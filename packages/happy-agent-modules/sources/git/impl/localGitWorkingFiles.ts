import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { countUntrackedFileLines } from "../countUntrackedFileLines.js";
import type { GitWorkingFile, GitWorkingFiles, GitWorkingFileStat } from "../GitWorkingFiles.js";

/** This machine's working trees. */
export const localGitWorkingFiles: GitWorkingFiles = {
    async lstatMany(paths) {
        return await Promise.all(
            paths.map(async (path): Promise<GitWorkingFileStat | undefined> => {
                try {
                    const details = await lstat(path);
                    return {
                        isFile: details.isFile(),
                        size: details.size,
                        mtimeMs: details.mtimeMs,
                        identity: [
                            details.ino,
                            details.size,
                            details.mtimeMs,
                            details.ctimeMs,
                        ].join(":"),
                    };
                } catch {
                    return undefined;
                }
            }),
        );
    },
    countUntrackedLines: countUntrackedFileLines,
    openWorkingFile,
};

/**
 * Opens once, then proves and reads that descriptor. A path replacement after this point cannot
 * redirect the read to a FIFO, device, symlink target, or newly enlarged file.
 */
async function openWorkingFile(path: string, maximumBytes: number): Promise<GitWorkingFile> {
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
        const opened = handle;
        return {
            kind: "file",
            mtimeMs: details.mtimeMs,
            size: details.size,
            read: async (limit) => await readBounded(opened, limit),
            close: async () => await opened.close().catch(() => undefined),
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
