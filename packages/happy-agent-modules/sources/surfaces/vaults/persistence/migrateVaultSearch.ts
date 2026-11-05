import {
    agentDatabaseRun,
    type AgentDatabaseFacade,
    type AgentDatabase,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * Word indexes for ranked search. `vault_names` gives every entry an integer row in
 * `vault_name_words`, which holds its name and the names of the folders above it;
 * `vault_text_words` indexes the words of every `vault_texts` row under the same rowid, keeping no
 * copy of the text. Words are case- and diacritic-folded and never stemmed, so prefix queries
 * follow what a person is typing. The backfill row marks entries and texts made before this
 * migration, which the maintenance pass indexes in bounded transactions and then deletes.
 */
export async function migrateVaultSearch(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    const run = (query: ReturnType<typeof sql>) => agentDatabaseRun(database, query);
    await run(
        sql`CREATE TABLE happy_agent_vault_names (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, surface_id TEXT NOT NULL)`,
    );
    await run(
        sql`CREATE VIRTUAL TABLE happy_agent_vault_name_words USING fts5(name, folders, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    await run(
        sql`CREATE VIRTUAL TABLE happy_agent_vault_text_words USING fts5(text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    await run(
        sql`CREATE TABLE happy_agent_vault_search_backfill (id INTEGER PRIMARY KEY CHECK (id = 1), entries_after TEXT NOT NULL, texts_after INTEGER NOT NULL, texts_until INTEGER NOT NULL)`,
    );
    await run(
        sql`INSERT INTO happy_agent_vault_search_backfill (id, entries_after, texts_after, texts_until) SELECT 1, '', 0, coalesce(max(id), 0) FROM happy_agent_vault_texts`,
    );
}
