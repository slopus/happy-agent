import { delay } from "./concurrency/index.js";

/**
 * Happy's machine RPC gateway expires calls after 30 seconds. A worktree spawn
 * reserves 15 seconds for the session to be published remotely, leaving this
 * bounded window for the local workspace checkout to become ready.
 */
export const HAPPY_MACHINE_RPC_TIMEOUT_MS = 30_000;
export const HAPPY_REMOTE_SESSION_WAIT_MS = 15_000;
export const HAPPY_WORKSPACE_READY_WAIT_MS = 8_000;
export const HAPPY_SPAWN_PENDING_RETRY_AFTER_MS = 2_000;

/** The local workspace preparation outcome that precedes a Happy spawn. */
export type HappyWorkspaceCreationResult =
    // Keep the ready discriminator optional for existing HappySyncService
    // embedders that returned the pre-pending `{ id, path }` shape.
    { id: string; path: string; type?: "ready" } | { retryAfterMs: number; type: "pending" };

const WORKSPACE_POLL_INTERVAL_MS = 100;

/**
 * Wait only within the machine-RPC budget for a workspace reservation to be
 * materialized. The reservation remains durable, so callers can safely retry
 * the same client request after a pending result.
 */
export async function waitForHappyWorkspaceReady(options: {
    getWorkspace: () =>
        | { error?: string; id: string; path: string; status: string }
        | Promise<{ error?: string; id: string; path: string; status: string } | undefined>
        | undefined;
    now?: () => number;
    signal?: AbortSignal;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<HappyWorkspaceCreationResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? delay;
    const deadline = now() + HAPPY_WORKSPACE_READY_WAIT_MS;
    for (;;) {
        options.signal?.throwIfAborted();
        const workspace = await options.getWorkspace();
        if (workspace === undefined) {
            throw new Error("The workspace disappeared while it was being prepared.");
        }
        if (workspace.status === "ready") {
            return { id: workspace.id, path: workspace.path, type: "ready" };
        }
        if (workspace.status !== "initializing") {
            throw new Error(
                workspace.error ?? `The workspace is ${workspace.status.replaceAll("_", " ")}.`,
            );
        }
        if (now() >= deadline) {
            return {
                retryAfterMs: HAPPY_SPAWN_PENDING_RETRY_AFTER_MS,
                type: "pending",
            };
        }
        await sleep(Math.min(WORKSPACE_POLL_INTERVAL_MS, deadline - now()), options.signal);
    }
}
