import { constants, statSync } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path, { type PlatformPath } from "node:path";

import { countUntrackedFileLines, type UntrackedFileCount } from "./countUntrackedFileLines.js";
import { gitIndexFingerprint } from "./gitWorktreeFingerprint.js";

/** What a scan needs to know about one path in a working tree. */
export interface GitPathStat {
    /** Moves whenever the file at the path can have changed: its identity, size, or times. */
    readonly fingerprint: string;
    readonly isFile: boolean;
    readonly isSymbolicLink: boolean;
    readonly mtimeMs: number;
    readonly size: number;
}

/** A working file opened for display: proved regular and small enough, its bytes read on demand. */
export type GitWorkingFile =
    | {
          readonly kind: "file";
          readonly mtimeMs: number;
          readonly size: number;
          /** The file's bytes, or null when it grew past the display limit. */
          read(): Promise<Uint8Array | null>;
          close(): Promise<void>;
      }
    | { readonly kind: "missing" | "not_file" | "too_large" | "unavailable" };

/**
 * The working-tree files a scan reads besides Git's own output, on the machine the repository is
 * on: this one, or a runner. Git reports what changed; these say whether a changed file moved
 * since the last scan, how many lines an untracked file adds, and the bytes of a binary delta.
 */
export interface GitWorkingFiles {
    /** The path rules of the repository's machine. */
    readonly paths: PlatformPath;
    /**
     * The index and HEAD as the filesystem sees them, without asking Git. A scan takes it before
     * and after reading, and only trusts a read that both sides agree on.
     */
    indexFingerprint(gitDirectory: string | undefined): Promise<string>;
    /** Each path's details, or undefined where nothing is there. */
    lstatMany(paths: readonly string[]): Promise<readonly (GitPathStat | undefined)[]>;
    /**
     * One file opened for display, refusing links, other kinds of file, and files past the limit.
     * `known` is the path's details from a batched {@link lstatMany} taken moments ago; a machine
     * where each stat is a round trip uses it, and this one opens the file and asks it instead.
     */
    open(path: string, maximumBytes: number, known?: KnownGitPath): Promise<GitWorkingFile>;
    /** How many lines an untracked file adds, and whether it is binary or could not be counted. */
    countLines(
        path: string,
        maximumBytes: number,
        known?: KnownGitPath,
    ): Promise<UntrackedFileCount>;
}

/** A path's details from a batched stat: `stat` is undefined when nothing was there. */
export interface KnownGitPath {
    readonly stat: GitPathStat | undefined;
}

const STAT_BATCH = 64;

/** This machine's working files, read in this process. */
export const localGitWorkingFiles: GitWorkingFiles = {
    paths: path,
    // Two small stats taken synchronously, so the index cannot move between them and the scan.
    async indexFingerprint(gitDirectory) {
        if (gitDirectory === undefined) return "";
        return gitIndexFingerprint(
            [path.join(gitDirectory, "index"), path.join(gitDirectory, "HEAD")].map((file) => {
                try {
                    return statSync(file);
                } catch {
                    return undefined;
                }
            }),
        );
    },
    async lstatMany(paths) {
        const stats: (GitPathStat | undefined)[] = [];
        for (let offset = 0; offset < paths.length; offset += STAT_BATCH) {
            stats.push(
                ...(await Promise.all(
                    paths.slice(offset, offset + STAT_BATCH).map(async (candidate) => {
                        try {
                            const details = await lstat(candidate);
                            return {
                                fingerprint: [
                                    details.ino,
                                    details.size,
                                    details.mtimeMs,
                                    details.ctimeMs,
                                ].join(":"),
                                isFile: details.isFile(),
                                isSymbolicLink: details.isSymbolicLink(),
                                mtimeMs: details.mtimeMs,
                                size: details.size,
                            };
                        } catch {
                            return undefined;
                        }
                    }),
                )),
            );
        }
        return stats;
    },
    // A descriptor proves the file it reads, so a stat taken earlier is never trusted here.
    open: async (path, maximumBytes) => await openLocalWorkingFile(path, maximumBytes),
    countLines: async (path, maximumBytes) => await countUntrackedFileLines(path, maximumBytes),
};

/**
 * Opens once, then proves and reads that descriptor. A path replacement after this point cannot
 * redirect the read to a FIFO, device, symlink target, or newly enlarged file.
 */
async function openLocalWorkingFile(path: string, maximumBytes: number): Promise<GitWorkingFile> {
    let handle: FileHandle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
        if (code === "ELOOP") return { kind: "not_file" };
        return { kind: "unavailable" };
    }
    try {
        const details = await handle.stat();
        if (!details.isFile()) {
            await handle.close().catch(() => undefined);
            return { kind: "not_file" };
        }
        if (details.size > maximumBytes) {
            await handle.close().catch(() => undefined);
            return { kind: "too_large" };
        }
        return {
            kind: "file",
            mtimeMs: details.mtimeMs,
            size: details.size,
            read: async () => await readBounded(handle, maximumBytes),
            close: async () => await handle.close().catch(() => undefined),
        };
    } catch {
        await handle.close().catch(() => undefined);
        return { kind: "unavailable" };
    }
}

async function readBounded(handle: FileHandle, maximumBytes: number): Promise<Buffer | null> {
    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
        if (result.bytesRead === 0) return bytes.subarray(0, offset);
        offset += result.bytesRead;
    }
    return null;
}
