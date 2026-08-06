import { APIConnectionError, APIError } from "@anthropic-ai/sdk/error";

import { isEmptyResponseError } from "@/core/EmptyResponseError.js";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

export function shouldRetryAnthropicBedrock(
    error: unknown,
    failedAttempts: number,
    maxRetries: number,
): boolean {
    if (failedAttempts > maxRetries) return false;
    if (isEmptyResponseError(error)) return true;
    if (error instanceof APIConnectionError) return true;
    if (!(error instanceof APIError)) return false;
    return (
        error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        (error.status !== undefined && error.status >= 500)
    );
}

export function resolveAnthropicBedrockRetryDelay(
    error: unknown,
    failedAttempts: number,
    now: () => number = Date.now,
): number {
    const headers = error instanceof APIError ? error.headers : undefined;
    const retryAfterMilliseconds = headers?.get("retry-after-ms");
    if (retryAfterMilliseconds) {
        const milliseconds = Number.parseFloat(retryAfterMilliseconds);
        if (!Number.isNaN(milliseconds)) return milliseconds;
    }
    const retryAfter = headers?.get("retry-after");
    if (retryAfter) {
        const seconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(seconds)) return seconds * 1_000;
        return Date.parse(retryAfter) - now();
    }
    const baseDelay = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, failedAttempts - 1), MAX_DELAY_MS);
    return baseDelay + Math.random() * 0.25 * baseDelay;
}

export function waitForAnthropicBedrockRetry(
    milliseconds: number,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(finish, milliseconds);
        signal?.addEventListener("abort", abort, { once: true });

        function abort(): void {
            clearTimeout(timeout);
            reject(signal?.reason);
        }

        function finish(): void {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
    });
}

export function describeAnthropicBedrockRetry(
    error: unknown,
    failedAttempts: number,
    delay: number,
    maxRetries: number,
): string {
    if (isEmptyResponseError(error)) return error.message;
    const status =
        error instanceof APIError && error.status !== undefined
            ? `HTTP ${error.status}`
            : "connection failure";
    return `Anthropic Bedrock ${status}; retrying in ${formatDelay(delay)}, attempt ${failedAttempts} of ${maxRetries}.`;
}

function formatDelay(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
    const seconds = milliseconds / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}
