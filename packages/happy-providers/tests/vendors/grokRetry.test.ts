import { describe, expect, it, vi } from "vitest";

import {
    delayBeforeGrokRetry,
    isGrokAbortError,
    isRetryableGrokError,
} from "@/vendors/grok/impl/grokRetry.js";
import { isRetryableGrokCompactionError } from "@/vendors/grok/errors/grokErrors.js";

describe("Grok retry contract", () => {
    it.each([
        "Authentication failed: expired session",
        "invalid client configuration: missing model",
        "serialization error: malformed response",
        "Failed to parse API response at line 1 column 2",
        "inference idle timeout after 300s with no chunks",
        "Model stopped responding after 300s",
        "response truncated by max_tokens",
    ])("does not resample deterministic compaction failure: %s", (message) => {
        expect(isRetryableGrokCompactionError(message)).toBe(false);
    });

    it.each([
        "API error (status 408): timeout",
        "API error (status 429): rate limited",
        "API error (status 501): unavailable",
        "Event stream error: disconnected",
    ])("resamples transient compaction failure: %s", (message) => {
        expect(isRetryableGrokCompactionError(message)).toBe(true);
    });

    it.each([429, 500, 502, 503, 504, 520])(
        "retries production HTTP %s before output",
        (status) => {
            expect(isRetryableGrokError({ status, message: "request failed" })).toBe(true);
        },
    );

    it.each([400, 401, 403, 404, 408, 409, 422, 501, 505, 599])(
        "does not retry terminal HTTP %s",
        (status) => {
            expect(isRetryableGrokError({ status, message: "request failed" })).toBe(false);
        },
    );

    it.each([
        "subscription:free-usage-exhausted",
        "Your credit balance is too low",
        'Error 402 "Grok Build usage balance exhausted"',
    ])("does not retry a spent account as an ordinary 429: %s", (message) => {
        expect(isRetryableGrokError({ status: 429, message })).toBe(false);
    });

    it("retries nested transport failures", () => {
        expect(
            isRetryableGrokError({
                message: "request failed",
                cause: { code: "ECONNRESET" },
            }),
        ).toBe(true);
    });

    it("never retries aborts", () => {
        expect(isRetryableGrokError({ name: "AbortError", status: 503 })).toBe(false);
    });

    it("recognizes an abort wrapped inside another failure's cause", () => {
        const wrapped = { message: "stream failed", cause: { name: "AbortError" } };
        expect(isGrokAbortError(wrapped)).toBe(true);
        expect(isRetryableGrokError(wrapped)).toBe(false);
    });

    it("classifies aborts without looping on a cyclic cause", () => {
        const looped: { name: string; cause?: unknown } = { name: "SomethingElse" };
        looped.cause = looped;
        expect(isGrokAbortError(looped)).toBe(false);
    });

    it("honors the proxy's explicit no-retry header", () => {
        expect(
            isRetryableGrokError({
                status: 503,
                headers: { "x-should-retry": "false" },
            }),
        ).toBe(false);
    });

    it("honors the proxy retry delay", async () => {
        vi.useFakeTimers();
        try {
            let completed = false;
            const delay = delayBeforeGrokRetry(1, undefined, {
                headers: { "retry-after-ms": "25" },
            }).then(() => {
                completed = true;
            });
            await vi.advanceTimersByTimeAsync(24);
            expect(completed).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await delay;
            expect(completed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("removes the abort listener after a successful retry delay", async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            const add = vi.spyOn(controller.signal, "addEventListener");
            const remove = vi.spyOn(controller.signal, "removeEventListener");
            const delay = delayBeforeGrokRetry(1, controller.signal, {
                headers: { "retry-after-ms": "25" },
            });

            await vi.advanceTimersByTimeAsync(25);
            await delay;

            expect(add).toHaveBeenCalledOnce();
            expect(remove).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});
