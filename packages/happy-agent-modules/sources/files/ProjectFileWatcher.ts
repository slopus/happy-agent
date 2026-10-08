import { watch, type FSWatcher } from "node:fs";

import type { Compute, ComputeWatch } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

const MAX_CHANGED_PATHS = 256;
const MAX_PATH_LENGTH = 16_384;
const MAX_WATCHED_DIRECTORIES = 256;
const MAX_WATCHED_TREES = 8;
/** Directory names a runner folder's watch never descends into. */
const UNWATCHED_DIRECTORIES = [
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
];
const CHANGE_DEBOUNCE_MS = 75;
const MAXIMUM_DEBOUNCE_MS = 300;

export interface ProjectFileWatchRoot {
    readonly projectId: string;
    readonly root: string;
    readonly runnerId?: string;
    readonly workspaceId?: string;
}

export type ProjectFileChangeObserver = (
    ctx: Context,
    root: ProjectFileWatchRoot,
    paths: readonly string[] | null,
    structural: boolean,
) => Promise<void> | void;

interface DirectoryWatch {
    readonly directory: string;
    readonly watcher: FSWatcher;
}

interface TreeWatch {
    ended: boolean;
    readonly root: string;
    readonly runnerId: string;
    watch: ComputeWatch | undefined;
}

interface PendingChange {
    firstChangedAt: number | undefined;
    inFlight: Promise<void> | undefined;
    paths: Set<string>;
    root: ProjectFileWatchRoot;
    structural: boolean;
    timer: NodeJS.Timeout | undefined;
    unknown: boolean;
    readonly workspaceId: string;
}

/**
 * Watches only directories a client recently read.
 *
 * One non-recursive watch keeps a rendered file or expanded tree branch current without turning
 * dependency folders into a second recursive index. Watches are retained in least-recently-used
 * order and eviction closes the native handle immediately.
 *
 * A folder on a runner is watched as a whole through that runner's own watcher instead, skipping
 * dependency and repository directories, because each watch there is a request to another machine
 * rather than a native handle. Only the few most recently read runner folders are watched.
 */
export class ProjectFileWatcher {
    readonly #changes = new Map<string, PendingChange>();
    readonly #ctx: Context;
    readonly #inFlight = new Set<Promise<void>>();
    readonly #onChange: ProjectFileChangeObserver;
    readonly #trees = new Map<string, TreeWatch>();
    readonly #watches = new Map<string, DirectoryWatch>();
    #closed = false;

    constructor(ctx: Context, onChange: ProjectFileChangeObserver) {
        this.#ctx = ctx;
        this.#onChange = onChange;
    }

    watchDirectory(root: ProjectFileWatchRoot, relativeDirectory: string, directory: string): void {
        if (this.#closed) return;
        const workspaceId = root.workspaceId ?? root.projectId;
        const key = `${workspaceId}\0${relativeDirectory}`;
        const existing = this.#watches.get(key);
        if (existing?.directory === directory) {
            this.#watches.delete(key);
            this.#watches.set(key, existing);
            return;
        }
        if (existing !== undefined) this.#removeWatch(key);

        let watcher: FSWatcher;
        try {
            watcher = watch(directory, { persistent: false }, (event, filename) => {
                this.#observed(root, changedPath(relativeDirectory, filename), event === "rename");
            });
        } catch {
            return;
        }
        watcher.on("error", () => this.#removeWatch(key));
        watcher.unref?.();
        this.#watches.set(key, { directory, watcher });
        while (this.#watches.size > MAX_WATCHED_DIRECTORIES) {
            const oldestKey = this.#watches.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.#removeWatch(oldestKey);
        }
    }

    /** Watches a whole folder on a runner through that runner's watcher. */
    watchTree(root: ProjectFileWatchRoot & { readonly runnerId: string }, machine: Compute): void {
        const watcher = machine.watcher;
        if (this.#closed || watcher === undefined) return;
        const key = root.workspaceId ?? root.projectId;
        const existing = this.#trees.get(key);
        if (existing?.root === root.root && existing.runnerId === root.runnerId) {
            this.#trees.delete(key);
            this.#trees.set(key, existing);
            return;
        }
        if (existing !== undefined) this.#removeTree(key);
        const entry: TreeWatch = {
            ended: false,
            root: root.root,
            runnerId: root.runnerId,
            watch: undefined,
        };
        this.#trees.set(key, entry);
        while (this.#trees.size > MAX_WATCHED_TREES) {
            const oldestKey = this.#trees.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.#removeTree(oldestKey);
        }
        const forget = (): void => {
            entry.ended = true;
            if (this.#trees.get(key) === entry) this.#trees.delete(key);
        };
        watcher.watch(this.#ctx, { path: root.root, ignore: UNWATCHED_DIRECTORIES }).then(
            (watch) => {
                if (entry.ended) {
                    watch.close();
                    return;
                }
                entry.watch = watch;
                watch.onChange((batch) => {
                    if (batch.overflow) {
                        this.#observed(root, null, true);
                        return;
                    }
                    for (const path of batch.paths) {
                        this.#observed(root, changedPath("", path), true);
                    }
                });
                // A runner that went away ends its watches; the next read arms a new one.
                void watch.closed.then(forget);
            },
            (error: unknown) => {
                forget();
                this.#ctx.log.warn("A runner folder could not be watched.", { key }, error);
            },
        );
    }

    /** Whether a runner folder's watch is live, so its listing is current until it reports. */
    watchingTree(root: ProjectFileWatchRoot): boolean {
        const entry = this.#trees.get(root.workspaceId ?? root.projectId);
        return entry?.root === root.root && entry.watch !== undefined && !entry.ended;
    }

    /** Announces a successful module-owned write even when its directory was not already watched. */
    changed(root: ProjectFileWatchRoot, path: string): void {
        if (this.#closed) return;
        this.#observed(root, path, false);
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        for (const { watcher } of this.#watches.values()) closeWatcher(watcher);
        this.#watches.clear();
        for (const key of [...this.#trees.keys()]) this.#removeTree(key);
        for (const change of this.#changes.values()) {
            if (change.timer !== undefined) clearTimeout(change.timer);
            change.timer = undefined;
            change.paths.clear();
            change.unknown = false;
        }
        await Promise.allSettled([...this.#inFlight]);
        this.#changes.clear();
    }

    #observed(root: ProjectFileWatchRoot, path: string | null, structural: boolean): void {
        if (this.#closed) return;
        const workspaceId = root.workspaceId ?? root.projectId;
        let change = this.#changes.get(workspaceId);
        if (change === undefined) {
            change = {
                firstChangedAt: undefined,
                inFlight: undefined,
                paths: new Set<string>(),
                root,
                structural: false,
                timer: undefined,
                unknown: false,
                workspaceId,
            };
            this.#changes.set(workspaceId, change);
        }
        change.root = root;
        change.structural ||= structural;
        if (path === null) {
            change.paths.clear();
            change.unknown = true;
        } else if (!change.unknown) {
            if (change.paths.has(path) || change.paths.size < MAX_CHANGED_PATHS) {
                change.paths.add(path);
            } else {
                change.paths.clear();
                change.unknown = true;
            }
        }
        if (change.inFlight === undefined) this.#schedule(change);
    }

    #schedule(change: PendingChange): void {
        if (this.#closed) return;
        const now = Date.now();
        change.firstChangedAt ??= now;
        const elapsed = now - change.firstChangedAt;
        const delay = Math.max(0, Math.min(CHANGE_DEBOUNCE_MS, MAXIMUM_DEBOUNCE_MS - elapsed));
        if (change.timer !== undefined) clearTimeout(change.timer);
        change.timer = setTimeout(() => this.#flush(change), delay);
        change.timer.unref?.();
    }

    #flush(change: PendingChange): void {
        change.timer = undefined;
        change.firstChangedAt = undefined;
        if (this.#closed || change.inFlight !== undefined) return;
        if (!change.unknown && change.paths.size === 0) {
            this.#changes.delete(change.workspaceId);
            return;
        }

        const paths = change.unknown ? null : [...change.paths].sort();
        const root = change.root;
        const structural = change.structural;
        change.paths.clear();
        change.structural = false;
        change.unknown = false;
        const task = Promise.resolve(this.#onChange(this.#ctx, root, paths, structural))
            .catch((error: unknown) => {
                this.#ctx.log.warn(
                    "A project file change could not be published.",
                    { workspaceId: change.workspaceId },
                    error,
                );
            })
            .finally(() => {
                this.#inFlight.delete(task);
                change.inFlight = undefined;
                if (this.#closed) {
                    this.#changes.delete(change.workspaceId);
                } else if (change.unknown || change.paths.size > 0) {
                    this.#schedule(change);
                } else {
                    this.#changes.delete(change.workspaceId);
                }
            });
        change.inFlight = task;
        this.#inFlight.add(task);
    }

    #removeTree(key: string): void {
        const entry = this.#trees.get(key);
        if (entry === undefined) return;
        this.#trees.delete(key);
        entry.ended = true;
        entry.watch?.close();
    }

    #removeWatch(key: string): void {
        const entry = this.#watches.get(key);
        if (entry === undefined) return;
        this.#watches.delete(key);
        closeWatcher(entry.watcher);
    }
}

function changedPath(relativeDirectory: string, filename: string | Buffer | null): string | null {
    if (filename === null) return null;
    const name = String(filename).replaceAll("\\", "/");
    if (
        name.length === 0 ||
        name.startsWith("/") ||
        name.includes("\0") ||
        name
            .split("/")
            .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
        return null;
    }
    const path = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    return path.length <= MAX_PATH_LENGTH ? path : null;
}

function closeWatcher(watcher: FSWatcher): void {
    try {
        watcher.close();
    } catch {
        // The platform already closed this watcher.
    }
}
