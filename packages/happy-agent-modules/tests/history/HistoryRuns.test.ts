import { describe, expect, it } from "vitest";
import type {
    AgentBaseAcceptedMessage,
    AgentModuleHooks,
    AgentModuleScope,
} from "@slopus/happy-agent-base";

import { EventsModule } from "../../sources/events/index.js";
import { HistoryModule, type HistoryPendingMessage } from "../../sources/history/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const mode = {
    providerId: "codex",
    modelId: "openai/gpt-5.6-sol",
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
} as const;

function pending(
    id: string,
    createdAt: number,
    delivery: "queue" | "steer" = "queue",
): HistoryPendingMessage {
    return {
        id,
        agentId: "agent-a",
        role: "user",
        status: "pending",
        delivery,
        createdAt,
        blocks: [{ type: "text", text: id }],
        mode,
        runId: null,
    };
}

function accepted(id: string, kind: "send" | "steering"): AgentBaseAcceptedMessage {
    return {
        id,
        kind,
        message: { role: "user", content: [{ type: "text", text: id }] },
        metadata: USER_MESSAGE_ORIGIN_METADATA,
    };
}

function scope(): AgentModuleScope {
    const values = new Map<string, unknown>();
    return {
        agent: {
            id: "agent-a",
            model: "openai/gpt-5.6-sol",
            provider: "codex",
        },
        runKV: {
            delete: async (_ctx, key) => {
                values.delete(key);
            },
            read: async (_ctx, key) => values.get(key),
            write: async (_ctx, key, value) => {
                values.set(key, value);
            },
        },
    } as AgentModuleScope;
}

async function setup(name: string): Promise<{
    database: ModuleDatabase;
    events: EventsModule;
    eventHooks: AgentModuleHooks;
    history: HistoryModule;
    historyHooks: AgentModuleHooks;
    scope: AgentModuleScope;
}> {
    const events = new EventsModule();
    const history = new HistoryModule(events);
    const database = moduleDatabase([...events.migrations, ...history.migrations], name);
    await database.ready;
    const eventHooks = await resolveModuleHooks(database.context, events);
    const historyHooks = await resolveModuleHooks(database.context, history);
    return { database, events, eventHooks, history, historyHooks, scope: scope() };
}

async function acceptBatch(
    world: Awaited<ReturnType<typeof setup>>,
    messages: readonly AgentBaseAcceptedMessage[],
): Promise<void> {
    await world.database.context.inTx(async (txCtx) => {
        for (const message of messages) {
            await world.historyHooks.messageAcceptedTransact?.(txCtx, world.scope, message);
            await world.eventHooks.messageAcceptedTransact?.(txCtx, world.scope, message);
        }
    });
}

async function finishInference(
    world: Awaited<ReturnType<typeof setup>>,
    inferenceId: string,
    text: string,
): Promise<void> {
    const inference = {
        inferenceId,
        loopId: "loop-a",
        turnId: "turn-a",
        contextTokens: undefined,
    };
    await world.eventHooks.beforeInferenceTransact?.(
        world.database.context,
        world.scope,
        inference,
    );
    await world.historyHooks.beforeInferenceTransact?.(
        world.database.context,
        world.scope,
        inference,
    );
    await world.eventHooks.onEvent?.(world.database.context, world.scope, {
        type: "text_start",
    });
    await world.eventHooks.onEvent?.(world.database.context, world.scope, {
        type: "text_delta",
        delta: text,
    });
    await world.eventHooks.onEvent?.(world.database.context, world.scope, {
        type: "text_end",
    });
    await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
        type: "text_end",
        block: { type: "text", text },
    } as never);
    await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
        ...inference,
        state: "normal",
        tokens: { input: 1, output: 1 },
    });
}

describe("HistoryModule run history", () => {
    it("keeps the original client metadata when a pending user message is accepted", async () => {
        const world = await setup("history-runs-client-metadata");
        const clientMetadata = {
            composer: "mobile",
            localDraft: { revision: 4, tags: ["auth", null] },
        };
        try {
            await world.history.queuePending(world.database.context, {
                ...pending("message-client-metadata", 100),
                clientMetadata,
            });
            await acceptBatch(world, [
                {
                    ...accepted("message-client-metadata", "send"),
                    metadata: {
                        ...USER_MESSAGE_ORIGIN_METADATA,
                        clientMetadata: { replaced: true },
                    },
                },
            ]);

            expect(
                await world.history.message(
                    world.database.context,
                    "agent-a",
                    "message-client-metadata",
                ),
            ).toMatchObject({ clientMetadata });
            expect(await world.history.pending(world.database.context, "agent-a")).toEqual([]);
        } finally {
            world.database.close();
        }
    });

    it("reads exact current and previous run state without depending on run messages", async () => {
        const world = await setup("history-runs-exact-state");
        try {
            await world.history.queuePending(world.database.context, pending("message-a", 100));
            await acceptBatch(world, [accepted("message-a", "send")]);

            expect(await world.history.runningRun(world.database.context, "agent-a")).toEqual({
                id: "message-a",
                agentId: "agent-a",
                status: "running",
                reason: null,
                startedAt: 100,
                endedAt: null,
            });
            expect(await world.history.run(world.database.context, "agent-a", "message-a")).toEqual(
                await world.history.runningRun(world.database.context, "agent-a"),
            );
            expect(
                await world.history.previousRun(world.database.context, "agent-a", "message-a"),
            ).toBeUndefined();

            await finishInference(world, "inference-a", "first answer");
            await world.history.queuePending(
                world.database.context,
                pending("message-b", 200, "steer"),
            );
            await acceptBatch(world, [accepted("message-b", "steering")]);

            expect(
                await world.history.previousRun(world.database.context, "agent-a", "message-b"),
            ).toEqual({
                id: "message-a",
                agentId: "agent-a",
                status: "aborted",
                reason: "steering",
                startedAt: 100,
                endedAt: 200,
            });
            expect(await world.history.runningRun(world.database.context, "agent-a")).toMatchObject(
                {
                    id: "message-b",
                    status: "running",
                    startedAt: 200,
                },
            );
        } finally {
            world.database.close();
        }
    });

    it("reads a message-less maintenance run inside its creating transaction", async () => {
        const world = await setup("history-runs-empty-maintenance-state");
        try {
            await world.database.context.inTx(async (txCtx) => {
                await world.history.beginMaintenanceRun(txCtx, "agent-a", "maintenance-a", 300);
                expect(await world.history.runningRun(txCtx, "agent-a")).toEqual({
                    id: "maintenance-a",
                    agentId: "agent-a",
                    status: "running",
                    reason: null,
                    startedAt: 300,
                    endedAt: null,
                });
            });

            expect((await world.history.runs(world.database.context, "agent-a")).runs).toEqual([]);
            expect(
                await world.history.run(world.database.context, "agent-a", "maintenance-a"),
            ).toMatchObject({ id: "maintenance-a", status: "running" });

            await world.history.finishMaintenanceRun(
                world.database.context,
                "agent-a",
                "maintenance-a",
                "completed",
                400,
            );
            expect(
                await world.history.runningRun(world.database.context, "agent-a"),
            ).toBeUndefined();
            expect(
                await world.history.run(world.database.context, "agent-a", "maintenance-a"),
            ).toMatchObject({
                id: "maintenance-a",
                status: "completed",
                reason: "completed",
                endedAt: 400,
            });
        } finally {
            world.database.close();
        }
    });

    it("keeps a successfully settled run open until durable steering is accepted", async () => {
        const world = await setup("history-runs-pending-steering-boundary");
        try {
            await world.history.queuePending(world.database.context, pending("message-a", 100));
            await acceptBatch(world, [accepted("message-a", "send")]);
            await finishInference(world, "inference-a", "first answer");
            await world.history.queuePending(
                world.database.context,
                pending("message-b", 200, "steer"),
            );

            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-a", settlementId: "settlement-a" },
            );
            await world.eventHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-a", settlementId: "settlement-a" },
            );
            expect(await world.history.runningRun(world.database.context, "agent-a")).toMatchObject(
                {
                    id: "message-a",
                    status: "running",
                    reason: null,
                },
            );

            await acceptBatch(world, [accepted("message-b", "steering")]);
            expect(
                await world.history.previousRun(world.database.context, "agent-a", "message-b"),
            ).toMatchObject({
                id: "message-a",
                status: "aborted",
                reason: "steering",
                endedAt: 200,
            });
            expect(await world.history.runningRun(world.database.context, "agent-a")).toMatchObject(
                {
                    id: "message-b",
                    status: "running",
                },
            );
        } finally {
            world.database.close();
        }
    });

    it("records a settlement failure when the provider throws before completing inference", async () => {
        const world = await setup("history-runs-settlement-error");
        try {
            await world.history.queuePending(
                world.database.context,
                pending("message-settlement-error", 100),
            );
            await acceptBatch(world, [accepted("message-settlement-error", "send")]);

            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                {
                    error: "Codex access token could not be refreshed: 401 Unauthorized",
                    loopId: "loop-settlement-error",
                    settlementId: "settlement-error",
                },
            );

            const page = await world.history.runs(world.database.context, "agent-a");
            expect(page.runs).toHaveLength(1);
            expect(page.runs[0]).toMatchObject({
                id: "message-settlement-error",
                reason: "error",
                status: "failed",
            });
            expect(page.runs[0]?.messages).toMatchObject([
                { recordId: "message-settlement-error", role: "user" },
                {
                    blocks: [
                        {
                            text: "Codex access token could not be refreshed: 401 Unauthorized",
                            type: "text",
                        },
                    ],
                    recordId: "settlement-error",
                    role: "error",
                    runId: "message-settlement-error",
                },
            ]);
        } finally {
            world.database.close();
        }
    });

    it("appends one error message for each failed inference", async () => {
        const world = await setup("history-runs-stable-error");
        try {
            await world.history.queuePending(world.database.context, pending("message-error", 100));
            await acceptBatch(world, [accepted("message-error", "send")]);
            for (const [inferenceId, errorMessage] of [
                ["inference-error-a", "first failure"],
                ["inference-error-b", "second failure"],
            ] as const) {
                await world.historyHooks.afterInferenceTransact?.(
                    world.database.context,
                    world.scope,
                    {
                        inferenceId,
                        loopId: "loop-error",
                        turnId: "turn-error",
                        contextTokens: undefined,
                        state: "error",
                        tokens: undefined,
                        errorMessage,
                    },
                );
            }
            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                {
                    error: "second failure",
                    loopId: "loop-error",
                    settlementId: "settlement-error",
                },
            );

            const page = await world.history.runs(world.database.context, "agent-a");
            expect(page.runs[0]?.messages.map((message) => message.role)).toEqual([
                "user",
                "error",
                "error",
            ]);
            expect(page.runs[0]?.messages.slice(1).map((message) => message.blocks)).toEqual([
                [{ type: "text", text: "first failure" }],
                [{ type: "text", text: "second failure" }],
            ]);
        } finally {
            world.database.close();
        }
    });

    it("appends each inference and merges only its matching tool results", async () => {
        const world = await setup("history-runs-stable-assistant");
        try {
            await world.history.queuePending(
                world.database.context,
                pending("message-stable", 100),
            );
            await acceptBatch(world, [accepted("message-stable", "send")]);

            const toolInference = {
                inferenceId: "inference-tools",
                loopId: "loop-stable",
                turnId: "turn-stable",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                toolInference,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                toolInference,
            );
            await world.eventHooks.onEvent?.(world.database.context, world.scope, {
                type: "text_start",
            });
            await world.eventHooks.onEvent?.(world.database.context, world.scope, {
                type: "text_delta",
                delta: "working",
            });
            await world.eventHooks.onEvent?.(world.database.context, world.scope, {
                type: "text_end",
            });

            for (const callId of ["calla", "callb"]) {
                await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                    type: "toolcall_end",
                    block: {
                        type: "tool_call",
                        callId,
                        name: "shell",
                        arguments: `{"call":"${callId}"}`,
                    },
                } as never);
            }
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...toolInference,
                state: "tool_call",
                tokens: { input: 1, output: 1 },
            });
            for (const callId of ["calla", "callb"]) {
                await world.historyHooks.beforeToolCallTransact?.(
                    world.database.context,
                    world.scope,
                    {
                        type: "tool_call",
                        callId,
                        name: "shell",
                        arguments: `{"call":"${callId}"}`,
                    } as never,
                );
                await world.historyHooks.afterToolCallTransact?.(
                    world.database.context,
                    world.scope,
                    {
                        role: "tool",
                        callId,
                        content: [{ type: "text", text: `${callId} result` }],
                    },
                );
            }
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "text_end",
                block: { type: "text", text: "done" },
            } as never);
            const finalInference = {
                inferenceId: "inference-final",
                loopId: "loop-stable",
                turnId: "turn-stable",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                finalInference,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                finalInference,
            );
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...finalInference,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });

            const page = await world.history.runs(world.database.context, "agent-a");
            expect(page.runs[0]?.messages.map((message) => message.recordId)).toEqual([
                "message-stable",
                "inference-tools",
                "inference-final",
            ]);
            expect(page.runs[0]?.messages[1]?.blocks.map((block) => block.type)).toEqual([
                "tool_call",
                "tool_call",
                "tool_result",
                "tool_result",
            ]);
            expect(page.runs[0]?.messages[2]?.blocks).toEqual([{ type: "text", text: "done" }]);
            expect(await world.history.stats(world.database.context, "agent-a")).toMatchObject({
                messages: 3,
                toolCalls: 2,
                toolResults: 2,
            });
            const liveMessageId = world.events
                .replay(world.events.originCursor())
                ?.events.filter((event) => event.type === "provider.event")
                .map(
                    (event) =>
                        (
                            event.payload as {
                                rigEvent?: { messageId?: string };
                            }
                        ).rigEvent?.messageId,
                )
                .find((messageId) => messageId !== undefined);
            expect(liveMessageId).toBe("inference-tools");

            const restartedEvents = new EventsModule();
            await resolveModuleHooks(world.database.context, restartedEvents);
            const restartedHistory = new HistoryModule(restartedEvents);
            expect(await restartedHistory.runs(world.database.context, "agent-a")).toEqual(page);
        } finally {
            world.database.close();
        }
    });

    it("moves a mutation echo through delayed acceptance after module restart", async () => {
        const world = await setup("history-runs-mutation-restart");
        try {
            await world.history.queuePending(world.database.context, {
                ...pending("message-mutation", 100),
                mutationId: "mutation-a",
            });

            const restartedEvents = new EventsModule();
            const restartedEventHooks = await resolveModuleHooks(
                world.database.context,
                restartedEvents,
            );
            const restartedHistory = new HistoryModule(restartedEvents);
            const restartedHistoryHooks = await resolveModuleHooks(
                world.database.context,
                restartedHistory,
            );
            await world.database.context.inTx(async (txCtx) => {
                const message: AgentBaseAcceptedMessage = {
                    ...accepted("message-mutation", "send"),
                    metadata: {
                        ...USER_MESSAGE_ORIGIN_METADATA,
                        hideFromUser: true,
                        happy: { remoteMessageId: "happy:remote-a" },
                    },
                };
                await restartedHistoryHooks.messageAcceptedTransact?.(txCtx, world.scope, message);
                await restartedEventHooks.messageAcceptedTransact?.(txCtx, world.scope, message);
            });

            expect(
                await restartedHistory.message(
                    world.database.context,
                    "agent-a",
                    "message-mutation",
                ),
            ).toMatchObject({
                recordId: "message-mutation",
                runId: "message-mutation",
                mutationId: "mutation-a",
                hideFromUser: true,
                remoteMessageId: "happy:remote-a",
            });
        } finally {
            world.database.close();
        }
    });

    it("omits raw tool data only when a presentation summary is available", async () => {
        const world = await setup("history-runs-tool-data");
        try {
            await world.history.queuePending(world.database.context, pending("message-tool", 100));
            await acceptBatch(world, [accepted("message-tool", "send")]);
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId: "calla",
                    name: "shell",
                    arguments: '{"command":"secret"}',
                },
            } as never);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                inferenceId: "inference-tool",
                loopId: "loop-a",
                turnId: "turn-a",
                contextTokens: undefined,
                state: "tool_call",
                tokens: { input: 1, output: 1 },
            });
            await world.historyHooks.beforeToolCallTransact?.(world.database.context, world.scope, {
                type: "tool_call",
                callId: "calla",
                name: "shell",
                arguments: '{"command":"secret"}',
            } as never);
            await world.historyHooks.afterToolCallTransact?.(world.database.context, world.scope, {
                role: "tool",
                callId: "calla",
                content: [{ type: "text", text: "private output" }],
            });

            const raw = await world.history.runs(world.database.context, "agent-a");
            expect(raw.runs[0]?.messages[1]?.blocks[0]).toHaveProperty("arguments");
            expect(raw.runs[0]?.messages[1]?.blocks[1]).toHaveProperty("output");

            const omitted = await world.history.runs(world.database.context, "agent-a", {
                omitToolData: true,
            });
            expect(omitted.runs[0]?.messages[1]?.blocks[0]).not.toHaveProperty("arguments");
            expect(omitted.runs[0]?.messages[1]?.blocks[1]).toMatchObject({
                type: "tool_result",
                display: "Tool shell returned 14 characters.",
            });
            expect(omitted.runs[0]?.messages[1]?.blocks[1]).not.toHaveProperty("output");
        } finally {
            world.database.close();
        }
    });

    it("retains inline image bytes exactly from pending state through accepted history", async () => {
        const world = await setup("history-runs-image");
        const imageData = "A".repeat(6 * 1_024 * 1_024);
        const imagePending: HistoryPendingMessage = {
            ...pending("message-image", 100),
            blocks: [{ type: "image", mediaType: "image/png", data: imageData }],
        };
        const imageAccepted: AgentBaseAcceptedMessage = {
            ...accepted("message-image", "send"),
            message: {
                role: "user",
                content: [{ type: "image", mimeType: "image/png", data: imageData }],
            },
        };
        try {
            await world.history.queuePending(world.database.context, imagePending);
            await acceptBatch(world, [imageAccepted]);

            const page = await world.history.runs(world.database.context, "agent-a");
            const image = page.runs[0]?.messages[0]?.blocks[0];
            expect(image).toMatchObject({ type: "image", mediaType: "image/png" });
            expect(image?.type === "image" ? image.data : undefined).toBe(imageData);
            expect(page.runs[0]?.id).toBe("message-image");
            expect(page.runs[0]?.messages[0]?.runId).toBe("message-image");

            const acceptance = world.events
                .replay(world.events.originCursor())
                ?.events.find((event) => event.type === "message.accepted");
            expect(acceptance?.payload).toEqual({
                id: "message-image",
                kind: "send",
                runId: "message-image",
            });
            expect(JSON.stringify(acceptance).length).toBeLessThan(1_024);
        } finally {
            world.database.close();
        }
    });

    it("atomically moves every accepted message into one authoritative run and survives restart", async () => {
        const world = await setup("history-runs-acceptance");
        try {
            await world.history.queuePending(world.database.context, pending("message-a", 100));
            await world.history.queuePending(world.database.context, pending("message-b", 101));
            await acceptBatch(world, [
                accepted("message-a", "send"),
                accepted("message-b", "send"),
            ]);

            expect(await world.history.pending(world.database.context, "agent-a")).toEqual([]);
            const live = await world.history.runs(world.database.context, "agent-a");
            expect(live.runs).toHaveLength(1);
            expect(live.runs[0]).toMatchObject({
                id: "message-a",
                status: "running",
                reason: null,
            });
            expect(
                live.runs[0]?.messages.map((message) => [message.recordId, message.runId]),
            ).toEqual([
                ["message-a", "message-a"],
                ["message-b", "message-a"],
            ]);

            const restartedEvents = new EventsModule();
            await resolveModuleHooks(world.database.context, restartedEvents);
            const restartedHistory = new HistoryModule(restartedEvents);
            expect(await restartedHistory.runs(world.database.context, "agent-a")).toEqual(live);
        } finally {
            world.database.close();
        }
    });

    it("makes only steering a live boundary and pages without splitting completed runs", async () => {
        const world = await setup("history-runs-steering");
        try {
            await world.history.queuePending(world.database.context, pending("message-a", 100));
            await acceptBatch(world, [accepted("message-a", "send")]);
            await finishInference(world, "inference-a", "first answer");

            await world.history.queuePending(
                world.database.context,
                pending("message-b", 200, "steer"),
            );
            await acceptBatch(world, [accepted("message-b", "steering")]);
            await finishInference(world, "inference-b", "second answer");

            const extension = await world.history.runs(world.database.context, "agent-a", {
                after: "message-b",
            });
            expect(extension.runs).toHaveLength(1);
            expect(extension.runs[0]?.id).toBe("message-b");
            expect(extension.runs[0]?.messages.map((message) => message.recordId)).toEqual([
                "inference-b",
            ]);

            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-a", settlementId: "settlement-a" },
            );
            await world.eventHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-a", settlementId: "settlement-a" },
            );

            const newest = await world.history.runs(world.database.context, "agent-a", {
                limit: 1,
            });
            expect(newest.hasMore).toBe(true);
            expect(newest.runs).toHaveLength(1);
            expect(newest.runs[0]).toMatchObject({
                id: "message-b",
                status: "completed",
                reason: "completed",
            });
            expect(newest.runs[0]?.messages).toHaveLength(2);

            const older = await world.history.runs(world.database.context, "agent-a", {
                before: "message-b",
                limit: 1,
            });
            expect(older.hasMore).toBe(false);
            expect(older.runs).toHaveLength(1);
            expect(older.runs[0]).toMatchObject({
                id: "message-a",
                status: "aborted",
                reason: "steering",
            });
            expect(older.runs[0]?.messages).toHaveLength(2);
        } finally {
            world.database.close();
        }
    });
});
