import { MontyFileHandle, NOT_HANDLED, type OsCallback } from "@pydantic/monty";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeFileStat, ComputeModule, HostCompute } from "../../../compute/index.js";

/** Keep host-side buffering below Monty's 32 MiB interpreter limit. */
const MAX_CODE_MODE_FILE_BYTES = 16 * 1024 * 1024;
const DIRECTORY_PAGE_SIZE = 512;
const MAX_CODE_MODE_DIRECTORY_ENTRIES = 10_000;
const STAT_RESULT_TYPE_ID = 0x434f_4445_4d4f_4445n;
const STAT_RESULT_FIELDS = [
    "st_mode",
    "st_ino",
    "st_dev",
    "st_nlink",
    "st_uid",
    "st_gid",
    "st_size",
    "st_atime",
    "st_mtime",
    "st_ctime",
] as const;
const PYTHON_EXCEPTION_NAMES = new Set([
    "FileExistsError",
    "FileNotFoundError",
    "IsADirectoryError",
    "MemoryError",
    "NotADirectoryError",
    "OSError",
    "PermissionError",
    "RuntimeError",
    "TypeError",
    "UnicodeDecodeError",
]);

/** Monty's JS bridge has a dataclass marker but no public stat-result marker. */
interface MontyStatResult {
    readonly __monty_type__: "Dataclass";
    readonly name: "stat_result";
    readonly typeId: bigint;
    readonly fieldNames: readonly string[];
    readonly fields: Readonly<Record<(typeof STAT_RESULT_FIELDS)[number], number>>;
    readonly frozen: true;
}

/** Serve Monty's virtual filesystem calls through the agent's permission-aware compute. */
export function createCodeModeFileSystem(
    module: ComputeModule,
    compute: HostCompute,
    ctx: Context,
): OsCallback {
    const permissions = module.permissionsForContext(ctx);
    const resolvePath = (value: unknown): string =>
        module.resolvePath(compute, requireString(value, "filesystem path"));

    return async (name, args, kwargs) => {
        try {
            switch (name) {
                case "Path.exists":
                    return (
                        (await statOrUndefined(compute, permissions, resolvePath(args[0]))) !==
                        undefined
                    );
                case "Path.is_file":
                    return (
                        (await statOrUndefined(compute, permissions, resolvePath(args[0])))
                            ?.isFile === true
                    );
                case "Path.is_dir":
                    return (
                        (await statOrUndefined(compute, permissions, resolvePath(args[0])))
                            ?.isDirectory === true
                    );
                case "Path.is_symlink":
                    return (
                        (await lstatOrUndefined(compute, permissions, resolvePath(args[0])))
                            ?.isSymbolicLink === true
                    );
                case "Path.read_text":
                    return await readText(compute, permissions, resolvePath(args[0]));
                case "Path.read_bytes":
                    return await readBytes(compute, permissions, resolvePath(args[0]));
                case "Path.write_text": {
                    const value = requireString(args[1], "text file contents");
                    await write(compute, module, permissions, resolvePath(args[0]), value);
                    return unicodeLength(value);
                }
                case "Path.write_bytes": {
                    const value = requireBytes(args[1]);
                    await write(compute, module, permissions, resolvePath(args[0]), value);
                    return value.byteLength;
                }
                case "Path.append_text": {
                    const value = requireString(args[1], "text file contents");
                    await appendText(compute, module, permissions, resolvePath(args[0]), value);
                    return unicodeLength(value);
                }
                case "Path.append_bytes": {
                    const value = requireBytes(args[1]);
                    await appendBytes(compute, module, permissions, resolvePath(args[0]), value);
                    return value.byteLength;
                }
                case "open":
                    return await openFile(
                        compute,
                        module,
                        permissions,
                        requireString(args[0], "filesystem path"),
                        requireString(args[1], "file mode"),
                    );
                case "Path.mkdir":
                    await makeDirectory(
                        compute,
                        module,
                        permissions,
                        resolvePath(args[0]),
                        kwargs.parents === true,
                        kwargs.exist_ok === true,
                    );
                    return null;
                case "Path.rename":
                    await renamePath(
                        compute,
                        module,
                        permissions,
                        resolvePath(args[0]),
                        resolvePath(args[1]),
                    );
                    return null;
                case "Path.unlink":
                    await unlinkPath(compute, permissions, resolvePath(args[0]));
                    return null;
                case "Path.iterdir":
                    return await listDirectory(compute, permissions, resolvePath(args[0]));
                case "Path.stat":
                    return statResult(await compute.fs.stat(permissions, resolvePath(args[0])));
                case "Path.resolve":
                    return await compute.fs.realpath(permissions, resolvePath(args[0]));
                case "Path.absolute":
                    return resolvePath(args[0]);
                default:
                    return NOT_HANDLED;
            }
        } catch (error) {
            throw asPythonFileError(error);
        }
    };
}

async function readText(
    compute: HostCompute,
    permissions: Parameters<HostCompute["fs"]["readFileBuffer"]>[0],
    path: string,
): Promise<string> {
    const bytes = await readBytes(compute, permissions, path);
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw pythonError("UnicodeDecodeError", `File is not valid UTF-8: ${path}`);
    }
}

async function readBytes(
    compute: HostCompute,
    permissions: Parameters<HostCompute["fs"]["readFileBuffer"]>[0],
    path: string,
): Promise<Uint8Array> {
    const metadata = await compute.fs.stat(permissions, path);
    if (metadata.isDirectory) {
        throw pythonError("IsADirectoryError", `Is a directory: '${path}'`);
    }
    return await compute.fs.readFileBuffer(permissions, path, {
        maxBytes: MAX_CODE_MODE_FILE_BYTES,
    });
}

async function write(
    compute: HostCompute,
    module: ComputeModule,
    permissions: Parameters<HostCompute["fs"]["writeFile"]>[0],
    path: string,
    value: string | Uint8Array,
): Promise<void> {
    assertBounded(value);
    await assertFileDestination(compute, module, permissions, path);
    await compute.fs.writeFile(permissions, path, value);
}

async function appendText(
    compute: HostCompute,
    module: ComputeModule,
    permissions: Parameters<HostCompute["fs"]["writeFile"]>[0],
    path: string,
    value: string,
): Promise<void> {
    const existing = (await compute.fs.exists(permissions, path))
        ? await readText(compute, permissions, path)
        : "";
    await write(compute, module, permissions, path, `${existing}${value}`);
}

async function appendBytes(
    compute: HostCompute,
    module: ComputeModule,
    permissions: Parameters<HostCompute["fs"]["writeFile"]>[0],
    path: string,
    value: Uint8Array,
): Promise<void> {
    const existing = (await compute.fs.exists(permissions, path))
        ? await readBytes(compute, permissions, path)
        : new Uint8Array();
    const combined = new Uint8Array(existing.byteLength + value.byteLength);
    combined.set(existing);
    combined.set(value, existing.byteLength);
    await write(compute, module, permissions, path, combined);
}

async function openFile(
    compute: HostCompute,
    module: ComputeModule,
    permissions: Parameters<HostCompute["fs"]["writeFile"]>[0],
    virtualPath: string,
    mode: string,
): Promise<MontyFileHandle> {
    const handle = new MontyFileHandle(virtualPath, mode);
    const path = module.resolvePath(compute, virtualPath);
    const action = handle.mode[0];
    if (action === "r") {
        const metadata = await compute.fs.stat(permissions, path);
        if (metadata.isDirectory) {
            throw pythonError("IsADirectoryError", `Is a directory: '${path}'`);
        }
    } else if (action === "w") {
        await write(compute, module, permissions, path, handle.binary ? new Uint8Array() : "");
    } else if (action === "a") {
        if (await compute.fs.exists(permissions, path)) {
            const metadata = await compute.fs.stat(permissions, path);
            if (metadata.isDirectory) {
                throw pythonError("IsADirectoryError", `Is a directory: '${path}'`);
            }
        } else {
            await write(compute, module, permissions, path, handle.binary ? new Uint8Array() : "");
        }
    }
    return handle;
}

async function makeDirectory(
    compute: HostCompute,
    module: ComputeModule,
    permissions: Parameters<HostCompute["fs"]["mkdir"]>[0],
    path: string,
    parents: boolean,
    existOk: boolean,
): Promise<void> {
    if (await compute.fs.exists(permissions, path)) {
        const metadata = await compute.fs.lstat(permissions, path);
        if (existOk && metadata.isDirectory) return;
        throw pythonError("FileExistsError", `File exists: '${path}'`);
    }
    if (!parents) await assertDirectory(compute, permissions, module.parentPath(path));
    await compute.fs.mkdir(permissions, path, { recursive: parents });
}

async function renamePath(
    compute: HostCompute,
    module: ComputeModule,
    permissions: Parameters<HostCompute["fs"]["move"]>[0],
    source: string,
    destination: string,
): Promise<void> {
    await compute.fs.lstat(permissions, source);
    await assertDirectory(compute, permissions, module.parentPath(destination));
    await compute.fs.move(permissions, source, destination);
}

async function unlinkPath(
    compute: HostCompute,
    permissions: Parameters<HostCompute["fs"]["rm"]>[0],
    path: string,
): Promise<void> {
    const metadata = await compute.fs.lstat(permissions, path);
    if (metadata.isDirectory) {
        throw pythonError("IsADirectoryError", `Is a directory: '${path}'`);
    }
    await compute.fs.rm(permissions, path, { force: false, recursive: false });
}

async function listDirectory(
    compute: HostCompute,
    permissions: Parameters<HostCompute["fs"]["readdirPage"]>[0],
    path: string,
): Promise<readonly string[]> {
    await assertDirectory(compute, permissions, path);
    const entries: string[] = [];
    let after: string | undefined;
    for (;;) {
        const page = await compute.fs.readdirPage(permissions, path, {
            ...(after === undefined ? {} : { after }),
            limit: DIRECTORY_PAGE_SIZE,
        });
        for (const name of page.entries) {
            if (entries.length >= MAX_CODE_MODE_DIRECTORY_ENTRIES) {
                throw pythonError(
                    "MemoryError",
                    `Directory has more than ${String(MAX_CODE_MODE_DIRECTORY_ENTRIES)} entries: ${path}`,
                );
            }
            entries.push(childPath(path, name));
        }
        after = page.entries.at(-1);
        if (!page.hasMore || after === undefined) return entries;
    }
}

async function assertFileDestination(
    compute: HostCompute,
    module: ComputeModule,
    permissions: Parameters<HostCompute["fs"]["writeFile"]>[0],
    path: string,
): Promise<void> {
    if (await compute.fs.exists(permissions, path)) {
        const metadata = await compute.fs.lstat(permissions, path);
        if (metadata.isDirectory) {
            throw pythonError("IsADirectoryError", `Is a directory: '${path}'`);
        }
        return;
    }
    await assertDirectory(compute, permissions, module.parentPath(path));
}

async function assertDirectory(
    compute: HostCompute,
    permissions: Parameters<HostCompute["fs"]["stat"]>[0],
    path: string,
): Promise<void> {
    const metadata = await compute.fs.stat(permissions, path);
    if (!metadata.isDirectory) {
        throw pythonError("NotADirectoryError", `Not a directory: '${path}'`);
    }
}

async function statOrUndefined(
    compute: HostCompute,
    permissions: Parameters<HostCompute["fs"]["stat"]>[0],
    path: string,
): Promise<ComputeFileStat | undefined> {
    try {
        return await compute.fs.stat(permissions, path);
    } catch (error) {
        if (isMissingError(error)) return undefined;
        throw error;
    }
}

async function lstatOrUndefined(
    compute: HostCompute,
    permissions: Parameters<HostCompute["fs"]["lstat"]>[0],
    path: string,
): Promise<ComputeFileStat | undefined> {
    try {
        return await compute.fs.lstat(permissions, path);
    } catch (error) {
        if (isMissingError(error)) return undefined;
        throw error;
    }
}

function statResult(metadata: ComputeFileStat): MontyStatResult {
    const permissions = metadata.mode ?? (metadata.isDirectory ? 0o755 : 0o644);
    const type = metadata.isSymbolicLink ? 0o120_000 : metadata.isDirectory ? 0o040_000 : 0o100_000;
    const mtime = metadata.mtimeMs / 1_000;
    return {
        __monty_type__: "Dataclass",
        name: "stat_result",
        typeId: STAT_RESULT_TYPE_ID,
        fieldNames: STAT_RESULT_FIELDS,
        fields: {
            st_mode: type | permissions,
            st_ino: 0,
            st_dev: 0,
            st_nlink: metadata.isDirectory ? 2 : 1,
            st_uid: 0,
            st_gid: 0,
            st_size: metadata.isDirectory ? 4_096 : metadata.size,
            st_atime: mtime,
            st_mtime: mtime,
            st_ctime: mtime,
        },
        frozen: true,
    };
}

function requireString(value: unknown, label: string): string {
    if (typeof value === "string") return value;
    throw pythonError("TypeError", `Expected ${label} to be a string.`);
}

function requireBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    throw pythonError("TypeError", "Expected binary file contents to be bytes.");
}

function assertBounded(value: string | Uint8Array): void {
    const bytes =
        typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
    if (bytes > MAX_CODE_MODE_FILE_BYTES) {
        throw pythonError(
            "MemoryError",
            `Code Mode files are limited to ${String(MAX_CODE_MODE_FILE_BYTES)} bytes per operation.`,
        );
    }
}

function unicodeLength(value: string): number {
    return [...value].length;
}

function childPath(directory: string, name: string): string {
    const separator = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
    return directory.endsWith(separator)
        ? `${directory}${name}`
        : `${directory}${separator}${name}`;
}

function asPythonFileError(error: unknown): Error {
    if (error instanceof Error && isPythonExceptionName(error.name)) return error;
    const code =
        error instanceof Error && "code" in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT" || isMissingMessage(message)) {
        return pythonError("FileNotFoundError", message);
    }
    if (code === "ENOTDIR") return pythonError("NotADirectoryError", message);
    if (code === "EEXIST") return pythonError("FileExistsError", message);
    if (code === "EISDIR") return pythonError("IsADirectoryError", message);
    if (code === "ENOTEMPTY") return pythonError("OSError", message);
    if (/exceeds \d+ bytes/iu.test(message)) return pythonError("MemoryError", message);
    if (
        code === "EACCES" ||
        code === "EPERM" ||
        /permission boundary|read-only mode|file changes are disabled|workspace write mode cannot|blocks (?:modifying|reading)/iu.test(
            message,
        )
    ) {
        return pythonError("PermissionError", message);
    }
    return pythonError("RuntimeError", message);
}

function isMissingError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" || isMissingMessage(error.message);
}

function isMissingMessage(message: string): boolean {
    return /no such (?:file|path|directory)|cannot find the (?:file|path)/iu.test(message);
}

function pythonError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

function isPythonExceptionName(name: string): boolean {
    return PYTHON_EXCEPTION_NAMES.has(name);
}
