import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
    createPermissionReviewInstructions,
    PERMISSION_REVIEW_FOLLOWUP_REMINDER,
    PERMISSION_REVIEW_INSTRUCTIONS,
} from "../../sources/auto/impl/createPermissionReviewInstructions.js";

describe("createPermissionReviewInstructions", () => {
    it("already permits informed post-denial approval without overriding absolute policy restrictions", () => {
        expect(PERMISSION_REVIEW_INSTRUCTIONS).toContain(
            "the user clearly and explicitly re-approves the exact previously denied action after seeing the concrete risk",
        );
        expect(PERMISSION_REVIEW_FOLLOWUP_REMINDER).toContain(
            "Use prior reviews as context, not binding precedent",
        );
        expect(PERMISSION_REVIEW_FOLLOWUP_REMINDER).toContain(
            "unless the policy explicitly disallows user overwrites",
        );
    });

    it("pins the generated no-policy prompt to known bytes", () => {
        // The judging policy is still v1's, byte for byte; only the output contract deviates, so
        // the reviewer answers in tags instead of hand-assembled JSON. Any further drift in the
        // prompt should be a deliberate edit, not an accident.
        expect(PERMISSION_REVIEW_INSTRUCTIONS).toHaveLength(13_889);
        expect(createHash("sha256").update(PERMISSION_REVIEW_INSTRUCTIONS).digest("hex")).toBe(
            "646e3c230601fbb42ea960ea1c97449e606cc329c63fddc4629e51ea7283ba83",
        );
    });

    it("asks for the verdict as tagged fields the rationale cannot break", () => {
        expect(PERMISSION_REVIEW_INSTRUCTIONS).toContain("<outcome>allow | deny</outcome>");
        expect(PERMISSION_REVIEW_INSTRUCTIONS).toContain("<rationale>One concise sentence.");
        expect(PERMISSION_REVIEW_INSTRUCTIONS).not.toContain("strict JSON");
    });

    it("appends a user security policy under the fixed stricter-wins heading", () => {
        const instructions = createPermissionReviewInstructions(
            "Treat releases to production as high risk.",
        );

        expect(instructions).toContain("Organization: default generic tenant.");
        expect(instructions).toContain("Treat releases to production as high risk.");
        expect(instructions).toContain("## User security policy");
        expect(instructions).toContain("follow whichever rule is stricter");
        expect(instructions).not.toContain("{{ tenant_policy_config }}");
    });

    it("uses only the built-in policy when the security policy is blank", () => {
        expect(createPermissionReviewInstructions("   \n  ")).toBe(PERMISSION_REVIEW_INSTRUCTIONS);
        expect(createPermissionReviewInstructions(undefined)).toBe(PERMISSION_REVIEW_INSTRUCTIONS);
    });

    it("preserves replacement-string metacharacters in user security policy text", () => {
        const policy = "literal $& marker $` prefix and $' suffix";
        const instructions = createPermissionReviewInstructions(policy);

        expect(instructions).toContain(policy);
    });
});
