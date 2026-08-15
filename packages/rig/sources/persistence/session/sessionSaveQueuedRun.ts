import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { queuedRuns } from "../database/schema.js";
import type { PersistedQueuedRun } from "../../session/InMemorySession.js";

export async function sessionSaveQueuedRun(
    ctx: Context,
    sessionId: string,
    run: PersistedQueuedRun,
    createdAt: number,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.session_save_queued_run", async (ctx) => {
        const tx = ctx.tx;
        const integrationConfigJson =
            run.effort === undefined &&
            run.modelId === undefined &&
            run.providerId === undefined &&
            run.serviceTier === undefined &&
            run.systemPrompt === undefined
                ? null
                : JSON.stringify({
                      ...(run.effort === undefined ? {} : { effort: run.effort }),
                      ...(run.modelId === undefined ? {} : { modelId: run.modelId }),
                      ...(run.providerId === undefined ? {} : { providerId: run.providerId }),
                      ...(run.serviceTier === undefined ? {} : { serviceTier: run.serviceTier }),
                      ...(run.systemPrompt === undefined ? {} : { systemPrompt: run.systemPrompt }),
                  });
        await tx
            .insert(queuedRuns)
            .values({
                createdAtMs: createdAt,
                debug: run.debug === true,
                debugDirectory: run.debugDirectory ?? null,
                displayText: run.displayText,
                integrationConfigJson,
                kind: run.kind,
                runId: run.runId,
                sessionId,
                text: run.text,
                userMessageJson: JSON.stringify(run.userMessage),
            })
            .onConflictDoUpdate({
                set: {
                    debug: sql`excluded.debug`,
                    debugDirectory: sql`excluded.debug_directory`,
                    displayText: sql`excluded.display_text`,
                    integrationConfigJson: sql`excluded.integration_config_json`,
                    kind: sql`excluded.kind`,
                    text: sql`excluded.text`,
                    userMessageJson: sql`excluded.user_message_json`,
                },
                target: [queuedRuns.sessionId, queuedRuns.runId],
            })
            .run();
    });
}
