import { describe, expect, it, vi } from "vitest";

import { HappyReducer } from "../sources/HappyReducer.js";
import type { HappyAgentClient } from "../sources/HappyAgentClient.js";
import type { Agent, AgentActivityResponse, AgentStatus } from "../sources/protocol/agents.js";
import type { AgentBootstrapResponse } from "../sources/protocol/bootstrap.js";
import type { Cuid2, EventCursor, MessageMode } from "../sources/protocol/common.js";
import type { HappyAgentEvent } from "../sources/protocol/events.js";
import type { Run, UserMessage } from "../sources/protocol/messages.js";
import type { BackgroundProcess } from "../sources/protocol/processes.js";
import type { PendingQuestionResponse, Question } from "../sources/protocol/questions.js";
import type { HappyAgentUpdate } from "../sources/updates.js";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const AGENT_C = "agent-c";
const AGENT_D = "agent-d";
const AGENT_E = "agent-e";
const CHILD_A = "child-a";
const PROCESS_A = "process-a";

const CURSOR_0 = "01900000-0000-7000-8000-000000000000";
const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_2 = "01900000-0000-7000-8000-000000000002";
const CURSOR_3 = "01900000-0000-7000-8000-000000000003";
const CURSOR_4 = "01900000-0000-7000-8000-000000000004";
const CURSOR_5 = "01900000-0000-7000-8000-000000000005";
const CURSOR_6 = "01900000-0000-7000-8000-000000000006";
const CURSOR_7 = "01900000-0000-7000-8000-000000000007";
const CURSOR_8 = "01900000-0000-7000-8000-000000000008";
const CURSOR_9 = "01900000-0000-7000-8000-000000000009";
const CURSOR_10 = "01900000-0000-7000-8000-000000000010";
const CURSOR_11 = "01900000-0000-7000-8000-000000000011";
const CURSOR_12 = "01900000-0000-7000-8000-000000000012";

const MODE_A: MessageMode = {
    effort: "medium",
    modelId: "openai/gpt-5.6-sol",
    permissionMode: "auto",
    providerId: "codex",
    serviceTier: null,
};

const MODE_B: MessageMode = {
    effort: "high",
    modelId: "anthropic/sonnet-5",
    permissionMode: "workspace_write",
    providerId: "claude",
    serviceTier: null,
};

describe("HappyReducer agent synchronization", () => {
    it("loads a visible agent from one bootstrap request", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        const child = agent(CHILD_A, { parentAgentId: AGENT_A, version: CURSOR_2 });
        const process = backgroundProcess(PROCESS_A, AGENT_A, CURSOR_2);
        const pending = userMessage("message-pending", MODE_A);
        const question = pendingQuestion("question-a", AGENT_A, CURSOR_2);

        const hide = reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.completeBootstrap(
            AGENT_A,
            agentBootstrap(AGENT_A, {
                cursor: CURSOR_1,
                draft: {
                    updatedAt: 10,
                    value: { ...MODE_A, text: "A draft" },
                },
                context: {
                    approximate: false,
                    contextTokens: 120,
                    contextWindow: 1_000,
                    modelId: MODE_A.modelId,
                    providerId: MODE_A.providerId,
                },
                agent: agent(AGENT_A, {
                    parentAgentId: null,
                    status: "generating_tools",
                    version: CURSOR_1,
                }),
                mode: MODE_A,
                pending: [pending],
                processes: [process],
                subagents: [child],
            }),
            { question },
        );

        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]).toBeDefined());
        expect(harness.activityRequests).toHaveLength(0);
        expect(harness.questionRequests).toHaveLength(1);
        expect(reducer.getState().agents[AGENT_A]).toEqual({
            context: {
                approximate: false,
                contextTokens: 120,
                contextWindow: 1_000,
                modelId: MODE_A.modelId,
                providerId: MODE_A.providerId,
            },
            draft: {
                updatedAt: 10,
                value: { ...MODE_A, text: "A draft" },
            },
            lastUsedModel: { modelId: MODE_A.modelId, providerId: MODE_A.providerId },
            pending: [pending],
            processes: [process],
            question,
            status: "generating_tools",
            subagents: [child],
        });

        hide();
        reducer.stop();
    });

    it("maintains pending input, the current question, and every live activity phase", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.completeBootstrap(
            AGENT_A,
            agentBootstrap(AGENT_A, { processes: [], subagents: [] }),
        );
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]).toBeDefined());

        const first = userMessage("message-first", MODE_A);
        const second = userMessage("message-second", MODE_B);
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_2,
                occurredAt: 2,
                payload: { agentId: AGENT_A, message: first, runId: null },
                type: "message.created",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_3,
                occurredAt: 3,
                payload: { agentId: AGENT_A, message: second, runId: null },
                type: "message.created",
            }),
        );
        await vi.waitFor(() =>
            expect(reducer.getState().agents[AGENT_A]?.pending).toEqual([first, second]),
        );

        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_4,
                occurredAt: 4,
                payload: {
                    acceptedMessageIds: [first.id],
                    agentId: AGENT_A,
                    run: run("run-first", "running"),
                },
                type: "run.started",
            }),
        );
        await vi.waitFor(() =>
            expect(reducer.getState().agents[AGENT_A]?.pending).toEqual([second]),
        );

        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_5,
                occurredAt: 5,
                payload: {
                    acceptedMessageIds: [second.id],
                    agentId: AGENT_A,
                    finishedRun: run("run-first", "completed"),
                    startedRun: run("run-second", "running"),
                },
                type: "run.boundary",
            }),
        );
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]?.pending).toEqual([]));

        const phases: ReadonlyArray<readonly [EventCursor, EventCursor, AgentStatus]> = [
            [CURSOR_6, CURSOR_1, "thinking"],
            [CURSOR_7, CURSOR_6, "working"],
            [CURSOR_8, CURSOR_7, "generating_tools"],
            [CURSOR_9, CURSOR_8, "running_tools"],
            [CURSOR_10, CURSOR_9, "idle"],
        ];
        for (const [cursor, previousVersion, status] of phases) {
            harness.stream.push(
                eventUpdate({
                    cursor,
                    occurredAt: Number(cursor.slice(-2)),
                    payload: {
                        agentId: AGENT_A,
                        changes: { status },
                        previousVersion,
                        version: cursor,
                    },
                    type: "agent.updated",
                }),
            );
            await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]?.status).toBe(status));
        }

        const question = pendingQuestion("question-a", AGENT_A, CURSOR_11);
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_11,
                occurredAt: 11,
                payload: { question },
                type: "question.created",
            }),
        );
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]?.question).toBe(question));

        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_12,
                occurredAt: 12,
                payload: {
                    changes: {
                        answeredAt: 12,
                        answers: { "prompt-a": ["Continue"] },
                        status: "answered",
                    },
                    previousVersion: CURSOR_11,
                    questionId: question.id,
                    version: CURSOR_12,
                },
                type: "question.updated",
            }),
        );
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]?.question).toBeNull());

        reducer.stop();
    });

    it("applies agent SSE updates with structural sharing", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        const observedUpdates = vi.fn();
        reducer.subscribeUpdates(observedUpdates);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.complete(AGENT_A, agentBootstrap(AGENT_A, { cursor: CURSOR_0 }), emptyActivity());
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]).toBeDefined());
        expect(harness.activityRequests).toHaveLength(1);

        const before = reducer.getState();
        const beforeAgent = before.agents[AGENT_A];
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_1,
                occurredAt: 1,
                payload: {
                    agentId: AGENT_A,
                    context: {
                        approximate: false,
                        contextTokens: 240,
                        contextWindow: 1_000,
                        modelId: MODE_A.modelId,
                        providerId: MODE_A.providerId,
                    },
                },
                type: "agent.context.updated",
            }),
        );

        await vi.waitFor(() =>
            expect(reducer.getState().agents[AGENT_A]?.context?.contextTokens).toBe(240),
        );
        const afterContext = reducer.getState();
        const afterContextAgent = afterContext.agents[AGENT_A];
        expect(afterContext).not.toBe(before);
        expect(afterContext.agents).not.toBe(before.agents);
        expect(afterContextAgent).not.toBe(beforeAgent);
        expect(afterContextAgent?.draft).toBe(beforeAgent?.draft);
        expect(afterContextAgent?.processes).toBe(beforeAgent?.processes);
        expect(afterContextAgent?.subagents).toBe(beforeAgent?.subagents);

        const process = backgroundProcess(PROCESS_A, AGENT_A, CURSOR_2);
        const exitedProcess: BackgroundProcess = {
            ...process,
            endedAt: 3,
            exitCode: 0,
            status: "exited",
            version: CURSOR_3,
        };
        const child = agent(CHILD_A, { parentAgentId: AGENT_A, version: CURSOR_4 });
        const updatedChild: Agent = {
            ...child,
            status: "thinking",
            updatedAt: 5,
            version: CURSOR_5,
        };
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_2,
                occurredAt: 2,
                payload: { process },
                type: "process.started",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_3,
                occurredAt: 3,
                payload: {
                    changes: { endedAt: 3, exitCode: 0, status: "exited" },
                    previousVersion: CURSOR_2,
                    processId: PROCESS_A,
                    version: CURSOR_3,
                },
                type: "process.exited",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_4,
                occurredAt: 4,
                payload: { agent: child },
                type: "agent.created",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_5,
                occurredAt: 5,
                payload: {
                    agentId: CHILD_A,
                    changes: { status: "thinking", updatedAt: 5 },
                    previousVersion: CURSOR_4,
                    version: CURSOR_5,
                },
                type: "agent.updated",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_6,
                occurredAt: 6,
                payload: {
                    agentId: AGENT_A,
                    draft: { updatedAt: 20, value: { ...MODE_B, text: "New draft" } },
                },
                type: "agent.draft.updated",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_7,
                occurredAt: 7,
                payload: {
                    agentId: AGENT_A,
                    message: userMessage("message-a", MODE_B),
                    runId: null,
                },
                type: "message.created",
            }),
        );

        await vi.waitFor(() => {
            const state = reducer.getState().agents[AGENT_A];
            expect(state?.processes).toEqual([exitedProcess]);
            expect(state?.subagents).toEqual([updatedChild]);
            expect(state?.draft.updatedAt).toBe(20);
            expect(state?.lastUsedModel).toEqual({
                modelId: MODE_B.modelId,
                providerId: MODE_B.providerId,
            });
        });

        const beforeUnrelated = reducer.getState();
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_8,
                occurredAt: 8,
                payload: { agentId: AGENT_B, context: null },
                type: "agent.context.updated",
            }),
        );
        await vi.waitFor(() => expect(observedUpdates).toHaveBeenCalledTimes(9));
        expect(reducer.getState()).toBe(beforeUnrelated);

        reducer.stop();
    });

    it("preserves the public snapshot when unrelated agent metadata changes", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        const observedUpdates = vi.fn();
        reducer.subscribeUpdates(observedUpdates);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.completeBootstrap(
            AGENT_A,
            agentBootstrap(AGENT_A, { processes: [], subagents: [] }),
        );
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]).toBeDefined());

        const before = reducer.getState();
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_2,
                occurredAt: 2,
                payload: {
                    agentId: AGENT_A,
                    changes: { unread: { reason: "completed", since: 2 }, updatedAt: 2 },
                    previousVersion: CURSOR_1,
                    version: CURSOR_2,
                },
                type: "agent.updated",
            }),
        );
        await vi.waitFor(() => expect(observedUpdates).toHaveBeenCalledTimes(2));

        expect(reducer.getState()).toBe(before);
        expect(reducer.getState().agents[AGENT_A]).toBe(before.agents[AGENT_A]);

        reducer.stop();
    });

    it("rebases updates received while bootstrap is in flight", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        const observedUpdates = vi.fn();
        reducer.subscribeUpdates(observedUpdates);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));

        const process = backgroundProcess(PROCESS_A, AGENT_A, CURSOR_2);
        const child = agent(CHILD_A, { parentAgentId: AGENT_A, version: CURSOR_3 });
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_2,
                occurredAt: 2,
                payload: { process },
                type: "process.started",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_3,
                occurredAt: 3,
                payload: { agent: child },
                type: "agent.created",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_4,
                occurredAt: 4,
                payload: {
                    agentId: AGENT_A,
                    draft: { updatedAt: 20, value: { ...MODE_B, text: "Raced draft" } },
                },
                type: "agent.draft.updated",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_5,
                occurredAt: 5,
                payload: {
                    agentId: AGENT_A,
                    message: userMessage("message-race", MODE_B),
                    runId: null,
                },
                type: "message.created",
            }),
        );
        await vi.waitFor(() => expect(observedUpdates).toHaveBeenCalledTimes(5));

        harness.completeBootstrap(
            AGENT_A,
            agentBootstrap(AGENT_A, {
                cursor: CURSOR_1,
                processes: [],
                subagents: [],
            }),
        );

        await vi.waitFor(() => {
            const state = reducer.getState().agents[AGENT_A];
            expect(state?.draft.updatedAt).toBe(20);
            expect(state?.lastUsedModel?.modelId).toBe(MODE_B.modelId);
            expect(state?.processes).toEqual([process]);
            expect(state?.subagents).toEqual([child]);
        });
        expect(harness.startedAgentIds).toEqual([AGENT_A]);

        reducer.stop();
    });

    it("replays pending and question events that race the focused question read", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        const observedUpdates = vi.fn();
        reducer.subscribeUpdates(observedUpdates);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));

        harness.completeBootstrapOnly(
            AGENT_A,
            agentBootstrap(AGENT_A, { processes: [], subagents: [] }),
        );
        await vi.waitFor(() => expect(harness.questionRequests).toHaveLength(1));

        const pending = userMessage("message-raced", MODE_A);
        const question = pendingQuestion("question-raced", AGENT_A, CURSOR_3);
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_2,
                occurredAt: 2,
                payload: { agentId: AGENT_A, message: pending, runId: null },
                type: "message.created",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_3,
                occurredAt: 3,
                payload: { question },
                type: "question.created",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_4,
                occurredAt: 4,
                payload: {
                    agentId: AGENT_A,
                    changes: { status: "working" },
                    previousVersion: CURSOR_1,
                    version: CURSOR_4,
                },
                type: "agent.updated",
            }),
        );
        await vi.waitFor(() => expect(observedUpdates).toHaveBeenCalledTimes(4));
        harness.completeQuestion(AGENT_A, { question: null });

        await vi.waitFor(() => {
            const state = reducer.getState().agents[AGENT_A];
            expect(state?.pending).toEqual([pending]);
            expect(state?.question).toBe(question);
            expect(state?.status).toBe("working");
        });

        reducer.stop();
    });

    it("reconciles every bootstrap field with its private cursor", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));

        const process = backgroundProcess(PROCESS_A, AGENT_A, CURSOR_2);
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_2,
                occurredAt: 2,
                payload: { process },
                type: "process.started",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_3,
                occurredAt: 3,
                payload: {
                    agentId: AGENT_A,
                    context: {
                        approximate: false,
                        contextTokens: 300,
                        contextWindow: 1_000,
                        modelId: MODE_A.modelId,
                        providerId: MODE_A.providerId,
                    },
                },
                type: "agent.context.updated",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_4,
                occurredAt: 4,
                payload: {
                    agentId: AGENT_A,
                    draft: { updatedAt: 10, value: { ...MODE_A, text: "Older draft" } },
                },
                type: "agent.draft.updated",
            }),
        );
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_5,
                occurredAt: 5,
                payload: {
                    agentId: AGENT_A,
                    message: userMessage("message-older", MODE_A),
                    runId: null,
                },
                type: "message.created",
            }),
        );

        harness.completeBootstrap(
            AGENT_A,
            agentBootstrap(AGENT_A, {
                cursor: CURSOR_6,
                context: {
                    approximate: false,
                    contextTokens: 600,
                    contextWindow: 2_000,
                    modelId: MODE_B.modelId,
                    providerId: MODE_B.providerId,
                },
                draft: {
                    updatedAt: 20,
                    value: { ...MODE_B, text: "Newer draft" },
                },
                mode: MODE_B,
                processes: [process],
                subagents: [],
            }),
        );

        await vi.waitFor(() => {
            const state = reducer.getState().agents[AGENT_A];
            expect(state?.context?.contextTokens).toBe(600);
            expect(state?.draft).toEqual({
                updatedAt: 20,
                value: { ...MODE_B, text: "Newer draft" },
            });
            expect(state?.lastUsedModel).toEqual({
                modelId: MODE_B.modelId,
                providerId: MODE_B.providerId,
            });
            expect(state?.processes).toEqual([process]);
        });

        reducer.stop();
    });

    it("runs at most three agent syncs and selects visible work first", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        for (const agentId of [AGENT_A, AGENT_B, AGENT_C, AGENT_D, AGENT_E]) {
            reducer.agentVisible(agentId)();
        }

        reducer.start();
        harness.connect();
        await vi.waitFor(() =>
            expect(harness.startedAgentIds).toEqual([AGENT_A, AGENT_B, AGENT_C]),
        );
        const hide = reducer.agentVisible(AGENT_E);

        harness.complete(AGENT_A, agentBootstrap(AGENT_A), emptyActivity());
        await vi.waitFor(() => expect(harness.startedAgentIds).toHaveLength(4));
        expect(harness.startedAgentIds[3]).toBe(AGENT_E);
        expect(harness.activeRequestAgentIds()).toEqual(
            expect.arrayContaining([AGENT_B, AGENT_C, AGENT_E]),
        );
        expect(harness.activeRequestAgentIds()).toHaveLength(3);

        hide();
        reducer.stop();
    });

    it("marks tracked agents dirty and queues authoritative refresh after state loss", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.complete(AGENT_A, agentBootstrap(AGENT_A), emptyActivity());
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]).toBeDefined());

        const stateBeforeLoss = reducer.getState();
        harness.stream.push({ kind: "state_lost", cursor: CURSOR_5 });

        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A, AGENT_A]));
        expect(reducer.getState()).toBe(stateBeforeLoss);

        harness.complete(
            AGENT_A,
            agentBootstrap(AGENT_A, {
                cursor: CURSOR_5,
                context: {
                    approximate: false,
                    contextTokens: 500,
                    contextWindow: 1_000,
                    modelId: MODE_A.modelId,
                    providerId: MODE_A.providerId,
                },
            }),
            emptyActivity(),
        );
        await vi.waitFor(() =>
            expect(reducer.getState().agents[AGENT_A]?.context?.contextTokens).toBe(500),
        );

        reducer.stop();
    });

    it("marks one agent dirty when a versioned SSE update cannot join its snapshot", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        const process = backgroundProcess(PROCESS_A, AGENT_A, CURSOR_2);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.complete(AGENT_A, agentBootstrap(AGENT_A), {
            processes: [process],
            subagents: [],
        });
        await vi.waitFor(() =>
            expect(reducer.getState().agents[AGENT_A]?.processes).toEqual([process]),
        );

        const beforeMismatch = reducer.getState();
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_4,
                occurredAt: 4,
                payload: {
                    changes: { endedAt: 4, exitCode: 1, status: "exited" },
                    previousVersion: CURSOR_1,
                    processId: PROCESS_A,
                    version: CURSOR_4,
                },
                type: "process.exited",
            }),
        );

        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A, AGENT_A]));
        expect(reducer.getState()).toBe(beforeMismatch);

        const authoritative: BackgroundProcess = {
            ...process,
            endedAt: 4,
            exitCode: 1,
            status: "exited",
            version: CURSOR_4,
        };
        harness.complete(AGENT_A, agentBootstrap(AGENT_A, { cursor: CURSOR_4 }), {
            processes: [authoritative],
            subagents: [],
        });
        await vi.waitFor(() =>
            expect(reducer.getState().agents[AGENT_A]?.processes).toEqual([authoritative]),
        );

        reducer.stop();
    });

    it("refreshes one agent when a question update cannot join its version chain", async () => {
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        const question = pendingQuestion("question-a", AGENT_A, CURSOR_2);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.completeBootstrap(
            AGENT_A,
            agentBootstrap(AGENT_A, { processes: [], subagents: [] }),
            { question },
        );
        await vi.waitFor(() => expect(reducer.getState().agents[AGENT_A]?.question).toBe(question));

        const beforeMismatch = reducer.getState();
        harness.stream.push(
            eventUpdate({
                cursor: CURSOR_4,
                occurredAt: 4,
                payload: {
                    changes: { autoResolveAt: 60_000 },
                    previousVersion: CURSOR_3,
                    questionId: question.id,
                    version: CURSOR_4,
                },
                type: "question.updated",
            }),
        );

        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A, AGENT_A]));
        expect(reducer.getState()).toBe(beforeMismatch);

        const authoritative = { ...question, autoResolveAt: 60_000, version: CURSOR_4 };
        harness.completeBootstrap(
            AGENT_A,
            agentBootstrap(AGENT_A, {
                cursor: CURSOR_4,
                processes: [],
                subagents: [],
            }),
            { question: authoritative },
        );
        await vi.waitFor(() =>
            expect(reducer.getState().agents[AGENT_A]?.question).toEqual(authoritative),
        );

        reducer.stop();
    });

    it("retries failed agent snapshots with bounded backoff", async () => {
        vi.useFakeTimers();
        const harness = new AgentReducerHarness();
        const reducer = new HappyReducer(harness.client);
        try {
            reducer.agentVisible(AGENT_A);
            reducer.start();
            harness.connect();
            await vi.advanceTimersByTimeAsync(0);
            expect(harness.startedAgentIds).toEqual([AGENT_A]);

            harness.fail(AGENT_A, new Error("Temporary network failure."));
            await vi.advanceTimersByTimeAsync(99);
            expect(harness.startedAgentIds).toEqual([AGENT_A]);
            await vi.advanceTimersByTimeAsync(1);
            expect(harness.startedAgentIds).toEqual([AGENT_A, AGENT_A]);
        } finally {
            reducer.stop();
            vi.useRealTimers();
        }
    });

    it("ignores a snapshot that resolves after synchronous stop", async () => {
        const harness = new AgentReducerHarness({ ignoreAbort: true });
        const reducer = new HappyReducer(harness.client);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));

        expect(reducer.stop()).toBeUndefined();
        harness.complete(AGENT_A, agentBootstrap(AGENT_A), emptyActivity());
        await Promise.resolve();
        await Promise.resolve();

        expect(reducer.getState()).toEqual({ agents: {}, connection: "disconnected" });
    });

    it("ignores a focused question response that resolves after synchronous stop", async () => {
        const harness = new AgentReducerHarness({ ignoreAbort: true });
        const reducer = new HappyReducer(harness.client);
        reducer.agentVisible(AGENT_A);
        reducer.start();
        harness.connect();
        await vi.waitFor(() => expect(harness.startedAgentIds).toEqual([AGENT_A]));
        harness.completeBootstrapOnly(
            AGENT_A,
            agentBootstrap(AGENT_A, { processes: [], subagents: [] }),
        );
        await vi.waitFor(() => expect(harness.questionRequests).toHaveLength(1));

        expect(reducer.stop()).toBeUndefined();
        harness.completeQuestion(AGENT_A, {
            question: pendingQuestion("question-late", AGENT_A, CURSOR_2),
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(reducer.getState()).toEqual({ agents: {}, connection: "disconnected" });
    });
});

interface PendingRequest<T> {
    readonly agentId: Cuid2;
    readonly signal: AbortSignal | undefined;
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (error: unknown) => void;
    settled: boolean;
}

class AgentReducerHarness {
    readonly stream = controlledStream();
    readonly startedAgentIds: Cuid2[] = [];
    readonly bootstrapRequests: Array<PendingRequest<AgentBootstrapResponse>> = [];
    readonly activityRequests: Array<PendingRequest<AgentActivityResponse>> = [];
    readonly questionRequests: Array<PendingRequest<PendingQuestionResponse>> = [];
    readonly queuedActivity = new Map<Cuid2, AgentActivityResponse>();
    readonly queuedQuestions = new Map<Cuid2, PendingQuestionResponse>();
    readonly client: HappyAgentClient;

    constructor(harnessOptions: { ignoreAbort?: boolean } = {}) {
        const updates = vi.fn(() => this.stream);
        const getAgentBootstrap = vi.fn((agentId: Cuid2, options: { signal?: AbortSignal }) => {
            this.startedAgentIds.push(agentId);
            const request = pendingRequest<AgentBootstrapResponse>(
                agentId,
                options.signal,
                harnessOptions.ignoreAbort === true,
            );
            this.bootstrapRequests.push(request);
            return request.promise;
        });
        const getAgentActivity = vi.fn((agentId: Cuid2, options: { signal?: AbortSignal }) => {
            const request = pendingRequest<AgentActivityResponse>(
                agentId,
                options.signal,
                harnessOptions.ignoreAbort === true,
            );
            this.activityRequests.push(request);
            const queued = this.queuedActivity.get(agentId);
            if (queued !== undefined) {
                this.queuedActivity.delete(agentId);
                request.settled = true;
                request.resolve(queued);
            }
            return request.promise;
        });
        const getPendingQuestion = vi.fn((agentId: Cuid2, options: { signal?: AbortSignal }) => {
            const request = pendingRequest<PendingQuestionResponse>(
                agentId,
                options.signal,
                harnessOptions.ignoreAbort === true,
            );
            this.questionRequests.push(request);
            const queued = this.queuedQuestions.get(agentId);
            if (queued !== undefined) {
                this.queuedQuestions.delete(agentId);
                request.settled = true;
                request.resolve(queued);
            }
            return request.promise;
        });
        this.client = {
            getAgentActivity,
            getAgentBootstrap,
            getPendingQuestion,
            updates,
        } as unknown as HappyAgentClient;
    }

    connect(cursor: EventCursor = CURSOR_0): void {
        this.stream.push({ cursor, kind: "connected" });
    }

    complete(
        agentId: Cuid2,
        bootstrap: AgentBootstrapResponse,
        activity: AgentActivityResponse,
        question: PendingQuestionResponse = { question: null },
    ): void {
        const bootstrapRequest = this.bootstrapRequests.find(
            (request) => request.agentId === agentId && !request.settled,
        );
        if (bootstrapRequest === undefined) throw new Error(`No pending sync for ${agentId}.`);
        const activityRequest = this.activityRequests.find(
            (request) => request.agentId === agentId && !request.settled,
        );
        this.queuedQuestions.set(agentId, question);
        bootstrapRequest.settled = true;
        bootstrapRequest.resolve(bootstrap);
        if (activityRequest === undefined) this.queuedActivity.set(agentId, activity);
        else {
            activityRequest.settled = true;
            activityRequest.resolve(activity);
        }
    }

    completeBootstrap(
        agentId: Cuid2,
        bootstrap: AgentBootstrapResponse,
        question: PendingQuestionResponse = { question: null },
    ): void {
        const bootstrapRequest = this.bootstrapRequests.find(
            (request) => request.agentId === agentId && !request.settled,
        );
        if (bootstrapRequest === undefined) throw new Error(`No pending sync for ${agentId}.`);
        this.queuedQuestions.set(agentId, question);
        bootstrapRequest.settled = true;
        bootstrapRequest.resolve(bootstrap);
    }

    completeBootstrapOnly(agentId: Cuid2, bootstrap: AgentBootstrapResponse): void {
        const bootstrapRequest = this.bootstrapRequests.find(
            (request) => request.agentId === agentId && !request.settled,
        );
        if (bootstrapRequest === undefined) throw new Error(`No pending sync for ${agentId}.`);
        bootstrapRequest.settled = true;
        bootstrapRequest.resolve(bootstrap);
    }

    completeQuestion(agentId: Cuid2, response: PendingQuestionResponse): void {
        const questionRequest = this.questionRequests.find(
            (request) => request.agentId === agentId && !request.settled,
        );
        if (questionRequest === undefined) {
            throw new Error(`No pending question request for ${agentId}.`);
        }
        questionRequest.settled = true;
        questionRequest.resolve(response);
    }

    fail(agentId: Cuid2, error: unknown): void {
        const bootstrapRequest = this.bootstrapRequests.find(
            (request) => request.agentId === agentId && !request.settled,
        );
        const activityRequest = this.activityRequests.find(
            (request) => request.agentId === agentId && !request.settled,
        );
        if (bootstrapRequest === undefined) throw new Error(`No pending sync for ${agentId}.`);
        bootstrapRequest.settled = true;
        bootstrapRequest.reject(error);
        if (activityRequest !== undefined) {
            activityRequest.settled = true;
            activityRequest.reject(error);
        }
    }

    activeRequestAgentIds(): Cuid2[] {
        return this.bootstrapRequests
            .filter((request) => !request.settled && request.signal?.aborted !== true)
            .map((request) => request.agentId);
    }
}

interface ControlledStream extends AsyncIterableIterator<HappyAgentUpdate> {
    push(update: HappyAgentUpdate): void;
}

function controlledStream(): ControlledStream {
    const queued: HappyAgentUpdate[] = [];
    let waiting: ((result: IteratorResult<HappyAgentUpdate>) => void) | undefined;
    let closed = false;

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next() {
            const update = queued.shift();
            if (update !== undefined)
                return Promise.resolve({ done: false as const, value: update });
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            return new Promise<IteratorResult<HappyAgentUpdate>>((resolve) => {
                waiting = resolve;
            });
        },
        push(update) {
            if (closed) return;
            if (waiting !== undefined) {
                const resolve = waiting;
                waiting = undefined;
                resolve({ done: false, value: update });
                return;
            }
            queued.push(update);
        },
        return() {
            closed = true;
            waiting?.({ done: true, value: undefined });
            waiting = undefined;
            return Promise.resolve({ done: true as const, value: undefined });
        },
    };
}

function pendingRequest<T>(
    agentId: Cuid2,
    signal: AbortSignal | undefined,
    ignoreAbort: boolean,
): PendingRequest<T> {
    let resolvePromise: (value: T) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const request: PendingRequest<T> = {
        agentId,
        signal,
        promise: new Promise<T>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        }),
        resolve: (value) => resolvePromise(value),
        reject: (error) => rejectPromise(error),
        settled: false,
    };
    if (!ignoreAbort) {
        signal?.addEventListener(
            "abort",
            () => {
                if (request.settled) return;
                request.settled = true;
                request.reject(signal.reason);
            },
            { once: true },
        );
    }
    return request;
}

function agent(
    id: Cuid2,
    overrides: Partial<Agent> & Pick<Agent, "parentAgentId" | "version"> = {
        parentAgentId: null,
        version: CURSOR_1,
    },
): Agent {
    const { parentAgentId, version, ...rest } = overrides;
    return {
        archivedAt: null,
        createdAt: 1,
        id,
        lastCursor: version,
        orderKey: parentAgentId === null ? "1" : null,
        parentAgentId,
        pendingQuestionId: null,
        processes: { running: 0 },
        status: "idle",
        subagents: { running: 0, total: 0 },
        title: null,
        titleStatus: "idle",
        unread: null,
        updatedAt: 1,
        version,
        workspaceId: "workspace-a",
        ...rest,
    };
}

function agentBootstrap(
    agentId: Cuid2,
    overrides: Partial<AgentBootstrapResponse> = {},
): AgentBootstrapResponse {
    return {
        agent: agent(agentId),
        context: null,
        cursor: CURSOR_1,
        draft: { updatedAt: null, value: null },
        mode: null,
        pending: [],
        slashCommands: [],
        usage: {},
        ...overrides,
    };
}

function emptyActivity(): AgentActivityResponse {
    return { processes: [], subagents: [] };
}

function backgroundProcess(id: Cuid2, agentId: Cuid2, version: string): BackgroundProcess {
    return {
        agentId,
        command: "pnpm dev",
        endedAt: null,
        exitCode: null,
        id,
        startedAt: 1,
        status: "running",
        version,
    };
}

function userMessage(id: Cuid2, mode: MessageMode): UserMessage {
    return {
        content: [{ text: "Hello", type: "text" }],
        createdAt: 1,
        delivery: "queue",
        id,
        metadata: {},
        mode,
        role: "user",
        runId: null,
        status: "pending",
    };
}

function pendingQuestion(id: Cuid2, agentId: Cuid2, version: string): Question {
    return {
        agentId,
        answeredAt: null,
        answers: null,
        autoResolveAt: null,
        createdAt: 1,
        id,
        questions: [
            {
                header: "Choice",
                id: "prompt-a",
                multiSelect: false,
                options: [{ description: "Keep going.", label: "Continue" }],
                question: "What next?",
            },
        ],
        runId: "run-question",
        status: "pending",
        version,
    };
}

function run(id: Cuid2, status: Run["status"]): Run {
    return {
        costUsd: null,
        endedAt: status === "running" ? null : 5,
        id,
        reason: status === "running" ? null : "completed",
        startedAt: 1,
        status,
        usage: {},
    };
}

function eventUpdate(event: HappyAgentEvent): HappyAgentUpdate {
    return { cursor: event.cursor, event, kind: "event" };
}
