import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createEventIdFactory } from "../../../protocol/index.js";
import type {
    PersistedQueuedRun,
    PersistedSessionMessage,
} from "../../../session/InMemorySession.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projects, sessions } from "../../database/schema.js";
import { querySessionRestore } from "../querySessionRestore.js";
import {
    sessionAcceptQueuedRun,
    type SessionAcceptQueuedRunInput,
} from "../sessionAcceptQueuedRun.js";
import { sessionFailQueuedRun } from "../sessionFailQueuedRun.js";
import { sessionStartQueuedRun } from "../sessionStartQueuedRun.js";

describe("queued run lifecycle persistence", () => {
    it("accepts the queue row, visible message, event, and session status atomically", () => {
        const opened = createDatabase();
        const accepted = fixture();

        sessionAcceptQueuedRun(opened.database, accepted);

        expect(counts(opened.database)).toEqual({ events: 1, messages: 1, queued: 1 });
        expect(sessionState(opened.database)).toMatchObject({
            activeRunId: null,
            status: "queued",
            workspaceQueueWaiting: 1,
        });
        opened.client.close();
    });

    it("rolls every accepted-submission row back with its surrounding action", () => {
        const opened = createDatabase();
        const accepted = fixture();

        expect(() =>
            opened.database.transaction((tx) => {
                sessionAcceptQueuedRun(tx, accepted);
                throw new Error("submission response could not commit");
            }),
        ).toThrow("submission response could not commit");

        expect(counts(opened.database)).toEqual({ events: 0, messages: 0, queued: 0 });
        expect(sessionState(opened.database)).toMatchObject({
            activeRunId: null,
            status: "idle",
            workspaceQueueWaiting: 0,
        });
        opened.client.close();
    });

    it("moves an accepted run into the active slot without a durable gap", () => {
        const opened = createDatabase();
        const accepted = fixture();
        sessionAcceptQueuedRun(opened.database, accepted);
        opened.database.update(sessions).set({ workspaceQueueWaiting: true }).run();
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

        sessionStartQueuedRun(opened.database, started);

        expect(counts(opened.database)).toEqual({ events: 2, messages: 1, queued: 0 });
        expect(sessionState(opened.database)).toMatchObject({
            activeRunId: accepted.run.runId,
            status: "running",
            workspaceQueueWaiting: 0,
        });
        opened.client.close();
    });

    it("keeps the queued run when starting or failing cannot commit", () => {
        const opened = createDatabase();
        const accepted = fixture();
        sessionAcceptQueuedRun(opened.database, accepted);

        expect(() =>
            opened.database.transaction((tx) => {
                sessionStartQueuedRun(tx, {
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
        ).toThrow("runtime handoff could not commit");
        expect(counts(opened.database)).toEqual({ events: 1, messages: 1, queued: 1 });

        expect(() =>
            opened.database.transaction((tx) => {
                sessionFailQueuedRun(tx, {
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
        ).toThrow("failure event could not commit");
        expect(counts(opened.database)).toEqual({ events: 1, messages: 1, queued: 1 });
        expect(sessionState(opened.database)).toMatchObject({
            activeRunId: null,
            status: "queued",
        });
        opened.client.close();
    });

    it("clears the durable workspace wait when a queued run fails", () => {
        const opened = createDatabase();
        const accepted = fixture();
        sessionAcceptQueuedRun(opened.database, accepted);
        opened.database.update(sessions).set({ workspaceQueueWaiting: true }).run();

        sessionFailQueuedRun(opened.database, {
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

        expect(sessionState(opened.database)).toMatchObject({
            activeRunId: null,
            status: "error",
            workspaceQueueWaiting: 0,
        });
        opened.client.close();
    });

    it("restores structured debug request content from the durable user message", () => {
        const opened = createDatabase();
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
        sessionAcceptQueuedRun(opened.database, accepted);

        expect(querySessionRestore(opened.database, accepted.sessionId)?.restore).toMatchObject({
            queuedRuns: [
                {
                    debug: true,
                    debugRequestContent: blocks,
                },
            ],
            workspaceQueueWaiting: true,
        });
        opened.client.close();
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

function counts(database: ReturnType<typeof createDatabase>["database"]) {
    return database.get<{ events: number; messages: number; queued: number }>(sql`
        SELECT
            (SELECT COUNT(*) FROM session_events) AS events,
            (SELECT COUNT(*) FROM session_messages) AS messages,
            (SELECT COUNT(*) FROM queued_runs) AS queued
    `);
}

function sessionState(database: ReturnType<typeof createDatabase>["database"]) {
    return database.get<{
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

function createDatabase() {
    const opened = openSessionDatabase(":memory:");
    migrateSessionDatabase(opened.database);
    opened.database
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
    opened.database
        .insert(sessions)
        .values({
            agentId: "agent-1",
            archived: false,
            createdAtMs: 1,
            cwd: "/workspace",
            depth: 0,
            durableSkillsJson: "[]",
            elapsedMs: 0,
            externalToolsJson: "[]",
            id: "session-1",
            interrupted: false,
            modelId: "model",
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
    return opened;
}
