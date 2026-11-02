import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { MirroredSkillFile } from "./collectMirroredSkills.js";

/** The most files a product folder may have. */
const MAX_FOLDER_FILES = 2_048;
/** The most bytes a product folder may hold. */
const MAX_FOLDER_BYTES = 32 * 1024 * 1024;

/** A whole folder to copy, and the hash of everything in it. */
export interface MirroredFolder {
    readonly files: readonly MirroredSkillFile[];
    readonly hash: string;
}

/**
 * Every regular file under a folder of this daemon's own product files, such as its documentation
 * or native skills, with a hash of the whole tree. Links are not followed: the folder is the
 * product's, written by its installer. Undefined when the folder does not exist.
 */
export async function collectMirroredFolder(root: string): Promise<MirroredFolder | undefined> {
    let entries;
    try {
        entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    const paths = entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
        .sort();
    if (paths.length > MAX_FOLDER_FILES) {
        throw new Error(`${root} has more than ${String(MAX_FOLDER_FILES)} files to copy.`);
    }
    const digest = createHash("sha256");
    const files: MirroredSkillFile[] = [];
    let total = 0;
    for (const path of paths) {
        const absolute = join(root, ...path.split("/"));
        const info = await stat(absolute);
        total += info.size;
        if (total > MAX_FOLDER_BYTES) throw new Error(`${root} is too large to copy.`);
        const bytes = await readFile(absolute);
        const executable = (info.mode & 0o111) !== 0;
        digest.update(JSON.stringify([path, executable]));
        digest.update(createHash("sha256").update(bytes).digest());
        files.push({ path, size: info.size, executable, read: async () => bytes });
    }
    return { files, hash: digest.digest("hex").slice(0, 16) };
}
