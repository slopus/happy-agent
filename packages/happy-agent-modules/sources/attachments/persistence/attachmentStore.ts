import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

import type { AttachmentKind, StoredAttachment, StoredUpload } from "../Attachment.js";
import { parseByteRanges } from "../impl/byteRanges.js";
import {
    ATTACHMENT_GARBAGE_TABLE,
    ATTACHMENT_UPLOADS_TABLE,
    ATTACHMENTS_TABLE,
} from "../AttachmentsMigrations.js";

/**
 * Attachment, upload, and garbage rows as stored. Every function joins the caller's transaction
 * through `ctx.db`.
 */
const rows = <Row>(ctx: Context, query: SQL) => agentDatabaseRows<Row>(ctx.db, query);
const run = (ctx: Context, query: SQL) => agentDatabaseRun(ctx.db, query);

type Numeric = number | string | bigint;

interface AttachmentRow {
    readonly agent_id: string;
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly mime_type: string;
    readonly size: Numeric;
    readonly width: Numeric | null;
    readonly height: Numeric | null;
    readonly thumbhash: string | null;
    readonly scale: Numeric | null;
    readonly uploaded_by: string | null;
    readonly created_at: Numeric;
    readonly sent_at: Numeric | null;
    readonly expires_at: Numeric | null;
}

interface UploadRow {
    readonly agent_id: string;
    readonly id: string;
    readonly file_id: string;
    readonly name: string;
    readonly content_type: string | null;
    readonly size: Numeric;
    readonly received_json: string;
    readonly chunks: Numeric;
    readonly uploaded_by: string | null;
    readonly created_at: Numeric;
    readonly expires_at: Numeric;
}

const ATTACHMENT_COLUMNS = sql.raw(
    "agent_id, id, name, kind, mime_type, size, width, height, thumbhash, scale, uploaded_by, created_at, sent_at, expires_at",
);
const UPLOAD_COLUMNS = sql.raw(
    "agent_id, id, file_id, name, content_type, size, received_json, chunks, uploaded_by, created_at, expires_at",
);

// Attachments

export async function queryAttachment(
    ctx: Context,
    agentId: string,
    id: string,
): Promise<StoredAttachment | undefined> {
    const [row] = await rows<AttachmentRow>(
        ctx,
        sql`SELECT ${ATTACHMENT_COLUMNS} FROM ${sql.raw(ATTACHMENTS_TABLE)}
            WHERE agent_id = ${agentId} AND id = ${id}`,
    );
    return row === undefined ? undefined : attachmentFromRow(row);
}

/** Unsent attachments whose time ran out, oldest first. */
export async function queryExpiredAttachments(
    ctx: Context,
    now: number,
    limit: number,
): Promise<readonly StoredAttachment[]> {
    return (
        await rows<AttachmentRow>(
            ctx,
            sql`SELECT ${ATTACHMENT_COLUMNS} FROM ${sql.raw(ATTACHMENTS_TABLE)}
                WHERE expires_at IS NOT NULL AND expires_at <= ${now}
                ORDER BY expires_at LIMIT ${limit}`,
        )
    ).map(attachmentFromRow);
}

/** Whether any conversation still holds this content. */
export async function queryAttachmentContentHeld(ctx: Context, sha256: string): Promise<boolean> {
    const found = await rows<{ found: number }>(
        ctx,
        sql`SELECT 1 AS found FROM ${sql.raw(ATTACHMENTS_TABLE)} WHERE id = ${sha256} LIMIT 1`,
    );
    return found.length > 0;
}

export async function insertAttachment(ctx: Context, row: StoredAttachment): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO ${sql.raw(ATTACHMENTS_TABLE)} (${ATTACHMENT_COLUMNS}) VALUES (
            ${row.agentId}, ${row.id}, ${row.name}, ${row.kind}, ${row.mimeType}, ${row.size},
            ${row.width}, ${row.height}, ${row.thumbhash}, ${row.scale}, ${row.uploadedBy},
            ${row.createdAt}, ${row.sentAt}, ${row.expiresAt}
        )`,
    );
}

/** Write when an attachment was sent and when it expires, the only columns that change. */
export async function updateAttachmentLifetime(
    ctx: Context,
    row: Pick<StoredAttachment, "agentId" | "id" | "sentAt" | "expiresAt">,
): Promise<void> {
    await run(
        ctx,
        sql`UPDATE ${sql.raw(ATTACHMENTS_TABLE)}
            SET sent_at = ${row.sentAt}, expires_at = ${row.expiresAt}
            WHERE agent_id = ${row.agentId} AND id = ${row.id}`,
    );
}

export async function deleteAttachment(ctx: Context, agentId: string, id: string): Promise<void> {
    await run(
        ctx,
        sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)} WHERE agent_id = ${agentId} AND id = ${id}`,
    );
}

// Uploads

export async function queryUpload(
    ctx: Context,
    agentId: string,
    id: string,
): Promise<StoredUpload | undefined> {
    const [row] = await rows<UploadRow>(
        ctx,
        sql`SELECT ${UPLOAD_COLUMNS} FROM ${sql.raw(ATTACHMENT_UPLOADS_TABLE)}
            WHERE agent_id = ${agentId} AND id = ${id}`,
    );
    return row === undefined ? undefined : uploadFromRow(row);
}

/** Unfinished uploads whose time ran out, oldest first. */
export async function queryExpiredUploads(
    ctx: Context,
    now: number,
    limit: number,
): Promise<readonly StoredUpload[]> {
    return (
        await rows<UploadRow>(
            ctx,
            sql`SELECT ${UPLOAD_COLUMNS} FROM ${sql.raw(ATTACHMENT_UPLOADS_TABLE)}
                WHERE expires_at <= ${now} ORDER BY expires_at LIMIT ${limit}`,
        )
    ).map(uploadFromRow);
}

/** Whether an upload still owns this private file. */
export async function queryUploadFileOwned(ctx: Context, fileId: string): Promise<boolean> {
    const found = await rows<{ found: number }>(
        ctx,
        sql`SELECT 1 AS found FROM ${sql.raw(ATTACHMENT_UPLOADS_TABLE)}
            WHERE file_id = ${fileId} LIMIT 1`,
    );
    return found.length > 0;
}

export async function insertUpload(ctx: Context, row: StoredUpload): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO ${sql.raw(ATTACHMENT_UPLOADS_TABLE)} (${UPLOAD_COLUMNS}) VALUES (
            ${row.agentId}, ${row.id}, ${row.fileId}, ${row.name}, ${row.contentType},
            ${row.size}, ${JSON.stringify(row.received)}, ${row.chunks}, ${row.uploadedBy},
            ${row.createdAt}, ${row.expiresAt}
        )`,
    );
}

/** Write the ranges an upload holds and when it expires. */
export async function updateUploadReceived(
    ctx: Context,
    row: Pick<StoredUpload, "agentId" | "id" | "received" | "expiresAt">,
): Promise<void> {
    await run(
        ctx,
        sql`UPDATE ${sql.raw(ATTACHMENT_UPLOADS_TABLE)}
            SET received_json = ${JSON.stringify(row.received)}, expires_at = ${row.expiresAt}
            WHERE agent_id = ${row.agentId} AND id = ${row.id}`,
    );
}

/** Write how many requests have carried bytes to an upload. */
export async function updateUploadChunks(
    ctx: Context,
    row: Pick<StoredUpload, "agentId" | "id" | "chunks">,
): Promise<void> {
    await run(
        ctx,
        sql`UPDATE ${sql.raw(ATTACHMENT_UPLOADS_TABLE)}
            SET chunks = ${row.chunks}
            WHERE agent_id = ${row.agentId} AND id = ${row.id}`,
    );
}

export async function deleteUpload(ctx: Context, agentId: string, id: string): Promise<void> {
    await run(
        ctx,
        sql`DELETE FROM ${sql.raw(ATTACHMENT_UPLOADS_TABLE)}
            WHERE agent_id = ${agentId} AND id = ${id}`,
    );
}

// One conversation

/**
 * Erase one conversation's attachments and uploads, in the transaction erasing it. Answers the
 * content digests it held and the upload files it owned.
 */
export async function deleteAgentAttachments(
    ctx: Context,
    agentId: string,
): Promise<{ readonly digests: readonly string[]; readonly fileIds: readonly string[] }> {
    const digests = await rows<{ id: string }>(
        ctx,
        sql`SELECT id FROM ${sql.raw(ATTACHMENTS_TABLE)} WHERE agent_id = ${agentId}`,
    );
    const files = await rows<{ file_id: string }>(
        ctx,
        sql`SELECT file_id FROM ${sql.raw(ATTACHMENT_UPLOADS_TABLE)} WHERE agent_id = ${agentId}`,
    );
    await run(ctx, sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)} WHERE agent_id = ${agentId}`);
    await run(
        ctx,
        sql`DELETE FROM ${sql.raw(ATTACHMENT_UPLOADS_TABLE)} WHERE agent_id = ${agentId}`,
    );
    return {
        digests: digests.map((row) => row.id),
        fileIds: files.map((row) => row.file_id),
    };
}

// Garbage

/** Note digests that may be unused from `notBefore` on; the later time wins for a repeat. */
export async function addAttachmentGarbage(
    ctx: Context,
    digests: readonly string[],
    notBefore: number,
): Promise<void> {
    for (const sha256 of new Set(digests)) {
        await run(
            ctx,
            sql`INSERT INTO ${sql.raw(ATTACHMENT_GARBAGE_TABLE)} (sha256, not_before)
                VALUES (${sha256}, ${notBefore})
                ON CONFLICT(sha256) DO UPDATE SET not_before = MAX(not_before, excluded.not_before)`,
        );
    }
}

/** Digests whose wait is over, oldest first. */
export async function queryDueAttachmentGarbage(
    ctx: Context,
    now: number,
    limit: number,
): Promise<readonly string[]> {
    return (
        await rows<{ sha256: string }>(
            ctx,
            sql`SELECT sha256 FROM ${sql.raw(ATTACHMENT_GARBAGE_TABLE)}
                WHERE not_before <= ${now} ORDER BY not_before LIMIT ${limit}`,
        )
    ).map((row) => row.sha256);
}

export async function deleteAttachmentGarbage(ctx: Context, sha256: string): Promise<void> {
    await run(ctx, sql`DELETE FROM ${sql.raw(ATTACHMENT_GARBAGE_TABLE)} WHERE sha256 = ${sha256}`);
}

function optional(value: Numeric | null): number | null {
    return value === null ? null : Number(value);
}

function attachmentFromRow(row: AttachmentRow): StoredAttachment {
    return {
        agentId: row.agent_id,
        id: row.id,
        name: row.name,
        kind: row.kind as AttachmentKind,
        mimeType: row.mime_type,
        size: Number(row.size),
        width: optional(row.width),
        height: optional(row.height),
        thumbhash: row.thumbhash,
        scale: optional(row.scale),
        uploadedBy: row.uploaded_by,
        createdAt: Number(row.created_at),
        sentAt: optional(row.sent_at),
        expiresAt: optional(row.expires_at),
    };
}

function uploadFromRow(row: UploadRow): StoredUpload {
    return {
        agentId: row.agent_id,
        id: row.id,
        fileId: row.file_id,
        name: row.name,
        contentType: row.content_type,
        size: Number(row.size),
        received: parseByteRanges(row.received_json),
        chunks: Number(row.chunks),
        uploadedBy: row.uploaded_by,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
    };
}
