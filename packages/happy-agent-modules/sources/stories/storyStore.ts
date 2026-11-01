import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** A story as stored: what is served, plus the snapshot its media is kept under. */
export const storyRecordSchema = Type.Object({
    id: Type.String(),
    agentId: Type.String(),
    taskId: Type.Union([Type.String(), Type.Null()]),
    botId: Type.Union([Type.String(), Type.Null()]),
    caption: Type.Union([Type.String(), Type.Null()]),
    media: Type.Object({
        kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
        name: Type.String(),
        mimeType: Type.String(),
        size: Type.Integer(),
        sha256: Type.String(),
    }),
    postedAt: Type.Integer(),
    expiresAt: Type.Integer(),
});
export type StoryRecord = Static<typeof storyRecordSchema>;

export const storyMigrations: readonly AgentModuleMigration[] = [
    [
        // Each posted story, and one row per story and person who opened it.
        "001-stories",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_module_stories (id TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL, posted_at INTEGER NOT NULL, record TEXT NOT NULL)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_module_story_seen (story_id TEXT NOT NULL,
                    member_id TEXT NOT NULL, PRIMARY KEY (story_id, member_id))`,
            );
        },
    ],
];

/** Insert a new story, dropping ended ones. */
export async function insertStory(ctx: Context, story: StoryRecord): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_module_story_seen WHERE story_id IN
            (SELECT id FROM happy_agent_module_stories WHERE expires_at <= ${story.postedAt})`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_module_stories WHERE expires_at <= ${story.postedAt}`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_module_stories(id, expires_at, posted_at, record)
            VALUES (${story.id}, ${story.expiresAt}, ${story.postedAt}, ${JSON.stringify(story)})`,
    );
}

/** Stories that end after `now`, oldest first, with whether `member` saw each; one if `id` is named. */
export async function readLiveStories(ctx: Context, member: string, now: number, id?: string) {
    const rows = await agentDatabaseRows<{ record: string; seen: string | null }>(
        ctx.db,
        sql`SELECT s.record AS record, seen.member_id AS seen FROM happy_agent_module_stories s
            LEFT JOIN happy_agent_module_story_seen seen
                ON seen.story_id = s.id AND seen.member_id = ${member}
            WHERE s.expires_at > ${now} ${id === undefined ? sql`` : sql`AND s.id = ${id}`}
            ORDER BY s.posted_at, s.id`,
    );
    return rows.map((row) => ({
        ...Value.Parse(storyRecordSchema, JSON.parse(row.record)),
        seen: row.seen !== null,
    }));
}

export async function markStorySeen(ctx: Context, id: string, member: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT OR IGNORE INTO happy_agent_module_story_seen(story_id, member_id)
            VALUES (${id}, ${member})`,
    );
}
