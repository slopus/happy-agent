import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { CHAT_UI_ATTEMPTS_TABLE, CHAT_UI_NOTES_TABLE } from "../ChatUiMigrations.js";

/** `pending` while the hook runs; then what it decided, or `failed`. */
export type ChatUiAttemptStatus = "pending" | "accepted" | "rejected" | "failed";

/** One attempt's row: which component it was sent to, when, and whether it has settled. */
export interface ChatUiAttempt {
    readonly agentId: string;
    readonly id: string;
    readonly uiId: string;
    readonly componentId: string;
    readonly status: ChatUiAttemptStatus;
    readonly createdAt: number;
}

interface AttemptRow {
    agent_id: string;
    id: string;
    ui_id: string;
    component_id: string;
    status: string;
    created_at: number | string;
}

export async function insertChatUiAttempt(ctx: Context, attempt: ChatUiAttempt): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)} (
                agent_id, id, ui_id, component_id, status, created_at
            ) VALUES (
                ${attempt.agentId}, ${attempt.id}, ${attempt.uiId}, ${attempt.componentId},
                ${attempt.status}, ${attempt.createdAt}
            )`,
    );
}

export async function settleChatUiAttempt(
    ctx: Context,
    agentId: string,
    id: string,
    status: ChatUiAttemptStatus,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`UPDATE ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)}
            SET status = ${status}
            WHERE agent_id = ${agentId} AND id = ${id}`,
    );
}

export async function queryChatUiAttempt(
    ctx: Context,
    agentId: string,
    id: string,
): Promise<ChatUiAttempt | undefined> {
    const rows = await agentDatabaseRows<AttemptRow>(
        ctx.db,
        sql`SELECT agent_id, id, ui_id, component_id, status, created_at
            FROM ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)}
            WHERE agent_id = ${agentId} AND id = ${id}`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
        agentId: row.agent_id,
        id: row.id,
        uiId: row.ui_id,
        componentId: row.component_id,
        status: row.status as ChatUiAttemptStatus,
        createdAt: Number(row.created_at),
    };
}

/** How many attempts one component received since `since`. */
export async function countChatUiAttempts(
    ctx: Context,
    agentId: string,
    uiId: string,
    componentId: string,
    since: number,
): Promise<number> {
    const rows = await agentDatabaseRows<{ count: number | string }>(
        ctx.db,
        sql`SELECT COUNT(*) AS count FROM ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)}
            WHERE agent_id = ${agentId} AND ui_id = ${uiId} AND component_id = ${componentId}
              AND created_at >= ${since}`,
    );
    return Number(rows[0]?.count ?? 0);
}

export async function insertChatUiNote(ctx: Context, agentId: string, text: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(CHAT_UI_NOTES_TABLE)} (agent_id, text)
            VALUES (${agentId}, ${text})`,
    );
}

/** Take every note waiting for one conversation, in the order they were left, removing them. */
export async function takeChatUiNotes(ctx: Context, agentId: string): Promise<string[]> {
    const rows = await agentDatabaseRows<{ text: string }>(
        ctx.db,
        sql`SELECT text FROM ${sql.raw(CHAT_UI_NOTES_TABLE)}
            WHERE agent_id = ${agentId}
            ORDER BY sequence ASC`,
    );
    if (rows.length === 0) return [];
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(CHAT_UI_NOTES_TABLE)} WHERE agent_id = ${agentId}`,
    );
    return rows.map((row) => row.text);
}
