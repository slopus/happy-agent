import { agentDatabaseRun, type AgentModuleMigration } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

export const viewersMigrations: readonly AgentModuleMigration[] = [
    [
        "001-viewers",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_viewers (target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL, user_id TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
                    PRIMARY KEY (target_type, target_id, user_id))`,
            );
        },
    ],
];
