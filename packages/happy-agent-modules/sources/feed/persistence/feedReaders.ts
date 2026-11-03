import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { FeedReader } from "../FeedRecords.js";

/** Record that a person joined the Feed; false when they already had. */
export async function insertFeedReader(
    ctx: Context,
    reader: string,
    joinedAt: number,
    joinedCursor: string | null,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ reader: string }>(
        ctx.db,
        sql`INSERT INTO happy_agent_feed_readers (reader, joined_at, joined_cursor)
            VALUES (${reader}, ${joinedAt}, ${joinedCursor})
            ON CONFLICT(reader) DO NOTHING RETURNING reader`,
    );
    return rows.length === 1;
}

export async function queryFeedReaders(ctx: Context): Promise<FeedReader[]> {
    const rows = await agentDatabaseRows<{ reader: string; joined_cursor: string | null }>(
        ctx.db,
        sql`SELECT reader, joined_cursor FROM happy_agent_feed_readers ORDER BY reader`,
    );
    return rows.map((row) => ({ reader: row.reader, joinedCursor: row.joined_cursor }));
}
