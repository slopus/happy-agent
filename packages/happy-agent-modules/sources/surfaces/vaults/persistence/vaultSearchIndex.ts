import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { VaultItem } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

import { vaultSearchText } from "../vaultSearchText.js";

/**
 * The word indexes behind ranked search, kept in step with entries and texts by `vaultStore`.
 * Every function joins the caller's transaction through `ctx.db`.
 */
const rows = <Row>(ctx: Context, query: SQL) => agentDatabaseRows<Row>(ctx.db, query);
const run = (ctx: Context, query: SQL) => agentDatabaseRun(ctx.db, query);

/** How the folders above an item read in the index: their names, outermost first. */
const FOLDER_SEPARATOR = " / ";

/** Index an entry's name and the folders above it, replacing what was indexed before. */
export async function indexVaultName(ctx: Context, entry: VaultItem): Promise<void> {
    const [above] = await rows<{ folders: string | null }>(
        ctx,
        sql`WITH RECURSIVE up(id, parent_id, depth) AS (
            SELECT id, parent_id, 0 FROM happy_agent_vault_entries WHERE id = ${entry.parentId}
            UNION ALL
            SELECT e.id, e.parent_id, up.depth + 1 FROM happy_agent_vault_entries e JOIN up ON e.id = up.parent_id WHERE up.depth < 100
        ) SELECT group_concat(name, ${FOLDER_SEPARATOR}) AS folders FROM (SELECT json_extract(e.entry_json, '$.name') AS name FROM up JOIN happy_agent_vault_entries e ON e.id = up.id ORDER BY up.depth DESC)`,
    );
    await writeNameRow(ctx, entry.id, entry.surfaceId, entry.name, above?.folders ?? "");
}

/** Re-index the folders of everything below `folder` after it was renamed or moved. */
export async function indexVaultNamesBelow(ctx: Context, folder: VaultItem): Promise<void> {
    const [own] = await rows<{ folders: string }>(
        ctx,
        sql`SELECT w.folders FROM happy_agent_vault_names n JOIN happy_agent_vault_name_words w ON w.rowid = n.id WHERE n.entry_id = ${folder.id}`,
    );
    const prefix =
        own === undefined || own.folders === ""
            ? folder.name
            : `${own.folders}${FOLDER_SEPARATOR}${folder.name}`;
    const below = await rows<{ row_id: number; folders: string }>(
        ctx,
        sql`WITH RECURSIVE down(id, name, folders, depth) AS (
            SELECT id, json_extract(entry_json, '$.name'), ${prefix}, 1 FROM happy_agent_vault_entries WHERE parent_id = ${folder.id}
            UNION ALL
            SELECT e.id, json_extract(e.entry_json, '$.name'), down.folders || ${FOLDER_SEPARATOR} || down.name, down.depth + 1
                FROM happy_agent_vault_entries e JOIN down ON e.parent_id = down.id WHERE down.depth < 100
        ) SELECT n.id AS row_id, down.folders FROM down JOIN happy_agent_vault_names n ON n.entry_id = down.id`,
    );
    for (const row of below)
        await run(
            ctx,
            sql`UPDATE happy_agent_vault_name_words SET folders = ${row.folders} WHERE rowid = ${Number(row.row_id)}`,
        );
}

async function writeNameRow(
    ctx: Context,
    entryId: string,
    surfaceId: string,
    name: string,
    folders: string,
): Promise<void> {
    const [row] = await rows<{ id: number }>(
        ctx,
        sql`INSERT INTO happy_agent_vault_names (entry_id, surface_id) VALUES (${entryId}, ${surfaceId}) ON CONFLICT (entry_id) DO UPDATE SET surface_id = excluded.surface_id RETURNING id`,
    );
    const id = Number(row!.id);
    await run(ctx, sql`DELETE FROM happy_agent_vault_name_words WHERE rowid = ${id}`);
    await run(
        ctx,
        sql`INSERT INTO happy_agent_vault_name_words (rowid, name, folders) VALUES (${id}, ${name}, ${folders})`,
    );
}

export async function deleteVaultName(ctx: Context, entryId: string): Promise<void> {
    await run(
        ctx,
        sql`DELETE FROM happy_agent_vault_name_words WHERE rowid IN (SELECT id FROM happy_agent_vault_names WHERE entry_id = ${entryId})`,
    );
    await run(ctx, sql`DELETE FROM happy_agent_vault_names WHERE entry_id = ${entryId}`);
}

/** Index the words of one `vault_texts` row under its ID. */
export async function indexVaultTextWords(ctx: Context, id: number, text: string): Promise<void> {
    await run(ctx, sql`DELETE FROM happy_agent_vault_text_words WHERE rowid = ${id}`);
    await run(
        ctx,
        sql`INSERT INTO happy_agent_vault_text_words (rowid, text) VALUES (${id}, ${text})`,
    );
}

/** Forget the words of an entry's texts, before its `vault_texts` rows go. */
export async function deleteVaultTextWords(ctx: Context, entryId: string): Promise<void> {
    await run(
        ctx,
        sql`DELETE FROM happy_agent_vault_text_words WHERE rowid IN (SELECT id FROM happy_agent_vault_texts WHERE entry_id = ${entryId})`,
    );
}

/** Which columns a name query must match in: the name alone, or the name and its folders. */
export type VaultNameColumns = "name" | "folders";

/**
 * Entries whose name (or name and folders) holds every query word, best BM25 first, in one
 * vault or every vault. `match` is an FTS5 query of prefix terms. The path tier leaves out what
 * the name tier finds.
 */
export async function queryVaultNameWords(
    ctx: Context,
    surfaceId: string | null,
    match: string,
    columns: VaultNameColumns,
    limit: number,
): Promise<string[]> {
    const where =
        columns === "name"
            ? sql`happy_agent_vault_name_words MATCH ${`name : (${match})`}`
            : sql`happy_agent_vault_name_words MATCH ${match} AND w.rowid NOT IN (SELECT rowid FROM happy_agent_vault_name_words WHERE happy_agent_vault_name_words MATCH ${`name : (${match})`})`;
    const weights = columns === "name" ? sql`1.0, 0.0` : sql`4.0, 1.0`;
    const found = await rows<{ entry_id: string }>(
        ctx,
        sql`SELECT n.entry_id FROM happy_agent_vault_name_words w JOIN happy_agent_vault_names n ON n.id = w.rowid WHERE ${where} ${surfaceId === null ? sql`` : sql`AND n.surface_id = ${surfaceId}`} ORDER BY bm25(happy_agent_vault_name_words, ${weights}) LIMIT ${limit}`,
    );
    return found.map((row) => row.entry_id);
}

/** Texts holding every query word, best BM25 first, in one vault or every vault. */
export async function queryVaultTextWords(
    ctx: Context,
    surfaceId: string | null,
    match: string,
    limit: number,
): Promise<{ id: number; entryId: string; innerPath: string | null }[]> {
    const found = await rows<{ id: number; entry_id: string; inner_path: string | null }>(
        ctx,
        sql`SELECT t.id, t.entry_id, t.inner_path FROM happy_agent_vault_text_words w JOIN happy_agent_vault_texts t ON t.id = w.rowid WHERE happy_agent_vault_text_words MATCH ${match} ${surfaceId === null ? sql`` : sql`AND t.surface_id = ${surfaceId}`} ORDER BY bm25(happy_agent_vault_text_words) LIMIT ${limit}`,
    );
    return found.map((row) => ({
        id: Number(row.id),
        entryId: row.entry_id,
        innerPath: row.inner_path,
    }));
}

/** The text of one `vault_texts` row, from the trigram index that keeps it. */
export async function readVaultText(ctx: Context, id: number): Promise<string | undefined> {
    const [row] = await rows<{ text: string }>(
        ctx,
        sql`SELECT text FROM happy_agent_vault_text_index WHERE rowid = ${id}`,
    );
    return row?.text;
}

/**
 * Index up to `limit` entries and texts made before the search indexes existed, or only the HTML
 * texts when `html_only` says just those need their words again. Returns false once nothing is
 * left, when the backfill row is gone.
 */
export async function backfillVaultSearch(ctx: Context, limit: number): Promise<boolean> {
    const [state] = await rows<{
        entries_after: string;
        texts_after: number;
        texts_until: number;
        html_only: number;
    }>(
        ctx,
        sql`SELECT entries_after, texts_after, texts_until, html_only FROM happy_agent_vault_search_backfill WHERE id = 1`,
    );
    if (state === undefined) return false;
    const pending = await rows<{ entry_json: string }>(
        ctx,
        sql`SELECT e.entry_json FROM happy_agent_vault_entries e WHERE e.id > ${state.entries_after} AND NOT EXISTS (SELECT 1 FROM happy_agent_vault_names n WHERE n.entry_id = e.id) ORDER BY e.id LIMIT ${limit}`,
    );
    for (const row of pending) await indexVaultName(ctx, JSON.parse(row.entry_json) as VaultItem);
    // A plain file's own name, or a vault app file's inner path, says whether it is HTML.
    const path = sql`coalesce(t.inner_path, json_extract(e.entry_json, '$.name'))`;
    const texts = await rows<{ id: number; text: string; name: string; inner_path: string | null }>(
        ctx,
        sql`SELECT t.id, i.text, json_extract(e.entry_json, '$.name') AS name, t.inner_path FROM happy_agent_vault_texts t JOIN happy_agent_vault_text_index i ON i.rowid = t.id JOIN happy_agent_vault_entries e ON e.id = t.entry_id WHERE t.id > ${Number(state.texts_after)} AND t.id <= ${Number(state.texts_until)} ${Number(state.html_only) === 1 ? sql`AND (lower(${path}) LIKE '%.html' OR lower(${path}) LIKE '%.htm')` : sql``} ORDER BY t.id LIMIT ${limit}`,
    );
    for (const text of texts)
        await indexVaultTextWords(
            ctx,
            Number(text.id),
            vaultSearchText(text.name, text.inner_path, text.text),
        );
    if (pending.length < limit && texts.length < limit) {
        await run(ctx, sql`DELETE FROM happy_agent_vault_search_backfill WHERE id = 1`);
        return false;
    }
    await run(
        ctx,
        sql`UPDATE happy_agent_vault_search_backfill SET entries_after = ${pending.length === limit ? (JSON.parse(pending.at(-1)!.entry_json) as VaultItem).id : state.entries_after}, texts_after = ${texts.at(-1)?.id ?? state.texts_after} WHERE id = 1`,
    );
    return true;
}
