import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";
import { createMcpProtocolTools } from "./createMcpProtocolTools.js";
import { createMcpTool } from "./createMcpTool.js";

describe("MCP application errors", () => {
    it("preserves every error block for direct and dynamic tool calls", async () => {
        const applicationError = {
            content: [
                { type: "text" as const, text: "Error: request failed" },
                { type: "text" as const, text: "Retryable: false" },
            ],
            isError: true,
        };
        const callTool = vi.fn().mockResolvedValue(applicationError);
        const client = { callTool } as unknown as Client;
        const context = createJustBashToolHarness().context;
        const direct = createMcpTool({
            client,
            serverName: "test server",
            tool: {
                annotations: { readOnlyHint: true },
                inputSchema: { properties: {}, type: "object" },
                name: "fail_request",
            },
        });

        const ctx = createTestRootContext();
        const directResult = await direct.execute({} as never, context, { ctx });
        expect(direct.isError?.(directResult as never)).toBe(true);
        expect(direct.toLLM(directResult as never)).toEqual([
            { type: "text", text: "Error: request failed" },
            { type: "text", text: "Retryable: false" },
        ]);

        const dynamic = createMcpProtocolTools([{ client, name: "test server" }]).find(
            (tool) => tool.name === "call_mcp_tool",
        );
        expect(dynamic).toBeDefined();
        if (dynamic === undefined) throw new Error("Expected the dynamic MCP call tool.");
        const dynamicResult = await dynamic.execute(
            { arguments: {}, name: "fail_request", server: "test server" } as never,
            context,
            { ctx },
        );
        expect(dynamic.isError?.(dynamicResult as never)).toBe(true);
        expect(dynamic.toLLM(dynamicResult as never)).toEqual([
            { type: "text", text: "Error: request failed" },
            { type: "text", text: "Retryable: false" },
        ]);
    });
});
