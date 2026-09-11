import type { PermissionReviewTranscript } from "../../sources/permissions/PermissionReviewer.js";
import { describe, expect, it } from "vitest";

import { convertGuardianReview } from "../../sources/auto/impl/convertGuardianReview.js";

function guardian(outcome: string, extra: Record<string, string> = {}): string {
    const fields = Object.entries({ outcome, ...extra }).map(
        ([name, value]) => `<${name}>${value}</${name}>`,
    );
    return `<review>\n${fields.join("\n")}\n</review>`;
}

describe("convertGuardianReview", () => {
    it("maps a supported allow to an allowed decision carrying the guardian's own reason", () => {
        const decision = convertGuardianReview({
            text: guardian("allow", {
                risk_level: "low",
                user_authorization: "high",
                rationale: "Routine local edit.",
            }),
            userEvidenceOmitted: false,
        });
        expect(decision).toEqual({
            outcome: "allowed",
            reason: "Routine local edit.",
            risk: "low",
            userAuthorization: "high",
        });
    });

    it("maps an explicit deny to a denied decision", () => {
        const decision = convertGuardianReview({
            text: guardian("deny", { rationale: "Writes outside the workspace." }),
            userEvidenceOmitted: false,
        });
        expect(decision.outcome).toBe("denied");
        expect(decision.reason).toBe("Writes outside the workspace.");
    });

    it("denies an allow the independent policy rejects (high risk without medium authorization)", () => {
        const decision = convertGuardianReview({
            text: guardian("allow", {
                risk_level: "high",
                user_authorization: "low",
                rationale: "Risky but requested.",
            }),
            userEvidenceOmitted: false,
        });
        expect(decision.outcome).toBe("denied");
    });

    it("honors a critical allow after informed user authorization", () => {
        const decision = convertGuardianReview({
            text: guardian("allow", {
                risk_level: "critical",
                user_authorization: "high",
                rationale: "The user explicitly approved the exact action after risk disclosure.",
            }),
            userEvidenceOmitted: false,
        });
        expect(decision).toEqual({
            outcome: "allowed",
            risk: "critical",
            userAuthorization: "high",
            reason: "The user explicitly approved the exact action after risk disclosure.",
        });
    });

    it("treats a completed but unreadable answer as a denial, not an error", () => {
        const decision = convertGuardianReview({
            text: "the reviewer rambled without a verdict",
            userEvidenceOmitted: false,
        });
        expect(decision.outcome).toBe("denied");
        expect(decision.reason).toBe(
            "The automatic permission review returned an unreadable decision.",
        );
    });

    it("carries the transcript and userEvidenceOmitted flag through", () => {
        const transcript: PermissionReviewTranscript = {
            entries: [{ type: "text", text: "checked" }],
            modelId: "m",
            providerId: "p",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        };
        const decision = convertGuardianReview({
            text: guardian("allow", {
                risk_level: "low",
                user_authorization: "high",
                rationale: "Fine.",
            }),
            transcript,
            userEvidenceOmitted: true,
        });
        expect(decision.transcript).toEqual(transcript);
        expect(decision.userEvidenceOmitted).toBe(true);
    });

    it("carries incomplete user evidence through denied decisions too", () => {
        const decision = convertGuardianReview({
            text: guardian("deny", {
                risk_level: "high",
                user_authorization: "unknown",
                rationale: "The scope is not authorized.",
            }),
            userEvidenceOmitted: true,
        });

        expect(decision).toMatchObject({
            outcome: "denied",
            userEvidenceOmitted: true,
            risk: "high",
            userAuthorization: "unknown",
        });
    });

    it("omits optional metadata when the review did not produce it", () => {
        const decision = convertGuardianReview({
            text: guardian("allow"),
            userEvidenceOmitted: false,
        });

        expect(decision).not.toHaveProperty("transcript");
        expect(decision).not.toHaveProperty("userEvidenceOmitted");
    });
});
