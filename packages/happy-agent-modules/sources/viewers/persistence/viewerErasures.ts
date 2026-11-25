import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { ViewerTarget } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * Erasures are numbered in commit order. One is kept only while a request that read the erasures
 * before it may still be checking access, so the numbers keep growing after every record is gone.
 */
export async function recordViewerErasure(ctx: Context, target: ViewerTarget): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_viewer_erasures (target_type, target_id)
            VALUES (${target.type}, ${target.id})`,
    );
}

/** The number of the latest erasure kept, or 0; every later one is numbered above it. */
export async function latestViewerErasure(ctx: Context): Promise<number> {
    const rows = await agentDatabaseRows<{ seq: number | null }>(
        ctx.db,
        sql`SELECT MAX(seq) AS seq FROM happy_agent_viewer_erasures`,
    );
    return Number(rows[0]?.seq ?? 0);
}

/** Whether the target was erased after the erasure numbered `seen`. */
export async function viewerErasedSince(
    ctx: Context,
    target: ViewerTarget,
    seen: number,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ found: number }>(
        ctx.db,
        sql`SELECT 1 AS found FROM happy_agent_viewer_erasures
            WHERE seq > ${seen} AND target_type = ${target.type} AND target_id = ${target.id}
            LIMIT 1`,
    );
    return rows.length > 0;
}

/** Drop the erasures numbered `through` and below. */
export async function pruneViewerErasures(ctx: Context, through: number): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_viewer_erasures WHERE seq <= ${through}`,
    );
}
