import type { AutoPermissionReview } from "./parseAutoPermissionReview.js";

/**
 * Re-derives the decision from risk and authorization so a reviewer cannot allow an action its own
 * classification does not support. Ported from Happy Agent v1's
 * `permissions/shouldAllowAutoPermissionReview.ts`.
 *
 * `AutoModule` applies this once when it converts raw guardian output into a v2 decision, and
 * `PermissionsModule` keeps the equivalent check as defense in depth. Nothing authorizes
 * exfiltration or major irreversible destruction automatically: critical always denies, and a
 * high-risk action needs at least medium user authorization.
 */
export function shouldAllowAutoPermissionReview(review: AutoPermissionReview): boolean {
    if (review.decision !== "allow") return false;
    if (review.risk === "critical") return false;
    if (review.risk !== "high") return true;
    return review.userAuthorization === "medium" || review.userAuthorization === "high";
}
