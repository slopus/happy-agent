import type { Context, RootContext } from "@steve.kite/stdlib";

import type { ScanGitRunner } from "../runScanGit.js";
import { scanGitRepository } from "../scanGitRepository.js";
import type { GitChangeSnapshot, GitChangeState, GitTrackedEntity } from "../types.js";
import {
    GitRepositoryWatchRegistry,
    supportsRecursiveWorktreeWatch,
    type GitRepositoryChange,
} from "../watchGitRepositoryChanges.js";

const WATCH_TTL_MS = 5 * 60 * 1000;
const TRACKED_LIMIT = 256;
const SCAN_CONCURRENCY = 2;
const DEBOUNCE_MS = 150;
const MAXIMUM_DEBOUNCE_MS = 750;
const RECURSIVE_WATCH_STALE_MS = 2 * 60 * 1000;
const POLLING_STALE_MS = 30_000;
const WORKTREE_PATH_LIMIT = 128;
const WORKTREE_PATH_BATCH = 64;
const PATH_STATUS_OUTPUT_LIMIT = 64 * 1024;
const BACKOFF_START_MS = 1_000;
const BACKOFF_LIMIT_MS = 30_000;

export const GIT_RECONCILE_STALE_AFTER_MS = supportsRecursiveWorktreeWatch()
    ? RECURSIVE_WATCH_STALE_MS
    : POLLING_STALE_MS;

/**
 * What a finished scan is handed back to.
 *
 * `deliver` is the Git module's snapshot publication. A failure there is retryable delivery work
 * rather than successful publication, so it reaches the tracker's bounded backoff and the same
 * snapshot stays pending. `report` only records that something went wrong and never throws.
 */
export interface GitStateTrackerOwner {
    deliver(ctx: Context, entity: GitTrackedEntity, snapshot: GitChangeSnapshot): Promise<void>;
    report(ctx: Context, error: unknown, entity: GitTrackedEntity): void;
    stamp(state: GitChangeState): GitChangeSnapshot;
}

interface RepositoryTracker {
    backoffMs: number;
    backoffTimer: NodeJS.Timeout | undefined;
    backoffUntil: number;
    classificationInFlight: boolean;
    debounceTimer: NodeJS.Timeout | undefined;
    dirtyAgain: boolean;
    entity: GitTrackedEntity;
    expiresAt: number;
    firstDirtyAt: number | undefined;
    generation: number;
    inFlight: Promise<void> | undefined;
    key: string;
    lastActiveAt: number;
    readonly pendingWorktreePaths: Set<string>;
    reconcileAt: number | undefined;
    scanController: AbortController | undefined;
    scanning: boolean;
    snapshot: GitChangeSnapshot | undefined;
    snapshotDelivered: boolean;
    unclassifiedDirty: boolean;
    unwatch: (() => void) | undefined;
}

/**
 * The live half of the Git module: bounded per-repository watching, debounced rescanning, and
 * change-only publication.
 *
 * This is module-private. `GitModule` owns the lifetime it runs on, the Git execution boundary it
 * scans through, and the subscriptions its snapshots reach; nothing outside the Git module
 * constructs one.
 */
export class GitStateTracker {
    readonly #ctx: Context;
    readonly #owner: GitStateTrackerOwner;
    readonly #pendingScans: string[] = [];
    readonly #scan: ScanGitRunner;
    readonly #trackers = new Map<string, RepositoryTracker>();
    readonly #watchRegistry: GitRepositoryWatchRegistry;
    #activeScans = 0;
    #disposed = false;
    #maintenanceTimer: NodeJS.Timeout | undefined;

    constructor(rootContext: RootContext, scan: ScanGitRunner, owner: GitStateTrackerOwner) {
        this.#ctx = rootContext.named("git-state-tracker");
        this.#owner = owner;
        this.#scan = scan;
        this.#watchRegistry = new GitRepositoryWatchRegistry(rootContext);
        this.#ctx.lifetime?.addEventListener("abort", () => this.dispose(), { once: true });
    }

    get trackedKeys(): readonly string[] {
        return [...this.#trackers.values()]
            .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
            .map((tracker) => tracker.key);
    }

    /** Every repository that has already been scanned, with what the last scan found. */
    tracked(): readonly { entity: GitTrackedEntity; snapshot: GitChangeSnapshot }[] {
        return [...this.#trackers.values()]
            .filter(
                (tracker): tracker is RepositoryTracker & { snapshot: GitChangeSnapshot } =>
                    tracker.snapshot !== undefined,
            )
            .map((tracker) => ({ entity: tracker.entity, snapshot: tracker.snapshot }));
    }

    watch(entity: GitTrackedEntity): void {
        if (this.#disposed) return;
        const key = entityKey(entity);
        const existing = this.#trackers.get(key);
        if (existing !== undefined) {
            if (!sameEntity(existing.entity, entity)) {
                this.#retire(existing);
                this.#watch(entity);
                return;
            }
            const now = Date.now();
            existing.entity = entity;
            existing.expiresAt = now + WATCH_TTL_MS;
            existing.lastActiveAt = now;
            this.#scheduleMaintenance();
            return;
        }
        this.#watch(entity);
    }

    /**
     * Makes the tracked set exactly match one caller-owned subscription set.
     *
     * This stays synchronous deliberately: retired trackers have their generation advanced and
     * their scans aborted before new watchers are armed, so a completed asynchronous scan cannot
     * publish an entity the replacement omitted.
     */
    replace(entities: readonly GitTrackedEntity[]): void {
        if (this.#disposed) return;
        const desired = new Map<string, GitTrackedEntity>();
        for (const entity of entities) desired.set(entityKey(entity), entity);

        for (const tracker of Array.from(this.#trackers.values())) {
            const entity = desired.get(tracker.key);
            if (entity === undefined || !sameEntity(tracker.entity, entity)) {
                this.#retire(tracker);
            }
        }

        const now = Date.now();
        for (const [key, entity] of desired) {
            const existing = this.#trackers.get(key);
            if (existing === undefined) {
                this.#watch(entity);
                continue;
            }
            existing.entity = entity;
            existing.expiresAt = now + WATCH_TTL_MS;
            existing.lastActiveAt = now;
        }
        this.#scheduleMaintenance();
    }

    #watch(entity: GitTrackedEntity): void {
        const key = entityKey(entity);
        const tracker: RepositoryTracker = {
            backoffMs: BACKOFF_START_MS,
            backoffTimer: undefined,
            backoffUntil: 0,
            classificationInFlight: false,
            debounceTimer: undefined,
            dirtyAgain: false,
            entity,
            expiresAt: Date.now() + WATCH_TTL_MS,
            firstDirtyAt: undefined,
            generation: 0,
            inFlight: undefined,
            key,
            lastActiveAt: Date.now(),
            pendingWorktreePaths: new Set(),
            reconcileAt: undefined,
            scanController: undefined,
            scanning: false,
            snapshot: undefined,
            snapshotDelivered: false,
            unclassifiedDirty: false,
            unwatch: undefined,
        };
        this.#trackers.set(key, tracker);
        this.#evictExpired();
        if (!this.#trackers.has(key)) return;
        this.#scheduleMaintenance();
        this.#arm(tracker);
    }

    unwatch(entity: GitTrackedEntity): void {
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker !== undefined) this.#retire(tracker);
    }

    markChanged(entity: GitTrackedEntity): void {
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker === undefined || this.#disposed) return;
        tracker.lastActiveAt = Date.now();
        if (tracker.scanning) {
            tracker.dirtyAgain = true;
            return;
        }
        tracker.unclassifiedDirty = true;
        this.#scheduleDirty(tracker);
    }

    /** Records one path supplied by the recursive working-tree watcher for cheap classification. */
    markWorktreeChanged(entity: GitTrackedEntity, path: string): void {
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker === undefined || this.#disposed) return;
        tracker.lastActiveAt = Date.now();
        const normalized = normalizeWorktreeEventPath(path);
        if (normalized === undefined) {
            this.markChanged(entity);
            return;
        }
        if (!tracker.unclassifiedDirty) {
            if (
                tracker.pendingWorktreePaths.size >= WORKTREE_PATH_LIMIT &&
                !tracker.pendingWorktreePaths.has(normalized)
            ) {
                tracker.pendingWorktreePaths.clear();
                tracker.unclassifiedDirty = true;
            } else {
                tracker.pendingWorktreePaths.add(normalized);
            }
        }
        this.#scheduleDirty(tracker);
    }

    #scheduleDirty(tracker: RepositoryTracker): void {
        tracker.firstDirtyAt ??= Date.now();
        if (tracker.scanning || tracker.classificationInFlight) return;
        const waited = Date.now() - tracker.firstDirtyAt;
        const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAXIMUM_DEBOUNCE_MS - waited));
        if (tracker.debounceTimer !== undefined) clearTimeout(tracker.debounceTimer);
        tracker.debounceTimer = setTimeout(() => {
            tracker.debounceTimer = undefined;
            void this.#flushDirty(tracker);
        }, delay);
        tracker.debounceTimer.unref?.();
    }

    async #flushDirty(tracker: RepositoryTracker): Promise<void> {
        if (
            this.#disposed ||
            this.#trackers.get(tracker.key) !== tracker ||
            tracker.scanning ||
            tracker.classificationInFlight
        ) {
            return;
        }
        tracker.firstDirtyAt = undefined;
        const unclassified = tracker.unclassifiedDirty;
        tracker.unclassifiedDirty = false;
        const paths = Array.from(tracker.pendingWorktreePaths);
        tracker.pendingWorktreePaths.clear();
        if (unclassified) {
            this.#enqueue(tracker.key);
            return;
        }
        if (paths.length === 0) return;

        const generation = tracker.generation;
        tracker.classificationInFlight = true;
        let relevant = true;
        try {
            relevant = await this.#hasRelevantWorktreeChanges(tracker.entity.path, paths);
        } catch {
            // Classification is only an optimization. A failure must conservatively rescan.
        } finally {
            tracker.classificationInFlight = false;
        }
        if (
            this.#disposed ||
            tracker.generation !== generation ||
            this.#trackers.get(tracker.key) !== tracker
        ) {
            return;
        }
        if (relevant) {
            // Everything accumulated while classification ran predates the full scan we are about
            // to start, so that scan covers it too. Later events see `scanning` and remain pending.
            tracker.unclassifiedDirty = false;
            tracker.pendingWorktreePaths.clear();
            tracker.firstDirtyAt = undefined;
            this.#enqueue(tracker.key);
        } else if (hasPendingDirty(tracker)) {
            this.#scheduleDirty(tracker);
        }
    }

    async #hasRelevantWorktreeChanges(path: string, paths: readonly string[]): Promise<boolean> {
        for (let offset = 0; offset < paths.length; offset += WORKTREE_PATH_BATCH) {
            const result = await this.#scan({
                args: [
                    "status",
                    "--porcelain=v2",
                    "-z",
                    "--untracked-files=all",
                    "--",
                    ...paths.slice(offset, offset + WORKTREE_PATH_BATCH),
                ],
                cwd: path,
                maximumBytes: PATH_STATUS_OUTPUT_LIMIT,
            });
            if (result.truncated || result.stdout.length > 0) return true;
        }
        return false;
    }

    snapshot(entity: GitTrackedEntity): GitChangeSnapshot | undefined {
        return this.#trackers.get(entityKey(entity))?.snapshot;
    }

    async refresh(ctx: Context, entity: GitTrackedEntity): Promise<GitChangeSnapshot | undefined> {
        if (this.#disposed) return undefined;
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker === undefined) return this.#owner.stamp(await this.#runScan(entity));
        tracker.lastActiveAt = Date.now();
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await tracker.inFlight?.catch(() => undefined);
            if (this.#disposed || this.#trackers.get(tracker.key) !== tracker) break;
            if (!tracker.scanning) {
                await this.#scanTracker(ctx, tracker);
                break;
            }
        }
        return tracker.snapshot;
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        if (this.#maintenanceTimer !== undefined) clearTimeout(this.#maintenanceTimer);
        this.#maintenanceTimer = undefined;
        this.#pendingScans.length = 0;
        for (const tracker of Array.from(this.#trackers.values())) this.#retire(tracker);
        this.#watchRegistry.dispose();
    }

    #arm(tracker: RepositoryTracker): void {
        const generation = tracker.generation;
        void this.#resolveGitDirectories(tracker.entity.path)
            .then((directories) => {
                if (this.#disposed || tracker.generation !== generation) {
                    return;
                }
                if (directories === undefined) {
                    this.markChanged(tracker.entity);
                    return;
                }
                tracker.unwatch = this.#watchRegistry.watch({
                    commonDirectory: directories.commonDirectory,
                    gitDirectory: directories.gitDirectory,
                    onDirty: (change) => this.#watchChanged(tracker, change),
                    path: tracker.entity.path,
                });
            })
            .catch(() => {
                if (!this.#disposed && tracker.generation === generation) {
                    this.markChanged(tracker.entity);
                }
            });
    }

    #watchChanged(tracker: RepositoryTracker, change: GitRepositoryChange): void {
        if (change.kind === "worktree" && change.path !== undefined) {
            this.markWorktreeChanged(tracker.entity, change.path);
            return;
        }
        if (
            change.kind === "refs" &&
            !gitReferenceChangeAffectsSnapshot(tracker.snapshot, change.entry)
        ) {
            return;
        }
        this.markChanged(tracker.entity);
    }

    async #resolveGitDirectories(
        path: string,
    ): Promise<{ commonDirectory: string; gitDirectory: string } | undefined> {
        try {
            const result = await this.#scan({
                args: ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
                cwd: path,
            });
            const [gitDirectory, commonDirectory] = result.stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            return gitDirectory === undefined
                ? undefined
                : { commonDirectory: commonDirectory ?? gitDirectory, gitDirectory };
        } catch {
            return undefined;
        }
    }

    #retire(tracker: RepositoryTracker): void {
        tracker.generation += 1;
        if (tracker.backoffTimer !== undefined) clearTimeout(tracker.backoffTimer);
        if (tracker.debounceTimer !== undefined) clearTimeout(tracker.debounceTimer);
        tracker.scanController?.abort();
        tracker.unwatch?.();
        this.#trackers.delete(tracker.key);
        for (let index = this.#pendingScans.length - 1; index >= 0; index -= 1) {
            if (this.#pendingScans[index] === tracker.key) this.#pendingScans.splice(index, 1);
        }
        this.#scheduleMaintenance();
    }

    #evictExpired(): void {
        const now = Date.now();
        for (const tracker of Array.from(this.#trackers.values())) {
            if (tracker.expiresAt <= now) this.#retire(tracker);
        }
        while (this.#trackers.size > TRACKED_LIMIT) {
            const oldest = [...this.#trackers.values()].reduce((left, right) =>
                left.lastActiveAt <= right.lastActiveAt ? left : right,
            );
            this.#retire(oldest);
        }
    }

    #scheduleMaintenance(): void {
        if (this.#disposed) return;
        if (this.#maintenanceTimer !== undefined) clearTimeout(this.#maintenanceTimer);
        this.#maintenanceTimer = undefined;
        let next = Number.POSITIVE_INFINITY;
        for (const tracker of this.#trackers.values()) {
            next = Math.min(next, tracker.expiresAt);
            if (tracker.reconcileAt !== undefined) next = Math.min(next, tracker.reconcileAt);
        }
        if (!Number.isFinite(next)) return;
        const delay = Math.min(2_147_483_647, Math.max(1, next - Date.now()));
        this.#maintenanceTimer = setTimeout(() => {
            this.#maintenanceTimer = undefined;
            this.#maintain();
        }, delay);
        this.#maintenanceTimer.unref?.();
    }

    #maintain(): void {
        if (this.#disposed) return;
        this.#evictExpired();
        const now = Date.now();
        for (const tracker of Array.from(this.#trackers.values())) {
            if (tracker.reconcileAt === undefined || tracker.reconcileAt > now) continue;
            tracker.reconcileAt = undefined;
            this.#enqueue(tracker.key);
        }
        this.#scheduleMaintenance();
    }

    #enqueue(key: string): void {
        if (this.#disposed) return;
        const tracker = this.#trackers.get(key);
        if (tracker === undefined) return;
        tracker.reconcileAt = undefined;
        this.#scheduleMaintenance();
        if (tracker.backoffTimer !== undefined && Date.now() < tracker.backoffUntil) return;
        if (tracker.scanning) {
            tracker.dirtyAgain = true;
            return;
        }
        if (!this.#pendingScans.includes(key)) this.#pendingScans.push(key);
        this.#drain();
    }

    #drain(): void {
        if (this.#disposed) return;
        while (this.#activeScans < SCAN_CONCURRENCY) {
            const key = this.#pendingScans.shift();
            if (key === undefined) return;
            const tracker = this.#trackers.get(key);
            if (tracker === undefined) continue;
            this.#activeScans += 1;
            void this.#scanTracker(this.#ctx, tracker)
                .catch((error: unknown) => this.#owner.report(this.#ctx, error, tracker.entity))
                .finally(() => {
                    this.#activeScans -= 1;
                    this.#drain();
                });
        }
    }

    async #scanTracker(ctx: Context, tracker: RepositoryTracker): Promise<void> {
        if (this.#disposed || tracker.scanning) return;
        const scan = this.#runScanTracker(ctx, tracker);
        tracker.inFlight = scan;
        try {
            await scan;
        } finally {
            if (tracker.inFlight === scan) tracker.inFlight = undefined;
        }
    }

    async #runScanTracker(ctx: Context, tracker: RepositoryTracker): Promise<void> {
        const generation = tracker.generation;
        const controller = new AbortController();
        tracker.scanning = true;
        tracker.scanController = controller;
        tracker.reconcileAt = undefined;
        this.#scheduleMaintenance();
        try {
            const state = await this.#runScan(tracker.entity, controller.signal);
            if (this.#disposed || tracker.generation !== generation) return;
            const unchanged = tracker.snapshot !== undefined && sameState(tracker.snapshot, state);
            if (!unchanged || !tracker.snapshotDelivered) {
                const snapshot =
                    unchanged && tracker.snapshot !== undefined
                        ? tracker.snapshot
                        : this.#owner.stamp(state);
                tracker.snapshot = snapshot;
                await this.#owner.deliver(ctx, tracker.entity, snapshot);
                tracker.snapshotDelivered = true;
            }
            tracker.backoffMs = BACKOFF_START_MS;
            tracker.backoffUntil = 0;
            if (tracker.backoffTimer !== undefined) clearTimeout(tracker.backoffTimer);
            tracker.backoffTimer = undefined;
            tracker.reconcileAt = Date.now() + GIT_RECONCILE_STALE_AFTER_MS;
        } catch (error) {
            if (this.#disposed || tracker.generation !== generation) return;
            const delay = tracker.backoffMs;
            tracker.backoffMs = Math.min(BACKOFF_LIMIT_MS, tracker.backoffMs * 2);
            tracker.backoffUntil = Date.now() + delay;
            if (tracker.backoffTimer !== undefined) clearTimeout(tracker.backoffTimer);
            tracker.backoffTimer = setTimeout(() => {
                tracker.backoffTimer = undefined;
                this.#enqueue(tracker.key);
            }, delay);
            tracker.backoffTimer.unref?.();
            this.#owner.report(ctx, error, tracker.entity);
        } finally {
            tracker.scanning = false;
            tracker.scanController = undefined;
            if (tracker.dirtyAgain && tracker.generation === generation && !this.#disposed) {
                tracker.dirtyAgain = false;
                this.#enqueue(tracker.key);
            } else if (
                tracker.generation === generation &&
                !this.#disposed &&
                hasPendingDirty(tracker)
            ) {
                this.#scheduleDirty(tracker);
            }
            this.#scheduleMaintenance();
        }
    }

    async #runScan(entity: GitTrackedEntity, signal?: AbortSignal): Promise<GitChangeState> {
        return await scanGitRepository({
            path: entity.path,
            runGit: this.#scan,
            ...(signal === undefined ? {} : { signal }),
        });
    }
}

export function entityKey(entity: GitTrackedEntity): string {
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

function sameEntity(left: GitTrackedEntity, right: GitTrackedEntity): boolean {
    return (
        left.path === right.path &&
        left.projectId === right.projectId &&
        left.workspaceId === right.workspaceId
    );
}

export function gitReferenceChangeAffectsSnapshot(
    snapshot: GitChangeSnapshot | undefined,
    entry: string | undefined,
): boolean {
    if (entry === undefined || snapshot === undefined) return true;
    const normalized = entry.replaceAll("\\", "/").replace(/\.lock$/, "");
    if (normalized.startsWith("heads/")) {
        const branch = snapshot.facts.branch;
        return branch === undefined || referenceEventMatches(`heads/${branch}`, normalized);
    }
    if (normalized.startsWith("remotes/")) {
        const originMain = "remotes/origin/main";
        const upstream =
            snapshot.facts.upstream === undefined
                ? undefined
                : `remotes/${snapshot.facts.upstream}`;
        return (
            referenceEventMatches(originMain, normalized) ||
            (upstream !== undefined && referenceEventMatches(upstream, normalized))
        );
    }
    if (normalized === "tags" || normalized.startsWith("tags/")) return false;
    return true;
}

function referenceEventMatches(expected: string, observed: string): boolean {
    return expected === observed || expected.startsWith(`${observed}/`);
}

function normalizeWorktreeEventPath(path: string): string | undefined {
    if (path.length === 0 || path.length > 16_384 || path.includes("\0")) return undefined;
    const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
    if (
        normalized.length === 0 ||
        normalized.startsWith("/") ||
        /^[A-Za-z]:\//.test(normalized) ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.includes("/../")
    ) {
        return undefined;
    }
    return normalized;
}

function hasPendingDirty(tracker: RepositoryTracker): boolean {
    return tracker.unclassifiedDirty || tracker.pendingWorktreePaths.size > 0;
}
