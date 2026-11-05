import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * The word index search reads for artifacts. Every artifact that is not deleted gets an
 * integer row in `artifact_search_rows`, under which an FTS5 table keeps its title, and its
 * summary followed by the text of its newest version's entry, folded for case and diacritics and
 * never stemmed. The text is kept
 * so a match's line is read without opening the stored file. The backfill row marks the artifacts
 * made before this migration, which a durable job indexes in bounded transactions and then deletes.
 */
export async function migrateArtifactSearch(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    const run = (query: ReturnType<typeof sql>) => agentDatabaseRun(database, query);
    await run(
        sql`CREATE TABLE happy_agent_module_artifact_search_rows (id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL UNIQUE)`,
    );
    await run(
        sql`CREATE VIRTUAL TABLE happy_agent_module_artifact_words USING fts5(title, text, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    await run(
        sql`CREATE TABLE happy_agent_module_artifact_search_backfill (id INTEGER PRIMARY KEY CHECK (id = 1), artifacts_after TEXT NOT NULL)`,
    );
    await run(
        sql`INSERT INTO happy_agent_module_artifact_search_backfill (id, artifacts_after) VALUES (1, '')`,
    );
}
