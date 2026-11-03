import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * Record an edit to a document by one actor at `at`. Returns true when it starts a new edit
 * session: the actor had not edited the document for `idleMs`. Ended sessions are dropped.
 */
export async function touchFeedEditSession(
    ctx: Context,
    surfaceId: string,
    actor: string,
    at: number,
    idleMs: number,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ last_at: number }>(
        ctx.db,
        sql`SELECT last_at FROM happy_agent_feed_edit_sessions
            WHERE surface_id = ${surfaceId} AND actor = ${actor}`,
    );
    const started = rows[0] === undefined || at - rows[0].last_at >= idleMs;
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_feed_edit_sessions WHERE last_at <= ${at - idleMs}`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_feed_edit_sessions (surface_id, actor, last_at)
            VALUES (${surfaceId}, ${actor}, ${at})
            ON CONFLICT(surface_id, actor) DO UPDATE SET last_at = MAX(last_at, excluded.last_at)`,
    );
    return started;
}
