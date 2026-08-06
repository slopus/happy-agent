import { describe, expect, it } from "vitest";

import {
    extractProviderErrorDiagnostics,
    extractProviderRetryResetAt,
} from "@/core/extractProviderErrorDiagnostics.js";

describe("provider error diagnostics", () => {
    it("keeps only bounded diagnostic fields from nested provider errors", () => {
        const error = Object.assign(new Error("upstream failed"), {
            cause: {
                code: "model_backend_failure",
                headers: {
                    authorization: "secret",
                    "x-amzn-requestid": "request-123",
                },
                status: 502,
            },
        });

        const diagnostics = extractProviderErrorDiagnostics(error);

        expect(diagnostics).toEqual({
            code: "model_backend_failure",
            requestId: "request-123",
            status: 502,
            upstreamMessage: "upstream failed",
        });
        expect(JSON.stringify(diagnostics)).not.toContain("secret");
    });

    it("converts provider retry headers to an absolute reset timestamp", () => {
        expect(
            extractProviderRetryResetAt(
                { headers: new Headers({ "retry-after-ms": "2500" }) },
                () => 10_000,
            ),
        ).toBe(12_500);
        expect(extractProviderRetryResetAt({ headers: { "retry-after": "3" } }, () => 10_000)).toBe(
            13_000,
        );
    });
});
