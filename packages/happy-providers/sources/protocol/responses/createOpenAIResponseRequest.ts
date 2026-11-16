import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";

import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionReasoningEffort, SessionStructuredOutput } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import {
    OPENAI_RESPONSES_CAPABILITIES,
    type ResponsesCapabilities,
} from "@/protocol/responses/ResponsesCapabilities.js";
import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { toOpenAIReasoningEffort } from "@/protocol/responses/toOpenAIReasoningEffort.js";
import { toResponsesToolDefinitions } from "@/protocol/responses/toResponsesToolDefinitions.js";

export function createOpenAIResponseRequest(options: {
    context: SessionContext;
    effort?: SessionReasoningEffort;
    model: string;
    promptCacheKey?: string;
    structuredOutput?: SessionStructuredOutput;
    tools?: readonly SessionTool[];
    capabilities?: ResponsesCapabilities;
}): ResponseCreateParamsStreaming {
    const capabilities = options.capabilities ?? OPENAI_RESPONSES_CAPABILITIES;
    const effort =
        options.effort === undefined ? undefined : toOpenAIReasoningEffort(options.effort);
    return {
        model: options.model,
        input: toOpenAIResponseInput(options.context),
        stream: true,
        store: false,
        ...(capabilities.parallelToolCalls ? { parallel_tool_calls: true } : {}),
        ...(capabilities.textVerbosity || options.structuredOutput !== undefined
            ? {
                  text: {
                      ...(capabilities.textVerbosity ? { verbosity: "low" as const } : {}),
                      ...(options.structuredOutput === undefined
                          ? {}
                          : {
                                format: {
                                    type: "json_schema" as const,
                                    name: options.structuredOutput.name,
                                    schema: options.structuredOutput.schema,
                                    strict: true,
                                },
                            }),
                  },
              }
            : {}),
        instructions: options.context.instructions,
        ...(options.tools === undefined
            ? {}
            : {
                  tool_choice: "auto" as const,
                  tools: toResponsesToolDefinitions(options.tools),
              }),
        ...(options.promptCacheKey === undefined
            ? {}
            : { prompt_cache_key: options.promptCacheKey }),
        ...(effort === undefined || !capabilities.reasoning
            ? {}
            : {
                  reasoning: { effort },
                  ...(effort === "none" || !capabilities.encryptedReasoning
                      ? {}
                      : { include: ["reasoning.encrypted_content" as const] }),
              }),
    } as ResponseCreateParamsStreaming;
}
