import {
    chmod,
    lstat,
    mkdir,
    open,
    opendir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    utimes,
    writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { assertCanReadPath } from "./assertCanReadPath.js";
import { assertCanWritePath } from "./assertCanWritePath.js";
import { createUserSkillRootPaths } from "./createUserSkillRootPaths.js";
import type { FileSystemContext, FileSystemStat } from "./FileSystemContext.js";
import { toFileSystemStat } from "./toFileSystemStat.js";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "../../permissions/index.js";
import { getBuiltinSkillRoot } from "../skills/getBuiltinSkillRoot.js";

export interface CreateNodeFileSystemContextOptions {
    home?: string;
    permissionMode?: () => PermissionMode;
    platform?: NodeJS.Platform;
    protectedPaths?: readonly string[];
}

export function createNodeFileSystemContext(
    cwd: string,
    options: CreateNodeFileSystemContextOptions = {},
): FileSystemContext {
    const permissionMode = options.permissionMode ?? (() => DEFAULT_PERMISSION_MODE);
    const resolvePath = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
    const home = options.home ?? homedir();
    const protectedPaths = options.protectedPaths ?? [];
    const readPathOptions = {
        allowedPaths: [getBuiltinSkillRoot(), ...createUserSkillRootPaths(home)],
        homeDirectory: home,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
    };
    return {
        cwd,
        home,
        async chmod(path, mode) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode(), protectedPaths);
            await chmod(target, mode);
        },
        async exists(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            try {
                await lstat(target);
                return true;
            } catch (error) {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
                ) {
                    return false;
                }
                throw error;
            }
        },
        async lstat(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return toFileSystemStat(await lstat(target));
        },
        async lstatMany(paths) {
            const results: (FileSystemStat | undefined)[] = [];
            for (let offset = 0; offset < paths.length; offset += 32) {
                const batch = paths.slice(offset, offset + 32);
                results.push(
                    ...(await Promise.all(
                        batch.map(async (path) => {
                            try {
                                return await this.lstat(path);
                            } catch {
                                return undefined;
                            }
                        }),
                    )),
                );
            }
            return results;
        },
        async mkdir(path, options) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode(), protectedPaths);
            await mkdir(target, { recursive: options?.recursive ?? false });
        },
        async move(source, destination) {
            const sourceTarget = resolvePath(source);
            const destinationTarget = resolvePath(destination);
            await assertCanWritePath(cwd, sourceTarget, permissionMode(), protectedPaths);
            await assertCanWritePath(cwd, destinationTarget, permissionMode(), protectedPaths);
            await rename(sourceTarget, destinationTarget);
        },
        async realpath(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return realpath(target);
        },
        async readFile(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return readFile(target, "utf8");
        },
        async readFileBuffer(path, readOptions) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return readOptions?.noFollow === true
                ? readFileBufferWithoutFollowing(
                      target,
                      readOptions.maxBytes ?? Number.MAX_SAFE_INTEGER,
                  )
                : readOptions?.maxBytes === undefined
                  ? readFile(target)
                  : readFileBufferWithLimit(target, readOptions.maxBytes);
        },
        async readdir(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return readdir(target);
        },
        async readdirPage(path, pageOptions) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            const capacity = pageOptions.limit + 1;
            const entries: DirectoryHeapEntry[] = [];
            const after =
                pageOptions.after === undefined ? undefined : Buffer.from(pageOptions.after);
            const directory = await opendir(target);
            for await (const entry of directory) {
                const candidate = { bytes: Buffer.from(entry.name), name: entry.name };
                if (after !== undefined && Buffer.compare(candidate.bytes, after) <= 0) continue;
                addToBoundedMaxHeap(entries, candidate, capacity);
            }
            entries.sort(compareDirectoryHeapEntries);
            const hasMore = entries.length > pageOptions.limit;
            if (hasMore) entries.pop();
            return { entries: entries.map((entry) => entry.name), hasMore };
        },
        async rm(path, options) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode(), protectedPaths);
            await rm(target, {
                recursive: options?.recursive ?? false,
                force: options?.force ?? false,
            });
        },
        async setModificationTime(path, mtimeMs) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode(), protectedPaths);
            const time = new Date(mtimeMs);
            await utimes(target, time, time);
        },
        async stat(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return toFileSystemStat(await stat(target));
        },
        async writeFile(path, content) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode(), protectedPaths);
            await writeFile(target, content);
        },
    };
}

interface DirectoryHeapEntry {
    bytes: Buffer;
    name: string;
}

function compareDirectoryHeapEntries(left: DirectoryHeapEntry, right: DirectoryHeapEntry): number {
    return Buffer.compare(left.bytes, right.bytes);
}

function addToBoundedMaxHeap(
    heap: DirectoryHeapEntry[],
    entry: DirectoryHeapEntry,
    capacity: number,
): void {
    if (heap.length < capacity) {
        heap.push(entry);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (compareDirectoryHeapEntries(heap[parent]!, heap[index]!) >= 0) break;
            [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
            index = parent;
        }
        return;
    }
    if (compareDirectoryHeapEntries(entry, heap[0]!) >= 0) return;
    heap[0] = entry;
    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= heap.length) return;
        const larger =
            right < heap.length && compareDirectoryHeapEntries(heap[right]!, heap[left]!) > 0
                ? right
                : left;
        if (compareDirectoryHeapEntries(heap[index]!, heap[larger]!) >= 0) return;
        [heap[index], heap[larger]] = [heap[larger]!, heap[index]!];
        index = larger;
    }
}

async function readFileBufferWithLimit(path: string, maxBytes: number): Promise<Buffer> {
    return readOpenedFileWithLimit(path, maxBytes, "r");
}

async function readFileBufferWithoutFollowing(path: string, maxBytes: number): Promise<Buffer> {
    return readOpenedFileWithLimit(path, maxBytes, constants.O_RDONLY | constants.O_NOFOLLOW);
}

async function readOpenedFileWithLimit(
    path: string,
    maxBytes: number,
    flags: number | string,
): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new Error("The file read limit must be a non-negative safe integer.");
    }
    const file = await open(path, flags);
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        while (length <= maxBytes) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) return Buffer.concat(chunks, length);
            chunks.push(chunk.subarray(0, bytesRead));
            length += bytesRead;
        }
        throw new Error(`Could not read '${path}' because it exceeds ${String(maxBytes)} bytes.`);
    } finally {
        await file.close();
    }
}
