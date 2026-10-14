import { resolve } from "node:path";

import {
    computePermissions,
    createHostCommandWorker,
    type ComputeHostPolicy,
    type HostCommandWorker,
} from "@slopus/happy-agent-compute";
import type { RootContext } from "@steve.kite/stdlib";

import { runScanGitInWorker, scanEnvironment, type ScanGitRunner } from "../runScanGit.js";

/**
 * One long-lived read-only sandbox per workspace for Windows Git scans.
 *
 * A one-shot sandboxed command on Windows costs a sandbox logon, a private desktop, and an ACL
 * refresh. The tracker issues a stream of short Git reads per workspace, so each workspace keeps
 * one worker that pays for those once.
 *
 * A worker starts on its workspace's first scan, or ahead of time when an agent run begins there.
 * It keeps running while the tracker follows the workspace or an agent run holds it, and stops
 * five idle minutes after neither is true. Being tracked never starts a worker by itself, so a
 * daemon with many background workspaces starts only the sandboxes that actually scan.
 *
 * `limit` caps how many workers are kept; beyond it the least recently used one is stopped.
 * Eviction never stops a busy worker (a scan is still running), a held one, or one the tracker
 * follows, because stopping those fails a scan or costs a sandbox logon to restart. When nothing
 * can be evicted the count stays over the limit and shrinks as workers become idle.
 *
 * Workers use the same host policy as agent shells, because the deny set is per sandbox group
 * and a smaller set would revoke the shell's denies.
 */
export class GitScanWorkers {
    /** Scans in flight per worker key; the worker itself exposes no busy state. */
    readonly #busy = new Map<string, number>();
    readonly #held = new Map<string, number>();
    readonly #hostPolicy: () => ComputeHostPolicy | undefined;
    readonly #limit: () => number;
    readonly #lifetime: () => RootContext;
    readonly #tracked: () => Iterable<string>;
    readonly #workers = new Map<string, HostCommandWorker>();

    /**
     * `tracked` names the repository paths the Git tracker currently follows; `limit` is the
     * number of workers to keep, read whenever a worker is created or finishes work. `hostPolicy`
     * is read whenever a worker is created.
     */
    constructor(
        lifetime: () => RootContext,
        tracked: () => Iterable<string>,
        limit: () => number,
        hostPolicy: () => ComputeHostPolicy | undefined,
    ) {
        this.#lifetime = lifetime;
        this.#tracked = tracked;
        this.#limit = limit;
        this.#hostPolicy = hostPolicy;
    }

    /** The scan runner that routes each read to its workspace's worker. */
    scanner(gitCeilingDirectories: () => string | undefined): ScanGitRunner {
        return async (options) => {
            const key = this.#key(options.cwd, gitCeilingDirectories());
            const worker = this.#worker(options.cwd, gitCeilingDirectories());
            this.#busy.set(key, (this.#busy.get(key) ?? 0) + 1);
            try {
                return await runScanGitInWorker(worker, options);
            } finally {
                const count = (this.#busy.get(key) ?? 1) - 1;
                if (count <= 0) this.#busy.delete(key);
                else this.#busy.set(key, count);
                this.#trim(undefined);
            }
        };
    }

    /**
     * Starts a workspace's worker in the background and keeps it running until the returned
     * release, for an agent run that is about to scan it. Never waits and never throws.
     */
    hold(cwd: string, gitCeilingDirectories: string | undefined): () => void {
        const path = pathKey(cwd);
        this.#held.set(path, (this.#held.get(path) ?? 0) + 1);
        this.#worker(cwd, gitCeilingDirectories).warm();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const count = (this.#held.get(path) ?? 1) - 1;
            if (count <= 0) this.#held.delete(path);
            else this.#held.set(path, count);
            this.#trim(undefined);
        };
    }

    /** Stops every worker. */
    dispose(): void {
        const workers = Array.from(this.#workers.values());
        this.#workers.clear();
        this.#held.clear();
        this.#busy.clear();
        for (const worker of workers) void worker.dispose();
    }

    #inUse(path: string): boolean {
        if (this.#held.has(path)) return true;
        for (const tracked of this.#tracked()) {
            if (pathKey(tracked) === path) return true;
        }
        return false;
    }

    #key(cwd: string, gitCeilingDirectories: string | undefined): string {
        return `${pathKey(cwd)}\0${gitCeilingDirectories ?? ""}`;
    }

    /** Stops least recently used workers beyond the limit, skipping any that are in use. */
    #trim(keep: string | undefined): void {
        const limit = this.#limit();
        if (this.#workers.size <= limit) return;
        const tracked = new Set<string>();
        for (const path of this.#tracked()) tracked.add(pathKey(path));
        for (const [key, worker] of Array.from(this.#workers)) {
            if (this.#workers.size <= limit) break;
            if (key === keep || this.#busy.has(key)) continue;
            const path = key.slice(0, key.indexOf("\0"));
            if (this.#held.has(path) || tracked.has(path)) continue;
            this.#workers.delete(key);
            void worker.dispose();
        }
    }

    #worker(cwd: string, gitCeilingDirectories: string | undefined): HostCommandWorker {
        const path = pathKey(cwd);
        const key = this.#key(cwd, gitCeilingDirectories);
        const existing = this.#workers.get(key);
        if (existing !== undefined) {
            // Reinsert so the map stays ordered from least to most recently used.
            this.#workers.delete(key);
            this.#workers.set(key, existing);
            return existing;
        }
        const hostPolicy = this.#hostPolicy();
        const worker = createHostCommandWorker({
            ctx: this.#lifetime().named("git-scan-worker"),
            cwd,
            environment: scanEnvironment(cwd, gitCeilingDirectories),
            ...(hostPolicy === undefined ? {} : { hostPolicy }),
            keepAlive: () => this.#inUse(path),
            permissions: computePermissions("read_only"),
        });
        this.#workers.set(key, worker);
        this.#trim(key);
        return worker;
    }
}

/** Windows compares paths without regard to case. */
function pathKey(path: string): string {
    return resolve(path).toLowerCase();
}
