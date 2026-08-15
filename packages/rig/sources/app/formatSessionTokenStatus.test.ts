import { describe, expect, it } from "vitest";

import type { Usage } from "../protocol/index.js";
import { formatSessionTokenStatus } from "./formatSessionTokenStatus.js";

describe("formatSessionTokenStatus", () => {
    it("counts cached input once through the cache rate without inflating session tokens", () => {
        expect(
            formatSessionTokenStatus({
                contextTokens: 1_600,
                contextWindow: 200_000,
                sessionTokens: 1_300,
                usage: usage({
                    cacheRead: 1_000,
                    cacheWrite: 200,
                    input: 800,
                    output: 300,
                    totalTokens: 2_300,
                }),
            }),
        ).toBe("1.3k tokens · 50% cache hit · 99% ctx left");
    });

    it("excludes output from cache-hit eligibility and handles providers without a context window", () => {
        expect(
            formatSessionTokenStatus({
                contextTokens: 1_000,
                sessionTokens: 1_000,
                usage: usage({
                    cacheRead: 0,
                    cacheWrite: 0,
                    input: 0,
                    output: 1_000,
                    totalTokens: 1_000,
                }),
            }),
        ).toBe("1.0k tokens · 0% cache hit");
    });
});

function usage(values: Omit<Usage, "cost">): Usage {
    return {
        ...values,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    };
}
