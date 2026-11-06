import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * HTML texts were indexed as source, so a word in a tag or attribute found them and their
 * snippets showed markup. Their words are now indexed as readable text. This marks the HTML texts
 * that exist to be indexed again by the maintenance pass's backfill, which `html_only` limits to
 * them; a backfill still pending from before the word indexes already covers every text.
 */
export async function migrateVaultHtmlWords(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    const run = (query: ReturnType<typeof sql>) => agentDatabaseRun(database, query);
    await run(
        sql`ALTER TABLE happy_agent_vault_search_backfill ADD COLUMN html_only INTEGER NOT NULL DEFAULT 0`,
    );
    await run(
        sql`INSERT OR IGNORE INTO happy_agent_vault_search_backfill (id, entries_after, texts_after, texts_until, html_only) SELECT 1, coalesce((SELECT max(id) FROM happy_agent_vault_entries), ''), 0, coalesce((SELECT max(id) FROM happy_agent_vault_texts), 0), 1`,
    );
}
