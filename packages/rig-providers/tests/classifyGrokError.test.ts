import { describe, expect, it } from "vitest";

import { classifyGrokError, classifyGrokProviderError } from "@/vendors/grok/errors/grokErrors.js";

describe("classifyGrokError", () => {
    it("classifies context overflow messages like grok-build", () => {
        expect(classifyGrokError("The prompt is too long for this model's context window.")).toBe(
            "context_overflow",
        );
        expect(
            classifyGrokError(
                "invalid_request_error: prompt is too long: 300000 tokens > 200000 maximum",
            ),
        ).toBe("context_overflow");
    });

    it("classifies billing and free-usage exhaustion", () => {
        expect(classifyGrokError("subscription:free-usage-exhausted quota hit")).toBe(
            "billing_error",
        );
        expect(classifyGrokError("Your credit balance is too low")).toBe("billing_error");
        expect(classifyGrokError('Error 402 "Grok Build usage balance exhausted"')).toBe(
            "billing_error",
        );
    });

    it("classifies server and transport failures as internal errors", () => {
        expect(classifyGrokError("API error (status 503): service unavailable")).toBe(
            "internal_error",
        );
        expect(classifyGrokError("empty response from model (no_visible_content)")).toBe(
            "internal_error",
        );
    });

    it("falls back to unknown for unclassified client errors", () => {
        expect(classifyGrokError("Unauthorized (401): invalid token")).toBe("unknown");
        expect(classifyGrokError("Invalid model parameter")).toBe("unknown");
    });

    it("preserves Grok status, code, request ID, and attempt count", () => {
        const error = Object.assign(new Error("service unavailable"), {
            code: "model_backend_failure",
            headers: { "x-request-id": "grok-request-1" },
            status: 503,
        });

        expect(classifyGrokProviderError(error, error.message, 3)).toEqual({
            type: "server_overloaded",
            diagnostics: {
                attempts: 3,
                code: "model_backend_failure",
                requestId: "grok-request-1",
                status: 503,
                upstreamMessage: "service unavailable",
            },
        });
    });

    it("classifies a generic HTTP 500 as an internal server error", () => {
        const error = Object.assign(new Error("request failed"), { status: 500 });

        expect(classifyGrokProviderError(error, error.message, 1)).toMatchObject({
            type: "internal_server_error",
            diagnostics: { attempts: 1, status: 500 },
        });
    });
});
