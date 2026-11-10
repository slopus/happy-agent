import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const CHAT_UI_ATTEMPTS_TABLE = "happy_agent_chat_ui_attempts";
export const CHAT_UI_NOTES_TABLE = "happy_agent_chat_ui_notes";

/**
 * One row per chat UI attempt, beside its service record in history: the idempotency key, the
 * component it was sent to, when, and whether its hook has settled. The rate limit and the restart
 * sweep read these rows instead of history JSON; the action itself lives only in the record. Notes
 * wait in their own table for the conversation's next turn, in the order they were left.
 */
export const chatUiMigrations: readonly AgentModuleMigration[] = [
    [
        "001-chat-ui",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    ui_id TEXT NOT NULL,
                    component_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (agent_id, id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_chat_ui_attempts_component
                    ON ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)} (agent_id, ui_id, component_id, created_at)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(CHAT_UI_NOTES_TABLE)} (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id TEXT NOT NULL,
                    text TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_chat_ui_notes_agent
                    ON ${sql.raw(CHAT_UI_NOTES_TABLE)} (agent_id, sequence)`,
            );
        },
    ],
];
