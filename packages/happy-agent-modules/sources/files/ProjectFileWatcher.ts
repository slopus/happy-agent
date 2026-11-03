import { lstatSync, opendirSync, realpathSync, watch, type Dir, type FSWatcher } from "node:fs";
import { dirname } from "node:path";

import type { Compute, ComputeWatch } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { GitModule } from "../git/index.js";

const MAX_CHANGED_PATHS = 256;
const MAX_PATH_LENGTH = 16_384;
/** A watched folder with more entries than this is compared as a whole, not entry by entry. */
const MAX_RECONCILED_ENTRIES = 1_000;
const MAX_WATCHED_DIRECTORIES = 256;
const MAX_WATCHED_FILES = 256;
const MAX_WATCHED_TREES = 8;
/** Runner folders a client opened inside a directory the shared watch leaves out. */
const MAX_WATCHED_RUNNER_DIRECTORIES = 8;
/** Directory names a watch of a left-out runner directory still never descends into. */
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
    /** The folder's entry names as last compared, or undefined past the entry cap. */
    entries: ReadonlySet<string> | undefined;
    /** The folder's identity and change times when `entries` was taken; undefined once gone. */
    fingerprint: string | undefined;
    /** Whether a reported change has not been folded into `entries` yet. */
    pending: boolean;
    readonly relativeDirectory: string;
    readonly root: ProjectFileWatchRoot;
    readonly watcher: FSWatcher;
}

interface FileWatch {
    /** Device and inode of the file the watch is on, from the fingerprint it armed with. */
    identity: string | undefined;
    readonly path: string;
    watcher: FSWatcher | undefined;
}

interface TreeWatch {
    readonly root: string;
    readonly runnerId: string | undefined;
    unwatch: () => void;
    /** Whether the shared watch is delivering events, so a listing is current until it reports. */
    watching: boolean;
}

interface RunnerDirectoryWatch {
    ended: boolean;
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
 * A folder on a runner is watched as a whole instead, through the Git module's shared watch of
 * that folder on the runner — the same watch live Git tracking uses, skipping dependency,
 * repository, and Git-ignored directories — because each watch there is a stream to another
 * machine rather than a native handle. A client that opens a directory the shared watch leaves
 * out, such as one inside `node_modules`, gets a watch of that directory of its own. Only the few
 * most recently read runner folders and left-out directories are watched.
 */
export class ProjectFileWatcher {
    readonly #changes = new Map<string, PendingChange>();
    readonly #files = new Map<string, FileWatch>();
    /** Rendered files whose watch failed and were reported broadly, until one arms again. */
    readonly #unwatchable = new Set<string>();
    readonly #ctx: Context;
    readonly #inFlight = new Set<Promise<void>>();
    readonly #onChange: ProjectFileChangeObserver;
    readonly #trees = new Map<string, TreeWatch>();
    readonly #runnerDirectories = new Map<string, RunnerDirectoryWatch>();
    readonly #watches = new Map<string, DirectoryWatch>();
    readonly #git: GitModule;
    #closed = false;

    constructor(ctx: Context, git: GitModule, onChange: ProjectFileChangeObserver) {
        this.#ctx = ctx;
        this.#git = git;
        this.#onChange = onChange;
    }

    /**
     * Watches one folder a client just read, by itself.
     *
     * On macOS every directory watch in the process shares one FSEvents stream, which the runtime
     * stops and recreates whenever any directory watch is added or closed; a create or delete
     * landing a few milliseconds either side of that is not reported. Each watch therefore keeps
     * the folder's entry names as last compared. Every watched folder is compared with them right
     * after a directory watch is added or closed here, and a folder again when it is read again,
     * so a change the stream lost is reported then, without polling.
     */
    watchDirectory(root: ProjectFileWatchRoot, relativeDirectory: string, directory: string): void {
        if (this.#closed) return;
        const workspaceId = root.workspaceId ?? root.projectId;
        const key = `${workspaceId}\0${relativeDirectory}`;
        const existing = this.#watches.get(key);
        if (existing?.directory === directory) {
            this.#watches.delete(key);
            this.#watches.set(key, existing);
            this.#reconcile(existing);
            return;
        }
        if (existing !== undefined) this.#removeWatch(key);

        let entry: DirectoryWatch | undefined;
        let watcher: FSWatcher;
        try {
            watcher = watch(directory, { persistent: false }, (event, filename) => {
                this.#observed(root, changedPath(relativeDirectory, filename), event === "rename");
                if (event === "rename" && entry !== undefined) this.#settle(key, entry);
            });
        } catch {
            if (existing !== undefined) this.#reconcileAll();
            return;
        }
        watcher.on("error", () => {
            if (entry === undefined || this.#watches.get(key) !== entry) return;
            this.#removeWatch(key);
            this.#reconcileAll();
        });
        watcher.unref?.();
        // Taken once the watch is armed and before the client lists the folder, so a later change
        // is in that listing, reported by the watch, or found by the next comparison.
        const fingerprint = directoryFingerprint(directory);
        entry = {
            directory,
            entries: fingerprint === undefined ? undefined : directoryEntries(directory),
            fingerprint,
            pending: false,
            relativeDirectory,
            root,
            watcher,
        };
        this.#watches.set(key, entry);
        while (this.#watches.size > MAX_WATCHED_DIRECTORIES) {
            const oldestKey = this.#watches.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.#removeWatch(oldestKey);
        }
        this.#reconcileAll(entry);
    }

    /**
     * Watches one file a client just read, by itself.
     *
     * On macOS every directory watch in the process shares one FSEvents stream, which libuv stops
     * and recreates from "now" whenever any directory watch is added or closed; a change landing
     * meanwhile is never reported. A file watch is a kqueue vnode watch there, untouched by that.
     * `seen` is the file's fingerprint from before it was read: one that differs once the watch
     * is armed changed in between, and is reported then.
     */
    watchFile(
        root: ProjectFileWatchRoot,
        relativePath: string,
        path: string,
        seen: string | undefined,
    ): void {
        if (this.#closed) return;
        const key = `${root.workspaceId ?? root.projectId}\0${relativePath}`;
        const existing = this.#files.get(key);
        // The same path may name another file by now, as when its folder was moved and remade.
        if (
            existing?.path === path &&
            existing.watcher !== undefined &&
            (seen === undefined || fileIdentity(seen) === existing.identity)
        ) {
            this.#files.delete(key);
            this.#files.set(key, existing);
            return;
        }
        if (existing !== undefined) this.#removeFile(key);
        const entry: FileWatch = { identity: undefined, path, watcher: undefined };
        this.#files.set(key, entry);
        this.#armFile(root, key, relativePath, entry, seen);
        while (this.#files.size > MAX_WATCHED_FILES) {
            const oldestKey = this.#files.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.#removeFile(oldestKey);
        }
    }

    /**
     * Watches a whole folder on a runner, remote or a workload user's, through the shared watch of
     * it, and — when the client read a directory that watch leaves out — that directory too.
     * `directory` is that directory's path on the runner.
     */
    watchTree(
        root: ProjectFileWatchRoot,
        machine: Compute,
        relativeDirectory = "",
        directory = root.root,
    ): void {
        if (this.#closed) return;
        const key = root.workspaceId ?? root.projectId;
        const existing = this.#trees.get(key);
        if (existing?.root === root.root && existing.runnerId === root.runnerId) {
            this.#trees.delete(key);
            this.#trees.set(key, existing);
        } else {
            if (existing !== undefined) this.#removeTree(key);
            const entry: TreeWatch = {
                root: root.root,
                runnerId: root.runnerId,
                watching: false,
                unwatch: () => undefined,
            };
            // Set first: the shared watch may already be live and say so at once.
            this.#trees.set(key, entry);
            entry.unwatch = this.#git.watchWorkingTree(
                root.root,
                {
                    onChanges: (changes) => {
                        if (this.#trees.get(key) !== entry) return;
                        if (changes === null) {
                            this.#observed(root, null, true);
                            return;
                        }
                        for (const change of changes) {
                            this.#observed(root, changedPath("", change.path), true);
                        }
                    },
                    onWatching: (watching) => {
                        entry.watching = watching;
                    },
                },
                root.runnerId === undefined ? {} : { runnerId: root.runnerId },
            );
            while (this.#trees.size > MAX_WATCHED_TREES) {
                const oldestKey = this.#trees.keys().next().value as string | undefined;
                if (oldestKey === undefined) break;
                this.#removeTree(oldestKey);
            }
        }
        if (
            relativeDirectory !== "" &&
            !this.#git.coversWorkingTreePath(
                root.root,
                relativeDirectory,
                root.runnerId === undefined ? {} : { runnerId: root.runnerId },
            )
        ) {
            this.#watchRunnerDirectory(root, machine, relativeDirectory, directory);
        }
    }

    /** Whether a runner folder's watch is live, so its listing is current until it reports. */
    watchingTree(root: ProjectFileWatchRoot): boolean {
        const entry = this.#trees.get(root.workspaceId ?? root.projectId);
        return entry?.root === root.root && entry.watching;
    }

    /** Watches one runner directory the shared watch leaves out, with what is below it. */
    #watchRunnerDirectory(
        root: ProjectFileWatchRoot,
        machine: Compute,
        relativeDirectory: string,
        directory: string,
    ): void {
        const watcher = machine.watcher;
        if (watcher === undefined) return;
        const key = `${root.runnerId ?? ""}\0${root.workspaceId ?? root.projectId}\0${relativeDirectory}`;
        const existing = this.#runnerDirectories.get(key);
        if (existing !== undefined && !existing.ended) {
            this.#runnerDirectories.delete(key);
            this.#runnerDirectories.set(key, existing);
            return;
        }
        const entry: RunnerDirectoryWatch = { ended: false, watch: undefined };
        this.#runnerDirectories.set(key, entry);
        while (this.#runnerDirectories.size > MAX_WATCHED_RUNNER_DIRECTORIES) {
            const oldestKey = this.#runnerDirectories.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.#removeRunnerDirectory(oldestKey);
        }
        const forget = (): void => {
            entry.ended = true;
            if (this.#runnerDirectories.get(key) === entry) this.#runnerDirectories.delete(key);
        };
        watcher
            .watch(this.#ctx, {
                path: directory,
                ignore: UNWATCHED_DIRECTORIES.filter(
                    (name) => !relativeDirectory.split("/").includes(name),
                ),
            })
            .then(
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
                            this.#observed(root, changedPath(relativeDirectory, path), true);
                        }
                    });
                    // A runner that went away ends its watches; the next read arms a new one.
                    void watch.closed.then(forget);
                },
                (error: unknown) => {
                    forget();
                    this.#ctx.log.warn("A runner directory could not be watched.", { key }, error);
                },
            );
    }

    #removeRunnerDirectory(key: string): void {
        const entry = this.#runnerDirectories.get(key);
        if (entry === undefined) return;
        this.#runnerDirectories.delete(key);
        entry.ended = true;
        entry.watch?.close();
    }

    /** Announces a successful module-owned write even when its directory was not already watched. */
    changed(root: ProjectFileWatchRoot, path: string): void {
        if (this.#closed) return;
        this.#observed(root, path, false);
        // Folded into its folder's entries, so a comparison does not report the write again.
        const parent = dirname(path);
        const key = `${root.workspaceId ?? root.projectId}\0${parent === "." ? "" : parent}`;
        const entry = this.#watches.get(key);
        if (entry !== undefined) this.#settle(key, entry);
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        for (const { watcher } of this.#watches.values()) closeWatcher(watcher);
        this.#watches.clear();
        for (const { watcher } of this.#files.values()) if (watcher) closeWatcher(watcher);
        this.#files.clear();
        for (const key of [...this.#trees.keys()]) this.#removeTree(key);
        for (const key of [...this.#runnerDirectories.keys()]) this.#removeRunnerDirectory(key);
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
        entry.unwatch();
    }

    /**
     * Arms a file's watch, then compares its fingerprint with `seen`, so a change between the two
     * is reported rather than lost. A file replaced by a rename leaves the watch on its old inode;
     * it is reported and the new one is watched the same way.
     *
     * On macOS the kernel holds the watch only once the loop next polls, which from an I/O
     * callback is after the second check phase, so the comparison waits two turns: one any
     * sooner can miss a change made in between.
     */
    #armFile(
        root: ProjectFileWatchRoot,
        key: string,
        relativePath: string,
        entry: FileWatch,
        seen: string | undefined,
    ): void {
        let watcher: FSWatcher;
        try {
            watcher = watch(entry.path, { persistent: false }, (event) => {
                if (this.#files.get(key) !== entry || entry.watcher !== watcher) return;
                if (event !== "rename") {
                    this.#observed(root, relativePath, false);
                    return;
                }
                // Only a regular file at the same canonical path takes the old one's place: a link,
                // a folder, or a parent swapped for a link is not followed out of the root. The
                // path is checked before the watch is armed on it, so a swap in between can still
                // make it follow a link; that yields change hints about an outside file, never
                // its content.
                const current = canonical(entry.path) ? fileFingerprint(entry.path) : undefined;
                // macOS also reports a write in place as a rename; the same file keeps its watch.
                if (current !== undefined && fileIdentity(current) === entry.identity) {
                    this.#observed(root, relativePath, false);
                    return;
                }
                this.#observed(root, relativePath, true);
                closeWatcher(watcher);
                entry.watcher = undefined;
                if (current === undefined) this.#files.delete(key);
                else this.#armFile(root, key, relativePath, entry, current);
            });
        } catch {
            this.#files.delete(key);
            this.#unwatched(root, key);
            return;
        }
        watcher.on("error", () => {
            if (entry.watcher !== watcher) return;
            this.#removeFile(key);
            this.#unwatched(root, key);
        });
        watcher.unref?.();
        entry.watcher = watcher;
        entry.identity = seen === undefined ? undefined : fileIdentity(seen);
        this.#unwatchable.delete(key);
        if (seen === undefined) return;
        setImmediate(() =>
            setImmediate(() => {
                if (this.#closed || this.#files.get(key) !== entry || entry.watcher !== watcher) {
                    return;
                }
                const current = fileFingerprint(entry.path);
                if (current !== seen) this.#observed(root, relativePath, current === undefined);
            }),
        );
    }

    /**
     * A rendered file that cannot be watched may change unseen, so its workspace is reported as
     * changed without a path. Only once per file until it is watched again: the client's re-read
     * that follows fails the same way and must not report again, or the two would loop. The set
     * forgets the oldest of more than 256 such files, so a client rendering more than that many
     * unwatchable files at once could still be asked to refetch them in a cycle.
     */
    #unwatched(root: ProjectFileWatchRoot, key: string): void {
        if (this.#unwatchable.has(key)) return;
        this.#unwatchable.add(key);
        while (this.#unwatchable.size > MAX_WATCHED_FILES) {
            const oldest = this.#unwatchable.values().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#unwatchable.delete(oldest);
        }
        this.#observed(root, null, false);
    }

    #removeFile(key: string): void {
        const entry = this.#files.get(key);
        if (entry === undefined) return;
        this.#files.delete(key);
        if (entry.watcher !== undefined) closeWatcher(entry.watcher);
        entry.watcher = undefined;
    }

    /** Compares every watched folder with its entries once directory watches churned. */
    #reconcileAll(except?: DirectoryWatch): void {
        for (const entry of [...this.#watches.values()]) {
            if (entry !== except) this.#reconcile(entry);
        }
    }

    /**
     * Folds a reported change into its folder's entries on the next turn, once for a burst, so
     * the next comparison reports only what no event did.
     */
    #settle(key: string, entry: DirectoryWatch): void {
        if (entry.pending) return;
        entry.pending = true;
        setImmediate(() => {
            if (this.#watches.get(key) === entry) this.#reconcile(entry);
        });
    }

    /**
     * Reports the entries a watched folder gained or lost since they were last taken, then takes
     * them again. A folder past the entry cap or unreadable is reported as a whole, unless a
     * change reported but not yet folded in already accounts for it; a folder that went away is
     * reported by its own path.
     */
    #reconcile(entry: DirectoryWatch): void {
        if (this.#closed) return;
        const explained = entry.pending;
        entry.pending = false;
        const fingerprint = directoryFingerprint(entry.directory);
        if (fingerprint === entry.fingerprint) return;
        const previous = entry.entries;
        entry.fingerprint = fingerprint;
        entry.entries = fingerprint === undefined ? undefined : directoryEntries(entry.directory);
        const current = entry.entries;
        if (fingerprint === undefined) {
            if (!explained) {
                const path = entry.relativeDirectory === "" ? null : entry.relativeDirectory;
                this.#observed(entry.root, path, true);
            }
        } else if (previous === undefined || current === undefined) {
            if (!explained) this.#observed(entry.root, null, true);
        } else {
            for (const name of current) {
                if (previous.has(name)) continue;
                this.#observed(entry.root, changedPath(entry.relativeDirectory, name), true);
            }
            for (const name of previous) {
                if (current.has(name)) continue;
                this.#observed(entry.root, changedPath(entry.relativeDirectory, name), true);
            }
        }
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

/**
 * Identity and change times of a local directory, or undefined once it is gone or is no longer a
 * directory. They move whenever an entry is created, removed or renamed in it.
 */
function directoryFingerprint(path: string): string | undefined {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isDirectory()) return undefined;
        return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
        return undefined;
    }
}

/** A directory's entry names, or undefined past the entry cap or when it cannot be read. */
function directoryEntries(path: string): ReadonlySet<string> | undefined {
    let directory: Dir | undefined;
    try {
        directory = opendirSync(path);
        const names = new Set<string>();
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
            if (names.size === MAX_RECONCILED_ENTRIES) return undefined;
            names.add(entry.name);
        }
        return names;
    } catch {
        return undefined;
    } finally {
        try {
            directory?.closeSync();
        } catch {
            // The directory handle was already closed.
        }
    }
}

/**
 * Identity, size and change times of a local regular file, or undefined once it is gone or is
 * no longer a regular file. The change time moves on every write, even one that restores the
 * modification time, and a replacement has a new inode.
 */
export function fileFingerprint(path: string): string | undefined {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isFile()) return undefined;
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
        return undefined;
    }
}

/** The device and inode of a fingerprint: which file it is, whatever its content. */
function fileIdentity(fingerprint: string): string {
    return fingerprint.split(":", 2).join(":");
}

/**
 * Whether no link anywhere on `path` leads elsewhere. Read paths are already canonical, resolved
 * natively as this is.
 */
function canonical(path: string): boolean {
    try {
        return realpathSync.native(path) === path;
    } catch {
        return false;
    }
}

function closeWatcher(watcher: FSWatcher): void {
    try {
        watcher.close();
    } catch {
        // The platform already closed this watcher.
    }
}
