import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type {
    ArtifactFile,
    VaultActivity,
    VaultEntry,
    VaultSettings,
    VaultVersion,
} from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

import { vaultNameKey } from "../vaultNames.js";

/** Vault rows as stored. Every function joins the caller's transaction through `ctx.db`. */
const rows = <Row>(ctx: Context, query: SQL) => agentDatabaseRows<Row>(ctx.db, query);
const run = (ctx: Context, query: SQL) => agentDatabaseRun(ctx.db, query);
const entries = (list: readonly { entry_json: string }[]) =>
    list.map((row) => JSON.parse(row.entry_json) as VaultEntry);

/** The live entries of one vault, or of the subtree below `rootId`, as a recursive CTE. */
function liveTree(surfaceId: string, rootId: string | null): SQL {
    return sql`WITH RECURSIVE live(id, path_key, depth) AS (
        SELECT id, '/' || name_key, 1 FROM happy_agent_vault_entries
            WHERE surface_id = ${surfaceId} AND parent_id IS ${rootId} AND deleted_at IS NULL
        UNION ALL
        SELECT e.id, live.path_key || '/' || e.name_key, live.depth + 1
            FROM happy_agent_vault_entries e JOIN live ON e.parent_id = live.id
            WHERE e.surface_id = ${surfaceId} AND e.deleted_at IS NULL
    )`;
}

export async function readVaultSettings(
    ctx: Context,
    surfaceId: string,
): Promise<VaultSettings | undefined> {
    const [row] = await rows<{ settings_json: string }>(
        ctx,
        sql`SELECT settings_json FROM happy_agent_vault_settings WHERE surface_id = ${surfaceId}`,
    );
    return row === undefined ? undefined : (JSON.parse(row.settings_json) as VaultSettings);
}

export async function writeVaultSettings(ctx: Context, settings: VaultSettings): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO happy_agent_vault_settings (surface_id, settings_json) VALUES (${settings.surfaceId}, ${JSON.stringify(settings)}) ON CONFLICT(surface_id) DO UPDATE SET settings_json = excluded.settings_json`,
    );
}

export async function readVaultEntry(ctx: Context, id: string): Promise<VaultEntry | undefined> {
    return entries(
        await rows<{ entry_json: string }>(
            ctx,
            sql`SELECT entry_json FROM happy_agent_vault_entries WHERE id = ${id}`,
        ),
    )[0];
}

export async function insertVaultEntry(ctx: Context, entry: VaultEntry): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO happy_agent_vault_entries (id, surface_id, parent_id, name_key, kind, size, updated_at, deleted_at, entry_json) VALUES (${entry.id}, ${entry.surfaceId}, ${entry.parentId}, ${vaultNameKey(entry.name)}, ${entry.kind}, ${entry.size}, ${entry.updatedAt}, ${entry.deletedAt}, ${JSON.stringify(entry)})`,
    );
}

export async function updateVaultEntry(ctx: Context, entry: VaultEntry): Promise<void> {
    await run(
        ctx,
        sql`UPDATE happy_agent_vault_entries SET parent_id = ${entry.parentId}, name_key = ${vaultNameKey(entry.name)}, size = ${entry.size}, updated_at = ${entry.updatedAt}, deleted_at = ${entry.deletedAt}, entry_json = ${JSON.stringify(entry)} WHERE id = ${entry.id}`,
    );
}

/** The child of a folder (or the root) that is not itself deleted, matched by name key. */
export async function readVaultChild(
    ctx: Context,
    surfaceId: string,
    parentId: string | null,
    name: string,
): Promise<VaultEntry | undefined> {
    return entries(
        await rows<{ entry_json: string }>(
            ctx,
            sql`SELECT entry_json FROM happy_agent_vault_entries WHERE surface_id = ${surfaceId} AND parent_id IS ${parentId} AND name_key = ${vaultNameKey(name)} AND deleted_at IS NULL`,
        ),
    )[0];
}

/** An entry and its folders from the root down, as stored. */
export async function readVaultLineage(ctx: Context, id: string): Promise<VaultEntry[]> {
    return entries(
        await rows<{ entry_json: string }>(
            ctx,
            sql`WITH RECURSIVE up(id, parent_id, depth) AS (
                SELECT id, parent_id, 0 FROM happy_agent_vault_entries WHERE id = ${id}
                UNION ALL
                SELECT e.id, e.parent_id, up.depth + 1 FROM happy_agent_vault_entries e JOIN up ON e.id = up.parent_id WHERE up.depth < 100
            ) SELECT e.entry_json FROM up JOIN happy_agent_vault_entries e ON e.id = up.id ORDER BY up.depth DESC`,
        ),
    );
}

/** The keyset position of one listed entry: group (folders first), sort value, name key, ID. */
export type VaultListPosition = readonly [number, string | number, string, string];

export async function listVaultChildren(
    ctx: Context,
    surfaceId: string,
    parentId: string | null,
    sort: "name" | "updatedAt" | "size",
    order: "asc" | "desc",
    after: VaultListPosition | undefined,
    limit: number,
): Promise<{ entries: VaultEntry[]; positions: VaultListPosition[] }> {
    const primary =
        sort === "name"
            ? sql.raw("name_key")
            : sort === "updatedAt"
              ? sql.raw("updated_at")
              : sql.raw("coalesce(size, 0)");
    const direction = sql.raw(order === "asc" ? "ASC" : "DESC");
    const comparison = sql.raw(order === "asc" ? ">" : "<");
    const group = sql.raw("(CASE WHEN kind = 'folder' THEN 0 ELSE 1 END)");
    const keyset =
        after === undefined
            ? sql``
            : sql`AND (${group} > ${after[0]} OR (${group} = ${after[0]} AND (${primary}, name_key, id) ${comparison} (${after[1]}, ${after[2]}, ${after[3]})))`;
    const found = await rows<{
        entry_json: string;
        grp: number;
        sort_value: string | number;
        name_key: string;
        id: string;
    }>(
        ctx,
        sql`SELECT entry_json, ${group} AS grp, ${primary} AS sort_value, name_key, id FROM happy_agent_vault_entries WHERE surface_id = ${surfaceId} AND parent_id IS ${parentId} AND deleted_at IS NULL ${keyset} ORDER BY grp ASC, sort_value ${direction}, name_key ${direction}, id ${direction} LIMIT ${limit}`,
    );
    return {
        entries: entries(found),
        positions: found.map((row) => [
            Number(row.grp),
            typeof row.sort_value === "string" ? row.sort_value : Number(row.sort_value),
            row.name_key,
            row.id,
        ]),
    };
}

/** Live entries of a vault in ID order, after `afterId`. */
export async function listVaultTree(
    ctx: Context,
    surfaceId: string,
    afterId: string | undefined,
    limit: number,
): Promise<VaultEntry[]> {
    return entries(
        await rows<{ entry_json: string }>(
            ctx,
            sql`${liveTree(surfaceId, null)} SELECT e.entry_json FROM live JOIN happy_agent_vault_entries e ON e.id = live.id WHERE live.id > ${afterId ?? ""} ORDER BY live.id LIMIT ${limit}`,
        ),
    );
}

/** Live entries below `rootId` (or the whole vault) with their depth below it, unordered. */
export async function listVaultSubtree(
    ctx: Context,
    surfaceId: string,
    rootId: string | null,
    maxDepth: number,
    limit: number,
): Promise<{ entry: VaultEntry; depth: number }[]> {
    const found = await rows<{ entry_json: string; depth: number }>(
        ctx,
        sql`${liveTree(surfaceId, rootId)} SELECT e.entry_json, live.depth FROM live JOIN happy_agent_vault_entries e ON e.id = live.id WHERE live.depth <= ${maxDepth} LIMIT ${limit}`,
    );
    return found.map((row) => ({
        entry: JSON.parse(row.entry_json) as VaultEntry,
        depth: Number(row.depth),
    }));
}

/** Trash items, newest deletion first: deleted entries whose folders are all live. */
export async function listVaultTrash(
    ctx: Context,
    surfaceId: string,
    after: readonly [number, string] | undefined,
    limit: number,
): Promise<VaultEntry[]> {
    const keyset =
        after === undefined ? sql`` : sql`AND (e.deleted_at, e.id) < (${after[0]}, ${after[1]})`;
    return entries(
        await rows<{ entry_json: string }>(
            ctx,
            sql`${liveTree(surfaceId, null)} SELECT e.entry_json FROM happy_agent_vault_entries e WHERE e.surface_id = ${surfaceId} AND e.deleted_at IS NOT NULL AND (e.parent_id IS NULL OR e.parent_id IN (SELECT id FROM live)) ${keyset} ORDER BY e.deleted_at DESC, e.id DESC LIMIT ${limit}`,
        ),
    );
}

/** A vault's Trash items deleted before `before`, oldest first. */
export async function listExpiredTrash(
    ctx: Context,
    surfaceId: string,
    before: number,
    limit: number,
): Promise<VaultEntry[]> {
    return entries(
        await rows<{ entry_json: string }>(
            ctx,
            sql`${liveTree(surfaceId, null)} SELECT e.entry_json FROM happy_agent_vault_entries e WHERE e.surface_id = ${surfaceId} AND e.deleted_at IS NOT NULL AND e.deleted_at < ${before} AND (e.parent_id IS NULL OR e.parent_id IN (SELECT id FROM live)) ORDER BY e.deleted_at LIMIT ${limit}`,
        ),
    );
}

/** Every entry below `rootId`, deleted or not, deepest first, at most `limit`. */
export async function listVaultDescendants(
    ctx: Context,
    rootId: string,
    limit: number,
): Promise<string[]> {
    const found = await rows<{ id: string }>(
        ctx,
        sql`WITH RECURSIVE down(id, depth) AS (
            SELECT id, 1 FROM happy_agent_vault_entries WHERE parent_id = ${rootId}
            UNION ALL
            SELECT e.id, down.depth + 1 FROM happy_agent_vault_entries e JOIN down ON e.parent_id = down.id
        ) SELECT id FROM down ORDER BY depth DESC LIMIT ${limit}`,
    );
    return found.map((row) => row.id);
}

/** Whether `ancestorId` is `id` or one of its folders. */
export async function isVaultAncestor(
    ctx: Context,
    ancestorId: string,
    id: string,
): Promise<boolean> {
    return (await readVaultLineage(ctx, id)).some((entry) => entry.id === ancestorId);
}

/**
 * Live entries whose path contains `key`, ranked: names equal to it, starting with it,
 * containing it, then paths containing it, each by path.
 */
export async function searchVaultNames(
    ctx: Context,
    surfaceId: string,
    rootId: string | null,
    key: string,
    limit: number,
): Promise<VaultEntry[]> {
    const pattern = `%${escapeLike(key)}%`;
    return entries(
        await rows<{ entry_json: string }>(
            ctx,
            sql`${liveTree(surfaceId, rootId)} SELECT e.entry_json, CASE WHEN e.name_key = ${key} THEN 0 WHEN e.name_key LIKE ${`${escapeLike(key)}%`} ESCAPE '\\' THEN 1 WHEN e.name_key LIKE ${pattern} ESCAPE '\\' THEN 2 ELSE 3 END AS rank FROM live JOIN happy_agent_vault_entries e ON e.id = live.id WHERE live.path_key LIKE ${pattern} ESCAPE '\\' ORDER BY rank, live.path_key LIMIT ${limit}`,
        ),
    );
}

/** Indexed texts matching `query` in a vault, scanning at most `limit` rows after `afterId`. */
export async function searchVaultTexts(
    ctx: Context,
    surfaceId: string,
    query: string,
    afterId: number,
    limit: number,
): Promise<{ id: number; entryId: string; innerPath: string | null; text: string }[]> {
    const phrase = `"${query.replaceAll('"', '""')}"`;
    const found = await rows<{
        id: number;
        entry_id: string;
        inner_path: string | null;
        text: string;
    }>(
        ctx,
        sql`SELECT t.id, t.entry_id, t.inner_path, i.text FROM happy_agent_vault_text_index i JOIN happy_agent_vault_texts t ON t.id = i.rowid WHERE happy_agent_vault_text_index MATCH ${phrase} AND t.surface_id = ${surfaceId} AND t.id > ${afterId} ORDER BY t.id LIMIT ${limit}`,
    );
    return found.map((row) => ({
        id: Number(row.id),
        entryId: row.entry_id,
        innerPath: row.inner_path,
        text: row.text,
    }));
}

/** Indexed texts of the given entries, for grep. */
export async function readVaultTexts(
    ctx: Context,
    entryIds: readonly string[],
): Promise<{ entryId: string; innerPath: string | null; text: string }[]> {
    if (entryIds.length === 0) return [];
    const found = await rows<{ entry_id: string; inner_path: string | null; text: string }>(
        ctx,
        sql`SELECT t.entry_id, t.inner_path, i.text FROM happy_agent_vault_texts t JOIN happy_agent_vault_text_index i ON i.rowid = t.id WHERE t.entry_id IN (${sql.join(
            entryIds.map((id) => sql`${id}`),
            sql`, `,
        )}) ORDER BY t.entry_id, t.inner_path`,
    );
    return found.map((row) => ({
        entryId: row.entry_id,
        innerPath: row.inner_path,
        text: row.text,
    }));
}

/** Replace an entry's indexed texts with its newest version's. */
export async function replaceVaultTexts(
    ctx: Context,
    surfaceId: string,
    entryId: string,
    texts: readonly { innerPath: string | null; text: string }[],
): Promise<void> {
    await deleteVaultTexts(ctx, entryId);
    for (const text of texts) {
        const [row] = await rows<{ id: number }>(
            ctx,
            sql`INSERT INTO happy_agent_vault_texts (entry_id, surface_id, inner_path) VALUES (${entryId}, ${surfaceId}, ${text.innerPath}) RETURNING id`,
        );
        await run(
            ctx,
            sql`INSERT INTO happy_agent_vault_text_index (rowid, text) VALUES (${Number(row!.id)}, ${text.text})`,
        );
    }
}

export async function deleteVaultTexts(ctx: Context, entryId: string): Promise<void> {
    await run(
        ctx,
        sql`DELETE FROM happy_agent_vault_text_index WHERE rowid IN (SELECT id FROM happy_agent_vault_texts WHERE entry_id = ${entryId})`,
    );
    await run(ctx, sql`DELETE FROM happy_agent_vault_texts WHERE entry_id = ${entryId}`);
}

export async function insertVaultVersion(
    ctx: Context,
    version: VaultVersion,
    files: readonly ArtifactFile[],
): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO happy_agent_vault_versions (entry_id, number, surface_id, sha256, created_at, pinned, version_json) VALUES (${version.entryId}, ${version.number}, ${version.surfaceId}, ${version.sha256}, ${version.createdAt}, ${version.pinned ? 1 : 0}, ${JSON.stringify(version)})`,
    );
    for (const file of files)
        await run(
            ctx,
            sql`INSERT INTO happy_agent_vault_version_files (entry_id, number, path, mime_type, size, sha256) VALUES (${version.entryId}, ${version.number}, ${file.path}, ${file.mimeType}, ${file.size}, ${file.sha256})`,
        );
}

export async function updateVaultVersionPin(ctx: Context, version: VaultVersion): Promise<void> {
    await run(
        ctx,
        sql`UPDATE happy_agent_vault_versions SET pinned = ${version.pinned ? 1 : 0}, version_json = ${JSON.stringify(version)} WHERE entry_id = ${version.entryId} AND number = ${version.number}`,
    );
}

export async function readVaultVersion(
    ctx: Context,
    entryId: string,
    number: number,
): Promise<VaultVersion | undefined> {
    const [row] = await rows<{ version_json: string }>(
        ctx,
        sql`SELECT version_json FROM happy_agent_vault_versions WHERE entry_id = ${entryId} AND number = ${number}`,
    );
    return row === undefined ? undefined : (JSON.parse(row.version_json) as VaultVersion);
}

export async function readVaultVersionFiles(
    ctx: Context,
    entryId: string,
    number: number,
): Promise<ArtifactFile[]> {
    const found = await rows<{ path: string; mime_type: string; size: number; sha256: string }>(
        ctx,
        sql`SELECT path, mime_type, size, sha256 FROM happy_agent_vault_version_files WHERE entry_id = ${entryId} AND number = ${number}`,
    );
    return found
        .map((row) => ({
            path: row.path,
            mimeType: row.mime_type,
            size: Number(row.size),
            sha256: row.sha256,
        }))
        .sort((left, right) =>
            Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
        );
}

/** Versions newest first, below `beforeNumber`. */
export async function listVaultVersions(
    ctx: Context,
    entryId: string,
    beforeNumber: number | undefined,
    limit: number,
): Promise<VaultVersion[]> {
    const found = await rows<{ version_json: string }>(
        ctx,
        sql`SELECT version_json FROM happy_agent_vault_versions WHERE entry_id = ${entryId} AND number < ${beforeNumber ?? Number.MAX_SAFE_INTEGER} ORDER BY number DESC LIMIT ${limit}`,
    );
    return found.map((row) => JSON.parse(row.version_json) as VaultVersion);
}

/** What retention needs of every version of one entry. */
export async function listVaultRetainedVersions(
    ctx: Context,
    entryId: string,
): Promise<{ number: number; createdAt: number; pinned: boolean }[]> {
    const found = await rows<{ number: number; created_at: number; pinned: number }>(
        ctx,
        sql`SELECT number, created_at, pinned FROM happy_agent_vault_versions WHERE entry_id = ${entryId}`,
    );
    return found.map((row) => ({
        number: Number(row.number),
        createdAt: Number(row.created_at),
        pinned: Number(row.pinned) === 1,
    }));
}

/** Delete versions and return the digests they held. */
export async function deleteVaultVersions(
    ctx: Context,
    entryId: string,
    numbers: readonly number[] | "all",
): Promise<string[]> {
    const which =
        numbers === "all"
            ? sql``
            : sql`AND number IN (${sql.join(
                  numbers.map((number) => sql`${number}`),
                  sql`, `,
              )})`;
    if (numbers !== "all" && numbers.length === 0) return [];
    const digests = await rows<{ sha256: string }>(
        ctx,
        sql`SELECT sha256 FROM happy_agent_vault_versions WHERE entry_id = ${entryId} AND sha256 IS NOT NULL ${which} UNION SELECT sha256 FROM happy_agent_vault_version_files WHERE entry_id = ${entryId} ${which}`,
    );
    await run(
        ctx,
        sql`DELETE FROM happy_agent_vault_versions WHERE entry_id = ${entryId} ${which}`,
    );
    await run(
        ctx,
        sql`DELETE FROM happy_agent_vault_version_files WHERE entry_id = ${entryId} ${which}`,
    );
    return digests.map((row) => row.sha256);
}

/** Entries with versions, in ID order after `afterId`, for the retention pass. */
export async function listVersionedEntries(
    ctx: Context,
    afterId: string,
    limit: number,
): Promise<{ id: string; surfaceId: string }[]> {
    const found = await rows<{ id: string; surface_id: string }>(
        ctx,
        sql`SELECT id, surface_id FROM happy_agent_vault_entries WHERE kind != 'folder' AND id > ${afterId} ORDER BY id LIMIT ${limit}`,
    );
    return found.map((row) => ({ id: row.id, surfaceId: row.surface_id }));
}

export async function listVaultSurfaces(ctx: Context): Promise<string[]> {
    const found = await rows<{ surface_id: string }>(
        ctx,
        sql`SELECT surface_id FROM happy_agent_vault_settings ORDER BY surface_id`,
    );
    return found.map((row) => row.surface_id);
}

export async function deleteVaultEntryRows(ctx: Context, id: string): Promise<void> {
    await deleteVaultTexts(ctx, id);
    await run(ctx, sql`DELETE FROM happy_agent_vault_activity WHERE entry_id = ${id}`);
    await run(ctx, sql`DELETE FROM happy_agent_vault_entries WHERE id = ${id}`);
}

export async function insertVaultActivity(ctx: Context, activity: VaultActivity): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO happy_agent_vault_activity (id, entry_id, kind, agent_id, at, activity_json) VALUES (${activity.id}, ${activity.entryId}, ${activity.kind}, ${activity.actor.agentId}, ${activity.at}, ${JSON.stringify(activity)})`,
    );
}

export async function listVaultActivity(
    ctx: Context,
    entryId: string,
    beforeId: string | undefined,
    limit: number,
): Promise<VaultActivity[]> {
    const found = await rows<{ activity_json: string }>(
        ctx,
        sql`SELECT activity_json FROM happy_agent_vault_activity WHERE entry_id = ${entryId} AND id < ${beforeId ?? "~"} ORDER BY id DESC LIMIT ${limit}`,
    );
    return found.map((row) => JSON.parse(row.activity_json) as VaultActivity);
}

/** How many versions an agent made of one entry since `since`, creation included. */
export async function countAgentVaultVersions(
    ctx: Context,
    entryId: string,
    agentId: string,
    since: number,
): Promise<number> {
    const [row] = await rows<{ count: number }>(
        ctx,
        sql`SELECT count(*) AS count FROM happy_agent_vault_activity WHERE entry_id = ${entryId} AND agent_id = ${agentId} AND at > ${since} AND kind IN ('created', 'version_created')`,
    );
    return Number(row?.count ?? 0);
}

export interface StoredVaultUpload {
    readonly id: string;
    readonly size: number;
    readonly received: number;
    readonly expectedSha256: string | null;
    readonly sha256: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
}

export async function insertVaultUpload(ctx: Context, upload: StoredVaultUpload): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO happy_agent_vault_uploads (id, size, received, expected_sha256, sha256, created_at, expires_at) VALUES (${upload.id}, ${upload.size}, ${upload.received}, ${upload.expectedSha256}, ${upload.sha256}, ${upload.createdAt}, ${upload.expiresAt})`,
    );
}

export async function readVaultUpload(
    ctx: Context,
    id: string,
): Promise<StoredVaultUpload | undefined> {
    const [row] = await rows<{
        id: string;
        size: number;
        received: number;
        expected_sha256: string | null;
        sha256: string | null;
        created_at: number;
        expires_at: number;
    }>(ctx, sql`SELECT * FROM happy_agent_vault_uploads WHERE id = ${id}`);
    return row === undefined
        ? undefined
        : {
              id: row.id,
              size: Number(row.size),
              received: Number(row.received),
              expectedSha256: row.expected_sha256,
              sha256: row.sha256,
              createdAt: Number(row.created_at),
              expiresAt: Number(row.expires_at),
          };
}

export async function updateVaultUpload(ctx: Context, upload: StoredVaultUpload): Promise<void> {
    await run(
        ctx,
        sql`UPDATE happy_agent_vault_uploads SET received = ${upload.received}, sha256 = ${upload.sha256}, expires_at = ${upload.expiresAt} WHERE id = ${upload.id}`,
    );
}

export async function deleteVaultUpload(ctx: Context, id: string): Promise<void> {
    await run(ctx, sql`DELETE FROM happy_agent_vault_uploads WHERE id = ${id}`);
}

export async function listExpiredVaultUploads(
    ctx: Context,
    now: number,
    limit: number,
): Promise<StoredVaultUpload[]> {
    const found = await rows<{ id: string }>(
        ctx,
        sql`SELECT id FROM happy_agent_vault_uploads WHERE expires_at <= ${now} ORDER BY expires_at LIMIT ${limit}`,
    );
    const uploads: StoredVaultUpload[] = [];
    for (const row of found) {
        const upload = await readVaultUpload(ctx, row.id);
        if (upload !== undefined) uploads.push(upload);
    }
    return uploads;
}

export async function hasVaultUpload(ctx: Context, id: string): Promise<boolean> {
    return (
        (await rows(ctx, sql`SELECT 1 FROM happy_agent_vault_uploads WHERE id = ${id}`)).length > 0
    );
}

/**
 * Note digests to check for collection from `notBefore`. A digest noted twice is checked at the
 * later time, so content just written for a placement is never collected before it is placed.
 */
export async function addVaultGarbage(
    ctx: Context,
    digests: readonly string[],
    notBefore: number,
): Promise<void> {
    for (const digest of new Set(digests))
        await run(
            ctx,
            sql`INSERT INTO happy_agent_vault_garbage (sha256, not_before) VALUES (${digest}, ${notBefore}) ON CONFLICT(sha256) DO UPDATE SET not_before = max(not_before, excluded.not_before)`,
        );
}

export async function listVaultGarbage(
    ctx: Context,
    now: number,
    limit: number,
): Promise<string[]> {
    const found = await rows<{ sha256: string }>(
        ctx,
        sql`SELECT sha256 FROM happy_agent_vault_garbage WHERE not_before <= ${now} LIMIT ${limit}`,
    );
    return found.map((row) => row.sha256);
}

export async function deleteVaultGarbage(ctx: Context, digest: string): Promise<void> {
    await run(ctx, sql`DELETE FROM happy_agent_vault_garbage WHERE sha256 = ${digest}`);
}

/** Whether any version, artifact manifest, or upload still holds this content. */
export async function vaultContentInUse(ctx: Context, digest: string): Promise<boolean> {
    const found = await rows(
        ctx,
        sql`SELECT 1 FROM happy_agent_vault_versions WHERE sha256 = ${digest} UNION ALL SELECT 1 FROM happy_agent_vault_version_files WHERE sha256 = ${digest} UNION ALL SELECT 1 FROM happy_agent_vault_uploads WHERE sha256 = ${digest} LIMIT 1`,
    );
    return found.length > 0;
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
