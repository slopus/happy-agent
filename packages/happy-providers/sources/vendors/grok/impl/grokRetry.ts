import { isEmptyResponseError } from "@/core/EmptyResponseError.js";
import { GROK_INFERENCE_RETRY_INITIAL_DELAY_MS } from "@/vendors/grok/impl/grokConstants.js";

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

const TRANSPORT_MESSAGE_PATTERNS = [
    /^fetch failed$/iu,
    /^Response stream closed before completion\.$/iu,
    /^WebSocket error$/iu,
    /^WebSocket closed(?: 1006)?$/iu,
    /^stream disconnected before completion(?:: .+)?$/iu,
];

const BILLING_PATTERNS = [
    "subscription:free-usage-exhausted",
    "free grok build usage limit",
    "grok build usage balance exhausted",
    "credit balance is too low",
    "out of credits",
    "insufficient credits",
    "payment required",
    "purchase more credits",
] as const;

/** Mirrors grok-build free-usage and credit-exhaustion sniffers. */
export function isGrokBillingError(message: string): boolean {
    const normalized = message.toLowerCase();
    return BILLING_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function isRetryableGrokError(value: unknown): boolean {
    if (isEmptyResponseError(value)) return true;
    if (isGrokAbortError(value)) return false;
    if (errorHeader(value, "x-should-retry")?.toLowerCase() === "false") return false;

    const message = errorMessage(value);
    // A spent account is a 429 waiting cannot fix; it belongs to the fatal budget instead.
    if (message !== undefined && isGrokBillingError(message)) return false;

    const status = grokErrorStatus(value);
    if ([429, 500, 502, 503, 504, 520].includes(status ?? -1)) {
        return true;
    }
    const code = errorCode(value);
    if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) return true;

    return (
        message !== undefined && TRANSPORT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
    );
}

export function grokErrorStatus(value: unknown): number | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.status === "number") return value.status;
    if (typeof value.statusCode === "number") return value.statusCode;
    return grokErrorStatus(value.cause);
}

export function delayBeforeGrokRetry(
    attempt: number,
    signal?: AbortSignal,
    error?: unknown,
): Promise<void> {
    const serverDelay = retryAfterMilliseconds(error);
    const base = Math.min(
        30_000,
        GROK_INFERENCE_RETRY_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    );
    const jitter = base * (0.8 + Math.random() * 0.4);
    const delayMs = serverDelay ?? jitter;
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        const timeout = setTimeout(finish, delayMs);
        signal?.addEventListener("abort", finish, { once: true });
    });
}

function retryAfterMilliseconds(value: unknown): number | undefined {
    const milliseconds = Number(errorHeader(value, "retry-after-ms"));
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;

    const retryAfter = errorHeader(value, "retry-after");
    if (retryAfter === undefined) return undefined;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function errorHeader(value: unknown, name: string): string | undefined {
    if (!isRecord(value)) return undefined;
    const headers = value.headers;
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (isRecord(headers)) {
        const entry = Object.entries(headers).find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
        )?.[1];
        if (typeof entry === "string") return entry;
        if (Array.isArray(entry)) return entry.join(", ");
    }
    return errorHeader(value.cause, name);
}

function errorMessage(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
        const cause = errorMessage(value.cause);
        return cause === undefined ? value.message : `${value.message}: ${cause}`;
    }
    if (isRecord(value) && typeof value.message === "string") return value.message;
    return undefined;
}

function errorCode(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.code === "string") return value.code;
    return errorCode(value.cause);
}

/**
 * Recognizes a cancellation even when the caller's signal is not observably aborted, so neither
 * retry budget can replay a request somebody stopped on purpose.
 */
export function isGrokAbortError(value: unknown): boolean {
    const seen = new Set<object>();
    let current = value;
    while (isRecord(current) && !seen.has(current)) {
        if (current.name === "AbortError" || current.code === "ABORT_ERR") return true;
        seen.add(current);
        current = current.cause;
    }
    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
