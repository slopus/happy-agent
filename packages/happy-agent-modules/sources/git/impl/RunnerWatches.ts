import type { PlatformPath } from "node:path";

import type { Compute, ComputeWatch, ComputeWatchBatch } from "@slopus/happy-agent-compute";
import type { Context, RootContext } from "@steve.kite/stdlib";

import type { ScanGitRunner } from "../runScanGit.js";
import type {
    GitRepositoryChange,
    GitRepositoryWatchOptions,
} from "../watchGitRepositoryChanges.js";
import type { WorkingTreeChange, WorkingTreeObserver } from "./WorkingTreeWatcher.js";

/**
 * Directory names a runner's working-tree watch never descends into, at any depth: dependency
 * trees, caches, virtual environments, and every repository's own metadata. A Linux runner spends
 * one kernel watch per directory, so these are skipped on the runner itself.
 */
export const RUNNER_UNWATCHED_DIRECTORIES = [
    ".cache",
    ".git",
    ".hg",
    ".next",
    ".svn",
    ".turbo",
    ".venv",
    "__pycache__",
    "node_modules",
    "venv",
] as const;

/**
 * What a repository's Git directory watch skips: object storage, logs, hooks, and nested
 * submodule repositories. Their names do not occur among the control files and refs a snapshot
 * depends on, so skipping them by name at any depth loses nothing.
 */
const GIT_DIRECTORY_UNWATCHED = ["objects", "logs", "hooks", "lfs", "modules", "rr-cache"] as const;

/** Control files in a Git directory whose change can move a snapshot. */
const CONTROL_ENTRIES = new Set([
    "CHERRY_PICK_HEAD",
    "HEAD",
    "MERGE_HEAD",
    "ORIG_HEAD",
    "REBASE_HEAD",
    "REVERT_HEAD",
    "index",
]);
/** Files in the common directory every worktree of the repository depends on. */
const COMMON_ENTRIES = new Set(["config", "packed-refs", "info/exclude"]);

/** How many working-tree watches one runner holds for this daemon; more folders poll instead. */
const MAX_TREE_WATCHES_PER_RUNNER = 32;
/** How many Git directory watches one runner holds for this daemon; more repositories poll. */
const MAX_GIT_WATCHES_PER_RUNNER = 16;
const RETRY_START_MS = 2_000;
const RETRY_LIMIT_MS = 60_000;
const IGNORED_DIRECTORY_LIMIT = 4_096;
const IGNORED_LISTING_BYTES = 1024 * 1024;
const IGNORE_RECHECK_DELAY_MS = 2_000;
const IGNORE_RECHECK_INTERVAL_MS = 10_000;
/** A batch at least this large is a burst — a build or an install — that may have made folders. */
const IGNORE_RECHECK_BURST = 32;
/** How many reported paths a watch remembers before it starts over. */
const SEEN_PATH_LIMIT = 4_096;

/** How the watches reach a runner. */
export interface RunnerWatchTarget {
    /** The folder's machine: a runner's product machine, or a workload user's. */
    machine(runnerId: string | undefined): Promise<Compute>;
    /** Unattended read-only Git on that machine. */
    scan(runnerId: string | undefined): ScanGitRunner;
    paths(runnerId: string | undefined): PlatformPath;
    /** The machine's home directory, which with its ancestors is never watched. */
    home(runnerId: string | undefined): string | undefined;
}

interface Subscriber {
    batch(paths: readonly string[] | null): void;
    watching(watching: boolean): void;
}

interface SharedWatch {
    readonly key: string;
    readonly kind: "tree" | "git";
    readonly runnerId: string | undefined;
    readonly path: string;
    readonly subscribers: Set<Subscriber>;
    closed: boolean;
    /** Whether a watch has been armed before, so a later arming reports a possible gap. */
    armedBefore: boolean;
    arming: boolean;
    watch: ComputeWatch | undefined;
    retryTimer: NodeJS.Timeout | undefined;
    retryDelayMs: number;
    /** Directories Git ignores below a working tree, whose changes are dropped. */
    ignored: readonly string[];
    ignoreTimer: NodeJS.Timeout | undefined;
    ignoreCheckedAt: number;
    /** Paths this watch has already reported, so only new ones prompt an ignore recheck. */
    readonly seen: Set<string>;
    readonly listing: AbortController;
}

/**
 * The daemon's watches of folders on runners, one per folder and one per repository's Git
 * directory, shared by everything that watches them.
 *
 * File change events, live Git tracking, and file search all ask for the same folder, and each
 * gets the one watch on the runner. A working-tree watch skips dependency and repository
 * directories on the runner and drops what Git ignores here; a Git directory watch serves every
 * worktree of the repository, fanning out control-file changes to the worktree they belong to and
 * ref changes to all of them. The runner coalesces events into batches, and turns a flood into one
 * overflow, which subscribers hear as "rescan everything".
 *
 * Each runner holds a bounded number of watches; folders beyond it, and folders whose runner is
 * away, are reported as unwatched so their subscribers poll. A watch that ends when its runner
 * leaves is armed again with backoff, and its subscribers then hear that changes may have been
 * missed.
 */
export class RunnerWatches {
    readonly #ctx: Context;
    readonly #target: RunnerWatchTarget;
    readonly #watches = new Map<string, SharedWatch>();
    #disposed = false;

    constructor(rootContext: RootContext, target: RunnerWatchTarget) {
        this.#ctx = rootContext.named("git-runner-watches");
        this.#target = target;
        this.#ctx.lifetime?.addEventListener("abort", () => this.dispose(), { once: true });
    }

    /** How many watches this daemon holds on runners right now, armed or waiting. */
    get size(): number {
        return this.#watches.size;
    }

    /** Watches a folder's working tree on its runner until the returned function is called. */
    watchTree(
        runnerId: string | undefined,
        root: string,
        observer: WorkingTreeObserver,
    ): () => void {
        return this.#subscribe("tree", runnerId, root, {
            batch: (paths) => {
                if (paths === null) {
                    observer.onChanges(null);
                    return;
                }
                const changes: WorkingTreeChange[] = paths.map((path) => ({
                    kind: "update",
                    path,
                }));
                if (changes.length > 0) observer.onChanges(changes);
            },
            watching: (watching) => observer.onWatching?.(watching),
        });
    }

    /**
     * Whether a working-tree watch reports changes below this relative path: false inside a
     * dependency, repository, or Git-ignored directory, which only a watch of its own covers.
     */
    covers(runnerId: string | undefined, root: string, relativePath: string): boolean {
        const segments = relativePath.split("/");
        if (
            segments.some((segment) =>
                (RUNNER_UNWATCHED_DIRECTORIES as readonly string[]).includes(segment),
            )
        )
            return false;
        const entry = this.#watches.get(watchKey("tree", runnerId, root));
        return entry === undefined || !isIgnored(entry.ignored, relativePath);
    }

    /**
     * Watches a repository's Git directory on its runner, shared by every worktree of it, and
     * tells one worktree about the changes that can move its snapshot.
     */
    watchGit(runnerId: string | undefined, options: GitRepositoryWatchOptions): () => void {
        const paths = this.#target.paths(runnerId);
        const own = paths
            .relative(options.commonDirectory, options.gitDirectory)
            .split(paths.sep)
            .join("/");
        // The worktree's own control files: at the top for the main checkout, or below
        // `worktrees/<name>` for a linked worktree.
        const prefix = own === "" ? "" : `${own}/`;
        const release = this.#subscribe("git", runnerId, options.commonDirectory, {
            batch: (changed) => {
                if (changed === null) {
                    options.onDirty({ kind: "git" });
                    return;
                }
                for (const path of changed) {
                    const change = classifyGitPath(path, prefix);
                    if (change !== undefined) options.onDirty(change);
                }
            },
            watching: (watching) => {
                if (!watching) options.onDegraded?.("The runner is not watching this repository.");
            },
        });
        options.onDirty({ kind: "armed" });
        return release;
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const entry of Array.from(this.#watches.values())) this.#close(entry);
    }

    #subscribe(
        kind: SharedWatch["kind"],
        runnerId: string | undefined,
        path: string,
        subscriber: Subscriber,
    ): () => void {
        if (this.#disposed) return () => undefined;
        const key = watchKey(kind, runnerId, path);
        let entry = this.#watches.get(key);
        if (entry === undefined) {
            entry = {
                key,
                kind,
                runnerId,
                path,
                subscribers: new Set(),
                closed: false,
                armedBefore: false,
                arming: false,
                watch: undefined,
                retryTimer: undefined,
                retryDelayMs: RETRY_START_MS,
                ignored: [],
                ignoreTimer: undefined,
                ignoreCheckedAt: 0,
                seen: new Set(),
                listing: new AbortController(),
            };
            this.#watches.set(key, entry);
            void this.#arm(entry);
        }
        entry.subscribers.add(subscriber);
        if (entry.watch !== undefined) subscriber.watching(true);
        const shared = entry;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            shared.subscribers.delete(subscriber);
            if (shared.subscribers.size === 0) this.#close(shared);
        };
    }

    async #arm(entry: SharedWatch): Promise<void> {
        if (entry.closed || entry.arming || entry.watch !== undefined) return;
        if (this.#containsHome(entry)) {
            // Stays unwatched for good, so its subscribers poll.
            this.#ctx.log.debug("A runner folder containing its home directory is never watched.", {
                path: entry.path,
            });
            return;
        }
        if (!this.#hasSlot(entry)) return;
        entry.arming = true;
        let watch: ComputeWatch;
        try {
            const machine = await this.#target.machine(entry.runnerId);
            if (machine.watcher === undefined) {
                entry.arming = false;
                return;
            }
            if (entry.kind === "tree") {
                entry.ignored = await this.#ignoredDirectories(entry);
                entry.ignoreCheckedAt = Date.now();
            }
            if (entry.closed) {
                entry.arming = false;
                return;
            }
            watch = await machine.watcher.watch(this.#ctx, {
                path: entry.path,
                ignore:
                    entry.kind === "tree" ? RUNNER_UNWATCHED_DIRECTORIES : GIT_DIRECTORY_UNWATCHED,
            });
        } catch (error) {
            entry.arming = false;
            this.#ctx.log.debug(
                "A runner folder could not be watched; it is polled.",
                { path: entry.path },
                error,
            );
            this.#retry(entry);
            return;
        }
        entry.arming = false;
        if (entry.closed) {
            watch.close();
            this.#armWaiting(entry.runnerId);
            return;
        }
        entry.watch = watch;
        entry.retryDelayMs = RETRY_START_MS;
        const gap = entry.armedBefore;
        entry.armedBefore = true;
        watch.onChange((batch) => this.#deliver(entry, batch));
        void watch.closed.then(({ reason }) => this.#lost(entry, watch, reason));
        for (const subscriber of Array.from(entry.subscribers)) {
            subscriber.watching(true);
            // Whatever changed while the runner was away produced no event.
            if (gap) subscriber.batch(null);
        }
    }

    #deliver(entry: SharedWatch, batch: ComputeWatchBatch): void {
        if (entry.closed) return;
        if (batch.overflow) {
            for (const subscriber of Array.from(entry.subscribers)) subscriber.batch(null);
            if (entry.kind === "tree") this.#scheduleIgnoreCheck(entry);
            return;
        }
        let paths = batch.paths;
        if (entry.kind === "tree") {
            paths = paths.filter((path) => !isIgnored(entry.ignored, path));
            if (this.#appeared(entry, batch.paths)) this.#scheduleIgnoreCheck(entry);
        }
        if (paths.length === 0) return;
        for (const subscriber of Array.from(entry.subscribers)) subscriber.batch(paths);
    }

    #lost(entry: SharedWatch, watch: ComputeWatch, reason: string | undefined): void {
        if (entry.watch !== watch) return;
        entry.watch = undefined;
        this.#armWaiting(entry.runnerId);
        if (entry.closed) return;
        this.#ctx.log.debug(
            "A runner folder's watch ended; it is polled until it is armed again.",
            {
                path: entry.path,
                ...(reason === undefined ? {} : { reason }),
            },
        );
        for (const subscriber of Array.from(entry.subscribers)) subscriber.watching(false);
        this.#retry(entry);
    }

    #retry(entry: SharedWatch): void {
        if (entry.closed || entry.retryTimer !== undefined) return;
        const delay = entry.retryDelayMs;
        entry.retryDelayMs = Math.min(RETRY_LIMIT_MS, entry.retryDelayMs * 2);
        entry.retryTimer = setTimeout(() => {
            entry.retryTimer = undefined;
            void this.#arm(entry);
        }, delay);
        entry.retryTimer.unref?.();
    }

    /** Whether the runner has room for another watch of this kind; otherwise the folder waits. */
    #hasSlot(entry: SharedWatch): boolean {
        const limit =
            entry.kind === "tree" ? MAX_TREE_WATCHES_PER_RUNNER : MAX_GIT_WATCHES_PER_RUNNER;
        let held = 0;
        for (const other of this.#watches.values()) {
            if (other === entry || other.kind !== entry.kind || other.runnerId !== entry.runnerId)
                continue;
            if (other.watch !== undefined || other.arming) held += 1;
        }
        return held < limit;
    }

    /** Arms the oldest folders that waited for a slot on a runner. */
    #armWaiting(runnerId: string | undefined): void {
        for (const entry of this.#watches.values()) {
            if (entry.runnerId !== runnerId || entry.closed || entry.watch !== undefined) continue;
            if (entry.arming || entry.retryTimer !== undefined) continue;
            void this.#arm(entry);
        }
    }

    #containsHome(entry: SharedWatch): boolean {
        if (entry.kind !== "tree") return false;
        const home = this.#target.home(entry.runnerId);
        if (home === undefined) return false;
        const paths = this.#target.paths(entry.runnerId);
        const relative = paths.relative(entry.path, home);
        return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
    }

    /**
     * Whether a batch names a path this watch has not reported before, or touches ignore rules.
     *
     * A new path may be a directory of build output Git ignores, whose events must stop being
     * reported. The runner says only which paths changed, not what they are, so any new path
     * prompts the rate-limited recheck; saving the same files again does not.
     */
    #appeared(entry: SharedWatch, paths: readonly string[]): boolean {
        let appeared = paths.length >= IGNORE_RECHECK_BURST;
        for (const path of paths) {
            if (path === ".gitignore" || path.endsWith("/.gitignore")) appeared = true;
            if (entry.seen.has(path)) continue;
            appeared = true;
            if (entry.seen.size >= SEEN_PATH_LIMIT) entry.seen.clear();
            entry.seen.add(path);
        }
        return appeared;
    }

    #scheduleIgnoreCheck(entry: SharedWatch): void {
        if (entry.closed || entry.ignoreTimer !== undefined) return;
        const delay = Math.max(
            IGNORE_RECHECK_DELAY_MS,
            entry.ignoreCheckedAt + IGNORE_RECHECK_INTERVAL_MS - Date.now(),
        );
        entry.ignoreTimer = setTimeout(() => {
            entry.ignoreTimer = undefined;
            void this.#ignoredDirectories(entry).then((ignored) => {
                if (entry.closed) return;
                entry.ignored = ignored;
                entry.ignoreCheckedAt = Date.now();
            });
        }, delay);
        entry.ignoreTimer.unref?.();
    }

    /**
     * Every directory Git ignores below a working tree, as the runner's own Git decides.
     * `--directory` reports an ignored directory once instead of descending into it; a folder
     * that is not a repository ignores nothing beyond the fixed list.
     */
    async #ignoredDirectories(entry: SharedWatch): Promise<readonly string[]> {
        if (entry.closed) return [];
        try {
            const result = await this.#target.scan(entry.runnerId)({
                args: [
                    "ls-files",
                    "-z",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                    "--directory",
                ],
                cwd: entry.path,
                maximumBytes: IGNORED_LISTING_BYTES,
                signal: entry.listing.signal,
            });
            return result.stdout
                .split("\0")
                .filter((path) => path.endsWith("/"))
                .map((path) => path.slice(0, -1))
                .filter((path) => path.length > 0 && !path.split("/").includes(".."))
                .sort()
                .slice(0, IGNORED_DIRECTORY_LIMIT);
        } catch {
            return entry.ignored;
        }
    }

    #close(entry: SharedWatch): void {
        if (entry.closed) return;
        entry.closed = true;
        entry.listing.abort();
        if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
        if (entry.ignoreTimer !== undefined) clearTimeout(entry.ignoreTimer);
        const watch = entry.watch;
        entry.watch = undefined;
        entry.subscribers.clear();
        if (this.#watches.get(entry.key) === entry) this.#watches.delete(entry.key);
        watch?.close();
        if (watch !== undefined) this.#armWaiting(entry.runnerId);
    }
}

/** What one changed path in a Git directory means for the worktree whose own files are at `prefix`. */
export function classifyGitPath(path: string, prefix: string): GitRepositoryChange | undefined {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith("refs/")) {
        return { kind: "refs", entry: normalized.slice("refs/".length) };
    }
    if (normalized === "refs") return { kind: "refs" };
    if (COMMON_ENTRIES.has(normalized)) return { kind: "git", entry: normalized };
    if (prefix !== "" && !normalized.startsWith(prefix)) return undefined;
    const entry = normalized.slice(prefix.length);
    return CONTROL_ENTRIES.has(entry) ? { kind: "git", entry } : undefined;
}

function watchKey(kind: SharedWatch["kind"], runnerId: string | undefined, path: string): string {
    return `${kind}\0${runnerId ?? ""}\0${path}`;
}

function isIgnored(ignored: readonly string[], path: string): boolean {
    return ignored.some((directory) => path === directory || path.startsWith(`${directory}/`));
}
