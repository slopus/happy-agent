export type { Model } from "@slopus/happy-agent-base";
export type { SessionProviderError as ProviderError } from "@slopus/happy-providers";

/** Service tiers exposed by Rig's stable HTTP and terminal protocol. */
export type ServiceTier = "fast";

/** Terminal outcome names retained by Rig's existing session protocol. */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** Provider-reported token usage plus Rig's existing cost projection fields. */
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoning?: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}