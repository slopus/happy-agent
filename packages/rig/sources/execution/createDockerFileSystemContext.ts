import { posix } from "node:path";

import { extract as extractTar } from "tar-stream";

import type { FileSystemContext, FileSystemStat } from "../agent/context/FileSystemContext.js";
import type { PermissionContext } from "../permissions/index.js";
import { assertDockerReadPath } from "./assertDockerReadPath.js";
import { assertDockerWritePath } from "./assertDockerWritePath.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";
import { formatDockerTouchTimestamp } from "./formatDockerTouchTimestamp.js";
import { isDockerNotFoundError } from "./isDockerNotFoundError.js";
import { parseDockerPathStat } from "./parseDockerPathStat.js";
import { resolveDockerPath } from "./resolveDockerPath.js";
import { runDockerExec } from "./runDockerExec.js";

const MAX_FILE_READ_BYTES = 32 * 1024 * 1024;
// Linux NAME_MAX is 255 bytes. One extra byte carries the terminating NUL.
const MAX_DOCKER_DIRECTORY_ENTRY_BYTES = 256;

export function createDockerFileSystemContext(
    environment: DockerEnvironment,
    permissions: PermissionContext,
): FileSystemContext {
    const cwd = environment.config.workingDirectory;
    let canonicalCwd: Promise<string> | undefined;
    const resolvePath = (target: string) => {
        if (target !== posix.resolve(cwd)) return resolveDockerPath(environment, target);
        canonicalCwd ??= resolveDockerPath(environment, target).catch((error: unknown) => {
            canonicalCwd = undefined;
            throw error;
        });
        return canonicalCwd;
    };
    return {
        cwd,
        async chmod(path, mode) {
            const target = await assertDockerWritePath(
                cwd,
                path,
                permissions.mode,
                resolvePath,
                permissions.protectedPaths,
            );
            await successfulExec(environment, ["chmod", (mode & 0o7777).toString(8), target]);
        },
        async exists(path) {
            const target = assertDockerReadPath(cwd, path);
            const result = await runDockerExec(await environment.container(), [
                "/bin/sh",
                "-c",
                'test -e "$1" || test -L "$1"',
                "rig",
                target,
            ]);
            return result.exitCode === 0;
        },
        async lstat(path) {
            const target = assertDockerReadPath(cwd, path);
            const result = await runDockerExec(await environment.container(), [
                "/bin/sh",
                "-c",
                'kind=other; if [ -L "$1" ]; then kind=symlink; elif [ -d "$1" ]; then kind=directory; elif [ -f "$1" ]; then kind=file; fi; printf "%s\\n" "$kind" && stat -c "%s" -- "$1" && stat -c "%Y" -- "$1" && stat -c "%a" -- "$1"',
                "rig",
                target,
            ]);
            if (result.exitCode !== 0) throw dockerCommandError("inspect", target, result.stderr);
            return parseDockerLstat(result.stdout, target);
        },
        async lstatMany(paths) {
            if (paths.length === 0) return [];
            const targets = paths.map((path) => assertDockerReadPath(cwd, path));
            const result = await runDockerExec(
                await environment.container(),
                [
                    "/bin/sh",
                    "-c",
                    'set -e\nfor target do\nif [ ! -e "$target" ] && [ ! -L "$target" ]; then printf "missing\\n0\\n0\\n0\\n"; continue; fi\nkind=other\nif [ -L "$target" ]; then kind=symlink; elif [ -d "$target" ]; then kind=directory; elif [ -f "$target" ]; then kind=file; fi\nprintf "%s\\n" "$kind"\nstat -c "%s" -- "$target"\nstat -c "%Y" -- "$target"\nstat -c "%a" -- "$target"\ndone',
                    "rig-directory-metadata",
                    ...targets,
                ],
                { maxOutputBytes: targets.length * 128 },
            );
            if (result.exitCode !== 0) {
                throw dockerCommandError("inspect directory entries", cwd, result.stderr);
            }
            return parseDockerLstatMany(result.stdout, targets);
        },
        async mkdir(path, options) {
            const target = await assertDockerWritePath(
                cwd,
                path,
                permissions.mode,
                resolvePath,
                permissions.protectedPaths,
            );
            await successfulExec(environment, [
                "mkdir",
                ...(options?.recursive === true ? ["-p"] : []),
                "--",
                target,
            ]);
        },
        async move(source, destination) {
            const sourceTarget = await assertDockerWritePath(
                cwd,
                source,
                permissions.mode,
                resolvePath,
                permissions.protectedPaths,
            );
            const destinationTarget = await assertDockerWritePath(
                cwd,
                destination,
                permissions.mode,
                resolvePath,
                permissions.protectedPaths,
            );
            await successfulExec(environment, ["mv", "--", sourceTarget, destinationTarget]);
        },
        async realpath(path) {
            const target = assertDockerReadPath(cwd, path);
            return resolveDockerPath(environment, target);
        },
        async readFile(path) {
            return Buffer.from(await this.readFileBuffer(path)).toString("utf8");
        },
        async readFileBuffer(path, options) {
            const target = assertDockerReadPath(cwd, path);
            const maxBytes = Math.min(
                options?.maxBytes ?? MAX_FILE_READ_BYTES,
                MAX_FILE_READ_BYTES,
            );
            if (options?.noFollow === true) {
                return readDockerFileWithoutFollowing(
                    await environment.container(),
                    target,
                    maxBytes,
                );
            }
            const details = await this.stat(path);
            if (details.size > maxBytes) throw fileReadLimitError(target, maxBytes);
            const result = await runDockerExec(
                await environment.container(),
                ["cat", "--", target],
                {
                    maxOutputBytes: maxBytes + 1,
                },
            );
            if (result.exitCode !== 0) throw dockerCommandError("read", target, result.stderr);
            if (result.stdout.length > maxBytes) throw fileReadLimitError(target, maxBytes);
            return result.stdout;
        },
        async readdir(path) {
            const target = assertDockerReadPath(cwd, path);
            const result = await runDockerExec(await environment.container(), [
                "/bin/sh",
                "-c",
                'for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do { test -e "$entry" || test -L "$entry"; } || continue; printf "%s\\0" "${entry##*/}"; done',
                "rig",
                target,
            ]);
            if (result.exitCode !== 0) throw dockerCommandError("list", target, result.stderr);
            return result.stdout
                .toString("utf8")
                .split("\0")
                .filter((entry) => entry.length > 0);
        },
        async readdirPage(path, options) {
            const target = assertDockerReadPath(cwd, path);
            const capacity = options.limit + 1;
            const maxOutputBytes = capacity * MAX_DOCKER_DIRECTORY_ENTRY_BYTES;
            const result = await runDockerExec(
                await environment.container(),
                [
                    "/bin/sh",
                    "-c",
                    'set -e\nexport LC_ALL=C\ncd "$1"\nfind . -mindepth 1 -maxdepth 1 -exec /bin/sh -c \'after=$1; shift; for entry do name=${entry#./}; if [ "$name" \\> "$after" ]; then printf "%s\\\\0" "$name"; fi; done\' rig-directory-page "$2" {} + | sort -z | head -c "$3"',
                    "rig",
                    target,
                    options.after ?? "",
                    String(maxOutputBytes),
                ],
                {
                    maxOutputBytes,
                },
            );
            if (result.exitCode !== 0) throw dockerCommandError("list", target, result.stderr);
            const lastTerminator = result.stdout.lastIndexOf(0);
            const completeOutput =
                lastTerminator < 0
                    ? Buffer.alloc(0)
                    : result.stdout.subarray(0, lastTerminator + 1);
            const entries = completeOutput
                .toString("utf8")
                .split("\0")
                .filter((entry) => entry.length > 0);
            const hasMore = entries.length > options.limit;
            return { entries: entries.slice(0, options.limit), hasMore };
        },
        async rm(path, options) {
            const target = await assertDockerWritePath(
                cwd,
                path,
                permissions.mode,
                resolvePath,
                permissions.protectedPaths,
            );
            await successfulExec(environment, [
                "rm",
                ...(options?.recursive === true ? ["-r"] : []),
                ...(options?.force === true ? ["-f"] : []),
                "--",
                target,
            ]);
        },
        async setModificationTime(path, mtimeMs) {
            const target = await assertDockerWritePath(
                cwd,
                path,
                permissions.mode,
                resolvePath,
                permissions.protectedPaths,
            );
            await successfulExec(environment, [
                "env",
                "TZ=UTC0",
                "touch",
                "-m",
                "-t",
                formatDockerTouchTimestamp(mtimeMs),
                "--",
                target,
            ]);
        },
        async stat(path) {
            const target = assertDockerReadPath(cwd, path);
            const container = await environment.container();
            try {
                const response = (await container.infoArchive({
                    path: target,
                })) as NodeJS.ReadableStream & {
                    destroy?: () => void;
                    headers?: Record<string, string | string[] | undefined>;
                };
                try {
                    return parseDockerPathStat(response.headers?.["x-docker-container-path-stat"]);
                } finally {
                    response.destroy?.();
                }
            } catch (error) {
                if (isDockerNotFoundError(error)) throw dockerCommandError("inspect", target);
                throw error;
            }
        },
        async writeFile(path, content) {
            const target = await assertDockerWritePath(
                cwd,
                path,
                permissions.mode,
                resolvePath,
                permissions.protectedPaths,
            );
            const parent = posix.dirname(target);
            await successfulExec(environment, ["mkdir", "-p", "--", parent]);
            await successfulExec(environment, ["/bin/sh", "-c", 'cat > "$1"', "rig", target], {
                stdin: content,
            });
        },
    };
}

async function readDockerFileWithoutFollowing(
    container: Awaited<ReturnType<DockerEnvironment["container"]>>,
    path: string,
    maxBytes: number,
): Promise<Buffer> {
    const archive = await container.getArchive({ path });
    const destroyArchive = (error: Error) =>
        (archive as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.(error);
    const tar = extractTar();
    return new Promise<Buffer>((resolve, reject) => {
        let bytes: Buffer | undefined;
        let settled = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            destroyArchive(error);
            tar.destroy(error);
            reject(error);
        };
        archive.once("error", (error) => fail(error));
        tar.once("error", (error) => fail(error));
        tar.on("entry", (header, stream, next) => {
            if (
                bytes !== undefined ||
                header.type !== "file" ||
                (header.size ?? Number.POSITIVE_INFINITY) > maxBytes
            ) {
                stream.resume();
                fail(
                    header.type === "symlink" || header.type === "link"
                        ? new Error(`Could not read '${path}' because it is a symbolic link.`)
                        : fileReadLimitError(path, maxBytes),
                );
                return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            stream.on("data", (chunk: Buffer) => {
                length += chunk.byteLength;
                if (length > maxBytes) {
                    fail(fileReadLimitError(path, maxBytes));
                    return;
                }
                chunks.push(chunk);
            });
            stream.once("error", (error) => fail(error));
            stream.once("end", () => {
                if (settled) return;
                bytes = Buffer.concat(chunks, length);
                next();
            });
        });
        tar.once("finish", () => {
            if (settled) return;
            settled = true;
            if (bytes === undefined) {
                reject(new Error(`Could not read '${path}' because it is not a regular file.`));
                return;
            }
            resolve(bytes);
        });
        archive.pipe(tar);
    });
}

function parseDockerLstat(output: Buffer, path: string): FileSystemStat {
    const [kind, rawSize, rawMtime, rawMode, ...extra] = output
        .toString("utf8")
        .trimEnd()
        .split("\n");
    const size = Number(rawSize);
    const mtimeSeconds = Number(rawMtime);
    const mode = Number.parseInt(rawMode ?? "", 8);
    if (
        !["directory", "file", "other", "symlink"].includes(kind ?? "") ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isFinite(mtimeSeconds) ||
        !Number.isSafeInteger(mode) ||
        extra.length > 0
    ) {
        throw new Error(`Docker returned invalid link metadata for '${path}'.`);
    }
    return {
        isDirectory: kind === "directory",
        isFile: kind === "file",
        isSymbolicLink: kind === "symlink",
        mode,
        mtimeMs: mtimeSeconds * 1000,
        size,
    };
}

function parseDockerLstatMany(
    output: Buffer,
    paths: readonly string[],
): readonly (FileSystemStat | undefined)[] {
    const lines = output.toString("utf8").trimEnd().split("\n");
    if (lines.length !== paths.length * 4) {
        throw new Error("Docker returned incomplete directory-entry metadata.");
    }
    return paths.map((path, index) => {
        const record = lines.slice(index * 4, index * 4 + 4);
        return record[0] === "missing"
            ? undefined
            : parseDockerLstat(Buffer.from(record.join("\n")), path);
    });
}

function fileReadLimitError(path: string, maxBytes: number): Error {
    return new Error(
        `Could not read '${path}' in the Docker container because it exceeds ${String(maxBytes)} bytes.`,
    );
}

async function successfulExec(
    environment: DockerEnvironment,
    command: readonly string[],
    options: { stdin?: string | Uint8Array } = {},
) {
    const result = await runDockerExec(await environment.container(), command, options);
    if (result.exitCode !== 0)
        throw dockerCommandError("access", command.at(-1) ?? "path", result.stderr);
}

function dockerCommandError(action: string, path: string, stderr?: Buffer): Error {
    const detail = stderr?.toString("utf8").trim();
    return new Error(
        detail === undefined || detail.length === 0
            ? `Could not ${action} '${path}' in the Docker container.`
            : `Could not ${action} '${path}' in the Docker container: ${detail}`,
    );
}
