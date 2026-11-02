import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { FileFinder } from "@ff-labs/fff-node";

import type { GitModule } from "../git/index.js";
import { rankFilePaths } from "./impl/rankFilePaths.js";

const DEFAULT_MAX_INDEXES = 8;
const RESCAN_AFTER_MS = 2_000;
const SEARCH_READY_BUDGET_MS = 100;
/** How many result pages a search reads past dependency trees before settling for fewer. */
const MAX_FILTERED_PAGES = 20;
/** Dependency and repository directories fff leaves out of a folder in no repository. */
const UNINDEXED_DIRECTORIES = new Set([
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
]);

interface IndexFreshness {
    lastScanAt: number;
    /** Whether a file may have been added, removed, or renamed since the last scan started. */
    stale: boolean;
    readonly unwatch: () => void;
    /** Whether working-tree events are arriving; without them a search rescans on a timer. */
    watching: boolean;
}

/** fff's own index, for a repository's top level or a folder in no repository. */
interface FinderIndex extends IndexFreshness {
    readonly kind: "finder";
    readonly finder: FileFinder;
    /**
     * Whether fff indexes the folder in the mode of a repository above it whose listing of the
     * folder is empty or cut off, so results under dependency trees are left out as fff would in
     * no repository.
     */
    readonly unindexedLeftOut: boolean;
}

/** Git's ignore-aware listing, for a folder nested below its repository's top level. */
interface ListingIndex extends IndexFreshness {
    readonly kind: "listing";
    readonly root: string;
    paths: readonly string[];
    pending: Promise<void> | undefined;
    /** Whether the last listing stopped at Git's cap, so fff must index the folder instead. */
    truncated: boolean;
}

type IndexState = FinderIndex | ListingIndex;

type FinderHealth = ReturnType<typeof import("@ff-labs/fff-node").FileFinder.healthCheckStatic>;

/**
 * Bounded file-name indexes, one per recently searched workspace.
 *
 * fff indexes a repository's top level and a folder in no repository. A folder nested inside a
 * repository is listed by Git instead, because fff loses the ignore rules its ancestors declare
 * there and would offer dependency and build trees. A folder Git lists nothing for — one its
 * repository ignores entirely, or one Git is told to treat as in no repository — keeps fff's
 * index, with dependency trees left out of its results as fff leaves them out of a folder in no
 * repository; so does a folder too large for Git's bounded listing, whose files past the cap
 * would otherwise never be found. Either index is refreshed only when the Git module's shared working-tree watch
 * reports a path appearing or disappearing, so an idle workspace costs nothing. fff's own watcher
 * stays off: it would be a second recursive watch of the same tree. When a tree cannot be
 * watched, a search falls back to rescanning when the index is more than a couple of seconds old.
 */
export class WorkspaceFileIndex {
    readonly #indexes = new Map<string, IndexState>();
    readonly #git: GitModule;
    readonly #maxIndexes = DEFAULT_MAX_INDEXES;
    #fileFinderConstructor: Promise<typeof import("@ff-labs/fff-node").FileFinder> | undefined;

    constructor(git: GitModule) {
        this.#git = git;
    }

    close(): void {
        for (const state of this.#indexes.values()) this.#destroy(state);
        this.#indexes.clear();
    }

    /** Marks an index out of date after a structural change the caller made or observed. */
    refresh(root: string): void {
        const state = this.#indexes.get(resolve(root));
        if (state !== undefined) state.stale = true;
    }

    /** Requests a scan only when a file proven by a direct read is absent from a warm index. */
    ensure(root: string, path: string): void {
        const state = this.#indexes.get(resolve(root));
        if (state === undefined) return;
        if (state.kind === "listing") {
            if (state.pending !== undefined || !state.paths.includes(path)) state.stale = true;
            return;
        }
        // A scan in flight may have passed the path before it existed, so the next search rescans.
        if (state.finder.isScanning()) {
            state.stale = true;
            return;
        }
        const result = state.finder.fileSearch(path, { pageSize: 10 });
        if (!result.ok) return;
        if (!result.value.items.some((item) => item.relativePath === path)) {
            this.#startScan(state);
        }
    }

    async search(
        root: string,
        query: string,
        limit: number,
    ): Promise<readonly { readonly fileName: string; readonly path: string }[]> {
        const state = await this.#stateFor(root);
        const outdated =
            state.stale || (!state.watching && Date.now() - state.lastScanAt > RESCAN_AFTER_MS);
        if (state.kind === "listing") {
            if (outdated || state.pending !== undefined) await this.#relist(state);
            if (!state.truncated) return rankFilePaths(state.paths, query, limit);
            // The folder outgrew the listing; the next index for it is fff's.
            this.#forget(state);
            return await this.search(root, query, limit);
        }
        if (outdated) this.#startScan(state);
        if (state.finder.isScanning()) {
            await this.#waitForScan(state.finder, SEARCH_READY_BUDGET_MS);
        }
        const files: { readonly fileName: string; readonly path: string }[] = [];
        for (let pageIndex = 0; files.length < limit; pageIndex += 1) {
            const result = state.finder.fileSearch(query, { pageIndex, pageSize: limit });
            if (!result.ok) throw new Error(`File search failed: ${result.error}`);
            for (const item of result.value.items) {
                if (files.length === limit) break;
                if (state.unindexedLeftOut && underUnindexed(item.relativePath)) continue;
                files.push({ fileName: item.fileName, path: item.relativePath });
            }
            if (
                !state.unindexedLeftOut ||
                (pageIndex + 1) * limit >= result.value.totalMatched ||
                pageIndex + 1 === MAX_FILTERED_PAGES
            ) {
                break;
            }
        }
        return files;
    }

    async #stateFor(root: string): Promise<IndexState> {
        const basePath = resolve(root);
        const existing = this.#indexes.get(basePath);
        if (existing !== undefined) {
            this.#indexes.delete(basePath);
            this.#indexes.set(basePath, existing);
            return existing;
        }

        const FileFinderConstructor = await this.#loadFileFinder();
        const health = FileFinderConstructor.healthCheckStatic(basePath);
        const holder: { state?: IndexState } = {};
        // A folder in no repository is watched only where fff reads it: not in hidden or
        // dependency directories, where an agent's caches and package stores can hold tens of
        // thousands of directories that would each cost a kernel watch.
        const inRepository = health.ok && health.value.git.repositoryFound;
        const unwatch = this.#git.watchWorkingTree(
            basePath,
            {
                onChanges: (changes) => {
                    const state = holder.state;
                    if (state === undefined) return;
                    if (changes === null || changes.some((change) => change.kind !== "update")) {
                        state.stale = true;
                    }
                },
                onWatching: (watching) => {
                    const state = holder.state;
                    if (state === undefined) return;
                    state.watching = watching;
                    // Whatever happened before the watch went live, or after it stopped, is unknown.
                    state.stale = true;
                },
            },
            inRepository ? {} : { plainFolder: true },
        );
        let state: IndexState;
        try {
            state = await this.#createIndex(FileFinderConstructor, health, basePath, unwatch);
        } catch (error) {
            unwatch();
            throw error;
        }
        // A concurrent first search may have built the same index while this one was waiting.
        const raced = this.#indexes.get(basePath);
        if (raced !== undefined) {
            this.#destroy(state);
            return raced;
        }
        holder.state = state;
        this.#indexes.set(basePath, state);
        this.#removeOldestIndex();
        return state;
    }

    async #createIndex(
        FileFinderConstructor: typeof import("@ff-labs/fff-node").FileFinder,
        health: FinderHealth,
        basePath: string,
        unwatch: () => void,
    ): Promise<IndexState> {
        const belowRepository = await this.#belowFinderRepository(health, basePath);
        if (belowRepository) {
            const listing: ListingIndex = {
                kind: "listing",
                lastScanAt: 0,
                paths: [],
                pending: undefined,
                root: basePath,
                stale: true,
                truncated: false,
                unwatch,
                watching: false,
            };
            await this.#relist(listing);
            // Git lists nothing for a folder its repository ignores entirely, or one it is told
            // to treat as in no repository, and only part of a folder past its cap; fff sees all.
            if (listing.paths.length > 0 && !listing.truncated) return listing;
        }

        const created = FileFinderConstructor.create({
            aiMode: true,
            basePath,
            disableContentIndexing: true,
            disableMmapCache: true,
            disableWatch: true,
        });
        if (!created.ok) {
            throw new Error(`Workspace files could not be indexed: ${created.error}`);
        }
        return {
            finder: created.value,
            kind: "finder",
            lastScanAt: Date.now(),
            stale: false,
            unindexedLeftOut: belowRepository,
            unwatch,
            watching: false,
        };
    }

    /**
     * Whether fff would index a folder in the mode of a repository above it, which loses that
     * repository's ignore rules. fff finds repositories itself and ignores `GIT_CEILING_DIRECTORIES`,
     * so this asks fff rather than Git: a folder Git is told to treat as in no repository is still
     * below one for fff.
     */
    async #belowFinderRepository(health: FinderHealth, basePath: string): Promise<boolean> {
        const workdir = health.ok ? health.value.git.workdir : undefined;
        if (!health.ok || !health.value.git.repositoryFound || workdir === undefined) return false;
        const [folder, repository] = await Promise.all([
            realpath(basePath).catch(() => basePath),
            realpath(workdir).catch(() => resolve(workdir)),
        ]);
        return folder !== repository;
    }

    async #relist(state: ListingIndex): Promise<void> {
        if (state.pending !== undefined) return await state.pending;
        // Cleared before listing, so a change reported while it runs leaves the listing stale.
        state.stale = false;
        state.pending = this.#git
            .listWorkingTreeFiles({ path: state.root })
            .then((listed) => {
                state.paths = listed.paths;
                state.truncated = listed.truncated;
                state.lastScanAt = Date.now();
            })
            .catch((error: unknown) => {
                state.stale = true;
                throw error;
            })
            .finally(() => {
                state.pending = undefined;
            });
        return await state.pending;
    }

    async #waitForScan(finder: FileFinder, timeoutMs: number): Promise<void> {
        await finder.waitForScan(timeoutMs).catch(() => undefined);
    }

    #startScan(state: FinderIndex): void {
        if (state.finder.isScanning()) return;
        // Cleared before scanning, so a change during the scan leaves the index stale again.
        state.stale = false;
        if (state.finder.scanFiles().ok) state.lastScanAt = Date.now();
        else state.stale = true;
    }

    #removeOldestIndex(): void {
        if (this.#indexes.size <= this.#maxIndexes) return;

        const oldestPath = this.#indexes.keys().next().value as string | undefined;
        if (oldestPath === undefined) return;

        const oldest = this.#indexes.get(oldestPath);
        this.#indexes.delete(oldestPath);
        if (oldest !== undefined) this.#destroy(oldest);
    }

    /** Drops an index so the next search builds a new one for its folder. */
    #forget(state: ListingIndex): void {
        if (this.#indexes.get(state.root) !== state) return;
        this.#indexes.delete(state.root);
        this.#destroy(state);
    }

    #destroy(state: IndexState): void {
        state.unwatch();
        if (state.kind === "finder") state.finder.destroy();
    }

    async #loadFileFinder(): Promise<typeof import("@ff-labs/fff-node").FileFinder> {
        this.#fileFinderConstructor ??= import("@ff-labs/fff-node").then(
            ({ FileFinder: FileFinderConstructor }) => FileFinderConstructor,
        );
        return await this.#fileFinderConstructor;
    }
}

/** Whether a relative path lies in a dependency or repository directory. */
function underUnindexed(path: string): boolean {
    return path
        .split("/")
        .slice(0, -1)
        .some((segment) => UNINDEXED_DIRECTORIES.has(segment));
}
