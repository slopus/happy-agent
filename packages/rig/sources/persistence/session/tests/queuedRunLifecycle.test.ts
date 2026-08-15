import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createEventIdFactory } from "../../../protocol/index.js";
import type {
    PersistedQueuedRun,
    PersistedSessionMessage,
} from "../../../session/InMemorySession.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projects, sessionCredentialBindings, sessions } from "../../database/schema.js";
import { querySessionRestore } from "../querySessionRestore.js";
import {
    sessionAcceptQueuedRun,
    type SessionAcceptQueuedRunInput,
} from "../sessionAcceptQueuedRun.js";
import { sessionFailQueuedRun } from "../sessionFailQueuedRun.js";
import { sessionStartQueuedRun } from "../sessionStartQueuedRun.js";
import { inTx } from "../../inTx.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

describe("queued run lifecycle persistence", () => {
    it("accepts the queue row, visible message, event, and session status atomically", async () => {
        const opened = await createDatabase();
        const accepted = fixture();

        await sessionAcceptQueuedRun(opened.ctx, accepted);

        expect(await counts(opened.ctx)).toEqual({ events: 1, messages: 1, queued: 1 });
        expect(await sessionState(opened.ctx)).toMatchObject({
            activeRunId: null,
            status: "queued",
            workspaceQueueWaiting: 1,
        });
        await opened.database.close(opened.ctx);
    });

    it("rolls every accepted-submission row back with its surrounding action", async () => {
        const opened = await createDatabase();
        const accepted = fixture();

        await expect(
            inTx(opened.ctx, "rig.sql.test.queued_run.accept_rollback", async (ctx) => {
                await sessionAcceptQueuedRun(ctx, accepted);
                throw new Error("submission response could not commit");
            }),
        ).rejects.toThrow("submission response could not commit");

        expect(await counts(opened.ctx)).toEqual({ events: 0, messages: 0, queued: 0 });
        expect(await sessionState(opened.ctx)).toMatchObject({
            activeRunId: null,
            status: "idle",
            workspaceQueueWaiting: 0,
        });
        await opened.database.close(opened.ctx);
    });

    it("moves an accepted run into the active slot without a durable gap", async () => {
        const opened = await createDatabase();
        const accepted = fixture();
        await sessionAcceptQueuedRun(opened.ctx, accepted);
        await opened.ctx.tx.update(sessions).set({ workspaceQueueWaiting: true }).run();
        const started = {
            activeSince: 3,
            event: {
                createdAt: 3,
                data: { runId: accepted.run.runId },
                id: createEventIdFactory()(),
                sessionId: accepted.sessionId,
                type: "run_started" as const,
            },
            now: 3,
            runId: accepted.run.runId,
            sessionId: accepted.sessionId,
        };

        await sessionStartQueuedRun(opened.ctx, started);

        expect(await counts(opened.ctx)).toEqual({ events: 2, messages: 1, queued: 0 });
        expect(await sessionState(opened.ctx)).toMatchObject({
            activeRunId: accepted.run.runId,
            status: "running",
            workspaceQueueWaiting: 0,
        });
        await opened.database.close(opened.ctx);
    });

    it("keeps the queued run when starting or failing cannot commit", async () => {
        const opened = await createDatabase();
        const accepted = fixture();
        await sessionAcceptQueuedRun(opened.ctx, accepted);

        await expect(
            inTx(opened.ctx, "rig.sql.test.queued_run.start_rollback", async (ctx) => {
                await sessionStartQueuedRun(ctx, {
                    activeSince: 3,
                    event: {
                        createdAt: 3,
                        data: { runId: accepted.run.runId },
                        id: createEventIdFactory()(),
                        sessionId: accepted.sessionId,
                        type: "run_started",
                    },
                    now: 3,
                    runId: accepted.run.runId,
                    sessionId: accepted.sessionId,
                });
                throw new Error("runtime handoff could not commit");
            }),
        ).rejects.toThrow("runtime handoff could not commit");
        expect(await counts(opened.ctx)).toEqual({ events: 1, messages: 1, queued: 1 });

        await expect(
            inTx(opened.ctx, "rig.sql.test.queued_run.fail_rollback", async (ctx) => {
                await sessionFailQueuedRun(ctx, {
                    event: {
                        createdAt: 4,
                        data: {
                            errorMessage: "Workspace initialization failed.",
                            modelLocked: true,
                            runId: accepted.run.runId,
                        },
                        id: createEventIdFactory()(),
                        sessionId: accepted.sessionId,
                        type: "run_error",
                    },
                    now: 4,
                    runId: accepted.run.runId,
                    sessionId: accepted.sessionId,
                });
                throw new Error("failure event could not commit");
            }),
        ).rejects.toThrow("failure event could not commit");
        expect(await counts(opened.ctx)).toEqual({ events: 1, messages: 1, queued: 1 });
        expect(await sessionState(opened.ctx)).toMatchObject({
            activeRunId: null,
            status: "queued",
        });
        await opened.database.close(opened.ctx);
    });

    it("clears the durable workspace wait when a queued run fails", async () => {
        const opened = await createDatabase();
        const accepted = fixture();
        await sessionAcceptQueuedRun(opened.ctx, accepted);
        await opened.ctx.tx.update(sessions).set({ workspaceQueueWaiting: true }).run();

        await sessionFailQueuedRun(opened.ctx, {
            event: {
                createdAt: 5,
                data: {
                    errorMessage: "Workspace initialization failed.",
                    modelLocked: true,
                    runId: accepted.run.runId,
                },
                id: createEventIdFactory()(),
                sessionId: accepted.sessionId,
                type: "run_error",
            },
            now: 5,
            runId: accepted.run.runId,
            sessionId: accepted.sessionId,
        });

        expect(await sessionState(opened.ctx)).toMatchObject({
            activeRunId: null,
            status: "error",
            workspaceQueueWaiting: 0,
        });
        await opened.database.close(opened.ctx);
    });

    it("restores structured debug request content from the durable user message", async () => {
        const opened = await createDatabase();
        const accepted = fixture();
        const blocks = [
            { text: "Inspect this image.", type: "text" as const },
            {
                data: "aGVsbG8=",
                mediaType: "image/png" as const,
                type: "image" as const,
            },
        ];
        accepted.run.debug = true;
        accepted.run.debugRequestContent = blocks;
        accepted.run.userMessage = {
            ...accepted.run.userMessage,
            blocks,
        };
        accepted.message.message = accepted.run.userMessage;
        accepted.event.data.message = accepted.run.userMessage;
        await sessionAcceptQueuedRun(opened.ctx, accepted);

        expect((await querySessionRestore(opened.ctx, accepted.sessionId))?.restore).toMatchObject({
            queuedRuns: [
                {
                    debug: true,
                    debugRequestContent: blocks,
                },
            ],
            workspaceQueueWaiting: true,
        });
        await opened.database.close(opened.ctx);
    });
});

function fixture(): SessionAcceptQueuedRunInput {
    const runId = "run-1";
    const userMessage = {
        blocks: [{ text: "Wait for the workspace.", type: "text" as const }],
        id: "submission-1",
        role: "user" as const,
    };
    const run: PersistedQueuedRun = {
        displayText: "Wait for the workspace.",
        kind: "user",
        runId,
        text: "Wait for the workspace.",
        userMessage,
    };
    const message: PersistedSessionMessage = {
        isPartial: false,
        message: userMessage,
        position: 0,
        runId,
    };
    return {
        event: {
            createdAt: 2,
            data: {
                delivery: "run" as const,
                displayText: "Wait for the workspace.",
                message: userMessage,
                runId,
            },
            id: createEventIdFactory()(),
            sessionId: "session-1",
            type: "message_submitted" as const,
        },
        message,
        now: 2,
        run,
        sessionId: "session-1",
        status: "queued" as const,
        workspaceQueueWaiting: true,
    };
}

async function counts(ctx: Awaited<ReturnType<typeof createDatabase>>["ctx"]) {
    return await ctx.tx.get<{ events: number; messages: number; queued: number }>(sql`
        SELECT
            (SELECT COUNT(*) FROM session_events) AS events,
            (SELECT COUNT(*) FROM session_messages) AS messages,
            (SELECT COUNT(*) FROM queued_runs) AS queued
    `);
}

async function sessionState(ctx: Awaited<ReturnType<typeof createDatabase>>["ctx"]) {
    return await ctx.tx.get<{
        activeRunId: string | null;
        status: string;
        workspaceQueueWaiting: number;
    }>(sql`
        SELECT active_run_id AS activeRunId, status,
            workspace_queue_waiting AS workspaceQueueWaiting
        FROM sessions
        WHERE id = 'session-1'
    `);
}

async function createDatabase() {
    const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
    await migrateSessionDatabase(opened.ctx);
    await opened.ctx.tx
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id: "project-1",
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: "Workspace",
            nameKey: "workspace",
            nameSource: "folder",
            orderKey: "a0",
            path: "/workspace",
            presence: "present",
            storageKey: "workspace",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "unknown",
        })
        .run();
    await opened.ctx.tx
        .insert(sessions)
        .values({
            agentId: "agent-1",
            archived: false,
            createdAtMs: 1,
            cwd: "/workspace",
            depth: 0,
            elapsedMs: 0,
            id: "session-1",
            interrupted: false,
            modelId: "model",
            ownerInstanceId: "alocalinstance00000000001",
            modelsJson: "[]",
            nextTaskId: 1,
            orderKey: "a0",
            permissionMode: "workspace_write",
            projectId: "project-1",
            providerId: "codex",
            rootSessionId: "session-1",
            secretIdsJson: "[]",
            sessionKind: "primary",
            status: "idle",
            tasksJson: "[]",
            titleStatus: "idle",
            toolsJson: "[]",
            totalTokens: 0,
            trackUnread: false,
            updatedAtMs: 1,
            workflowsEnabled: true,
            workflowsJson: "[]",
        })
        .run();
    await opened.ctx.tx
        .insert(sessionCredentialBindings)
        .values({
            bindingId: "alocalinstance00000000001:codex",
            sessionId: "session-1",
        })
        .run();
    return opened;
}
