import { describe, expect, it } from "vitest";

import {
    createHappySyncDatabase,
    happySyncMigrations,
    MAX_HAPPY_MESSAGES_PER_EVENT,
    MAX_HAPPY_OUTBOX_MESSAGE_CHARACTERS,
    MAX_HAPPY_OUTBOX_MESSAGES,
    HappyMessageMapper,
    type HappyOutboxMessage,
} from "../../sources/happy/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const NOW = 1_700_000_000_000;

const ATTACH = {
    agentId: "agent-1",
    credentialFingerprint: "account-a",
    encryptionKeyBase64: "a2V5",
    encryptionVariant: "dataKey" as const,
    sessionId: "session-1",
};

/** Event ids are UUIDv7 in production; these sort the same way, which is all the cursor asks. */
function eventId(ordinal: number): string {
    return `01900000-0000-7000-8000-${String(ordinal).padStart(12, "0")}`;
}

function messages(count: number, prefix = "m"): HappyOutboxMessage[] {
    return Array.from({ length: count }, (_unused, index) => ({
        localId: `${prefix}-${index}`,
        payload: { index, text: "hello" },
    }));
}

async function withDatabase(
    name: string,
    body: (
        sync: ReturnType<typeof createHappySyncDatabase>,
        database: ModuleDatabase,
    ) => Promise<void>,
): Promise<void> {
    const database = moduleDatabase(happySyncMigrations, name);
    try {
        await database.ready;
        await body(createHappySyncDatabase(), database);
    } finally {
        database.close();
    }
}

describe("Happy sync storage", () => {
    it("reports an oversized rich message and continues syncing subsequent events", async () => {
        await withDatabase("happy-oversized-input", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            const mapper = new HappyMessageMapper();
            const record = {
                at: NOW,
                recordId: "requestedmessage",
                role: "user" as const,
                blocks: [
                    { type: "tool_call_request" as const, name: "list_skills" },
                    {
                        type: "image" as const,
                        mediaType: "image/png",
                        data: "AAAA".repeat(1_000_001),
                    },
                ],
            };
            const mapped = mapper.map(
                {
                    id: eventId(1),
                    agentId: ATTACH.agentId,
                    occurredAt: NOW,
                    type: "message.accepted",
                    payload: { id: record.recordId, kind: "send", runId: "run1" },
                },
                record,
            );
            expect(mapped[0]?.content).toMatchObject({
                role: "agent",
                ev: { t: "service", text: expect.stringContaining("too large to sync") },
            });
            expect(mapper.mapHistory([record])[0]?.content.ev).toEqual(mapped[0]?.content.ev);
            expect(JSON.stringify(mapped[0]).length).toBeLessThan(
                MAX_HAPPY_OUTBOX_MESSAGE_CHARACTERS,
            );
            expect(
                await sync.projectEvent(database.context, {
                    agentId: ATTACH.agentId,
                    eventId: eventId(1),
                    now: NOW,
                    messages: mapped.map((message) => ({
                        localId: message.localId,
                        payload: message,
                    })),
                }),
            ).toMatchObject({ kind: "projected" });
            expect(
                await sync.projectEvent(database.context, {
                    agentId: ATTACH.agentId,
                    eventId: eventId(2),
                    now: NOW + 1,
                    messages: messages(1),
                }),
            ).toMatchObject({ kind: "projected" });
            expect(await sync.pending(database.context, ATTACH.agentId, 10)).toHaveLength(2);
            expect(
                (await sync.readSession(database.context, ATTACH.agentId))?.projectionStatus,
            ).toBe("active");
        });
    });

    it("attaches an agent once and reports the same session again", async () => {
        await withDatabase("happy-attach", async (sync, database) => {
            const first = await sync.ensureSession(database.context, ATTACH, NOW);
            expect(first.tag).toBe("rig:session-1");
            expect(first.historyBackfilled).toBe(false);
            expect(first.projectedEventId).toBeUndefined();
            expect(first.projectionStatus).toBe("active");

            const again = await sync.ensureSession(database.context, ATTACH, NOW + 5);
            expect(again).toEqual(first);
        });
    });

    it("discards the remote identity and the queue when the account changes", async () => {
        await withDatabase("happy-rotate", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            await sync.setRemoteSession(database.context, ATTACH.agentId, "remote-1", NOW);
            await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1),
                messages: messages(2),
                now: NOW,
            });

            const rotated = await sync.ensureSession(
                database.context,
                { ...ATTACH, credentialFingerprint: "account-b" },
                NOW + 1,
            );
            expect(rotated.remoteSessionId).toBeUndefined();
            expect(rotated.projectedEventId).toBeUndefined();
            expect(await sync.pending(database.context, ATTACH.agentId, 10)).toEqual([]);
        });
    });

    it("lists the agents attached to one account, most recent first", async () => {
        await withDatabase("happy-list", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            await sync.ensureSession(
                database.context,
                { ...ATTACH, agentId: "agent-2", sessionId: "session-2" },
                NOW + 1,
            );
            await sync.ensureSession(
                database.context,
                {
                    ...ATTACH,
                    agentId: "agent-3",
                    credentialFingerprint: "account-b",
                    sessionId: "session-3",
                },
                NOW + 2,
            );

            expect(await sync.listAgentIds(database.context, "account-a", 10)).toEqual([
                "agent-2",
                "agent-1",
            ]);
        });
    });

    it("refuses to project for an agent that is not attached", async () => {
        await withDatabase("happy-unattached", async (sync, database) => {
            const outcome = await sync.projectEvent(database.context, {
                agentId: "stranger",
                eventId: eventId(1),
                messages: messages(1),
                now: NOW,
            });
            expect(outcome).toEqual({ kind: "not_attached" });
        });
    });

    it("queues an event's messages and advances the cursor past it", async () => {
        await withDatabase("happy-project", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            const outcome = await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1),
                messages: messages(2),
                now: NOW,
            });
            expect(outcome).toEqual({ deferred: false, kind: "projected" });

            const session = await sync.readSession(database.context, ATTACH.agentId);
            expect(session?.projectedEventId).toBe(eventId(1));

            const pending = await sync.pending(database.context, ATTACH.agentId, 10);
            expect(pending.map((entry) => entry.localId)).toEqual(["m-0", "m-1"]);
            expect(pending[0]?.payload).toEqual({ index: 0, text: "hello" });
        });
    });

    it("ignores an event the cursor has already passed", async () => {
        await withDatabase("happy-replay", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(2),
                messages: messages(1),
                now: NOW,
            });

            for (const ordinal of [1, 2]) {
                const outcome = await sync.projectEvent(database.context, {
                    agentId: ATTACH.agentId,
                    eventId: eventId(ordinal),
                    messages: messages(1, "replay"),
                    now: NOW,
                });
                expect(outcome).toEqual({ kind: "already_projected" });
            }
            const pending = await sync.pending(database.context, ATTACH.agentId, 10);
            expect(pending).toHaveLength(1);
        });
    });

    it("keeps the cursor in step with events that say nothing to Happy", async () => {
        await withDatabase("happy-empty", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            const outcome = await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1),
                messages: [],
                now: NOW,
            });
            expect(outcome).toEqual({ deferred: false, kind: "projected" });

            const session = await sync.readSession(database.context, ATTACH.agentId);
            expect(session?.projectedEventId).toBe(eventId(1));
            expect(await sync.pending(database.context, ATTACH.agentId, 10)).toEqual([]);
        });
    });

    it("delivers messages in the order they were produced", async () => {
        await withDatabase("happy-order", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            for (const ordinal of [1, 2, 3]) {
                await sync.projectEvent(database.context, {
                    agentId: ATTACH.agentId,
                    eventId: eventId(ordinal),
                    messages: [{ localId: `local-${ordinal}`, payload: { ordinal } }],
                    now: NOW + ordinal,
                });
            }

            const pending = await sync.pending(database.context, ATTACH.agentId, 10);
            expect(pending.map((entry) => entry.localId)).toEqual([
                "local-1",
                "local-2",
                "local-3",
            ]);
            expect(pending.map((entry) => entry.position)).toEqual([1, 2, 3]);
        });
    });

    it("queues a message the phone already holds only once", async () => {
        await withDatabase("happy-duplicate", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            for (const ordinal of [1, 2]) {
                await sync.projectEvent(database.context, {
                    agentId: ATTACH.agentId,
                    eventId: eventId(ordinal),
                    messages: [{ localId: "same", payload: { ordinal } }],
                    now: NOW,
                });
            }

            const pending = await sync.pending(database.context, ATTACH.agentId, 10);
            expect(pending.map((entry) => entry.payload)).toEqual([{ ordinal: 1 }]);
        });
    });

    it("stops the queue at a single moment that produced too many messages", async () => {
        await withDatabase("happy-too-many", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            const outcome = await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1),
                messages: messages(MAX_HAPPY_MESSAGES_PER_EVENT + 1),
                now: NOW,
            });
            expect(outcome).toEqual({ cause: "event_too_large", kind: "stalled" });

            const session = await sync.readSession(database.context, ATTACH.agentId);
            expect(session?.projectionStatus).toBe("stalled");
            expect(session?.projectedEventId).toBeUndefined();
            expect(session?.projectionError).toBeTypeOf("string");
        });
    });

    it("stops the queue at a message too large to send, and holds everything behind it", async () => {
        await withDatabase("happy-too-large", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            const stalled = await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1),
                messages: [
                    { localId: "huge", payload: "x".repeat(MAX_HAPPY_OUTBOX_MESSAGE_CHARACTERS) },
                ],
                now: NOW,
            });
            expect(stalled).toEqual({ cause: "event_too_large", kind: "stalled" });

            const behind = await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(2),
                messages: messages(1),
                now: NOW + 1,
            });
            expect(behind).toEqual({ cause: "event_too_large", kind: "stalled" });
            expect(await sync.pending(database.context, ATTACH.agentId, 10)).toEqual([]);
        });
    });

    it("defers what will not fit and releases it once the queue drains", async () => {
        await withDatabase("happy-capacity", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            // No single event may carry the whole queue, so fill it a moment at a time.
            const perEvent = MAX_HAPPY_MESSAGES_PER_EVENT;
            for (let ordinal = 0; ordinal * perEvent < MAX_HAPPY_OUTBOX_MESSAGES; ordinal += 1) {
                const remaining = MAX_HAPPY_OUTBOX_MESSAGES - ordinal * perEvent;
                const outcome = await sync.projectEvent(database.context, {
                    agentId: ATTACH.agentId,
                    eventId: eventId(ordinal + 1),
                    messages: messages(Math.min(perEvent, remaining), `bulk-${ordinal}`),
                    now: NOW,
                });
                expect(outcome).toEqual({ deferred: false, kind: "projected" });
            }

            const overflow = await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1_000),
                messages: [{ localId: "late", payload: { late: true } }],
                now: NOW + 1,
            });
            expect(overflow).toEqual({ deferred: true, kind: "projected" });

            // The deferred message waits its turn behind the messages already queued.
            const ready = await sync.pending(database.context, ATTACH.agentId, 3);
            expect(ready.map((entry) => entry.localId)).toEqual([
                "bulk-0-0",
                "bulk-0-1",
                "bulk-0-2",
            ]);

            let queued = await sync.pending(database.context, ATTACH.agentId, perEvent);
            while (queued.length > 0 && queued[0]?.localId !== "late") {
                await sync.acknowledge(
                    database.context,
                    ATTACH.agentId,
                    queued.map((entry) => entry.localId),
                    NOW + 2,
                );
                queued = await sync.pending(database.context, ATTACH.agentId, perEvent);
            }
            const promoted = await sync.pending(database.context, ATTACH.agentId, 5);
            expect(promoted.map((entry) => entry.localId)).toEqual(["late"]);
        });
    });

    it("forgets the messages Happy accepted", async () => {
        await withDatabase("happy-acknowledge", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1),
                messages: messages(3),
                now: NOW,
            });

            await sync.acknowledge(database.context, ATTACH.agentId, ["m-0", "m-1"], NOW + 1);
            const pending = await sync.pending(database.context, ATTACH.agentId, 10);
            expect(pending.map((entry) => entry.localId)).toEqual(["m-2"]);
        });
    });

    it("stops queueing when Happy has been unreachable for far too long, then resumes", async () => {
        await withDatabase("happy-unstall", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            let ordinal = 0;
            let outcome = await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(ordinal + 1),
                messages: messages(MAX_HAPPY_MESSAGES_PER_EVENT, `bulk-${ordinal}`),
                now: NOW,
            });
            while (outcome.kind === "projected") {
                ordinal += 1;
                outcome = await sync.projectEvent(database.context, {
                    agentId: ATTACH.agentId,
                    eventId: eventId(ordinal + 1),
                    messages: messages(MAX_HAPPY_MESSAGES_PER_EVENT, `bulk-${ordinal}`),
                    now: NOW,
                });
            }
            expect(outcome).toEqual({ cause: "capacity", kind: "stalled" });

            const stalled = await sync.readSession(database.context, ATTACH.agentId);
            expect(stalled?.projectionStatus).toBe("stalled");
            // The refused event stays unprojected, so it is re-offered once room returns.
            expect(stalled?.projectedEventId).toBe(eventId(ordinal));

            const accepted = await sync.pending(database.context, ATTACH.agentId, 10);
            await sync.acknowledge(
                database.context,
                ATTACH.agentId,
                accepted.map((entry) => entry.localId),
                NOW + 1,
            );
            const resumed = await sync.readSession(database.context, ATTACH.agentId);
            expect(resumed?.projectionStatus).toBe("active");
            expect(resumed?.projectionStallCause).toBeUndefined();
        });
    });

    it("queues the history that came before Happy exactly once", async () => {
        await withDatabase("happy-backfill", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            await sync.backfillHistory(
                database.context,
                ATTACH.agentId,
                messages(2, "old"),
                eventId(7),
                NOW,
            );
            await sync.backfillHistory(
                database.context,
                ATTACH.agentId,
                messages(2, "older"),
                eventId(9),
                NOW + 1,
            );

            const session = await sync.readSession(database.context, ATTACH.agentId);
            expect(session?.historyBackfilled).toBe(true);
            expect(session?.projectedEventId).toBe(eventId(7));
            const pending = await sync.pending(database.context, ATTACH.agentId, 10);
            expect(pending.map((entry) => entry.localId)).toEqual(["old-0", "old-1"]);
        });
    });

    it("only moves the read position of Happy's own stream forward", async () => {
        await withDatabase("happy-remote-seq", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            await sync.advanceRemoteSequence(database.context, ATTACH.agentId, 12, NOW);
            await sync.advanceRemoteSequence(database.context, ATTACH.agentId, 4, NOW + 1);

            const session = await sync.readSession(database.context, ATTACH.agentId);
            expect(session?.lastRemoteSeq).toBe(12);
        });
    });

    it("forgets everything an agent owed Happy when it detaches", async () => {
        await withDatabase("happy-detach", async (sync, database) => {
            await sync.ensureSession(database.context, ATTACH, NOW);
            await sync.projectEvent(database.context, {
                agentId: ATTACH.agentId,
                eventId: eventId(1),
                messages: messages(2),
                now: NOW,
            });

            await sync.removeSession(database.context, ATTACH.agentId);
            expect(await sync.readSession(database.context, ATTACH.agentId)).toBeUndefined();
            expect(await sync.pending(database.context, ATTACH.agentId, 10)).toEqual([]);
        });
    });
});
