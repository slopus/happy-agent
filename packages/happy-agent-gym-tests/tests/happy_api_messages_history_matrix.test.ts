import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    createAgentGym,
    type AgentGym,
    type GymAgentEvent,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public message and history matrix", () => {
    it("MH-01 starts with an empty complete history", async () => {
        const gym = await startGym();
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history).toEqual({ cursor: expect.any(String), hasMore: false, runs: [] });
        await expect(gym.client.getAgentBootstrap(gym.defaultSessionId)).resolves.toMatchObject({
            pending: [],
        });
    });

    it("MH-02 stores one accepted user and assistant message in one run", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "one answer", type: "text" }] }],
        });
        const accepted = await gym.send("one question");
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0]).toMatchObject({
            id: accepted.runId,
            reason: "completed",
            status: "completed",
        });
        expect(history.runs[0]?.messages.map((message) => message.role)).toEqual(["user", "agent"]);
        expect(textOf(history.runs[0]?.messages[0])).toContain("one question");
        expect(textOf(history.runs[0]?.messages[1])).toContain("one answer");
    });

    it("MH-03 keeps a queued message pending while the first provider turn is gated", async () => {
        let release!: () => void;
        let providerStarted!: () => void;
        const providerReady = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let agentCallIndex = 0;
        const gym = await startGym({
            inference: async (request): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) return namingTurn("Queued message");
                const callIndex = agentCallIndex;
                agentCallIndex += 1;
                if (callIndex === 0) {
                    providerStarted();
                    await gate;
                }
                return { content: [{ text: `answer ${String(callIndex)}`, type: "text" }] };
            },
        });

        const first = await gym.send("first", { wait: false });
        await providerReady;
        const queued = await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            mode: modeFor(gym),
            text: "queued",
        });
        expect(queued.message).toMatchObject({
            delivery: "queue",
            role: "user",
            runId: null,
            status: "pending",
        });
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).pending).toContainEqual(
            queued.message,
        );

        release();
        await gym.waitForRun(first.runId);
        await gym.waitUntil(async () => {
            const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
            return bootstrap.pending.length === 0 ? bootstrap : undefined;
        }, "queued message acceptance");
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs).toHaveLength(2);
        expect(textOf(history.runs[1]?.messages[0])).toContain("queued");
    }, 30_000);

    it("MH-04 accepts three queued messages in submission order in one run", async () => {
        let release!: () => void;
        let providerStarted!: () => void;
        const providerReady = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let agentCallIndex = 0;
        const gym = await startGym({
            inference: async (request): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) return namingTurn("Queued batch");
                const callIndex = agentCallIndex;
                agentCallIndex += 1;
                if (callIndex === 0) {
                    providerStarted();
                    await gate;
                }
                return { content: [{ text: `reply-${String(callIndex)}`, type: "text" }] };
            },
        });
        const first = await gym.send("first", { wait: false });
        await providerReady;
        const queued = await Promise.all(
            ["second", "third", "fourth"].map((text) =>
                gym.client.sendMessage(gym.defaultSessionId, {
                    delivery: "queue",
                    mode: modeFor(gym),
                    text,
                }),
            ),
        );
        expect(queued.map((response) => response.message.content[0])).toEqual([
            { text: "second", type: "text" },
            { text: "third", type: "text" },
            { text: "fourth", type: "text" },
        ]);
        release();
        await gym.waitForRun(first.runId);
        await gym.waitUntil(async () => {
            const [bootstrap, history] = await Promise.all([
                gym.client.getAgentBootstrap(gym.defaultSessionId),
                gym.client.getMessages(gym.defaultSessionId),
            ]);
            return bootstrap.pending.length === 0 && history.runs.length === 2
                ? history
                : undefined;
        }, "all queued messages to run");
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(textOf(history.runs[0]?.messages[0])).toEqual(["first"]);
        expect(
            history.runs[1]?.messages
                .filter((message) => message.role === "user")
                .flatMap((message) => textOf(message)),
        ).toEqual(["second", "third", "fourth"]);
    }, 40_000);

    it("MH-05 returns the complete pending list from bootstrap independently of history paging", async () => {
        let release!: () => void;
        let providerStarted!: () => void;
        const providerReady = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let agentCallIndex = 0;
        const gym = await startGym({
            inference: async (request): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) return namingTurn("Pending messages");
                const callIndex = agentCallIndex;
                agentCallIndex += 1;
                if (callIndex === 0) {
                    providerStarted();
                    await gate;
                }
                return { content: [{ text: "done", type: "text" }] };
            },
        });
        const first = await gym.send("working", { wait: false });
        await providerReady;
        for (const text of ["p1", "p2", "p3"]) {
            await gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "queue",
                mode: modeFor(gym),
                text,
            });
        }
        const page = await gym.client.getMessages(gym.defaultSessionId, { limit: 1 });
        expect(page).not.toHaveProperty("pending");
        const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
        expect(bootstrap.pending.map((message) => textOf(message))).toEqual([
            ["p1"],
            ["p2"],
            ["p3"],
        ]);
        release();
        await gym.waitForRun(first.runId);
    }, 30_000);

    it("MH-06 treats history limit as a lower bound and never splits a run", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "first", type: "text" }] },
                { content: [{ text: "second", type: "text" }] },
            ],
        });
        await gym.send("one");
        await gym.send("two");
        const page = await gym.client.getMessages(gym.defaultSessionId, { limit: 1 });
        expect(page.runs).toHaveLength(1);
        expect(page.runs[0]?.messages).toHaveLength(2);
        expect(page.hasMore).toBe(true);
    });

    it("MH-07 pages older whole runs with before", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "a", type: "text" }] },
                { content: [{ text: "b", type: "text" }] },
                { content: [{ text: "c", type: "text" }] },
            ],
        });
        const first = await gym.send("a");
        const second = await gym.send("b");
        await gym.send("c");
        const older = await gym.client.getMessages(gym.defaultSessionId, {
            before: second.runId,
            limit: 10,
        });
        expect(older.runs.map((run) => run.id)).toEqual([first.runId]);
        expect(older.hasMore).toBe(false);
    });

    it("MH-08 pages messages after a user message without returning that message twice", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "a", type: "text" }] },
                { content: [{ text: "b", type: "text" }] },
            ],
        });
        await gym.send("a");
        await gym.send("b");
        const complete = await gym.client.getMessages(gym.defaultSessionId);
        const firstUser = complete.runs[0]?.messages.find((message) => message.role === "user");
        if (firstUser === undefined) throw new Error("The first user message was not persisted.");
        const after = await gym.client.getMessages(gym.defaultSessionId, { after: firstUser.id });
        expect(after.runs).toHaveLength(1);
        expect(textOf(after.runs[0]?.messages[0])).toContain("b");
        expect(JSON.stringify(after.runs)).not.toContain('"text":"a"');
    });

    it("MH-09 preserves grouped history and pending state across restart", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "durable", type: "text" }] }],
        });
        await gym.send("persist me");
        const before = await gym.client.getMessages(gym.defaultSessionId);
        await gym.restart();
        const after = await gym.client.getMessages(gym.defaultSessionId);
        expect(after.cursor).not.toBe(before.cursor);
        expect(after.hasMore).toBe(before.hasMore);
        expect(after.runs).toEqual(before.runs);
    });

    it("MH-10 records exact per-run usage by provider and model", async () => {
        const gym = await startGym({
            inference: [
                {
                    content: [{ text: "usage", type: "text" }],
                    usage: {
                        cacheRead: 4,
                        cacheWrite: 5,
                        input: 6,
                        output: 7,
                        totalTokens: 22,
                    },
                },
            ],
        });
        const accepted = await gym.send("usage request");
        const run = (await gym.client.getMessages(gym.defaultSessionId)).runs[0];
        expect(run?.id).toBe(accepted.runId);
        expect(run?.usage[gym.selection.providerId]?.[gym.selection.modelId]).toEqual({
            cacheRead: 4,
            cacheWrite: 5,
            input: 6,
            output: 7,
        });
    });

    it("MH-11 aggregates cache reads and writes across multiple runs", async () => {
        const gym = await startGym({
            inference: [
                {
                    content: [{ text: "one", type: "text" }],
                    usage: {
                        cacheRead: 2,
                        cacheWrite: 3,
                        input: 4,
                        output: 5,
                        totalTokens: 14,
                    },
                },
                {
                    content: [{ text: "two", type: "text" }],
                    usage: {
                        cacheRead: 7,
                        cacheWrite: 11,
                        input: 13,
                        output: 17,
                        totalTokens: 48,
                    },
                },
            ],
        });
        await gym.send("one");
        await gym.send("two");
        const usage = await gym.client.getAgentUsage(gym.defaultSessionId);
        expect(usage.usage[gym.selection.providerId]?.[gym.selection.modelId]).toEqual({
            cacheRead: 9,
            cacheWrite: 14,
            input: 17,
            output: 22,
        });
    });

    it("MH-12 reports zero usage for a turn without provider accounting", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "no accounting", type: "text" }] }],
        });
        await gym.send("no usage");
        const usage = await gym.client.getAgentUsage(gym.defaultSessionId);
        expect(usage.usage[gym.selection.providerId]?.[gym.selection.modelId]).toEqual({
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
        });
    });

    it("MH-13 preserves reasoning and text block order in history and the final stream snapshot", async () => {
        const gym = await startGym({
            inference: [
                {
                    content: [
                        { text: "thinking", type: "reasoning" },
                        { text: "answer", type: "text" },
                    ],
                },
            ],
        });
        await gym.send("ordered blocks");
        const history = await gym.client.getMessages(gym.defaultSessionId);
        const agent = history.runs[0]?.messages.find((message) => message.role === "agent");
        expect(agent?.content).toEqual([
            { text: "thinking", type: "reasoning" },
            { text: "answer", type: "text" },
        ]);
        const finalSnapshot = (await gym.events())
            .filter(
                (event): event is Extract<GymAgentEvent, { type: "message.updated" }> =>
                    event.type === "message.updated" &&
                    event.payload.agentId === gym.defaultSessionId &&
                    event.payload.message.role === "agent",
            )
            .at(-1);
        expect(finalSnapshot?.payload.message.content).toEqual([
            { text: "thinking", type: "reasoning" },
            { text: "answer", type: "text" },
        ]);
    });

    it("MH-14 emits deltas and reconstructs split streaming text from history", async () => {
        const gym = await startGym({
            inference: (request) =>
                request.instructions.includes("You name a piece of work")
                    ? { content: [{ text: "Streamed text", type: "text" }] }
                    : {
                          content: [{ text: "streamed text", type: "text" }],
                          textDeltaChunkSize: 3,
                      },
        });
        const accepted = await gym.send("stream");
        const events = await gym.events();
        const deltas = events.filter(
            (event): event is Extract<GymAgentEvent, { type: "message.delta" }> =>
                event.type === "message.delta" && event.payload.agentId === gym.defaultSessionId,
        );
        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.map((event) => event.payload.append).join("")).toContain("streamed text");
        for (let index = 1; index < deltas.length; index += 1) {
            const previous = deltas[index - 1];
            const current = deltas[index];
            if (previous === undefined || current === undefined) {
                throw new Error("The streamed delta sequence was incomplete.");
            }
            expect(current.payload.offset).toBe(
                previous.payload.offset + previous.payload.append.length,
            );
        }
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(
            textOf(history.runs.find((run) => run.id === accepted.runId)?.messages.at(-1)),
        ).toContain("streamed text");
    });

    it("MH-15 removes reset content and retains only the replacement message", async () => {
        const gym = await startGym({
            inference: [
                {
                    events: [
                        { type: "block_start" },
                        { type: "text_start" },
                        { delta: "discarded", type: "text_delta" },
                        { type: "block_reset" },
                        { type: "block_start" },
                        { type: "text_start" },
                        { delta: "replacement", type: "text_delta" },
                        { type: "text_end" },
                        { type: "block_stop" },
                        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
                    ],
                },
            ],
        });
        await gym.send("reset");
        const events = await gym.events();
        expect(events.some((event) => event.type === "message.deleted")).toBe(true);
        const history = await gym.client.getMessages(gym.defaultSessionId);
        const rendered = JSON.stringify(history.runs);
        expect(rendered).toContain("replacement");
        expect(rendered).not.toContain("discarded");
    });

    it("MH-16 returns tool data by default and omits raw fields on request", async () => {
        let agentCall = 0;
        const gym = await startGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Matrix tool</title><slug>matrix-tool</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                const call = agentCall;
                agentCall += 1;
                return call === 0
                    ? {
                          content: [
                              {
                                  arguments: { cmd: "printf matrix-tool" },
                                  callId: "mh-16-tool",
                                  name: "exec_command",
                                  type: "tool_call",
                              },
                          ],
                      }
                    : { content: [{ text: "tool complete", type: "text" }] };
            },
        });
        await gym.send("run the tool", { permissionMode: "full_access" });
        const full = await gym.client.getMessages(gym.defaultSessionId);
        const omitted = await gym.client.getMessages(gym.defaultSessionId, {
            omitToolData: true,
        });
        const fullTool = firstTool(full);
        const omittedTool = firstTool(omitted);
        expect(fullTool.id).toMatch(/^[a-z][a-z0-9]{1,31}$/);
        expect(fullTool.id).not.toBe("mh-16-tool");
        expect(fullTool).toMatchObject({
            arguments: { cmd: "printf matrix-tool" },
            result: { output: expect.stringContaining("matrix-tool") },
            presentation: {
                type: "exec_command",
                command: "printf matrix-tool",
                output: expect.stringContaining("matrix-tool"),
            },
        });
        expect(omittedTool).toEqual({
            type: "tool_call",
            id: fullTool.id,
            name: "exec_command",
            status: "completed",
            presentation: fullTool.presentation,
        });
        expect(omittedTool).not.toHaveProperty("arguments");
        expect(omittedTool).not.toHaveProperty("result");
    }, 30_000);

    it("MH-17 records a provider failure as a failed run without losing the user message", async () => {
        const gym = await startGym({
            inference: [
                {
                    error: { kind: "unknown", message: "matrix provider failure" },
                },
            ],
        });
        const accepted = await gym.send("fail visibly");
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs[0]).toMatchObject({
            id: accepted.runId,
            reason: "error",
            status: "failed",
        });
        expect(textOf(history.runs[0]?.messages[0])).toContain("fail visibly");
    });

    it("MH-18 records provider retries inside one run instead of duplicating history", async () => {
        const gym = await startGym({
            inference: [
                {
                    content: [{ text: "recovered", type: "text" }],
                    retries: [
                        { attempt: 1, reason: "temporary transport", delayMs: 1 },
                        { attempt: 2, reason: "retryable response", delayMs: 1 },
                    ],
                },
            ],
        });
        const accepted = await gym.send("retry once");
        expect(gym.inference.requests).toHaveLength(1);
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0]?.id).toBe(accepted.runId);
        expect(textOf(history.runs[0]?.messages.at(-1))).toContain("recovered");
    });

    it("MH-19 records explicit compaction as one maintenance lifecycle run", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "before compact", type: "text" }] }],
        });
        await gym.send("compact this");
        const before = await lifecycleEvents(gym);
        const result = await gym.client.compactAgent(gym.defaultSessionId, {
            mutationId: "mh-19-compact",
        });
        expect(result.agent.id).toBe(gym.defaultSessionId);
        await gym.waitForRun(result.run.id);
        expect(await lifecycleEvents(gym)).toEqual([
            ...before,
            `run.started:${result.run.id}`,
            `run.finished:${result.run.id}`,
        ]);
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs).toHaveLength(2);
        expect(history.runs[1]).toMatchObject({
            id: result.run.id,
            reason: "completed",
            status: "completed",
        });
    });

    it("MH-20 sends the complete retained context to a custom compaction handler", async () => {
        let compactedContextLength = 0;
        const gym = await startGym({
            inference: [{ content: [{ text: "context", type: "text" }] }],
            compaction: async (request) => {
                compactedContextLength = request.messages.length;
                return {
                    context: request.context,
                    preservedMessages: request.messages.slice(-1),
                    status: "completed",
                    summary: "matrix summary",
                    usage: {
                        cacheRead: 1,
                        cacheWrite: 0,
                        input: 2,
                        output: 3,
                        totalTokens: 6,
                    },
                };
            },
        });
        await gym.send("retain context");
        await gym.client.compactAgent(gym.defaultSessionId);
        await gym.waitUntil(
            () => (gym.inference.compactions.length > 0 ? true : undefined),
            "custom compaction",
        );
        expect(compactedContextLength).toBeGreaterThan(0);
        expect(gym.inference.compactions[0]?.messages.length).toBe(compactedContextLength);
    });

    it("MH-21 persists the exact last mode on the agent and user message", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "mode", type: "text" }] }],
        });
        const accepted = await gym.send("mode check", {
            effort: "high",
            modelId: "gym/model-2",
            permissionMode: "workspace_write",
        });
        const history = await gym.client.getMessages(gym.defaultSessionId);
        const user = history.runs[0]?.messages.find((message) => message.role === "user");
        expect(user).toMatchObject({
            id: accepted.id,
            mode: {
                effort: "high",
                modelId: "gym/model-2",
                permissionMode: "workspace_write",
                providerId: "gym",
                serviceTier: null,
            },
        });
        await expect(gym.client.getAgentMode(gym.defaultSessionId)).resolves.toEqual({
            mode: user?.mode,
        });
    });

    it("MH-22 reuses a client message ID without duplicating pending or accepted work", async () => {
        let release!: () => void;
        let providerStarted!: () => void;
        const providerReady = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let realCallIndex = 0;
        const gym = await startGym({
            inference: async (request): Promise<GymTurn> => {
                if (request.instructions.includes("You name a piece of work")) {
                    return { content: [{ text: "<title>Retry identity</title>", type: "text" }] };
                }
                const current = realCallIndex;
                realCallIndex += 1;
                if (current === 0) {
                    providerStarted();
                    await gate;
                }
                return { content: [{ text: `answer ${String(current)}`, type: "text" }] };
            },
        });
        const first = await gym.send("blocking", { id: "mh22blocking", wait: false });
        await providerReady;

        const original = await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            id: "mh22retry",
            mode: modeFor(gym),
            text: "original queued message",
        });
        expect(original.message).toMatchObject({
            id: "mh22retry",
            status: "pending",
            delivery: "queue",
            runId: null,
        });

        const [pendingRetry, concurrentRetry] = await Promise.all([
            gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer",
                id: "mh22retry",
                mode: { ...modeFor(gym), modelId: "unavailable-model" },
                text: "this retry must be ignored",
            }),
            gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer",
                id: "mh22retry",
                mode: { ...modeFor(gym), modelId: "another-unavailable-model" },
                text: "this concurrent retry must also be ignored",
            }),
        ]);
        expect(pendingRetry.message).toEqual(original.message);
        expect(concurrentRetry.message).toEqual(original.message);
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).pending).toEqual([
            original.message,
        ]);

        release();
        await gym.waitForRun(first.runId);
        const settled = await gym.waitUntil(async () => {
            const [bootstrap, history] = await Promise.all([
                gym.client.getAgentBootstrap(gym.defaultSessionId),
                gym.client.getMessages(gym.defaultSessionId),
            ]);
            return bootstrap.pending.length === 0 && history.runs.length === 2
                ? history
                : undefined;
        }, "the client-named queued message to settle once");

        const acceptedRetry = await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "steer",
            id: "mh22retry",
            mode: { ...modeFor(gym), modelId: "unavailable-model" },
            text: "this accepted retry must also be ignored",
        });
        const users = settled.runs
            .flatMap((run) => run.messages)
            .filter((message) => message.role === "user");
        expect(users.map((message) => message.id)).toEqual(["mh22blocking", "mh22retry"]);
        expect(users.flatMap((message) => textOf(message))).toEqual([
            "blocking",
            "original queued message",
        ]);
        expect(users.map((message) => message.delivery)).toEqual(["queue", "queue"]);
        expect(acceptedRetry.message).toEqual(users[1]);
    }, 30_000);

    it("MH-23 pages a three-run history from newest to oldest without overlap", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "one", type: "text" }] },
                { content: [{ text: "two", type: "text" }] },
                { content: [{ text: "three", type: "text" }] },
            ],
        });
        const one = await gym.send("one");
        const two = await gym.send("two");
        const three = await gym.send("three");
        const newest = await gym.client.getMessages(gym.defaultSessionId, { limit: 1 });
        const middle = await gym.client.getMessages(gym.defaultSessionId, {
            before: three.runId,
            limit: 1,
        });
        expect(newest.runs.map((run) => run.id)).toEqual([three.runId]);
        expect(middle.runs.map((run) => run.id)).toEqual([two.runId]);
        expect(middle.hasMore).toBe(true);
        const oldest = await gym.client.getMessages(gym.defaultSessionId, {
            before: two.runId,
            limit: 1,
        });
        expect(oldest.runs.map((run) => run.id)).toEqual([one.runId]);
        expect(oldest.hasMore).toBe(false);
        expect(new Set([one.runId, two.runId, three.runId]).size).toBe(3);
    });

    it("MH-24 clears pending after acceptance and returns no duplicate message", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "accepted", type: "text" }] }],
        });
        const accepted = await gym.send("clear pending");
        const history = await gym.client.getMessages(gym.defaultSessionId);
        await expect(gym.client.getAgentBootstrap(gym.defaultSessionId)).resolves.toMatchObject({
            pending: [],
        });
        const occurrences = history.runs
            .flatMap((run) => run.messages)
            .filter((message) => message.id === accepted.id);
        expect(occurrences).toHaveLength(1);
    });

    it("MH-25 returns only the requested run page and reports older history", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "older", type: "text" }] },
                { content: [{ text: "newer", type: "text" }] },
            ],
        });
        const older = await gym.send("older");
        const newer = await gym.send("newer");
        const page = await gym.client.getMessages(gym.defaultSessionId, {
            before: newer.runId,
            limit: 1,
        });
        expect(page.runs.map((run) => run.id)).toEqual([older.runId]);
        expect(page.hasMore).toBe(false);
    });

    it("MH-26 preserves a failed run and its error message after restart", async () => {
        const gym = await startGym({
            inference: [{ error: { kind: "unknown", message: "restart failure" } }],
        });
        await gym.send("persist failure");
        const before = await gym.client.getMessages(gym.defaultSessionId);
        await gym.restart();
        const after = await gym.client.getMessages(gym.defaultSessionId);
        expect(after.cursor).not.toBe(before.cursor);
        expect(after.hasMore).toBe(before.hasMore);
        expect(after.runs).toEqual(before.runs);
        expect(after.runs[0]?.status).toBe("failed");
    });

    it("MH-27 gives an AGENTS.md replacement notice to the model but never to the API", async () => {
        // The notice runs a turn of its own, so the script answers by request rather than by list.
        const gym = await startGym({
            files: { "AGENTS.md": "Always greet the user in Portuguese.\n" },
            inference: (request): GymTurn => ({
                content: [{ text: `answer ${String(request.callIndex)}`, type: "text" }],
            }),
        });
        await gym.send("first");

        // Editing AGENTS.md mid-session makes the daemon inject a replacement notice carrying the
        // whole instruction body. It is context for the model, not conversation for the person.
        await writeFile(
            join(gym.workspacePath, "AGENTS.md"),
            "Always greet the user in Japanese.\n",
            "utf8",
        );
        await gym.send("second");

        const seenByModel = JSON.stringify(gym.inference.requests.at(-1)?.messages ?? []);
        expect(seenByModel).toContain("replace all previously provided AGENTS.md instructions");
        expect(seenByModel).toContain("Always greet the user in Japanese.");

        const history = await gym.client.getMessages(gym.defaultSessionId);
        const transcript = JSON.stringify(history);
        expect(transcript).toContain("second");
        expect(
            history.runs.flatMap((run) => run.messages.map((message) => message.role)),
        ).not.toContain("system");
        expect(transcript).not.toContain("replace all previously provided AGENTS.md instructions");
        expect(transcript).not.toContain("Always greet the user in Japanese.");

        const streamed = JSON.stringify(await gym.events());
        expect(streamed).not.toContain("replace all previously provided AGENTS.md instructions");
        expect(streamed).not.toContain("Always greet the user in Japanese.");
    });
});

async function startGym(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym(options);
    activeGyms.add(gym);
    return gym;
}

function namingTurn(title: string): GymTurn {
    return {
        content: [
            {
                text: `<title>${title}</title><slug>${title.toLowerCase().replaceAll(" ", "-")}</slug>`,
                type: "text",
            },
        ],
    };
}

function modeFor(
    gym: AgentGym,
    permissionMode: "auto" | "workspace_write" | "full_access" = "auto",
) {
    return {
        effort: gym.selection.effort,
        modelId: gym.selection.modelId,
        permissionMode,
        providerId: gym.selection.providerId,
        serviceTier: null,
    } as const;
}

function textOf(
    message:
        | { readonly content?: readonly { readonly type: string; readonly text?: string }[] }
        | undefined,
): string[] {
    return (message?.content ?? [])
        .filter(
            (block): block is { readonly type: "text"; readonly text: string } =>
                block.type === "text",
        )
        .map((block) => block.text);
}

function firstTool(history: Awaited<ReturnType<AgentGym["client"]["getMessages"]>>) {
    for (const run of history.runs) {
        for (const message of run.messages) {
            const tool = message.content.find((block) => block.type === "tool_call");
            if (tool !== undefined) return tool;
        }
    }
    throw new Error("No tool call in history.");
}

async function lifecycleEvents(gym: AgentGym): Promise<readonly string[]> {
    return (await gym.events())
        .filter(
            (event) =>
                event.type === "run.started" ||
                event.type === "run.boundary" ||
                event.type === "run.finished",
        )
        .map((event) => `${event.type}:${runIdOf(event) ?? ""}`);
}

function runIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const direct = (payload as { readonly runId?: unknown }).runId;
    if (typeof direct === "string") return direct;
    if (event.type === "run.boundary") {
        const finished = (payload as { readonly finishedRun?: { readonly id?: unknown } })
            .finishedRun;
        const started = (payload as { readonly startedRun?: { readonly id?: unknown } }).startedRun;
        if (typeof finished?.id === "string") return finished.id;
        if (typeof started?.id === "string") return started.id;
    }
    const run = (payload as { readonly run?: { readonly id?: unknown } }).run;
    return typeof run?.id === "string" ? run.id : undefined;
}
