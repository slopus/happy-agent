import type { SessionTokenCount, Usage } from "../index.js";

export interface AttributedSessionUsageGroup {
    kind: "attributed";
    modelId: string;
    providerId: string;
    requestedModelId: string;
    responseModel?: string;
    /**
     * Set when the tokens were spent reviewing permissions rather than answering the user. Kept
     * separate from the conversation's own usage, which stays true when a reviewer happens to run
     * on the same model as the agent it reviews.
     */
    role?: "permission_review";
    usage: Usage;
}

export type SessionUsageGroup = AttributedSessionUsageGroup;

export interface SessionContextUsage {
    approximate: boolean;
    modelId: string;
    providerId: string;
    requestedModelId: string;
    responseModel?: string;
    totalTokens: number;
}

export interface SessionUsageSummary {
    currentContext?: SessionContextUsage;
    groups: readonly SessionUsageGroup[];
    sessionTokenCount: SessionTokenCount;
}

export interface SessionUsageMetadata {
    type: "primary" | "subagent";
}
