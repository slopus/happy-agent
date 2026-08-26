import { agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

export const BOTS_TABLE = "happy_agent_module_bots";
export const BOT_AVATARS_TABLE = "happy_agent_module_bot_avatars";

export const botMigrations = [
    [
        "001-bots-catalog",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOTS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    username TEXT NOT NULL UNIQUE,
                    workspace_id TEXT NOT NULL UNIQUE,
                    workspace_version INTEGER NOT NULL,
                    workspace_updated_at BIGINT NOT NULL,
                    agent_id TEXT NOT NULL UNIQUE,
                    path TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL,
                    avatar_source TEXT,
                    avatar_thumbhash TEXT,
                    order_key TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${BOTS_TABLE}_order`)}
                    ON ${sql.raw(BOTS_TABLE)} (order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOT_AVATARS_TABLE)} (
                    bot_id TEXT PRIMARY KEY,
                    image_bytes BLOB NOT NULL,
                    content_type TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    thumbhash TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                )`,
            );
        },
    ],
] as const;
