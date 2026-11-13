import type {
    BetaThinkingConfigAdaptive,
    MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionReasoningEffort, SessionStructuredOutput } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { withAnthropicToolReferences } from "@/protocol/anthropic/anthropicToolReferences.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";
import { toAnthropicSystem } from "@/protocol/anthropic/toAnthropicSystem.js";
import {
    isAnthropicToolSearchTool,
    toAnthropicTools,
} from "@/protocol/anthropic/toAnthropicTools.js";

export type AnthropicRequest = MessageCreateParamsStreaming;

/** The beta that makes `thinking.block_binding` a legal request field. */
export const ANTHROPIC_THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

export function createAnthropicRequest(options: {
    compaction?: {
        instructions?: string;
    };
    context: SessionContext;
    /**
     * Ask the API to drop replayed thinking blocks that fail its prefix check instead of
     * rejecting the whole request. The caller says whether the model and endpoint accept the
     * control; it is never sent with thinking disabled, where the API refuses the field.
     */
    dropMismatchedThinking?: boolean;
    effort?: SessionReasoningEffort;
    model: string;
    structuredOutput?: SessionStructuredOutput;
    tools: readonly SessionTool[];
}): AnthropicRequest {
    const effort = resolveEffort(options.effort);
    const system = toAnthropicSystem(options);
    const hasToolSearch = options.tools.some(isAnthropicToolSearchTool);
    const { messages, tools } = withAnthropicToolReferences(
        toAnthropicMessages(options.context.messages),
        toAnthropicTools(options.tools),
        hasToolSearch,
    );
    const hasCompaction = options.context.messages.some((message) => message.role === "compaction");
    const requestsCompaction = options.compaction !== undefined;
    const usesCompaction = requestsCompaction || hasCompaction;
    const betas = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"];
    if (usesCompaction) betas.push("compact-2026-01-12");
    if (options.structuredOutput !== undefined) betas.push("structured-outputs-2025-12-15");
    if (hasToolSearch) {
        betas.push("tool-search-tool-2025-10-19");
    }
    const dropsMismatchedThinking =
        options.dropMismatchedThinking === true && options.effort !== "off";
    if (dropsMismatchedThinking) betas.push(ANTHROPIC_THINKING_BINDING_BETA);
    return {
        betas,
        ...(!usesCompaction
            ? {}
            : {
                  context_management: {
                      edits: [
                          requestsCompaction
                              ? {
                                    type: "compact_20260112" as const,
                                    ...(options.compaction?.instructions === undefined
                                        ? {}
                                        : { instructions: options.compaction.instructions }),
                                    pause_after_compaction: true,
                                    trigger: { type: "input_tokens" as const, value: 50_000 },
                                }
                              : {
                                    // The API rejects compaction blocks whose strategy is not
                                    // declared, but offers no way to declare it with compaction
                                    // disabled. Rig owns compaction timing and the run path
                                    // treats a mid-run compaction as an error, so the trigger
                                    // sits beyond the 1M context window and can never fire.
                                    type: "compact_20260112" as const,
                                    trigger: { type: "input_tokens" as const, value: 2_000_000 },
                                },
                      ],
                  },
              }),
        max_tokens: 64_000,
        messages,
        model: options.model,
        stream: true,
        ...(system.length === 0 ? {} : { system }),
        thinking:
            options.effort === "off"
                ? { type: "disabled" }
                : dropsMismatchedThinking
                  ? // The SDK does not type `block_binding` yet; the wire shape is the API's.
                    ({
                        type: "adaptive",
                        block_binding: { prefix_mismatch_behavior: "drop_block" },
                    } as BetaThinkingConfigAdaptive)
                  : { type: "adaptive" },
        ...(options.effort === "off" && options.structuredOutput === undefined
            ? {}
            : {
                  output_config: {
                      ...(options.effort === "off" ? {} : { effort }),
                      ...(options.structuredOutput === undefined
                          ? {}
                          : {
                                format: {
                                    type: "json_schema" as const,
                                    schema: options.structuredOutput.schema,
                                },
                            }),
                  },
              }),
        ...(tools.length === 0 ? {} : { tools }),
    };
}

function resolveEffort(
    effort: SessionReasoningEffort | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" {
    if (effort === undefined) return "high";
    if (effort === "off" || effort === "minimal") return "low";
    return effort;
}
