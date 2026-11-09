import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const USER_DEVICE_ENVIRONMENTS_TABLE = "happy_agent_user_device_environments";

/**
 * One row per person and device: the device's kind, its reported environment as compact JSON,
 * when that environment last changed, and when the device last reported at all.
 */
export const userEnvironmentMigrations: readonly AgentModuleMigration[] = [
    [
        "001-user-device-environments",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(USER_DEVICE_ENVIRONMENTS_TABLE)} (
                    owner_id TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    device_kind TEXT,
                    environment_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    reported_at INTEGER NOT NULL,
                    PRIMARY KEY (owner_id, device_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${USER_DEVICE_ENVIRONMENTS_TABLE}_reported`)}
                    ON ${sql.raw(USER_DEVICE_ENVIRONMENTS_TABLE)} (owner_id, reported_at)`,
            );
        },
    ],
];
