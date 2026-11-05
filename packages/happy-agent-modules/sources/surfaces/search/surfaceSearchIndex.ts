import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

/**
 * Search's word indexes over Surface content. Every function joins the caller's transaction
 * through `ctx.db`.
 */
const rows = <Row>(ctx: Context, query: SQL) => agentDatabaseRows<Row>(ctx.db, query);
const run = (ctx: Context, query: SQL) => agentDatabaseRun(ctx.db, query);

/** What a Surface search row indexes, and the columns its words are kept in. */
export interface SurfaceSearchColumns {
    readonly todo: { readonly text: string };
    readonly calendar_event: { readonly title: string; readonly details: string };
    readonly document: { readonly text: string; readonly comments: string };
}
export type SurfaceSearchKind = keyof SurfaceSearchColumns;

const WORDS: Record<SurfaceSearchKind, SQL> = {
    todo: sql.raw("happy_agent_surface_todo_words"),
    calendar_event: sql.raw("happy_agent_surface_calendar_event_words"),
    document: sql.raw("happy_agent_surface_document_words"),
};

/** Index an item's words in place of what was indexed before; null leaves it unsearchable. */
export async function indexSurfaceSearchText<Kind extends SurfaceSearchKind>(
    ctx: Context,
    kind: Kind,
    surfaceId: string,
    itemId: string,
    columns: SurfaceSearchColumns[Kind] | null,
): Promise<void> {
    const [row] = await rows<{ id: number }>(
        ctx,
        sql`INSERT INTO happy_agent_surface_search_rows (kind, item_id, surface_id) VALUES (${kind}, ${itemId}, ${surfaceId}) ON CONFLICT (kind, item_id) DO UPDATE SET surface_id = excluded.surface_id RETURNING id`,
    );
    const id = Number(row!.id);
    await run(ctx, sql`DELETE FROM ${WORDS[kind]} WHERE rowid = ${id}`);
    if (columns === null) return;
    const names = Object.keys(columns);
    const values = Object.values(columns) as string[];
    await run(
        ctx,
        sql`INSERT INTO ${WORDS[kind]} (rowid, ${sql.raw(names.join(", "))}) VALUES (${id}, ${sql.join(
            values.map((value) => sql`${value}`),
            sql`, `,
        )})`,
    );
}

/**
 * Items of one kind whose `column` holds every query word, best BM25 first, with that column's
 * words when the kind keeps them.
 */
export async function querySurfaceSearch<Kind extends SurfaceSearchKind>(
    ctx: Context,
    kind: Kind,
    column: keyof SurfaceSearchColumns[Kind] & string,
    match: string,
    limit: number,
): Promise<{ surfaceId: string; itemId: string; text: string | null }[]> {
    const text = kind === "document" ? sql`w.${sql.raw(column)}` : sql`NULL`;
    const found = await rows<{ surface_id: string; item_id: string; text: string | null }>(
        ctx,
        sql`SELECT r.surface_id, r.item_id, ${text} AS text FROM ${WORDS[kind]} w JOIN happy_agent_surface_search_rows r ON r.id = w.rowid WHERE ${WORDS[kind]} MATCH ${`${column} : (${match})`} ORDER BY bm25(${WORDS[kind]}) LIMIT ${limit}`,
    );
    return found.map((row) => ({
        surfaceId: row.surface_id,
        itemId: row.item_id,
        text: row.text,
    }));
}

/** Note that a document changed at `seq` and its text needs indexing again. */
export async function markSurfaceDocumentToIndex(
    ctx: Context,
    surfaceId: string,
    seq: number,
): Promise<void> {
    await run(
        ctx,
        sql`INSERT INTO happy_agent_surface_documents_to_index (surface_id, seq) VALUES (${surfaceId}, ${seq}) ON CONFLICT (surface_id) DO UPDATE SET seq = excluded.seq`,
    );
}

/** One document waiting to be indexed, and the `seq` it was marked at. */
export async function queryNextSurfaceDocumentToIndex(
    ctx: Context,
): Promise<{ surfaceId: string; seq: number } | undefined> {
    const [row] = await rows<{ surface_id: string; seq: number }>(
        ctx,
        sql`SELECT surface_id, seq FROM happy_agent_surface_documents_to_index ORDER BY surface_id LIMIT 1`,
    );
    return row === undefined ? undefined : { surfaceId: row.surface_id, seq: Number(row.seq) };
}

/** Take a document off the list, unless it changed again since `seq`. */
export async function clearSurfaceDocumentToIndex(
    ctx: Context,
    surfaceId: string,
    seq: number,
): Promise<void> {
    await run(
        ctx,
        sql`DELETE FROM happy_agent_surface_documents_to_index WHERE surface_id = ${surfaceId} AND seq = ${seq}`,
    );
}

/** Where the backfill of items made before the indexes has reached, or undefined when done. */
export async function querySurfaceSearchBackfill(
    ctx: Context,
): Promise<{ todosAfter: string; eventsAfter: string; documentsAfter: string } | undefined> {
    const [row] = await rows<{
        todos_after: string;
        events_after: string;
        documents_after: string;
    }>(
        ctx,
        sql`SELECT todos_after, events_after, documents_after FROM happy_agent_surface_search_backfill WHERE id = 1`,
    );
    return row === undefined
        ? undefined
        : {
              todosAfter: row.todos_after,
              eventsAfter: row.events_after,
              documentsAfter: row.documents_after,
          };
}

export async function updateSurfaceSearchBackfill(
    ctx: Context,
    state: { todosAfter: string; eventsAfter: string; documentsAfter: string } | null,
): Promise<void> {
    if (state === null)
        await run(ctx, sql`DELETE FROM happy_agent_surface_search_backfill WHERE id = 1`);
    else
        await run(
            ctx,
            sql`UPDATE happy_agent_surface_search_backfill SET todos_after = ${state.todosAfter}, events_after = ${state.eventsAfter}, documents_after = ${state.documentsAfter} WHERE id = 1`,
        );
}

/** Calendar events after `afterKey` (`surfaceId/eventId`), as stored, for the backfill. */
export async function queryCalendarEventsAfter(
    ctx: Context,
    afterKey: string,
    limit: number,
): Promise<{ key: string; event: unknown }[]> {
    const found = await rows<{ key: string; event_json: string }>(
        ctx,
        sql`SELECT surface_id || '/' || event_id AS key, event_json FROM happy_agent_surface_calendar_events WHERE surface_id || '/' || event_id > ${afterKey} ORDER BY surface_id, event_id LIMIT ${limit}`,
    );
    return found.map((row) => ({ key: row.key, event: JSON.parse(row.event_json) as unknown }));
}
