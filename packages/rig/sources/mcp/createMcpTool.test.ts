import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";

import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { createMcpTool } from "./createMcpTool.js";

describe("createMcpTool", () => {
    it("owns the external-boundary description used for Auto approval", () => {
        const tool = createMcpTool({
            client: {} as Client,
            serverName: "deployment_service",
            tool: {
                inputSchema: { properties: {}, type: "object" },
                name: "publish_release",
            },
        });
        const describe = tool.describeAutoPermissionAction;

        expect(describe).toBeDefined();
        expect(
            describe?.(
                { channel: "production", version: "1.2.3" } as never,
                createJustBashToolHarness().context,
            ),
        ).toBe(
            'calling "Publish Release" from "Deployment Service" with arguments "{\\"channel\\":\\"production\\",\\"version\\":\\"1.2.3\\"}". Access: the MCP server can perform actions outside Rig’s filesystem sandbox',
        );
    });

    it("uses readable MCP names in the user-facing result label", () => {
        const tool = createMcpTool({
            client: {} as Client,
            serverName: "openaiDeveloper_docs",
            tool: {
                inputSchema: { properties: {}, type: "object" },
                name: "publishRelease",
            },
        });

        expect(tool.toUI({} as never, {} as never)).toBe("OpenAI Developer Docs · Publish Release");
    });

    it.each([true, false, undefined])(
        "reviews direct MCP tools when readOnlyHint is %s",
        async (readOnlyHint) => {
            const tool = createMcpTool({
                client: {} as Client,
                serverName: "untrusted server",
                tool: {
                    ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
                    inputSchema: { properties: {}, type: "object" },
                    name: "possibly_mutating_action",
                },
            });

            expect(
                await tool.shouldReviewInAutoMode({} as never, createJustBashToolHarness().context),
            ).toBe(true);
            expect(tool.locks).toEqual(["mcp:untrusted server"]);
        },
    );
});
