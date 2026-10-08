import type { Compute, ComputeWatch } from "@slopus/happy-agent-compute";
import type { Context, RootContext } from "@steve.kite/stdlib";

import type { GitWorkingFiles } from "../GitWorkingFiles.js";
import type { ScanGitRunner } from "../runScanGit.js";
import { scanGitRepository } from "../scanGitRepository.js";
import type { GitChangeSnapshot, GitChangeState, GitTrackedEntity } from "../types.js";
import type { GitStateTrackerOwner } from "./GitStateTracker.js";

const WATCH_TTL_MS = 5 * 60 * 1000;
const TRACKED_LIMIT = 256;
const DEBOUNCE_MS = 300;
/** A watched repository is still rescanned this often, for changes a watch cannot see. */
const WATCHED_POLL_MS = 2 * 60 * 1000;
/** A repository whose watch failed is polled instead. */
const UNWATCHED_POLL_MS = 30_000;
const BACKOFF_LIMIT_MS = 60_000;
/** Directories a runner watch never descends into; they hold nothing a snapshot reads. */
const WATCH_IGNORE = ["node_modules", ".venv", "target", "dist", "build", ".next"];

/** How the tracker reaches the runner a repository lives on. */
export interface RunnerGitAccess {
    readonly machine: () => Promise<Compute>;
    readonly scan: ScanGitRunner;
    readonly files: GitWorkingFiles;
}

interface Tracker {
    entity: GitTrackedEntity & { readonly runnerId: string };
    readonly key: string;
    expiresAt: number;
    lastActiveAt: number;
    generation: number;
    snapshot: GitChangeSnapshot | undefined;
    delivered: boolean;
    watch: ComputeWatch | undefined;
    watching: boolean;
    timer: NodeJS.Timeout | undefined;
    scanning: Promise<void> | undefined;
    dirtyAgain: boolean;
    failures: number;
}

/**
 * Live Git tracking for repositories on runners.
 *
 * The same contract as the local tracker — bounded, expiring subscriptions, debounced rescans,
 * change-only publication — over the runner's own file watch and Git. Git metadata lives inside
 * the watched folder, so one recursive watch covers commits, staging, and branch moves too.
 */
export class RunnerGitStateTracker {
    readonly #ctx: Context;
    readonly #owner: GitStateTrackerOwner;
    readonly #access: (runnerId: string) => RunnerGitAccess;
    readonly #trackers = new Map<string, Tracker>();
    #disposed = false;

    constructor(
        rootContext: RootContext,
        owner: GitStateTrackerOwner,
        access: (runnerId: string) => RunnerGitAccess,
    ) {
        this.#ctx = rootContext.named("runner-git-state-tracker");
        this.#owner = owner;
        this.#access = access;
        this.#ctx.lifetime?.addEventListener("abort", () => this.dispose(), { once: true });
    }

    get trackedKeys(): readonly string[] {
        return [...this.#trackers.values()]
            .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
            .map((tracker) => tracker.key);
    }

    tracked(): readonly { entity: GitTrackedEntity; snapshot: GitChangeSnapshot }[] {
        return [...this.#trackers.values()].flatMap((tracker) =>
            tracker.snapshot === undefined
                ? []
                : [{ entity: tracker.entity, snapshot: tracker.snapshot }],
        );
    }

    watch(entity: GitTrackedEntity & { readonly runnerId: string }): void {
        if (this.#disposed) return;
        const existing = this.#trackers.get(runnerEntityKey(entity));
        if (existing !== undefined && existing.entity.path === entity.path) {
            existing.expiresAt = Date.now() + WATCH_TTL_MS;
            existing.lastActiveAt = Date.now();
            return;
        }
        if (existing !== undefined) this.#retire(existing);
        this.#start(entity);
    }

    replace(entities: readonly (GitTrackedEntity & { readonly runnerId: string })[]): void {
        if (this.#disposed) return;
        const desired = new Map(entities.map((entity) => [runnerEntityKey(entity), entity]));
        for (const tracker of Array.from(this.#trackers.values())) {
            const entity = desired.get(tracker.key);
            if (entity === undefined || entity.path !== tracker.entity.path) this.#retire(tracker);
        }
        for (const entity of desired.values()) this.watch(entity);
    }

    unwatch(entity: GitTrackedEntity): void {
        const tracker = this.#trackers.get(runnerEntityKey(entity));
        if (tracker !== undefined) this.#retire(tracker);
    }

    markChanged(entity: GitTrackedEntity): void {
        const tracker = this.#trackers.get(runnerEntityKey(entity));
        if (tracker !== undefined) this.#schedule(tracker, DEBOUNCE_MS);
    }

    snapshot(entity: GitTrackedEntity): GitChangeSnapshot | undefined {
        return this.#trackers.get(runnerEntityKey(entity))?.snapshot;
    }

    async refresh(
        ctx: Context,
        entity: GitTrackedEntity & { readonly runnerId: string },
    ): Promise<GitChangeSnapshot | undefined> {
        this.watch(entity);
        const tracker = this.#trackers.get(runnerEntityKey(entity));
        if (tracker === undefined) return undefined;
        await this.#scan(ctx, tracker);
        return tracker.snapshot;
    }

    dispose(): void {
        this.#disposed = true;
        for (const tracker of Array.from(this.#trackers.values())) this.#retire(tracker);
    }

    #start(entity: GitTrackedEntity & { readonly runnerId: string }): void {
        while (this.#trackers.size >= TRACKED_LIMIT) {
            const oldest = [...this.#trackers.values()].sort(
                (left, right) => left.lastActiveAt - right.lastActiveAt,
            )[0];
            if (oldest === undefined) break;
            this.#retire(oldest);
        }
        const tracker: Tracker = {
            entity,
            key: runnerEntityKey(entity),
            expiresAt: Date.now() + WATCH_TTL_MS,
            lastActiveAt: Date.now(),
            generation: 0,
            snapshot: undefined,
            delivered: false,
            watch: undefined,
            watching: false,
            timer: undefined,
            scanning: undefined,
            dirtyAgain: false,
            failures: 0,
        };
        this.#trackers.set(tracker.key, tracker);
        this.#schedule(tracker, 0);
        void this.#arm(tracker);
    }

    async #arm(tracker: Tracker): Promise<void> {
        const generation = tracker.generation;
        try {
            const machine = await this.#access(tracker.entity.runnerId).machine();
            const watcher = machine.watcher;
            if (watcher === undefined) return;
            const watch = await watcher.watch(this.#ctx, {
                path: tracker.entity.path,
                ignore: WATCH_IGNORE,
            });
            if (this.#trackers.get(tracker.key) !== tracker || tracker.generation !== generation) {
                watch.close();
                return;
            }
            tracker.watch = watch;
            tracker.watching = true;
            watch.onChange(() => this.#schedule(tracker, DEBOUNCE_MS));
            void watch.closed.then(() => {
                if (tracker.watch !== watch) return;
                tracker.watch = undefined;
                tracker.watching = false;
                // A watch ends when its runner drops; the poll covers the gap and rearms it.
            });
        } catch {
            tracker.watching = false;
        }
    }

    #schedule(tracker: Tracker, delayMs: number): void {
        if (this.#disposed || this.#trackers.get(tracker.key) !== tracker) return;
        if (tracker.scanning !== undefined) {
            tracker.dirtyAgain = true;
            return;
        }
        if (tracker.timer !== undefined) clearTimeout(tracker.timer);
        tracker.timer = setTimeout(() => {
            tracker.timer = undefined;
            if (Date.now() > tracker.expiresAt) {
                this.#retire(tracker);
                return;
            }
            void this.#scan(this.#ctx, tracker);
        }, delayMs);
        tracker.timer.unref?.();
    }

    async #scan(ctx: Context, tracker: Tracker): Promise<void> {
        if (tracker.scanning !== undefined) {
            tracker.dirtyAgain = true;
            await tracker.scanning;
            return;
        }
        const run = this.#runScan(ctx, tracker);
        tracker.scanning = run;
        try {
            await run;
        } finally {
            tracker.scanning = undefined;
        }
        if (this.#trackers.get(tracker.key) !== tracker) return;
        if (tracker.dirtyAgain) {
            tracker.dirtyAgain = false;
            this.#schedule(tracker, DEBOUNCE_MS);
            return;
        }
        if (!tracker.watching && tracker.failures === 0) void this.#arm(tracker);
        const backoff = Math.min(BACKOFF_LIMIT_MS, 1_000 * 2 ** tracker.failures);
        this.#schedule(
            tracker,
            tracker.failures > 0 ? backoff : tracker.watching ? WATCHED_POLL_MS : UNWATCHED_POLL_MS,
        );
    }

    async #runScan(ctx: Context, tracker: Tracker): Promise<void> {
        const generation = tracker.generation;
        const access = this.#access(tracker.entity.runnerId);
        try {
            const state = await scanGitRepository({
                files: access.files,
                path: tracker.entity.path,
                ...(tracker.snapshot === undefined ? {} : { previous: tracker.snapshot }),
                runGit: access.scan,
            });
            if (this.#trackers.get(tracker.key) !== tracker || tracker.generation !== generation)
                return;
            tracker.failures = 0;
            const unchanged = sameState(tracker.snapshot, state);
            if (unchanged && tracker.delivered) return;
            const snapshot =
                unchanged && tracker.snapshot !== undefined
                    ? tracker.snapshot
                    : this.#owner.stamp(state);
            tracker.snapshot = snapshot;
            await this.#owner.deliver(ctx, tracker.entity, snapshot);
            tracker.delivered = true;
        } catch (error) {
            tracker.failures += 1;
            this.#owner.report(ctx, error, tracker.entity);
        }
    }

    #retire(tracker: Tracker): void {
        tracker.generation += 1;
        if (tracker.timer !== undefined) clearTimeout(tracker.timer);
        tracker.timer = undefined;
        tracker.watch?.close();
        tracker.watch = undefined;
        if (this.#trackers.get(tracker.key) === tracker) this.#trackers.delete(tracker.key);
    }
}

function runnerEntityKey(entity: GitTrackedEntity): string {
    return entity.workspaceId === undefined
        ? `project:${entity.projectId}`
        : `workspace:${entity.workspaceId}`;
}

function sameState(left: GitChangeSnapshot | undefined, right: GitChangeState): boolean {
    if (left === undefined) return false;
    const { generation: _generation, scannedAt: _leftAt, version: _version, ...previous } = left;
    const { scannedAt: _rightAt, ...next } = right;
    return JSON.stringify(previous) === JSON.stringify(next);
}
