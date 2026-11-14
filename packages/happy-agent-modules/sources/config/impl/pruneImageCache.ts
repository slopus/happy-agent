import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** A saved image no request has named for this long belongs to a conversation long finished. */
export const IMAGE_CACHE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Remove the image copies no request has named for half a year, and return how many went.
 *
 * Every request renews the modification time of each image it names, so a conversation still in
 * use never loses a file; only one untouched for six months does, and its next request writes the
 * copy again from history. There is no size limit, so pruning never reaches a live conversation.
 * A folder that does not exist yet holds nothing to prune.
 */
export async function pruneImageCache(
    directory: string,
    now: number = Date.now(),
    maxAgeMs: number = IMAGE_CACHE_MAX_AGE_MS,
): Promise<number> {
    const names = await readdir(directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    });
    let removed = 0;
    for (const name of names) {
        const path = join(directory, name);
        const facts = await stat(path).catch(() => undefined);
        if (facts?.isFile() !== true || now - facts.mtimeMs <= maxAgeMs) continue;
        await rm(path, { force: true });
        removed += 1;
    }
    return removed;
}
