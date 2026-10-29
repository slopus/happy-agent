import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const STORIES_TABLE = "happy_agent_stories";
export const STORY_SEEN_TABLE = "happy_agent_story_seen";
export const STORY_REACTIONS_TABLE = "happy_agent_story_reactions";
export const STORY_PARTICIPATION_TABLE = "happy_agent_story_participation";
export const STORY_PEOPLE_TABLE = "happy_agent_story_people";

/**
 * One row per story: who it belongs to, where it came from, its state, and its current content,
 * which is also the latest `story.json` of its artifact. A person key is a team user's ID, or
 * `standalone` for the one person of a standalone installation.
 *
 * Seen state is one mark per viewer and author: the newest story of that author the viewer saw,
 * by `posted_at`. Reactions are one per viewer and story. Participation records when each person
 * last wrote in each conversation, which ranking reads instead of scanning history.
 */
export const storyMigrations: readonly AgentModuleMigration[] = [
    [
        "001-stories",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(STORIES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    author_key TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_by_json TEXT NOT NULL,
                    source_agent_id TEXT,
                    source_tool_call_id TEXT,
                    content_json TEXT NOT NULL,
                    artifact_version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    posted_at INTEGER,
                    expires_at INTEGER,
                    version TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX happy_agent_stories_source
                    ON ${sql.raw(STORIES_TABLE)} (source_agent_id, source_tool_call_id)
                    WHERE source_tool_call_id IS NOT NULL`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_stories_author
                    ON ${sql.raw(STORIES_TABLE)} (author_key, created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_stories_posted
                    ON ${sql.raw(STORIES_TABLE)} (status, expires_at)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(STORY_SEEN_TABLE)} (
                    viewer_key TEXT NOT NULL,
                    author_key TEXT NOT NULL,
                    story_id TEXT NOT NULL,
                    posted_at INTEGER NOT NULL,
                    seen_at INTEGER NOT NULL,
                    PRIMARY KEY (viewer_key, author_key)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_story_seen_author
                    ON ${sql.raw(STORY_SEEN_TABLE)} (author_key, posted_at)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(STORY_REACTIONS_TABLE)} (
                    story_id TEXT NOT NULL,
                    viewer_key TEXT NOT NULL,
                    emoji TEXT NOT NULL,
                    reacted_at INTEGER NOT NULL,
                    PRIMARY KEY (story_id, viewer_key)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(STORY_PARTICIPATION_TABLE)} (
                    agent_id TEXT NOT NULL,
                    person_key TEXT NOT NULL,
                    last_at INTEGER NOT NULL,
                    PRIMARY KEY (agent_id, person_key)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_story_participation_person
                    ON ${sql.raw(STORY_PARTICIPATION_TABLE)} (person_key, last_at)`,
            );
        },
    ],
    /**
     * Agents' stories. `agent_author` names the agent whose story it is, while `author_key` stays
     * the person it was posted for and the only one who reads it. `ring_agent_id` is the task's or
     * bot's agent whose ring wears it, and `ended_at` is set once it leaves that ring. A repost
     * names the agent's story it started from. Seen marks for rings reuse the seen table with the
     * ring's key in `author_key`.
     *
     * Each conversation's person is also kept here, so a subtask nobody wrote in posts for its
     * nearest ancestor's person.
     */
    [
        "002-agent-stories",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            for (const column of [
                "agent_author TEXT",
                "ring_agent_id TEXT",
                "supersedes_json TEXT NOT NULL DEFAULT '[]'",
                "ended_at INTEGER",
                "end_reason TEXT",
                "repost_of_json TEXT",
            ]) {
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE ${sql.raw(STORIES_TABLE)} ADD COLUMN ${sql.raw(column)}`,
                );
            }
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_stories_ring
                    ON ${sql.raw(STORIES_TABLE)} (ring_agent_id, ended_at, posted_at)
                    WHERE ring_agent_id IS NOT NULL`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(STORY_PEOPLE_TABLE)} (
                    agent_id TEXT PRIMARY KEY,
                    person_key TEXT
                )`,
            );
        },
    ],
];
