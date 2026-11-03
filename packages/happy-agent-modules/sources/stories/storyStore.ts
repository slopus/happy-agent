import { open } from "node:fs/promises";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { storyLayersSchema, storyMediaLayerInputSchema } from "@slopus/happy-agent-client";
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
/** One media layer: its own stored file and its own placement, never composed into another. */
export const storyMediaLayerRecordSchema = Type.Composite([
    Type.Object({ id: Type.String(), media: mediaSchema }),
    Type.Omit(storyMediaLayerInputSchema, ["uploadId"]),
]);
export type StoryMediaLayerRecord = Static<typeof storyMediaLayerRecordSchema>;

/**
 * A story as stored: what is served, plus the snapshots its media is kept under. A repost names
 * the story it reposts and its reposter (`null` standalone), and copies where that was posted.
 */
export const storyRecordSchema = Type.Object({
    id: Type.String(),
    agentId: Type.Union([Type.String(), Type.Null()]),
    taskId: Type.Union([Type.String(), Type.Null()]),
    botId: Type.Union([Type.String(), Type.Null()]),
    caption: Type.Union([Type.String(), Type.Null()]),
    media: mediaSchema,
    repostOf: Type.Optional(Type.String()),
    userId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    round: Type.Optional(mediaSchema),
    layers: Type.Optional(storyLayersSchema),
    /** In paint order; a repost holds the original's layers, then its own, by reference. */
    mediaLayers: Type.Optional(Type.Array(storyMediaLayerRecordSchema)),
    postedAt: Type.Integer(),
    expiresAt: Type.Integer(),
});
export type StoryRecord = Static<typeof storyRecordSchema>;

// This history belongs to stories-v2, not the retired prototype's "stories" ledger.
// Adopt the same tables from 0.4.111 previews without clearing their rows.
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

/** Bytes at an offset of an MP4 being checked; fewer at its end. */
type ReadMp4 = (at: number, length: number) => Promise<Buffer>;

/** The most box headers one check reads, so a file of tiny boxes cannot keep it busy. */
const MAX_MP4_BOXES = 100_000;

/** An MP4 opens with its ftyp box, and an H.264 track is an avc1 or avc3 sample entry. */
export async function isH264Mp4(bytes: Uint8Array): Promise<boolean> {
    const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return await hasH264Track(async (at, length) => file.subarray(at, at + length), file.length);
}

/**
 * What a stored file can be as story media, from its box headers alone, never its frame data:
 * an ISO box file is an H.264 video, an AVIF picture, or refused; anything else may be a picture.
 */
export async function storedMediaKind(path: string): Promise<"video" | "avif" | "image" | "none"> {
    const handle = await open(path, "r");
    try {
        const read: ReadMp4 = async (at, length) => {
            const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, at);
            return buffer.subarray(0, bytesRead);
        };
        const head = (await read(4, 8)).toString("latin1");
        if (!head.startsWith("ftyp")) return "image";
        if (/^ftypavi[fs]$/u.test(head)) return "avif";
        return (await hasH264Track(read, (await handle.stat()).size)) ? "video" : "none";
    } finally {
        await handle.close();
    }
}

async function hasH264Track(read: ReadMp4, length: number): Promise<boolean> {
    let boxes = 0;
    const scan = async (start: number, end: number, path: readonly string[]): Promise<boolean> => {
        for (let at = start; at + 8 <= end; ) {
            if (++boxes > MAX_MP4_BOXES) return false;
            const head = await read(at, 16);
            if (head.length < 8) return false;
            const wide = head.readUInt32BE(0) === 1,
                header = wide ? 16 : 8;
            if (at + header > end || head.length < header) return false;
            const size = wide ? Number(head.readBigUInt64BE(8)) : head.readUInt32BE(0) || end - at;
            if (size < header || size > end - at) return false;
            const kind = head.toString("latin1", 4, 8);
            if (
                kind === path[0] &&
                (path.length === 1 ||
                    (await scan(at + header + (kind === "stsd" ? 8 : 0), at + size, path.slice(1))))
            )
                return true;
            at += size;
        }
        return false;
    };
    if ((await read(4, 4)).toString("latin1") !== "ftyp") return false;
    for (const kind of ["avc1", "avc3"])
        if (await scan(0, length, ["moov", "trak", "mdia", "minf", "stbl", "stsd", kind]))
            return true;
    return false;
}
