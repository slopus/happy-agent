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
    [
        "002-feed-references",
        async (_ctx, db) => {
            // Entries name their newest change instead of copying the subject's title, Surface
            // type, todo text, or agent. A change's `verb` becomes `latest.type`; only an
            // artifact's version survives from the snapshot, since todo IDs and document entries
            // were never recorded.
            await agentDatabaseRun(
                db,
                sql`UPDATE happy_agent_feed_changes SET record = json_set(
                    json_remove(record, '$.snapshot', '$.verb'), '$.latest',
                    json(CASE WHEN json_type(record, '$.snapshot.artifactVersion') = 'integer'
                        THEN json_object('type', json_extract(record, '$.verb'),
                            'artifactVersion', json_extract(record, '$.snapshot.artifactVersion'))
                        ELSE json_object('type', json_extract(record, '$.verb')) END))
                    WHERE json_type(record, '$.verb') IS NOT NULL`,
            );
            // An entry's newest change is the one at its cursor. Should the log no longer hold
            // it, the entry's own snapshot says what kind of change it was.
            await agentDatabaseRun(
                db,
                sql`UPDATE happy_agent_feed_items SET record = json_set(
                    json_remove(record, '$.snapshot'), '$.latest',
                    json(COALESCE(
                        (SELECT json_extract(c.record, '$.latest') FROM happy_agent_feed_changes c
                            WHERE c.id = happy_agent_feed_items.cursor),
                        CASE
                            WHEN subject_type = 'artifact' THEN json_object(
                                'type', CASE WHEN json_extract(record, '$.updates') > 0
                                    THEN 'artifact.updated' ELSE 'artifact.created' END,
                                'artifactVersion',
                                json_extract(record, '$.snapshot.artifactVersion'))
                            WHEN subject_type = 'surface'
                                AND json_extract(record, '$.updates') > 0
                                THEN json_object('type',
                                    CASE json_extract(record, '$.snapshot.surfaceType')
                                        WHEN 'document' THEN 'document.edited'
                                        ELSE 'todo.created' END)
                            ELSE json_object('type', subject_type || '.created')
                        END)))
                    WHERE json_type(record, '$.snapshot') IS NOT NULL`,
            );
        },
    ],
];
