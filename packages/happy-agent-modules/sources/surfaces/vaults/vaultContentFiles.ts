import { createHash, type Hash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

/** Text the content index and grep cover: valid UTF-8 without NUL, at most 1 MiB. */
export const MAX_SEARCHABLE_BYTES = 1024 * 1024;

/**
 * One new private file written front to back, measured, hashed, and checked for UTF-8 on the
 * way. `finish` syncs it, so a digest recorded next names bytes that are on disk.
 */
export class ContentWriter {
    readonly #file: FileHandle;
    readonly #hash: Hash = createHash("sha256");
    readonly #decoder = new TextDecoder("utf-8", { fatal: true });
    #size = 0;
    #utf8 = true;
    private constructor(
        readonly path: string,
        file: FileHandle,
    ) {
        this.#file = file;
    }
    static async create(path: string): Promise<ContentWriter> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        return new ContentWriter(path, await open(path, "wx", 0o600));
    }
    get size(): number {
        return this.#size;
    }
    async write(chunk: Uint8Array): Promise<void> {
        if (chunk.byteLength === 0) return;
        this.#size += chunk.byteLength;
        if (this.#utf8) this.#utf8 = decodes(this.#decoder, chunk, true);
        this.#hash.update(chunk);
        let written = 0;
        while (written < chunk.byteLength) {
            const { bytesWritten } = await this.#file.write(chunk, written);
            written += bytesWritten;
        }
    }
    async finish(): Promise<{ size: number; sha256: string; utf8: boolean }> {
        if (this.#utf8) this.#utf8 = decodes(this.#decoder, new Uint8Array(0), false);
        try {
            await this.#file.sync();
        } finally {
            await this.#file.close();
        }
        return { size: this.#size, sha256: this.#hash.digest("hex"), utf8: this.#utf8 };
    }
    async abort(): Promise<void> {
        await this.#file.close().catch(() => undefined);
        await rm(this.path, { force: true });
    }
}

/**
 * Keep a written file as the stored content for its digest. Stored content never changes, so
 * when the digest is already stored the existing copy wins and the new one is dropped.
 */
export async function storeContent(writtenPath: string, contentPath: string): Promise<void> {
    if (await fileExists(contentPath)) {
        await rm(writtenPath, { force: true });
        return;
    }
    await mkdir(dirname(contentPath), { recursive: true, mode: 0o700 });
    await rename(writtenPath, contentPath);
}

export async function fileExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** At most `maxBytes` of a stored file, starting `offset` bytes in. */
export async function readContent(
    path: string,
    offset: number,
    maxBytes: number,
): Promise<Uint8Array> {
    const file = await open(path, "r");
    try {
        const buffer = Buffer.alloc(maxBytes);
        let length = 0;
        while (length < maxBytes) {
            const { bytesRead } = await file.read(
                buffer,
                length,
                maxBytes - length,
                offset + length,
            );
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        return new Uint8Array(buffer.subarray(0, length));
    } finally {
        await file.close();
    }
}

/** A stored file's text when content search covers it, otherwise undefined. */
export async function searchableText(path: string, size: number): Promise<string | undefined> {
    if (size > MAX_SEARCHABLE_BYTES) return undefined;
    return searchableTextOf(await readFile(path));
}

export function searchableTextOf(bytes: Uint8Array): string | undefined {
    if (bytes.byteLength > MAX_SEARCHABLE_BYTES || bytes.includes(0)) return undefined;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
}

export async function removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
}

function decodes(decoder: TextDecoder, chunk: Uint8Array, stream: boolean): boolean {
    try {
        decoder.decode(chunk, { stream });
        return true;
    } catch {
        return false;
    }
}
