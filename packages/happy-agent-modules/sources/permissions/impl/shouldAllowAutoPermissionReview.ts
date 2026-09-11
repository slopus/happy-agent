import type { PermissionReviewDecision } from "../PermissionReviewer.js";

/**
 * Re-derives whether an allowed review fits the independent high-risk authorization check.
 * Critical-risk outcomes remain the reviewer's policy decision, not an unconditional veto.
 */
export function shouldAllowAutoPermissionReview(decision: PermissionReviewDecision): boolean {
    if (decision.outcome !== "allowed") return false;
    if (decision.risk !== "high") return true;
    return decision.userAuthorization === "medium" || decision.userAuthorization === "high";
}

export function autoPermissionPolicyDenialReason(decision: PermissionReviewDecision): string {
    if (decision.outcome !== "allowed") return decision.reason;
    return (
        `The independent Auto policy requires at least medium user authorization for high-risk ` +
        `actions, but this review reported ${decision.userAuthorization} authorization.`
    );
}
