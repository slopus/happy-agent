import { APIUserAbortError } from "openai";

import {
    grokErrorStatus,
    isGrokBillingError,
    isGrokContextOverflowError,
} from "@/vendors/grok/errors/grokErrors.js";
import { GROK_INFERENCE_RETRY_INITIAL_DELAY_MS } from "@/vendors/grok/impl/grokConstants.js";

/**
 * Whether sending this request again could plausibly succeed.
 *
 * The answer defaults to yes, and only the rejections we can name as hopeless say no. An
 * enumeration of retryable transport failures is the wrong shape for this question: the network
 * invents new ways to break faster than anyone maintains a list, and every code missing from such
 * a list becomes a turn that dies on a blip a second attempt would have survived. Being wrong in
 * this direction costs one bounded, backed-off request; being wrong in the other costs the user
 * their work. `GrokSession` caps the attempts, so an error nobody recognizes is retried a few
 * times and then surfaces on its own.
 *
 * This is the same default `isRetryableGrokCompactionError` already takes for compaction.
 */
export function isRetryableGrokError(value: unknown): boolean {
    // A cancelled request is not a failed one. This outranks everything below, because an abort
    // that races a real failure still carries that failure's status and headers.
    if (value instanceof APIUserAbortError || isAbortError(value)) return false;
    // The server is entitled to say a request must not be sent again.
    if (errorHeader(value, "x-should-retry")?.toLowerCase() === "false") return false;

    const status = grokErrorStatus(value);
    if (status !== undefined && isPermanentClientStatus(status)) return false;

    // A context that does not fit, and a balance that cannot pay, are identical on every attempt.
    const message = errorMessage(value);
    if (
        message !== undefined &&
        (isGrokContextOverflowError(message) || isGrokBillingError(message))
    ) {
        return false;
    }

    return true;
}

/**
 * The client rejections a byte-identical retry cannot fix.
 *
 * Every 4xx qualifies except the two that are themselves requests to try again: 408 says the
 * server gave up waiting for this request, and 429 says to send the same one later.
 */
function isPermanentClientStatus(status: number): boolean {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
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

/**
 * The complete text of a rejection, including the causes wrapped inside it.
 *
 * The SDK buries the upstream sentence several errors deep, and the meanings read here are
 * substrings rather than whole messages, so joining the chain finds them wherever they landed.
 */
function errorMessage(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
        const cause = errorMessage(value.cause);
        return cause === undefined ? value.message : `${value.message}: ${cause}`;
    }
    if (isRecord(value) && typeof value.message === "string") return value.message;
    return undefined;
}

function isAbortError(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return value.name === "AbortError" || value.code === "ABORT_ERR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
