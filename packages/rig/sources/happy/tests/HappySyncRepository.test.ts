import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { sessionEvents, sessions } from "../../persistence/database/schema.js";
import { createSessionDatabaseFixture } from "../../persistence/database/tests/createSessionDatabaseFixture.js";
import { HappySyncRepository } from "../HappySyncRepository.js";
import { HappyMessageMapper } from "../mapSessionEventToHappyMessages.js";
import type { SessionEvent } from "../../protocol/index.js";
import { isDatabaseFailure } from "../../persistence/isDatabaseFailure.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";

const directories: string[] = [];
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;
const ctx = createTestRootContext().named("happy-sync-repository-test");

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("HappySyncRepository", () => {
    it("atomically records one initial backfill even after its outbox has drained", async () => {
        const { repository } = await createRepository();
        const historical = createMessage("historical");
        const repeated = createMessage("repeated");
        const initial = await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        expect(initial.historyBackfilled).toBe(false);

        await repository.enqueueInitialBackfill(ctx, "session-1", [historical]);
        expect((await repository.getSession(ctx, "session-1"))?.historyBackfilled).toBe(true);
        await repository.acknowledge(ctx, "session-1", [historical.localId]);
        await repository.enqueueInitialBackfill(ctx, "session-1", [repeated]);

        expect(await repository.pending(ctx, "session-1")).toEqual([]);
        await repository.close(ctx);
    });

    it("rolls back the initial-backfill marker when its bounded enqueue fails", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await repository.close(ctx);
        const bounded = await HappySyncRepository.open(
            createTestRootContext(),
            databasePath,
            Date.now,
            1,
        );
        await expect(
            bounded.enqueueInitialBackfill(ctx, "session-1", [
                createMessage("historical-1"),
                createMessage("historical-2"),
            ]),
        ).rejects.toThrow("Happy sync outbox is full");

        expect((await bounded.getSession(ctx, "session-1"))?.historyBackfilled).toBe(false);
        expect(await bounded.pending(ctx, "session-1")).toEqual([]);
        await bounded.close(ctx);
    });

    it("acknowledges the Happy outbox with the operation context", async () => {
        const ctx = createTestRootContext().named("happy-outbox-acknowledge");
        const { repository } = await createRepository();
        const message = createMessage("message-1");

        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await repository.enqueue(ctx, "session-1", [message]);
        await repository.acknowledge(ctx, "session-1", [message.localId]);

        expect(await repository.pending(ctx, "session-1")).toEqual([]);
        await repository.close(ctx);
    });

    it("rejects new messages without deleting pending delivery work when the outbox is full", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.close(ctx);
        const bounded = await HappySyncRepository.open(
            createTestRootContext(),
            databasePath,
            Date.now,
            2,
        );
        const first = createMessage("message-1");
        const second = createMessage("message-2");
        await bounded.enqueue(ctx, "session-1", [first, second]);

        await expect(
            bounded.enqueue(ctx, "session-1", [createMessage("message-3")]),
        ).rejects.toThrow("Happy sync outbox is full");
        expect(await bounded.pending(ctx, "session-1")).toEqual([first, second]);
        await bounded.close(ctx);
    });

    it("durably defers the exact next projection behind a full delivery window", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.close(ctx);
        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        await opened.ctx.tx
            .insert(sessionEvents)
            .values([
                {
                    createdAtMs: 1,
                    dataJson: "{}",
                    eventId: "event-history",
                    sessionId: "session-1",
                    type: "session_updated",
                },
                {
                    createdAtMs: 2,
                    dataJson: "{}",
                    eventId: "event-x",
                    sessionId: "session-1",
                    type: "session_updated",
                },
            ])
            .run();
        await opened.database.close(opened.ctx);

        const bounded = await HappySyncRepository.open(
            createTestRootContext(),
            databasePath,
            Date.now,
            1,
        );
        await bounded.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const historical = createMessage("historical");
        await bounded.enqueueInitialBackfill(ctx, "session-1", [historical], "event-history");
        await bounded.acknowledge(ctx, "session-1", [historical.localId]);
        const filler = createMessage("filler");
        await bounded.enqueue(ctx, "session-1", [filler]);

        await expect(
            bounded.enqueueProjection(ctx, "session-1", "event-x", [createMessage("x")]),
        ).resolves.toEqual({ deferred: true, status: "projected" });
        expect((await bounded.getSession(ctx, "session-1"))?.projectedEventId).toBe("event-x");
        await bounded.close(ctx);

        const restarted = await HappySyncRepository.open(
            createTestRootContext(),
            databasePath,
            Date.now,
            1,
        );
        expect(await restarted.pending(ctx, "session-1")).toEqual([filler]);
        await restarted.acknowledge(ctx, "session-1", [filler.localId]);
        expect(await restarted.pending(ctx, "session-1")).toEqual([createMessage("x")]);
        expect(
            (await restarted.pending(ctx, "session-1")).map((message) => message.localId),
        ).not.toContain("historical");
        await restarted.close(ctx);
    });

    it("advances zero-output events and preserves stateful mapper output in event order", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.close(ctx);
        const events: SessionEvent[] = [
            event("session_updated", "history", {}),
            event("run_started", "run-started", { runId: "run-1" }),
            event("message_submitted", "agent-header", {
                delivery: "run",
                displayText: "Delegated work",
                message: {
                    blocks: [{ text: "Delegated work", type: "text" }],
                    id: "agent-header",
                    provenance: "agent",
                    role: "user",
                },
                runId: "run-1",
            }),
            event("agent_event", "iteration", {
                event: { iteration: 1, messageId: "agent-1", type: "inference_iteration_start" },
                runId: "run-1",
            }),
        ];
        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        await opened.ctx.tx
            .insert(sessionEvents)
            .values(
                events.map((source, index) => ({
                    createdAtMs: index + 1,
                    dataJson: JSON.stringify(source.data),
                    eventId: source.id,
                    sessionId: source.sessionId,
                    type: source.type,
                })),
            )
            .run();
        await opened.database.close(opened.ctx);

        const bounded = await HappySyncRepository.open(
            createTestRootContext(),
            databasePath,
            Date.now,
            2,
        );
        await bounded.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await bounded.enqueueInitialBackfill(ctx, "session-1", [], "history");
        const filler = createMessage("filler");
        await bounded.enqueue(ctx, "session-1", [filler]);
        const mapper = new HappyMessageMapper();
        const runStarted = mapper.map(events[1]!);
        const header = mapper.map(events[2]!);
        const iteration = mapper.map(events[3]!);
        expect(runStarted).toEqual([]);
        expect(header).toEqual([]);
        expect(iteration.map((message) => message.content.ev.t)).toEqual(["service", "turn-start"]);

        await expect(
            bounded.enqueueProjection(ctx, "session-1", events[1]!.id, runStarted),
        ).resolves.toMatchObject({ status: "projected" });
        await expect(
            bounded.enqueueProjection(ctx, "session-1", events[2]!.id, header),
        ).resolves.toMatchObject({ status: "projected" });
        await expect(
            bounded.enqueueProjection(ctx, "session-1", events[3]!.id, iteration),
        ).resolves.toEqual({ deferred: true, status: "projected" });
        expect((await bounded.getSession(ctx, "session-1"))?.projectedEventId).toBe("iteration");

        expect(await bounded.pending(ctx, "session-1")).toEqual([filler]);
        await bounded.acknowledge(ctx, "session-1", [filler.localId]);
        expect(
            (await bounded.pending(ctx, "session-1")).map((message) => message.content.ev.t),
        ).toEqual(["service", "turn-start"]);
        await bounded.close(ctx);
    });

    it("durably stalls an oversized event and prevents later events from leapfrogging it", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.close(ctx);
        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        await opened.ctx.tx
            .insert(sessionEvents)
            .values(
                ["history", "oversized", "later"].map((eventId, index) => ({
                    createdAtMs: index + 1,
                    dataJson: "{}",
                    eventId,
                    sessionId: "session-1",
                    type: "session_updated",
                })),
            )
            .run();
        await opened.database.close(opened.ctx);
        const bounded = await HappySyncRepository.open(
            createTestRootContext(),
            databasePath,
            Date.now,
            1,
        );
        await bounded.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await bounded.enqueueInitialBackfill(ctx, "session-1", [], "history");

        await expect(
            bounded.enqueueProjection(ctx, "session-1", "oversized", [
                createMessage("one"),
                createMessage("two"),
            ]),
        ).resolves.toMatchObject({ status: "stalled" });
        await expect(
            bounded.enqueueProjection(ctx, "session-1", "later", []),
        ).resolves.toMatchObject({ cause: "event_too_large", status: "stalled" });
        expect(await bounded.getSession(ctx, "session-1")).toMatchObject({
            projectedEventId: "history",
            projectionError:
                "One Rig event produces more Happy messages than the bounded recovery queue can retain.",
            projectionStatus: "stalled",
        });
        expect(await bounded.pending(ctx, "session-1")).toEqual([]);
        await bounded.close(ctx);
    });

    it("keeps a random session key and remote cursor across daemon restarts", async () => {
        const { databasePath, repository } = await createRepository();
        const first = await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await repository.setRemoteSession(ctx, "session-1", "remote-1");
        await repository.updateLastRemoteSeq(ctx, "session-1", 12);
        await repository.close(ctx);

        const reopened = await HappySyncRepository.open(createTestRootContext(), databasePath);
        const second = await reopened.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(second.encryptionKey).toEqual(first.encryptionKey);
        expect(second).toMatchObject({ lastRemoteSeq: 12, remoteSessionId: "remote-1" });
        await reopened.close(ctx);
    });

    it("never moves the remote sequence backwards", async () => {
        const { repository } = await createRepository();
        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        await repository.updateLastRemoteSeq(ctx, "session-1", 12);
        await repository.updateLastRemoteSeq(ctx, "session-1", 5);

        expect((await repository.getSession(ctx, "session-1"))?.lastRemoteSeq).toBe(12);
        await repository.close(ctx);
    });

    it("rotates remote state when the authenticated Happy account changes", async () => {
        const { repository } = await createRepository();
        const first = await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await repository.setRemoteSession(ctx, "session-1", "remote-1");
        await repository.enqueue(ctx, "session-1", [createMessage("encrypted-for-account-1")]);

        const rotated = await repository.ensureSession(ctx, {
            credentialFingerprint: "account-2",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(rotated.remoteSessionId).toBeUndefined();
        expect(rotated.encryptionKey).not.toEqual(first.encryptionKey);
        expect(await repository.pending(ctx, "session-1")).toEqual([]);
        await repository.close(ctx);
    });

    it("lists only sessions mapped for the active Happy credentials", async () => {
        const { repository } = await createRepository();
        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(await repository.sessionIds(ctx, "account-1", { activeSinceMs: 0 })).toEqual([
            "session-1",
        ]);
        expect(await repository.sessionIds(ctx, "account-2", { activeSinceMs: 0 })).toEqual([]);
        await repository.close(ctx);
    });

    it("restores only live, recently active sessions and keeps the batch bounded", async () => {
        const { databasePath, repository } = await createRepository(() => NOW);
        await insertSessions(databasePath, [
            { archived: true, id: "archived", updatedAtMs: NOW - HOUR_MS },
            { id: "subagent", sessionKind: "subagent", updatedAtMs: NOW - HOUR_MS },
            { id: "stale", updatedAtMs: NOW - 30 * DAY_MS },
            { id: "recent", updatedAtMs: NOW - 2 * DAY_MS },
            { id: "chatting", lastMessageAtMs: NOW - HOUR_MS, updatedAtMs: NOW - 30 * DAY_MS },
        ]);
        for (const sessionId of [
            "archived",
            "chatting",
            "recent",
            "session-1",
            "stale",
            "subagent",
        ]) {
            await repository.ensureSession(ctx, {
                credentialFingerprint: "account-1",
                encryptionVariant: "dataKey",
                sessionId,
            });
        }

        expect(await repository.sessionIds(ctx, "account-1")).toEqual(["chatting", "recent"]);
        expect(await repository.sessionIds(ctx, "account-1", { limit: 1 })).toEqual(["chatting"]);
        expect(await repository.sessionIds(ctx, "account-1", { activeSinceMs: 0 })).toEqual([
            "chatting",
            "recent",
            "stale",
            "session-1",
        ]);
        await repository.close(ctx);
    });

    it("rolls back session rotation when clearing the stale outbox fails", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const pending = createMessage("encrypted-for-account-1");
        await repository.enqueue(ctx, "session-1", [pending]);
        await repository.close(ctx);

        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        await opened.ctx.tx.run(
            sql.raw(`
            CREATE TRIGGER reject_happy_outbox_delete
            BEFORE DELETE ON happy_outbox
            BEGIN
                SELECT RAISE(ABORT, 'forced outbox delete failure');
            END
        `),
        );
        await opened.database.close(opened.ctx);

        const reopened = await HappySyncRepository.open(createTestRootContext(), databasePath);
        const failure = await reopened
            .ensureSession(ctx, {
                credentialFingerprint: "account-2",
                encryptionKey: new Uint8Array(32).fill(2),
                encryptionVariant: "dataKey",
                sessionId: "session-1",
            })
            .then(
                () => undefined,
                (error: unknown) => error,
            );
        expect(isDatabaseFailure(failure)).toBe(true);
        expect((await reopened.getSession(ctx, "session-1"))?.credentialFingerprint).toBe(
            "account-1",
        );
        expect(await reopened.pending(ctx, "session-1")).toEqual([pending]);
        await reopened.close(ctx);
    });
});

function createMessage(localId: string) {
    return {
        content: {
            ev: { t: "service" as const, text: localId },
            id: localId,
            role: "agent" as const,
            time: 1,
        },
        localId,
        meta: { sentFrom: "rig" as const },
        role: "session" as const,
    };
}

function event(type: SessionEvent["type"], id: string, data: unknown): SessionEvent {
    return { createdAt: 1, data, id, sessionId: "session-1", type } as SessionEvent;
}

async function createRepository(now: () => number = Date.now) {
    const directory = await mkdtemp(join(tmpdir(), "rig-happy-repository-"));
    directories.push(directory);
    const databasePath = join(directory, "sessions.sqlite");
    await createSessionDatabaseFixture(databasePath);
    return {
        databasePath,
        repository: await HappySyncRepository.open(createTestRootContext(), databasePath, now),
    };
}

/*
 * The restore query joins the owning session rows, so the scope it has to reject
 * only exists once those rows do.
 */
async function insertSessions(
    databasePath: string,
    rows: readonly {
        archived?: boolean;
        id: string;
        lastMessageAtMs?: number;
        sessionKind?: string;
        updatedAtMs: number;
    }[],
): Promise<void> {
    const opened = await openSessionDatabase(createTestRootContext(), databasePath);
    for (const row of rows) {
        await opened.ctx.tx
            .insert(sessions)
            .values({
                agentId: `agent-${row.id}`,
                archived: row.archived ?? false,
                createdAtMs: 1,
                cwd: "/workspace",
                depth: 0,
                elapsedMs: 0,
                id: row.id,
                interrupted: false,
                ...(row.lastMessageAtMs === undefined
                    ? {}
                    : { lastMessageAtMs: row.lastMessageAtMs }),
                modelId: "model",
                ownerInstanceId: "alocalinstance00000000001",
                modelsJson: "[]",
                nextTaskId: 1,
                orderKey: `a-${row.id}`,
                permissionMode: "workspace_write",
                projectId: "project-1",
                providerId: "codex",
                rootSessionId: row.id,
                secretIdsJson: "[]",
                sessionKind: row.sessionKind ?? "primary",
                status: "idle",
                tasksJson: "[]",
                titleStatus: "idle",
                toolsJson: "[]",
                totalTokens: 0,
                trackUnread: false,
                updatedAtMs: row.updatedAtMs,
                workflowsEnabled: true,
                workflowsJson: "[]",
            })
            .run();
    }
    await opened.database.close(opened.ctx);
}
