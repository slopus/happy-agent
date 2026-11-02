import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** IDs that ever named a server connection by URL. Removal keeps them, so none is reused. */
export const migrateReservedServerConnectionIds: AgentModuleMigration = [
    "003-reserved-server-connection-ids",
    async (_ctx, database) => {
        await agentDatabaseRun(
            database,
            sql`CREATE TABLE happy_agent_reserved_server_connection_ids (
            id TEXT PRIMARY KEY NOT NULL
        )`,
        );
    },
];

export async function reserveServerConnectionId(ctx: Context, id: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_reserved_server_connection_ids (id) VALUES (${id})
        ON CONFLICT(id) DO NOTHING`,
    );
}

export async function queryReservedServerConnectionIds(ctx: Context): Promise<Set<string>> {
    const rows = await agentDatabaseRows<{ id: string }>(
        ctx.db,
        sql`SELECT id FROM happy_agent_reserved_server_connection_ids`,
    );
    return new Set(rows.map((row) => row.id));
}
