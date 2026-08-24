import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { SessionAssistantMessage, SessionToolCallBlock } from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { searchCodexTools } from "@/vendors/codex/impl/searchCodexTools.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";

const toolSearchArgumentsSchema = Type.Object(
    {
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
);

export interface CodexToolSearchResult {
    assistantText: string;
    message: SessionAssistantMessage;
    outputItems: readonly string[];
    toolCalls: readonly Omit<SessionToolCallBlock, "type">[];
}

export interface CodexToolSearchSettlement {
    readonly call: Omit<SessionToolCallBlock, "type">;
    readonly outputItem: string;
}

export function settleCodexToolSearch<T extends CodexToolSearchResult>(
    result: T,
    tools: readonly SessionTool[],
): { result: T; settled: boolean; settlements: readonly CodexToolSearchSettlement[] } {
    if (!tools.some(isClientToolSearchDefinition)) {
        return { result, settled: false, settlements: [] };
    }
    const searches = result.toolCalls.filter(isClientToolSearchCall);
    if (searches.length === 0) return { result, settled: false, settlements: [] };
    const deferredTools = tools.filter((tool) => tool.server === undefined && tool.defer === true);
    const outputs = searches.map((call) => {
        let matched: readonly SessionTool[] = [];
        try {
            const parsed: unknown = JSON.parse(call.arguments);
            if (Value.Check(toolSearchArgumentsSchema, parsed)) {
                matched = searchCodexTools(deferredTools, parsed.query, parsed.limit);
            }
        } catch {
            // Invalid discovery input is settled as an empty result so the model can recover.
        }
        return JSON.stringify({
            type: "tool_search_output",
            call_id: call.callId,
            execution: "client",
            status: "completed",
            tools: toCodexToolDefinitions(matched, { includeDeferred: true }).filter(
                (tool) => tool.type !== "tool_search",
            ),
        });
    });
    return {
        settled: true,
        settlements: searches.map((call, index) => ({ call, outputItem: outputs[index]! })),
        result: {
            ...result,
            outputItems: [...result.outputItems, ...outputs],
            message: {
                role: "assistant",
                content: [
                    ...result.message.content.map((block) =>
                        block.type === "tool_call" &&
                        searches.some((search) => search.callId === block.callId)
                            ? { ...block, server: true as const }
                            : block,
                    ),
                    ...outputs.map((output, index) => ({
                        type: "tool_result" as const,
                        callId: searches[index]!.callId,
                        content: [],
                        vendor: { outputItem: output },
                    })),
                ],
            },
            toolCalls: result.toolCalls.filter((call) => !isClientToolSearchCall(call)),
        } as T,
    };
}

function isClientToolSearchDefinition(tool: SessionTool): boolean {
    return tool.server?.type === "tool_search" && tool.server.execution === "client";
}

function isClientToolSearchCall(call: Omit<SessionToolCallBlock, "type">): boolean {
    const vendor =
        typeof call.vendor === "object" && call.vendor !== null
            ? (call.vendor as { provider?: unknown; type?: unknown })
            : undefined;
    return vendor?.provider === "codex" && vendor.type === "tool_search_call";
}
