import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql, type SQL } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    taskMembershipSchema,
    taskRecordSchema,
    type TaskMembership,
    type TaskRecord,
} from "./Task.js";
import { TASK_MEMBERS_TABLE, TASKS_TABLE } from "./TaskMigrations.js";

interface TaskRow {
    readonly id: string;
    readonly name: string;
    readonly folder_name: string;
    readonly owner_user_id: string | null;
    readonly creator_agent_id: string | null;
    readonly workspace_id: string;
    readonly workspace_version: number | string;
    readonly workspace_updated_at: number | string;
    readonly agent_id: string;
    readonly path: string;
    readonly runner_id: string | null;
    readonly status: string;
    readonly version: number | string;
    readonly created_at: number | string;
    readonly updated_at: number | string;
    readonly archived_at: number | string | null;
}

export async function readTask(ctx: Context, taskId: string): Promise<TaskRecord | undefined> {
    return await readOne(ctx, sql`id = ${taskId}`);
}

export async function readTaskByFolderName(
    ctx: Context,
    folderName: string,
): Promise<TaskRecord | undefined> {
    return await readOne(ctx, sql`folder_name = ${folderName}`);
}

export async function readTaskByWorkspace(
    ctx: Context,
    workspaceId: string,
): Promise<TaskRecord | undefined> {
    return await readOne(ctx, sql`workspace_id = ${workspaceId}`);
}

export async function readTaskByAgent(
    ctx: Context,
    agentId: string,
): Promise<TaskRecord | undefined> {
    return await readOne(ctx, sql`agent_id = ${agentId}`);
}

export async function readTasks(ctx: Context): Promise<readonly TaskRecord[]> {
    const rows = await agentDatabaseRows<TaskRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(TASKS_TABLE)} ORDER BY created_at, id`,
    );
    return rows.map(taskFromRow);
}

export async function insertTask(ctx: Context, task: TaskRecord): Promise<void> {
    assertTask(task);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(TASKS_TABLE)} (
            id, name, folder_name, owner_user_id, creator_agent_id,
            workspace_id, workspace_version, workspace_updated_at,
            agent_id, path, runner_id, status, version,
            created_at, updated_at, archived_at
        ) VALUES (
            ${task.id}, ${task.name}, ${task.folderName}, ${task.ownerUserId ?? null},
            ${task.creatorAgentId ?? null}, ${task.workspaceId}, ${task.workspaceVersion},
            ${task.workspaceUpdatedAt}, ${task.agentId}, ${task.path}, ${task.runnerId ?? null},
            ${task.status}, ${task.version}, ${task.createdAt},
            ${task.updatedAt}, ${task.archivedAt ?? null}
        )`,
    );
}

/** Store a decided change; the version compare-and-swap refuses a row that moved meanwhile. */
export async function updateTask(
    ctx: Context,
    task: TaskRecord,
    expectedVersion: number,
): Promise<TaskRecord> {
    assertTask(task);
    const changed = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`UPDATE ${sql.raw(TASKS_TABLE)} SET
            name = ${task.name}, status = ${task.status},
            workspace_version = ${task.workspaceVersion},
            workspace_updated_at = ${task.workspaceUpdatedAt},
            version = ${task.version},
            updated_at = ${task.updatedAt}, archived_at = ${task.archivedAt ?? null}
            WHERE id = ${task.id} AND version = ${expectedVersion}
            RETURNING id`,
    );
    if (changed.length !== 1) throw new Error("The task changed before it could be stored.");
    const stored = await readTask(ctx, task.id);
    if (stored === undefined) throw new Error("The stored task disappeared.");
    return stored;
}

interface MembershipRow {
    readonly task_id: string;
    readonly member_id: string;
    readonly order_key: string;
    readonly joined_at: number | string;
}

export async function readMembership(
    ctx: Context,
    taskId: string,
    memberId: string,
): Promise<TaskMembership | undefined> {
    const rows = await agentDatabaseRows<MembershipRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(TASK_MEMBERS_TABLE)}
            WHERE task_id = ${taskId} AND member_id = ${memberId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : membershipFromRow(rows[0]);
}

/** One member's memberships in that member's own order. */
export async function readMemberships(
    ctx: Context,
    memberId: string,
): Promise<readonly TaskMembership[]> {
    const rows = await agentDatabaseRows<MembershipRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(TASK_MEMBERS_TABLE)}
            WHERE member_id = ${memberId} ORDER BY order_key, task_id`,
    );
    return rows.map(membershipFromRow);
}

export async function insertMembership(ctx: Context, membership: TaskMembership): Promise<void> {
    assertMembership(membership);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(TASK_MEMBERS_TABLE)} (task_id, member_id, order_key, joined_at)
            VALUES (${membership.taskId}, ${membership.memberId}, ${membership.orderKey},
                ${membership.joinedAt})`,
    );
}

export async function updateMembershipOrder(
    ctx: Context,
    membership: TaskMembership,
): Promise<void> {
    assertMembership(membership);
    await agentDatabaseRun(
        ctx.db,
        sql`UPDATE ${sql.raw(TASK_MEMBERS_TABLE)} SET order_key = ${membership.orderKey}
            WHERE task_id = ${membership.taskId} AND member_id = ${membership.memberId}`,
    );
}

export async function deleteMembership(
    ctx: Context,
    taskId: string,
    memberId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(TASK_MEMBERS_TABLE)}
            WHERE task_id = ${taskId} AND member_id = ${memberId}`,
    );
}

function membershipFromRow(row: MembershipRow): TaskMembership {
    const membership: TaskMembership = {
        taskId: row.task_id,
        memberId: row.member_id,
        orderKey: row.order_key,
        joinedAt: Number(row.joined_at),
    };
    assertMembership(membership);
    return membership;
}

function assertMembership(membership: unknown): asserts membership is TaskMembership {
    if (!Value.Check(taskMembershipSchema, membership)) {
        throw new Error("Task storage contains an invalid membership.");
    }
}

async function readOne(ctx: Context, where: SQL): Promise<TaskRecord | undefined> {
    const rows = await agentDatabaseRows<TaskRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(TASKS_TABLE)} WHERE ${where} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : taskFromRow(rows[0]);
}

function taskFromRow(row: TaskRow): TaskRecord {
    const task: TaskRecord = {
        id: row.id,
        name: row.name,
        folderName: row.folder_name,
        ...(row.owner_user_id === null ? {} : { ownerUserId: row.owner_user_id }),
        ...(row.creator_agent_id === null ? {} : { creatorAgentId: row.creator_agent_id }),
        workspaceId: row.workspace_id,
        workspaceVersion: Number(row.workspace_version),
        workspaceUpdatedAt: Number(row.workspace_updated_at),
        agentId: row.agent_id,
        path: row.path,
        ...(row.runner_id === null ? {} : { runnerId: row.runner_id }),
        status: row.status as TaskRecord["status"],
        version: Number(row.version),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    };
    assertTask(task);
    return task;
}

function assertTask(task: unknown): asserts task is TaskRecord {
    if (!Value.Check(taskRecordSchema, task)) {
        throw new Error("Task storage contains an invalid task.");
    }
}
