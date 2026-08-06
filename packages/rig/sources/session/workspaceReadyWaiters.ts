import type { ProjectWorkspace } from "../protocol/index.js";
import { AbortedError, throwIfAborted } from "../concurrency/index.js";

type WorkspaceWaiter = {
    abort: () => void;
    reject: (error: Error) => void;
    resolve: (workspace: ProjectWorkspace) => void;
    signal: AbortSignal | undefined;
};

export function createWorkspaceReadyWaiters(
    workspace: (projectId: string, workspaceId: string) => ProjectWorkspace | undefined,
): {
    changed(projectId: string, workspaceId: string): void;
    close(): void;
    wait(projectId: string, workspaceId: string, signal?: AbortSignal): Promise<ProjectWorkspace>;
} {
    const waiters = new Map<string, Set<WorkspaceWaiter>>();
    const keyFor = (projectId: string, workspaceId: string) => `${projectId}\u0000${workspaceId}`;

    const result = (
        projectId: string,
        workspaceId: string,
    ): ProjectWorkspace | Error | undefined => {
        const current = workspace(projectId, workspaceId);
        if (current === undefined)
            return new Error("That workspace was not found in that project.");
        if (current.status === "initializing") return undefined;
        if (current.status !== "ready") {
            return new Error(
                `The workspace is ${current.status.replaceAll("_", " ")} and cannot start work.`,
            );
        }
        if (current.presence === "missing") {
            return new Error("The workspace directory is unavailable and cannot start work.");
        }
        return current;
    };

    const settle = (projectId: string, workspaceId: string) => {
        const key = keyFor(projectId, workspaceId);
        const pending = waiters.get(key);
        if (pending === undefined) return;
        const current = result(projectId, workspaceId);
        if (current === undefined) return;
        waiters.delete(key);
        for (const waiter of pending) {
            waiter.signal?.removeEventListener("abort", waiter.abort);
            if (current instanceof Error) waiter.reject(current);
            else waiter.resolve(current);
        }
    };

    return {
        changed: settle,
        close: () => {
            for (const pending of waiters.values()) {
                for (const waiter of pending) {
                    waiter.signal?.removeEventListener("abort", waiter.abort);
                    waiter.reject(new Error("Rig closed while waiting for the workspace."));
                }
            }
            waiters.clear();
        },
        wait: (projectId, workspaceId, signal) => {
            throwIfAborted(signal);
            const current = result(projectId, workspaceId);
            if (current instanceof Error) return Promise.reject(current);
            if (current !== undefined) return Promise.resolve(current);
            return new Promise<ProjectWorkspace>((resolve, reject) => {
                const key = keyFor(projectId, workspaceId);
                const pending = waiters.get(key) ?? new Set<WorkspaceWaiter>();
                waiters.set(key, pending);
                let waiter!: WorkspaceWaiter;
                waiter = {
                    abort: () => {
                        pending.delete(waiter);
                        if (pending.size === 0) waiters.delete(key);
                        reject(new AbortedError("Waiting for the workspace was aborted."));
                    },
                    reject,
                    resolve,
                    signal,
                };
                pending.add(waiter);
                signal?.addEventListener("abort", waiter.abort, { once: true });
                settle(projectId, workspaceId);
            });
        },
    };
}
