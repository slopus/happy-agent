import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { UntrackedFileCount } from "../countUntrackedFileLines.js";
import type { GitWorkingFile, GitWorkingFiles } from "../GitWorkingFiles.js";

const BINARY_SNIFF_BYTES = 8 * 1024;
/** The product reads its own folders; the agent sandbox does not apply to Git scans. */
const PRODUCT = computePermissions("full_access");

/** A runner's working trees, read through its product machine. */
export function runnerGitWorkingFiles(machine: () => Promise<Compute>): GitWorkingFiles {
    return {
        async lstatMany(paths) {
            const stats = await (await machine()).fs.lstatMany(PRODUCT, paths);
            return stats.map((stat) =>
                stat === undefined
                    ? undefined
                    : {
                          isFile: stat.isFile,
                          size: stat.size,
                          mtimeMs: stat.mtimeMs,
                          identity: `${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.mode ?? 0)}`,
                      },
            );
        },
        async countUntrackedLines(path, maximumBytes): Promise<UntrackedFileCount> {
            const fs = (await machine()).fs;
            let bytes: Uint8Array;
            try {
                const stat = await fs.lstat(PRODUCT, path);
                if (stat.isSymbolicLink) return { binary: false, inexact: false, insertions: 1 };
                if (!stat.isFile || stat.size > maximumBytes)
                    return { binary: false, inexact: true };
                bytes = await fs.readFileBuffer(PRODUCT, path, {
                    maxBytes: maximumBytes,
                    noFollow: true,
                });
            } catch {
                return { binary: false, inexact: true };
            }
            if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
                return { binary: true, inexact: false };
            }
            let lines = 0;
            for (const byte of bytes) if (byte === 0x0a) lines += 1;
            if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) lines += 1;
            return { binary: false, inexact: false, insertions: lines };
        },
        async openWorkingFile(path, maximumBytes): Promise<GitWorkingFile> {
            const fs = (await machine()).fs;
            let stat;
            try {
                stat = await fs.lstat(PRODUCT, path);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                return code === "ENOENT" || code === "ENOTDIR"
                    ? { kind: "missing" }
                    : { kind: "unavailable" };
            }
            if (stat.isSymbolicLink || !stat.isFile) return { kind: "not_file" };
            if (stat.size > maximumBytes) return { kind: "too_large" };
            return {
                kind: "file",
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                async read(limit) {
                    try {
                        return await fs.readFileBuffer(PRODUCT, path, {
                            maxBytes: limit,
                            noFollow: true,
                        });
                    } catch {
                        return null;
                    }
                },
                async close() {},
            };
        },
    };
}
