import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { SessionAgentType } from "../../protocol/index.js";
import { happySessions, sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export interface HappySessionIdQuery {
    /** Lower bound on the session's last activity, so dead history stays offline. */
    activeSinceMs: number;
    credentialFingerprint: string;
    limit: number;
}

const PRIMARY_SESSION_KIND: SessionAgentType = "primary";

/*
 * Restoring Happy synchronization opens one websocket per session, so the daemon
 * only asks for the sessions it could actually reattach: primary, still live, and
 * recently active. The bound is applied in SQL because the caller would otherwise
 * hydrate every session ever synchronized just to discard it.
 */
export function queryHappySessionIds(tx: TX, query: HappySessionIdQuery): readonly string[] {
    const lastActivityMs = sql<number>`coalesce(${sessions.lastMessageAtMs}, ${sessions.updatedAtMs})`;
    return tx
        .select({ sessionId: happySessions.sessionId })
        .from(happySessions)
        .innerJoin(sessions, eq(sessions.id, happySessions.sessionId))
        .where(
            and(
                eq(happySessions.credentialFingerprint, query.credentialFingerprint),
                eq(sessions.archived, false),
                eq(sessions.sessionKind, PRIMARY_SESSION_KIND),
                gte(lastActivityMs, query.activeSinceMs),
            ),
        )
        .orderBy(desc(lastActivityMs), desc(happySessions.sessionId))
        .limit(query.limit)
        .all()
        .map((row) => row.sessionId);
}
