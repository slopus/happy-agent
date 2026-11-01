import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

const mediaSchema = Type.Object({
    kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
    name: Type.String(),
    mimeType: Type.String(),
    size: Type.Integer(),
    sha256: Type.String(),
});

/**
 * A story as stored: what is served, plus the snapshots its media is kept under. A repost names
 * the story it reposts and its reposter (`null` standalone), and copies where that was posted.
 */
export const storyRecordSchema = Type.Object({
    id: Type.String(),
    agentId: Type.String(),
    taskId: Type.Union([Type.String(), Type.Null()]),
    botId: Type.Union([Type.String(), Type.Null()]),
    caption: Type.Union([Type.String(), Type.Null()]),
    media: mediaSchema,
    repostOf: Type.Optional(Type.String()),
    userId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    round: Type.Optional(mediaSchema),
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
    [
        // Each reply, by the person who wrote it (`NULL` standalone).
        "002-story-replies",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_agent_module_story_replies (id TEXT PRIMARY KEY,
                    story_id TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL,
                    created_at INTEGER NOT NULL)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX happy_agent_module_story_replies_story
                    ON happy_agent_module_story_replies(story_id, created_at)`,
            );
        },
    ],
];

/** Insert a new story, dropping ended ones. */
export async function insertStory(ctx: Context, story: StoryRecord): Promise<void> {
    for (const table of ["happy_agent_module_story_seen", "happy_agent_module_story_replies"]) {
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(table)} WHERE story_id IN
                (SELECT id FROM happy_agent_module_stories WHERE expires_at <= ${story.postedAt})`,
        );
    }
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

/** End a story and its reposts at once, forgetting who saw them and their replies. */
export async function endStories(ctx: Context, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE happy_agent_module_stories SET expires_at = 0 WHERE id = ${id}`,
        );
        for (const table of ["happy_agent_module_story_seen", "happy_agent_module_story_replies"]) {
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(table)} WHERE story_id = ${id}`,
            );
        }
    }
}

export async function seenCount(ctx: Context, id: string): Promise<number> {
    const rows = await agentDatabaseRows<{ count: number }>(
        ctx.db,
        sql`SELECT COUNT(*) AS count FROM happy_agent_module_story_seen WHERE story_id = ${id}`,
    );
    return Number(rows[0]?.count ?? 0);
}

export async function insertReply(ctx: Context, reply: StoryReply): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_module_story_replies(id, story_id, user_id, text, created_at)
            VALUES (${reply.id}, ${reply.storyId}, ${reply.userId}, ${reply.text}, ${reply.createdAt})`,
    );
}

/** How many replies a story has, and the latest `limit` of them, oldest first. */
export async function readReplies(ctx: Context, storyId: string, limit: number) {
    const rows = await agentDatabaseRows<{
        id: string;
        user_id: string | null;
        text: string;
        created_at: number;
    }>(
        ctx.db,
        sql`SELECT id, user_id, text, created_at FROM happy_agent_module_story_replies
            WHERE story_id = ${storyId} ORDER BY created_at DESC, id DESC`,
    );
    const replies: StoryReply[] = rows
        .slice(0, limit)
        .reverse()
        .map((row) => ({
            id: row.id,
            storyId,
            userId: row.user_id,
            text: row.text,
            createdAt: Number(row.created_at),
        }));
    return { count: rows.length, replies };
}

export type StoryReply = {
    readonly id: string;
    readonly storyId: string;
    readonly userId: string | null;
    readonly text: string;
    readonly createdAt: number;
};

/** An MP4 opens with its ftyp box, and an H.264 track is an avc1 or avc3 sample entry. */
export function isH264Mp4(bytes: Uint8Array): boolean {
    const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const avc = file.includes("avc1") || file.includes("avc3");
    return file.toString("latin1", 4, 8) === "ftyp" && avc;
}
