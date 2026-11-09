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
 * offer it answered, its action with every secret left out, and its outcome. The open-offer rule,
 * the rate limit, and the restart sweep read these rows instead of history JSON. Notes wait here
 * for the conversation's next turn.
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
                    message_id TEXT NOT NULL,
                    ui_id TEXT NOT NULL,
                    component_id TEXT NOT NULL,
                    action_type TEXT NOT NULL,
                    once INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    person_message_id TEXT,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (agent_id, id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_chat_ui_attempts_offer
                    ON ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)} (agent_id, ui_id, component_id, created_at)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_chat_ui_attempts_status
                    ON ${sql.raw(CHAT_UI_ATTEMPTS_TABLE)} (status)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(CHAT_UI_NOTES_TABLE)} (
                    agent_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (agent_id, id)
                )`,
            );
        },
    ],
];
