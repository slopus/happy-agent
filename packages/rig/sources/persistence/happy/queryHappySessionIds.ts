import { asc, eq } from "drizzle-orm";

import { happySessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryHappySessionIds(tx: TX, credentialFingerprint: string): readonly string[] {
    return tx
        .select({ sessionId: happySessions.sessionId })
        .from(happySessions)
        .where(eq(happySessions.credentialFingerprint, credentialFingerprint))
        .orderBy(asc(happySessions.createdAtMs), asc(happySessions.sessionId))
        .all()
        .map((row) => row.sessionId);
}
