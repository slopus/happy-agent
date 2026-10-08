import { join } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { GitModule } from "../../git/index.js";
import { rankFilePaths } from "./rankFilePaths.js";

const PRODUCT = computePermissions("full_access");
const MAX_LISTINGS = 8;
const MAX_LISTED_FILES = 20_000;
const MAX_WALKED_DIRECTORIES = 2_000;
const MAX_STATS_PER_CALL = 4_096;
/** How old an unwatched listing may be before a search lists the folder again. */
const RELIST_AFTER_MS = 2_000;
const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

interface Listing {
    listedAt: number;
    paths: readonly string[];
    pending: Promise<readonly string[]> | undefined;
    /** Whether the folder's watch reported a change since the listing started. */
    stale: boolean;
}

/**
 * File-name search for folders on runners, which the native index on this machine cannot reach.
 *
 * The runner lists the folder itself — Git's own view of the working tree, which already leaves
 * ignored files out, or a bounded walk outside a repository — and the list is ranked here. One
 * listing is kept for each of the few most recently searched folders and listed again once it is
 * stale: after the folder's watch reports a change, or after a couple of seconds when nothing is
 * watching it.
 */
export class MachineFileIndex {
    readonly #git: GitModule;
    readonly #listings = new Map<string, Listing>();

    constructor(git: GitModule) {
        this.#git = git;
    }

    close(): void {
        this.#listings.clear();
    }

    /** Marks a listing out of date after a change the folder's watch reported. */
    refresh(runnerId: string, root: string): void {
        const listing = this.#listings.get(listingKey(runnerId, root));
        if (listing !== undefined) listing.stale = true;
    }

    async search(
        machine: Compute,
        folder: { readonly root: string; readonly runnerId: string },
        query: string,
        limit: number,
        watching: boolean,
    ): Promise<{ readonly fileName: string; readonly path: string }[]> {
        const paths = await this.#paths(machine, folder, watching);
        return rankFilePaths(paths, query, limit);
    }

    async #paths(
        machine: Compute,
        folder: { readonly root: string; readonly runnerId: string },
        watching: boolean,
    ): Promise<readonly string[]> {
        const key = listingKey(folder.runnerId, folder.root);
        let listing = this.#listings.get(key);
        if (listing !== undefined) {
            this.#listings.delete(key);
            this.#listings.set(key, listing);
        } else {
            listing = { listedAt: 0, paths: [], pending: undefined, stale: true };
            this.#listings.set(key, listing);
            while (this.#listings.size > MAX_LISTINGS) {
                const oldest = this.#listings.keys().next().value as string | undefined;
                if (oldest === undefined) break;
                this.#listings.delete(oldest);
            }
        }
        const outdated = watching ? listing.stale : Date.now() - listing.listedAt > RELIST_AFTER_MS;
        if (!outdated) return listing.paths;
        if (listing.pending !== undefined) return await listing.pending;
        const current = listing;
        // Cleared before listing, so a change reported while it runs leaves the listing stale.
        current.stale = false;
        current.pending = this.#list(machine, folder)
            .then((paths) => {
                current.paths = paths;
                current.listedAt = Date.now();
                return paths;
            })
            .catch((error: unknown) => {
                current.stale = true;
                throw error;
            })
            .finally(() => {
                current.pending = undefined;
            });
        return await current.pending;
    }

    async #list(
        machine: Compute,
        folder: { readonly root: string; readonly runnerId: string },
    ): Promise<readonly string[]> {
        const listed = await this.#git
            .listWorkingTreeFiles({ path: folder.root, runnerId: folder.runnerId })
            .catch(() => undefined);
        if (listed !== undefined && listed.paths.length > 0) return listed.paths;
        return await walk(machine, folder.root);
    }
}

/** Every file under a folder outside any repository, breadth first and bounded. */
async function walk(machine: Compute, root: string): Promise<readonly string[]> {
    const files: string[] = [];
    const directories = [""];
    let visited = 0;
    while (
        directories.length > 0 &&
        files.length < MAX_LISTED_FILES &&
        visited < MAX_WALKED_DIRECTORIES
    ) {
        const directory = directories.shift() as string;
        visited += 1;
        const absolute = directory === "" ? root : join(root, directory);
        const names = await machine.fs.readdir(PRODUCT, absolute).catch(() => [] as string[]);
        for (let offset = 0; offset < names.length; offset += MAX_STATS_PER_CALL) {
            const page = names.slice(offset, offset + MAX_STATS_PER_CALL);
            const stats = await machine.fs.lstatMany(
                PRODUCT,
                page.map((name) => join(absolute, name)),
            );
            page.forEach((name, index) => {
                const stat = stats[index];
                const path = directory === "" ? name : `${directory}/${name}`;
                if (stat?.isDirectory === true) {
                    if (!SKIPPED_DIRECTORIES.has(name)) directories.push(path);
                } else if (stat?.isFile === true && files.length < MAX_LISTED_FILES) {
                    files.push(path);
                }
            });
        }
    }
    return files;
}

function listingKey(runnerId: string, root: string): string {
    return `${runnerId}\0${root}`;
}
