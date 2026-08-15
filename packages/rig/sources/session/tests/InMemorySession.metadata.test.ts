import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@libsql/client";
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
import { toLocalDate } from "../toLocalDate.js";
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
        let releaseAgent!: () => void;
        const agentGate = new Promise<void>((resolve) => {
            releaseAgent = resolve;
        });
        const harness = createHarness({ agentGate });

        const first = await harness.session.submit(ctx, {
            text: "Implement immediate session metadata.",
        });
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

        releaseAgent();
        await harness.session.waitForRun(ctx, first.runId);
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

    it("titles the first message when its managed workspace is already ready", async () => {
        const inheritedTitles: string[] = [];
        const harness = createHarness({
            inheritedTitles,
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "ready" }),
        });

        const submitted = await harness.session.submit(ctx, {
            text: "Name this already ready workspace.",
        });
        await harness.session.waitForRun(ctx, submitted.runId);
        await vi.waitFor(() => expect(harness.session.snapshot().titleStatus).toBe("ready"));

        expect(harness.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]);
        expect(inheritedTitles).toEqual(["Delayed session metadata"]);
    });

    it("finishes restored first-message naming before releasing a ready workspace run", async () => {
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = await waiting.session.submit(ctx, {
            text: "Resume after workspace setup.",
        });
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
        await restored.session.waitForRun(ctx, submitted.runId);
        expect(restored.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]);
    });

    it("releases a ready workspace run when first-message naming reaches its deadline", async () => {
        vi.useFakeTimers();
        const neverSettles = new Promise<void>(() => {});
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = await waiting.session.submit(ctx, {
            text: "Do not wait forever for naming.",
        });
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
        await restored.session.waitForRun(ctx, submitted.runId);

        expect(restored.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]);
        await restored.session.beginShutdown(ctx);
        expect(restored.session.snapshot().titleStatus).toBe("idle");
    });

    it("retries an inconclusive ready-workspace probe without another workspace event", async () => {
        vi.useFakeTimers();
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = await waiting.session.submit(ctx, {
            text: "Retry the transient directory probe.",
        });
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
        await restored.session.waitForRun(ctx, submitted.runId);

        expect(restored.inferenceKinds.slice(0, 2)).toEqual(["metadata", "agent"]);
    });

    it("durably fails after bounded ready-workspace probe retries are exhausted", async () => {
        vi.useFakeTimers();
        const waiting = createHarness({
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "waiting" }),
        });
        const submitted = await waiting.session.submit(ctx, {
            text: "Bound repeated directory probes.",
        });
        const restored = createHarness({
            events: waiting.session.events.since(undefined) ?? [],
            restore: waiting.session.state(),
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ retryable: true, state: "waiting" }),
        });

        restored.session.workspaceReadinessChanged();
        await vi.runAllTimersAsync();
        await restored.session.waitForRun(ctx, submitted.runId);

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
        const submitted = await harness.session.submit(ctx, {
            text: "Keep this queued through shutdown.",
        });

        const shutdown = harness.session.beginShutdown(ctx);
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
        await waiting.session.submit(ctx, { text: "Stop this before naming finishes." });
        const restored = createHarness({
            afterMetadataAbort: Promise.resolve(),
            events: waiting.session.events.since(undefined) ?? [],
            restore: waiting.session.state(),
            workspaceId: "workspace-1",
            workspaceRunReadiness: () => ({ state: "ready" }),
        });

        restored.session.workspaceReadinessChanged();
        await vi.waitFor(() => expect(restored.inferenceKinds).toEqual(["metadata"]));
        await expect(restored.session.abort(ctx)).resolves.toMatchObject({ aborted: true });
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

        const first = await harness.session.submit(ctx, { text: "Start from this message." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        const second = await harness.session.submit(ctx, { text: "Use this clarification too." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));
        expect(JSON.stringify(harness.metadataContexts[1])).toContain("Start from this message.");
        expect(JSON.stringify(harness.metadataContexts[1])).toContain(
            "Use this clarification too.",
        );
        expect(JSON.stringify(harness.metadataContexts[1])).not.toContain("Final visible response");

        releaseAgent?.();
        await harness.session.waitForRun(ctx, first.runId);
        await harness.session.waitForRun(ctx, second.runId);
        await Promise.resolve();
        expect(harness.metadataContexts).toHaveLength(2);
        expect(harness.session.snapshot().metadataRunId).toBe(second.runId);
    });

    it("offers the initial chat title to its workspace exactly once", async () => {
        const inheritedTitles: string[] = [];
        const harness = createHarness({ inheritedTitles, workspaceId: "workspace-1" });

        const first = await harness.session.submit(ctx, {
            text: "Name this workspace from the chat.",
        });
        await harness.session.waitForRun(ctx, first.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        expect(inheritedTitles).toEqual(["Delayed session metadata"]);
    });

    it("names the chat and its workspace after a failed first attempt", async () => {
        const inheritedTitles: string[] = [];
        const harness = createHarness({
            failedMetadataAttempts: 1,
            inheritedTitles,
            workspaceId: "workspace-1",
        });

        const first = await harness.session.submit(ctx, {
            text: "Name this workspace from the chat.",
        });
        await harness.session.waitForRun(ctx, first.runId);
        await vi.waitFor(() =>
            expect(harness.session.snapshot()).toMatchObject({
                title: "Delayed session metadata",
                titleStatus: "ready",
            }),
        );
        await vi.waitFor(() => expect(inheritedTitles).toEqual(["Delayed session metadata"]));

        // The failure was reported while it stood, and then it was tried again rather than
        // leaving the chat and its workspace unnamed for good.
        expect(
            harness.session.events
                .since(undefined)
                ?.flatMap((event) =>
                    event.type === "session_title_changed" && "errorMessage" in event.data
                        ? [event.data.errorMessage]
                        : [],
                ),
        ).toEqual(["The account is out of capacity."]);
    });

    it("stops naming a chat whose provider keeps failing", async () => {
        const harness = createHarness({ failedMetadataAttempts: 10 });

        for (const text of ["Give up eventually.", "Second.", "Third.", "Fourth.", "Fifth."]) {
            const submitted = await harness.session.submit(ctx, { text });
            await harness.session.waitForRun(ctx, submitted.runId);
        }
        await vi.waitFor(() => expect(harness.session.snapshot().titleStatus).toBe("error"));

        expect(harness.metadataContexts).toHaveLength(3);
    });

    it("lets a database failure from initial workspace naming escape the settlement", async () => {
        const databaseError = await captureDriverError();
        let harness: ReturnType<typeof createHarness> | undefined;

        const escaped = await captureUnhandledRejection(async () => {
            harness = createHarness({
                onInitialTitle: () => {
                    throw databaseError;
                },
                workspaceId: "workspace-1",
            });

            void harness.session.submit(ctx, { text: "Name this workspace from the chat." });
            await vi.waitFor(() => expect(harness?.metadataContexts).toHaveLength(1));
        });

        expect(escaped).toBe(databaseError);
        expect(harness?.session.snapshot().titleStatus).not.toBe("error");
    });

    it("restores title projections when the ready metadata event fails to persist", async () => {
        const databaseError = await captureDriverError();
        const inheritedTitles: string[] = [];
        let harness: ReturnType<typeof createHarness> | undefined;

        const escaped = await captureUnhandledRejection(async () => {
            harness = createHarness({
                inheritedTitles,
                onAppendEvent: (event) => {
                    if (event.type === "session_title_changed" && event.data.status === "ready") {
                        throw databaseError;
                    }
                },
                workspaceId: "workspace-1",
            });

            void harness.session.submit(ctx, { text: "Keep failed metadata out of memory." });
            await vi.waitFor(() => expect(harness?.metadataContexts).toHaveLength(1));
        });

        expect(escaped).toBe(databaseError);
        expect(harness?.session.snapshot()).toMatchObject({
            titleStatus: "generating",
        });
        expect(harness?.session.snapshot().title).toBeUndefined();
        expect(harness?.session.snapshot().recap).toBeUndefined();
        expect(harness?.session.snapshot().metadataUpdatedAt).toBeUndefined();
        expect(inheritedTitles).toEqual([]);
    });

    it("keeps ordinary initial workspace naming failures optional", async () => {
        const inherited = vi.fn(() => {
            throw new Error("Workspace naming is unavailable.");
        });
        const harness = createHarness({
            onInitialTitle: inherited,
            workspaceId: "workspace-1",
        });

        const first = await harness.session.submit(ctx, {
            text: "Name this workspace from the chat.",
        });
        await harness.session.waitForRun(ctx, first.runId);
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

        const first = await harness.session.submit(ctx, { text: "Initial request." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        expect(harness.metadataSignals[0]?.aborted).toBe(false);

        const second = await harness.session.submit(ctx, {
            text: "A newer request supersedes it.",
        });
        expect(harness.metadataSignals[0]?.aborted).toBe(false);
        releaseStale?.();
        await harness.session.waitForRun(ctx, first.runId);
        await harness.session.waitForRun(ctx, second.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        expect(harness.session.snapshot()).toMatchObject({
            metadataRunId: second.runId,
            title: "Delayed session metadata",
        });
        expect(harness.session.snapshot().title).not.toBe("Stale generated title");
    });

    it("gives back the naming attempt a cleared chat cancelled", async () => {
        // Naming hangs until it is cancelled, so every attempt here ends the way a cleared chat
        // ends one. A chat gets an initial attempt and a refining one; if cancelling spent them,
        // the third request would never be named at all.
        const harness = createHarness({ afterMetadataAbort: Promise.resolve() });

        for (const text of ["Ask the wrong thing.", "Ask a different wrong thing."]) {
            await harness.session.submit(ctx, { text });
            await vi.waitFor(() => expect(harness.metadataSignals).not.toHaveLength(0));
            const pending = harness.metadataSignals.length;
            await harness.session.reset(ctx);
            expect(harness.metadataSignals[pending - 1]?.aborted).toBe(true);
        }

        await harness.session.submit(ctx, { text: "Ask the right thing." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(3));
    });

    it("does not count naming cancelled by a rewind as a naming failure", async () => {
        const harness = createHarness({ afterMetadataAbort: Promise.resolve() });
        const first = await harness.session.submit(ctx, { text: "Keep this turn." });
        await harness.session.waitForRun(ctx, first.runId);
        const second = await harness.session.submit(ctx, { text: "Remove this turn." });
        await harness.session.waitForRun(ctx, second.runId);
        await vi.waitFor(() => expect(harness.metadataSignals).not.toHaveLength(0));

        const secondMessage = harness.session
            .snapshot()
            .snapshot.messages.find(
                (message) =>
                    message.role === "user" &&
                    message.blocks[0]?.type === "text" &&
                    message.blocks[0].text === "Remove this turn.",
            );
        if (secondMessage === undefined) throw new Error("Second user message was not persisted.");
        await harness.session.rewind(ctx, secondMessage.id);

        // Rewinding closes the runtime the naming request was running through. That is the rewind
        // cancelling its own work, not the chat failing to earn a name.
        await vi.waitFor(() => expect(harness.metadataSignals[0]?.aborted).toBe(true));
        await Promise.resolve();
        expect(harness.session.snapshot().titleStatus).not.toBe("error");
    });

    it("keeps the name a chat has been given through rewind and reset", async () => {
        const inherited = vi.fn();
        const harness = createHarness({ onInitialTitle: inherited, workspaceId: "workspace-1" });
        const first = await harness.session.submit(ctx, { text: "Keep this turn." });
        await harness.session.waitForRun(ctx, first.runId);
        const second = await harness.session.submit(ctx, { text: "Remove this turn." });
        await harness.session.waitForRun(ctx, second.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));
        const named = harness.session.snapshot().title;

        const secondMessage = harness.session
            .snapshot()
            .snapshot.messages.find(
                (message) =>
                    message.role === "user" &&
                    message.blocks[0]?.type === "text" &&
                    message.blocks[0].text === "Remove this turn.",
            );
        if (secondMessage === undefined) throw new Error("Second user message was not persisted.");
        await harness.session.rewind(ctx, secondMessage.id);
        expect(harness.session.snapshot()).toMatchObject({ title: named, titleStatus: "ready" });

        // Clearing the chat empties the transcript, and the name the chat earned outlives it.
        await harness.session.reset(ctx);
        expect(harness.session.snapshot()).toMatchObject({ title: named, titleStatus: "ready" });
        await Promise.resolve();
        expect(harness.metadataContexts).toHaveLength(2);
        expect(inherited).toHaveBeenCalledOnce();
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
        const foreground = await harness.session.submit(ctx, {
            text: "Abort in-flight metadata safely.",
        });
        await harness.session.waitForRun(ctx, foreground.runId);
        expect(harness.metadataContexts).toHaveLength(1);

        taskDrain.beginClose();
        const shuttingDown = harness.session.beginShutdown(ctx);
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
        /** How many naming attempts fail before one succeeds. */
        failedMetadataAttempts?: number;
        onAppendEvent?: (event: SessionEvent) => void | Promise<void>;
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
        stream(runtimeCtx, _model, context, streamOptions: StreamOptions = {}) {
            if (streamOptions.sessionId?.endsWith(":title")) {
                inferenceKinds.push("metadata");
                metadataContexts.push(context);
                if (runtimeCtx.lifetime !== undefined) metadataSignals.push(runtimeCtx.lifetime);
                metadataResponses += 1;
                return createInferenceStream(async function* () {
                    if (options.afterMetadataAbort !== undefined) {
                        await new Promise<void>((resolve) => {
                            const signal = runtimeCtx.lifetime;
                            if (signal?.aborted === true) {
                                resolve();
                                return;
                            }
                            signal?.addEventListener("abort", () => resolve(), { once: true });
                        });
                        options.onMetadataAbort?.();
                        await options.afterMetadataAbort;
                        const ignoredAbort = assistantMessage(
                            "<title>Ignored abort</title>\n<recap>This result must be discarded.</recap>",
                        );
                        yield { type: "start", partial: ignoredAbort };
                        yield { type: "done", reason: "stop", message: ignoredAbort };
                        return ignoredAbort;
                    }
                    if (metadataResponses === 1 && options.staleMetadata !== undefined) {
                        await options.staleMetadata;
                    }
                    if (metadataResponses <= (options.failedMetadataAttempts ?? 0)) {
                        // What a failed vendor response looks like from here: no answer at all.
                        const failure = {
                            ...assistantMessage(""),
                            errorMessage: "The account is out of capacity.",
                            stopReason: "error" as const,
                        };
                        yield { type: "error", reason: "error", error: failure };
                        return failure;
                    }
                    const named =
                        metadataResponses === 1 && options.staleMetadata !== undefined
                            ? {
                                  title: "Stale generated title",
                                  recap: "This stale result must be discarded.",
                              }
                            : {
                                  title: "Delayed session metadata",
                                  recap: "The user implemented delayed session metadata.",
                              };
                    const message = assistantMessage(
                        `<title>${named.title}</title>\n<recap>${named.recap}</recap>`,
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
    const root = new InMemorySession(ctx, {
        createEventId: createEventIdFactory(),
        createRuntime: (runtimeOptions) => {
            runtimeStartDates.push(runtimeOptions.startDate);
            return createRuntime(runtimeOptions, provider);
        },
        modelCatalog: catalog,
        ...(options.onAppendEvent === undefined
            ? {}
            : { onAppendEvent: (_ctx, event) => options.onAppendEvent!(event) }),
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
        scope:
            options.workspaceId === undefined
                ? { kind: "project", projectId: "project-1" }
                : { kind: "workspace", projectId: "project-1", workspaceId: options.workspaceId },
        request: { cwd: "/tmp/rig-metadata-test", modelId: model.id, providerId: provider.id },
        ...(options.restore === undefined ? {} : { restore: options.restore }),
        ...(options.taskDrain === undefined ? {} : { taskDrain: options.taskDrain }),
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
    const context = createNodeAgentContext(createTestRootContext().named("agent"), {
        cwd: options.cwd,
        processManager,
    });
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

async function captureDriverError(): Promise<unknown> {
    const database = createClient({ url: "file::memory:" });
    try {
        await database.execute("select * from missing_table");
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        await database.close();
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
