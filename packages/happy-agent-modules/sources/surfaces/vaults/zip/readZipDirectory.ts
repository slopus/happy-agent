import type { FileHandle } from "node:fs/promises";

import { SurfaceError } from "../../SurfaceError.js";

/** One record of a zip's central directory, as far as reading a bundle needs it. */
export interface ZipRecord {
    readonly name: string;
    readonly method: number;
    readonly encrypted: boolean;
    readonly symlink: boolean;
    readonly crc32: number;
    readonly compressedSize: number;
    readonly size: number;
    readonly localHeaderOffset: number;
}

/** Bundles hold at most 256 files; the rest is room for folders and macOS metadata. */
const MAX_RECORDS = 4_096;
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;

/**
 * Read a zip's central directory, ZIP64 included. Only the directory describes symbolic links
 * and every record, so a bundle is judged from it before any content is read.
 */
export async function readZipDirectory(file: FileHandle, fileSize: number): Promise<ZipRecord[]> {
    const tailLength = Math.min(fileSize, 22 + 0xffff);
    const tail = await readAt(file, fileSize - tailLength, tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
        if (tail.readUInt32LE(index) === EOCD) {
            eocd = index;
            break;
        }
    }
    if (eocd < 0) throw refused("The file is not a zip, which a .artifact file is.");
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    const eocdOffset = fileSize - tailLength + eocd;
    if (eocdOffset >= 20) {
        const locator = await readAt(file, eocdOffset - 20, 20);
        if (locator.readUInt32LE(0) === ZIP64_LOCATOR) {
            const record = await readAt(file, safeNumber(locator.readBigUInt64LE(8)), 56);
            if (record.readUInt32LE(0) !== ZIP64_EOCD) throw refused("The zip file is damaged.");
            count = safeNumber(record.readBigUInt64LE(32));
            directorySize = safeNumber(record.readBigUInt64LE(40));
            directoryOffset = safeNumber(record.readBigUInt64LE(48));
        }
    }
    if (count > MAX_RECORDS || directorySize > MAX_DIRECTORY_BYTES)
        throw refused("The zip file holds too many files to be an artifact.");
    if (directoryOffset + directorySize > fileSize) throw refused("The zip file is damaged.");
    const directory = await readAt(file, directoryOffset, directorySize);
    const records: ZipRecord[] = [];
    let at = 0;
    for (let index = 0; index < count; index += 1) {
        if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL)
            throw refused("The zip file is damaged.");
        const madeBy = directory.readUInt16LE(at + 4);
        const flags = directory.readUInt16LE(at + 8);
        const method = directory.readUInt16LE(at + 10);
        const crc32 = directory.readUInt32LE(at + 16);
        let compressedSize = directory.readUInt32LE(at + 20);
        let size = directory.readUInt32LE(at + 24);
        const nameLength = directory.readUInt16LE(at + 28);
        const extraLength = directory.readUInt16LE(at + 30);
        const commentLength = directory.readUInt16LE(at + 32);
        const external = directory.readUInt32LE(at + 38);
        let localHeaderOffset = directory.readUInt32LE(at + 42);
        const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
        const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
        // ZIP64 sizes and offsets replace exactly the fields that are all ones, in this order.
        for (let offset = 0; offset + 4 <= extra.length; ) {
            const id = extra.readUInt16LE(offset);
            const length = extra.readUInt16LE(offset + 2);
            if (id === 0x0001) {
                let field = offset + 4;
                const next = () => {
                    if (field + 8 > offset + 4 + length) throw refused("The zip file is damaged.");
                    const value = safeNumber(extra.readBigUInt64LE(field));
                    field += 8;
                    return value;
                };
                if (size === 0xffffffff) size = next();
                if (compressedSize === 0xffffffff) compressedSize = next();
                if (localHeaderOffset === 0xffffffff) localHeaderOffset = next();
            }
            offset += 4 + length;
        }
        let name: string;
        try {
            name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
        } catch {
            throw refused("The zip file names a file in an encoding other than UTF-8.");
        }
        const unix = madeBy >> 8 === 3;
        records.push({
            name,
            method,
            encrypted: (flags & 1) !== 0,
            symlink: unix && ((external >>> 16) & 0o170000) === 0o120000,
            crc32,
            compressedSize,
            size,
            localHeaderOffset,
        });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return records;
}

export async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
        const { bytesRead } = await file.read(buffer, read, length - read, position + read);
        if (bytesRead === 0) throw refused("The zip file is damaged.");
        read += bytesRead;
    }
    return buffer;
}

function safeNumber(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw refused("The zip file is damaged.");
    return Number(value);
}

export function refused(message: string): SurfaceError {
    return new SurfaceError("invalid_request", message);
}
