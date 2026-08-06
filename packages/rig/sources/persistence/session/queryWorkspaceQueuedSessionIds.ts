import { and, asc, eq, min } from "drizzle-orm";

import { queuedRuns, sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Sessions whose durable FIFO must be reconsidered after one workspace lifecycle event. */
export function queryWorkspaceQueuedSessionIds(tx: TX, workspaceId: string): readonly string[] {
    return tx
        .select({
            firstQueuedAtMs: min(queuedRuns.createdAtMs),
            id: sessions.id,
        })
        .from(sessions)
        .innerJoin(queuedRuns, eq(queuedRuns.sessionId, sessions.id))
        .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.workspaceQueueWaiting, true)))
        .groupBy(sessions.id)
        .orderBy(asc(min(queuedRuns.createdAtMs)), asc(sessions.createdAtMs), asc(sessions.id))
        .all()
        .map((row) => row.id);
}
