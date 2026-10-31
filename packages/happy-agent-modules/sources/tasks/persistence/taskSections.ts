import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { taskSectionRecordSchema, type TaskSectionRecord } from "../Task.js";
import { TASK_SECTIONS_TABLE } from "../TaskMigrations.js";

interface SectionRow {
    readonly id: string;
    readonly member_id: string;
    readonly name: string;
    readonly order_key: string;
    readonly collapsed: number | string | boolean;
}

/** One member's sections in key order. */
export async function readTaskSections(
    ctx: Context,
    memberId: string,
): Promise<TaskSectionRecord[]> {
    const rows = await agentDatabaseRows<SectionRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(TASK_SECTIONS_TABLE)}
            WHERE member_id = ${memberId} ORDER BY order_key, id`,
    );
    return rows.map((row) => {
        const section = {
            id: row.id,
            memberId: row.member_id,
            name: row.name,
            orderKey: row.order_key,
            collapsed: Number(row.collapsed) === 1 || row.collapsed === true,
        };
        if (!Value.Check(taskSectionRecordSchema, section)) {
            throw new Error("Task storage contains an invalid section.");
        }
        return section;
    });
}

/** Whether any member already has a section with this ID; IDs are unique across members. */
export async function taskSectionIdTaken(ctx: Context, id: string): Promise<boolean> {
    const rows = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`SELECT id FROM ${sql.raw(TASK_SECTIONS_TABLE)} WHERE id = ${id} LIMIT 1`,
    );
    return rows.length > 0;
}

/** Replace one member's whole set of sections. */
export async function writeTaskSections(
    ctx: Context,
    memberId: string,
    sections: readonly TaskSectionRecord[],
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(TASK_SECTIONS_TABLE)} WHERE member_id = ${memberId}`,
    );
    for (const section of sections) {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(TASK_SECTIONS_TABLE)}
                    (id, member_id, name, order_key, collapsed)
                VALUES (${section.id}, ${memberId}, ${section.name}, ${section.orderKey},
                    ${section.collapsed ? 1 : 0})`,
        );
    }
}
