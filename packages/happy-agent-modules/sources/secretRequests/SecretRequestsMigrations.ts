import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const SECRET_ACTION_SAVES_TABLE = "happy_agent_secret_action_saves";

/**
 * One row per saved secret form, keyed by the client's save ID: which element it answered and
 * what the save did, so a retry answers the first save instead of saving again. Never a value.
 */
export const secretRequestsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-secret-action-saves",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(SECRET_ACTION_SAVES_TABLE)} (
                    id TEXT NOT NULL PRIMARY KEY,
                    artifact_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    element TEXT NOT NULL,
                    secret_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )`,
            );
        },
    ],
];
