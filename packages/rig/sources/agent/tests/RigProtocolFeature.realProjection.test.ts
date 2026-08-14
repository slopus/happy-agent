import { afterEach, describe, expect, it } from "vitest";

import type { ModelCatalog } from "../../protocol/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { runSessionTransaction } from "../../session/SessionTransactionContext.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { withDatabase } from "../../persistence/databaseContext.js";
import { querySessionEvents } from "../../persistence/session/querySessionEvents.js";
import { querySessionMessageSubmission } from "../../persistence/session/querySessionMessageSubmission.js";
import { querySessionTranscriptPage } from "../../persistence/session/querySessionTranscriptPage.js";

const ctx = createTestRootContext().named("rig-protocol-real-projection-test");
const stores: PersistentSessionStore[] = [];

const modelCatalog: ModelCatalog = {
    defaultModelId: "test/model",
    defaultProviderId: "test",
    models: [],
    providers: [
        {
            models: [
                {
                    defaultThinkingLevel: "off",
                    id: "test/model",
                    name: "Test",
                    thinkingLevels: ["off"],
                },
            ],
            providerId: "test",
        },
    ],
};

afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close(ctx)));
});

describe("Rig protocol projection with the real session", () => {
    it("does not publish user heap/event state when the enclosing transaction rolls back", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            createRuntime: () => {
                throw new Error("Legacy runtime is unavailable in this test.");
            },
            databasePath: ":memory:",
            modelCatalog,
        });
        stores.push(store);
        const session = await store.create(ctx, { cwd: "/tmp/rig-real-projection" });
        const user = {
            blocks: [{ text: "rollback me", type: "text" as const }],
            id: "rollback-user",
            identity: null,
            role: "user" as const,
        };

        await expect(
            runSessionTransaction(withDatabase(ctx, store.database), async (txCtx) => {
                await session.projectUserMessage(txCtx, {
                    delivery: "run",
                    displayText: "rollback me",
                    message: user,
                    runId: "rollback-run",
                });
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");

        expect(session.events.messageSubmission(user.id)).toBeUndefined();
        expect((await session.transcriptWindow(ctx)).messages).toEqual([]);
        expect(
            await querySessionMessageSubmission(
                withDatabase(ctx, store.database),
                session.id,
                user.id,
            ),
        ).toBeUndefined();

        const committed = await runSessionTransaction(
            withDatabase(ctx, store.database),
            async (txCtx) =>
                await session.projectUserMessage(txCtx, {
                    delivery: "run",
                    displayText: "rollback me",
                    message: user,
                    runId: "rollback-run",
                }),
        );
        expect(session.events.messageSubmission(user.id)).toEqual(committed);
        expect((await session.transcriptWindow(ctx)).messages).toEqual([user]);

        const assistant = {
            blocks: [{ text: "assistant", type: "text" as const }],
            id: "rollback-assistant",
            providerId: "test",
            requestedModelId: "test/model",
            role: "agent" as const,
        };
        await expect(
            runSessionTransaction(withDatabase(ctx, store.database), async (txCtx) => {
                await session.projectAgentMessage(txCtx, "rollback-run", assistant);
                throw new Error("rollback assistant");
            }),
        ).rejects.toThrow("rollback assistant");
        expect((await session.transcriptWindow(ctx)).messages).toEqual([user]);
        expect(session.events.all().some((event) => event.type === "agent_message")).toBe(false);
        expect(
            (await querySessionEvents(withDatabase(ctx, store.database), session.id)).some(
                (event) => event.type === "agent_message",
            ),
        ).toBe(false);

        const terminal = {
            createdAt: Date.now(),
            data: {
                modelLocked: false,
                providerId: "test",
                requestedModelId: "test/model",
                runId: "rollback-run",
                stopReason: "stop" as const,
            },
            id: "rollback-terminal",
            sessionId: session.id,
            type: "run_finished" as const,
        };
        await expect(
            runSessionTransaction(withDatabase(ctx, store.database), async (txCtx) => {
                await session.projectProtocolEvent(txCtx, terminal);
                throw new Error("rollback terminal");
            }),
        ).rejects.toThrow("rollback terminal");
        expect(session.events.all().some((event) => event.id === terminal.id)).toBe(false);
        expect(
            (await querySessionEvents(withDatabase(ctx, store.database), session.id)).some(
                (event) => event.id === terminal.id,
            ),
        ).toBe(false);
    });

    it("bounds live Agent protocol messages without pruning durable transcript or event identity", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            createRuntime: () => {
                throw new Error("Legacy runtime is unavailable in this test.");
            },
            databasePath: ":memory:",
            modelCatalog,
        });
        stores.push(store);
        const session = await store.create(ctx, { cwd: "/tmp/rig-real-projection-retention" });
        const runCount = 257;
        const expectedMessageIds = Array.from({ length: runCount }, (_, index) => [
            `agent-projection-user-${index}`,
            `agent-projection-assistant-${index}`,
        ]).flat();
        const projectedEventIds: string[] = [];

        await runSessionTransaction(withDatabase(ctx, store.database), async (txCtx) => {
            for (let index = 0; index < runCount; index += 1) {
                const runId = `agent-projection-run-${index}`;
                const user = {
                    blocks: [{ text: `User message ${index}`, type: "text" as const }],
                    id: `agent-projection-user-${index}`,
                    identity: null,
                    role: "user" as const,
                };
                const assistant = {
                    blocks: [{ text: `Assistant message ${index}`, type: "text" as const }],
                    id: `agent-projection-assistant-${index}`,
                    providerId: "test",
                    requestedModelId: "test/model",
                    role: "agent" as const,
                };
                const submitted = await session.projectUserMessage(txCtx, {
                    delivery: "run",
                    displayText: `User message ${index}`,
                    message: user,
                    runId,
                });
                const completed = await session.projectAgentMessage(txCtx, runId, assistant);
                projectedEventIds.push(submitted.id, completed.id);
            }
        });

        const liveMessageIds = session.state().messages.map((entry) => entry.message.id);
        expect(liveMessageIds).toHaveLength(512);
        expect(liveMessageIds).toEqual(expectedMessageIds.slice(-512));
        expect(session.snapshot().snapshot.messages).toHaveLength(512);

        const liveProjectedMessageIds = session.events
            .all()
            .flatMap((event) =>
                event.type === "message_submitted" || event.type === "agent_message"
                    ? [event.data.message.id]
                    : [],
            );
        expect(liveProjectedMessageIds).toEqual(expectedMessageIds);
        const liveProjectedEventIds = session.events
            .all()
            .flatMap((event) =>
                event.type === "message_submitted" || event.type === "agent_message"
                    ? [event.id]
                    : [],
            );
        expect(liveProjectedEventIds).toEqual(projectedEventIds);

        const durableTranscript = await querySessionTranscriptPage(
            withDatabase(ctx, store.database),
            session.id,
            runCount,
        );
        expect(durableTranscript?.messages.map((entry) => entry.message.id)).toEqual(
            expectedMessageIds,
        );

        const durableEvents = await querySessionEvents(
            withDatabase(ctx, store.database),
            session.id,
        );
        const durableProjectedMessageIds = durableEvents.flatMap((event) =>
            event.type === "message_submitted" || event.type === "agent_message"
                ? [event.data.message.id]
                : [],
        );
        expect(durableProjectedMessageIds).toEqual(expectedMessageIds);
        const durableProjectedEventIds = durableEvents.flatMap((event) =>
            event.type === "message_submitted" || event.type === "agent_message" ? [event.id] : [],
        );
        expect(durableProjectedEventIds).toEqual(projectedEventIds);
    }, 30_000);
});
