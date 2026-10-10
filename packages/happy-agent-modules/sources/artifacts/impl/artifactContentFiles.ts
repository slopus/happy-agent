import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

import { ArtifactInputError, ArtifactTooLargeError } from "../Artifact.js";
import { formatBytes } from "../ArtifactTypes.js";

/** Bytes as they arrive: all at once, or as a stream such as a request body. */
export type ArtifactContentSource = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/**
 * Write one upload's bytes into its own new file, measuring, hashing, and checking them for UTF-8
 * on the way.
 *
 * The file is synced before this returns, so the digest a caller records next names bytes that
 * are really on disk. Anything past `maxBytes` is refused before it is written. A refused upload
 * leaves its partial file for the caller to remove.
 */
export async function receiveArtifactContent(
    path: string,
    source: ArtifactContentSource,
    maxBytes: number,
): Promise<{ readonly size: number; readonly sha256: string; readonly utf8: boolean }> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let utf8 = true;
    let size = 0;
    try {
        for await (const chunk of chunksOf(source)) {
            size += chunk.byteLength;
            if (size > maxBytes) {
                throw new ArtifactTooLargeError(
                    `An artifact file may be at most ${formatBytes(maxBytes)}.`,
                );
            }
            if (utf8) utf8 = decodesAsUtf8(decoder, chunk, true);
            hash.update(chunk);
            await file.write(chunk);
        }
        if (utf8) utf8 = decodesAsUtf8(decoder, new Uint8Array(0), false);
        if (size === 0) throw new ArtifactInputError("An artifact file cannot be empty.");
        await file.sync();
    } finally {
        await file.close();
    }
    return { size, sha256: hash.digest("hex"), utf8 };
}

/**
 * Keep a received file as the stored content for its digest. Stored content never changes, so
 * when the digest is already stored the existing copy wins and the received one is dropped.
 */
export async function storeArtifactContent(uploadPath: string, contentPath: string): Promise<void> {
    if (await artifactFileExists(contentPath)) {
        await removeArtifactFile(uploadPath);
        return;
    }
    await mkdir(dirname(contentPath), { recursive: true, mode: 0o700 });
    await rename(uploadPath, contentPath);
}

export async function artifactFileExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** At most `maxBytes` of a stored file, starting `offset` bytes in. */
export async function readArtifactContent(
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

export async function removeArtifactFile(path: string): Promise<void> {
    await rm(path, { force: true });
}

async function* chunksOf(source: ArtifactContentSource): AsyncIterable<Uint8Array> {
    if (source instanceof Uint8Array) {
        yield source;
        return;
    }
    for await (const chunk of source) yield chunk;
}

function decodesAsUtf8(decoder: TextDecoder, chunk: Uint8Array, stream: boolean): boolean {
    try {
        decoder.decode(chunk, { stream });
        return true;
    } catch {
        return false;
    }
}
