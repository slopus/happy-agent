import { describe, expect, it } from "vitest";

import { shouldAllowAutoPermissionReview } from "../../sources/auto/impl/shouldAllowAutoPermissionReview.js";

describe("shouldAllowAutoPermissionReview", () => {
    it.each([
        ["low", "low", true],
        ["low", "unknown", true],
        ["medium", "low", true],
        ["medium", "unknown", true],
        ["high", "unknown", false],
        ["high", "low", false],
        ["high", "medium", true],
        ["high", "high", true],
        ["critical", "high", true],
        ["critical", "medium", true],
        ["critical", "low", true],
        ["critical", "unknown", true],
    ] as const)(
        "treats %s risk with %s authorization as allowed=%s",
        (risk, userAuthorization, allowed) => {
            expect(
                shouldAllowAutoPermissionReview({
                    decision: "allow",
                    reason: "Reviewed.",
                    risk,
                    userAuthorization,
                }),
            ).toBe(allowed);
        },
    );

    it.each(["low", "critical"] as const)("preserves an explicit %s-risk deny decision", (risk) => {
        expect(
            shouldAllowAutoPermissionReview({
                decision: "deny",
                denialKind: "rejected",
                reason: "Needs confirmation.",
                risk,
                userAuthorization: "high",
            }),
        ).toBe(false);
    });
});
