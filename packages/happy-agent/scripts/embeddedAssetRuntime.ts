import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export interface EmbeddedFile {
    contents?: string | Uint8Array;
    executable?: boolean;
    relativePath: string;
    source?: string;
}

const materializedRoots = new Map<string, string>();

/**
 * Materializes Bun-embedded files when a native loader or executable needs an ordinary path.
 *
 * The cache key includes every file's bytes and layout. Native package-relative lookups therefore
 * keep working, while multiple Happy Agent binaries can safely share immutable extracted assets.
 */
export function materializeEmbeddedFiles(name: string, files: readonly EmbeddedFile[]): string {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
        throw new Error(`Invalid embedded asset name: ${name}`);
    }
    if (files.length === 0) {
        throw new Error(`Embedded asset group ${name} has no files.`);
    }

    const assets = files.map((file) => ({
        ...file,
        contents:
            file.contents === undefined
                ? readFileSync(requiredSource(file))
                : Buffer.from(file.contents),
        relativePath: validateRelativePath(file.relativePath),
    }));
    const hash = createHash("sha256");
    for (const asset of [...assets].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
    )) {
        hash.update(asset.relativePath);
        hash.update("\0");
        hash.update(asset.executable === true ? "x" : "-");
        hash.update("\0");
        hash.update(asset.contents);
    }
    const identity = `${name}-${hash.digest("hex").slice(0, 24)}`;
    const cached = materializedRoots.get(identity);
    if (cached !== undefined) return cached;

    const userId = typeof process.getuid === "function" ? process.getuid() : 0;
    const userRoot = join(tmpdir(), `happy-agent-${userId}`);
    ensureOwnedDirectory(userRoot);
    const cacheRoot = join(userRoot, "binary-assets");
    ensureOwnedDirectory(cacheRoot);
    const groupRoot = join(cacheRoot, identity);
    ensureOwnedDirectory(groupRoot);

    for (const asset of assets) {
        const target = join(groupRoot, asset.relativePath);
        if (relative(groupRoot, target).startsWith(`..${sep}`)) {
            throw new Error(`Embedded asset escapes its group: ${asset.relativePath}`);
        }
        ensureDirectoryTree(groupRoot, dirname(target));
        materializeFile(target, asset.contents, asset.executable === true);
    }

    materializedRoots.set(identity, groupRoot);
    return groupRoot;
}

function requiredSource(file: EmbeddedFile): string {
    if (file.source !== undefined) return file.source;
    throw new Error(`Embedded asset ${file.relativePath} has no source or contents.`);
}

function validateRelativePath(path: string): string {
    const normalized = normalize(path);
    if (
        path.length === 0 ||
        isAbsolute(path) ||
        normalized === ".." ||
        normalized.startsWith(`..${sep}`)
    ) {
        throw new Error(`Invalid embedded asset path: ${path}`);
    }
    return normalized;
}

function ensureOwnedDirectory(path: string): void {
    try {
        mkdirSync(path, { mode: 0o700 });
    } catch (error) {
        if (!isDestinationExistsError(error)) throw error;
    }
    const status = lstatSync(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error(`Embedded asset directory is unsafe: ${path}`);
    }
    if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
        throw new Error(`Embedded asset directory has a different owner: ${path}`);
    }
    chmodSync(path, 0o700);
}

function ensureDirectoryTree(root: string, target: string): void {
    const path = relative(root, target);
    if (path === "") return;
    if (path === ".." || path.startsWith(`..${sep}`)) {
        throw new Error(`Embedded asset directory escapes its group: ${target}`);
    }
    let current = root;
    for (const part of path.split(sep)) {
        current = join(current, part);
        ensureOwnedDirectory(current);
    }
}

function materializeFile(path: string, contents: Buffer, executable: boolean): void {
    try {
        assertExistingFile(path, contents, executable);
        return;
    } catch (error) {
        if (!isMissingFileError(error)) throw error;
    }

    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        writeFileSync(temporary, contents, { flag: "wx", mode: executable ? 0o700 : 0o600 });
        chmodSync(temporary, executable ? 0o700 : 0o600);
        try {
            linkSync(temporary, path);
        } catch (error) {
            if (!isDestinationExistsError(error)) throw error;
        }
    } finally {
        rmSync(temporary, { force: true });
    }
    assertExistingFile(path, contents, executable);
}

function assertExistingFile(path: string, contents: Buffer, executable: boolean): void {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`Embedded asset path is unsafe: ${path}`);
    }
    if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
        throw new Error(`Embedded asset has a different owner: ${path}`);
    }
    if (!readFileSync(path).equals(contents)) {
        throw new Error(`Embedded asset cache contents do not match: ${path}`);
    }
    chmodSync(path, executable ? 0o700 : 0o600);
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isDestinationExistsError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
