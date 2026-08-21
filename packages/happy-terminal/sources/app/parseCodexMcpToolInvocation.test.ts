import { describe, expect, it } from "vitest";

import { parseCodexMcpToolInvocation } from "./parseCodexMcpToolInvocation.js";

describe("parseCodexMcpToolInvocation", () => {
    it("parses a direct qualified MCP tool while preserving its arguments", () => {
        const argumentsValue = { title: "Final one-click agent creation", timeout_ms: 60_000 };

        expect(parseCodexMcpToolInvocation("mcp__node_repl__js", argumentsValue)).toEqual({
            server: "node_repl",
            tool: "js",
            arguments: argumentsValue,
        });
    });

    it("parses the dynamic MCP protocol tool as the underlying invocation", () => {
        expect(
            parseCodexMcpToolInvocation("call_mcp_tool", {
                server: "node_repl",
                name: "js",
                arguments: { code: "nodeRepl.write({ ready: true })" },
            }),
        ).toEqual({
            server: "node_repl",
            tool: "js",
            arguments: { code: "nodeRepl.write({ ready: true })" },
        });
        expect(
            parseCodexMcpToolInvocation("call_mcp_tool", {
                server: "docs",
                name: "search",
            }),
        ).toEqual({ server: "docs", tool: "search", arguments: {} });
    });

    it("leaves unrelated and malformed tool calls to other renderers", () => {
        expect(parseCodexMcpToolInvocation("exec_command", { cmd: "pwd" })).toBeUndefined();
        expect(parseCodexMcpToolInvocation("mcp__missing_tool", {})).toBeUndefined();
        expect(parseCodexMcpToolInvocation("call_mcp_tool", { server: "docs" })).toBeUndefined();
    });
});
