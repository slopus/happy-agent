import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";

/** One record of a zip being written: a stored file, or a folder record ending in `/`. */
export type ZipItem =
    | {
          readonly kind: "file";
          readonly name: string;
          readonly contentPath: string;
          readonly size: number;
          readonly modifiedAt: number;
      }
    | { readonly kind: "folder"; readonly name: string; readonly modifiedAt: number };

const MAX32 = 0xffffffff;

/**
 * Stream a zip of stored (uncompressed) records with UTF-8 names. Sizes and checksums follow
 * each file in a data descriptor, so nothing is read twice, and ZIP64 records appear wherever a
 * size, offset, or count needs them. A file whose stored bytes differ in length from `size`
 * fails the stream rather than producing a corrupt archive.
 */
export async function* writeZip(items: Iterable<ZipItem>): AsyncGenerator<Buffer> {
    let offset = 0;
    const central: Buffer[] = [];
    let count = 0;
    for (const item of items) {
        const name = Buffer.from(item.kind === "folder" ? `${item.name}/` : item.name, "utf8");
        const size = item.kind === "file" ? item.size : 0;
        const zip64 = size >= MAX32;
        const local = Buffer.alloc(30);
        const { time, date } = dosTime(item.modifiedAt);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(zip64 ? 45 : 20, 4);
        local.writeUInt16LE(0x0808, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(zip64 ? MAX32 : 0, 18);
        local.writeUInt32LE(zip64 ? MAX32 : 0, 22);
        local.writeUInt16LE(name.length, 26);
        const localExtra = zip64 ? zip64Extra([0, 0]) : Buffer.alloc(0);
        local.writeUInt16LE(localExtra.length, 28);
        const headerOffset = offset;
        yield Buffer.concat([local, name, localExtra]);
        offset += 30 + name.length + localExtra.length;
        let checksum = 0;
        let written = 0;
        if (item.kind === "file") {
            for await (const chunk of createReadStream(item.contentPath, {
                highWaterMark: 1024 * 1024,
            })) {
                const bytes = chunk as Buffer;
                checksum = crc32(bytes, checksum);
                written += bytes.length;
                yield bytes;
            }
            if (written !== size) throw new Error("A vault file's stored content changed size.");
        }
        offset += written;
        const descriptor = Buffer.alloc(zip64 ? 24 : 16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(checksum >>> 0, 4);
        if (zip64) {
            descriptor.writeBigUInt64LE(BigInt(size), 8);
            descriptor.writeBigUInt64LE(BigInt(size), 16);
        } else {
            descriptor.writeUInt32LE(size, 8);
            descriptor.writeUInt32LE(size, 12);
        }
        yield descriptor;
        offset += descriptor.length;

        const wide = [
            ...(zip64 ? [size, size] : []),
            ...(headerOffset >= MAX32 ? [headerOffset] : []),
        ];
        const extra = wide.length === 0 ? Buffer.alloc(0) : zip64Extra(wide);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE((3 << 8) | 45, 4);
        record.writeUInt16LE(wide.length === 0 ? 20 : 45, 6);
        record.writeUInt16LE(0x0808, 8);
        record.writeUInt16LE(0, 10);
        record.writeUInt16LE(time, 12);
        record.writeUInt16LE(date, 14);
        record.writeUInt32LE(checksum >>> 0, 16);
        record.writeUInt32LE(zip64 ? MAX32 : size, 20);
        record.writeUInt32LE(zip64 ? MAX32 : size, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt16LE(extra.length, 30);
        record.writeUInt16LE(0, 32);
        record.writeUInt16LE(0, 34);
        record.writeUInt16LE(0, 36);
        record.writeUInt32LE(
            item.kind === "folder" ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0,
            38,
        );
        record.writeUInt32LE(Math.min(headerOffset, MAX32), 42);
        central.push(record, name, extra);
        count += 1;
    }
    const directoryOffset = offset;
    const directory = Buffer.concat(central);
    yield directory;
    offset += directory.length;
    const needs64 = count >= 0xffff || directoryOffset >= MAX32 || directory.length >= MAX32;
    if (needs64) {
        const record = Buffer.alloc(56);
        record.writeUInt32LE(0x06064b50, 0);
        record.writeBigUInt64LE(44n, 4);
        record.writeUInt16LE((3 << 8) | 45, 12);
        record.writeUInt16LE(45, 14);
        record.writeUInt32LE(0, 16);
        record.writeUInt32LE(0, 20);
        record.writeBigUInt64LE(BigInt(count), 24);
        record.writeBigUInt64LE(BigInt(count), 32);
        record.writeBigUInt64LE(BigInt(directory.length), 40);
        record.writeBigUInt64LE(BigInt(directoryOffset), 48);
        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(0x07064b50, 0);
        locator.writeUInt32LE(0, 4);
        locator.writeBigUInt64LE(BigInt(offset), 8);
        locator.writeUInt32LE(1, 16);
        yield Buffer.concat([record, locator]);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(needs64 ? 0xffff : count, 8);
    end.writeUInt16LE(needs64 ? 0xffff : count, 10);
    end.writeUInt32LE(needs64 ? MAX32 : directory.length, 12);
    end.writeUInt32LE(needs64 ? MAX32 : directoryOffset, 16);
    yield end;
}

function zip64Extra(values: readonly number[]): Buffer {
    const extra = Buffer.alloc(4 + values.length * 8);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(values.length * 8, 2);
    values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
    return extra;
}

/** MS-DOS local time, which zip records keep; clamped to its 1980–2107 range. */
function dosTime(at: number): { time: number; date: number } {
    const moment = new Date(at);
    const year = Math.min(Math.max(moment.getFullYear(), 1980), 2107);
    return {
        time:
            (moment.getHours() << 11) |
            (moment.getMinutes() << 5) |
            Math.floor(moment.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((moment.getMonth() + 1) << 5) | moment.getDate(),
    };
}
