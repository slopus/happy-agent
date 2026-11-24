import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const PUSH_REGISTRATIONS_TABLE = "happy_agent_push_registrations";
export const PUSH_SETTINGS_TABLE = "happy_agent_push_settings";

/**
 * One row per phone a person registered, holding the relay capability that reaches it; the unique
 * pair keeps a person to one registration per phone. A settings row exists only once a person has
 * chosen.
 */
export const pushMigrations: readonly AgentModuleMigration[] = [
    [
        "001-push",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PUSH_REGISTRATIONS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    version TEXT NOT NULL,
                    token TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    app_id TEXT NOT NULL,
                    locale TEXT,
                    expires_at INTEGER NOT NULL,
                    UNIQUE (owner_id, token)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PUSH_SETTINGS_TABLE)} (
                    owner_id TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL
                )`,
            );
        },
    ],
];
