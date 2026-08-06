import { APIError } from "@anthropic-ai/sdk/error";

import {
    extractProviderErrorDiagnostics,
    extractProviderRetryResetAt,
} from "@/core/extractProviderErrorDiagnostics.js";
import type { SessionErrorKind, SessionProviderError } from "@/core/SessionEvent.js";

export function classifyAnthropicBedrockError(error: unknown): SessionErrorKind {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error);
    if (
        message.includes("context window") ||
        message.includes("context limit") ||
        message.includes("input is too long") ||
        message.includes("too many input tokens")
    ) {
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
    if (error instanceof APIError) {
        if (error.status === 402) return "billing_error";
        if (error.status !== undefined && error.status >= 500) return "internal_error";
    }
    return "unknown";
}

export function classifyAnthropicBedrockProviderError(
    error: unknown,
    attempts: number,
): SessionProviderError {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = extractProviderErrorDiagnostics(error, {
        attempts: Math.max(1, attempts),
        upstreamMessage: message,
    });
    const status = diagnostics?.status;
    const kind = classifyAnthropicBedrockError(error);
    const normalized = message.toLowerCase();
    const type: SessionProviderError["type"] =
        status === 401 || status === 403
            ? "authentication"
            : status === 402 || kind === "billing_error"
              ? "out_of_tokens"
              : status === 429
                ? "rate_limit"
                : status === 503 || normalized.includes("overloaded")
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
