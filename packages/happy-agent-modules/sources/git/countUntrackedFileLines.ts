import { lstat, open } from "node:fs/promises";

import { Type, type Static } from "@sinclair/typebox";

const BINARY_SNIFF_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export const untrackedFileCountSchema = Type.Object(
    {
        binary: Type.Boolean(),
        insertions: Type.Optional(Type.Integer({ minimum: 0 })),
        inexact: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type UntrackedFileCount = Static<typeof untrackedFileCountSchema>;

export async function countUntrackedFileLines(
    path: string,
    maximumBytes: number,
): Promise<UntrackedFileCount> {
    try {
        const link = await lstat(path);
        if (link.isSymbolicLink()) return { binary: false, inexact: false, insertions: 1 };
    } catch {
        return { binary: false, inexact: true };
    }
    let handle;
    try {
        handle = await open(path, "r");
    } catch {
        return { binary: false, inexact: true };
    }
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > maximumBytes) return { binary: false, inexact: true };
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let inspected = 0;
        let lines = 0;
        let lastByte: number | undefined;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, null);
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            if (inspected < BINARY_SNIFF_BYTES) {
                const window = chunk.subarray(0, BINARY_SNIFF_BYTES - inspected);
                if (window.includes(0)) return { binary: true, inexact: false };
            }
            inspected += bytesRead;
            for (let index = 0; index < bytesRead; index += 1) {
                if (chunk[index] === 0x0a) lines += 1;
            }
            lastByte = chunk[bytesRead - 1];
        }
        if (lastByte !== undefined && lastByte !== 0x0a) lines += 1;
        return { binary: false, inexact: false, insertions: lines };
    } catch {
        return { binary: false, inexact: true };
    } finally {
        await handle.close().catch(() => undefined);
    }
}

/**
 * The same count over bytes already read, for a file read whole from another machine. `bytes`
 * must be the entire file.
 */
export function countLinesInBytes(bytes: Uint8Array): UntrackedFileCount {
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { binary: true, inexact: false };
    let lines = 0;
    for (const byte of bytes) if (byte === 0x0a) lines += 1;
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) lines += 1;
    return { binary: false, inexact: false, insertions: lines };
}
