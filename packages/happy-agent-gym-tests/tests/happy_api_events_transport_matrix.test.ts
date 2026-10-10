import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 60_000;
const UNKNOWN_CURSOR = "00000000-0000-7000-8000-000000000000";
type HappyAgentClient = AgentGym["client"];
type EventStreamFrame =
    ReturnType<HappyAgentClient["streamEvents"]> extends AsyncGenerator<
        infer Frame,
        unknown,
        unknown
    >
        ? Frame
        : never;
type EventStreamOptions = NonNullable<Parameters<HappyAgentClient["streamEvents"]>[0]>;

type ApiFailure = {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
};

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("Happy Agent event transport matrix", () => {
    it(
        "events-transport-001 returns an empty page after the latest cursor",
        async () => {
            const gym = await startGym();
            const latest = (await gym.client.getEvents({ limit: 1 })).latestCursor;

            const page = await gym.client.getEvents({ after: latest, limit: 5 });

            expect(page.events).toEqual([]);
            expect(page.cursor).toBe(latest);
            expect(page.latestCursor).toBe(latest);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-002 starts an omitted-after pull at the oldest retained event",
        async () => {
            const gym = await startGym();

            const stable = await stablePages(gym, 1, 10_000);
            const first = stable.first;
            const complete = stable.second;

            expect(first.events).toHaveLength(1);
            expect(complete.events.length).toBeGreaterThan(0);
            expect(first.events[0]?.cursor).toBe(complete.events[0]?.cursor);
            expect(first.latestCursor).toBe(complete.latestCursor);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-003 advances exclusive-after pages without duplicating a cursor",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await createAgents(gym, 3, "events-transport-003");

            const all = await gym.client.getEvents({ after: baseline, limit: 10 });
            expect(all.events.length).toBeGreaterThanOrEqual(3);
            const first = all.events[0];
            const second = all.events[1];
            if (first === undefined || second === undefined) {
                throw new Error("The seeded event page did not contain two events.");
            }

            const continuation = await gym.client.getEvents({
                after: first.cursor,
                limit: 10,
            });

            expect(continuation.events[0]?.cursor).toBe(second.cursor);
            expect(continuation.events.every((event) => event.cursor !== first.cursor)).toBe(true);
            expectStrictlyIncreasing(continuation.events.map((event) => event.cursor));
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-004 includes the until cursor while excluding the after cursor",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await createAgents(gym, 3, "events-transport-004");
            const all = await gym.client.getEvents({ after: baseline, limit: 10 });
            const first = all.events[0];
            const second = all.events[1];
            if (first === undefined || second === undefined) {
                throw new Error("The seeded event page did not contain two events.");
            }

            const page = await gym.client.getEvents({
                after: baseline,
                until: second.cursor,
                limit: 10,
            });

            expect(page.events.map((event) => event.cursor)).toEqual([first.cursor, second.cursor]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-005 returns no event when equal cursors form exclusive and inclusive bounds",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await createAgents(gym, 2, "events-transport-005");
            const all = await gym.client.getEvents({ after: baseline, limit: 10 });
            const first = all.events[0];
            if (first === undefined) throw new Error("The seeded event page was empty.");

            const page = await gym.client.getEvents({
                after: first.cursor,
                until: first.cursor,
                limit: 10,
            });

            expect(page.events).toEqual([]);
            expect(page.cursor).toBe(first.cursor);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-006 honors a small limit and returns its continuation cursor",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await createAgents(gym, 4, "events-transport-006");

            const firstPage = await gym.client.getEvents({ after: baseline, limit: 2 });
            expect(firstPage.events).toHaveLength(2);
            expect(firstPage.cursor).toBe(firstPage.events[1]?.cursor);

            const secondPage = await gym.client.getEvents({
                after: firstPage.cursor,
                limit: 2,
            });
            expect(secondPage.events).toHaveLength(2);
            expect(secondPage.events[0]?.cursor).not.toBe(firstPage.events[0]?.cursor);
            expect(secondPage.latestCursor >= secondPage.cursor).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-007 keeps latestCursor at the journal head on a truncated page",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await createAgents(gym, 3, "events-transport-007");
            const page = await gym.client.getEvents({ after: baseline, limit: 1 });

            expect(page.events).toHaveLength(1);
            expect(page.latestCursor >= page.cursor).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-008 rejects a malformed after cursor with invalid_request",
        async () => {
            const gym = await startGym();

            const failure = await captureFailure(() =>
                gym.client.getEvents({ after: "not-a-uuidv7-cursor" }),
            );

            expect(failure).toMatchObject({
                code: "invalid_request",
                status: 400,
            });
            await expect(gym.client.getEvents({ limit: 1 })).resolves.toMatchObject({
                events: expect.any(Array),
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-009 rejects a malformed until cursor with invalid_request",
        async () => {
            const gym = await startGym();

            const failure = await captureFailure(() =>
                gym.client.getEvents({ until: "not-a-uuidv7-cursor" }),
            );

            expect(failure).toMatchObject({
                code: "invalid_request",
                status: 400,
            });
            await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-010 rejects a zero event limit without changing the journal",
        async () => {
            const gym = await startGym();

            const failure = await captureFailure(() => gym.client.getEvents({ limit: 0 }));

            expect(failure).toMatchObject({
                code: "invalid_request",
                status: 400,
            });
            await expect(gym.client.getEvents({ limit: 1 })).resolves.toMatchObject({
                events: expect.any(Array),
                latestCursor: expect.any(String),
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-011 rejects an event limit above the journal bound",
        async () => {
            const gym = await startGym();

            const failure = await captureFailure(() => gym.client.getEvents({ limit: 10_001 }));

            expect(failure).toMatchObject({
                code: "invalid_request",
                status: 400,
            });
            await expect(gym.client.getEvents({ limit: 1 })).resolves.toMatchObject({
                latestCursor: expect.any(String),
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-012 rejects an unknown after cursor with cursor_unavailable",
        async () => {
            const gym = await startGym();

            const failure = await captureFailure(() =>
                gym.client.getEvents({ after: UNKNOWN_CURSOR }),
            );

            expect(failure).toMatchObject({
                code: "cursor_unavailable",
                status: 409,
                body: { cursor: expect.any(String) },
            });
            await expect(gym.client.getHealth()).resolves.toMatchObject({ healthy: true });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-013 rejects an unknown until cursor with cursor_unavailable",
        async () => {
            const gym = await startGym();

            const failure = await captureFailure(() =>
                gym.client.getEvents({ until: UNKNOWN_CURSOR }),
            );

            expect(failure).toMatchObject({
                code: "cursor_unavailable",
                status: 409,
                body: { cursor: expect.any(String) },
            });
            await expect(gym.client.getEvents({ limit: 1 })).resolves.toMatchObject({
                events: expect.any(Array),
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-014 returns an empty page for reversed event bounds",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await createAgents(gym, 3, "events-transport-014");
            const all = await gym.client.getEvents({ after: baseline, limit: 10 });
            const first = all.events[0];
            const last = all.events.at(-1);
            if (first === undefined || last === undefined) {
                throw new Error("The seeded event page was empty.");
            }

            const page = await gym.client.getEvents({
                after: last.cursor,
                until: first.cursor,
                limit: 10,
            });

            expect(page.events).toEqual([]);
            expect(page.cursor).toBe(last.cursor);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-015 preserves a complete event envelope and UUIDv7 cursor",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const mutationId = "events-transport-015-mutation";
            await createAgent(gym, "events-transport-015-agent", mutationId);

            const all = await gym.client.getEvents({ after: baseline, limit: 10 });
            const event = all.events.find(
                (candidate) =>
                    candidate.type === "agent.created" &&
                    candidate.payload.mutationId === mutationId,
            );
            expect(event).toMatchObject({
                cursor: expect.stringMatching(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                ),
                occurredAt: expect.any(Number),
                payload: expect.any(Object),
                type: "agent.created",
            });
            if (event?.type !== "agent.created") throw new Error("Expected agent.created.");
            expect(event.payload.mutationId).toBe(mutationId);
            const page = await gym.client.getEvents({
                after: baseline,
                until: event.cursor,
                limit: 10,
            });
            expect(page.cursor).toBe(event.cursor);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-016 opens a fresh SSE stream with an honest hello",
        async () => {
            const gym = await startGym();

            await withStream(gym.client, {}, async (iterator) => {
                const frame = await nextFrame(iterator);
                expect(frame).toMatchObject({
                    kind: "hello",
                    hello: {
                        cursor: expect.stringMatching(
                            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                        ),
                        gap: false,
                        resumed: false,
                        connectedAt: expect.any(Number),
                    },
                });
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-017 replays only events after an SSE after cursor",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await createAgents(gym, 2, "events-transport-017");
            const all = await gym.client.getEvents({ after: baseline, limit: 10 });
            const first = all.events[0];
            const second = all.events[1];
            if (first === undefined || second === undefined) {
                throw new Error("The seeded event page did not contain two events.");
            }

            await withStream(gym.client, { after: first.cursor }, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { gap: false, resumed: true },
                });
                const replay = await nextFrame(iterator);
                expect(replay).toMatchObject({
                    kind: "event",
                    cursor: second.cursor,
                    event: { cursor: second.cursor },
                });
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-018 resumes through Last-Event-ID without replaying that cursor",
        async () => {
            const gym = await startGym();
            const first = await createAgent(
                gym,
                "events-transport-018-first",
                "events-transport-018-a",
            );
            const firstCursor = await cursorForAgent(gym.client, first.agent.id);

            await withStream(gym.client, { lastEventId: firstCursor }, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { gap: false, resumed: true },
                });
                const next = createAgent(
                    gym,
                    "events-transport-018-second",
                    "events-transport-018-b",
                );
                const frame = await nextEventMatching(
                    iterator,
                    (event) =>
                        event.type === "agent.created" &&
                        event.payload.agent.id === "eventstransport018second",
                );
                expect(frame.cursor).not.toBe(firstCursor);
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-019 resumes through the after query at the current cursor",
        async () => {
            const gym = await startGym();
            const created = await createAgent(
                gym,
                "events-transport-019-agent",
                "events-transport-019",
            );
            const cursor = await cursorForAgent(gym.client, created.agent.id);

            await withStream(gym.client, { after: cursor }, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { cursor: expect.any(String), gap: false, resumed: true },
                });
                const next = createAgent(
                    gym,
                    "events-transport-019-next",
                    "events-transport-019-next",
                );
                const event = await nextFrameAfter(iterator, next);
                expect(event.kind).toBe("event");
                if (event.kind === "event") expect(event.cursor).not.toBe(cursor);
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-020 gives Last-Event-ID precedence over an older after query",
        async () => {
            const gym = await startGym();
            const first = await createAgent(
                gym,
                "events-transport-020-first",
                "events-transport-020-a",
            );
            const firstCursor = await cursorForAgent(gym.client, first.agent.id);
            const second = await createAgent(
                gym,
                "events-transport-020-second",
                "events-transport-020-b",
            );
            const secondCursor = await cursorForAgent(gym.client, second.agent.id);

            await withStream(
                gym.client,
                { after: firstCursor, lastEventId: secondCursor },
                async (iterator) => {
                    const hello = await nextFrame(iterator);
                    expect(hello).toMatchObject({
                        kind: "hello",
                        hello: { gap: false, resumed: true },
                    });
                    const third = createAgent(
                        gym,
                        "events-transport-020-third",
                        "events-transport-020-c",
                    );
                    const frame = await nextEventMatching(
                        iterator,
                        (event) =>
                            event.type === "agent.created" &&
                            event.payload.agent.id === "eventstransport020third",
                    );
                    expect(frame.cursor).not.toBe(firstCursor);
                    expect(frame.cursor).not.toBe(secondCursor);
                },
            );
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-021 reports strictly increasing cursors for live SSE events",
        async () => {
            const gym = await startGym();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;

            await withStream(gym.client, {}, async (iterator) => {
                await nextFrame(iterator);
                await createAgents(gym, 3, "events-transport-021");
                const pulled = await gym.client.getEvents({ after: baseline, limit: 10 });
                const frames = await Promise.all(
                    pulled.events.map(async () => await nextFrame(iterator)),
                );
                const cursors = frames.map((frame) => {
                    expect(frame.kind).toBe("event");
                    if (frame.kind !== "event") throw new Error("Expected an event frame.");
                    return frame.cursor;
                });

                expect(cursors).toEqual(pulled.events.map((event) => event.cursor));
                expectStrictlyIncreasing(cursors);
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-022 reconnects from the last event without duplicates",
        async () => {
            const gym = await startGym();
            const first = await withStream(gym.client, {}, async (iterator) => {
                await nextFrame(iterator);
                const created = createAgent(
                    gym,
                    "events-transport-022-first",
                    "events-transport-022-a",
                );
                const frame = await nextFrameAfter(iterator, created);
                expect(frame.kind).toBe("event");
                if (frame.kind !== "event") throw new Error("Expected the first event frame.");
                return frame.cursor;
            });

            const second = await withStream(
                gym.client,
                { lastEventId: first },
                async (iterator) => {
                    const hello = await nextFrame(iterator);
                    expect(hello).toMatchObject({
                        kind: "hello",
                        hello: { gap: false, resumed: true },
                    });
                    const created = createAgent(
                        gym,
                        "events-transport-022-second",
                        "events-transport-022-b",
                    );
                    const frame = await nextFrameAfter(iterator, created);
                    expect(frame.kind).toBe("event");
                    if (frame.kind !== "event") throw new Error("Expected the second event frame.");
                    return frame.cursor;
                },
            );

            expect(second).not.toBe(first);
            expect(new Set([first, second]).size).toBe(2);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-023 aborts a bounded SSE reader and releases the connection",
        async () => {
            const gym = await startGym();
            const controller = new AbortController();
            const iterator = gym.client.streamEvents({ signal: controller.signal });
            const hello = await iterator.next();
            expect(hello.value).toMatchObject({ kind: "hello" });

            const pending = iterator.next().then(
                () => "settled" as const,
                () => "rejected" as const,
            );
            controller.abort();

            await expect(pending).resolves.toMatch(/settled|rejected/);
            await iterator.return(undefined);
            await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-024 continues serving pulls after an aborted SSE reader",
        async () => {
            const gym = await startGym();
            const controller = new AbortController();
            const iterator = gym.client.streamEvents({ signal: controller.signal });
            await iterator.next();
            controller.abort();
            await iterator.return(undefined);

            const created = await createAgent(
                gym,
                "events-transport-024-agent",
                "events-transport-024",
            );
            const cursor = await cursorForAgent(gym.client, created.agent.id);
            const page = await gym.client.getEvents({ after: cursor, limit: 1 });

            expect(page.events).toEqual([]);
            expect(page.cursor).toBe(cursor);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-025 announces a gap for an unavailable SSE cursor",
        async () => {
            const gym = await startGym();

            await withStream(gym.client, { after: UNKNOWN_CURSOR }, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { cursor: expect.any(String), gap: true, resumed: false },
                });
                const created = createAgent(
                    gym,
                    "events-transport-025-agent",
                    "events-transport-025",
                );
                const event = await nextFrameAfter(iterator, created);
                expect(event.kind).toBe("event");
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-026 reconnects after a gap from the hello cursor",
        async () => {
            const gym = await startGym();
            const gapCursor = await withStream(
                gym.client,
                { lastEventId: UNKNOWN_CURSOR },
                async (iterator) => {
                    const hello = await nextFrame(iterator);
                    expect(hello.kind).toBe("hello");
                    if (hello.kind !== "hello") throw new Error("Expected a hello frame.");
                    expect(hello.hello.gap).toBe(true);
                    return hello.hello.cursor;
                },
            );

            await withStream(gym.client, { lastEventId: gapCursor }, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { gap: false, resumed: true },
                });
                const created = createAgent(
                    gym,
                    "events-transport-026-agent",
                    "events-transport-026",
                );
                const event = await nextFrameAfter(iterator, created);
                expect(event.kind).toBe("event");
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-027 carries a mutation echo through the SSE event payload",
        async () => {
            const gym = await startGym();
            const mutationId = "events-transport-027-mutation";

            await withStream(gym.client, {}, async (iterator) => {
                await nextFrame(iterator);
                const created = createAgent(gym, "events-transport-027-agent", mutationId);
                await created;
                const frame = await nextEventMatching(
                    iterator,
                    (event) =>
                        event.type === "agent.created" && event.payload.mutationId === mutationId,
                );

                if (frame.event.type !== "agent.created") {
                    throw new Error("Expected an agent.created event.");
                }
                expect(frame.event.payload.mutationId).toBe(mutationId);
                expect(frame.event.payload.agent.id).toBe("eventstransport027agent");
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-028 restarts with a usable typed client and fresh stream",
        async () => {
            const gym = await startGym();
            const before = await gym.client.getAgent(gym.defaultSessionId);
            await gym.restart();

            await expect(gym.client.getAgent(gym.defaultSessionId)).resolves.toMatchObject({
                agent: {
                    id: before.agent.id,
                    workspaceId: before.agent.workspaceId,
                },
            });
            await withStream(gym.client, {}, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { gap: false, resumed: false, cursor: expect.any(String) },
                });
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-029 publishes post-restart mutations through a new SSE connection",
        async () => {
            const gym = await startGym();
            await createAgent(gym, "events-transport-029-before", "events-transport-029-a");
            await gym.restart();
            await waitForStableCursor(gym);

            await withStream(gym.client, {}, async (iterator) => {
                await nextFrame(iterator);
                const created = createAgent(
                    gym,
                    "events-transport-029-after",
                    "events-transport-029-b",
                );
                await created;
                const event = await nextEventMatching(
                    iterator,
                    (candidate) =>
                        candidate.type === "agent.created" &&
                        candidate.payload.agent.id === "eventstransport029after",
                );
                expect(event).toMatchObject({
                    kind: "event",
                    event: { type: "agent.created" },
                });
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-030 reports a pre-restart cursor as a gap after daemon restart",
        async () => {
            const gym = await startGym();
            const created = await createAgent(
                gym,
                "events-transport-030-before",
                "events-transport-030-a",
            );
            const oldCursor = await cursorForAgent(gym.client, created.agent.id);
            await gym.restart();

            await withStream(gym.client, { lastEventId: oldCursor }, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { gap: true, resumed: false },
                });
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-031 closes the bootstrap snapshot window with an event replay",
        async () => {
            const gym = await startGym();
            const bootstrap = await gym.client.getDesktopBootstrap();
            const created = await createAgent(
                gym,
                "events-transport-031-agent",
                "events-transport-031",
            );

            const replay = await gym.client.getEvents({
                after: bootstrap.cursor,
                limit: 10,
            });
            expect(replay.events.some((event) => event.type === "agent.created")).toBe(true);
            expect(
                replay.events.some(
                    (event) =>
                        event.type === "agent.created" &&
                        event.payload.agent.id === created.agent.id,
                ),
            ).toBe(true);

            await withStream(gym.client, { after: bootstrap.cursor }, async (iterator) => {
                const hello = await nextFrame(iterator);
                expect(hello).toMatchObject({
                    kind: "hello",
                    hello: { gap: false, resumed: true },
                });
                const event = await nextEventMatching(
                    iterator,
                    (candidate) =>
                        candidate.type === "agent.created" &&
                        candidate.payload.agent.id === created.agent.id,
                );
                expect(event).toMatchObject({
                    kind: "event",
                    event: { type: "agent.created", payload: { agent: { id: created.agent.id } } },
                });
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "events-transport-032 keeps a bootstrap cursor usable for a follow-up pull",
        async () => {
            const gym = await startGym();
            const bootstrap = await gym.client.getDesktopBootstrap();
            const page = await gym.client.getEvents({
                after: bootstrap.cursor,
                limit: 10,
            });

            expect(page.cursor).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expect(page.latestCursor).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expectStrictlyIncreasing(page.events.map((event) => event.cursor));
            expect(page.events.every((event) => event.cursor > bootstrap.cursor)).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );
});

async function startGym(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    activeGyms.add(gym);
    // Startup keeps writing in the background until the root checkout and the Git probe have
    // settled; the matrix asserts exact event windows, so those writes must land first.
    await gym.waitUntil(
        async () => {
            const bootstrap = await gym.client.getDesktopBootstrap();
            const settled = bootstrap.projects.every(
                (project) =>
                    project.initialization.status !== "initializing" &&
                    project.worktreeSupport !== "unknown",
            );
            return settled ? true : undefined;
        },
        "startup project probes to settle",
        15_000,
    );
    await waitForStableCursor(gym);
    return gym;
}

async function rootWorkspaceId(client: HappyAgentClient): Promise<string> {
    const projects = await client.listProjects();
    const root = projects.projects[0];
    if (root === undefined) throw new Error("The gym did not expose its root project.");
    return root.id;
}

async function createAgents(gym: AgentGym, count: number, prefix: string): Promise<void> {
    const workspaceId = await rootWorkspaceId(gym.client);
    for (let index = 0; index < count; index += 1) {
        const agentId = publicAgentId(`${prefix}agent${String(index)}`);
        const mutationId = `${prefix}-mutation-${String(index)}`;
        await gym.client.createAgent({
            id: agentId,
            mutationId,
            workspaceId,
        });
    }
}

async function createAgent(
    gym: AgentGym,
    id: string,
    mutationId: string,
): Promise<{ readonly agent: { readonly id: string } }> {
    const workspaceId = await rootWorkspaceId(gym.client);
    return await gym.client.createAgent({
        id: publicAgentId(id),
        mutationId,
        workspaceId,
    });
}

function publicAgentId(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (normalized.length < 2) throw new Error("The test agent ID was empty.");
    return normalized.slice(0, 96);
}

async function waitForStableCursor(gym: AgentGym): Promise<string> {
    return await gym.waitUntil(
        async () => {
            const first = await gym.client.getEvents({ limit: 1 });
            const second = await gym.client.getEvents({ limit: 1 });
            return first.latestCursor === second.latestCursor ? first.latestCursor : undefined;
        },
        "the startup event cursor to settle",
        15_000,
    );
}

async function stablePages(
    gym: AgentGym,
    firstLimit: number,
    secondLimit: number,
): Promise<{
    readonly first: Awaited<ReturnType<HappyAgentClient["getEvents"]>>;
    readonly second: Awaited<ReturnType<HappyAgentClient["getEvents"]>>;
}> {
    return await gym.waitUntil(
        async () => {
            const first = await gym.client.getEvents({ limit: firstLimit });
            const second = await gym.client.getEvents({ limit: secondLimit });
            return first.latestCursor === second.latestCursor ? { first, second } : undefined;
        },
        "event pages to share a latest cursor",
        15_000,
    );
}

async function cursorForAgent(client: HappyAgentClient, agentId: string): Promise<string> {
    const events = await client.getEvents({ limit: 10_000 });
    const event = [...events.events]
        .reverse()
        .find(
            (candidate) =>
                candidate.type === "agent.created" && candidate.payload.agent.id === agentId,
        );
    if (event === undefined) throw new Error(`No agent.created event for ${agentId}.`);
    return event.cursor;
}

async function captureFailure(action: () => Promise<unknown>): Promise<ApiFailure> {
    try {
        await action();
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null) {
            const candidate = error as {
                readonly body?: unknown;
                readonly code?: unknown;
                readonly status?: unknown;
            };
            if (typeof candidate.status === "number") {
                return {
                    body:
                        typeof candidate.body === "object" &&
                        candidate.body !== null &&
                        !Array.isArray(candidate.body)
                            ? (candidate.body as Record<string, unknown>)
                            : null,
                    code: typeof candidate.code === "string" ? candidate.code : null,
                    status: candidate.status,
                };
            }
        }
        throw error;
    }
    throw new Error("Expected the public client request to fail.");
}

async function withStream<Result>(
    client: HappyAgentClient,
    options: Omit<EventStreamOptions, "signal">,
    action: (iterator: AsyncGenerator<EventStreamFrame>) => Promise<Result>,
): Promise<Result> {
    const controller = new AbortController();
    const iterator = client.streamEvents({ ...options, signal: controller.signal });
    try {
        return await action(iterator);
    } finally {
        controller.abort();
        await iterator.return(undefined).catch(() => undefined);
    }
}

async function nextFrame(iterator: AsyncGenerator<EventStreamFrame>): Promise<EventStreamFrame> {
    const result = await iterator.next();
    if (result.done) throw new Error("The event stream ended before the expected frame.");
    return result.value;
}

async function nextFrameAfter(
    iterator: AsyncGenerator<EventStreamFrame>,
    mutation: Promise<unknown>,
): Promise<EventStreamFrame> {
    await mutation;
    return await nextFrame(iterator);
}

async function nextEventMatching(
    iterator: AsyncGenerator<EventStreamFrame>,
    predicate: (event: Extract<EventStreamFrame, { kind: "event" }>["event"]) => boolean,
): Promise<Extract<EventStreamFrame, { kind: "event" }>> {
    for (;;) {
        const frame = await nextFrame(iterator);
        if (frame.kind === "event" && predicate(frame.event)) return frame;
    }
}

function expectStrictlyIncreasing(values: readonly string[]): void {
    for (let index = 1; index < values.length; index += 1) {
        const previous = values[index - 1];
        const current = values[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        expect(current && previous && current > previous).toBe(true);
    }
}
