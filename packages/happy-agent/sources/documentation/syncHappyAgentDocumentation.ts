import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export interface HappyAgentDocumentationFile {
    readonly contents: string | Uint8Array;
    readonly relativePath: string;
}

/** Atomically synchronize one release's documentation into its managed Happy-home directory. */
export async function syncHappyAgentDocumentation(
    happyHome: string,
    files: readonly HappyAgentDocumentationFile[],
): Promise<void> {
    if (files.length === 0) throw new Error("The packaged Happy Agent documentation is empty.");
    const docsHome = join(happyHome, "docs");
    await mkdir(happyHome, { recursive: true });
    await ensureSafeDirectory(docsHome);

    for (const file of files) {
        const relativePath = validateRelativePath(file.relativePath);
        const target = join(docsHome, relativePath);
        if (escapes(docsHome, target)) {
            throw new Error(
                `Happy Agent documentation path escapes its directory: ${relativePath}`,
            );
        }
        await ensureSafeDirectory(dirname(target), docsHome);
        await replaceFile(target, file.contents);
    }
}

function validateRelativePath(path: string): string {
    const normalized = normalize(path);
    if (
        path.length === 0 ||
        isAbsolute(path) ||
        normalized === ".." ||
        normalized.startsWith(`..${sep}`)
    ) {
        throw new Error(`Invalid Happy Agent documentation path: ${path}`);
    }
    return normalized;
}

async function ensureSafeDirectory(path: string, root: string = path): Promise<void> {
    if (escapes(root, path)) {
        throw new Error(`Happy Agent documentation directory escapes its root: ${path}`);
    }
    await createAndVerifyDirectory(root);
    const nested = relative(root, path);
    if (nested.length === 0) return;
    let current = root;
    for (const part of nested.split(sep)) {
        current = join(current, part);
        await createAndVerifyDirectory(current);
    }
}

async function createAndVerifyDirectory(path: string): Promise<void> {
    try {
        await mkdir(path, { mode: 0o755 });
    } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
    }
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error(`Happy Agent documentation directory is unsafe: ${path}`);
    }
    await chmod(path, 0o755);
}

async function replaceFile(path: string, contents: string | Uint8Array): Promise<void> {
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o444 });
        await chmod(temporary, 0o444);
        await rename(temporary, path);
        await chmod(path, 0o444);
    } finally {
        await rm(temporary, { force: true });
    }
}

function escapes(root: string, target: string): boolean {
    const path = relative(root, target);
    return path === ".." || path.startsWith(`..${sep}`);
}

function isAlreadyExistsError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
