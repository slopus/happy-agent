import type { Usage } from "../protocol/index.js";

export type AutoPermissionRisk = "low" | "medium" | "high" | "critical";
export type AutoPermissionUserAuthorization = "unknown" | "low" | "medium" | "high";
export type AutoPermissionDenialKind = "rejected" | "timed_out" | "unavailable";

export interface AutoPermissionReview {
    decision: "allow" | "deny";
    denialKind?: AutoPermissionDenialKind;
    reason: string;
    risk: AutoPermissionRisk;
    userAuthorization: AutoPermissionUserAuthorization;
    transcript?: PermissionReviewTranscript;
}

/**
 * Persisted evidence from a permission review. The Agent Base path owns producing reviews; Rig
 * keeps this DTO only because historical session events expose it through the public protocol.
 */
export interface PermissionReviewTranscript {
    entries: readonly PermissionReviewTranscriptEntry[];
    modelId: string;
    providerId: string;
    usage: Usage;
}

export type PermissionReviewTranscriptEntry =
    | { type: "thinking"; text: string }
    | { type: "text"; text: string }
    | { type: "tool_call"; name: string; arguments: string }
    | { type: "tool_result"; name: string; isError: boolean; text: string };