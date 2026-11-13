import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Create the empty private file an upload's bytes accumulate in. */
export async function createUploadFile(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    await file.close();
}

/**
 * Write one request's body at `start` and make it durable. Answers how many bytes the body held,
 * reading at most one byte past `length` to tell a longer body apart. Writes land at their own
 * offsets, so requests for other ranges of the same file may run at the same time; a body of the
 * wrong length leaves bytes that nothing counts and a later chunk overwrites.
 */
export async function writeUploadChunk(
    path: string,
    start: number,
    length: number,
    body: AsyncIterable<Uint8Array>,
): Promise<number> {
    const file = await open(path, "r+");
    let written = 0;
    try {
        for await (const chunk of body) {
            if (written + chunk.byteLength > length) {
                written += chunk.byteLength;
                break;
            }
            let offset = 0;
            while (offset < chunk.byteLength) {
                const { bytesWritten } = await file.write(
                    chunk,
                    offset,
                    chunk.byteLength - offset,
                    start + written + offset,
                );
                offset += bytesWritten;
            }
            written += chunk.byteLength;
        }
        if (written === length) await file.sync();
    } finally {
        await file.close();
    }
    return written;
}

/**
 * Receive a whole file into a new private file, hashing it as it arrives. Answers its digest and
 * size, or `undefined` once it passes `limit`, when the partial file is removed.
 */
export async function receiveWholeFile(
    path: string,
    limit: number,
    body: AsyncIterable<Uint8Array>,
): Promise<{ readonly sha256: string; readonly size: number } | undefined> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
        for await (const chunk of body) {
            size += chunk.byteLength;
            if (size > limit) break;
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
                const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
                offset += bytesWritten;
            }
        }
        if (size <= limit) await file.sync();
    } catch (error) {
        await file.close();
        await removeFile(path);
        throw error;
    }
    await file.close();
    if (size > limit) {
        await removeFile(path);
        return undefined;
    }
    return { sha256: hash.digest("hex"), size };
}

/**
 * Copy a finished upload's file to a new private file, sharing its blocks where the filesystem
 * can. A chunk request may still hold the upload's file open, so its bytes are only ever checked
 * and stored through such a copy, which no request writes.
 */
export async function snapshotUploadFile(path: string, snapshotPath: string): Promise<void> {
    await copyFile(path, snapshotPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

/** The SHA-256 of a whole file, read as a stream. */
export async function hashFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

/**
 * Keep a finished file as the stored content of its digest. Stored content never changes, so
 * when the digest is already stored the existing copy wins and the new file is dropped.
 */
export async function storeUploadedContent(uploadPath: string, contentPath: string): Promise<void> {
    if (await fileExists(contentPath)) {
        await removeFile(uploadPath);
        return;
    }
    await mkdir(dirname(contentPath), { recursive: true, mode: 0o700 });
    await rename(uploadPath, contentPath);
}

export async function fileExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export async function removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
}

/** Up to the first `length` bytes of a file. */
export async function readFileHead(path: string, length: number): Promise<Buffer> {
    const file = await open(path, "r");
    try {
        const bytes = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const { bytesRead } = await file.read(bytes, read, length - read, read);
            if (bytesRead === 0) break;
            read += bytesRead;
        }
        return bytes.subarray(0, read);
    } finally {
        await file.close();
    }
}
