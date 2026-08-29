import type { Context } from "@steve.kite/stdlib";

import type { Compute, ComputeSessionSnapshot } from "../Compute.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";

/** How much of a command's output the machine captures unless its vendor asks for another limit. */
export const COMPUTE_COMMAND_CAPTURE_MAX_BYTES = 512_000;

/**
 * How long a command started in the background is watched before the tool answers. Long enough
 * to catch one that falls over immediately, short enough that starting a server feels instant.
 */
export const COMPUTE_BACKGROUND_GRACE_MS = 3_000;

/** One command's state at the moment the tool stopped waiting for it. */
export interface ComputeCommandOutcome {
    readonly snapshot: ComputeSessionSnapshot;
    readonly wallTimeSeconds: number;
}

/**
 * Start a shell command and wait for it as long as the caller asked.
 *
 * Reaching the wait does not kill the command. It is detached and keeps running, so the answer
 * carries a session the model can read from, type into, and stop — which is the opposite of what
 * most tools do and the reason a long build or a dev server does not have to be started twice.
 * A command the model is still waiting on belongs to the turn, so interrupting the turn takes it
 * down; one already handed back as background does not, because it was asked to outlive the call.
 */
export async function startComputeCommand(
    compute: Compute,
    ctx: Context,
    options: {
        readonly command: string;
        readonly workdir?: string;
        readonly shell?: string;
        readonly secrets?: readonly string[];
        readonly tty?: boolean;
        readonly background?: boolean;
        readonly maxOutputBytes?: number;
        readonly waitMs: number;
    },
): Promise<ComputeCommandOutcome> {
    const startedAt = Date.now();
    const permissions = computePermissionsForContext(ctx);
    const sessionId = await compute.shell.startSession({
        command: options.command,
        permissions,
        ...(options.workdir === undefined ? {} : { cwd: options.workdir }),
        maxOutputBytes: options.maxOutputBytes ?? COMPUTE_COMMAND_CAPTURE_MAX_BYTES,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        ...(options.tty === undefined ? {} : { tty: options.tty }),
        ...(options.shell === undefined ? {} : { shell: options.shell }),
    });
    const stop = () => void compute.shell.killSession(sessionId);
    const watching = options.background !== true ? ctx.lifetime : undefined;
    watching?.addEventListener("abort", stop, { once: true });
    if (watching?.aborted === true) stop();
    let snapshot;
    try {
        snapshot = await compute.shell.readSession(sessionId, {
            ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
            waitMs: options.background === true ? COMPUTE_BACKGROUND_GRACE_MS : options.waitMs,
        });
    } finally {
        watching?.removeEventListener("abort", stop);
    }
    if (snapshot === undefined) {
        // A host that cannot say how the command started leaves nothing the model could read from,
        // type into, or stop, so the session goes down with the call instead of running on with
        // no handle to it.
        try {
            await compute.shell.killSession(sessionId);
        } catch {
            // A host that has already lost the session has nothing left to stop.
        }
        throw new Error("The command could not be started.");
    }
    // Handing back a session means the command is meant to go on running, so an interrupted turn
    // must no longer take it down.
    if (snapshot.status === "running" && ctx.lifetime?.aborted !== true) {
        compute.shell.detachSession?.(sessionId);
    }
    return { snapshot, wallTimeSeconds: (Date.now() - startedAt) / 1_000 };
}
