import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
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
        // Windows cannot atomically replace a file while its read-only attribute is set.
        // Use a verified file handle so changing that attribute cannot follow a replaced link.
        const previous =
            process.platform === "win32" ? await openExistingDocument(path) : undefined;
        const identity = await previous?.stat();
        if (previous) {
            try {
                await previous.chmod(0o644);
            } finally {
                // Windows rejects replacement while this handle is open.
                await previous.close();
            }
        }
        try {
            await rename(temporary, path);
        } catch (error) {
            if (identity) {
                const retained = await openExistingDocument(path);
                if (retained) {
                    try {
                        const current = await retained.stat();
                        if (current.dev === identity.dev && current.ino === identity.ino) {
                            await retained.chmod(0o444);
                        }
                    } finally {
                        await retained.close();
                    }
                }
            }
            throw error;
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

async function openExistingDocument(path: string) {
    const status = await lstat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    });
    if (!status) return undefined;
    if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`Happy Agent documentation file is unsafe: ${path}`);
    }
    const handle = await open(path, "r");
    try {
        const opened = await handle.stat();
        if (opened.dev !== status.dev || opened.ino !== status.ino || !opened.isFile()) {
            throw new Error(`Happy Agent documentation file changed while opening: ${path}`);
        }
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

function escapes(root: string, target: string): boolean {
    const path = relative(root, target);
    return path === ".." || path.startsWith(`..${sep}`);
}

function isAlreadyExistsError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
