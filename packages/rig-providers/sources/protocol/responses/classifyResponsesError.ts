import {
    extractProviderErrorDiagnostics,
    extractProviderRetryResetAt,
} from "@/core/extractProviderErrorDiagnostics.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionProviderError } from "@/core/SessionProviderError.js";

type ErrorDone = Extract<SessionEvent, { type: "done"; state: "error" }>;

export function classifyResponsesError(error: unknown): ErrorDone {
    const message = error instanceof Error ? error.message : "Responses API request failed.";
    const diagnostics = extractProviderErrorDiagnostics(error, {
        attempts: 1,
        upstreamMessage: message,
    });
    const status = diagnostics?.status;
    const normalized = message.toLowerCase();
    if (status === 401 || status === 403) {
        return {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "Authentication with the Responses API failed.",
            providerError: withDiagnostics("authentication", diagnostics),
        };
    }
    if (status === 429) {
        return {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "The Responses API rate limit was reached.",
            providerError: withResetAt(
                "rate_limit",
                diagnostics,
                extractProviderRetryResetAt(error),
            ),
        };
    }
    if (
        status === 413 ||
        normalized.includes("context_length") ||
        normalized.includes("context window") ||
        normalized.includes("too many tokens")
    ) {
        return {
            type: "done",
            state: "error",
            kind: "context_overflow",
            message: "The conversation exceeds the model's context window.",
            providerError: withDiagnostics("unclassified", diagnostics),
        };
    }
    if (status === 402) {
        return {
            type: "done",
            state: "error",
            kind: "billing_error",
            message: "The Responses API rejected the request because billing is unavailable.",
            providerError: withResetAt(
                "out_of_tokens",
                diagnostics,
                extractProviderRetryResetAt(error),
            ),
        };
    }
    if (status === 503 || normalized.includes("overloaded")) {
        return {
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "The Responses API is temporarily overloaded.",
            providerError: withDiagnostics("server_overloaded", diagnostics),
        };
    }
    if (status !== undefined && status >= 500) {
        return {
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "The Responses API returned an internal server error.",
            providerError: withDiagnostics("internal_server_error", diagnostics),
        };
    }
    return {
        type: "done",
        state: "error",
        kind: "unknown",
        message,
        providerError: withDiagnostics("unclassified", diagnostics),
    };
}

function withDiagnostics(
    type: SessionProviderError["type"],
    diagnostics: SessionProviderError["diagnostics"],
): SessionProviderError {
    return {
        type,
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}

function withResetAt(
    type: "out_of_tokens" | "rate_limit",
    diagnostics: SessionProviderError["diagnostics"],
    resetAt: number | undefined,
): SessionProviderError {
    return {
        type,
        ...(resetAt === undefined ? {} : { resetAt }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}
