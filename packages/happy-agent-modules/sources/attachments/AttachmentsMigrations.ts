import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const ATTACHMENTS_TABLE = "happy_agent_module_attachments";
export const ATTACHMENT_UPLOADS_TABLE = "happy_agent_module_attachment_uploads";
export const ATTACHMENT_GARBAGE_TABLE = "happy_agent_module_attachment_garbage";

/**
 * An attachment row is one file of one conversation, keyed by the conversation and the SHA-256
 * of its bytes; `sent_at` is set by the first message that sends it, which also clears
 * `expires_at`. An upload row is a chunked upload still missing bytes; `received_json` holds its
 * merged byte ranges, and `chunks` counts the requests that carried bytes to it. An attachment's
`pending_file_id` names the finished upload file its bytes are still to be stored from; storing
runs after the row commits, and maintenance finishes it after a crash. A garbage row names stored content that may be unused from `not_before` on;
 * collection deletes the bytes only when no attachment row of any conversation holds them, and keeps
the row until the bytes are gone.
 */
export const attachmentsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-attachments",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ATTACHMENTS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    thumbhash TEXT,
                    scale REAL,
                    uploaded_by TEXT,
                    created_at INTEGER NOT NULL,
                    sent_at INTEGER,
                    expires_at INTEGER,
                    PRIMARY KEY (agent_id, id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ATTACHMENTS_TABLE}_id`)}
                    ON ${sql.raw(ATTACHMENTS_TABLE)} (id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ATTACHMENTS_TABLE}_expires`)}
                    ON ${sql.raw(ATTACHMENTS_TABLE)} (expires_at)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ATTACHMENT_UPLOADS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    file_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    content_type TEXT,
                    size INTEGER NOT NULL,
                    received_json TEXT NOT NULL,
                    uploaded_by TEXT,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    PRIMARY KEY (agent_id, id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ATTACHMENT_UPLOADS_TABLE}_expires`)}
                    ON ${sql.raw(ATTACHMENT_UPLOADS_TABLE)} (expires_at)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ATTACHMENT_GARBAGE_TABLE)} (
                    sha256 TEXT PRIMARY KEY,
                    not_before INTEGER NOT NULL
                )`,
            );
        },
    ],
    [
        "002-attachment-chunks-and-publication",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ATTACHMENT_UPLOADS_TABLE)}
                    ADD COLUMN chunks INTEGER NOT NULL DEFAULT 0`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ATTACHMENTS_TABLE)} ADD COLUMN pending_file_id TEXT`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ATTACHMENTS_TABLE}_pending`)}
                    ON ${sql.raw(ATTACHMENTS_TABLE)} (pending_file_id)
                    WHERE pending_file_id IS NOT NULL`,
            );
        },
    ],
];
