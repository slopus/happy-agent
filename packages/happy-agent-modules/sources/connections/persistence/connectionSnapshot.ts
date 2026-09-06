import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import {
    connectionsUpdatedPayloadSchema,
    type ConnectionsUpdatedPayload,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const connectionsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-connections-snapshot",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_connections_snapshot (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            snapshot_json TEXT NOT NULL
        )`,
            );
        },
    ],
];

/** One bounded public projection; private configuration never enters this table. */
export async function queryConnectionSnapshot(
    ctx: Context,
): Promise<ConnectionsUpdatedPayload | undefined> {
    const rows = await agentDatabaseRows<{ snapshot_json: string }>(
        ctx.db,
        sql`SELECT snapshot_json FROM happy_agent_connections_snapshot WHERE singleton_id = 1`,
    );
    if (rows[0] === undefined) return undefined;
    const value: unknown = JSON.parse(rows[0].snapshot_json);
    if (!Value.Check(connectionsUpdatedPayloadSchema, value))
        throw new Error("The stored remote connection roster is invalid.");
    return value;
}

export async function saveConnectionSnapshot(
    ctx: Context,
    snapshot: ConnectionsUpdatedPayload,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_connections_snapshot (singleton_id, snapshot_json)
        VALUES (1, ${JSON.stringify(snapshot)})
        ON CONFLICT(singleton_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
    );
}
