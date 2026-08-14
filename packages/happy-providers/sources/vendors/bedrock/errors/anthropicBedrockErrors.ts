import { APIError } from "@anthropic-ai/sdk/error";

import {
    extractProviderErrorDiagnostics,
    extractProviderRetryResetAt,
} from "@/core/extractProviderErrorDiagnostics.js";
import type { SessionErrorKind, SessionProviderError } from "@/core/SessionEvent.js";
import { isAnthropicRefusalError } from "@/protocol/anthropic/AnthropicRefusalError.js";
import {
    anthropicBedrockRuntimeExceptionDetails,
    anthropicBedrockStreamErrorDetails,
    isAnthropicBedrockConnectionFailure,
    isAnthropicBedrockContextOverflow,
    resolveAnthropicBedrockErrorStatus,
} from "@/vendors/bedrock/impl/anthropicBedrockRetry.js";

/**
 * Surfaced errors must read like a sentence. Raw transport failures such as undici's
 * "terminated" get a human message, and a mid-stream error event's message is lifted out of
 * its JSON body; other SDK API errors already carry one.
 */
export function describeAnthropicBedrockErrorMessage(error: unknown): string {
    // A refusal's message already carries the stop_details category and explanation.
    if (isAnthropicRefusalError(error)) return error.message;
    if (!(error instanceof APIError) && isAnthropicBedrockConnectionFailure(error)) {
        return "The network connection to Anthropic Bedrock was lost before the response finished.";
    }
    const stream = anthropicBedrockStreamErrorDetails(error);
    if (stream !== undefined) {
        return stream.message === undefined
            ? "Anthropic Bedrock reported an error while streaming the response."
            : `Anthropic Bedrock reported an error while streaming the response: ${stream.message}.`;
    }
    const runtimeException = anthropicBedrockRuntimeExceptionDetails(error);
    if (runtimeException?.message !== undefined) return runtimeException.message;
    return error instanceof Error ? error.message : String(error);
}

export function classifyAnthropicBedrockError(error: unknown): SessionErrorKind {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error);
    if (isAnthropicBedrockContextOverflow(error)) {
        return "context_overflow";
    }
    if (
        message.includes("billing") ||
        message.includes("credit balance") ||
        message.includes("insufficient credit") ||
        message.includes("payment required")
    ) {
        return "billing_error";
    }
    const status = resolveAnthropicBedrockErrorStatus(error);
    if (status === 402) return "billing_error";
    if (status !== undefined && status >= 500) return "internal_error";
    return "unknown";
}

export function classifyAnthropicBedrockProviderError(
    error: unknown,
    attempts: number,
): SessionProviderError {
    const message = error instanceof Error ? error.message : String(error);
    const runtimeException = anthropicBedrockRuntimeExceptionDetails(error);
    const diagnostics = extractProviderErrorDiagnostics(error, {
        attempts: Math.max(1, attempts),
        upstreamMessage: message,
        ...(runtimeException === undefined ? {} : { errorType: runtimeException.name }),
    });
    const status = diagnostics?.status ?? resolveAnthropicBedrockErrorStatus(error);
    const kind = classifyAnthropicBedrockError(error);
    const normalized = message.toLowerCase();
    const type: SessionProviderError["type"] =
        status === 401 || status === 403
            ? "authentication"
            : status === 402 || kind === "billing_error"
              ? "out_of_tokens"
              : status === 429
                ? "rate_limit"
                : status === 503 || status === 529 || normalized.includes("overloaded")
                  ? "server_overloaded"
                  : (status !== undefined && status >= 500) || kind === "internal_error"
                    ? "internal_server_error"
                    : "unclassified";
    if (type === "rate_limit" || type === "out_of_tokens") {
        const resetAt = extractProviderRetryResetAt(error);
        return {
            type,
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }
    return {
        type,
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}
