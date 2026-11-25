import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { ViewerTarget } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * Record that a person was at a target at `at`, keeping a later moment already stored, and return
 * the moment now stored.
 */
export async function saveViewerLastSeen(
    ctx: Context,
    target: ViewerTarget,
    userId: string,
    at: number,
): Promise<number> {
    const rows = await agentDatabaseRows<{ last_seen_at: number }>(
        ctx.db,
        sql`INSERT INTO happy_agent_viewers (target_type, target_id, user_id, last_seen_at)
            VALUES (${target.type}, ${target.id}, ${userId}, ${at})
            ON CONFLICT (target_type, target_id, user_id)
            DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
            RETURNING last_seen_at`,
    );
    return Number(rows[0]!.last_seen_at);
}

/**
 * Move a stored last-seen moment later, keeping a later one, and return the moment now stored.
 * Undefined when nothing is stored, because the target was deleted.
 */
export async function touchViewerLastSeen(
    ctx: Context,
    target: ViewerTarget,
    userId: string,
    at: number,
): Promise<number | undefined> {
    const rows = await agentDatabaseRows<{ last_seen_at: number }>(
        ctx.db,
        sql`UPDATE happy_agent_viewers SET last_seen_at = MAX(last_seen_at, ${at})
            WHERE target_type = ${target.type} AND target_id = ${target.id} AND user_id = ${userId}
            RETURNING last_seen_at`,
    );
    return rows[0] === undefined ? undefined : Number(rows[0].last_seen_at);
}

export async function hasViewerLastSeen(
    ctx: Context,
    target: ViewerTarget,
    userId: string,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ found: number }>(
        ctx.db,
        sql`SELECT 1 AS found FROM happy_agent_viewers
            WHERE target_type = ${target.type} AND target_id = ${target.id} AND user_id = ${userId}`,
    );
    return rows.length > 0;
}

/** Everyone ever seen at a target, newest first, at most `limit`. */
export async function queryViewerLastSeen(
    ctx: Context,
    target: ViewerTarget,
    limit: number,
): Promise<{ userId: string; lastSeenAt: number }[]> {
    const rows = await agentDatabaseRows<{ user_id: string; last_seen_at: number }>(
        ctx.db,
        sql`SELECT user_id, last_seen_at FROM happy_agent_viewers
            WHERE target_type = ${target.type} AND target_id = ${target.id}
            ORDER BY last_seen_at DESC, user_id LIMIT ${limit}`,
    );
    return rows.map((row) => ({ userId: row.user_id, lastSeenAt: Number(row.last_seen_at) }));
}

export async function deleteViewerTarget(ctx: Context, target: ViewerTarget): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_viewers
            WHERE target_type = ${target.type} AND target_id = ${target.id}`,
    );
}
