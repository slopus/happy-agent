import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { CHAT_UI_ATTEMPTS_TABLE, CHAT_UI_NOTES_TABLE } from "../ChatUiMigrations.js";

export type ChatUiAttemptStatus = "pending" | "accepted" | "rejected" | "failed";

/** One stored attempt; its payload already has every secret left out. */
export interface ChatUiAttempt {
    readonly agentId: string;
    readonly id: string;
    readonly messageId: string;
    readonly uiId: string;
    readonly componentId: string;
    readonly actionType: string;
    readonly payload: Record<string, unknown>;
    readonly status: ChatUiAttemptStatus;
    readonly createdAt: number;
}

interface AttemptRow {
    agent_id: string;
    id: string;
    message_id: string;
    ui_id: string;
    component_id: string;
    action_type: string;
    payload_json: string;
    status: string;
    created_at: number | string;
}

const COLUMNS = `agent_id, id, message_id, ui_id, component_id, action_type, payload_json, status,
    created_at`;

/**
 * Store an attempt. The `once` and `person_message_id` columns are left from message actions,
 * which are gone: every action is silent, so they are always `0` and null.
 */
export async function insertChatUiAttempt(ctx: Context, attempt: ChatUiAttempt): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)} (${sql.raw(COLUMNS)}, once) VALUES (
            ${attempt.agentId}, ${attempt.id}, ${attempt.messageId}, ${attempt.uiId},
            ${attempt.componentId}, ${attempt.actionType}, ${JSON.stringify(attempt.payload)},
            ${attempt.status}, ${attempt.createdAt}, 0
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
        sql`SELECT ${sql.raw(COLUMNS)} FROM ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)}
            WHERE agent_id = ${agentId} AND id = ${id}`,
    );
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
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

export async function insertChatUiNote(
    ctx: Context,
    agentId: string,
    id: string,
    text: string,
    createdAt: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(CHAT_UI_NOTES_TABLE)} (agent_id, id, text, created_at)
            VALUES (${agentId}, ${id}, ${text}, ${createdAt})`,
    );
}

/** Take every note waiting for one conversation, oldest first, removing them. */
export async function takeChatUiNotes(ctx: Context, agentId: string): Promise<string[]> {
    const rows = await agentDatabaseRows<{ text: string }>(
        ctx.db,
        sql`SELECT text FROM ${sql.raw(CHAT_UI_NOTES_TABLE)}
            WHERE agent_id = ${agentId}
            ORDER BY created_at ASC, id ASC`,
    );
    if (rows.length === 0) return [];
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(CHAT_UI_NOTES_TABLE)} WHERE agent_id = ${agentId}`,
    );
    return rows.map((row) => row.text);
}

function fromRow(row: AttemptRow): ChatUiAttempt {
    return {
        agentId: row.agent_id,
        id: row.id,
        messageId: row.message_id,
        uiId: row.ui_id,
        componentId: row.component_id,
        actionType: row.action_type,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        status: row.status as ChatUiAttemptStatus,
        createdAt: Number(row.created_at),
    };
}
