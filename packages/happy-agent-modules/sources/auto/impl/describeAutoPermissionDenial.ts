import type { AutoPermissionReview } from "./parseAutoPermissionReview.js";

/**
 * What the agent is told when Auto refuses an action, ported byte-for-byte from Happy Agent v1's
 * `permissions/describeAutoPermissionDenial.ts`.
 *
 * The refusal is addressed to the agent rather than to the user, because Auto decides on the
 * user's behalf and never interrupts them. A reviewer's real judgement forbids routing around the
 * refusal; a timeout or an unavailable reviewer only makes the action unproven, so those messages
 * say so and invite a retry or asking the user, rather than treating the outcome as a verdict.
 */
export function describeAutoPermissionDenial(action: string, review: AutoPermissionReview): string {
    if (review.denialKind === "timed_out") {
        return [
            `The automatic permission review did not finish in time, so ${action} was not performed.`,
            "The action is unproven rather than unsafe, so do not treat the timeout by itself as a",
            "verdict. You may try once more, or ask the user how to proceed.",
        ].join(" ");
    }
    if (review.denialKind === "unavailable") {
        return [
            `The automatic permission review could not run, so ${action} was not performed.`,
            "No judgement was made about the action itself. Continue with work that does not need",
            "this permission, or ask the user how to proceed.",
        ].join(" ");
    }
    return [
        `Automatic permission review refused ${action}.`,
        `Reason: ${review.reason}`,
        "Do not pursue the same outcome by another route, by splitting it into smaller steps, or by",
        "working around the restriction. Continue only with a materially safer alternative.",
        "Otherwise stop and tell the user what you wanted to do and why it was refused, so they can",
        "decide.",
    ].join(" ");
}
