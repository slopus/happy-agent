import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionReasoningEffort, SessionStructuredOutput } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { createOpenAIResponseRequest } from "@/protocol/responses/createOpenAIResponseRequest.js";
import { createResponsesLiteRequest } from "@/protocol/responsesLite/createResponsesLiteRequest.js";
import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";
import type { CodexServiceTier } from "@/vendors/codex/impl/codexServiceTier.js";
import { isCodexV2Model } from "@/vendors/codex/impl/isCodexV2Model.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";

export function createCodexCliRequest(options: {
    context: SessionContext;
    clientMetadata: Readonly<Record<string, string>>;
    effort?: SessionReasoningEffort;
    model: string;
    parallelToolCalls?: boolean;
    promptCacheKey: string;
    serviceTier?: CodexServiceTier;
    structuredOutput?: SessionStructuredOutput;
    tools: readonly SessionTool[];
}): CodexResponseRequest {
    const request: CodexResponseRequest = createOpenAIResponseRequest(options);
    request.tool_choice = "auto";
    request.client_metadata = { ...options.clientMetadata };
    if (options.serviceTier !== undefined) request.service_tier = options.serviceTier;
    const useResponsesLite = isCodexV2Model(options.model) && options.parallelToolCalls !== true;
    if (useResponsesLite) {
        return createResponsesLiteRequest(request, options.context.instructions);
    } else {
        request.parallel_tool_calls = options.parallelToolCalls ?? true;
        request.tools = toCodexToolDefinitions(options.tools) as never;
    }
    return request;
}
