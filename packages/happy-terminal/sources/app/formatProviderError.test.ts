import { describe, expect, it } from "vitest";

import { formatProviderError } from "./formatProviderError.js";

describe("formatProviderError", () => {
    it("reports exhausted tokens with an optional reset", () => {
        expect(
            formatProviderError(
                { resetAt: 121_000, type: "out_of_tokens" },
                { fallbackMessage: "raw billing error", now: 1_000, providerId: "claude" },
            ),
        ).toBe("Claude Code is out of tokens. Resets in 2m 0s.");
        expect(
            formatProviderError(
                { resetAt: 121_000, type: "out_of_tokens" },
                { fallbackMessage: "raw billing error", now: 2_500, providerId: "claude" },
            ),
        ).toBe("Claude Code is out of tokens. Resets in 1m 59s.");
        expect(
            formatProviderError(
                { resetAt: 121_000, type: "out_of_tokens" },
                { fallbackMessage: "raw billing error", now: 121_000, providerId: "claude" },
            ),
        ).toBe("Claude Code is out of tokens. Resets now.");
        expect(
            formatProviderError(
                { type: "out_of_tokens" },
                { fallbackMessage: "raw billing error", now: 1_000, providerId: "claude" },
            ),
        ).toBe("Claude Code is out of tokens.");
    });

    it("reports ordinary rate limits for a named provider", () => {
        expect(
            formatProviderError(
                { resetAt: 61_000, type: "rate_limit" },
                { fallbackMessage: "raw 429", now: 1_000, providerId: "kirill_claude" },
            ),
        ).toBe("Kirill Claude is rate limited. Try again in 1m 0s.");
        expect(
            formatProviderError(
                { resetAt: 61_000, type: "rate_limit" },
                { fallbackMessage: "raw 429", now: 30_500, providerId: "kirill_claude" },
            ),
        ).toBe("Kirill Claude is rate limited. Try again in 31s.");
        expect(
            formatProviderError(
                { resetAt: 61_000, type: "rate_limit" },
                { fallbackMessage: "raw 429", now: 61_500, providerId: "kirill_claude" },
            ),
        ).toBe("Kirill Claude is rate limited. Try again now.");
    });

    it("reports overloaded and internal provider failures with useful recovery details", () => {
        expect(
            formatProviderError(
                { type: "server_overloaded" },
                { fallbackMessage: "raw overload", providerId: "codex" },
            ),
        ).toBe("Codex servers are overloaded. Try again later.");
        expect(
            formatProviderError(
                {
                    type: "internal_server_error",
                    diagnostics: { requestId: "request-123" },
                },
                { fallbackMessage: "raw internal error", providerId: "codex" },
            ),
        ).toBe("Codex encountered an internal server error. Try again. Request ID: request-123.");
    });

    it("reports exhausted empty responses", () => {
        expect(
            formatProviderError(
                { type: "empty_response", diagnostics: { attempts: 3 } },
                { fallbackMessage: "raw empty response", providerId: "codex" },
            ),
        ).toBe("Codex repeatedly returned an empty response. Try again.");
    });

    it("explains expired credentials instead of showing the upstream diagnostic string", () => {
        expect(
            formatProviderError(
                { type: "authentication" },
                { fallbackMessage: "raw 401", providerId: "grok" },
            ),
        ).toBe("Grok Build credentials have expired. Run grok to sign in again.");
    });

    it("recognizes an unclassified credential rejection from its raw text", () => {
        const raw =
            'Error 401 "Invalid or expired credentials (auth_kind=bearer, x_xai_token_auth=xai-grok-cli, upstream=PermissionDenied, reason=no auth context)"';

        expect(
            formatProviderError(
                { type: "unclassified" },
                { fallbackMessage: raw, providerId: "grok" },
            ),
        ).toBe("Grok Build credentials have expired. Run grok to sign in again.");
        expect(formatProviderError(undefined, { fallbackMessage: raw, providerId: "grok" })).toBe(
            "Grok Build credentials have expired. Run grok to sign in again.",
        );
    });

    it("falls back to a generic sign-in hint for an unknown provider", () => {
        expect(
            formatProviderError(
                { type: "authentication" },
                { fallbackMessage: "raw 401", providerId: "acme" },
            ),
        ).toBe("Acme credentials have expired. Sign in again.");
    });

    it("preserves the provider message for unclassified errors", () => {
        expect(
            formatProviderError(
                { type: "unclassified" },
                { fallbackMessage: "Anthropic's API is unavailable", providerId: "claude" },
            ),
        ).toBe("Anthropic's API is unavailable");
    });
});
