import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const ONBOARDING_TABLE = "happy_agent_onboarding";

/** One row per owner (`standalone` today): the onboarding state as JSON, checked on every read. */
export const onboardingMigrations: readonly AgentModuleMigration[] = [
    [
        "001-onboarding",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ONBOARDING_TABLE)} (
                    owner_id TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )`,
            );
        },
    ],
];
