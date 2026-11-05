import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

import type { HistoryMessage } from "../HistoryMessage.js";

/**
 * The word index search reads over conversation messages: what people and agents wrote, never
 * reasoning, tool calls, tool output, or system and service notices. Every searchable message
 * gets an integer row in `history_word_rows`, under which a contentless FTS5 table indexes its
 * words, folded for case and diacritics and never stemmed. The text itself stays in the history
 * row. Every function joins the caller's transaction through `ctx.db`.
 */
const ROWS = sql.raw("happy_agent_module_history_word_rows");
const WORDS = sql.raw("happy_agent_module_history_words");
const BACKFILL = sql.raw("happy_agent_module_history_word_backfill");

const rows = <Row>(ctx: Context, query: SQL) => agentDatabaseRows<Row>(ctx.db, query);
const run = (ctx: Context, query: SQL) => agentDatabaseRun(ctx.db, query);

export async function migrateHistoryWords(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    const create = (query: SQL) => agentDatabaseRun(database, query);
    await create(
        sql`CREATE TABLE ${ROWS} (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, record_id TEXT NOT NULL, UNIQUE (agent_id, record_id))`,
    );
    await create(
        sql`CREATE VIRTUAL TABLE ${WORDS} USING fts5(text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    // The history rows to index after an upgrade: everything up to the rowid that exists now.
    await create(
        sql`CREATE TABLE ${BACKFILL} (id INTEGER PRIMARY KEY CHECK (id = 1), after BIGINT NOT NULL, until BIGINT NOT NULL)`,
    );
    await create(
        sql`INSERT INTO ${BACKFILL} (id, after, until) SELECT 1, 0, coalesce(max(rowid), 0) FROM happy_agent_module_history`,
    );
}

/** Who wrote a message, as search reports it, or null when search leaves it out. */
export function historyWordRole(message: HistoryMessage): "user" | "agent" | null {
    if (message.hideFromUser === true) return null;
    if (message.role === "user") return "user";
    if (message.role === "assistant" || message.role === "agent") return "agent";
    return null;
}

/** The words search finds a message by: its text blocks. */
export function historyWordText(message: HistoryMessage): string {
    return message.blocks
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
}

/** Index a message's words in place of what was indexed before. */
export async function indexHistoryWords(
    ctx: Context,
    agentId: string,
    message: HistoryMessage,
): Promise<void> {
    const text = historyWordRole(message) === null ? "" : historyWordText(message);
    const [existing] = await rows<{ id: number }>(
        ctx,
        sql`SELECT id FROM ${ROWS} WHERE agent_id = ${agentId} AND record_id = ${message.recordId}`,
    );
    if (existing !== undefined)
        await run(ctx, sql`DELETE FROM ${WORDS} WHERE rowid = ${Number(existing.id)}`);
    if (text.trim().length === 0) {
        if (existing !== undefined)
            await run(ctx, sql`DELETE FROM ${ROWS} WHERE id = ${Number(existing.id)}`);
        return;
    }
    const id =
        existing === undefined
            ? Number(
                  (
                      await rows<{ id: number }>(
                          ctx,
                          sql`INSERT INTO ${ROWS} (agent_id, record_id) VALUES (${agentId}, ${message.recordId}) RETURNING id`,
                      )
                  )[0]!.id,
              )
            : Number(existing.id);
    await run(ctx, sql`INSERT INTO ${WORDS} (rowid, text) VALUES (${id}, ${text})`);
}

/** Forget every message of an agent erased for good. */
export async function eraseHistoryWords(ctx: Context, agentId: string): Promise<void> {
    await run(
        ctx,
        sql`DELETE FROM ${WORDS} WHERE rowid IN (SELECT id FROM ${ROWS} WHERE agent_id = ${agentId})`,
    );
    await run(ctx, sql`DELETE FROM ${ROWS} WHERE agent_id = ${agentId}`);
}

/** Messages holding every query word, best BM25 first. */
export async function queryHistoryWords(
    ctx: Context,
    match: string,
    limit: number,
): Promise<{ agentId: string; recordId: string }[]> {
    const found = await rows<{ agent_id: string; record_id: string }>(
        ctx,
        sql`SELECT r.agent_id, r.record_id FROM ${WORDS} w JOIN ${ROWS} r ON r.id = w.rowid WHERE ${WORDS} MATCH ${match} ORDER BY bm25(${WORDS}) LIMIT ${limit}`,
    );
    return found.map((row) => ({ agentId: row.agent_id, recordId: row.record_id }));
}

/** Where the backfill has reached, or undefined once it is done. */
export async function queryHistoryWordBackfill(
    ctx: Context,
): Promise<{ after: number; until: number } | undefined> {
    const [row] = await rows<{ after: number; until: number }>(
        ctx,
        sql`SELECT after, until FROM ${BACKFILL} WHERE id = 1`,
    );
    return row === undefined ? undefined : { after: Number(row.after), until: Number(row.until) };
}

export async function updateHistoryWordBackfill(ctx: Context, after: number | null): Promise<void> {
    if (after === null) await run(ctx, sql`DELETE FROM ${BACKFILL} WHERE id = 1`);
    else await run(ctx, sql`UPDATE ${BACKFILL} SET after = ${after} WHERE id = 1`);
}

/** History rows after `after` and up to `until`, by rowid, for the backfill. */
export async function queryHistoryRowsForWords(
    ctx: Context,
    after: number,
    until: number,
    limit: number,
): Promise<{ rowid: number; agentId: string; messageJson: string }[]> {
    const found = await rows<{ rowid: number; agent_id: string; message_json: string }>(
        ctx,
        sql`SELECT rowid, agent_id, message_json FROM happy_agent_module_history WHERE rowid > ${after} AND rowid <= ${until} AND role IN ('user', 'assistant', 'agent') ORDER BY rowid LIMIT ${limit}`,
    );
    return found.map((row) => ({
        rowid: Number(row.rowid),
        agentId: row.agent_id,
        messageJson: row.message_json,
    }));
}
