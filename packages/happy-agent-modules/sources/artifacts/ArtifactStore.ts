import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql, type SQL } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    artifactAuthorSchema,
    artifactFileSchema,
    artifactRecordSchema,
    artifactSourceSchema,
    artifactUploadSchema,
    artifactVersionSchema,
    DEFAULT_ARTIFACT_PAGE_SIZE,
    type ArtifactAuthor,
    type ArtifactFile,
    type ArtifactListQuery,
    type ArtifactRecord,
    type ArtifactSource,
    type ArtifactUpload,
    type ArtifactVersion,
} from "./Artifact.js";
import {
    ARTIFACT_FILES_TABLE,
    ARTIFACT_UPLOADS_TABLE,
    ARTIFACT_VERSIONS_TABLE,
    ARTIFACTS_TABLE,
} from "./ArtifactMigrations.js";
import { compareArtifactPaths } from "./ArtifactTypes.js";
import { artifactAuthorId, artifactSourceId } from "./impl/artifactIdentities.js";

interface ArtifactRow {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly status: string;
    readonly latest_version: number | string;
    readonly entry_json: string;
    readonly file_count: number | string;
    readonly size: number | string;
    readonly source_json: string | null;
    readonly created_by_json: string;
    readonly created_at: number | string;
    readonly updated_by_json: string;
    readonly updated_source_json: string | null;
    readonly updated_at: number | string;
    readonly deleted_by_json: string | null;
    readonly deleted_source_json: string | null;
    readonly deleted_at: number | string | null;
    readonly revision: number | string;
}

interface VersionRow {
    readonly artifact_id: string;
    readonly number: number | string;
    readonly title: string;
    readonly entry_path: string;
    readonly created_by_json: string;
    readonly source_json: string | null;
    readonly created_at: number | string;
}

interface FileRow {
    readonly version_number: number | string;
    readonly path: string;
    readonly mime_type: string;
    readonly size: number | string;
    readonly sha256: string;
}

interface UploadRow {
    readonly id: string;
    readonly size: number | string | null;
    readonly sha256: string | null;
    readonly utf8: number | string | null;
    readonly created_at: number | string;
    readonly expires_at: number | string;
}

/** An upload that is still receiving its bytes has no size or digest yet. */
export interface ArtifactUploadState {
    readonly id: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly received?: ArtifactUpload;
}

export async function queryArtifact(
    ctx: Context,
    artifactId: string,
): Promise<ArtifactRecord | undefined> {
    const rows = await agentDatabaseRows<ArtifactRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(ARTIFACTS_TABLE)} WHERE id = ${artifactId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : artifactFromRow(rows[0]);
}

/**
 * One page of the catalog, newest created first with the ID breaking ties, after an artifact
 * named by `after`. `undefined` when `after` names no artifact, so the caller can refuse a cursor
 * it does not recognize instead of starting over.
 */
export async function queryArtifactPage(
    ctx: Context,
    query: ArtifactListQuery,
): Promise<{ readonly artifacts: ArtifactRecord[]; readonly hasMore: boolean } | undefined> {
    const conditions: SQL[] = [];
    if (query.after !== undefined) {
        const after = await agentDatabaseRows<{ created_at: number | string; id: string }>(
            ctx.db,
            sql`SELECT created_at, id FROM ${sql.raw(ARTIFACTS_TABLE)}
                WHERE id = ${query.after} LIMIT 1`,
        );
        const cursor = after[0];
        if (cursor === undefined) return undefined;
        const createdAt = Number(cursor.created_at);
        conditions.push(
            sql`(created_at < ${createdAt} OR (created_at = ${createdAt} AND id < ${cursor.id}))`,
        );
    }
    if (query.includeDeleted !== true) conditions.push(sql`status = 'active'`);
    if (query.type !== undefined) conditions.push(sql`type = ${query.type}`);
    if (query.sourceKind !== undefined) conditions.push(sql`source_kind = ${query.sourceKind}`);
    if (query.sourceId !== undefined) conditions.push(sql`source_id = ${query.sourceId}`);
    if (query.agentId !== undefined) conditions.push(sql`source_agent_id = ${query.agentId}`);
    if (query.authorKind !== undefined) {
        conditions.push(sql`created_by_kind = ${query.authorKind}`);
    }
    if (query.authorId !== undefined) conditions.push(sql`created_by_id = ${query.authorId}`);
    const limit = query.limit ?? DEFAULT_ARTIFACT_PAGE_SIZE;
    const where = conditions.length === 0 ? sql`` : sql`WHERE ${sql.join(conditions, sql` AND `)}`;
    const rows = await agentDatabaseRows<ArtifactRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(ARTIFACTS_TABLE)} ${where}
            ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
    );
    return {
        artifacts: rows.slice(0, limit).map(artifactFromRow),
        hasMore: rows.length > limit,
    };
}

export async function queryArtifactVersion(
    ctx: Context,
    artifactId: string,
    number: number,
): Promise<ArtifactVersion | undefined> {
    const rows = await agentDatabaseRows<VersionRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(ARTIFACT_VERSIONS_TABLE)}
            WHERE artifact_id = ${artifactId} AND number = ${number} LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const files = await queryVersionFiles(ctx, artifactId, [number]);
    return versionFromRow(row, files.get(number) ?? []);
}

/** Versions newest first, older than `before` when it is given. */
export async function queryArtifactVersionPage(
    ctx: Context,
    artifactId: string,
    before: number | undefined,
    limit: number,
): Promise<{ readonly versions: ArtifactVersion[]; readonly hasMore: boolean }> {
    const older = before === undefined ? sql`` : sql`AND number < ${before}`;
    const rows = await agentDatabaseRows<VersionRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(ARTIFACT_VERSIONS_TABLE)}
            WHERE artifact_id = ${artifactId} ${older}
            ORDER BY number DESC LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const files = await queryVersionFiles(
        ctx,
        artifactId,
        page.map((row) => Number(row.number)),
    );
    return {
        versions: page.map((row) => versionFromRow(row, files.get(Number(row.number)) ?? [])),
        hasMore: rows.length > limit,
    };
}

/** One file of one version, by its exact path; nothing else is ever matched. */
export async function queryArtifactFile(
    ctx: Context,
    artifactId: string,
    number: number,
    path: string,
): Promise<ArtifactFile | undefined> {
    const rows = await agentDatabaseRows<FileRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(ARTIFACT_FILES_TABLE)}
            WHERE artifact_id = ${artifactId} AND version_number = ${number} AND path = ${path}
            LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : fileFromRow(rows[0]);
}

/** The version a retried change already made, if it made one. */
export async function queryArtifactVersionForOperation(
    ctx: Context,
    artifactId: string,
    operationId: string,
): Promise<number | undefined> {
    const rows = await agentDatabaseRows<{ number: number | string }>(
        ctx.db,
        sql`SELECT number FROM ${sql.raw(ARTIFACT_VERSIONS_TABLE)}
            WHERE artifact_id = ${artifactId} AND operation_id = ${operationId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : Number(rows[0].number);
}

export async function queryArtifactUpload(
    ctx: Context,
    uploadId: string,
): Promise<ArtifactUploadState | undefined> {
    const rows = await agentDatabaseRows<UploadRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(ARTIFACT_UPLOADS_TABLE)} WHERE id = ${uploadId} LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const state = {
        id: row.id,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
    };
    if (row.sha256 === null || row.size === null || row.utf8 === null) return state;
    const received: ArtifactUpload = {
        ...state,
        size: Number(row.size),
        sha256: row.sha256,
        utf8: Number(row.utf8) === 1,
    };
    if (!Value.Check(artifactUploadSchema, received)) {
        throw new Error("Artifact storage contains an invalid upload.");
    }
    return { ...state, received };
}

/** Whether a version or another upload still holds the content stored under this digest. */
export async function queryArtifactContentInUse(
    ctx: Context,
    sha256: string,
    exceptUploadId: string,
): Promise<boolean> {
    const files = await agentDatabaseRows<{ found: number }>(
        ctx.db,
        sql`SELECT 1 AS found FROM ${sql.raw(ARTIFACT_FILES_TABLE)}
            WHERE sha256 = ${sha256} LIMIT 1`,
    );
    if (files.length > 0) return true;
    const uploads = await agentDatabaseRows<{ found: number }>(
        ctx.db,
        sql`SELECT 1 AS found FROM ${sql.raw(ARTIFACT_UPLOADS_TABLE)}
            WHERE sha256 = ${sha256} AND id <> ${exceptUploadId} LIMIT 1`,
    );
    return uploads.length > 0;
}

/** Store a new artifact with its first version, all or nothing. */
export async function insertArtifact(
    ctx: Context,
    artifact: ArtifactRecord,
    version: ArtifactVersion,
): Promise<void> {
    assertArtifact(artifact);
    assertVersion(version);
    await ctx.inTx(async (txCtx) => {
        const source = artifact.source;
        await agentDatabaseRun(
            txCtx.db,
            sql`INSERT INTO ${sql.raw(ARTIFACTS_TABLE)} (
                id, type, title, status, latest_version, entry_json, file_count, size,
                source_json, source_kind, source_id, source_agent_id,
                created_by_json, created_by_kind, created_by_id, created_at,
                updated_by_json, updated_source_json, updated_at,
                deleted_by_json, deleted_source_json, deleted_at, revision
            ) VALUES (
                ${artifact.id}, ${artifact.type}, ${artifact.title}, ${artifact.status},
                ${artifact.latestVersion}, ${JSON.stringify(artifact.entry)},
                ${artifact.fileCount}, ${artifact.size},
                ${json(source)}, ${source?.kind ?? null},
                ${source === undefined ? null : artifactSourceId(source)},
                ${source?.agentId ?? null},
                ${JSON.stringify(artifact.createdBy)}, ${artifact.createdBy.kind},
                ${artifactAuthorId(artifact.createdBy) ?? null}, ${artifact.createdAt},
                ${JSON.stringify(artifact.updatedBy)}, ${json(artifact.updatedSource)},
                ${artifact.updatedAt}, ${json(artifact.deletedBy)}, ${json(artifact.deletedSource)},
                ${artifact.deletedAt ?? null}, ${artifact.revision}
            )`,
        );
        await insertVersion(txCtx, version, undefined);
    });
}

/**
 * Store a new version and the catalog row it leaves behind. The revision compare refuses a row
 * that moved meanwhile, and nothing is written unless all of it is.
 */
export async function insertArtifactVersion(
    ctx: Context,
    artifact: ArtifactRecord,
    version: ArtifactVersion,
    expectedRevision: number,
    operationId: string | undefined,
): Promise<void> {
    assertArtifact(artifact);
    assertVersion(version);
    if (version.artifactId !== artifact.id || version.number !== artifact.latestVersion) {
        throw new Error("The artifact version does not belong at the head of its artifact.");
    }
    await ctx.inTx(async (txCtx) => {
        await updateHead(
            txCtx,
            artifact,
            expectedRevision,
            sql`title = ${artifact.title}, latest_version = ${artifact.latestVersion},
                entry_json = ${JSON.stringify(artifact.entry)},
                file_count = ${artifact.fileCount}, size = ${artifact.size}`,
        );
        await insertVersion(txCtx, version, operationId);
    });
}

/** Store a deletion: the row becomes a tombstone, guarded by the same revision compare. */
export async function updateArtifactDeleted(
    ctx: Context,
    artifact: ArtifactRecord,
    expectedRevision: number,
): Promise<void> {
    assertArtifact(artifact);
    if (artifact.status !== "deleted" || artifact.deletedAt === undefined) {
        throw new Error("Only a deleted artifact can be stored as a tombstone.");
    }
    await updateHead(
        ctx,
        artifact,
        expectedRevision,
        sql`status = ${artifact.status}, deleted_by_json = ${json(artifact.deletedBy)},
            deleted_source_json = ${json(artifact.deletedSource)},
            deleted_at = ${artifact.deletedAt}`,
    );
}

/** Record an upload before any of its bytes are written, so an interrupted one is still owned. */
export async function insertArtifactUpload(
    ctx: Context,
    upload: { readonly id: string; readonly createdAt: number; readonly expiresAt: number },
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(ARTIFACT_UPLOADS_TABLE)}
            (id, size, sha256, utf8, created_at, expires_at)
            VALUES (${upload.id}, NULL, NULL, NULL, ${upload.createdAt}, ${upload.expiresAt})`,
    );
}

export async function updateArtifactUploadReceived(
    ctx: Context,
    upload: ArtifactUpload,
): Promise<void> {
    if (!Value.Check(artifactUploadSchema, upload)) {
        throw new Error("The artifact upload is invalid.");
    }
    const changed = await agentDatabaseRows<{ id: string }>(
        ctx.db,
        sql`UPDATE ${sql.raw(ARTIFACT_UPLOADS_TABLE)}
            SET size = ${upload.size}, sha256 = ${upload.sha256}, utf8 = ${upload.utf8 ? 1 : 0}
            WHERE id = ${upload.id} AND sha256 IS NULL RETURNING id`,
    );
    if (changed.length !== 1) throw new Error("The artifact upload was not waiting for its bytes.");
}

export async function deleteArtifactUpload(ctx: Context, uploadId: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(ARTIFACT_UPLOADS_TABLE)} WHERE id = ${uploadId}`,
    );
}

async function updateHead(
    ctx: Context,
    artifact: ArtifactRecord,
    expectedRevision: number,
    fields: SQL,
): Promise<void> {
    const changed = await agentDatabaseRows<{ id: string }>(
        ctx.db,
        sql`UPDATE ${sql.raw(ARTIFACTS_TABLE)} SET ${fields},
            updated_by_json = ${JSON.stringify(artifact.updatedBy)},
            updated_source_json = ${json(artifact.updatedSource)},
            updated_at = ${artifact.updatedAt}, revision = ${artifact.revision}
            WHERE id = ${artifact.id} AND revision = ${expectedRevision}
            RETURNING id`,
    );
    if (changed.length !== 1) throw new Error("The artifact changed before it could be stored.");
}

async function insertVersion(
    ctx: Context,
    version: ArtifactVersion,
    operationId: string | undefined,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(ARTIFACT_VERSIONS_TABLE)}
            (artifact_id, number, title, entry_path, created_by_json, source_json, created_at,
                operation_id)
            VALUES (${version.artifactId}, ${version.number}, ${version.title},
                ${version.entry.path}, ${JSON.stringify(version.createdBy)},
                ${json(version.source)}, ${version.createdAt}, ${operationId ?? null})`,
    );
    for (const file of version.files) {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(ARTIFACT_FILES_TABLE)}
                (artifact_id, version_number, path, mime_type, size, sha256)
                VALUES (${version.artifactId}, ${version.number}, ${file.path},
                    ${file.mimeType}, ${file.size}, ${file.sha256})`,
        );
    }
}

async function queryVersionFiles(
    ctx: Context,
    artifactId: string,
    numbers: readonly number[],
): Promise<Map<number, ArtifactFile[]>> {
    const files = new Map<number, ArtifactFile[]>();
    if (numbers.length === 0) return files;
    const rows = await agentDatabaseRows<FileRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(ARTIFACT_FILES_TABLE)}
            WHERE artifact_id = ${artifactId}
                AND version_number IN (${sql.join(
                    numbers.map((number) => sql`${number}`),
                    sql`, `,
                )})`,
    );
    for (const row of rows) {
        const number = Number(row.version_number);
        files.set(number, [...(files.get(number) ?? []), fileFromRow(row)]);
    }
    for (const list of files.values()) {
        list.sort((left, right) => compareArtifactPaths(left.path, right.path));
    }
    return files;
}

function fileFromRow(row: FileRow): ArtifactFile {
    const file: ArtifactFile = {
        path: row.path,
        mimeType: row.mime_type,
        size: Number(row.size),
        sha256: row.sha256,
    };
    if (!Value.Check(artifactFileSchema, file)) {
        throw new Error("Artifact storage contains an invalid file.");
    }
    return file;
}

function artifactFromRow(row: ArtifactRow): ArtifactRecord {
    const source = parseSource(row.source_json);
    const updatedSource = parseSource(row.updated_source_json);
    const deletedBy = parseAuthor(row.deleted_by_json);
    const deletedSource = parseSource(row.deleted_source_json);
    const artifact = {
        id: row.id,
        type: row.type,
        title: row.title,
        status: row.status,
        latestVersion: Number(row.latest_version),
        entry: JSON.parse(row.entry_json) as unknown,
        fileCount: Number(row.file_count),
        size: Number(row.size),
        ...(source === undefined ? {} : { source }),
        createdBy: JSON.parse(row.created_by_json) as unknown,
        createdAt: Number(row.created_at),
        updatedBy: JSON.parse(row.updated_by_json) as unknown,
        ...(updatedSource === undefined ? {} : { updatedSource }),
        updatedAt: Number(row.updated_at),
        ...(deletedBy === undefined ? {} : { deletedBy }),
        ...(deletedSource === undefined ? {} : { deletedSource }),
        ...(row.deleted_at === null ? {} : { deletedAt: Number(row.deleted_at) }),
        revision: Number(row.revision),
    };
    assertArtifact(artifact);
    return artifact;
}

function versionFromRow(row: VersionRow, files: readonly ArtifactFile[]): ArtifactVersion {
    const source = parseSource(row.source_json);
    const entry = files.find((file) => file.path === row.entry_path);
    if (entry === undefined) throw new Error("Artifact storage lost a version's entry.");
    const version = {
        artifactId: row.artifact_id,
        number: Number(row.number),
        title: row.title,
        entry,
        files: [...files],
        createdBy: JSON.parse(row.created_by_json) as unknown,
        ...(source === undefined ? {} : { source }),
        createdAt: Number(row.created_at),
    };
    assertVersion(version);
    return version;
}

function parseSource(value: string | null): ArtifactSource | undefined {
    if (value === null) return undefined;
    const parsed = JSON.parse(value) as unknown;
    if (!Value.Check(artifactSourceSchema, parsed)) {
        throw new Error("Artifact storage contains an invalid source.");
    }
    return parsed;
}

function parseAuthor(value: string | null): ArtifactAuthor | undefined {
    if (value === null) return undefined;
    const parsed = JSON.parse(value) as unknown;
    if (!Value.Check(artifactAuthorSchema, parsed)) {
        throw new Error("Artifact storage contains an invalid author.");
    }
    return parsed;
}

function json(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

function assertArtifact(artifact: unknown): asserts artifact is ArtifactRecord {
    if (!Value.Check(artifactRecordSchema, artifact)) {
        throw new Error("Artifact storage contains an invalid artifact.");
    }
}

function assertVersion(version: unknown): asserts version is ArtifactVersion {
    if (!Value.Check(artifactVersionSchema, version)) {
        throw new Error("Artifact storage contains an invalid version.");
    }
}
