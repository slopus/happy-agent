import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { globalSkillSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const globalSkillsStateSchema = Type.Object({
    revision: Type.String(),
    scanSequence: Type.Integer(),
    rootStamp: Type.String(),
    entries: Type.Array(
        Type.Object({
            skill: globalSkillSchema,
            present: Type.Boolean(),
            stamp: Type.String(),
            canonical: Type.String(),
        }),
        { maxItems: 10000 },
    ),
});
export type GlobalSkillsState = Static<typeof globalSkillsStateSchema>;
export const globalSkillsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-global-skills",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_global_skills (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), state_json TEXT NOT NULL
        )`,
            );
        },
    ],
];
export async function queryGlobalSkillsState(ctx: Context): Promise<GlobalSkillsState | undefined> {
    const rows = await agentDatabaseRows<{ state_json: string }>(
        ctx.db,
        sql`SELECT state_json FROM happy_agent_global_skills WHERE singleton_id = 1`,
    );
    if (rows[0] === undefined) return undefined;
    const state: unknown = JSON.parse(rows[0].state_json);
    if (!Value.Check(globalSkillsStateSchema, state))
        throw new Error("Stored global skill state is invalid.");
    return state;
}
export async function saveGlobalSkillsState(ctx: Context, state: GlobalSkillsState): Promise<void> {
    if (!Value.Check(globalSkillsStateSchema, state))
        throw new Error("Global skill state is invalid.");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_global_skills (singleton_id, state_json)
        VALUES (1, ${JSON.stringify(state)}) ON CONFLICT(singleton_id) DO UPDATE SET state_json = excluded.state_json`,
    );
}
