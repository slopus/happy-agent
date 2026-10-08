import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { runnerListResponseSchema, type RunnerListResponse } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const runnersMigrations: readonly AgentModuleMigration[] = [
    [
        "001-runners-snapshot",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_runners_snapshot (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            snapshot_json TEXT NOT NULL
        )`,
            );
        },
    ],
];

/** The public runner list as last published. Tokens never enter this table. */
export async function queryRunnerSnapshot(ctx: Context): Promise<RunnerListResponse | undefined> {
    const rows = await agentDatabaseRows<{ snapshot_json: string }>(
        ctx.db,
        sql`SELECT snapshot_json FROM happy_agent_runners_snapshot WHERE singleton_id = 1`,
    );
    if (rows[0] === undefined) return undefined;
    const value: unknown = JSON.parse(rows[0].snapshot_json);
    if (!Value.Check(runnerListResponseSchema, value))
        throw new Error("The stored runner list is invalid.");
    return value;
}

export async function saveRunnerSnapshot(
    ctx: Context,
    snapshot: RunnerListResponse,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_runners_snapshot (singleton_id, snapshot_json)
        VALUES (1, ${JSON.stringify(snapshot)})
        ON CONFLICT(singleton_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
    );
}
