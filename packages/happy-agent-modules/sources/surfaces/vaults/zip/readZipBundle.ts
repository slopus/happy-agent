import { open, rm } from "node:fs/promises";
import { crc32 } from "node:zlib";

import { Inflate } from "fflate";

import { ContentWriter } from "../vaultContentFiles.js";
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES } from "../vaultBundle.js";
import { readAt, readZipDirectory, refused, type ZipRecord } from "./readZipDirectory.js";

/** One file read out of a zip into its own private file, not yet stored by digest. */
export interface ExtractedFile {
    readonly path: string;
    readonly writtenPath: string;
    readonly size: number;
    readonly sha256: string;
    readonly utf8: boolean;
}

const LOCAL = 0x04034b50;
const CHUNK = 1024 * 1024;

/**
 * Read an artifact bundle out of a zip: folder records, `__MACOSX/`, `.DS_Store`, and empty files
 * are left out, and a single top-level folder is removed when no entry page sits at the root.
 * Only stored and deflated records are read; encrypted records, symbolic links, unsafe or
 * duplicate paths, and files breaking the bundle limits as they are inflated are refused,
 * whatever the headers claim. Each file is written to `writtenPath()`; on failure every file
 * written so far is removed.
 */
export async function readZipBundle(
    zipPath: string,
    writtenPath: () => string,
): Promise<ExtractedFile[]> {
    const file = await open(zipPath, "r");
    const extracted: ExtractedFile[] = [];
    try {
        const records = selectRecords(await readZipDirectory(file, (await file.stat()).size));
        let total = 0;
        for (const { record, path } of records) {
            const header = await readAt(file, record.localHeaderOffset, 30);
            if (header.readUInt32LE(0) !== LOCAL) throw refused("The zip file is damaged.");
            let position =
                record.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
            const writer = await ContentWriter.create(writtenPath());
            try {
                let checksum = 0;
                let failure: unknown;
                const pending: Uint8Array[] = [];
                const accept = (chunk: Uint8Array) => {
                    total += chunk.byteLength;
                    if (writer.size + chunk.byteLength > record.size || total > MAX_BUNDLE_BYTES)
                        failure ??= refused(
                            total > MAX_BUNDLE_BYTES
                                ? "The zip's files hold more than the 256 MiB an artifact may hold."
                                : "The zip file is damaged: a file is larger than its header says.",
                        );
                    else pending.push(chunk);
                };
                const inflate = record.method === 8 ? new Inflate(accept) : undefined;
                let remaining = record.compressedSize;
                while (remaining > 0) {
                    const length = Math.min(CHUNK, remaining);
                    const chunk = await readAt(file, position, length);
                    position += length;
                    remaining -= length;
                    if (inflate === undefined) accept(chunk);
                    else {
                        try {
                            inflate.push(chunk, remaining === 0);
                        } catch {
                            failure ??= refused("The zip file is damaged.");
                        }
                    }
                    if (failure !== undefined) throw failure;
                    for (const piece of pending.splice(0)) {
                        checksum = crc32(piece, checksum);
                        await writer.write(piece);
                    }
                }
                if (writer.size !== record.size || checksum >>> 0 !== record.crc32 >>> 0)
                    throw refused("The zip file is damaged.");
                extracted.push({ path, writtenPath: writer.path, ...(await writer.finish()) });
            } catch (error) {
                await writer.abort();
                throw error;
            }
        }
        return extracted;
    } catch (error) {
        await Promise.all(extracted.map((done) => rm(done.writtenPath, { force: true })));
        throw error;
    } finally {
        await file.close();
    }
}

/** The records a bundle keeps, with the paths their files take, checked before any is read. */
function selectRecords(records: readonly ZipRecord[]): { record: ZipRecord; path: string }[] {
    const kept: ZipRecord[] = [];
    for (const record of records) {
        if (record.name.endsWith("/")) continue;
        if (record.name.startsWith("__MACOSX/")) continue;
        if (record.name === ".DS_Store" || record.name.endsWith("/.DS_Store")) continue;
        if (record.encrypted)
            throw refused("The zip holds an encrypted file, which cannot be read.");
        if (record.symlink)
            throw refused(`The zip holds a symbolic link, ${JSON.stringify(record.name)}.`);
        if (record.method !== 0 && record.method !== 8)
            throw refused(
                "The zip uses a compression method other than stored or deflated; zip it again with standard settings.",
            );
        if (
            record.name.startsWith("/") ||
            record.name.includes("\\") ||
            /^[A-Za-z]:/.test(record.name) ||
            record.name
                .split("/")
                .some((segment) => segment === "." || segment === ".." || segment === "")
        )
            throw refused(`The zip holds an unsafe path, ${JSON.stringify(record.name)}.`);
        if (record.size === 0) continue;
        kept.push(record);
    }
    const atRoot = kept.some(
        (record) => record.name === "index.html" || record.name === "index.md",
    );
    const tops = new Set(kept.map((record) => record.name.split("/")[0]));
    const strip =
        !atRoot && tops.size === 1 && kept.every((record) => record.name.includes("/"))
            ? `${[...tops][0]!}/`
            : "";
    const selected = kept.map((record) => ({ record, path: record.name.slice(strip.length) }));
    if (selected.length > MAX_BUNDLE_FILES)
        throw refused(`An artifact holds at most ${String(MAX_BUNDLE_FILES)} files.`);
    const seen = new Set<string>();
    for (const { path } of selected) {
        if (seen.has(path)) throw refused(`The zip holds ${JSON.stringify(path)} twice.`);
        seen.add(path);
    }
    return selected;
}
