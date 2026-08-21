import type {
    PermissionReviewDecision,
    PermissionReviewTranscript,
} from "../../permissions/PermissionReviewer.js";
import {
    parseAutoPermissionReview,
    type AutoPermissionReview,
} from "./parseAutoPermissionReview.js";
import { shouldAllowAutoPermissionReview } from "./shouldAllowAutoPermissionReview.js";

/**
 * Turns a completed reviewer's raw final text into the v2 permission decision, applying the exact
 * v1 recovery, defaults, and independent allow-policy re-derivation.
 *
 * This is the pure core of what Happy Agent v1's `reviewAutoPermission` did after the reviewer returned,
 * minus the parts that belong to `PermissionsModule` in v2: the timeout, the abort, and the
 * unavailable/unproven outcomes a review that never returned produces. Everything here is about a
 * review that *did* return text, so there are only two v2 outcomes:
 *
 * - a parsed allow whose own risk and authorization support it becomes `allowed`;
 * - a parsed deny, a parsed allow the independent policy rejects (critical, or high without at
 *   least medium authorization), and unreadable text all become `denied`. An unreadable but
 *   completed answer is a v1 rejection, not a v2 "unavailable": the reviewer answered, it just
 *   answered unintelligibly.
 *
 * The reason carried here is the guardian's own normalized rationale, not the agent-facing refusal
 * wrapper; `PermissionsModule` wraps it when it tells the model why a call was refused. The
 * independent policy is applied once here and kept as defense in depth in `PermissionsModule`.
 */

/** What a completed but unintelligible reviewer answer maps to, exactly as v1. */
const UNREADABLE_REVIEW: AutoPermissionReview = {
    decision: "deny",
    denialKind: "rejected",
    reason: "The automatic permission review returned an unreadable decision.",
    risk: "medium",
    userAuthorization: "low",
};

export function convertGuardianReview(options: {
    /** The reviewer's raw final text, still to be parsed into a verdict. */
    text: string;
    /** What the review did and cost, recorded regardless of how the verdict ended. */
    transcript?: PermissionReviewTranscript;
    /** True when user-authorization history did not fit the whole-transcript budget. */
    userEvidenceOmitted: boolean;
}): PermissionReviewDecision {
    const { text, transcript, userEvidenceOmitted } = options;
    const parsed = parseAutoPermissionReview(text) ?? UNREADABLE_REVIEW;
    const review: AutoPermissionReview =
        parsed.decision === "allow" && !shouldAllowAutoPermissionReview(parsed)
            ? { ...parsed, decision: "deny", denialKind: "rejected" }
            : parsed;

    const extra = {
        ...(transcript === undefined ? {} : { transcript }),
        ...(userEvidenceOmitted ? { userEvidenceOmitted: true } : {}),
    };
    if (review.decision === "allow") {
        return {
            outcome: "allowed",
            reason: review.reason,
            risk: review.risk,
            userAuthorization: review.userAuthorization,
            ...extra,
        };
    }
    return {
        outcome: "denied",
        reason: review.reason,
        risk: review.risk,
        userAuthorization: review.userAuthorization,
        ...extra,
    };
}
