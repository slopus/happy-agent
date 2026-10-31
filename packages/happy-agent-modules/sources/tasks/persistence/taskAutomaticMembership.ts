import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    TASK_LEAVES_TABLE,
    TASK_MEMBERS_TABLE,
    TASK_SECTIONS_TABLE,
    TASKS_TABLE,
} from "../TaskMigrations.js";

/** Missing active memberships, excluding tasks the person explicitly left. */
export async function queryAutomaticTaskIds(
    ctx: Context,
    memberId: string,
    taskId?: string,
): Promise<readonly string[]> {
    const rows = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`SELECT task.id FROM ${sql.raw(TASKS_TABLE)} AS task
            WHERE task.status = 'active'
                ${taskId === undefined ? sql`` : sql`AND task.id = ${taskId}`}
                AND NOT EXISTS (
                    SELECT 1 FROM ${sql.raw(TASK_MEMBERS_TABLE)} AS membership
                    WHERE membership.member_id = ${memberId} AND membership.task_id = task.id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM ${sql.raw(TASK_LEAVES_TABLE)} AS departure
                    WHERE departure.member_id = ${memberId} AND departure.task_id = task.id
                )
            ORDER BY task.created_at, task.id LIMIT 100`,
    );
    return rows.map((row) => row.id);
}

/** Remember a deliberate leave, including a leave before the person ever joined. */
export async function saveTaskLeave(ctx: Context, memberId: string, taskId: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(TASK_LEAVES_TABLE)} (member_id, task_id)
            VALUES (${memberId}, ${taskId}) ON CONFLICT DO NOTHING`,
    );
}

/** An explicit join makes a formerly left task eligible for participation again. */
export async function clearTaskLeave(
    ctx: Context,
    memberId: string,
    taskId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(TASK_LEAVES_TABLE)}
            WHERE member_id = ${memberId} AND task_id = ${taskId}`,
    );
}

/**
 * Only the first order key is needed to place a new membership at the top, above any section
 * header, which shares the key space.
 */
export async function queryFirstTaskOrderKey(
    ctx: Context,
    memberId: string,
): Promise<string | undefined> {
    const rows = await agentDatabaseRows<{ readonly order_key: string }>(
        ctx.db,
        sql`SELECT order_key FROM (
                SELECT order_key FROM ${sql.raw(TASK_MEMBERS_TABLE)} WHERE member_id = ${memberId}
                UNION ALL
                SELECT order_key FROM ${sql.raw(TASK_SECTIONS_TABLE)} WHERE member_id = ${memberId}
            ) AS list ORDER BY order_key LIMIT 1`,
    );
    return rows[0]?.order_key;
}
