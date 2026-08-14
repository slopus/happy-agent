import { APIConnectionError, APIUserAbortError } from "openai";

/**
 * Connection-level failures the Responses API transport can hit below the HTTP layer: dropped
 * sockets, DNS failures, and the undici timeout/connect errors node's fetch implementation
 * raises. Mirrors the equivalent list in the Grok transport.
 */
const RETRYABLE_ERROR_CODES = new Set([
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
]);

/**
 * Recognizes a failure waiting can fix: a dropped connection or a retryable HTTP status. A spent
 * account and cancellation are excluded even when they otherwise look transient, because no
 * amount of waiting changes either outcome.
 */
export function isTransientResponsesError(error: unknown): boolean {
    if (isResponsesAbortError(error)) return false;
    if (isInsufficientQuotaResponsesError(error) || responsesErrorStatus(error) === 402) {
        return false;
    }

    const directive = responsesErrorHeader(error, "x-should-retry")?.toLowerCase();
    if (directive === "true") return true;
    if (directive === "false") return false;

    if (error instanceof APIConnectionError) return true;
    const code = responsesErrorCode(error);
    if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) return true;
    const status = responsesErrorStatus(error);
    return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
}

/**
 * Recognizes a cancellation even when the caller's signal is not observably aborted, so neither
 * retry budget can replay a request somebody stopped on purpose.
 */
export function isResponsesAbortError(error: unknown): boolean {
    for (const record of causeChain(error)) {
        if (record instanceof APIUserAbortError) return true;
        if (
            record.name === "AbortError" ||
            record.name === "APIUserAbortError" ||
            record.code === "ABORT_ERR"
        ) {
            return true;
        }
    }
    return false;
}

/** Recognizes a spent account, which spends the fatal budget and reports `out_of_tokens`. */
export function isInsufficientQuotaResponsesError(error: unknown): boolean {
    return responsesErrorCode(error) === "insufficient_quota";
}

const CONTEXT_OVERFLOW_MESSAGES = ["context_length", "context window", "too many tokens"] as const;

/**
 * Recognizes the rejection only a smaller context can fix, which no retry budget replays. It is
 * checked ahead of every status-based classification, because an overflow can arrive decorated
 * with a status that would otherwise look retryable.
 */
export function isResponsesContextOverflowError(error: unknown): boolean {
    if (responsesErrorStatus(error) === 413) return true;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return CONTEXT_OVERFLOW_MESSAGES.some((pattern) => message.includes(pattern));
}

function responsesErrorStatus(error: unknown): number | undefined {
    for (const record of causeChain(error)) {
        if (typeof record.status === "number") return record.status;
        if (typeof record.statusCode === "number") return record.statusCode;
    }
    return undefined;
}

function responsesErrorCode(error: unknown): string | undefined {
    for (const record of causeChain(error)) {
        if (typeof record.code === "string") return record.code;
    }
    return undefined;
}

function responsesErrorHeader(error: unknown, name: string): string | undefined {
    for (const record of causeChain(error)) {
        const headers = record.headers;
        if (headers instanceof Headers) {
            const value = headers.get(name);
            if (value !== null) return value;
        } else if (typeof headers === "object" && headers !== null) {
            const entry = Object.entries(headers as Record<string, unknown>).find(
                ([key]) => key.toLowerCase() === name,
            )?.[1];
            if (typeof entry === "string") return entry;
            if (Array.isArray(entry)) return entry.join(", ");
        }
    }
    return undefined;
}

/** Walks an error's cause chain once, tolerating a cyclic graph. */
function* causeChain(error: unknown): Generator<Record<string, unknown>> {
    const seen = new Set<object>();
    let current: unknown = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        seen.add(current);
        yield current as Record<string, unknown>;
        current = (current as Record<string, unknown>).cause;
    }
}
