/**
 * How long Codex waits, and when it gives up.
 *
 * Four different clocks run over a request: the backoff between attempts, the server's own
 * retry-after instruction, the gentler schedule compaction retries on, and the idle timeout that
 * decides a stream has stalled. They are collected here because they are read together whenever
 * the answer to "why did this take so long" is wanted.
 */

import { readCodexErrorHeader } from "@/vendors/codex/errors/codexErrors.js";

const DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000;

export function resolveCodexStreamIdleTimeout(value?: number): number {
    if (value === undefined) return DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        throw new TypeError("streamIdleTimeoutMs must be a finite positive integer.");
    }
    return value;
}

const MAX_SERVER_RETRY_DELAY_MS = 60_000;

export function resolveCodexRetryDelay(
    attempt: number,
    error: unknown,
    random: () => number = Math.random,
): number {
    const milliseconds = parseFiniteNumber(readCodexErrorHeader(error, "retry-after-ms"));
    if (
        milliseconds !== undefined &&
        milliseconds >= 0 &&
        milliseconds <= MAX_SERVER_RETRY_DELAY_MS
    )
        return milliseconds;
    const retryAfter = readCodexErrorHeader(error, "retry-after");
    const seconds = parseFiniteNumber(retryAfter);
    if (seconds !== undefined && seconds >= 0 && seconds * 1_000 <= MAX_SERVER_RETRY_DELAY_MS)
        return seconds * 1_000;
    if (retryAfter !== undefined) {
        const dateDelay = Date.parse(retryAfter) - Date.now();
        if (dateDelay >= 0 && dateDelay <= MAX_SERVER_RETRY_DELAY_MS) return dateDelay;
    }
    const base = 200 * 2 ** Math.max(0, attempt - 1);
    return Math.floor(base * (0.9 + random() * 0.2));
}

function parseFiniteNumber(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function waitForCodexRetry(
    attempt: number,
    error: unknown,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted)
        return Promise.reject(new DOMException("Request was aborted", "AbortError"));
    const delay = resolveCodexRetryDelay(attempt, error);
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            clearTimeout(timeout);
            reject(new DOMException("Request was aborted", "AbortError"));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

const BASE_DELAY_MS = 200;
const JITTER_FRACTION = 0.1;

export function waitForCodexCompactionRetry(attempt: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
        return Promise.reject(new DOMException("Request was aborted", "AbortError"));
    const base = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER_FRACTION;
    const delay = Math.round(base * jitter);
    return new Promise((resolve, reject) => {
        const finish = (): void => {
            signal?.removeEventListener("abort", abort);
            resolve();
        };
        const timeout = setTimeout(finish, delay);
        const abort = (): void => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            reject(new DOMException("Request was aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal !== undefined) {
            void Promise.resolve().then(() => {
                if (!signal.aborted) return;
                abort();
            });
        }
    });
}

export async function* withCodexStreamIdleTimeout<T>(options: {
    stream: AsyncIterable<T>;
    timeoutMs: number;
    signal?: AbortSignal;
    onTimeout?: () => void;
}): AsyncGenerator<T> {
    const iterator = options.stream[Symbol.asyncIterator]();
    try {
        for (;;) {
            if (options.signal?.aborted)
                throw new DOMException("Request was aborted", "AbortError");
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    options.onTimeout?.();
                    const error = new Error(
                        `Codex stream timed out after ${options.timeoutMs}ms without activity.`,
                    );
                    error.name = "TimeoutError";
                    reject(error);
                }, options.timeoutMs);
            });
            try {
                const item = await Promise.race([iterator.next(), idle]);
                if (item.done) return;
                yield item.value;
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
            }
        }
    } finally {
        void iterator.return?.();
    }
}
