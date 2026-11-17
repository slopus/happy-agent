import { describe, expect, it } from "vitest";

import { sanitizeVerificationDiagnostic } from "../../sources/providerScan/sanitizeVerificationDiagnostic.js";

describe("sanitizeVerificationDiagnostic", () => {
    it.each([
        ["Authorization: Bearer abc.def-ghi", "abc.def-ghi"],
        ["Invalid x-api-key: sk-ant-api03-AbCdEf123456", "sk-ant-api03-AbCdEf123456"],
        ['{"api_key":"hunter2-secret"}', "hunter2-secret"],
        ["Incorrect API key provided: sk-proj-1234567890abcdef", "sk-proj-1234567890abcdef"],
        ["key xai-0123456789abcdefghij is invalid", "xai-0123456789abcdefghij"],
        ["The access key AKIAIOSFODNN7EXAMPLE was rejected", "AKIAIOSFODNN7EXAMPLE"],
        ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl expired", "eyJhbGciOiJIUzI1NiJ9"],
        ["password=correct-horse&user=me", "correct-horse"],
        ["opaque wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYabcdef value", "wJalrXUtnFEMI"],
    ])("redacts credentials in %j", (input, secret) => {
        const output = sanitizeVerificationDiagnostic(input);
        expect(output).not.toContain(secret);
        expect(output).toContain("[redacted]");
    });

    it("keeps only the origin and path of URLs", () => {
        expect(
            sanitizeVerificationDiagnostic(
                "POST https://user:pass@gateway.corp.example:8443/v1/chat?api-key=s3cret#frag failed.",
            ),
        ).toBe("POST https://gateway.corp.example:8443/v1/chat failed.");
    });

    it("replaces local file paths", () => {
        const output = sanitizeVerificationDiagnostic(
            "Could not read /Users/ada/.aws/credentials or C:\\Users\\ada\\.aws\\config",
        );
        expect(output).toBe("Could not read [path] or [path]");
    });

    it("keeps readable vendor text and bounds its length", () => {
        expect(
            sanitizeVerificationDiagnostic(
                "You don't have access to the model with the specified model ID.\n",
            ),
        ).toBe("You don't have access to the model with the specified model ID.");
        const long = sanitizeVerificationDiagnostic("word ".repeat(200), 50);
        expect(long).toHaveLength(50);
        expect(long?.endsWith("…")).toBe(true);
    });

    it("returns nothing when only a secret remains", () => {
        expect(sanitizeVerificationDiagnostic("  sk-ant-api03-0123456789  ")).toBeUndefined();
        expect(sanitizeVerificationDiagnostic("\n\t")).toBeUndefined();
    });
});
