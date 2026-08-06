import type { Bash } from "just-bash";

import type { FileSystemContext } from "./FileSystemContext.js";
import { toFileSystemStat } from "./toFileSystemStat.js";
import { isProtectedPath, type PermissionContext } from "../../permissions/index.js";
import { resolve } from "node:path";

export function createJustBashFileSystemContext(
    bash: Bash,
    cwd: string,
    permissions?: PermissionContext,
): FileSystemContext {
    const assertWritable = (path: string) => {
        if (permissions === undefined || permissions.mode === "full_access") return;
        if (permissions.mode === "read_only") {
            throw new Error("File changes are disabled in read-only mode.");
        }
        if (isProtectedPath(resolve(cwd, path), permissions.protectedPaths)) {
            throw new Error("Cannot modify a protected workspace path without Full access.");
        }
    };
    return {
        cwd,
        async chmod(path, mode) {
            assertWritable(path);
            await bash.fs.chmod(path, mode);
        },
        async exists(path) {
            try {
                await bash.fs.lstat(path);
                return true;
            } catch (error) {
                if (
                    error instanceof Error &&
                    (error.message.startsWith("ENOENT:") || error.message.startsWith("ENOTDIR:"))
                ) {
                    return false;
                }
                throw error;
            }
        },
        async lstat(path) {
            return toFileSystemStat(await bash.fs.lstat(path));
        },
        async lstatMany(paths) {
            return Promise.all(
                paths.map(async (path) => {
                    try {
                        return await this.lstat(path);
                    } catch {
                        return undefined;
                    }
                }),
            );
        },
        async mkdir(path, mkdirOptions) {
            assertWritable(path);
            await bash.fs.mkdir(path, mkdirOptions);
        },
        async move(source, destination) {
            assertWritable(source);
            assertWritable(destination);
            await bash.fs.mv(source, destination);
        },
        async realpath(path) {
            return bash.fs.realpath(path);
        },
        async readFile(path) {
            return bash.fs.readFile(path);
        },
        async readFileBuffer(path, options) {
            if (options?.noFollow === true) {
                const facts = toFileSystemStat(await bash.fs.lstat(path));
                if (facts.isSymbolicLink) {
                    throw new Error(`Could not read '${path}' because it is a symbolic link.`);
                }
            }
            const bytes = await bash.fs.readFileBuffer(path);
            if (options?.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
                throw new Error(
                    `Could not read '${path}' because it exceeds ${String(options.maxBytes)} bytes.`,
                );
            }
            return bytes;
        },
        async readdir(path) {
            return bash.fs.readdir(path);
        },
        async readdirPage(path, options) {
            const after = options.after === undefined ? undefined : Buffer.from(options.after);
            const entries = (await bash.fs.readdir(path))
                .map((name) => ({ bytes: Buffer.from(name), name }))
                .filter((entry) => after === undefined || Buffer.compare(entry.bytes, after) > 0)
                .sort((left, right) => Buffer.compare(left.bytes, right.bytes));
            const hasMore = entries.length > options.limit;
            return {
                entries: (hasMore ? entries.slice(0, options.limit) : entries).map(
                    (entry) => entry.name,
                ),
                hasMore,
            };
        },
        async rm(path, rmOptions) {
            assertWritable(path);
            await bash.fs.rm(path, rmOptions);
        },
        async setModificationTime(path, mtimeMs) {
            assertWritable(path);
            const time = new Date(mtimeMs);
            await bash.fs.utimes(path, time, time);
        },
        async stat(path) {
            const stats = await bash.fs.stat(path);
            return toFileSystemStat(stats);
        },
        async writeFile(path, content) {
            assertWritable(path);
            await bash.fs.writeFile(path, content);
        },
    };
}
