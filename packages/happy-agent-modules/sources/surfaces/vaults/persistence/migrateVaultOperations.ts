import {
    agentDatabaseRun,
    type AgentDatabaseFacade,
    type AgentDatabase,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * What each operation ID used on a file did: the version it made, or a null `number` when its
 * content matched the newest version. Rows live as long as the file.
 */
export async function migrateVaultOperations(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`CREATE TABLE happy_agent_vault_operations (entry_id TEXT NOT NULL, operation_id TEXT NOT NULL, number INTEGER, PRIMARY KEY (entry_id, operation_id))`,
    );
}
