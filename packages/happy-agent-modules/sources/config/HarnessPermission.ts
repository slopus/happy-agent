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

/** How a harness's ask was decided: an answer, or a refusal that tells the agent why. */
export type HarnessPermissionDecision =
    | AcpPermissionAnswer
    | { readonly answer: "deny"; readonly reason: string };

/**
 * What Happy's own Auto reviewer made of a harness's ask. `allowed` approves it once; `denied`
 * refuses it with `reason`, addressed to the agent; `escalate` means nothing decided it, because
 * the agent is not in Auto or the reviewer could not answer, so it goes to the person.
 */
export type HarnessPermissionReview =
    | { readonly outcome: "allowed" }
    | { readonly outcome: "denied"; readonly reason: string }
    | { readonly outcome: "escalate" };

/** Reviews a harness's ask before anyone is asked; see {@link HarnessPermissionReview}. */
export type HarnessPermissionReviewer = (
    ctx: Context,
    ask: HarnessPermissionAsk,
    signal: AbortSignal,
) => Promise<HarnessPermissionReview>;
