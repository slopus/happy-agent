import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { SessionTool } from "@/core/SessionTool.js";
import { toAnthropicToolName } from "@/protocol/anthropic/toAnthropicToolName.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";

const ANTHROPIC_TOOL_SEARCH_TYPES = new Set([
    "tool_search_tool_bm25",
    "tool_search_tool_bm25_20251119",
    "tool_search_tool_regex",
    "tool_search_tool_regex_20251119",
]);

export function toAnthropicTools(tools: readonly SessionTool[]): BetaToolUnion[] {
    const hasToolSearch = tools.some(isAnthropicToolSearchTool);
    return tools.map((tool) => {
        if (tool.server !== undefined) {
            if (isAnthropicToolSearchTool(tool)) {
                return structuredClone(tool.server) as unknown as BetaToolUnion;
            }
            throw new Error(
                `Anthropic Bedrock does not support server tool '${tool.name}' through this transport.`,
            );
        }
        const schema = toLlmParametersSchema(tool.parameters) as Record<string, unknown> & {
            type: "object";
        };
        return {
            name: toAnthropicToolName(tool),
            description: tool.description ?? "",
            input_schema: { ...schema, type: "object" as const },
            ...(hasToolSearch && tool.defer === true ? { defer_loading: true } : {}),
        };
    });
}

export function isAnthropicToolSearchTool(tool: SessionTool): boolean {
    return tool.server !== undefined && ANTHROPIC_TOOL_SEARCH_TYPES.has(tool.server.type);
}
