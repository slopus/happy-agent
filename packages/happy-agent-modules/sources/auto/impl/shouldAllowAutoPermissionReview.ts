import type { AutoPermissionReview } from "./parseAutoPermissionReview.js";

/**
 * Re-derives the decision from risk and authorization so a reviewer cannot allow an action its own
 * high-risk authorization does not support. Ported from Happy Agent v1's
 * `permissions/shouldAllowAutoPermissionReview.ts`.
 *
 * `AutoModule` applies this once when it converts raw guardian output into a v2 decision, and
 * `PermissionsModule` keeps the equivalent check as defense in depth. Critical-risk outcomes
 * remain the reviewer's policy decision, including informed post-denial user approval; the
 * runtime must not silently replace that verdict. High risk still needs medium authorization.
 */
export function shouldAllowAutoPermissionReview(review: AutoPermissionReview): boolean {
    if (review.decision !== "allow") return false;
    if (review.risk !== "high") return true;
    return review.userAuthorization === "medium" || review.userAuthorization === "high";
}
