import { describe, expect, it } from "vitest";

import { providerErrorResetAt } from "./providerErrorResetAt.js";

describe("providerErrorResetAt", () => {
    it("reads reset timestamps only from token and rate-limit failures", () => {
        expect(providerErrorResetAt({ resetAt: 12, type: "out_of_tokens" })).toBe(12);
        expect(providerErrorResetAt({ resetAt: 34, type: "rate_limit" })).toBe(34);
        expect(providerErrorResetAt({ type: "out_of_tokens" })).toBeUndefined();
        expect(providerErrorResetAt({ type: "authentication" })).toBeUndefined();
        expect(providerErrorResetAt(undefined)).toBeUndefined();
    });
});
