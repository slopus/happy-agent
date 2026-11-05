import {
    agentDatabaseRun,
    type AgentDatabaseFacade,
    type AgentDatabase,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * Word indexes for search over todos, calendar events, and documents. Each searchable item gets
 * an integer row in `surface_search_rows`, under which its kind's FTS5 table indexes its words,
 * folded for case and diacritics and never stemmed: a todo's text, a calendar event's title and
 * its notes and location, and a document's text and its comments, which are kept. Documents
 * waiting to be indexed are listed with the `seq` they changed at. The backfill row marks what
 * existed before this migration, which a durable job indexes in bounded transactions and then
 * deletes.
 */
export async function migrateSurfaceSearch(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    const run = (query: ReturnType<typeof sql>) => agentDatabaseRun(database, query);
    await run(
        sql`CREATE TABLE happy_agent_surface_search_rows (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, item_id TEXT NOT NULL, surface_id TEXT NOT NULL, UNIQUE (kind, item_id))`,
    );
    await run(
        sql`CREATE VIRTUAL TABLE happy_agent_surface_todo_words USING fts5(text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    await run(
        sql`CREATE VIRTUAL TABLE happy_agent_surface_calendar_event_words USING fts5(title, details, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    // Document text is kept, so a match's line is read without rebuilding the document.
    await run(
        sql`CREATE VIRTUAL TABLE happy_agent_surface_document_words USING fts5(text, comments, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    await run(
        sql`CREATE TABLE happy_agent_surface_documents_to_index (surface_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)`,
    );
    await run(
        sql`CREATE TABLE happy_agent_surface_search_backfill (id INTEGER PRIMARY KEY CHECK (id = 1), todos_after TEXT NOT NULL, events_after TEXT NOT NULL, documents_after TEXT NOT NULL)`,
    );
    await run(
        sql`INSERT INTO happy_agent_surface_search_backfill (id, todos_after, events_after, documents_after) VALUES (1, '', '', '')`,
    );
}
