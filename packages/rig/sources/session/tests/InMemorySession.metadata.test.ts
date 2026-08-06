import { afterEach, describe, expect, it, vi } from "vitest";

import Database from "better-sqlite3";
import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { NativeProcessManager } from "../../processes/index.js";
import {
    createEventIdFactory,
    type ModelCatalog,
    type SessionEvent,
} from "../../protocol/index.js";
import { createInferenceStream } from "@slopus/rig-execution";
import { toLocalDate } from "../../executor/toLocalDate.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type StreamOptions,
} from "@slopus/rig-execution";
import {
    InMemorySession,
    type PersistedSessionState,
    type WorkspaceRunReadiness,
} from "../InMemorySession.js";
import { TrackedTaskDrain } from "../../utils/TrackedTaskDrain.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("InMemorySession metadata settlement", () => {
    it("titles from the first message immediately, then refines after the first agent response", async () => {
        const harness = createHarness();

        const first = harness.session.submit({ text: "Implement immediate session metadata." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        await vi.waitFor(() =>
            expect(harness.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]),
        );
        expect(JSON.stringify(harness.metadataContexts[0])).toContain(
            "Implement immediate session metadata.",
        );
        expect(JSON.stringify(harness.metadataContexts[0])).not.toContain(
            "Final visible response 1.",
        );

        await harness.session.waitForRun(first.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));
        const firstMessageEvent = harness.session.events
            .since(undefined)
            ?.find((event) => event.type === "message_submitted");
        if (firstMessageEvent === undefined) throw new Error("First message event was not stored.");
        expect(harness.runtimeStartDates).toEqual([toLocalDate(firstMessageEvent.createdAt)]);
        expect(JSON.stringify(harness.metadataContexts[1])).toContain("Final visible response 1.");
        await vi.waitFor(() =>
            expect(harness.session.snapshot()).toMatchObject({
                metadataRunId: first.runId,
                recap: "The user implemented delayed session metadata.",
                title: "Delayed session metadata",
                titleStatus: "ready",
            }),
        );
    });

    it("finishes restored first-message naming before releasing a ready workspace run", async () => {
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = waiting.session.submit({ text: "Resume after workspace setup." });
        const restoredState = waiting.session.state();
        const restoredEvents = waiting.session.events.since(undefined) ?? [];
        let releaseMetadata: (() => void) | undefined;
        const metadataGate = new Promise<void>((resolve) => {
            releaseMetadata = resolve;
        });
        const restored = createHarness({
            events: restoredEvents,
            restore: restoredState,
            staleMetadata: metadataGate,
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "ready" }),
        });

        restored.session.workspaceReadinessChanged();
        await vi.waitFor(() => expect(restored.inferenceKinds).toEqual(["metadata"]));
        expect(restored.session.state().queuedRuns).toHaveLength(1);

        releaseMetadata?.();
        await restored.session.waitForRun(submitted.runId);
        expect(restored.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]);
    });

    it("releases a ready workspace run when first-message naming reaches its deadline", async () => {
        vi.useFakeTimers();
        const neverSettles = new Promise<void>(() => {});
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = waiting.session.submit({ text: "Do not wait forever for naming." });
        const restored = createHarness({
            afterMetadataAbort: neverSettles,
            events: waiting.session.events.since(undefined) ?? [],
            restore: waiting.session.state(),
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "ready" }),
        });

        restored.session.workspaceReadinessChanged();
        await vi.waitFor(() => expect(restored.inferenceKinds).toEqual(["metadata"]));
        await vi.advanceTimersByTimeAsync(30_000);
        await restored.session.waitForRun(submitted.runId);

        expect(restored.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]);
        await restored.session.beginShutdown();
        expect(restored.session.snapshot().titleStatus).toBe("idle");
    });

    it("retries an inconclusive ready-workspace probe without another workspace event", async () => {
        vi.useFakeTimers();
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = waiting.session.submit({ text: "Retry the transient directory probe." });
        let probes = 0;
        const restored = createHarness({
            events: waiting.session.events.since(undefined) ?? [],
            restore: waiting.session.state(),
            workspaceId: "workspace-1",
            workspaceRunReadiness: () =>
                probes++ === 0 ? { retryable: true, state: "waiting" } : { state: "ready" },
        });

        restored.session.workspaceReadinessChanged();
        await vi.advanceTimersByTimeAsync(100);
        await restored.session.waitForRun(submitted.runId);

        expect(restored.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]);
    });

    it("durably fails after bounded ready-workspace probe retries are exhausted", async () => {
        vi.useFakeTimers();
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = waiting.session.submit({ text: "Bound repeated directory probes." });
        const restored = createHarness({
            events: waiting.session.events.since(undefined) ?? [],
            restore: waiting.session.state(),
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ retryable: true, state: "waiting" }),
        });

        restored.session.workspaceReadinessChanged();
        await vi.runAllTimersAsync();
        await restored.session.waitForRun(submitted.runId);

        expect(restored.inferenceKinds).toEqual([]);
        expect(restored.session.state().queuedRuns).toEqual([]);
        expect(
            restored.session.events
                .since(undefined)
                ?.find(
                    (event) => event.type === "run_error" && event.data.runId === submitted.runId,
                ),
        ).toMatchObject({
            data: {
                errorMessage: expect.stringContaining("after repeated attempts"),
            },
        });
    });

    it("keeps a retryable workspace run durable when shutdown wins the drain race", async () => {
        const taskDrain = new TrackedTaskDrain();
        const harness = createHarness({
            taskDrain,
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ retryable: true, state: "waiting" }),
        });
        const submitted = harness.session.submit({ text: "Keep this queued through shutdown." });

        const shutdown = harness.session.beginShutdown();
        await taskDrain.drain();
        await shutdown;

        expect(harness.session.state().queuedRuns).toMatchObject([{ runId: submitted.runId }]);
        expect(
            harness.session.events
                .since(undefined)
                ?.some(
                    (event) => event.type === "run_error" && event.data.runId === submitted.runId,
                ),
        ).toBe(false);
    });

    it("lets the user abort a queued run while its metadata barrier is active", async () => {
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        waiting.session.submit({ text: "Stop this before naming finishes." });
        const restored = createHarness({
            afterMetadataAbort: Promise.resolve(),
            events: waiting.session.events.since(undefined) ?? [],
            restore: waiting.session.state(),
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "ready" }),
        });

        restored.session.workspaceReadinessChanged();
        await vi.waitFor(() => expect(restored.inferenceKinds).toEqual(["metadata"]));
        await expect(restored.session.abort()).resolves.toMatchObject({ aborted: true });
        await Promise.resolve();

        expect(restored.inferenceKinds).toEqual(["metadata"]);
        expect(restored.session.state().queuedRuns).toEqual([]);
        expect(restored.session.snapshot().titleStatus).toBe("idle");
    });

    it("uses the second user message as the one refinement trigger when it arrives first", async () => {
        let releaseAgent: (() => void) | undefined;
        const agentGate = new Promise<void>((resolve) => {
            releaseAgent = resolve;
        });
        const harness = createHarness({ agentGate });

        const first = harness.session.submit({ text: "Start from this message." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        const second = harness.session.submit({ text: "Use this clarification too." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));
        expect(JSON.stringify(harness.metadataContexts[1])).toContain("Start from this message.");
        expect(JSON.stringify(harness.metadataContexts[1])).toContain(
            "Use this clarification too.",
        );
        expect(JSON.stringify(harness.metadataContexts[1])).not.toContain("Final visible response");

        releaseAgent?.();
        await harness.session.waitForRun(first.runId);
        await harness.session.waitForRun(second.runId);
        await Promise.resolve();
        expect(harness.metadataContexts).toHaveLength(2);
        expect(harness.session.snapshot().metadataRunId).toBe(second.runId);
    });

    it("offers the initial chat title to its workspace exactly once", async () => {
        const inheritedTitles: string[] = [];
        const harness = createHarness({ inheritedTitles, workspaceId: "workspace-1" });

        const first = harness.session.submit({ text: "Name this workspace from the chat." });
        await harness.session.waitForRun(first.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        expect(inheritedTitles).toEqual(["Delayed session metadata"]);
    });

    it("lets a database failure from initial workspace title inheritance escape the settlement", async () => {
        const databaseError = captureDriverError();
        let harness: ReturnType<typeof createHarness> | undefined;

        const escaped = await captureUnhandledRejection(async () => {
            harness = createHarness({
                onInitialTitle: () => {
                    throw databaseError;
                },
                workspaceId: "workspace-1",
            });

            harness.session.submit({ text: "Name this workspace from the chat." });
            await vi.waitFor(() => expect(harness?.metadataContexts).toHaveLength(1));
        });

        expect(escaped).toBe(databaseError);
        expect(harness?.session.snapshot().titleStatus).not.toBe("error");
    });

    it("keeps ordinary initial workspace title inheritance failures optional", async () => {
        const inherited = vi.fn(() => {
            throw new Error("Workspace title inheritance is unavailable.");
        });
        const harness = createHarness({
            onInitialTitle: inherited,
            workspaceId: "workspace-1",
        });

        const first = harness.session.submit({ text: "Name this workspace from the chat." });
        await harness.session.waitForRun(first.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        expect(inherited).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(harness.session.snapshot().titleStatus).toBe("ready"));
    });

    it("serializes refinement behind an in-flight initial title", async () => {
        let releaseStale: (() => void) | undefined;
        const staleReleased = new Promise<void>((resolve) => {
            releaseStale = resolve;
        });
        const harness = createHarness({ staleMetadata: staleReleased });

        const first = harness.session.submit({ text: "Initial request." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        expect(harness.metadataSignals[0]?.aborted).toBe(false);

        const second = harness.session.submit({ text: "A newer request supersedes it." });
        expect(harness.metadataSignals[0]?.aborted).toBe(false);
        releaseStale?.();
        await harness.session.waitForRun(first.runId);
        await harness.session.waitForRun(second.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        expect(harness.session.snapshot()).toMatchObject({
            metadataRunId: second.runId,
            title: "Delayed session metadata",
        });
        expect(harness.session.snapshot().title).not.toBe("Stale generated title");
    });

    it("invalidates stale metadata on rewind and reset", async () => {
        const harness = createHarness();
        const first = harness.session.submit({ text: "Keep this turn." });
        await harness.session.waitForRun(first.runId);
        const second = harness.session.submit({ text: "Remove this turn." });
        await harness.session.waitForRun(second.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        const secondMessage = harness.session
            .snapshot()
            .snapshot.messages.find(
                (message) =>
                    message.role === "user" &&
                    message.blocks[0]?.type === "text" &&
                    message.blocks[0].text === "Remove this turn.",
            );
        if (secondMessage === undefined) throw new Error("Second user message was not persisted.");
        harness.session.rewind(secondMessage.id);
        await vi.waitFor(() =>
            expect(harness.session.snapshot()).toMatchObject({
                metadataRunId: first.runId,
                titleStatus: "ready",
            }),
        );

        await harness.session.reset();
        expect(harness.session.snapshot()).toMatchObject({ titleStatus: "idle" });
        expect(harness.session.snapshot()).not.toHaveProperty("metadataRunId");
        expect(harness.session.snapshot()).not.toHaveProperty("metadataUpdatedAt");
        expect(harness.session.snapshot()).not.toHaveProperty("recap");
        await Promise.resolve();
        expect(harness.metadataContexts).toHaveLength(4);
    });

    it("does not let a provider that ignores abort block task-drain shutdown", async () => {
        vi.useFakeTimers();
        const taskDrain = new TrackedTaskDrain();
        const afterAbort = new Promise<void>(() => {});
        let observedAbort = false;
        const harness = createHarness({
            afterMetadataAbort: afterAbort,
            onMetadataAbort: () => {
                observedAbort = true;
            },
            taskDrain,
        });
        const foreground = harness.session.submit({ text: "Abort in-flight metadata safely." });
        await harness.session.waitForRun(foreground.runId);
        expect(harness.metadataContexts).toHaveLength(1);

        taskDrain.beginClose();
        const shuttingDown = harness.session.beginShutdown();
        const draining = taskDrain.drain();
        await vi.waitFor(() => expect(observedAbort).toBe(true));
        await draining;
        await shuttingDown;
        expect(harness.session.snapshot().titleStatus).toBe("idle");
    });
});

function createHarness(
    options: {
        agentGate?: Promise<void>;
        afterMetadataAbort?: Promise<void>;
        events?: readonly SessionEvent[];
        onMetadataAbort?: () => void;
        restore?: PersistedSessionState;
        staleMetadata?: Promise<void>;
        taskDrain?: TrackedTaskDrain;
        inheritedTitles?: string[];
        onInitialTitle?: (metadata: {
            projectId: string;
            sessionId: string;
            title: string;
            workspaceId: string;
        }) => void;
        workspaceId?: string;
        workspaceRunReadiness?: () => WorkspaceRunReadiness;
    } = {},
) {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/session-metadata",
        name: "Session metadata",
        thinkingLevels: ["off"],
    });
    const metadataContexts: Context[] = [];
    const metadataSignals: AbortSignal[] = [];
    const inferenceKinds: ("agent" | "metadata")[] = [];
    let agentResponses = 0;
    let metadataResponses = 0;
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream(_model, context, streamOptions: StreamOptions = {}) {
            if (streamOptions.sessionId?.endsWith(":title")) {
                inferenceKinds.push("metadata");
                metadataContexts.push(context);
                if (streamOptions.signal !== undefined) metadataSignals.push(streamOptions.signal);
                metadataResponses += 1;
                return createInferenceStream(async function* () {
                    if (options.afterMetadataAbort !== undefined) {
                        await new Promise<void>((resolve) => {
                            const signal = streamOptions.signal;
                            if (signal?.aborted === true) {
                                resolve();
                                return;
                            }
                            signal?.addEventListener("abort", () => resolve(), { once: true });
                        });
                        options.onMetadataAbort?.();
                        await options.afterMetadataAbort;
                        throw new Error("Metadata generation was cancelled.");
                    }
                    if (metadataResponses === 1 && options.staleMetadata !== undefined) {
                        await options.staleMetadata;
                    }
                    const message = assistantMessage(
                        JSON.stringify(
                            metadataResponses === 1 && options.staleMetadata !== undefined
                                ? {
                                      title: "Stale generated title",
                                      recap: "This stale result must be discarded.",
                                  }
                                : {
                                      title: "Delayed session metadata",
                                      recap: "The user implemented delayed session metadata.",
                                  },
                        ),
                    );
                    yield { type: "start", partial: message };
                    yield { type: "done", reason: "stop", message };
                    return message;
                });
            }
            inferenceKinds.push("agent");
            agentResponses += 1;
            const message = assistantMessage(`Final visible response ${agentResponses}.`);
            return createInferenceStream(async function* () {
                await options.agentGate;
                yield { type: "start", partial: message };
                yield { type: "done", reason: "stop", message };
                return message;
            });
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ providerId: provider.id, models: [model] }],
    };
    const runtimeStartDates: (string | undefined)[] = [];
    const root = new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (runtimeOptions) => {
            runtimeStartDates.push(runtimeOptions.startDate);
            return createRuntime(runtimeOptions, provider);
        },
        modelCatalog: catalog,
        ...(options.events === undefined ? {} : { events: options.events }),
        ...(options.onInitialTitle === undefined && options.inheritedTitles === undefined
            ? {}
            : {
                  onInitialTitle:
                      options.onInitialTitle ??
                      (({ title }) => {
                          options.inheritedTitles?.push(title);
                      }),
              }),
        projectId: "project-1",
        request: { cwd: "/tmp/rig-metadata-test", modelId: model.id, providerId: provider.id },
        ...(options.restore === undefined ? {} : { restore: options.restore }),
        ...(options.taskDrain === undefined ? {} : { taskDrain: options.taskDrain }),
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        ...(options.workspaceRunReadiness === undefined
            ? {}
            : { workspaceRunReadiness: options.workspaceRunReadiness }),
    });
    return {
        inferenceKinds,
        metadataContexts,
        metadataSignals,
        runtimeStartDates,
        session: root,
    };
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
            tools: [],
        }),
        context,
        cwd: options.cwd,
        processManager,
        executor: provider,
    };
}

function assistantMessage(text: string): AssistantMessage {
    return {
        api: "test",
        content: [{ text, type: "text" }],
        model: "test/session-metadata",
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}

function captureDriverError(): unknown {
    const database = new Database(":memory:");
    try {
        database.prepare("select * from missing_table").all();
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        database.close();
    }
}

async function captureUnhandledRejection(run: () => Promise<void>): Promise<unknown> {
    const installed = process.listeners("unhandledRejection");
    for (const listener of installed) process.off("unhandledRejection", listener);
    let captured: unknown;
    const observe = (reason: unknown): void => {
        captured ??= reason;
    };
    process.on("unhandledRejection", observe);
    try {
        await run();
        for (let attempt = 0; attempt < 200 && captured === undefined; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return captured;
    } finally {
        process.off("unhandledRejection", observe);
        for (const listener of installed) process.on("unhandledRejection", listener);
    }
}
