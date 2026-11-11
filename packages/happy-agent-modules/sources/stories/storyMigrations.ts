import { agentDatabaseRun, type AgentModuleMigration } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

// Historical migrations only. Stories is retired and the runtime does not load this owner.
// Keep released migration identities and SQL unchanged; existing data is left untouched.
export const storyMigrations: readonly AgentModuleMigration[] = [
    [
        // Each posted story, and one row per story and person who opened it.
        "001-stories",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_module_stories (id TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL, posted_at INTEGER NOT NULL, record TEXT NOT NULL)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_module_story_seen (story_id TEXT NOT NULL,
                    member_id TEXT NOT NULL, PRIMARY KEY (story_id, member_id))`,
            );
        },
    ],
    [
        // Each reply, by the person who wrote it (`NULL` standalone).
        "002-story-replies",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_module_story_replies (id TEXT PRIMARY KEY,
                    story_id TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL,
                    created_at INTEGER NOT NULL)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_module_story_replies_story
                    ON happy_agent_module_story_replies(story_id, created_at)`,
            );
        },
    ],
    [
        "003-remove-retired-stories",
        async (_ctx, db) => {
            // The abandoned prototype is not imported into the rebuilt feed. Remove its
            // tables and retired ledger together; the current feed's module_* tables stay.
            for (const table of [
                "happy_agent_story_people",
                "happy_agent_story_participation",
                "happy_agent_story_reactions",
                "happy_agent_story_seen",
                "happy_agent_stories",
            ]) {
                await agentDatabaseRun(db, sql`DROP TABLE IF EXISTS ${sql.raw(table)}`);
            }
            await agentDatabaseRun(
                db,
                sql`DELETE FROM happy_agent_migrations WHERE module_key = 'stories'`,
            );
        },
    ],
];
