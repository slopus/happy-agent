import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";

import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { createMcpProtocolTools } from "./createMcpProtocolTools.js";
import { createMcpTool } from "./createMcpTool.js";

describe("createMcpProtocolTools", () => {
    it("bounds protocol metadata before returning it to the model", () => {
        const tool = createMcpProtocolTools([{ client: {} as Client, name: "large_server" }]).find(
            (candidate) => candidate.name === "list_mcp_tools",
        );

        const blocks = tool?.toLLM({
            tools: Array.from({ length: 10_000 }, (_, index) => ({
                description: "x".repeat(1_000),
                name: `tool_${String(index)}`,
            })),
        } as never);

        expect(blocks).toHaveLength(1);
        expect(blocks?.[0]).toMatchObject({ type: "text" });
        if (blocks?.[0]?.type !== "text") throw new Error("Expected bounded metadata text.");
        expect(Buffer.byteLength(blocks[0].text)).toBeLessThanOrEqual(512 * 1024);
        expect(blocks[0].text).toContain("[truncated]");
    });

    it("bounds resource contents before returning them to the model", () => {
        const tool = createMcpProtocolTools([{ client: {} as Client, name: "large_server" }]).find(
            (candidate) => candidate.name === "read_mcp_resource",
        );

        const blocks = tool?.toLLM({
            contents: Array.from({ length: 1_000 }, (_, index) => ({
                text: `${String(index)}:${"🔥".repeat(10_000)}`,
                uri: `resource://${String(index)}`,
            })),
        } as never);
        const text = blocks
            ?.filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");

        expect(Buffer.byteLength(text ?? "")).toBeLessThanOrEqual(512 * 1024);
        expect(text).toContain("[truncated]");
    });

    it("reviews prompt loading because prompt content can come from an external server", () => {
        const tool = createMcpProtocolTools([
            { client: {} as Client, name: "deployment_service" },
        ]).find((candidate) => candidate.name === "get_mcp_prompt");

        expect(tool?.shouldReviewInAutoMode({} as never, createJustBashToolHarness().context)).toBe(
            true,
        );
        expect(
            tool?.describeAutoPermissionAction?.(
                { name: "release_notes", server: "deployment_service" } as never,
                createJustBashToolHarness().context,
            ),
        ).toBe(
            'loading prompt "release notes" from "deployment service". Access: the MCP server can return instructions from outside Rig’s local sandbox',
        );
    });

    it("makes the dynamic call tool own its external-boundary description", () => {
        const tool = createMcpProtocolTools([
            { client: {} as Client, name: "deployment_service" },
        ]).find((candidate) => candidate.name === "call_mcp_tool");
        const describe = tool?.describeAutoPermissionAction;

        expect(describe).toBeDefined();
        expect(
            describe?.(
                {
                    arguments: { channel: "production" },
                    name: "publish_release",
                    server: "deployment_service",
                } as never,
                createJustBashToolHarness().context,
            ),
        ).toBe(
            'calling "Publish Release" from "Deployment Service" with arguments "{\\"channel\\":\\"production\\"}". Access: the MCP server can perform actions outside Rig’s filesystem sandbox',
        );
    });

    it("shares per-server locks with direct MCP tools without locking other servers", () => {
        const client = {} as Client;
        const dynamicTool = createMcpProtocolTools([
            { client, name: "deployment_service" },
            { client, name: "issue_tracker" },
        ]).find((candidate) => candidate.name === "call_mcp_tool");
        const directTool = createMcpTool({
            client,
            serverName: "deployment_service",
            tool: {
                inputSchema: { properties: {}, type: "object" },
                name: "publish_release",
            },
        });
        const dynamicLock = dynamicTool?.locks[0];

        expect(typeof dynamicLock).toBe("function");
        if (typeof dynamicLock !== "function")
            throw new Error("Expected an argument-derived lock.");
        expect(
            dynamicLock({
                arguments: {},
                name: "publish_release",
                server: "deployment_service",
            } as never),
        ).toBe(directTool.locks[0]);
        expect(
            dynamicLock({ arguments: {}, name: "create_issue", server: "issue_tracker" } as never),
        ).not.toBe(directTool.locks[0]);
    });
});
