import type { CodexMcpToolInvocation } from "./CodexMcpToolCall.js";

const DIRECT_MCP_PREFIX = "mcp__";

export function parseCodexMcpToolInvocation(
    toolName: string,
    argumentsValue: unknown,
): CodexMcpToolInvocation | undefined {
    if (toolName === "call_mcp_tool") {
        if (!isRecord(argumentsValue)) return undefined;
        const server = argumentsValue.server;
        const tool = argumentsValue.name;
        if (!isNonEmptyString(server) || !isNonEmptyString(tool)) return undefined;
        return {
            server,
            tool,
            arguments: Object.hasOwn(argumentsValue, "arguments") ? argumentsValue.arguments : {},
        };
    }

    if (!toolName.startsWith(DIRECT_MCP_PREFIX)) return undefined;
    const qualifiedName = toolName.slice(DIRECT_MCP_PREFIX.length);
    const separator = qualifiedName.indexOf("__");
    if (separator <= 0 || separator >= qualifiedName.length - 2) return undefined;

    return {
        server: qualifiedName.slice(0, separator),
        tool: qualifiedName.slice(separator + 2),
        arguments: argumentsValue,
    };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
