import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createEventIdFactory } from "../../../protocol/index.js";
import { SessionEventLog } from "../../../protocol/projection/SessionEventLog.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { sessionEvents } from "../../database/schema.js";
import { querySessionEvents } from "../querySessionEvents.js";

describe("querySessionEvents", () => {
    it("keeps a contiguous resume suffix within its byte budget without loading legacy snapshots", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-session-event-resume-tail-"));
        const databasePath = join(directory, "sessions.sqlite");
        await createSessionDatabaseFixture(databasePath);
        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        try {
            const createId = createEventIdFactory();
            const oversizedEventId = createId();
            const retainedEventIds = [createId(), createId(), createId()];
            await opened.ctx.tx
                .insert(sessionEvents)
                .values([
                    {
                        createdAtMs: 1,
                        dataJson: JSON.stringify({ legacySnapshot: "x".repeat(64 * 1_024) }),
                        eventId: oversizedEventId,
                        sessionId: "session-1",
                        type: "session_updated",
                    },
                    ...retainedEventIds.map((eventId, index) => ({
                        createdAtMs: index + 2,
                        dataJson: JSON.stringify({ index }),
                        eventId,
                        sessionId: "session-1",
                        type: "session_updated",
                    })),
                ])
                .run();

            const events = await querySessionEvents(opened.ctx, "session-1", {
                maxBytes: 1_024,
                maxCount: 4_096,
            });

            expect(events.map((event) => event.id)).toEqual(retainedEventIds);
            expect(
                events.reduce(
                    (bytes, event) =>
                        bytes +
                        Buffer.byteLength(event.id) +
                        Buffer.byteLength(event.type) +
                        Buffer.byteLength(JSON.stringify(event.data)) +
                        8,
                    0,
                ),
            ).toBe(210);
            expect(JSON.stringify(events)).not.toContain("legacySnapshot");

            const log = new SessionEventLog({
                events,
                lastEventId: retainedEventIds.at(-1)!,
            });
            expect(log.since(oversizedEventId)).toBeUndefined();
            expect(log.since(retainedEventIds[0]!)).toEqual(events.slice(1));

            const stored = await opened.ctx.tx
                .select({ dataJson: sessionEvents.dataJson })
                .from(sessionEvents)
                .all();
            expect(stored[0]?.dataJson).toContain("legacySnapshot");
        } finally {
            await opened.database.close(opened.ctx);
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("returns an empty resume cache when the newest durable event alone exceeds the budget", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-session-event-oversized-head-"));
        const databasePath = join(directory, "sessions.sqlite");
        await createSessionDatabaseFixture(databasePath);
        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        try {
            const createId = createEventIdFactory();
            const olderEventId = createId();
            const newestEventId = createId();
            await opened.ctx.tx
                .insert(sessionEvents)
                .values([
                    {
                        createdAtMs: 1,
                        dataJson: "{}",
                        eventId: olderEventId,
                        sessionId: "session-1",
                        type: "session_updated",
                    },
                    {
                        createdAtMs: 2,
                        dataJson: JSON.stringify({ legacySnapshot: "x".repeat(64 * 1_024) }),
                        eventId: newestEventId,
                        sessionId: "session-1",
                        type: "session_updated",
                    },
                ])
                .run();

            const events = await querySessionEvents(opened.ctx, "session-1", {
                maxBytes: 1_024,
                maxCount: 4_096,
            });

            expect(events).toEqual([]);
            const log = new SessionEventLog({ events, lastEventId: newestEventId });
            expect(log.lastEventId()).toBe(newestEventId);
            expect(log.since(olderEventId)).toBeUndefined();
            expect(log.since(newestEventId)).toBeUndefined();
        } finally {
            await opened.database.close(opened.ctx);
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("keeps the byte scan and payload fetch on one snapshot while another connection appends", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-session-event-concurrent-tail-"));
        const databasePath = join(directory, "sessions.sqlite");
        await createSessionDatabaseFixture(databasePath);
        const reader = await openSessionDatabase(createTestRootContext(), databasePath);
        const writer = await openSessionDatabase(createTestRootContext(), databasePath);
        let releaseScan!: () => void;
        let markScanComplete!: () => void;
        const scanComplete = new Promise<void>((resolve) => {
            markScanComplete = resolve;
        });
        const scanGate = new Promise<void>((resolve) => {
            releaseScan = resolve;
        });
        const execute = reader.client.execute.bind(reader.client);
        const executeSpy = vi
            .spyOn(reader.client, "execute")
            .mockImplementation(async (statement) => {
                const result = await execute(statement);
                const text =
                    typeof statement === "string" ? statement : (statement as { sql: string }).sql;
                if (text.includes("length(CAST(event_id AS BLOB))")) {
                    markScanComplete();
                    await scanGate;
                }
                return result;
            });
        try {
            const createId = createEventIdFactory();
            const retainedEventId = createId();
            const concurrentEventId = createId();
            await reader.ctx.tx
                .insert(sessionEvents)
                .values({
                    createdAtMs: 1,
                    dataJson: "{}",
                    eventId: retainedEventId,
                    sessionId: "session-1",
                    type: "session_updated",
                })
                .run();

            const reading = querySessionEvents(reader.ctx, "session-1", {
                maxBytes: 1_024,
                maxCount: 4_096,
            });
            await scanComplete;
            await writer.ctx.tx
                .insert(sessionEvents)
                .values({
                    createdAtMs: 2,
                    dataJson: JSON.stringify({ legacySnapshot: "x".repeat(64 * 1_024) }),
                    eventId: concurrentEventId,
                    sessionId: "session-1",
                    type: "session_updated",
                })
                .run();
            releaseScan();

            await expect(reading).resolves.toEqual([
                expect.objectContaining({ id: retainedEventId }),
            ]);
        } finally {
            releaseScan();
            executeSpy.mockRestore();
            await Promise.all([
                reader.database.close(reader.ctx),
                writer.database.close(writer.ctx),
            ]);
            await rm(directory, { force: true, recursive: true });
        }
    });
});
