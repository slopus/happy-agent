import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";

import {
    mcpAgentIdSchema,
    mcpServerNameSchema,
    mcpToolResultSchema,
    mcpToolSchema,
    type McpTool,
} from "./Mcp.js";
import { describeMcpAutoPermissionAction } from "./describeMcpAutoPermissionAction.js";
import { isMcpErrorResult } from "./isMcpErrorResult.js";
import { normalizeMcpName } from "./normalizeMcpName.js";
import type { McpModule } from "./McpModule.js";

export function createMcpTool(
    module: McpModule,
    agentId: string,
    serverName: string,
    tool: McpTool,
): AnyAgentTool {
    if (
        !Value.Check(mcpAgentIdSchema, agentId) ||
        !Value.Check(mcpServerNameSchema, serverName) ||
        !Value.Check(mcpToolSchema, tool)
    ) {
        throw new Error("MCP direct tool definition is invalid.");
    }
    const qualifiedName = `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(tool.name)}`;
    return defineAgentTool({
        name: qualifiedName,
        defer: true,
        capabilities: ["Discover and use configured MCP servers, resources, prompts, and tools."],
        searchKeywords: ["MCP direct tool", serverName, tool.name],
        description: tool.description ?? `Use ${tool.name} from ${serverName}.`,
        // Preserve the server's JSON Schema for providers while intentionally treating it as
        // opaque to TypeBox's ordinary argument checker. MCP itself validates the arguments at
        // the server boundary; `Type.Unsafe` would make Value.Check throw on the external
        // schema's unregistered kind.
        parameters: Type.Unknown(tool.inputSchema),
        returnType: mcpToolResultSchema,
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: (args) =>
            describeMcpAutoPermissionAction({
                arguments: args,
                server: serverName,
                tool: tool.name,
            }),
        // Server annotations such as readOnlyHint are untrusted metadata. Every direct invocation
        // is reviewed in Auto mode, even when a server claims that it is read-only.
        shouldReviewInAutoMode: () => true,
        execute: async (ctx, args) =>
            await module.callTool(ctx, agentId, {
                arguments: isRecord(args) ? args : {},
                name: tool.name,
                server: serverName,
            }),
        isError: isMcpErrorResult,
        toLLM: (result) => module.formatToolResultForModel(result),
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
