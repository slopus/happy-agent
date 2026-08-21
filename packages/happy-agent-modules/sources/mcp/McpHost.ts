import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    mcpAgentIdSchema,
    mcpCallToolInputSchema,
    mcpContextSchema,
    mcpElicitationRequestSchema,
    mcpElicitationResultSchema,
    mcpGetPromptInputSchema,
    mcpGetPromptResultSchema,
    mcpPermissionModeSchema,
    mcpPromptPageSchema,
    mcpPromptPageQuerySchema,
    mcpReadResourceInputSchema,
    mcpReadResourceResultSchema,
    mcpResourcePageQuerySchema,
    mcpResourcePageSchema,
    mcpResourceTemplatePageSchema,
    mcpServerNameSchema,
    mcpServerPageQuerySchema,
    mcpServerPageSchema,
    mcpToolPolicySchema,
    mcpToolPageQuerySchema,
    mcpToolPageSchema,
    mcpToolResultSchema,
    type McpElicitationRequest,
    type McpToolResult,
} from "./Mcp.js";

/**
 * The host owns every boundary that can reach an MCP server.  In particular, this contract does
 * not expose a Client, Transport, socket, process, credential, or path.  A Happy Agent adapter can hand
 * these calls to its existing McpClientManager, while another host can use a remote MCP broker.
 * `getToolPolicy` is optional for hosts that already include policy lists in server summaries.
 */

export const mcpElicitationHandlerSchema = Type.Function(
    [mcpElicitationRequestSchema],
    Type.Promise(mcpElicitationResultSchema),
);

export const mcpHostCallOptionsSchema = Type.Object(
    {
        onElicitation: Type.Optional(mcpElicitationHandlerSchema),
    },
    { additionalProperties: false },
);

export const mcpHostSchema = Type.Object(
    {
        callTool: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpCallToolInputSchema, mcpHostCallOptionsSchema],
            Type.Promise(mcpToolResultSchema),
        ),
        getPrompt: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpGetPromptInputSchema],
            Type.Promise(mcpGetPromptResultSchema),
        ),
        getToolPolicy: Type.Optional(
            Type.Function(
                [mcpContextSchema, mcpAgentIdSchema, mcpServerNameSchema],
                Type.Promise(mcpToolPolicySchema),
            ),
        ),
        listPrompts: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpPromptPageQuerySchema],
            Type.Promise(mcpPromptPageSchema),
        ),
        listResourceTemplates: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpResourcePageQuerySchema],
            Type.Promise(mcpResourceTemplatePageSchema),
        ),
        listResources: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpResourcePageQuerySchema],
            Type.Promise(mcpResourcePageSchema),
        ),
        listServers: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpPermissionModeSchema, mcpServerPageQuerySchema],
            Type.Promise(mcpServerPageSchema),
        ),
        listTools: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpToolPageQuerySchema],
            Type.Promise(mcpToolPageSchema),
        ),
        readResource: Type.Function(
            [mcpContextSchema, mcpAgentIdSchema, mcpReadResourceInputSchema],
            Type.Promise(mcpReadResourceResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type McpHost = Static<typeof mcpHostSchema>;
export type McpHostCallOptions = Static<typeof mcpHostCallOptionsSchema>;

export function assertMcpHost(value: unknown): asserts value is McpHost {
    try {
        const candidate = value as Record<string, unknown>;
        const materialized = {
            ...candidate,
            callTool: candidate.callTool,
            getPrompt: candidate.getPrompt,
            ...(candidate.getToolPolicy === undefined
                ? {}
                : { getToolPolicy: candidate.getToolPolicy }),
            listPrompts: candidate.listPrompts,
            listResourceTemplates: candidate.listResourceTemplates,
            listResources: candidate.listResources,
            listServers: candidate.listServers,
            listTools: candidate.listTools,
            readResource: candidate.readResource,
        };
        if (!Value.Check(mcpHostSchema, materialized)) {
            throw new Error("MCP module received an invalid host.");
        }
    } catch {
        throw new Error("MCP module received an invalid host.");
    }
}

export type McpHostToolCall = (
    ctx: Parameters<McpHost["callTool"]>[0],
    agentId: Parameters<McpHost["callTool"]>[1],
    input: Parameters<McpHost["callTool"]>[2],
    options: Parameters<McpHost["callTool"]>[3],
) => ReturnType<McpHost["callTool"]>;

export type McpHostElicitationRequest = McpElicitationRequest;
export type McpHostResult = McpToolResult;
