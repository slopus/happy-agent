import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const focusMigrations: readonly AgentModuleMigration[] = [
    [
        // Each person's Focus, and the rows they moved, hid, or sectioned since a status changed.
        "001-focus",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_module_focus_agents (
        member_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL
    )`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_module_focus_held (
        member_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY (member_id, task_id)
    )`,
            );
        },
    ],
];

export async function readFocusAgents(
    ctx: Context,
): Promise<readonly { readonly memberId: string; readonly agentId: string }[]> {
    const rows = await agentDatabaseRows<{ member_id: string; agent_id: string }>(
        ctx.db,
        sql`SELECT member_id, agent_id FROM happy_agent_module_focus_agents`,
    );
    return rows.map((row) => ({ memberId: row.member_id, agentId: row.agent_id }));
}

/** A new Focus replaces the person's archived or erased one. */
export async function saveFocusAgent(
    ctx: Context,
    memberId: string,
    agentId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_module_focus_agents(member_id, agent_id) VALUES (${memberId}, ${agentId})
        ON CONFLICT(member_id) DO UPDATE SET agent_id = excluded.agent_id`,
    );
}

export async function readHeldTasks(ctx: Context, memberId: string): Promise<ReadonlySet<string>> {
    const rows = await agentDatabaseRows<{ task_id: string }>(
        ctx.db,
        sql`SELECT task_id FROM happy_agent_module_focus_held WHERE member_id = ${memberId}`,
    );
    return new Set(rows.map((row) => row.task_id));
}

export async function holdTask(ctx: Context, memberId: string, taskId: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT OR IGNORE INTO happy_agent_module_focus_held(member_id, task_id) VALUES (${memberId}, ${taskId})`,
    );
}

/** A task's status changed, so every person's hold on it ends. */
export async function releaseTask(ctx: Context, taskId: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_module_focus_held WHERE task_id = ${taskId}`,
    );
}
