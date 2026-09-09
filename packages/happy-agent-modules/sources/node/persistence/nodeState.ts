import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { nodeStateSchema, type NodeState } from "../NodeState.js";

export const nodeMigrations: readonly AgentModuleMigration[] = [
    [
        "001-node-state",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_node (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), state_json TEXT NOT NULL
    )`,
            );
        },
    ],
];

/** One bounded singleton keeps avatar bytes and metadata in the same atomic record. */
export async function queryNodeState(ctx: Context): Promise<NodeState | undefined> {
    const rows = await agentDatabaseRows<{ state_json: string }>(
        ctx.db,
        sql`SELECT state_json FROM happy_agent_node WHERE singleton_id = 1`,
    );
    if (rows[0] === undefined) return undefined;
    const state: unknown = JSON.parse(rows[0].state_json);
    if (!Value.Check(nodeStateSchema, state))
        throw new Error("The stored node configuration is invalid.");
    return state;
}

export async function saveNodeState(ctx: Context, state: NodeState): Promise<void> {
    if (!Value.Check(nodeStateSchema, state)) throw new Error("The node configuration is invalid.");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_node (singleton_id, state_json)
        VALUES (1, ${JSON.stringify(state)})
        ON CONFLICT(singleton_id) DO UPDATE SET state_json = excluded.state_json`,
    );
}
