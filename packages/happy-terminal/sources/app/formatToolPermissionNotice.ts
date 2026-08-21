import type { ToolPermission } from "../protocol/index.js";
import { humanizePermissionReviewLevel } from "./humanizePermissionReviewLevel.js";

/** One compact, human-readable audit line for a tool's automatic permission review. */
export function formatToolPermissionNotice(permission: ToolPermission): string {
    const { elevated, review } = permission;
    if (review.outcome === "unproven") {
        const kind = review.kind === "timed_out" ? "timed out" : "reviewer unavailable";
        return `Auto-reviewed: Unproven (${kind}). Tool not run. Reason: ${review.reason}`;
    }

    const outcome = review.outcome === "allowed" ? "Allowed" : "Denied";
    const execution =
        review.outcome === "denied"
            ? "Tool not run"
            : elevated
              ? "Temporary Full access"
              : "Stayed sandboxed";
    return `Auto-reviewed: ${outcome}. ${execution}. Risk: ${humanizePermissionReviewLevel(review.risk)}. User authorization: ${humanizePermissionReviewLevel(review.userAuthorization)}. Reason: ${review.reason}`;
}
