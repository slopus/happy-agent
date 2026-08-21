import { describe, expect, it, vi } from "vitest";
import { APIConnectionError, APIUserAbortError } from "openai";

import { delayBeforeGrokRetry, isRetryableGrokError } from "@/vendors/grok/impl/grokRetry.js";
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

    it.each([408, 429, 500, 502, 503, 504, 520, 599])(
        "retries production HTTP %s before output",
        (status) => {
            expect(isRetryableGrokError({ status, message: "request failed" })).toBe(true);
        },
    );

    it.each([400, 401, 403, 404, 409, 413, 422, 451])(
        "does not retry terminal HTTP %s",
        (status) => {
            expect(isRetryableGrokError({ status, message: "request failed" })).toBe(false);
        },
    );

    it("reads the status out of a deeply wrapped rejection", () => {
        expect(isRetryableGrokError(new Error("request failed", { cause: { status: 400 } }))).toBe(
            false,
        );
    });

    it.each([
        ["a named socket failure", Object.assign(new Error("read"), { code: "ECONNRESET" })],
        [
            "a TLS alert nobody enumerated",
            Object.assign(new Error("TLS alert: bad record mac"), {
                code: "ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC",
            }),
        ],
        ["a protocol error", Object.assign(new Error("stream failed"), { code: "EPROTO" })],
        ["an error with no code at all", new Error("something went sideways")],
        ["an SDK connection error", new APIConnectionError({ cause: new Error("fetch failed") })],
        [
            "an SDK timeout wrapping a transport abort",
            new APIConnectionError({
                cause: new DOMException("The transport timed out.", "AbortError"),
            }),
        ],
        ["a bare string", "the socket hung up"],
        ["a value that is not an error", { nothing: "useful" }],
    ])("retries %s, because nothing says it is hopeless", (_description, error) => {
        expect(isRetryableGrokError(error)).toBe(true);
    });

    it.each([
        "This model's maximum context length is 500000 tokens",
        "Your credit balance is too low to continue",
        "subscription:free-usage-exhausted",
    ])("does not retry the permanently hopeless: %s", (message) => {
        expect(isRetryableGrokError(new Error(message))).toBe(false);
    });

    it("finds a hopeless meaning wrapped inside a transport error", () => {
        expect(
            isRetryableGrokError(
                new Error("fetch failed", {
                    cause: new Error("prompt is too long for this model"),
                }),
            ),
        ).toBe(false);
    });

    it.each([
        ["a bare abort", { name: "AbortError", status: 503 }],
        ["an SDK user abort", new APIUserAbortError()],
    ])("never retries %s", (_description, error) => {
        expect(isRetryableGrokError(error)).toBe(false);
    });

    it.each([
        ["directly on the rejection", { status: 503, headers: { "x-should-retry": "false" } }],
        [
            "on a nested cause",
            new APIConnectionError({
                cause: Object.assign(new Error("The proxy rejected the retry."), {
                    headers: { "x-should-retry": "false" },
                }),
            }),
        ],
    ])("honors an explicit no-retry directive %s", (_description, error) => {
        expect(isRetryableGrokError(error)).toBe(false);
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
