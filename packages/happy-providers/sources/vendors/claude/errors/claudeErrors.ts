/**
 * Recognition of the Claude Code SDK failures the session has to describe to a person.
 *
 * The SDK reports a failure twice over: a coarse assistant error code alongside rate-limit
 * bookkeeping, and a result message carrying whatever the run collected. The first decides which
 * taxonomy case the caller sees, the second supplies the sentence shown when the run had nothing
 * better to say.
 */

import type {
    SDKAPIRetryMessage,
    SDKAssistantMessageError,
    SDKRateLimitInfo,
    SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { extractProviderErrorDiagnostics } from "@/core/extractProviderErrorDiagnostics.js";
import type { SessionErrorKind, SessionProviderError } from "@/core/SessionEvent.js";

/** Use the existing terminal error kind for both SDK-local and upstream context rejections. */
export function claudeErrorKind(
    message: string,
    providerError: SessionProviderError,
): SessionErrorKind {
    const normalized = message.toLowerCase();
    if (
        normalized.includes("prompt is too long") ||
        normalized.includes("input is too long for requested model")
    ) {
        return "context_overflow";
    }
    if (providerError.type === "out_of_tokens") return "billing_error";
    if (
        providerError.type === "server_overloaded" ||
        providerError.type === "internal_server_error"
    ) {
        return "internal_error";
    }
    return "unknown";
}

export function classifyClaudeError(options: {
    assistantError?: SDKAssistantMessageError;
    attempts?: number;
    error?: unknown;
    message: string;
    rateLimitInfo?: SDKRateLimitInfo;
    requestId?: string;
}): SessionProviderError {
    const diagnostics = extractProviderErrorDiagnostics(options.error, {
        attempts: options.attempts ?? 1,
        ...(options.assistantError === undefined ? {} : { code: options.assistantError }),
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        upstreamMessage: options.message,
    });
    const normalized = options.message.toLowerCase();
    if (options.assistantError === "authentication_failed") {
        return {
            type: "authentication",
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }
    // The CLI reports a spent subscription window and a momentary throttle with the same
    // `rate_limit` assistant error. What tells them apart is the unified limiter's own verdict:
    // `rejected` with a reset, while not running on overage, is the condition under which Claude
    // Code itself says "You've hit your … limit". A throttle carries no such rejection.
    const windowReset = spentWindowResetAt(options.rateLimitInfo);
    const resetAt = windowReset ?? earliestResetAt(options.rateLimitInfo);
    const outOfTokens =
        windowReset !== undefined ||
        options.assistantError === "billing_error" ||
        options.rateLimitInfo?.overageDisabledReason === "out_of_credits" ||
        normalized.includes("credit balance is too low") ||
        normalized.includes("out of extra usage") ||
        normalized.includes("out of credits");
    if (outOfTokens) {
        return {
            type: "out_of_tokens",
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }

    const rateLimited =
        options.assistantError === "rate_limit" ||
        options.rateLimitInfo?.status === "rejected" ||
        normalized.includes("rate limit") ||
        normalized.includes("too many requests") ||
        /(?:session|weekly|opus|sonnet|usage) limit/iu.test(options.message) ||
        /(?:^|\D)429(?:\D|$)/u.test(options.message);
    if (rateLimited) {
        return {
            type: "rate_limit",
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }
    if (options.assistantError === "overloaded")
        return {
            type: "server_overloaded",
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    if (
        options.assistantError === "server_error" ||
        isClaudeMidResponseServerError(options.message)
    ) {
        return {
            type: "internal_server_error",
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }
    return {
        type: "unclassified",
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}

/**
 * What an `api_retry` is retrying. Claude Code names the failure with the same assistant error
 * vocabulary it uses for a terminal one, so a retried 401 stays an authentication failure rather
 * than reading as an outage while Claude Code refreshes its login. A retry with no HTTP status
 * never got a response at all.
 */
export function classifyClaudeRetry(message: SDKAPIRetryMessage): SessionProviderError {
    const status = message.error_status ?? undefined;
    if (status === undefined && message.error === "unknown") {
        const diagnostics = extractProviderErrorDiagnostics(undefined, {
            attempts: message.attempt,
            code: message.error,
        });
        return { type: "network", ...(diagnostics === undefined ? {} : { diagnostics }) };
    }
    const providerError = classifyClaudeError({
        assistantError: message.error,
        attempts: message.attempt,
        message: "",
    });
    const diagnostics = extractProviderErrorDiagnostics(undefined, {
        attempts: message.attempt,
        code: message.error,
        ...(status === undefined ? {} : { status }),
    });
    return { ...providerError, ...(diagnostics === undefined ? {} : { diagnostics }) };
}

export function claudeResultErrorMessage(
    result: Exclude<SDKResultMessage, { subtype: "success" }>,
): string {
    const errors = result.errors.map((error) => error.trim()).filter((error) => error.length > 0);
    if (errors.length > 0) return errors.join("\n");

    switch (result.subtype) {
        case "error_during_execution":
            return "Claude encountered an error while running the request.";
        case "error_max_turns":
            return "Claude reached the maximum number of turns.";
        case "error_max_budget_usd":
            return "Claude reached the configured spending limit.";
        case "error_max_structured_output_retries":
            return "Claude could not produce valid structured output after repeated attempts.";
    }
}

export function isClaudeMidResponseServerError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes("mid-response") &&
        normalized.includes("response above may be incomplete")
    );
}

/** When the subscription window the limiter rejected the account for resets, in epoch ms. */
function spentWindowResetAt(rateLimitInfo: SDKRateLimitInfo | undefined): number | undefined {
    if (rateLimitInfo?.status !== "rejected" || rateLimitInfo.isUsingOverage === true) {
        return undefined;
    }
    const seconds = rateLimitInfo.resetsAt;
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1_000
        : undefined;
}

function earliestResetAt(rateLimitInfo: SDKRateLimitInfo | undefined): number | undefined {
    const seconds = [rateLimitInfo?.resetsAt, rateLimitInfo?.overageResetsAt].filter(
        (value): value is number =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
    return seconds.length === 0 ? undefined : Math.min(...seconds) * 1_000;
}
