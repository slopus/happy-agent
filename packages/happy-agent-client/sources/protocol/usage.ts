/**
 * Usage: what was consumed, never summarized across models.
 *
 * Tokens from different models are not comparable quantities, so the breakdown
 * is always by provider and then by model; a client wanting a rollup computes
 * its own.
 */

/** Token counts for one model. */
export interface ModelUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Provider key, then model ID, then the counts. */
export type UsageBreakdown = Record<string, Record<string, ModelUsage>>;

/** One normalized account-usage window reported by a provider. */
export interface ProviderAccountUsageWindow {
    usedPercent: number;
    resetsAt: number | null;
    startsAt: number | null;
    durationMs: number | null;
}

/** Spendable balance reported alongside a provider's account limits. */
export interface ProviderAccountUsageCredits {
    available: boolean;
    remainingCents: number | null;
    unlimited: boolean;
    usedPercent: number | null;
}

/** The complete latest normalized account-usage reading from one vendor. */
export interface ProviderAccountUsage {
    providerId: string;
    vendor: "claude" | "codex" | "grok";
    capturedAt: number;
    planName: string | null;
    exhausted: boolean;
    windows: {
        fiveHour: ProviderAccountUsageWindow | null;
        weekly: ProviderAccountUsageWindow | null;
        monthly: ProviderAccountUsageWindow | null;
    };
    credits: ProviderAccountUsageCredits | null;
}

/** One configured provider, its complete model catalog, and its latest account limits. */
export interface ProviderUsageEntry {
    providerId: string;
    /** The canonical provider key from the effective configuration. */
    type: string;
    enabled: boolean;
    /** The same complete model-reference list returned for this provider by `GET /v0/config`. */
    models: import("./daemon.js").ProviderModelReference[];
    usage: ProviderAccountUsage | null;
    checkedAt: number | null;
    error: string | null;
}

/** The latest exact provider measurement of one agent's active conversation context. */
export interface AgentContextUsage {
    approximate: boolean;
    contextTokens: number;
    /** The configured hard limit, or `null` for a custom model with no known limit. */
    contextWindow: number | null;
    modelId: string | null;
    providerId: string;
}

/** `GET /v0/agents/:agentId/usage` — the agent's whole life, subagents included. */
export interface AgentUsageResponse {
    /** The root agent's current context; descendant contexts are deliberately separate. */
    context: AgentContextUsage | null;
    usage: UsageBreakdown;
}

/** `GET /v0/usage` — rolling windows ending now. */
export interface DaemonUsageResponse {
    /** Optional only so this client remains compatible with older protocol-22 daemons. */
    providers?: ProviderUsageEntry[];
    hour: UsageBreakdown;
    day: UsageBreakdown;
    week: UsageBreakdown;
    month: UsageBreakdown;
}
