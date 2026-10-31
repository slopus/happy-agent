import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { storyRecordSchema, type StoryRecord } from "./Story.js";

export const storyMigrations: readonly AgentModuleMigration[] = [
    [
        // Each story artifact's posting state, keyed by its poster, and who opened it.
        "001-stories",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_module_stories (artifact_id TEXT PRIMARY KEY,
                    poster TEXT NOT NULL, posted_at INTEGER NOT NULL, record TEXT NOT NULL)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_module_story_seen (artifact_id TEXT NOT NULL,
                    member_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
                    PRIMARY KEY (artifact_id, member_id))`,
            );
        },
    ],
];

/** Stories posted since `since`, newest first; one poster's when named. */
export async function readStories(
    ctx: Context,
    since: number,
    poster?: string,
): Promise<StoryRecord[]> {
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT record FROM happy_agent_module_stories WHERE posted_at >= ${since}
            ${poster === undefined ? sql`` : sql`AND poster = ${poster}`} ORDER BY posted_at DESC`,
    );
    return rows.map((row) => Value.Parse(storyRecordSchema, JSON.parse(row.record)));
}

export async function readStory(
    ctx: Context,
    artifactId: string,
): Promise<StoryRecord | undefined> {
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT record FROM happy_agent_module_stories WHERE artifact_id = ${artifactId}`,
    );
    return rows[0] && Value.Parse(storyRecordSchema, JSON.parse(rows[0].record));
}

export async function writeStory(ctx: Context, poster: string, story: StoryRecord): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_module_stories(artifact_id, poster, posted_at, record)
            VALUES (${story.artifactId}, ${poster}, ${story.postedAt}, ${JSON.stringify(story)})
            ON CONFLICT(artifact_id) DO UPDATE SET record = excluded.record`,
    );
}

/** Who opened the story, oldest first. */
export async function readSeen(ctx: Context, artifactId: string) {
    const rows = await agentDatabaseRows<{ member_id: string; seen_at: number | string }>(
        ctx.db,
        sql`SELECT member_id, seen_at FROM happy_agent_module_story_seen
            WHERE artifact_id = ${artifactId} ORDER BY seen_at, member_id`,
    );
    return rows.map((row) => ({ memberId: row.member_id, seenAt: Number(row.seen_at) }));
}

/** Whether this was the member's first look. */
export async function markSeen(ctx: Context, artifactId: string, memberId: string) {
    const rows = await agentDatabaseRows<{ artifact_id: string }>(
        ctx.db,
        sql`INSERT OR IGNORE INTO happy_agent_module_story_seen(artifact_id, member_id, seen_at)
            VALUES (${artifactId}, ${memberId}, ${Date.now()}) RETURNING artifact_id`,
    );
    return rows.length > 0;
}
