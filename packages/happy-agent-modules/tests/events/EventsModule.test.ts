import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVENTS_CAPACITY, EventsModule } from "../../sources/events/EventsModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

/**
 * The journal with a deliberately small live window.
 *
 * `capacity()` is the one place the module answers how big its window is, so overriding it is how
 * retention, origin advancement, and replay bounds are exercised without recording ten thousand
 * events. Nothing is stubbed: the same code runs against a smaller number.
 */
class SmallWindowEventsModule extends EventsModule {
    readonly #capacity: number;

    constructor(capacity: number) {
        super();
        this.#capacity = capacity;
    }

    override capacity(): number {
        return this.#capacity;
    }
}

function eventTypes(events: readonly { readonly type: string }[]): string[] {
    return events.map((event) => event.type);
}

function scopeFor(agentId: string) {
    return {
        agent: { id: agentId },
    } as never;
}

function systemScope() {
    return {
        agents: {},
        sharedKV: {},
    } as never;
}

describe("EventsModule", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts at a stable origin and supports bounded replay from every cursor", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-replay-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const origin = events.originCursor();

            expect(events.cursor()).toBe(origin);
            expect(events.replay()).toEqual({
                cursor: origin,
                events: [],
                latestCursor: origin,
            });
            expect(events.replay(origin)).toEqual({
                cursor: origin,
                events: [],
                latestCursor: origin,
            });

            const first = await events.record(database.context, {
                payload: { value: 1 },
                type: "test.first",
            });
            const second = await events.record(database.context, {
                payload: { value: 2 },
                type: "test.second",
            });
            const third = await events.record(database.context, {
                payload: { value: 3 },
                type: "test.third",
            });

            expect(events.replay(origin, 2)).toEqual({
                cursor: second.id,
                events: [first, second],
                latestCursor: third.id,
            });
            expect(events.replay(first.id, 2)).toEqual({
                cursor: third.id,
                events: [second, third],
                latestCursor: third.id,
            });
            expect(events.replay(third.id)).toEqual({
                cursor: third.id,
                events: [],
                latestCursor: third.id,
            });
            expect(events.replay("00000000-0000-7000-8000-000000000000")).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("keeps one fixed window size no caller can widen", () => {
        expect(new EventsModule().capacity()).toBe(EVENTS_CAPACITY);
        expect(new EventsModule().replay(undefined, EVENTS_CAPACITY)).toBeDefined();
        expect(() => new EventsModule().replay(undefined, EVENTS_CAPACITY + 1)).toThrow(
            `The event replay limit must be between 1 and ${EVENTS_CAPACITY}.`,
        );
    });

    it("rejects replay limits past its window and invalid append envelopes", async () => {
        const events = new SmallWindowEventsModule(2);
        const database = moduleDatabase(events.migrations ?? [], "events-bounds-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            expect(() => events.replay(events.originCursor(), 0)).toThrow(
                "The event replay limit must be between 1 and 2.",
            );
            expect(() => events.replay(events.originCursor(), 3)).toThrow(
                "The event replay limit must be between 1 and 2.",
            );

            await expect(
                events.record(database.context, {
                    payload: {},
                    type: "Not-lowercase",
                }),
            ).rejects.toThrow("The event input is invalid.");
            await expect(
                events.record(database.context, {
                    agentId: "",
                    payload: {},
                    type: "test.invalid-agent",
                }),
            ).rejects.toThrow("The event input is invalid.");
            await expect(
                events.record(database.context, {
                    payload: {},
                    type: "test.invalid-extra",
                    unexpected: true,
                } as never),
            ).rejects.toThrow("The event input is invalid.");
            await expect(
                events.record(database.context, {
                    payload: {},
                    type: "test..empty-segment",
                }),
            ).rejects.toThrow("The event input is invalid.");
            await expect(
                events.record(database.context, {
                    payload: {},
                    type: "test.trailing.",
                }),
            ).rejects.toThrow("The event input is invalid.");
            expect(events.replay(events.originCursor())?.events).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("owns its journal migrations and reloads durable events", async () => {
        const first = new EventsModule();
        const database = moduleDatabase(first.migrations ?? [], "events-restart-test");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            const recorded = await first.record(database.context, {
                agentId: "agent-1",
                payload: { value: "durable" },
                type: "test.recorded",
            });

            expect(first.latestCursor("agent-1")).toBe(recorded.id);
            expect(first.replay(first.originCursor())?.events).toEqual([recorded]);

            const restarted = new EventsModule();
            await restarted.beforeStart?.(database.context);

            expect(restarted.cursor()).toBe(recorded.id);
            expect(restarted.latestCursor("agent-1")).toBe(recorded.id);
            expect(restarted.replay(restarted.originCursor())?.events).toEqual([recorded]);
        } finally {
            database.close();
        }
    });

    it("reads the transaction-authoritative active run before commit and after restart", async () => {
        const first = new EventsModule();
        const database = moduleDatabase(first.migrations ?? [], "events-active-run-lookup");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            await database.context.inTx(async (txCtx) => {
                const runId = await first.runIdForAccepted(txCtx, "agent-1", {
                    id: "message-1",
                    kind: "message",
                    message: { content: [{ type: "text", text: "Hello" }] },
                } as never);
                expect(first.activeRunId("agent-1")).toBeUndefined();
                expect(first.activeAgentIds()).toEqual([]);
                await expect(first.activeRunIdInTransaction(txCtx, "agent-1")).resolves.toBe(runId);
            });

            const durableRunId = await first.activeRunIdInTransaction(database.context, "agent-1");
            expect(durableRunId).toBe(first.activeRunId("agent-1"));
            expect(first.activeAgentIds()).toEqual(["agent-1"]);

            const restarted = new EventsModule();
            await restarted.beforeStart?.(database.context);
            await expect(
                restarted.activeRunIdInTransaction(database.context, "agent-1"),
            ).resolves.toBe(durableRunId);
            expect(restarted.activeRunId("agent-1")).toBe(durableRunId);
            expect(restarted.activeAgentIds()).toEqual(["agent-1"]);
        } finally {
            database.close();
        }
    });

    it("retains only its live window and persists the advanced origin", async () => {
        const first = new SmallWindowEventsModule(2);
        const database = moduleDatabase(first.migrations ?? [], "events-retention-test");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            const firstEvent = await first.record(database.context, {
                payload: { n: 1 },
                type: "test.one",
            });
            const secondEvent = await first.record(database.context, {
                payload: { n: 2 },
                type: "test.two",
            });
            const thirdEvent = await first.record(database.context, {
                payload: { n: 3 },
                type: "test.three",
            });

            expect(first.originCursor()).toBe(firstEvent.id);
            expect(first.cursor()).toBe(thirdEvent.id);
            expect(first.replay(first.originCursor())?.events).toEqual([secondEvent, thirdEvent]);

            const restarted = new SmallWindowEventsModule(2);
            await restarted.beforeStart?.(database.context);
            expect(restarted.originCursor()).toBe(firstEvent.id);
            expect(restarted.replay(restarted.originCursor())?.events).toEqual([
                secondEvent,
                thirdEvent,
            ]);
        } finally {
            database.close();
        }
    });

    it("advances the origin when a restart runs with a smaller window", async () => {
        const first = new SmallWindowEventsModule(5);
        const database = moduleDatabase(first.migrations ?? [], "events-capacity-change-test");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            const recorded = await database.context.inTx(
                async (txCtx) =>
                    await Promise.all(
                        Array.from({ length: 5 }, (_, index) =>
                            first.record(txCtx, {
                                payload: { index },
                                type: "test.capacity-change",
                            }),
                        ),
                    ),
            );

            const restarted = new SmallWindowEventsModule(2);
            await restarted.beforeStart?.(database.context);
            expect(restarted.originCursor()).toBe(recorded[2]?.id);
            expect(restarted.replay(restarted.originCursor())?.events).toEqual(recorded.slice(3));
        } finally {
            database.close();
        }
    });

    it("finds accepted-message cursors and trims an exact durable prefix", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-trim-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const accepted = await events.record(database.context, {
                agentId: "agent-1",
                payload: { id: "message-1" },
                type: "message.accepted",
            });
            const retained = await events.record(database.context, {
                agentId: "agent-1",
                payload: {},
                type: "test.retained",
            });

            expect(events.messageCursor("agent-1", "message-1")).toBe(accepted.id);
            await expect(events.trim(database.context, accepted.id)).resolves.toEqual({
                through: accepted.id,
                trimmed: 1,
            });
            expect(events.originCursor()).toBe(accepted.id);
            expect(events.replay(accepted.id)?.events).toEqual([retained]);
        } finally {
            database.close();
        }
    });

    it("trims through the head and rejects unknown cursors without changing state", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-trim-head-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const first = await events.record(database.context, {
                payload: { n: 1 },
                type: "test.first",
            });
            const second = await events.record(database.context, {
                payload: { n: 2 },
                type: "test.second",
            });

            await expect(
                events.trim(database.context, "00000000-0000-7000-8000-000000000000"),
            ).resolves.toBeUndefined();
            expect(events.replay(events.originCursor())?.events).toEqual([first, second]);

            await expect(events.trim(database.context, second.id)).resolves.toEqual({
                through: second.id,
                trimmed: 2,
            });
            expect(events.cursor()).toBe(second.id);
            expect(events.originCursor()).toBe(second.id);
            expect(events.replay(second.id)).toEqual({
                cursor: second.id,
                events: [],
                latestCursor: second.id,
            });
            await expect(events.trim(database.context, second.id)).resolves.toEqual({
                through: second.id,
                trimmed: 0,
            });
        } finally {
            database.close();
        }
    });

    it("does not publish an in-memory trim after its outer transaction rolls back", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-trim-rollback-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const first = await events.record(database.context, {
                payload: {},
                type: "test.first",
            });
            const second = await events.record(database.context, {
                payload: {},
                type: "test.second",
            });

            await expect(
                database.context.inTx(async (txCtx) => {
                    await events.trim(txCtx, first.id);
                    throw new Error("trim rollback");
                }),
            ).rejects.toThrow("trim rollback");

            expect(events.originCursor()).not.toBe(first.id);
            expect(events.replay(events.originCursor())?.events).toEqual([first, second]);
            const rows = await agentDatabaseRows<{ event_id: string }>(
                database.database,
                sql`SELECT event_id FROM happy_agent_events ORDER BY event_id`,
            );
            expect(rows.map((row) => row.event_id)).toEqual([first.id, second.id]);
        } finally {
            database.close();
        }
    });

    it("does not publish or trim in-memory state when the outer transaction rolls back", async () => {
        const received: string[] = [];
        const events = new EventsModule();
        events.observe({
            onEvent: (_ctx, event) => {
                received.push(event.type);
            },
        });
        const database = moduleDatabase(events.migrations ?? [], "events-rollback-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            await expect(
                database.context.inTx(async (txCtx) => {
                    await events.record(txCtx, {
                        payload: { rolledBack: true },
                        type: "test.rolled-back",
                    });
                    throw new Error("rollback");
                }),
            ).rejects.toThrow("rollback");

            expect(received).toEqual([]);
            expect(events.replay(events.originCursor())?.events).toEqual([]);
            const rows = await agentDatabaseRows<{ event_id: string }>(
                database.database,
                sql`SELECT event_id FROM happy_agent_events`,
            );
            expect(rows).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("delivers one frozen event to transactional, post-commit, and ordinary listeners", async () => {
        const transactional: unknown[] = [];
        const postCommit: unknown[] = [];
        const ordinary: unknown[] = [];
        const events = new EventsModule();
        events.observe({
            onEventTransactional: (_ctx, event) => {
                transactional.push(event);
                expect(Object.isFrozen(event)).toBe(true);
                expect(Object.isFrozen(event.payload)).toBe(true);
                expect(Object.isFrozen((event.payload as { nested: object }).nested)).toBe(true);
            },
            onEvent: (_ctx, event) => {
                postCommit.push(event);
                expect(Object.isFrozen(event)).toBe(true);
                expect(Object.isFrozen(event.payload)).toBe(true);
            },
        });
        const database = moduleDatabase(events.migrations ?? [], "events-listener-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const unsubscribe = events.subscribe((event) => ordinary.push(event));
            const payload = { nested: { value: 1 } };
            const recorded = await events.record(database.context, {
                payload,
                type: "test.listened",
            });
            payload.nested.value = 2;
            unsubscribe();

            expect(transactional).toEqual([recorded]);
            expect(postCommit).toEqual([recorded]);
            expect(ordinary).toEqual([recorded]);
            expect(transactional[0]).toBe(postCommit[0]);
            expect(ordinary[0]).toBe(recorded);
            expect(recorded.payload).toEqual({ nested: { value: 1 } });
        } finally {
            database.close();
        }
    });

    it("isolates ordinary listener failures and contains post-commit failures", async () => {
        const ordinary: string[] = [];
        const events = new EventsModule();
        events.observe({
            onEvent: () => {
                throw new Error("post-commit observer failed");
            },
        });
        const database = moduleDatabase(events.migrations ?? [], "events-listener-failure-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            events.subscribe(() => {
                throw new Error("ordinary observer failed");
            });
            events.subscribe((event) => ordinary.push(event.type));

            await expect(
                events.record(database.context, {
                    payload: {},
                    type: "test.observer-failure",
                }),
            ).resolves.toMatchObject({ type: "test.observer-failure" });
            expect(ordinary).toEqual(["test.observer-failure"]);
            expect(events.replay(events.originCursor())?.events).toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("rolls back durable state when the transactional module listener rejects", async () => {
        const events = new EventsModule();
        events.observe({
            onEventTransactional: () => {
                throw new Error("transactional observer failed");
            },
        });
        const database = moduleDatabase(
            events.migrations ?? [],
            "events-transactional-failure-test",
        );
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            await expect(
                events.record(database.context, {
                    payload: {},
                    type: "test.transactional-failure",
                }),
            ).rejects.toThrow("transactional observer failed");
            expect(events.replay(events.originCursor())?.events).toEqual([]);
            const rows = await agentDatabaseRows<{ event_id: string }>(
                database.database,
                sql`SELECT event_id FROM happy_agent_events`,
            );
            expect(rows).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("clones input payloads and rejects unsupported or oversized payloads before writing", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-payload-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const cyclic: { self?: unknown } = {};
            cyclic.self = cyclic;
            await expect(
                events.record(database.context, {
                    payload: cyclic,
                    type: "test.cyclic",
                }),
            ).rejects.toThrow("JSON serializable");
            await expect(
                events.record(database.context, {
                    payload: { text: "x".repeat(5 * 1_024 * 1_024) },
                    type: "test.oversized",
                }),
            ).rejects.toThrow("exceeds the 5 MiB durable limit");
            expect(events.replay(events.originCursor())?.events).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("keeps event IDs and timestamps monotonic when the wall clock moves backward", async () => {
        // Only the clock is moved; the database and its promises keep real timers.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(500);
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-clock-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const first = await events.record(database.context, {
                payload: {},
                type: "test.first",
            });
            vi.setSystemTime(499);
            const second = await events.record(database.context, {
                payload: {},
                type: "test.second",
            });
            vi.setSystemTime(501);
            const third = await events.record(database.context, {
                payload: {},
                type: "test.third",
            });

            expect(second.id > first.id).toBe(true);
            expect(third.id > second.id).toBe(true);
            expect(second.occurredAt).toBe(first.occurredAt);
            expect(third.occurredAt).toBeGreaterThan(second.occurredAt);
        } finally {
            database.close();
        }
    });

    it("records all lifecycle and provider events, then clears the active run on settlement", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-hooks-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const agentScope = scopeFor("agent-hooks");

            await database.context.inTx(async (txCtx) => {
                await hooks.agentCreatedTransact?.(txCtx, systemScope(), {
                    id: "agent-hooks",
                    metadata: undefined,
                });
            });
            await hooks.messageAcceptedTransact?.(database.context, agentScope, {
                id: "message-hooks",
                kind: "send",
                message: { role: "user", content: [{ type: "text", text: "Continue." }] },
            });
            await hooks.beforeAgentLoopTransact?.(database.context, agentScope, {
                loopId: "loop-hooks",
            });
            await hooks.onEvent?.(database.context, agentScope, { type: "text_start" });
            await hooks.onEvent?.(database.context, agentScope, {
                type: "text_delta",
                delta: "hello",
            });
            await hooks.onEvent?.(database.context, agentScope, { type: "text_end" });
            await hooks.beforeToolCallTransact?.(database.context, agentScope, {
                callId: "call-hooks",
                name: "shell",
                arguments: "{}",
            } as never);
            await hooks.afterToolCallTransact?.(database.context, agentScope, {
                callId: "call-hooks",
                content: [{ type: "text", text: "done" }],
                isError: false,
            } as never);
            await hooks.afterInferenceTransact?.(database.context, agentScope, {
                inferenceId: "inference-hooks",
                loopId: "loop-hooks",
                state: "normal",
                tokens: { input: 1, output: 1 },
            } as never);
            await hooks.afterTurnTransact?.(database.context, agentScope, {
                aborted: false,
                loopId: "loop-hooks",
                turnId: "turn-hooks",
            } as never);
            await hooks.afterAgentSettledTransact?.(database.context, agentScope, {
                loopId: "loop-hooks",
                settlementId: "settlement-hooks",
            } as never);

            const replay = events.replay(events.originCursor());
            expect(eventTypes(replay?.events ?? [])).toEqual([
                "agent.created",
                "message.accepted",
                "loop.started",
                "provider.event",
                "provider.event",
                "provider.event",
                "tool.started",
                "tool.completed",
                "inference.completed",
                "turn.completed",
                "loop.settled",
            ]);
            expect(events.messageCursor("agent-hooks", "message-hooks")).toBeDefined();
            const activeRuns = await agentDatabaseRows<{ agent_id: string }>(
                database.database,
                sql`SELECT agent_id FROM happy_agent_active_runs`,
            );
            expect(activeRuns).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("persists a completed local tool in the active assistant message", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-tool-result-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const scope = scopeFor("agent-tool-result");
            await hooks.messageAcceptedTransact?.(database.context, scope, {
                id: "message-tool-result",
                kind: "send",
                message: { role: "user", content: [{ type: "text", text: "Run it." }] },
            });
            await hooks.onEvent?.(database.context, scope, { type: "block_start" });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_start",
                callId: "call-tool-result",
                name: "exec_command",
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_end",
                callId: "call-tool-result",
                arguments: '{"cmd":"printf done"}',
            });
            await hooks.beforeToolCallTransact?.(database.context, scope, {
                callId: "call-tool-result",
                name: "exec_command",
                arguments: '{"cmd":"printf done"}',
            } as never);
            await hooks.afterToolCallTransact?.(database.context, scope, {
                callId: "call-tool-result",
                content: [{ type: "text", text: "done" }],
                isError: false,
            } as never);
            await hooks.afterInferenceTransact?.(database.context, scope, {
                inferenceId: "inference-tool-result",
                loopId: "loop-tool-result",
                state: "normal",
                tokens: { input: 1, output: 1 },
            } as never);

            const replay = events.replay(events.originCursor());
            const completion = replay?.events.find((event) => event.type === "tool.completed");
            expect(completion?.payload).toMatchObject({
                callId: "call-tool-result",
                rigEvent: {
                    partial: {
                        content: [
                            {
                                arguments: { cmd: "printf done" },
                                id: "call-tool-result",
                                name: "exec_command",
                                type: "toolCall",
                            },
                            {
                                display: "done",
                                rendered: [{ text: "done", type: "text" }],
                                toolCallId: "call-tool-result",
                                toolName: "exec_command",
                                type: "tool_result",
                            },
                        ],
                    },
                    type: "tool_execution_end",
                },
                runId: "message-tool-result",
            });
            expect(
                replay?.events.find((event) => event.type === "inference.completed")?.payload,
            ).toMatchObject({
                blocks: [
                    {
                        id: "call-tool-result",
                        name: "exec_command",
                        type: "toolCall",
                    },
                    {
                        display: "done",
                        toolCallId: "call-tool-result",
                        type: "tool_result",
                    },
                ],
            });
        } finally {
            database.close();
        }
    });

    it("rolls back the completed tool partial with its outer transaction", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(
            events.migrations ?? [],
            "events-tool-result-rollback-test",
        );
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const scope = scopeFor("agent-tool-rollback");
            await hooks.messageAcceptedTransact?.(database.context, scope, {
                id: "message-tool-rollback",
                kind: "send",
                message: { role: "user", content: [{ type: "text", text: "Run it." }] },
            });
            await hooks.onEvent?.(database.context, scope, { type: "block_start" });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_start",
                callId: "call-tool-rollback",
                name: "exec_command",
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_end",
                callId: "call-tool-rollback",
                arguments: '{"cmd":"printf rollback"}',
            });

            await expect(
                database.context.inTx(async (txCtx) => {
                    await hooks.afterToolCallTransact?.(txCtx, scope, {
                        callId: "call-tool-rollback",
                        content: [{ type: "text", text: "must disappear" }],
                        isError: false,
                    } as never);
                    throw new Error("roll back the result");
                }),
            ).rejects.toThrow("roll back the result");
            expect(
                events
                    .replay(events.originCursor())
                    ?.events.some((event) => event.type === "tool.completed"),
            ).toBe(false);

            const restarted = new EventsModule();
            const restartedHooks = await resolveModuleHooks(database.context, restarted);
            await restartedHooks.afterInferenceTransact?.(database.context, scope, {
                inferenceId: "inference-tool-rollback",
                loopId: "loop-tool-rollback",
                state: "normal",
                tokens: { input: 1, output: 1 },
            } as never);
            expect(
                restarted
                    .replay(restarted.originCursor())
                    ?.events.find((event) => event.type === "inference.completed")?.payload,
            ).toMatchObject({
                blocks: [
                    {
                        id: "call-tool-rollback",
                        name: "exec_command",
                        type: "toolCall",
                    },
                ],
            });
        } finally {
            database.close();
        }
    });

    it("records restored, archived, permission, and metadata lifecycle hooks", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-lifecycle-hooks-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const scope = scopeFor("agent-lifecycle");
            await hooks.agentRestoredTransact?.(database.context, systemScope(), {
                id: "agent-lifecycle",
                metadata: undefined,
            });
            await hooks.agentArchivedTransact?.(database.context, systemScope(), {
                id: "agent-lifecycle",
                metadata: undefined,
            });
            await hooks.permissionModeChangedTransact?.(database.context, scope, {
                previousMode: "auto",
                mode: "workspace_write",
            });
            await hooks.metadataChangedTransact?.(database.context, scope, {
                agentId: "agent-lifecycle",
                previousMetadata: { title: "Old" },
                update: { title: "New" },
                metadata: { title: "New" },
            });

            expect(eventTypes(events.replay(events.originCursor())?.events ?? [])).toEqual([
                "agent.restored",
                "agent.archived",
                "agent.permission-changed",
                "agent.metadata-changed",
            ]);
        } finally {
            database.close();
        }
    });

    it("keeps one run identity for send and steering messages accepted in one transaction", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-steering-identity-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const scope = scopeFor("agent-steering");
            await database.context.inTx(async (txCtx) => {
                await hooks.messageAcceptedTransact?.(txCtx, scope, {
                    id: "message-send",
                    kind: "send",
                    message: { role: "user", content: [{ type: "text", text: "Start." }] },
                });
                await hooks.messageAcceptedTransact?.(txCtx, scope, {
                    id: "message-steer",
                    kind: "steering",
                    message: { role: "user", content: [{ type: "text", text: "Adjust." }] },
                });
            });

            const accepted = events
                .replay(events.originCursor())
                ?.events.filter((event) => event.type === "message.accepted")
                .map((event) => event.payload as { runId: string });
            expect(accepted?.[1]?.runId).toBe(accepted?.[0]?.runId);
        } finally {
            database.close();
        }
    });

    it("opens a successor run only when steering follows provider work", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-steering-boundary-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const scope = scopeFor("agent-steering-boundary");
            await hooks.messageAcceptedTransact?.(database.context, scope, {
                id: "message-first",
                kind: "send",
                message: { role: "user", content: [{ type: "text", text: "Start." }] },
            });
            await hooks.onEvent?.(database.context, scope, { type: "text_start" });
            await hooks.messageAcceptedTransact?.(database.context, scope, {
                id: "message-steering",
                kind: "steering",
                message: { role: "user", content: [{ type: "text", text: "Adjust." }] },
            });

            const accepted = events
                .replay(events.originCursor())
                ?.events.filter((event) => event.type === "message.accepted")
                .map((event) => event.payload as { runId: string });
            expect(accepted?.map((event) => event.runId)).toEqual([
                "message-first",
                "message-steering",
            ]);
        } finally {
            database.close();
        }
    });

    it("resolves an exact prior agent cursor transactionally and after restart", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-previous-cursor-test");
        await database.ready;
        try {
            await resolveModuleHooks(database.context, events);
            const first = await events.record(database.context, {
                agentId: "agent-cursor",
                payload: {},
                type: "test.first",
            });
            const other = await events.record(database.context, {
                agentId: "other-agent",
                payload: {},
                type: "test.other",
            });
            const second = await events.record(database.context, {
                agentId: "agent-cursor",
                payload: {},
                type: "test.second",
            });

            expect(await events.previousCursor(database.context, "agent-cursor", second.id)).toBe(
                first.id,
            );
            expect(await events.previousCursor(database.context, "agent-cursor")).toBe(second.id);
            expect(other.id > first.id).toBe(true);
            expect(await events.latestAgentEvent(database.context, "agent-cursor")).toEqual({
                cursor: second.id,
                occurredAt: second.occurredAt,
            });

            await database.context.inTx(async (txCtx) => {
                const third = await events.record(txCtx, {
                    agentId: "agent-cursor",
                    payload: {},
                    type: "test.third",
                });
                expect(await events.latestAgentEvent(txCtx, "agent-cursor")).toEqual({
                    cursor: third.id,
                    occurredAt: third.occurredAt,
                });
            });

            const restarted = new EventsModule();
            await resolveModuleHooks(database.context, restarted);
            expect(
                await restarted.previousCursor(database.context, "agent-cursor", second.id),
            ).toBe(first.id);
            expect(await restarted.latestAgentEvent(database.context, "agent-cursor")).toEqual(
                await events.latestAgentEvent(database.context, "agent-cursor"),
            );
        } finally {
            database.close();
        }
    });

    it("retains per-agent version truth after the replay journal trims it", async () => {
        const events = new SmallWindowEventsModule(1);
        const database = moduleDatabase(events.migrations ?? [], "events-agent-version-retention");
        await database.ready;
        try {
            await resolveModuleHooks(database.context, events);
            const first = await events.record(database.context, {
                agentId: "quiet-agent",
                payload: {},
                type: "test.first",
            });
            await events.record(database.context, {
                agentId: "other-agent",
                payload: {},
                type: "test.other",
            });
            expect(events.replay(events.originCursor())?.events).toHaveLength(1);
            expect(await events.latestAgentEvent(database.context, "quiet-agent")).toEqual({
                cursor: first.id,
                occurredAt: first.occurredAt,
            });

            const second = await events.record(database.context, {
                agentId: "quiet-agent",
                payload: {},
                type: "test.second",
            });
            expect(await events.previousCursor(database.context, "quiet-agent", second.id)).toBe(
                first.id,
            );

            const restarted = new SmallWindowEventsModule(1);
            await resolveModuleHooks(database.context, restarted);
            expect(await restarted.latestAgentEvent(database.context, "quiet-agent")).toEqual({
                cursor: second.id,
                occurredAt: second.occurredAt,
            });
            expect(await restarted.previousCursor(database.context, "quiet-agent", second.id)).toBe(
                first.id,
            );
        } finally {
            database.close();
        }
    });

    it("projects reasoning, tool-call, server-result, retry, reset, and done variants", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-provider-projection-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const scope = scopeFor("agent-projection");
            await hooks.messageAcceptedTransact?.(database.context, scope, {
                id: "message-projection",
                kind: "send",
                message: { role: "user", content: [{ type: "text", text: "Project." }] },
            });

            await hooks.onEvent?.(database.context, scope, { type: "block_start" });
            await hooks.onEvent?.(database.context, scope, { type: "reasoning_start" });
            await hooks.onEvent?.(database.context, scope, {
                type: "reasoning_delta",
                delta: "think",
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "reasoning_end",
                reasoning: '{"type":"reasoning","encrypted_content":"OPAQUE_REASONING_SENTINEL"}',
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_start",
                callId: "call-projection",
                name: "lookup",
                namespace: "server",
                server: true,
                vendor: { source: "provider" },
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_delta",
                callId: "call-projection",
                delta: '{"query":',
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_end",
                callId: "call-projection",
                arguments: '{"query":"events"}',
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_result_start",
                callId: "unknown-server-call",
                vendor: { requestId: "server-1" },
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_result_delta",
                callId: "unknown-server-call",
                delta: "working",
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_result_end",
                callId: "unknown-server-call",
                content: [
                    { type: "text", text: "failed" },
                    { type: "image", data: "encoded", mimeType: "image/png" },
                ],
                isError: true,
                incomplete: true,
            } as never);
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_result_end",
                callId: "call-projection",
                content: [],
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "retrying",
                attempt: 2,
                reason: "transient",
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "token_usage",
                usage: {
                    cacheRead: 1,
                    cacheWrite: 2,
                    input: 3,
                    output: 4,
                },
            } as never);
            await hooks.onEvent?.(database.context, scope, { type: "block_stop" });
            await hooks.onEvent?.(database.context, scope, { type: "block_reset" });
            await hooks.onEvent?.(database.context, scope, {
                type: "done",
                state: "error",
                kind: "unknown",
                message: "provider failed",
            });

            const providerEvents =
                events
                    .replay(events.originCursor())
                    ?.events.filter((event) => event.type === "provider.event") ?? [];
            expect(providerEvents).toHaveLength(16);
            expect(providerEvents[0]?.payload).toMatchObject({
                event: { type: "block_start" },
                rigEvent: { type: "block_start" },
            });
            expect(providerEvents[3]?.payload).toMatchObject({
                event: {
                    reasoning:
                        '{"type":"reasoning","encrypted_content":"OPAQUE_REASONING_SENTINEL"}',
                    type: "reasoning_end",
                },
                rigEvent: {
                    content: "think",
                    partial: {
                        content: [{ thinking: "think", type: "thinking" }],
                    },
                    type: "thinking_end",
                },
            });
            expect(providerEvents[6]?.payload).toMatchObject({
                event: { type: "toolcall_end" },
                rigEvent: {
                    toolCall: {
                        arguments: { query: "events" },
                        id: "call-projection",
                    },
                },
            });
            expect(providerEvents[9]?.payload).toMatchObject({
                event: { type: "toolcall_result_end" },
                rigEvent: { type: "tool_execution_end" },
            });
            expect(providerEvents[11]?.payload).toMatchObject({
                event: { type: "retrying", attempt: 2 },
                rigEvent: { messageId: "message-projection-assistant", type: "retrying" },
            });
            expect(providerEvents[12]?.payload).toMatchObject({
                event: { type: "token_usage" },
            });
            expect(providerEvents[14]?.payload).toMatchObject({
                event: { type: "block_reset" },
                rigEvent: { type: "block_reset" },
            });
            expect(providerEvents[15]?.payload).toMatchObject({
                event: { message: "provider failed", state: "error", type: "done" },
            });
        } finally {
            database.close();
        }
    });

    it("does not carry a failed inference message into a later successful retry", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-retry-state-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            const scope = scopeFor("agent-retry-state");
            await hooks.messageAcceptedTransact?.(database.context, scope, {
                id: "message-retry-state",
                kind: "send",
                message: { role: "user", content: [{ type: "text", text: "Retry." }] },
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "done",
                state: "error",
                kind: "unknown",
                message: "temporary provider failure",
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "retrying",
                attempt: 2,
                reason: "transient",
            });
            await hooks.onEvent?.(database.context, scope, {
                type: "done",
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
            await hooks.afterAgentSettledTransact?.(database.context, scope, {
                loopId: "message-retry-state",
                settlementId: "settlement-retry-state",
            } as never);

            const settled = events
                .replay(events.originCursor())
                ?.events.find((event) => event.type === "loop.settled");
            expect(settled?.payload).not.toHaveProperty("errorMessage");
            expect(settled?.payload).toMatchObject({ stopReason: "stop" });
        } finally {
            database.close();
        }
    });

    it("rebuilds a crashed provider block on agent restoration", async () => {
        const first = new EventsModule();
        const database = moduleDatabase(first.migrations ?? [], "events-recovery-test");
        await database.ready;
        try {
            const firstHooks = await resolveModuleHooks(database.context, first);
            const scope = scopeFor("agent-recovery");
            await firstHooks.messageAcceptedTransact?.(database.context, scope, {
                id: "message-recovery",
                kind: "send",
                message: { role: "user", content: [{ type: "text", text: "Recover." }] },
            });
            await firstHooks.onEvent?.(database.context, scope, { type: "text_start" });
            await firstHooks.onEvent?.(database.context, scope, {
                type: "text_delta",
                delta: "partial",
            });

            const restarted = new EventsModule();
            const restartedHooks = await resolveModuleHooks(database.context, restarted);
            await restartedHooks.agentRestoredTransact?.(database.context, systemScope(), {
                id: "agent-recovery",
                metadata: undefined,
            });

            const recovered = restarted
                .replay(restarted.originCursor())
                ?.events.filter((event) => event.type === "provider.event")
                .at(-1);
            expect(recovered?.payload).toMatchObject({
                event: { type: "block_reset" },
                recovered: true,
                runId: "message-recovery",
            });
        } finally {
            database.close();
        }
    });

    it("rejects provider deltas without a matching start and leaves no partial event", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-provider-validation-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, events);
            await expect(
                hooks.onEvent?.(database.context, scopeFor("agent-provider"), {
                    type: "text_delta",
                    delta: "orphan",
                }),
            ).rejects.toThrow("without a start event");
            expect(events.replay(events.originCursor())?.events).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("serializes concurrent appends in ID order", async () => {
        const events = new SmallWindowEventsModule(100);
        const database = moduleDatabase(events.migrations ?? [], "events-concurrent-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const recorded = await database.context.inTx(
                async (txCtx) =>
                    await Promise.all(
                        Array.from({ length: 20 }, (_, index) =>
                            events.record(txCtx, {
                                payload: { index },
                                type: "test.concurrent",
                            }),
                        ),
                    ),
            );
            const replayed = events.replay(events.originCursor())?.events ?? [];
            expect(replayed).toHaveLength(20);
            expect(replayed.map((event) => event.id)).toEqual(
                [...replayed]
                    .sort((left, right) => left.id.localeCompare(right.id))
                    .map((event) => event.id),
            );
            expect(new Set(recorded.map((event) => event.id)).size).toBe(20);
        } finally {
            database.close();
        }
    });

    it("rejects malformed durable event, origin, and active-run rows on reload", async () => {
        const malformedEvent = new EventsModule();
        const eventDatabase = moduleDatabase(
            malformedEvent.migrations ?? [],
            "events-malformed-event-test",
        );
        await eventDatabase.ready;
        try {
            await agentDatabaseRun(
                eventDatabase.database,
                sql`INSERT INTO happy_agent_events
                    (event_id, agent_id, occurred_at, type, payload_json)
                    VALUES (
                        ${"00000000-0000-7000-8000-000000000000"},
                        ${"agent-malformed"},
                        ${1},
                        ${"test.malformed"},
                        ${"{"}
                    )`,
            );
            await expect(malformedEvent.beforeStart?.(eventDatabase.context)).rejects.toThrow();
        } finally {
            eventDatabase.close();
        }

        const missingOrigin = new EventsModule();
        const missingOriginDatabase = moduleDatabase(
            missingOrigin.migrations ?? [],
            "events-missing-origin-test",
        );
        await missingOriginDatabase.ready;
        try {
            await agentDatabaseRun(
                missingOriginDatabase.database,
                sql`INSERT INTO happy_agent_events
                    (event_id, agent_id, occurred_at, type, payload_json)
                    VALUES (
                        ${"00000000-0000-7000-8000-000000000001"},
                        ${"agent-missing-origin"},
                        ${1},
                        ${"test.valid"},
                        ${"{}"}
                    )`,
            );
            await expect(
                missingOrigin.beforeStart?.(missingOriginDatabase.context),
            ).rejects.toThrow();
        } finally {
            missingOriginDatabase.close();
        }

        const malformedOrigin = new EventsModule();
        const originDatabase = moduleDatabase(
            malformedOrigin.migrations ?? [],
            "events-malformed-origin-test",
        );
        await originDatabase.ready;
        try {
            await agentDatabaseRun(
                originDatabase.database,
                sql`INSERT INTO happy_agent_event_state (key, value)
                    VALUES (${"origin_cursor"}, ${"not-a-uuid"})`,
            );
            await expect(malformedOrigin.beforeStart?.(originDatabase.context)).rejects.toThrow();
        } finally {
            originDatabase.close();
        }

        const malformedRun = new EventsModule();
        const runDatabase = moduleDatabase(
            malformedRun.migrations ?? [],
            "events-malformed-run-test",
        );
        await runDatabase.ready;
        try {
            await agentDatabaseRun(
                runDatabase.database,
                sql`INSERT INTO happy_agent_active_runs (agent_id, state_json)
                    VALUES (${"agent-malformed"}, ${"{}"})`,
            );
            await expect(malformedRun.beforeStart?.(runDatabase.context)).rejects.toThrow(
                "durable active run is invalid",
            );
        } finally {
            runDatabase.close();
        }
    });

    it("rejects oversized persisted payloads on reload", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-oversized-persisted-test");
        await database.ready;
        try {
            const oversizedPayload = JSON.stringify({
                text: "x".repeat(5 * 1_024 * 1_024),
            });
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_event_state (key, value)
                    VALUES (${"origin_cursor"}, ${"00000000-0000-7000-8000-000000000000"})`,
            );
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_events
                    (event_id, agent_id, occurred_at, type, payload_json)
                    VALUES (
                        ${"00000000-0000-7000-8000-000000000001"},
                        ${"agent-oversized"},
                        ${1},
                        ${"test.oversized"},
                        ${oversizedPayload}
                    )`,
            );
            await expect(events.beforeStart?.(database.context)).rejects.toThrow(
                "exceeds the 5 MiB durable limit",
            );
        } finally {
            database.close();
        }
    });

    it("rejects persisted event rows whose timestamps move backward", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-persisted-order-test");
        await database.ready;
        try {
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_event_state (key, value)
                    VALUES (${"origin_cursor"}, ${"00000000-0000-7000-8000-000000000000"})`,
            );
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_events
                    (event_id, agent_id, occurred_at, type, payload_json)
                    VALUES
                        (
                            ${"00000000-0000-7000-8000-000000000001"},
                            ${"agent-order"},
                            ${100},
                            ${"test.first"},
                            ${"{}"}
                        ),
                        (
                            ${"00000000-0000-7000-8000-000000000002"},
                            ${"agent-order"},
                            ${50},
                            ${"test.second"},
                            ${"{}"}
                        )`,
            );
            await expect(events.beforeStart?.(database.context)).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("rejects an origin cursor that still exists in the retained event window", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "events-origin-in-window-test");
        await database.ready;
        try {
            const origin = "00000000-0000-7000-8000-000000000001";
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_event_state (key, value)
                    VALUES (${"origin_cursor"}, ${origin})`,
            );
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_events
                    (event_id, agent_id, occurred_at, type, payload_json)
                    VALUES
                        (${origin}, ${"agent-origin"}, ${1}, ${"test.first"}, ${"{}"}),
                        (
                            ${"00000000-0000-7000-8000-000000000002"},
                            ${"agent-origin"},
                            ${2},
                            ${"test.second"},
                            ${"{}"}
                        )`,
            );
            await expect(events.beforeStart?.(database.context)).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("does not alias mutable persisted payloads across reloads", async () => {
        const first = new EventsModule();
        const database = moduleDatabase(first.migrations ?? [], "events-payload-reload-test");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            const recorded = await first.record(database.context, {
                payload: { present: true, omitted: undefined },
                type: "test.payload-reload",
            });
            expect((recorded.payload as { omitted?: undefined }).omitted).toBeUndefined();

            const restarted = new EventsModule();
            await restarted.beforeStart?.(database.context);
            const reloadedPayload = restarted.replay(restarted.originCursor())?.events[0]?.payload;
            expect(reloadedPayload).toEqual(recorded.payload);
            expect(
                Object.prototype.hasOwnProperty.call(
                    reloadedPayload as Record<string, unknown>,
                    "omitted",
                ),
            ).toBe(true);
        } finally {
            database.close();
        }
    });

    it("deep-freezes values nested inside structured-clone collection payloads", async () => {
        const observed: { readonly payload: unknown }[] = [];
        const events = new EventsModule();
        events.observe({
            onEvent: (_ctx, event) => {
                observed.push(event);
            },
        });
        const database = moduleDatabase(events.migrations ?? [], "events-payload-collections-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            await events.record(database.context, {
                payload: new Map([["nested", { value: 1 }]]),
                type: "test.collection-payload",
            });
            const nested = (observed[0]!.payload as Map<string, { value: number }>).get("nested");
            expect(nested).toBeDefined();
            expect(Object.isFrozen(nested)).toBe(true);
        } finally {
            database.close();
        }
    });
});
