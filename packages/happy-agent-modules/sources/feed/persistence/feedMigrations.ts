import { agentDatabaseRun, type AgentModuleMigration } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

export const feedMigrations: readonly AgentModuleMigration[] = [
    [
        "001-feed",
        async (_ctx, db) => {
            // The shared log. `audience_users` is a JSON array of user IDs, or NULL for everyone.
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_feed_changes (id TEXT PRIMARY KEY,
                    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
                    occurred_at INTEGER NOT NULL, audience_users TEXT, record TEXT NOT NULL)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX happy_agent_feed_changes_subject
                    ON happy_agent_feed_changes(subject_type, subject_id)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX happy_agent_feed_changes_occurred
                    ON happy_agent_feed_changes(occurred_at)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_feed_change_clusters (cluster TEXT NOT NULL,
                    change_id TEXT NOT NULL, PRIMARY KEY (cluster, change_id))`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX happy_agent_feed_change_clusters_change
                    ON happy_agent_feed_change_clusters(change_id)`,
            );
            // Each reader's entries. At most one open entry per reader and subject.
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_feed_items (id TEXT PRIMARY KEY, reader TEXT NOT NULL,
                    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, cursor TEXT NOT NULL,
                    last_at INTEGER NOT NULL, seen_at INTEGER, record TEXT NOT NULL)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX happy_agent_feed_items_reader
                    ON happy_agent_feed_items(reader, cursor)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX happy_agent_feed_items_subject
                    ON happy_agent_feed_items(subject_type, subject_id, reader, cursor)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE UNIQUE INDEX happy_agent_feed_items_open
                    ON happy_agent_feed_items(reader, subject_type, subject_id)
                    WHERE seen_at IS NULL`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_feed_readers (reader TEXT PRIMARY KEY,
                    joined_at INTEGER NOT NULL, joined_cursor TEXT)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_feed_subscriptions (reader TEXT NOT NULL,
                    cluster TEXT NOT NULL, state TEXT NOT NULL, since INTEGER NOT NULL,
                    PRIMARY KEY (reader, cluster))`,
            );
            // Open document edit sessions, one per document and actor.
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_feed_edit_sessions (surface_id TEXT NOT NULL,
                    actor TEXT NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (surface_id, actor))`,
            );
        },
    ],
];
