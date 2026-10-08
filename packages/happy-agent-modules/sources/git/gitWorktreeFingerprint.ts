import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import type { GitWorkingFiles } from "./GitWorkingFiles.js";
import { localGitWorkingFiles } from "./impl/localGitWorkingFiles.js";
import type { GitStatusV2 } from "./parseGitStatusV2.js";

/** Beyond this many changed paths a fingerprint costs more than it saves. */
export const GIT_FINGERPRINT_PATH_LIMIT = 2_000;
const STAT_BATCH = 64;

/** The index and HEAD as this machine's filesystem sees them, without asking Git. */
export function gitIndexFingerprint(gitDirectory: string | undefined): string {
    if (gitDirectory === undefined) return "";
    return [join(gitDirectory, "index"), join(gitDirectory, "HEAD")]
        .map((path) => {
            try {
                const stats = statSync(path);
                return `${String(stats.size)}:${String(stats.mtimeMs)}`;
            } catch {
                return "missing";
            }
        })
        .join("|");
}

/** The same fingerprint for a repository on another machine, read through its files. */
export async function remoteGitIndexFingerprint(
    gitDirectory: string | undefined,
    files: GitWorkingFiles,
): Promise<string> {
    if (gitDirectory === undefined) return "";
    const stats = await files.lstatMany([join(gitDirectory, "index"), join(gitDirectory, "HEAD")]);
    return stats
        .map((stat) =>
            stat === undefined ? "missing" : `${String(stat.size)}:${String(stat.mtimeMs)}`,
        )
        .join("|");
}

/**
 * Everything a change snapshot depends on that can move without a Git metadata event.
 *
 * Committed changes are fixed by HEAD, which status reports. Staging is fixed by the index. What
 * remains is the working tree, and only the paths status already lists can differ from HEAD, so
 * their status lines plus a stat of each prove the tree is where the last scan left it. A new or
 * removed path changes status itself. `undefined` means the tree is too large to prove this way.
 */
export async function gitWorktreeFingerprint(options: {
    files?: GitWorkingFiles;
    indexFingerprint: string;
    root: string;
    status: GitStatusV2;
    statusOutput: string;
}): Promise<string | undefined> {
    if (options.status.entries.length > GIT_FINGERPRINT_PATH_LIMIT) return undefined;
    const files = options.files ?? localGitWorkingFiles;
    const hash = createHash("sha256");
    hash.update(options.indexFingerprint);
    hash.update("\0\0");
    hash.update(options.statusOutput);
    const paths = options.status.entries.map((entry) => entry.path);
    for (let offset = 0; offset < paths.length; offset += STAT_BATCH) {
        const stats = await files.lstatMany(
            paths.slice(offset, offset + STAT_BATCH).map((path) => join(options.root, path)),
        );
        for (const stat of stats)
            hash.update(`\0${stat === undefined ? "missing" : stat.identity}`);
    }
    return hash.digest("hex");
}
