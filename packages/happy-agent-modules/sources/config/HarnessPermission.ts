import type { AcpPermissionAnswer } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

/** An action a foreign agent's own permission system wants a person to decide on. */
export interface HarnessPermissionAsk {
    /** The Happy agent the foreign agent runs as. */
    readonly agentId: string;
    readonly harnessId: string;
    /** The harness as people know it, such as "Claude Code". */
    readonly harnessName: string;
    /** What the foreign agent wants to do, in its own words. */
    readonly action: string;
    /** Whether the foreign agent offers to allow such actions for the rest of its session. */
    readonly allowForSession: boolean;
}

/**
 * Puts a harness's ask to the person and resolves with their decision, or `cancelled` once
 * `signal` aborts because the turn stopped.
 */
export type HarnessPermissionAsker = (
    ctx: Context,
    ask: HarnessPermissionAsk,
    signal: AbortSignal,
) => Promise<AcpPermissionAnswer>;
