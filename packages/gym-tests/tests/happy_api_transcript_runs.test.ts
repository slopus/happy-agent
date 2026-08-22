import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymAgentEvent,
} from "@slopus/happy-agent-gym";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public transcript and run APIs", () => {
    it("persists provider startup failures as service messages in the failed run", async () => {
        const failure = "Codex access token could not be refreshed: 401 Unauthorized";
        const gym = await startGym({
            inference: () => {
                throw new Error(failure);
            },
        });

        const sent = await gym.client.sendMessage(gym.defaultSessionId, {
            mode: modeFor(gym),
            text: "Reply with exactly: rig beta zero works",
        });
        const started = await waitForStarted(gym, gym.defaultSessionId, sent.message.id);
        const runId = runIdOf(started);
        if (runId === undefined) throw new Error("The failed run had no ID.");
        await waitForFinished(gym, gym.defaultSessionId, runId);

        const beforeRestart = await gym.client.getMessages(gym.defaultSessionId);
        expect(beforeRestart.runs).toMatchObject([
            {
                id: runId,
                reason: "error",
                status: "failed",
                messages: [
                    {
                        content: [
                            { text: "Reply with exactly: rig beta zero works", type: "text" },
                        ],
                        role: "user",
                    },
                    {
                        content: [{ text: failure, type: "text" }],
                        role: "service",
                    },
                ],
            },
        ]);

        await gym.restart();
        const afterRestart = await gym.client.getMessages(gym.defaultSessionId);
        expect(afterRestart.runs).toEqual(beforeRestart.runs);
        expect(afterRestart.hasMore).toBe(beforeRestart.hasMore);
        expect(
            gym.inference.requests.filter(
                (request) => !request.instructions.includes("You name a piece of work"),
            ),
        ).toHaveLength(1);
    }, 60_000);

    it("keeps queued messages pending, accepts them in order, and pages whole runs", async () => {
        let releaseFirst!: () => void;
        let providerStarted!: () => void;
        const firstProviderStarted = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const firstProviderGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const gym = await startGym({
            inference: async (request) => {
                if (request.callIndex === 0) {
                    providerStarted();
                    await firstProviderGate;
                    return {
                        content: [{ text: "first answer", type: "text" }],
                        usage: {
                            cacheRead: 2,
                            cacheWrite: 3,
                            input: 11,
                            output: 7,
                            totalTokens: 23,
                        },
                    };
                }
                return {
                    content: [{ text: "second answer", type: "text" }],
                    usage: {
                        cacheRead: 5,
                        cacheWrite: 7,
                        input: 13,
                        output: 9,
                        totalTokens: 34,
                    },
                };
            },
        });

        const firstResponse = await gym.client.sendMessage(gym.defaultSessionId, {
            mode: modeFor(gym),
            text: "first question",
        });
        const firstStarted = await waitForStarted(
            gym,
            gym.defaultSessionId,
            firstResponse.message.id,
        );
        const firstRunId = runIdOf(firstStarted);
        if (firstRunId === undefined) throw new Error("The first run had no ID.");
        await firstProviderStarted;

        const secondResponse = await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            mode: modeFor(gym),
            text: "second question",
        });
        expect(secondResponse.message).toMatchObject({
            delivery: "queue",
            id: expect.any(String),
            role: "user",
            runId: null,
            status: "pending",
        });

        const pending = await gym.client.getAgentBootstrap(gym.defaultSessionId);
        expect(pending.pending.map((message) => message.id)).toContain(secondResponse.message.id);
        const duringFirstRun = await gym.client.getMessages(gym.defaultSessionId);
        expect(duringFirstRun.runs).toHaveLength(1);
        expect(duringFirstRun.runs[0]?.id).toBe(firstRunId);

        releaseFirst();
        await waitForFinished(gym, gym.defaultSessionId, firstRunId);
        const secondStarted = await waitForStarted(
            gym,
            gym.defaultSessionId,
            secondResponse.message.id,
        );
        const secondRunId = runIdOf(secondStarted);
        if (secondRunId === undefined) throw new Error("The second run had no ID.");
        await waitForFinished(gym, gym.defaultSessionId, secondRunId);

        const history = await gym.client.getMessages(gym.defaultSessionId);
        await expect(gym.client.getAgentBootstrap(gym.defaultSessionId)).resolves.toMatchObject({
            pending: [],
        });
        expect(history.runs.map((run) => run.id)).toEqual([firstRunId, secondRunId]);
        expect(history.runs.flatMap((run) => run.messages).map((message) => message.role)).toEqual([
            "user",
            "agent",
            "user",
            "agent",
        ]);
        expect(JSON.stringify(history.runs)).toContain("first question");
        expect(JSON.stringify(history.runs)).toContain("second answer");

        const newest = await gym.client.getMessages(gym.defaultSessionId, { limit: 1 });
        expect(newest.runs).toHaveLength(1);
        expect(newest.runs[0]?.id).toBe(secondRunId);
        expect(newest.hasMore).toBe(true);

        const older = await gym.client.getMessages(gym.defaultSessionId, {
            before: secondRunId,
            limit: 1,
        });
        expect(older.runs).toHaveLength(1);
        expect(older.runs[0]?.id).toBe(firstRunId);
        expect(older.hasMore).toBe(false);

        const runUsage = newest.runs[0]?.usage ?? {};
        expect(runUsage[gym.selection.providerId]?.[gym.selection.modelId]).toMatchObject({
            cacheRead: 5,
            cacheWrite: 7,
            input: 13,
            output: 9,
        });
        const usage = await gym.client.getAgentUsage(gym.defaultSessionId);
        expect(usage.usage[gym.selection.providerId]?.[gym.selection.modelId]).toMatchObject({
            cacheRead: 7,
            cacheWrite: 10,
            input: 24,
            output: 16,
        });
    }, 60_000);

    it("bootstraps queued and steering messages outside accepted history", async () => {
        let release!: () => void;
        let providerStarted!: () => void;
        let agentCalls = 0;
        const providerReady = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const gym = await startGym({
            inference: async (request) => {
                if (request.sessionId.startsWith("naming:")) return namingTurn();
                const call = agentCalls;
                agentCalls += 1;
                if (call === 0) {
                    providerStarted();
                    await gate;
                }
                return { content: [{ text: `answer-${String(call)}`, type: "text" }] };
            },
        });

        const first = await gym.send("hold the first run", { wait: false });
        await providerReady;
        const queuedRequest = gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            mode: modeFor(gym),
            text: "queued bootstrap message",
        });
        const steeringRequest = gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "steer",
            mode: modeFor(gym),
            text: "steering bootstrap message",
        });

        const pending = await gym.waitUntil(async () => {
            const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
            return bootstrap.pending.length === 2 ? bootstrap : undefined;
        }, "both pending messages in agent bootstrap");
        expect(pending).toMatchObject({
            agent: { id: gym.defaultSessionId },
            cursor: expect.any(String),
            mode: modeFor(gym),
        });
        expect(pending.pending.map((message) => message.delivery).sort()).toEqual([
            "queue",
            "steer",
        ]);
        expect(await gym.client.getMessages(gym.defaultSessionId)).not.toHaveProperty("pending");

        release();
        await Promise.all([queuedRequest, steeringRequest]);
        await gym.waitForRun(first.runId);
        await gym.waitUntil(async () => {
            const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
            return bootstrap.pending.length === 0 ? true : undefined;
        }, "bootstrap pending messages to be accepted");
    }, 60_000);

    it("reports the current context window and clears it after compaction", async () => {
        const gym = await startGym({
            models: [contextWindowModel()],
            inference: (request) =>
                request.sessionId.startsWith("naming:")
                    ? namingTurn()
                    : {
                          content: [{ text: "measured answer", type: "text" }],
                          usage: {
                              cacheRead: 150_000,
                              cacheWrite: 0,
                              input: 200_000,
                              output: 1_000,
                              totalTokens: 201_000,
                          },
                      },
        });

        await expect(gym.client.getAgentMode(gym.defaultSessionId)).resolves.toEqual({
            mode: null,
        });
        const initialBootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
        expect(initialBootstrap).toMatchObject({
            agent: { id: gym.defaultSessionId },
            context: null,
            mode: null,
            pending: [],
            usage: {},
            cursor: expect.any(String),
        });

        await gym.send("measure this conversation");
        const measuredEvent = await gym.waitForEvent(
            (event) =>
                event.type === "agent.context.updated" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.context?.contextTokens === 201_000,
            "the exact context measurement event",
        );
        expect(measuredEvent).toMatchObject({
            type: "agent.context.updated",
            payload: {
                agentId: gym.defaultSessionId,
                context: {
                    approximate: false,
                    contextTokens: 201_000,
                    contextWindow: 272_000,
                    modelId: "openai/gpt-5.6-sol",
                    providerId: "gym",
                },
            },
        });
        expect(
            (
                await gym.client.getEvents({
                    after: initialBootstrap.cursor,
                    limit: 100,
                })
            ).events,
        ).toContainEqual(measuredEvent);
        const measured = await gym.client.getAgentUsage(gym.defaultSessionId);
        expect(measured).toMatchObject({
            context: {
                approximate: false,
                contextTokens: 201_000,
                contextWindow: 272_000,
                modelId: "openai/gpt-5.6-sol",
                providerId: "gym",
            },
        });
        const mode = await gym.client.getAgentMode(gym.defaultSessionId);
        expect(mode.mode).toMatchObject({
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "auto",
            providerId: "gym",
        });
        await expect(gym.client.getAgentBootstrap(gym.defaultSessionId)).resolves.toMatchObject({
            ...measured,
            ...mode,
            pending: [],
            cursor: expect.any(String),
        });

        await gym.restart();
        await expect(gym.client.getAgentUsage(gym.defaultSessionId)).resolves.toMatchObject({
            context: { contextTokens: 201_000, contextWindow: 272_000 },
        });

        const compacted = await gym.client.compactAgent(gym.defaultSessionId, {
            mutationId: "manual-compaction-success",
        });
        expect(compacted).toMatchObject({
            run: { id: compacted.message.id, status: "running" },
            message: {
                id: compacted.message.id,
                role: "service",
                content: [
                    {
                        type: "compaction",
                        status: "running",
                        tokensBefore: 201_000,
                        trigger: "manual",
                    },
                ],
            },
        });
        await gym.waitUntil(
            () => (gym.inference.compactions.length === 1 ? true : undefined),
            "the measured conversation to compact",
        );
        await gym.waitForEvent(
            (event) =>
                event.type === "message.updated" &&
                event.payload.message.id === compacted.message.id &&
                event.payload.message.content.some(
                    (block) => block.type === "compaction" && block.status === "completed",
                ),
            "the manual compaction to complete",
        );
        await gym.waitForEvent(
            (event) =>
                event.type === "agent.context.updated" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.context === null,
            "the compacted context invalidation event",
        );
        await expect(gym.client.getAgentUsage(gym.defaultSessionId)).resolves.toMatchObject({
            context: null,
        });
        const completed = await gym.client.getMessages(gym.defaultSessionId);
        expect(compactionFrom(completed, compacted.message.id)).toMatchObject({
            run: { id: compacted.run.id, status: "completed" },
            message: { id: compacted.message.id, role: "service" },
            block: {
                failureReason: null,
                status: "completed",
                tokensBefore: 201_000,
                trigger: "manual",
            },
        });

        await gym.restart();
        const afterRestart = await gym.client.getMessages(gym.defaultSessionId);
        expect(afterRestart.runs).toEqual(completed.runs);
        expect(afterRestart.hasMore).toBe(completed.hasMore);
    }, 60_000);

    it("syncs a running manual compaction from durable bootstrap state", async () => {
        let releaseCompaction!: () => void;
        let providerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            releaseCompaction = resolve;
        });
        const gym = await startGym({
            inference: [{ content: [{ text: "ready to compact", type: "text" }] }],
            compaction: async (request) => {
                providerStarted();
                await gate;
                return {
                    status: "completed",
                    preservedMessages: [],
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 100,
                        output: 10,
                        totalTokens: 110,
                    },
                    context: request.context,
                };
            },
        });
        await gym.send("create context before the running sync check");
        const compacted = await gym.client.compactAgent(gym.defaultSessionId);
        await started;

        try {
            expect(
                compactionFrom(
                    await gym.client.getMessages(gym.defaultSessionId),
                    compacted.message.id,
                ),
            ).toMatchObject({
                run: { id: compacted.run.id, status: "running" },
                block: { status: "running", trigger: "manual" },
            });
            const lifecycle = (
                await gym.client.getEvents({
                    after: compacted.cursor,
                    limit: 100,
                })
            ).events;
            expect(lifecycle).toContainEqual(
                expect.objectContaining({
                    type: "run.started",
                    payload: expect.objectContaining({
                        run: expect.objectContaining({ id: compacted.run.id }),
                    }),
                }),
            );
            expect(lifecycle).toContainEqual(
                expect.objectContaining({
                    type: "message.created",
                    payload: expect.objectContaining({
                        message: expect.objectContaining({ id: compacted.message.id }),
                    }),
                }),
            );
        } finally {
            releaseCompaction();
        }
        await gym.waitUntil(async () => {
            const latest = compactionFrom(
                await gym.client.getMessages(gym.defaultSessionId),
                compacted.message.id,
            );
            return latest.block.status === "completed" ? true : undefined;
        }, "the synchronized running compaction to complete");
    }, 60_000);

    it("persists a failed manual compaction with a meaningful reason", async () => {
        const failure = "The provider rejected compaction.";
        const gym = await startGym({
            inference: [{ content: [{ text: "context exists", type: "text" }] }],
            compaction: () => ({
                status: "failed",
                kind: "inference_error",
                message: failure,
            }),
        });
        await gym.send("prepare a failed manual compaction");
        const compacted = await gym.client.compactAgent(gym.defaultSessionId);
        const failed = await gym.waitUntil(async () => {
            const latest = compactionFrom(
                await gym.client.getMessages(gym.defaultSessionId),
                compacted.message.id,
            );
            return latest.block.status === "failed" ? latest : undefined;
        }, "the manual compaction to fail");
        expect(failed).toMatchObject({
            message: { id: compacted.message.id, role: "service" },
            block: {
                completedAt: expect.any(Number),
                failureReason: failure,
                status: "failed",
                trigger: "manual",
            },
        });
        await gym.waitForEvent(
            (event) =>
                event.type === "message.updated" &&
                event.payload.message.id === compacted.message.id &&
                event.payload.message.content.some(
                    (block) =>
                        block.type === "compaction" &&
                        block.status === "failed" &&
                        block.failureReason === failure,
                ),
            "the failed compaction lifecycle event",
        );
        await gym.waitUntil(async () => {
            return (await gym.client.getAgent(gym.defaultSessionId)).agent.status === "idle"
                ? true
                : undefined;
        }, "the agent to leave failed compaction work");
        expect(
            compactionFrom(await gym.client.getMessages(gym.defaultSessionId), compacted.message.id)
                .block.status,
        ).toBe("failed");
    }, 60_000);

    it("automatically compacts before the measured context reaches the model limit", async () => {
        const gym = await startGym({
            models: [contextWindowModel()],
            inference: (request) =>
                request.sessionId.startsWith("naming:")
                    ? namingTurn()
                    : {
                          content: [{ text: "near the limit", type: "text" }],
                          usage: {
                              cacheRead: 200_000,
                              cacheWrite: 0,
                              input: 244_000,
                              output: 1_000,
                              totalTokens: 245_000,
                          },
                      },
        });

        const sent = await gym.send("approach the context limit");
        await gym.waitUntil(
            () => (gym.inference.compactions.length === 1 ? true : undefined),
            "automatic context compaction",
        );
        await expect(gym.client.getAgentUsage(gym.defaultSessionId)).resolves.toMatchObject({
            context: null,
        });
        const automatic = await gym.waitUntil(async () => {
            const history = await gym.client.getMessages(gym.defaultSessionId);
            const latest = compactionsFrom(history).at(-1);
            return latest?.block.status === "completed" ? latest : undefined;
        }, "the automatic compaction lifecycle to settle");
        expect(automatic).toMatchObject({
            run: { id: sent.runId },
            message: { role: "service" },
            block: {
                status: "completed",
                tokensBefore: 245_000,
                trigger: "automatic",
            },
        });
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);

    it("groups concurrent steering acceptances into one successor boundary", async () => {
        let releaseFirst!: () => void;
        let providerStarted!: () => void;
        const firstProviderStarted = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const firstProviderGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const gym = await startGym({
            inference: async (request) => {
                if (request.callIndex === 0) {
                    providerStarted();
                    await firstProviderGate;
                    return { content: [{ text: "obsolete answer", type: "text" }] };
                }
                return { content: [{ text: "steering answer", type: "text" }] };
            },
        });

        const first = await gym.client.sendMessage(gym.defaultSessionId, {
            mode: modeFor(gym),
            text: "start work",
        });
        const firstStarted = await waitForStarted(gym, gym.defaultSessionId, first.message.id);
        const firstRunId = runIdOf(firstStarted);
        if (firstRunId === undefined) throw new Error("The initial run had no ID.");
        await firstProviderStarted;

        const steeringRequests = [
            gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer" as const,
                mode: modeFor(gym),
                text: "steer one",
            }),
            gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer" as const,
                mode: modeFor(gym),
                text: "steer two",
            }),
        ];
        const steeringIds = await waitForPendingMessageIds(gym, gym.defaultSessionId, [
            "steer one",
            "steer two",
        ]);

        releaseFirst();
        const steeringResponses = await Promise.all(steeringRequests);
        const steerOne = steeringResponses[0];
        const steerTwo = steeringResponses[1];
        if (steerOne === undefined || steerTwo === undefined) {
            throw new Error("Both steering requests must return a response.");
        }
        expect(steeringIds).toEqual(
            expect.arrayContaining([steerOne.message.id, steerTwo.message.id]),
        );

        const boundary = await gym.waitForEvent(
            (event) =>
                event.type === "run.boundary" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.acceptedMessageIds.length === 2 &&
                event.payload.acceptedMessageIds.includes(steerOne.message.id) &&
                event.payload.acceptedMessageIds.includes(steerTwo.message.id),
            "one boundary for both steering messages",
        );
        expect(boundary.type).toBe("run.boundary");
        if (boundary.type !== "run.boundary") throw new Error("Expected a run boundary.");
        expect(boundary.payload.finishedRun.id).toBe(firstRunId);
        expect(new Set(boundary.payload.acceptedMessageIds)).toEqual(
            new Set([steerOne.message.id, steerTwo.message.id]),
        );
        expect(boundary.payload.startedRun.id).not.toBe(firstRunId);

        await waitForFinished(gym, gym.defaultSessionId, boundary.payload.startedRun.id);
        const boundaries = (await gym.events()).filter(
            (event) =>
                event.type === "run.boundary" && event.payload.agentId === gym.defaultSessionId,
        );
        expect(boundaries).toHaveLength(1);

        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs.map((run) => run.id)).toEqual([
            firstRunId,
            boundary.payload.startedRun.id,
        ]);
        expect(JSON.stringify(history.runs)).toContain("steer one");
        expect(JSON.stringify(history.runs)).toContain("steer two");
    }, 60_000);

    it("guards aborts by run identity and records an aborted run", async () => {
        let releaseInference!: () => void;
        let providerStarted!: () => void;
        const startedInference = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const inferenceGate = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        const gym = await startGym({
            inference: async () => {
                providerStarted();
                await inferenceGate;
                return { content: [{ text: "long answer", type: "text" }] };
            },
        });

        const sending = gym.client.sendMessage(gym.defaultSessionId, {
            mode: modeFor(gym),
            text: "keep working",
        });
        await startedInference;
        const sent = await sending;
        const started = await waitForStarted(gym, gym.defaultSessionId, sent.message.id);
        const runId = runIdOf(started);
        if (runId === undefined) throw new Error("The active run had no ID.");

        try {
            await expect(
                gym.client.abortAgent(gym.defaultSessionId, {
                    expectedRunId: "stalerun",
                    mutationId: "transcript-abort-stale",
                }),
            ).rejects.toMatchObject({ code: "conflict", status: 409 });
            expect((await gym.client.getAgent(gym.defaultSessionId)).agent.status).not.toBe("idle");

            const aborting = gym.client.abortAgent(gym.defaultSessionId, {
                expectedRunId: runId,
                mutationId: "transcript-abort-current",
            });
            releaseInference();
            const aborted = await aborting;
            expect(aborted.agent.id).toBe(gym.defaultSessionId);
            const finished = await waitForFinished(gym, gym.defaultSessionId, runId);
            expect(finished.type).toBe("run.finished");
            if (finished.type !== "run.finished") throw new Error("Expected run.finished.");
            expect(finished.payload.run).toMatchObject({
                id: runId,
                reason: "abort",
                status: "aborted",
            });

            const history = await gym.client.getMessages(gym.defaultSessionId);
            expect(history.runs).toHaveLength(1);
            expect(history.runs[0]).toMatchObject({
                id: runId,
                reason: "abort",
                status: "aborted",
            });
        } finally {
            releaseInference();
        }
    }, 60_000);

    it("aborts the targeted agent and its entire running descendant chain", async () => {
        let parentAgentId = "";
        let childAgentId: string | undefined;
        let grandchildAgentId: string | undefined;
        const callsByAgent = new Map<string, number>();
        const gym = await startGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Abort agent chain</title><slug>abort-agent-chain</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                const call = callsByAgent.get(request.sessionId) ?? 0;
                callsByAgent.set(request.sessionId, call + 1);
                if (request.sessionId === parentAgentId) {
                    return call === 0
                        ? {
                              content: [
                                  {
                                      arguments: {
                                          effort: "medium",
                                          model: "gym/model",
                                          text: "Create one descendant, then keep working.",
                                          title: "Abort chain child",
                                      },
                                      callId: "abortchainchild",
                                      name: "create_agent",
                                      type: "tool_call",
                                  },
                              ],
                          }
                        : {
                              content: [{ text: "parent still working", type: "text" }],
                              delayMs: 8_000,
                          };
                }
                if (childAgentId === undefined) {
                    childAgentId = request.sessionId;
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    text: "Keep working until the chain is stopped.",
                                    title: "Abort chain grandchild",
                                },
                                callId: "abortchaingrandchild",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (request.sessionId === childAgentId) {
                    return {
                        content: [{ text: "child still working", type: "text" }],
                        delayMs: 8_000,
                    };
                }
                grandchildAgentId = request.sessionId;
                return {
                    content: [{ text: "grandchild still working", type: "text" }],
                    delayMs: 8_000,
                };
            },
        });
        parentAgentId = gym.defaultSessionId;

        const accepted = await gym.send("Create a running descendant chain.", {
            permissionMode: "full_access",
            wait: false,
        });
        const descendants = await gym.waitUntil(async () => {
            const child = (await gym.client.getAgentActivity(parentAgentId)).subagents.find(
                (agent) => agent.status === "working",
            );
            if (child === undefined) return undefined;
            const grandchild = (await gym.client.getAgentActivity(child.id)).subagents.find(
                (agent) => agent.status === "working",
            );
            if (grandchild === undefined) return undefined;
            return { child, grandchild };
        }, "the complete descendant chain to be working");
        expect(childAgentId).toBe(descendants.child.id);
        expect(grandchildAgentId).toBe(descendants.grandchild.id);

        await gym.client.abortAgent(parentAgentId, {
            expectedRunId: accepted.runId,
            mutationId: "transcript-abort-chain",
        });

        const [finished, childRun, grandchildRun] = await Promise.all([
            waitForAborted(gym, parentAgentId, accepted.runId),
            waitForAbortedHistory(gym, descendants.child.id),
            waitForAbortedHistory(gym, descendants.grandchild.id),
        ]);
        expect(finished.payload.run.status).toBe("aborted");
        expect([childRun, grandchildRun]).toEqual([
            expect.objectContaining({ reason: "abort", status: "aborted" }),
            expect.objectContaining({ reason: "abort", status: "aborted" }),
        ]);
        await expect(gym.client.getAgent(parentAgentId)).resolves.toMatchObject({
            agent: { status: "idle", subagents: { running: 0 } },
        });
    }, 60_000);

    it("keeps tool-call presentations identical in live events and durable history", async () => {
        let agentCall = 0;
        const gym = await startGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Tool presentation</title><slug>tool-presentation</slug>",
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
                                  arguments: { cmd: "printf presented" },
                                  callId: "transcript-tool-presentation",
                                  name: "exec_command",
                                  type: "tool_call",
                              },
                          ],
                      }
                    : { content: [{ text: "done", type: "text" }] };
            },
        });

        const sent = await gym.send("run a presented command", {
            id: "transcripttoolpresentation",
            permissionMode: "full_access",
        });
        await waitForFinished(gym, gym.defaultSessionId, sent.runId);

        const full = await gym.client.getMessages(gym.defaultSessionId);
        const omitted = await gym.client.getMessages(gym.defaultSessionId, {
            omitToolData: true,
        });
        const fullTool = toolCallFrom(full);
        const liveTool = completedToolCallFromEvents(await gym.events(), gym.defaultSessionId);

        expect(fullTool).toMatchObject({
            type: "tool_call",
            id: "transcript-tool-presentation",
            name: "exec_command",
            status: "completed",
            arguments: { cmd: "printf presented" },
            result: { output: expect.stringContaining("presented") },
            presentation: {
                type: "exec_command",
                command: "printf presented",
                output: expect.stringContaining("presented"),
            },
        });
        expect(liveTool).toEqual(fullTool);
        expect(toolCallFrom(omitted)).toEqual({
            type: "tool_call",
            id: "transcript-tool-presentation",
            name: "exec_command",
            status: "completed",
            presentation: fullTool.presentation,
        });

        await gym.restart();
        expect(toolCallFrom(await gym.client.getMessages(gym.defaultSessionId))).toEqual(fullTool);
    }, 60_000);

    it("projects compute file diffs identically in live events and durable history", async () => {
        let agentCall = 0;
        const gym = await startGym({
            files: { "notes.txt": "old line\n" },
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>File diff presentation</title><slug>file-diff-presentation</slug>",
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
                                  arguments: {
                                      patch: [
                                          "*** Begin Patch",
                                          "*** Update File: notes.txt",
                                          "@@",
                                          "-old line",
                                          "+new line",
                                          "*** End Patch",
                                          "",
                                      ].join("\n"),
                                  },
                                  callId: "transcript-file-diff",
                                  name: "apply_patch",
                                  type: "tool_call",
                              },
                          ],
                      }
                    : { content: [{ text: "updated", type: "text" }] };
            },
        });

        const sent = await gym.send("update the note", {
            id: "transcriptfilediff",
            permissionMode: "full_access",
        });
        await waitForFinished(gym, gym.defaultSessionId, sent.runId);

        await expect(gym.readFile("notes.txt")).resolves.toBe("new line\n");
        const full = await gym.client.getMessages(gym.defaultSessionId);
        const omitted = await gym.client.getMessages(gym.defaultSessionId, {
            omitToolData: true,
        });
        const fullTool = toolCallFrom(full);
        const liveTool = completedToolCallFromEvents(await gym.events(), gym.defaultSessionId);

        expect(fullTool).toMatchObject({
            type: "tool_call",
            id: "transcript-file-diff",
            name: "apply_patch",
            status: "completed",
            presentation: {
                type: "file_diff",
                files: [
                    {
                        path: "notes.txt",
                        kind: "update",
                        added: 1,
                        deleted: 1,
                        hunks: [
                            {
                                oldStart: 1,
                                newStart: 1,
                                lines: [
                                    { kind: "delete", text: "old line" },
                                    { kind: "add", text: "new line" },
                                ],
                            },
                        ],
                    },
                ],
            },
        });
        expect(liveTool).toEqual(fullTool);
        expect(toolCallFrom(omitted)).toEqual({
            type: "tool_call",
            id: "transcript-file-diff",
            name: "apply_patch",
            status: "completed",
            presentation: fullTool.presentation,
        });

        await gym.restart();
        expect(toolCallFrom(await gym.client.getMessages(gym.defaultSessionId))).toEqual(fullTool);
    }, 60_000);

    it("recovers message deltas, deletes reset content, omits tool data, and records a compaction run", async () => {
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
                        { delta: "fresh", type: "text_delta" },
                        { type: "text_end" },
                        { type: "block_stop" },
                        {
                            type: "token_usage",
                            usage: {
                                cacheRead: 1,
                                cacheWrite: 2,
                                input: 17,
                                output: 19,
                                totalTokens: 39,
                            },
                        },
                        {
                            state: "normal",
                            tokens: { input: 17, output: 19 },
                            type: "done",
                        },
                    ],
                },
                {
                    content: [
                        {
                            arguments: { cmd: "printf tool-result" },
                            callId: "transcript-tool-result",
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 23,
                        output: 11,
                        totalTokens: 34,
                    },
                },
                { content: [{ text: "final answer", type: "text" }] },
            ],
        });

        const stream = gym.stream();
        await stream.opened();
        const first = await gym.send("stream a resettable answer", {
            permissionMode: "full_access",
        });
        await waitForFinished(gym, gym.defaultSessionId, first.runId);

        const events = await gym.events();
        const agentEvents = events.filter((event) => agentIdOf(event) === gym.defaultSessionId);
        expect(agentEvents.some((event) => event.type === "message.delta")).toBe(true);
        expect(agentEvents.some((event) => event.type === "message.deleted")).toBe(true);
        expect(agentEvents.some((event) => event.type === "message.updated")).toBe(true);

        const firstHistory = await gym.client.getMessages(gym.defaultSessionId);
        const firstText = JSON.stringify(firstHistory.runs[0]?.messages ?? []);
        expect(firstText).toContain("fresh");
        expect(firstText).not.toContain("discarded");

        const beforeCompact = await gym.events();
        const compacted = await gym.client.compactAgent(gym.defaultSessionId, {
            mutationId: "transcript-explicit-compaction",
        });
        expect(compacted.agent.id).toBe(gym.defaultSessionId);
        await gym.waitUntil(
            () => (gym.inference.compactions.length > 0 ? true : undefined),
            "explicit compaction to complete",
        );
        const afterCompact = await gym.events();
        const lifecycleBefore = beforeCompact.filter(
            (event) =>
                event.type === "run.started" ||
                event.type === "run.boundary" ||
                event.type === "run.finished",
        ).length;
        const lifecycleAfter = afterCompact.filter(
            (event) =>
                event.type === "run.started" ||
                event.type === "run.boundary" ||
                event.type === "run.finished",
        ).length;
        expect(lifecycleAfter).toBe(lifecycleBefore + 2);

        const second = await gym.send("call a tool", {
            permissionMode: "full_access",
        });
        await waitForFinished(gym, gym.defaultSessionId, second.runId);
        const full = await gym.client.getMessages(gym.defaultSessionId);
        const omitted = await gym.client.getMessages(gym.defaultSessionId, {
            omitToolData: true,
        });
        const fullTool = toolCallFrom(full);
        const omittedTool = toolCallFrom(omitted);
        const liveTool = completedToolCallFromEvents(await gym.events(), gym.defaultSessionId);
        expect(fullTool).toMatchObject({
            id: "transcript-tool-result",
            arguments: { cmd: "printf tool-result" },
            result: { output: expect.stringContaining("tool-result") },
            presentation: {
                type: "exec_command",
                command: "printf tool-result",
                output: expect.stringContaining("tool-result"),
            },
        });
        expect(liveTool).toEqual(fullTool);
        expect(omittedTool).toEqual({
            type: "tool_call",
            id: "transcript-tool-result",
            name: "exec_command",
            status: "completed",
            presentation: fullTool.presentation,
        });
        expect(omittedTool).not.toHaveProperty("arguments");
        expect(omittedTool).not.toHaveProperty("result");

        const beforeRestart = await gym.client.getMessages(gym.defaultSessionId);
        const beforeUsage = await gym.client.getAgentUsage(gym.defaultSessionId);
        await gym.restart();
        const afterRestart = await gym.client.getMessages(gym.defaultSessionId);
        const afterUsage = await gym.client.getAgentUsage(gym.defaultSessionId);
        expect(afterRestart.runs).toEqual(beforeRestart.runs);
        expect(afterRestart.hasMore).toBe(beforeRestart.hasMore);
        expect(afterUsage).toEqual(beforeUsage);
        expect(gym.inference.unscripted).toEqual([]);
    }, 90_000);
});

async function startGym(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym(options);
    activeGyms.add(gym);
    return gym;
}

function modeFor(gym: AgentGym) {
    return {
        effort: gym.selection.effort,
        modelId: gym.selection.modelId,
        permissionMode: "auto" as const,
        providerId: gym.selection.providerId,
        serviceTier: null,
    };
}

function contextWindowModel() {
    return {
        defaultEffort: "medium" as const,
        effortLevels: ["low", "medium", "high"] as const,
        id: "openai/gpt-5.6-sol",
        name: "Context Window Model",
        providerId: "gym",
    };
}

function namingTurn() {
    return {
        content: [
            {
                text: "<title>Context window test</title><slug>context-window-test</slug>",
                type: "text" as const,
            },
        ],
    };
}

async function waitForStarted(
    gym: AgentGym,
    agentId: string,
    messageId: string,
): Promise<Extract<GymAgentEvent, { type: "run.started" | "run.boundary" }>> {
    return (await gym.waitForEvent(
        (event) =>
            (event.type === "run.started" || event.type === "run.boundary") &&
            event.payload.agentId === agentId &&
            event.payload.acceptedMessageIds.includes(messageId),
        `message ${messageId} to be accepted`,
    )) as Extract<GymAgentEvent, { type: "run.started" | "run.boundary" }>;
}

async function waitForFinished(
    gym: AgentGym,
    agentId: string,
    runId: string,
): Promise<Extract<GymAgentEvent, { type: "run.finished" | "run.boundary" }>> {
    return (await gym.waitForEvent(
        (event) =>
            (event.type === "run.finished" || event.type === "run.boundary") &&
            event.payload.agentId === agentId &&
            finishedRunId(event) === runId,
        `run ${runId} to finish`,
    )) as Extract<GymAgentEvent, { type: "run.finished" | "run.boundary" }>;
}

async function waitForAborted(
    gym: AgentGym,
    agentId: string,
    runId: string,
): Promise<Extract<GymAgentEvent, { type: "run.finished" }>> {
    return (await gym.waitForEvent(
        (event) =>
            event.type === "run.finished" &&
            event.payload.agentId === agentId &&
            event.payload.run.id === runId &&
            event.payload.run.status === "aborted" &&
            event.payload.run.reason === "abort",
        `run ${runId} in agent ${agentId} to be aborted`,
        10_000,
    )) as Extract<GymAgentEvent, { type: "run.finished" }>;
}

async function waitForAbortedHistory(gym: AgentGym, agentId: string) {
    return await gym.waitUntil(
        async () => {
            if ((await gym.client.getAgent(agentId)).agent.status !== "idle") return undefined;
            const run = (await gym.client.getMessages(agentId)).runs.at(-1);
            return run?.status === "aborted" && run.reason === "abort" ? run : undefined;
        },
        `the run in agent ${agentId} to be aborted`,
        10_000,
    );
}

async function waitForPendingMessageIds(
    gym: AgentGym,
    agentId: string,
    texts: readonly string[],
): Promise<readonly string[]> {
    return await gym.waitUntil(async () => {
        const bootstrap = await gym.client.getAgentBootstrap(agentId);
        const ids = texts.map(
            (text) =>
                bootstrap.pending.find((message) =>
                    message.content.some((block) => block.type === "text" && block.text === text),
                )?.id,
        );
        return ids.every((id): id is string => id !== undefined) ? ids : undefined;
    }, "both steering messages to be pending");
}

function finishedRunId(
    event: Extract<GymAgentEvent, { type: "run.finished" | "run.boundary" }>,
): string {
    return event.type === "run.finished" ? event.payload.run.id : event.payload.finishedRun.id;
}

function agentIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const id = (payload as { readonly agentId?: unknown }).agentId;
    return typeof id === "string" ? id : undefined;
}

function toolCallFrom(history: Awaited<ReturnType<AgentGym["client"]["getMessages"]>>) {
    for (const run of history.runs) {
        for (const message of run.messages) {
            const tool = message.content.find((block) => block.type === "tool_call");
            if (tool !== undefined) return tool;
        }
    }
    throw new Error(`The history contained no tool call: ${JSON.stringify(history)}`);
}

function compactionsFrom(history: Awaited<ReturnType<AgentGym["client"]["getMessages"]>>) {
    return history.runs.flatMap((run) =>
        run.messages.flatMap((message) =>
            message.content.flatMap((block) =>
                block.type === "compaction" ? [{ block, message, run }] : [],
            ),
        ),
    );
}

function compactionFrom(
    history: Awaited<ReturnType<AgentGym["client"]["getMessages"]>>,
    messageId: string,
) {
    const result = compactionsFrom(history).find((candidate) => candidate.message.id === messageId);
    if (result === undefined) {
        throw new Error(`The history contained no compaction message ${messageId}.`);
    }
    return result;
}

function completedToolCallFromEvents(events: readonly GymAgentEvent[], agentId: string) {
    for (const event of events.toReversed()) {
        if (event.type !== "message.updated" || event.payload.agentId !== agentId) continue;
        const tool = event.payload.message.content.find(
            (block) => block.type === "tool_call" && block.status === "completed",
        );
        if (tool !== undefined) return tool;
    }
    throw new Error("The event stream contained no completed tool call.");
}
