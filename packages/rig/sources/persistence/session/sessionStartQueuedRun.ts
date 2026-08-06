import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { sessionAppendEvent } from "./sessionAppendEvent.js";
import { sessionDeleteQueuedRun } from "./sessionDeleteQueuedRun.js";

export interface SessionStartQueuedRunInput {
    activeSince: number;
    event: Extract<SessionEvent, { type: "run_started" }>;
    now: number;
    runId: string;
    sessionId: string;
}

/** Moves one run from the durable FIFO into the active slot without a crash-visible gap. */
export function sessionStartQueuedRun(tx: TX, input: SessionStartQueuedRunInput): void {
    inTx(tx, (tx) => {
        sessionDeleteQueuedRun(tx, input.sessionId, input.runId);
        sessionAppendEvent(tx, input.event, { runId: input.runId }, input.now);
        tx.update(sessions)
            .set({
                activeRunId: input.runId,
                activeSinceMs: input.activeSince,
                interrupted: false,
                interruptionJson: null,
                status: "running",
                updatedAtMs: input.now,
                workspaceQueueWaiting: false,
            })
            .where(eq(sessions.id, input.sessionId))
            .run();
    });
}
