import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** How many files one walk carries back before it says it stopped early. */
const MAX_WALKED_FILES = 20_000;

/** Folders whose contents are never what a mask is laid over. */
const SKIPPED_FOLDERS = new Set([".git"]);

/**
 * Every regular file under a folder, as workspace-relative paths, for a folder Git cannot list.
 *
 * A workspace that is not a repository still has files a mask can be laid over. The walk is
 * breadth first so a budget spent early is spent near the top, never follows symbolic links, and
 * skips Git's own folder; a walk that hit its budget says so rather than passing off a short
 * answer as the whole tree.
 */
export async function walkFolderFiles(
    root: string,
): Promise<{ readonly paths: readonly string[]; readonly truncated: boolean }> {
    const paths: string[] = [];
    const queue: string[] = [""];
    while (queue.length > 0) {
        const relative = queue.shift()!;
        let entries;
        try {
            entries = await readdir(relative === "" ? root : join(root, relative), {
                withFileTypes: true,
            });
        } catch {
            continue;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!SKIPPED_FOLDERS.has(entry.name)) queue.push(path);
                continue;
            }
            if (!entry.isFile()) continue;
            if (paths.length >= MAX_WALKED_FILES) return { paths: paths.sort(), truncated: true };
            paths.push(path);
        }
    }
    return { paths: paths.sort(), truncated: false };
}
