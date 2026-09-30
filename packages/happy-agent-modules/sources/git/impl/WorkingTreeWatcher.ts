import { watch as watchDirectory } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AsyncSubscription, Event } from "@parcel/watcher";
import type { Context, RootContext } from "@steve.kite/stdlib";

import type { ScanGitRunner } from "../runScanGit.js";

/** Directories no working tree needs watched, whether or not Git ignores them. */
const ALWAYS_IGNORED = [".git", "**/node_modules"];
const IGNORED_DIRECTORY_LIMIT = 4_096;
const IGNORED_LISTING_BYTES = 1024 * 1024;
const CREATED_PATH_PROBES = 32;
const IGNORE_RECHECK_DELAY_MS = 2_000;
const IGNORE_RECHECK_INTERVAL_MS = 10_000;
const RETRY_START_MS = 60_000;
const USE_BUILTIN_WATCHER = process.platform === "win32" || process.platform === "darwin";
/**
 * Whether ignored directories are listed so the native watch can skip them. Only per-directory
 * watches (inotify) pay for ignored trees; Windows watches recursively in the kernel, and there a
 * Git process running in the folder — slow to start through the sandbox — also keeps a folder
 * that is being deleted locked.
 */
const LISTS_IGNORED = process.platform !== "win32";
const RETRY_LIMIT_MS = 30 * 60 * 1000;

export type WorkingTreeChangeKind = "create" | "delete" | "update";

/** One changed path, relative to the watched root with `/` separators. */
export interface WorkingTreeChange {
    readonly kind: WorkingTreeChangeKind;
    readonly path: string;
}

export interface WorkingTreeObserver {
    /** Changed paths, or `null` when changes may have been missed and everything is suspect. */
    readonly onChanges: (changes: readonly WorkingTreeChange[] | null) => void;
    /** Whether events are currently arriving for this root; polling must cover the gaps. */
    readonly onWatching?: (watching: boolean) => void;
}

interface WatchedRoot {
    readonly observers: Set<WorkingTreeObserver>;
    closed: boolean;
    /** Every directory Git currently ignores, whose events are dropped whether watched or not. */
    ignored: readonly string[];
    ignoreCheckedAt: number;
    ignoreTimer: NodeJS.Timeout | undefined;
    /** Aborts the Git listing in flight, so closing never leaves a process in the folder. */
    readonly listing: AbortController;
    retryDelayMs: number;
    retryTimer: NodeJS.Timeout | undefined;
    readonly root: string;
    /** Advanced on every subscription attempt so a superseded attempt abandons itself. */
    subscriptionGeneration: number;
    subscription: LiveSubscription | undefined;
    watching: boolean;
}

interface LiveSubscription {
    readonly native: AsyncSubscription;
    /** Cleared when this subscription fails or closes, which silences its callback. */
    live: boolean;
}

type ParcelWatcher = typeof import("@parcel/watcher");

/**
 * Every native subscribe and unsubscribe in the process, in order.
 *
 * `@parcel/watcher` shares one backend per process and tears it down when its last subscription
 * closes. A subscription opened while that teardown is still running attaches to the dying backend
 * and never receives an event, so a close must finish before the next open starts — across every
 * watcher instance, since the backend is process-wide.
 */
let nativeOperations: Promise<unknown> = Promise.resolve();

function serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = nativeOperations.then(operation, operation);
    nativeOperations = result.catch(() => undefined);
    return result;
}

function closeNative(subscription: AsyncSubscription): Promise<void> {
    return serialized(async () => await subscription.unsubscribe()).catch(() => undefined);
}

/**
 * One native recursive watch per working tree, shared by every observer of that folder.
 *
 * `@parcel/watcher` uses Watchman when it is installed and otherwise the platform's own recursive
 * watcher: FSEvents, ReadDirectoryChangesW, or inotify. inotify has no recursive mode, so on Linux
 * each directory costs one kernel watch from a per-user budget. Git-ignored directories are
 * therefore excluded from the watch itself rather than filtered afterwards, which keeps a
 * checkout at hundreds of watches instead of the tens of thousands `node_modules` alone can hold.
 * The ignore list is re-derived when `.gitignore` changes or new directories appear, and events
 * from newly ignored directories are dropped from then on.
 *
 * macOS and Windows use the runtime's own recursive `fs.watch`. Parcel's failed-subscription
 * cleanup releases JavaScript references from its worker thread, which can corrupt the runtime
 * when a workspace disappears. These platforms already have kernel-recursive watching, so they
 * do not need that addon. Ignored directories are filtered from the events.
 *
 * A folder keeps one native subscription for its whole life. It is never replaced by a narrower
 * one: a second subscription on a folder that is already watched shares the backend's cached
 * directory tree and was observed to receive no events at all, so build output created after the
 * watch started keeps its kernel watches until the folder is next watched afresh.
 *
 * A root that cannot be watched — an exhausted inotify budget, a filesystem without events, a
 * folder that does not exist yet — reports `watching: false`, and its observers keep polling.
 */
export class WorkingTreeWatcher {
    readonly #ctx: Context;
    readonly #roots = new Map<string, WatchedRoot>();
    readonly #scan: ScanGitRunner;
    #disposed = false;
    #parcel: Promise<ParcelWatcher> | undefined;

    constructor(rootContext: RootContext, scan: ScanGitRunner) {
        this.#ctx = rootContext.named("git-working-tree-watcher");
        this.#scan = scan;
        this.#ctx.lifetime?.addEventListener("abort", () => this.dispose(), { once: true });
    }

    /** Whether events are currently arriving for `root`. */
    isWatching(root: string): boolean {
        return this.#roots.get(resolve(root))?.watching === true;
    }

    watch(root: string, observer: WorkingTreeObserver): () => void {
        if (this.#disposed) return () => undefined;
        const path = resolve(root);
        let entry = this.#roots.get(path);
        if (entry === undefined) {
            entry = {
                closed: false,
                ignoreCheckedAt: 0,
                ignoreTimer: undefined,
                ignored: [],
                listing: new AbortController(),
                observers: new Set(),
                retryDelayMs: RETRY_START_MS,
                retryTimer: undefined,
                root: path,
                subscription: undefined,
                subscriptionGeneration: 0,
                watching: false,
            };
            this.#roots.set(path, entry);
            void this.#subscribe(entry);
        }
        entry.observers.add(observer);
        if (entry.watching) observer.onWatching?.(true);
        const watched = entry;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            watched.observers.delete(observer);
            if (watched.observers.size === 0) this.#close(watched);
        };
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const entry of Array.from(this.#roots.values())) this.#close(entry);
    }

    async #subscribe(entry: WatchedRoot): Promise<void> {
        const generation = ++entry.subscriptionGeneration;
        const ignored = await this.#ignoredDirectories(entry);
        if (entry.closed || generation !== entry.subscriptionGeneration) return;
        entry.ignored = ignored;
        entry.ignoreCheckedAt = Date.now();
        const handle = { live: true };
        let native: AsyncSubscription;
        try {
            if (USE_BUILTIN_WATCHER) {
                native = this.#watchBuiltin(entry, handle);
            } else {
                const parcel = await this.#loadParcel();
                native = await serialized(
                    async () =>
                        await parcel.subscribe(
                            entry.root,
                            (error, events) => {
                                if (entry.closed || !handle.live) return;
                                if (error !== null) {
                                    this.#failed(entry, error, true);
                                    return;
                                }
                                this.#deliver(entry, events);
                            },
                            {
                                ignore: [
                                    ...ALWAYS_IGNORED,
                                    ...ignored.map((path) => join(entry.root, path)),
                                ],
                            },
                        ),
                );
            }
        } catch (error) {
            if (entry.closed || generation !== entry.subscriptionGeneration) return;
            this.#failed(entry, error, false);
            return;
        }
        if (entry.closed || generation !== entry.subscriptionGeneration) {
            handle.live = false;
            await closeNative(native);
            return;
        }
        entry.subscription = Object.assign(handle, { native });
        entry.retryDelayMs = RETRY_START_MS;
        if (!entry.watching) {
            entry.watching = true;
            for (const observer of Array.from(entry.observers)) observer.onWatching?.(true);
        }
    }

    /** A kernel-recursive watch whose close releases the directory immediately. */
    #watchBuiltin(entry: WatchedRoot, handle: { live: boolean }): AsyncSubscription {
        const watcher = watchDirectory(entry.root, { recursive: true }, (event, filename) => {
            if (entry.closed || !handle.live) return;
            if (typeof filename !== "string") {
                for (const observer of Array.from(entry.observers)) observer.onChanges(null);
                return;
            }
            // `rename` covers both appearance and disappearance; either is structural.
            this.#deliver(entry, [
                {
                    path: join(entry.root, filename),
                    type: event === "rename" ? "create" : "update",
                },
            ]);
        });
        watcher.on("error", (error) => {
            if (!entry.closed && handle.live) this.#failed(entry, error, true);
        });
        watcher.unref();
        return {
            unsubscribe: async () => {
                watcher.close();
            },
        };
    }

    #deliver(entry: WatchedRoot, events: readonly Event[]): void {
        const changes: WorkingTreeChange[] = [];
        const created: string[] = [];
        let ignoreRulesChanged = false;
        for (const event of events) {
            const path = relativePath(entry.root, event.path);
            if (
                path === undefined ||
                isUnder(path, ".git") ||
                path.split("/").includes("node_modules") ||
                isIgnored(entry.ignored, path)
            ) {
                continue;
            }
            changes.push({ kind: event.type, path });
            if (basename(path) === ".gitignore") ignoreRulesChanged = true;
            else if (event.type === "create") created.push(event.path);
        }
        if (changes.length === 0) return;
        for (const observer of Array.from(entry.observers)) observer.onChanges(changes);
        if (ignoreRulesChanged) this.#scheduleIgnoreCheck(entry);
        else if (created.length > 0) void this.#checkCreated(entry, created);
    }

    /** A new directory may be build output Git ignores, whose events must stop being reported. */
    async #checkCreated(entry: WatchedRoot, paths: readonly string[]): Promise<void> {
        if (entry.ignoreTimer !== undefined) return;
        for (const path of paths.slice(0, CREATED_PATH_PROBES)) {
            try {
                if ((await lstat(path)).isDirectory()) {
                    this.#scheduleIgnoreCheck(entry);
                    return;
                }
            } catch {
                // Already gone; nothing is watching it any more either.
            }
        }
    }

    #scheduleIgnoreCheck(entry: WatchedRoot): void {
        if (entry.closed || entry.ignoreTimer !== undefined || !LISTS_IGNORED) return;
        const delay = Math.max(
            IGNORE_RECHECK_DELAY_MS,
            entry.ignoreCheckedAt + IGNORE_RECHECK_INTERVAL_MS - Date.now(),
        );
        entry.ignoreTimer = setTimeout(() => {
            entry.ignoreTimer = undefined;
            void this.#recheckIgnores(entry);
        }, delay);
        entry.ignoreTimer.unref?.();
    }

    async #recheckIgnores(entry: WatchedRoot): Promise<void> {
        if (entry.closed || !entry.watching) return;
        const ignored = await this.#ignoredDirectories(entry);
        if (entry.closed) return;
        entry.ignoreCheckedAt = Date.now();
        entry.ignored = ignored;
    }

    #failed(entry: WatchedRoot, error: unknown, wasWatching: boolean): void {
        this.#ctx.log.debug(
            "A working tree could not be watched; its changes will be polled.",
            { path: entry.root },
            error,
        );
        const subscription = entry.subscription;
        entry.subscription = undefined;
        entry.subscriptionGeneration += 1;
        if (subscription !== undefined) {
            subscription.live = false;
            void closeNative(subscription.native);
        }
        if (entry.watching) {
            entry.watching = false;
            for (const observer of Array.from(entry.observers)) {
                observer.onWatching?.(false);
                // Events between the failure and now are unknown.
                if (wasWatching) observer.onChanges(null);
            }
        }
        if (entry.retryTimer !== undefined) return;
        const delay = entry.retryDelayMs;
        entry.retryDelayMs = Math.min(RETRY_LIMIT_MS, entry.retryDelayMs * 2);
        entry.retryTimer = setTimeout(() => {
            entry.retryTimer = undefined;
            if (!entry.closed) void this.#subscribe(entry);
        }, delay);
        entry.retryTimer.unref?.();
    }

    #close(entry: WatchedRoot): void {
        if (entry.closed) return;
        entry.closed = true;
        entry.subscriptionGeneration += 1;
        entry.listing.abort();
        if (entry.ignoreTimer !== undefined) clearTimeout(entry.ignoreTimer);
        if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
        if (entry.subscription !== undefined) {
            entry.subscription.live = false;
            // Built-in handles close before the caller goes on to delete the folder.
            if (USE_BUILTIN_WATCHER) void entry.subscription.native.unsubscribe();
            else void closeNative(entry.subscription.native);
        }
        entry.subscription = undefined;
        entry.observers.clear();
        if (this.#roots.get(entry.root) === entry) this.#roots.delete(entry.root);
    }

    /**
     * Every directory Git ignores, as Git itself decides, through the hardened read-only runner.
     * `--directory` reports an ignored directory once instead of descending into it. A folder
     * that is not a repository ignores nothing beyond the fixed list.
     */
    async #ignoredDirectories(entry: WatchedRoot): Promise<readonly string[]> {
        if (!LISTS_IGNORED || entry.closed) return [];
        try {
            const result = await this.#scan({
                args: [
                    "ls-files",
                    "-z",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                    "--directory",
                ],
                cwd: entry.root,
                maximumBytes: IGNORED_LISTING_BYTES,
                signal: entry.listing.signal,
            });
            const directories = result.stdout
                .split("\0")
                .filter((entry) => entry.endsWith("/"))
                .map((entry) => entry.slice(0, -1))
                .filter((entry) => entry.length > 0 && !entry.split("/").includes(".."));
            return directories.sort().slice(0, IGNORED_DIRECTORY_LIMIT);
        } catch {
            return [];
        }
    }

    async #loadParcel(): Promise<ParcelWatcher> {
        this.#parcel ??= import("@parcel/watcher").then(
            (loaded) => (loaded as ParcelWatcher & { default?: ParcelWatcher }).default ?? loaded,
        );
        return await this.#parcel;
    }
}

function relativePath(root: string, path: string): string | undefined {
    const value = relative(root, path);
    if (value.length === 0 || value.startsWith("..") || isAbsolute(value)) return undefined;
    return sep === "/" ? value : value.split(sep).join("/");
}

function isUnder(path: string, directory: string): boolean {
    return path === directory || path.startsWith(`${directory}/`);
}

/** Whether `path` is inside one of the ignored directories. */
function isIgnored(ignored: readonly string[], path: string): boolean {
    return ignored.some((directory) => isUnder(path, directory));
}
