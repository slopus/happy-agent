import type { Context } from "@steve.kite/stdlib";

import { killProcessTree } from "./killProcessTree.js";

/**
 * Remembers the process groups we started so shutdown can take them down.
 *
 * A background command outlives the shell that launched it, so a group has to
 * stay reapable long after its leader is gone.
 *
 * A group is identified by the number the operating system gave it, and that
 * number is reused once the group is gone. Every group is therefore dropped as
 * soon as it dies, and checked again immediately before it is signalled, which
 * narrows the window in which a recycled identifier could be mistaken for ours
 * to the gap between that check and the signal. Closing it entirely would take
 * a kernel handle on the group, which the platforms we support do not offer.
 */
export class ProcessGroupReaper {
    readonly #groups = new Set<number>();

    retain(processGroupId: number): void {
        if (!isUsableProcessGroupId(processGroupId)) return;
        this.#prune();
        this.#groups.add(processGroupId);
    }

    release(processGroupId: number): void {
        this.#groups.delete(processGroupId);
    }

    /** The groups we would take down right now, for tests and diagnostics. */
    pending(): readonly number[] {
        this.#prune();
        return [...this.#groups];
    }

    /** Asks every surviving group to stop, then forces the ones that did not. */
    terminateAll(ctx: Context, forceAfterMs: number): Promise<void> {
        return ctx.span("happy.terminal.process.groups.terminate", async (ctx) => {
            this.#prune();
            const groups = [...this.#groups];
            this.#groups.clear();
            if (groups.length === 0) return;
            for (const processGroupId of groups) {
                await signalProcessGroup(ctx, processGroupId, "SIGTERM");
            }
            if (forceAfterMs > 0) {
                await new Promise((resolve) => {
                    setTimeout(resolve, forceAfterMs).unref();
                });
            }
            for (const processGroupId of groups) {
                if (isProcessGroupAlive(processGroupId)) {
                    await signalProcessGroup(ctx, processGroupId, "SIGKILL");
                }
            }
        });
    }

    #prune(): void {
        for (const processGroupId of this.#groups) {
            if (!isProcessGroupAlive(processGroupId)) this.#groups.delete(processGroupId);
        }
    }
}

/**
 * Signals a whole process group and nothing else.
 *
 * Unlike killing a process tree, there is deliberately no fall back to the bare
 * identifier: if the group is gone, the number may now belong to an unrelated
 * process, and signalling it would be someone else's problem.
 */
export function killProcessGroup(
    ctx: Context,
    processGroupId: number,
    signal: NodeJS.Signals,
): Promise<void> {
    return ctx.span("happy.terminal.process.signal_group", async (ctx) => {
        await signalProcessGroup(ctx, processGroupId, signal);
    });
}

async function signalProcessGroup(
    ctx: Context,
    processGroupId: number,
    signal: NodeJS.Signals,
): Promise<void> {
    if (process.platform === "win32") {
        await killProcessTree(ctx, processGroupId, signal);
        return;
    }
    try {
        process.kill(-processGroupId, signal);
    } catch {
        // The group is already gone.
    }
}

function isUsableProcessGroupId(processGroupId: number): boolean {
    // A group led by process 1 is not ours to reap.
    return Number.isSafeInteger(processGroupId) && processGroupId > 1;
}

export function isProcessGroupAlive(processGroupId: number): boolean {
    if (process.platform === "win32") {
        // Windows has no process groups to probe, so liveness is asked of the
        // leader itself.
        return isProcessAlive(processGroupId);
    }
    return isProcessAlive(-processGroupId);
}

function isProcessAlive(target: number): boolean {
    try {
        process.kill(target, 0);
        return true;
    } catch (error) {
        // Existing but owned by someone else still counts as existing.
        return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: unknown }).code === "EPERM"
        );
    }
}
