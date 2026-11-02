import type { PlatformPath } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import { countLinesInBytes } from "../countUntrackedFileLines.js";
import type { GitPathStat, GitWorkingFiles } from "../gitWorkingFiles.js";
import { gitIndexFingerprint } from "../gitWorktreeFingerprint.js";

/** The product reads its own folders; the agent sandbox does not apply here. */
const PRODUCT = computePermissions("full_access");
/** Paths one request may stat; the runner protocol takes at most 10,000. */
const STAT_BATCH = 4_096;

/**
 * A runner's working files, read through its product machine.
 *
 * A runner reports a file's size, mode, and modification time but not its inode or change time,
 * so a fingerprint here moves with content size or modification time. A same-size rewrite that
 * also restores the time goes unnoticed until the next full scan, which runs at least every half
 * hour. Each request is a round trip, so a scan stats the files it will read in one batch and
 * passes each one's details in, and reads only the bytes it needs.
 */
export function machineGitWorkingFiles(
    machine: () => Promise<Compute>,
    paths: () => PlatformPath,
): GitWorkingFiles {
    return {
        get paths() {
            return paths();
        },
        async indexFingerprint(gitDirectory) {
            if (gitDirectory === undefined) return "";
            const rules = paths();
            const compute = await machine();
            return gitIndexFingerprint(
                await compute.fs.lstatMany(PRODUCT, [
                    rules.join(gitDirectory, "index"),
                    rules.join(gitDirectory, "HEAD"),
                ]),
            );
        },
        async lstatMany(candidates) {
            const compute = await machine();
            const stats: (GitPathStat | undefined)[] = [];
            for (let offset = 0; offset < candidates.length; offset += STAT_BATCH) {
                const page = await compute.fs.lstatMany(
                    PRODUCT,
                    candidates.slice(offset, offset + STAT_BATCH),
                );
                for (const details of page) {
                    stats.push(
                        details === undefined
                            ? undefined
                            : {
                                  fingerprint: [
                                      details.size,
                                      details.mtimeMs,
                                      details.mode ?? "",
                                  ].join(":"),
                                  isFile: details.isFile,
                                  isSymbolicLink: details.isSymbolicLink,
                                  mtimeMs: details.mtimeMs,
                                  size: details.size,
                              },
                    );
                }
            }
            return stats;
        },
        async open(path, maximumBytes, known) {
            const compute = await machine();
            // The read below refuses a link and stops at the limit, whatever the path became since.
            const details =
                known === undefined ? (await compute.fs.lstatMany(PRODUCT, [path]))[0] : known.stat;
            if (details === undefined) return { kind: "missing" };
            if (details.isSymbolicLink || !details.isFile) return { kind: "not_file" };
            if (details.size > maximumBytes) return { kind: "too_large" };
            return {
                kind: "file",
                mtimeMs: details.mtimeMs,
                size: details.size,
                read: async () => {
                    try {
                        const bytes = await compute.fs.readFileBuffer(PRODUCT, path, {
                            maxBytes: maximumBytes,
                            noFollow: true,
                        });
                        return bytes.byteLength > maximumBytes ? null : bytes;
                    } catch {
                        // Grown past the limit, replaced by a link, or gone since it was checked.
                        return null;
                    }
                },
                close: async () => undefined,
            };
        },
        async countLines(path, maximumBytes, known) {
            try {
                const compute = await machine();
                const details =
                    known === undefined
                        ? (await compute.fs.lstatMany(PRODUCT, [path]))[0]
                        : known.stat;
                if (details === undefined) return { binary: false, inexact: true };
                if (details.isSymbolicLink) return { binary: false, inexact: false, insertions: 1 };
                if (!details.isFile || details.size > maximumBytes) {
                    return { binary: false, inexact: true };
                }
                const bytes = await compute.fs.readFileBuffer(PRODUCT, path, {
                    maxBytes: maximumBytes,
                    noFollow: true,
                });
                return countLinesInBytes(bytes);
            } catch {
                return { binary: false, inexact: true };
            }
        },
    };
}
