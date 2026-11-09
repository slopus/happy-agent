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
    // Previews from late October 2026 applied this before onboarding was removed; it stays as it
    // was, so their applied migrations remain a prefix of these.
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
    // Those previews stored a step-based state this module no longer reads. Their rows are
    // discarded; the next start finds the installation already in use and records it finished.
    [
        "002-onboarding-recipes",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(database, sql`DELETE FROM ${sql.raw(ONBOARDING_TABLE)}`);
        },
    ],
    // Builds with the step-graph bootstrap stored the step it stood on. The opening has no steps,
    // so those rows are discarded the same way.
    [
        "003-onboarding-opening",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(database, sql`DELETE FROM ${sql.raw(ONBOARDING_TABLE)}`);
        },
    ],
];
