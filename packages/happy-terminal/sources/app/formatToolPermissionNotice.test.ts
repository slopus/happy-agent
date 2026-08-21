import { describe, expect, it } from "vitest";

import { formatToolPermissionNotice } from "./formatToolPermissionNotice.js";

describe("formatToolPermissionNotice", () => {
    it("makes temporary Full access explicit for an elevated allowed call", () => {
        expect(
            formatToolPermissionNotice({
                elevated: true,
                review: {
                    outcome: "allowed",
                    reason: "The user explicitly requested the release.",
                    risk: "high",
                    userAuthorization: "high",
                },
            }),
        ).toBe(
            "Auto-reviewed: Allowed. Temporary Full access. Risk: High. User authorization: High. Reason: The user explicitly requested the release.",
        );
    });

    it("distinguishes sandboxed, denied, and unproven outcomes", () => {
        expect(
            formatToolPermissionNotice({
                elevated: false,
                review: {
                    outcome: "allowed",
                    reason: "The action stays inside the workspace.",
                    risk: "low",
                    userAuthorization: "medium",
                },
            }),
        ).toContain("Allowed. Stayed sandboxed.");
        expect(
            formatToolPermissionNotice({
                elevated: false,
                review: {
                    outcome: "denied",
                    reason: "The destination is not authorized.",
                    risk: "critical",
                    userAuthorization: "unknown",
                },
            }),
        ).toContain("Denied. Tool not run.");
        expect(
            formatToolPermissionNotice({
                elevated: false,
                review: {
                    outcome: "unproven",
                    kind: "timed_out",
                    reason: "The reviewer did not answer in time.",
                },
            }),
        ).toBe(
            "Auto-reviewed: Unproven (timed out). Tool not run. Reason: The reviewer did not answer in time.",
        );
    });
});
