import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { codeModePythonResultSchema } from "./MontyPython.js";

const CHECKPOINT_MAGIC = Buffer.from([0x48, 0x41, 0x50, 0x50, 0x59, 0x50, 0x59, 0x00]);
const CHECKPOINT_VERSION = 1;
const HEADER_BYTES = 18;
const MAX_WAL_RECORDS = 256;
const MAX_WAL_BYTES = 8 * 1024 * 1024;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EBADF", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/** Dump framing can exceed the interpreter heap, but persistence remains strictly bounded. */
export const MAX_CODE_MODE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_CODE_MODE_CHECKPOINT_BYTES =
    HEADER_BYTES + MAX_WAL_BYTES + MAX_CODE_MODE_SNAPSHOT_BYTES;

const codeModeCheckpointRecordSchema = Type.Object(
    { callId: cuid2Schema, result: codeModePythonResultSchema },
    { additionalProperties: false },
);
const codeModeCheckpointSchema = Type.Object(
    {
        records: Type.Array(codeModeCheckpointRecordSchema, { maxItems: MAX_WAL_RECORDS }),
        snapshot: Type.Optional(
            Type.Uint8Array({ minByteLength: 1, maxByteLength: MAX_CODE_MODE_SNAPSHOT_BYTES }),
        ),
        version: Type.Literal(CHECKPOINT_VERSION),
    },
    { additionalProperties: false },
);

export type CodeModeCheckpoint = Static<typeof codeModeCheckpointSchema>;
export type CodeModeCheckpointRecord = Static<typeof codeModeCheckpointRecordSchema>;

export class InvalidCodeModeSnapshotError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "InvalidCodeModeSnapshotError";
    }
}

/** Read and validate one versioned checkpoint without allocating beyond its fixed bound. */
export async function readCodeModeCheckpoint(
    path: string,
): Promise<CodeModeCheckpoint | undefined> {
    let file;
    try {
        file = await open(path, "r");
    } catch (error) {
        if (isFileError(error, "ENOENT")) return undefined;
        throw error;
    }
    try {
        const metadata = await file.stat();
        if (!metadata.isFile()) throw invalid("The Code Mode checkpoint is not a file.");
        if (metadata.size < HEADER_BYTES) throw invalid("The Code Mode checkpoint is truncated.");
        if (metadata.size > MAX_CODE_MODE_CHECKPOINT_BYTES) {
            throw invalid("The Code Mode checkpoint is too large.");
        }
        const bytes = Buffer.allocUnsafe(metadata.size);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
            if (bytesRead === 0) {
                throw invalid("The Code Mode checkpoint changed while it was being read.");
            }
            offset += bytesRead;
        }
        if ((await file.read(Buffer.allocUnsafe(1), 0, 1, offset)).bytesRead !== 0) {
            throw invalid("The Code Mode checkpoint changed while it was being read.");
        }
        return decodeCheckpoint(bytes);
    } finally {
        await file.close().catch(() => undefined);
    }
}

/**
 * Write a private checkpoint, fsync it, and atomically replace the prior state. The producing
 * call may commit only after this returns.
 */
export async function writeCodeModeCheckpoint(
    path: string,
    checkpoint: CodeModeCheckpoint,
): Promise<void> {
    if (!Value.Check(codeModeCheckpointSchema, checkpoint)) {
        throw invalid("Code Mode produced an invalid checkpoint.");
    }
    const records = Buffer.from(JSON.stringify(checkpoint.records), "utf8");
    const snapshot = checkpoint.snapshot;
    if (records.byteLength > MAX_WAL_BYTES) {
        throw invalid("Code Mode produced an oversized checkpoint journal.");
    }
    const snapshotBytes = snapshot?.byteLength ?? 0;
    const totalBytes = HEADER_BYTES + records.byteLength + snapshotBytes;
    if (totalBytes > MAX_CODE_MODE_CHECKPOINT_BYTES) {
        throw invalid("Code Mode produced an oversized checkpoint.");
    }

    const directory = dirname(path);
    await ensurePrivateDirectory(directory);
    const temporary = join(directory, `.snapshot-${randomUUID()}.tmp`);
    let file;
    try {
        file = await open(temporary, "wx", 0o600);
        const header = Buffer.allocUnsafe(HEADER_BYTES);
        CHECKPOINT_MAGIC.copy(header, 0);
        header.writeUInt16BE(CHECKPOINT_VERSION, 8);
        header.writeUInt32BE(records.byteLength, 10);
        header.writeUInt32BE(snapshotBytes, 14);
        await file.writeFile(header);
        await file.writeFile(records);
        if (snapshot !== undefined) await file.writeFile(snapshot);
        await file.sync();
        await file.close();
        file = undefined;
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await syncDirectory(directory);
    } finally {
        await file?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

/** Keep one diagnostic copy, replacing any older invalid checkpoint. */
export async function preserveInvalidCodeModeSnapshot(path: string): Promise<void> {
    const directory = dirname(path);
    const invalidPath = join(directory, "snapshot.invalid.bin");
    await rm(invalidPath, { force: true });
    try {
        await rename(path, invalidPath);
        await chmod(invalidPath, 0o600);
        await syncDirectory(directory);
    } catch (error) {
        if (!isFileError(error, "ENOENT")) throw error;
    }
}

function decodeCheckpoint(bytes: Buffer): CodeModeCheckpoint {
    if (!bytes.subarray(0, CHECKPOINT_MAGIC.byteLength).equals(CHECKPOINT_MAGIC)) {
        throw invalid("The Code Mode checkpoint has an unknown format.");
    }
    const version = bytes.readUInt16BE(8);
    if (version !== CHECKPOINT_VERSION) {
        throw invalid(`The Code Mode checkpoint version ${version} is not supported.`);
    }
    const recordBytes = bytes.readUInt32BE(10);
    const snapshotBytes = bytes.readUInt32BE(14);
    if (recordBytes > MAX_WAL_BYTES || snapshotBytes > MAX_CODE_MODE_SNAPSHOT_BYTES) {
        throw invalid("The Code Mode checkpoint lengths are invalid.");
    }
    const expected = HEADER_BYTES + recordBytes + snapshotBytes;
    if (expected !== bytes.byteLength) throw invalid("The Code Mode checkpoint is truncated.");

    const recordsEnd = HEADER_BYTES + recordBytes;
    let records: unknown;
    try {
        records = JSON.parse(bytes.toString("utf8", HEADER_BYTES, recordsEnd));
    } catch (error) {
        throw invalid("The Code Mode checkpoint journal is invalid.", error);
    }
    const checkpoint = {
        records,
        ...(snapshotBytes === 0 ? {} : { snapshot: bytes.subarray(recordsEnd) }),
        version,
    };
    if (!Value.Check(codeModeCheckpointSchema, checkpoint)) {
        throw invalid("The Code Mode checkpoint contents are invalid.");
    }
    return checkpoint as CodeModeCheckpoint;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
    const missing: string[] = [];
    let current = path;
    for (;;) {
        try {
            const metadata = await stat(current);
            if (!metadata.isDirectory()) throw new Error(`'${current}' is not a directory.`);
            break;
        } catch (error) {
            if (!isFileError(error, "ENOENT")) throw error;
            missing.push(current);
            const parent = dirname(current);
            if (parent === current) throw error;
            current = parent;
        }
    }

    await mkdir(path, { recursive: true, mode: 0o700 });
    for (const created of missing) await chmod(created, 0o700);
    await chmod(path, 0o700);
    if (missing.length === 0) return;

    // Sync each new directory's own entries, then the existing ancestor containing the highest
    // new directory. This durably establishes the recursively-created chain.
    for (const created of missing) await syncDirectory(created);
    await syncDirectory(dirname(missing.at(-1)!));
}

async function syncDirectory(path: string): Promise<void> {
    let directory;
    try {
        directory = await open(path, "r");
        await directory.sync();
    } catch (error) {
        if (!isUnsupportedDirectorySyncError(error)) throw error;
    } finally {
        await directory?.close().catch(() => undefined);
    }
}

export function isUnsupportedDirectorySyncError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)
    );
}

function invalid(message: string, cause?: unknown): InvalidCodeModeSnapshotError {
    return new InvalidCodeModeSnapshotError(message, cause === undefined ? undefined : { cause });
}

function isFileError(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}
