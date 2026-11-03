import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { FeedSubject } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { feedItemRecordSchema, type FeedItemRecord } from "../FeedRecords.js";

export async function insertFeedItem(ctx: Context, item: FeedItemRecord): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_feed_items
            (id, reader, subject_type, subject_id, cursor, last_at, seen_at, record)
            VALUES (${item.id}, ${item.reader}, ${item.subject.type}, ${item.subject.id},
                ${item.cursor}, ${item.lastAt}, ${item.seenAt}, ${JSON.stringify(item)})`,
    );
}

/** Replace an entry's state; its identity, reader, and subject never change. */
export async function updateFeedItem(ctx: Context, item: FeedItemRecord): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`UPDATE happy_agent_feed_items SET cursor = ${item.cursor}, last_at = ${item.lastAt},
            seen_at = ${item.seenAt}, record = ${JSON.stringify(item)} WHERE id = ${item.id}`,
    );
}

/** A reader's entries with a cursor older than `before`, newest first, at most `limit`. */
export async function queryFeedItems(
    ctx: Context,
    reader: string,
    before: string | undefined,
    limit: number,
): Promise<FeedItemRecord[]> {
    const older = before === undefined ? sql`` : sql`AND cursor < ${before}`;
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT record FROM happy_agent_feed_items WHERE reader = ${reader} ${older}
            ORDER BY cursor DESC LIMIT ${limit}`,
    );
    return rows.map((row) => parse(row.record));
}

/** The reader's open entry for a subject. */
export async function queryOpenFeedItem(
    ctx: Context,
    reader: string,
    subject: FeedSubject,
): Promise<FeedItemRecord | undefined> {
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT record FROM happy_agent_feed_items WHERE reader = ${reader}
            AND subject_type = ${subject.type} AND subject_id = ${subject.id}
            AND seen_at IS NULL`,
    );
    return rows[0] && parse(rows[0].record);
}

/** The reader's newest entry for a subject, open or seen. */
export async function queryNewestFeedItem(
    ctx: Context,
    reader: string,
    subject: FeedSubject,
): Promise<FeedItemRecord | undefined> {
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT record FROM happy_agent_feed_items WHERE reader = ${reader}
            AND subject_type = ${subject.type} AND subject_id = ${subject.id}
            ORDER BY cursor DESC LIMIT 1`,
    );
    return rows[0] && parse(rows[0].record);
}

/** Every open entry of a reader whose cursor is not newer than `through`, oldest first. */
export async function queryOpenFeedItems(
    ctx: Context,
    reader: string,
    through: string | undefined,
): Promise<FeedItemRecord[]> {
    const bound = through === undefined ? sql`` : sql`AND cursor <= ${through}`;
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT record FROM happy_agent_feed_items WHERE reader = ${reader}
            AND seen_at IS NULL ${bound} ORDER BY cursor`,
    );
    return rows.map((row) => parse(row.record));
}

/** How many of a reader's entries are open. */
export async function queryFeedUnread(ctx: Context, reader: string): Promise<number> {
    const rows = await agentDatabaseRows<{ unread: number }>(
        ctx.db,
        sql`SELECT COUNT(*) AS unread FROM happy_agent_feed_items
            WHERE reader = ${reader} AND seen_at IS NULL`,
    );
    return Number(rows[0]?.unread ?? 0);
}

/** Whether a reader has any entry for a subject. */
export async function queryHasFeedItem(
    ctx: Context,
    reader: string,
    subject: FeedSubject,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ id: string }>(
        ctx.db,
        sql`SELECT id FROM happy_agent_feed_items WHERE reader = ${reader}
            AND subject_type = ${subject.type} AND subject_id = ${subject.id} LIMIT 1`,
    );
    return rows.length > 0;
}

/** Remove every reader's entries for a subject, returning who held each and whether it was open. */
export async function deleteFeedSubjectItems(
    ctx: Context,
    subject: FeedSubject,
): Promise<{ id: string; reader: string; open: boolean }[]> {
    const rows = await agentDatabaseRows<{ id: string; reader: string; seen_at: number | null }>(
        ctx.db,
        sql`DELETE FROM happy_agent_feed_items
            WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}
            RETURNING id, reader, seen_at`,
    );
    return rows.map((row) => ({ id: row.id, reader: row.reader, open: row.seen_at === null }));
}

/**
 * Keep a reader's newest `keep` entries and those that changed at or after `since`; return how
 * many open entries were dropped.
 */
export async function pruneFeedItems(
    ctx: Context,
    reader: string,
    keep: number,
    since: number,
): Promise<number> {
    const rows = await agentDatabaseRows<{ seen_at: number | null }>(
        ctx.db,
        sql`DELETE FROM happy_agent_feed_items WHERE reader = ${reader} AND (last_at < ${since}
            OR id IN (SELECT id FROM happy_agent_feed_items WHERE reader = ${reader}
                ORDER BY cursor DESC LIMIT -1 OFFSET ${keep}))
            RETURNING seen_at`,
    );
    return rows.filter((row) => row.seen_at === null).length;
}

function parse(record: string): FeedItemRecord {
    return Value.Parse(feedItemRecordSchema, JSON.parse(record));
}
