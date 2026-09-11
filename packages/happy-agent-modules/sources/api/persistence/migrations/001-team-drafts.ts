import { agentDatabaseRun, type AgentModuleMigration } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

export const teamDraftMigration: AgentModuleMigration = [
    "001-team-drafts",
    async (_ctx, database) => {
        await agentDatabaseRun(
            database,
            sql`CREATE TABLE happy_agent_api_team_drafts (
                agent_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                draft_json TEXT NOT NULL,
                PRIMARY KEY (agent_id, user_id)
            )`,
        );
    },
];
