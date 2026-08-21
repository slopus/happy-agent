import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import type { RootContext } from "@steve.kite/stdlib";

const CONTROL_ENTRIES = new Set([
    "CHERRY_PICK_HEAD",
    "HEAD",
    "MERGE_HEAD",
    "ORIG_HEAD",
    "REBASE_HEAD",
    "REVERT_HEAD",
    "index",
]);
const COMMON_ENTRIES = new Set(["config", "packed-refs"]);

export type GitRepositoryChange =
    | { readonly kind: "armed" }
    | { readonly entry?: string; readonly kind: "git" | "refs" }
    | { readonly kind: "worktree"; readonly path?: string };

export interface GitRepositoryWatchOptions {
    commonDirectory: string;
    gitDirectory: string;
    onDirty: (change: GitRepositoryChange) => void;
    onDegraded?: (reason: string) => void;
    path: string;
}

interface GitWatchSubscription {
    readonly accept?: (entry: string) => boolean;
    readonly kind: GitWatchTarget["kind"];
    readonly onDegraded?: (reason: string) => void;
    readonly onDirty: (change: GitRepositoryChange) => void;
}

interface SharedGitWatchTarget {
    readonly directory: string;
    failure: string | undefined;
    readonly key: string;
    readonly recursive: boolean;
    readonly subscriptions: Set<GitWatchSubscription>;
    watcher: FSWatcher | undefined;
}

/**
 * One module-owned pool of filesystem watchers.
 *
 * Worktrees have distinct control directories and working trees, but share their common Git
 * directory and refs. Pooling by physical directory means those shared locations have one
 * `fs.watch` handle whose events fan out to the interested repository trackers.
 */
export class GitRepositoryWatchRegistry {
    readonly #abort = () => this.dispose();
    readonly #context: ReturnType<RootContext["named"]>;
    #disposed = false;
    readonly #targets = new Map<string, SharedGitWatchTarget>();

    constructor(rootContext: RootContext) {
        this.#context = rootContext.named("git-repository-watch-registry");
        this.#context.lifetime?.addEventListener("abort", this.#abort, { once: true });
    }

    /** The number of physical filesystem watch handles currently owned by the registry. */
    get watchedTargetCount(): number {
        return [...this.#targets.values()].filter((target) => target.watcher !== undefined).length;
    }

    watch(options: GitRepositoryWatchOptions): () => void {
        if (this.#disposed) return () => undefined;
        const releases = gitWatchTargets(options).map((target) => this.#subscribe(target, options));
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            for (const unsubscribe of releases) unsubscribe();
        };
        options.onDirty({ kind: "armed" });
        return release;
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const target of this.#targets.values()) closeWatcher(target.watcher);
        this.#targets.clear();
        this.#context.lifetime?.removeEventListener("abort", this.#abort);
    }

    #subscribe(target: GitWatchTarget, options: GitRepositoryWatchOptions): () => void {
        const key = gitWatchTargetKey(target);
        let shared = this.#targets.get(key);
        if (shared === undefined) {
            shared = {
                directory: target.directory,
                failure: undefined,
                key,
                recursive: target.recursive,
                subscriptions: new Set(),
                watcher: undefined,
            };
            this.#targets.set(key, shared);
            this.#arm(shared);
        }
        const subscription: GitWatchSubscription = {
            ...(target.accept === undefined ? {} : { accept: target.accept }),
            kind: target.kind,
            ...(options.onDegraded === undefined ? {} : { onDegraded: options.onDegraded }),
            onDirty: options.onDirty,
        };
        shared.subscriptions.add(subscription);
        if (shared.failure !== undefined) options.onDegraded?.(shared.failure);

        return () => {
            shared!.subscriptions.delete(subscription);
            if (shared!.subscriptions.size > 0) return;
            closeWatcher(shared!.watcher);
            this.#targets.delete(shared!.key);
        };
    }

    #arm(target: SharedGitWatchTarget): void {
        try {
            const watcher = watch(
                target.directory,
                { recursive: target.recursive },
                (_event, filename) => {
                    if (this.#disposed) return;
                    // An undecodable byte filename cannot be represented safely as a Git
                    // pathspec, so degrade that event to an unclassified full reconciliation.
                    const entry = typeof filename === "string" ? filename : undefined;
                    for (const subscription of Array.from(target.subscriptions)) {
                        if (
                            entry !== undefined &&
                            subscription.accept !== undefined &&
                            !subscription.accept(entry)
                        ) {
                            continue;
                        }
                        subscription.onDirty(changeFor(subscription.kind, entry ?? ""));
                    }
                },
            );
            watcher.on("error", (error) => {
                const reason = watchFailure(target.directory, error, true);
                target.failure = reason;
                closeWatcher(target.watcher);
                target.watcher = undefined;
                for (const subscription of target.subscriptions) {
                    subscription.onDegraded?.(reason);
                }
            });
            watcher.unref?.();
            target.watcher = watcher;
        } catch (error) {
            target.failure = watchFailure(target.directory, error, false);
        }
    }
}

/** A standalone watch for callers that do not already own a shared registry. */
export function watchGitRepositoryChanges(
    rootContext: RootContext,
    options: GitRepositoryWatchOptions,
): () => void {
    const registry = new GitRepositoryWatchRegistry(rootContext);
    const unwatch = registry.watch(options);
    return () => {
        unwatch();
        registry.dispose();
    };
}

export interface GitWatchTarget {
    accept?: (entry: string) => boolean;
    directory: string;
    kind: "git" | "refs" | "worktree";
    recursive: boolean;
}

export function gitWatchTargets(options: {
    commonDirectory: string;
    gitDirectory: string;
    path: string;
}): readonly GitWatchTarget[] {
    const shared = options.commonDirectory === options.gitDirectory;
    const targets: GitWatchTarget[] = [
        {
            accept: (entry) => CONTROL_ENTRIES.has(entry) || (shared && COMMON_ENTRIES.has(entry)),
            directory: options.gitDirectory,
            kind: "git",
            recursive: false,
        },
    ];
    if (!shared) {
        targets.push({
            accept: (entry) => COMMON_ENTRIES.has(entry),
            directory: options.commonDirectory,
            kind: "git",
            recursive: false,
        });
    }
    targets.push({
        accept: (entry) => entry === "exclude",
        directory: join(options.commonDirectory, "info"),
        kind: "git",
        recursive: false,
    });
    targets.push({
        directory: join(options.commonDirectory, "refs"),
        kind: "refs",
        recursive: true,
    });
    if (supportsRecursiveWorktreeWatch()) {
        targets.push({ directory: options.path, kind: "worktree", recursive: true });
    }
    return targets;
}

export function gitWatchTargetKey(target: Pick<GitWatchTarget, "directory" | "recursive">): string {
    return `${target.recursive ? "recursive" : "shallow"}:${target.directory}`;
}

export function supportsRecursiveWorktreeWatch(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
}

function changeFor(kind: GitWatchTarget["kind"], entry: string): GitRepositoryChange {
    if (kind === "worktree") {
        return entry.length === 0 ? { kind } : { kind, path: entry };
    }
    return entry.length === 0 ? { kind } : { entry, kind };
}

function closeWatcher(watcher: FSWatcher | undefined): void {
    try {
        watcher?.close();
    } catch {
        // The platform already closed this watcher.
    }
}

function watchFailure(directory: string, error: unknown, stopped: boolean): string {
    if (stopped) return `Watching ${directory} stopped.`;
    return `Watching ${directory} is unavailable: ${error instanceof Error ? error.message : "unknown error"}`;
}
