import { createHash } from "node:crypto";

import type { GitWorkingFiles } from "./gitWorkingFiles.js";
import type { GitStatusV2 } from "./parseGitStatusV2.js";

/** Beyond this many changed paths a fingerprint costs more than it saves. */
export const GIT_FINGERPRINT_PATH_LIMIT = 2_000;

/** The index and HEAD as the filesystem sees them, without asking Git. */
export function gitIndexFingerprint(
    stats: readonly ({ readonly size: number; readonly mtimeMs: number } | undefined)[],
): string {
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
    files: GitWorkingFiles;
    indexFingerprint: string;
    root: string;
    status: GitStatusV2;
    statusOutput: string;
}): Promise<string | undefined> {
    if (options.status.entries.length > GIT_FINGERPRINT_PATH_LIMIT) return undefined;
    const hash = createHash("sha256");
    hash.update(options.indexFingerprint);
    hash.update("\0\0");
    hash.update(options.statusOutput);
    const stats = await options.files.lstatMany(
        options.status.entries.map((entry) => options.files.paths.join(options.root, entry.path)),
    );
    for (const stat of stats) hash.update(`\0${stat?.fingerprint ?? "missing"}`);
    return hash.digest("hex");
}
