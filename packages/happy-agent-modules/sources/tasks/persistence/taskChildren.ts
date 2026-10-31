import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { taskChildSchema, type TaskChild, type TaskChildRef } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { TASK_CHILDREN_TABLE } from "../TaskMigrations.js";

/** The most child choices one task holds. */
export const MAX_TASK_CHILDREN = 200;

interface ChildRow {
    readonly ref_kind: string;
    readonly ref_id: string;
    readonly visibility: string;
    readonly by_agent_id: string | null;
    readonly by_user_id: string | null;
    readonly updated_at: number | string;
}

/** One task's child choices, oldest first. */
export async function readTaskChildren(ctx: Context, taskId: string): Promise<TaskChild[]> {
    const rows = await agentDatabaseRows<ChildRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(TASK_CHILDREN_TABLE)}
            WHERE task_id = ${taskId} ORDER BY updated_at, ref_kind, ref_id`,
    );
    return rows.map((row) => {
        const child = {
            ref: { kind: row.ref_kind, id: row.ref_id },
            visibility: row.visibility,
            by: { agentId: row.by_agent_id, userId: row.by_user_id },
            updatedAt: Number(row.updated_at),
        };
        if (!Value.Check(taskChildSchema, child)) {
            throw new Error("Task storage contains an invalid child choice.");
        }
        return child;
    });
}

/** Store one child choice in place of any earlier one, or forget it when `child` is absent. */
export async function writeTaskChild(
    ctx: Context,
    taskId: string,
    ref: TaskChildRef,
    child: TaskChild | undefined,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(TASK_CHILDREN_TABLE)}
            WHERE task_id = ${taskId} AND ref_kind = ${ref.kind} AND ref_id = ${ref.id}`,
    );
    if (child === undefined) return;
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(TASK_CHILDREN_TABLE)}
                (task_id, ref_kind, ref_id, visibility, by_agent_id, by_user_id, updated_at)
            VALUES (${taskId}, ${ref.kind}, ${ref.id}, ${child.visibility}, ${child.by.agentId},
                ${child.by.userId}, ${child.updatedAt})`,
    );
}
