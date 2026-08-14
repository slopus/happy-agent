import { createTestRootContext } from "../../testing/createTestRootContext.js";
import type { Context } from "@steve.kite/stdlib";
import type { Span, Tracer } from "@opentelemetry/api";

const ctx = createTestRootContext();
import { describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { defineModel, defineProvider, type InferenceStream } from "@slopus/rig-execution";
import { InMemorySession, type InMemorySessionPersistence } from "../InMemorySession.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";
import type { TaskDrain } from "../../utils/TrackedTaskDrain.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import {
    deferSessionTransactionCommit,
    runSessionTransaction,
} from "../SessionTransactionContext.js";

describe("InMemorySession", () => {
    it("projects Agent Base user and assistant messages into the reconnect transcript", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-agent-base-projection" });
        const user = {
            blocks: [{ text: "Hello from Agent Base.", type: "text" }],
            id: "agent-base-user",
            identity: null,
            role: "user",
        } as const;
        const assistant = {
            blocks: [{ text: "Hello from the projection.", type: "text" }],
            id: "agent-base-assistant",
            providerId: "codex",
            requestedModelId: session.snapshot().modelId,
            role: "agent",
        } as const;

        const submitted = await session.projectUserMessage(ctx, {
            delivery: "run",
            displayText: "Hello from Agent Base.",
            message: user,
            runId: "agent-base-run",
        });
        const completed = await session.projectAgentMessage(ctx, "agent-base-run", assistant);

        expect(submitted.type).toBe("message_submitted");
        expect(completed.type).toBe("agent_message");
        expect((await session.transcriptWindow(ctx)).messages).toEqual([user, assistant]);
    });

    it("keeps current-state event payloads bounded independently of transcript size", async () => {
        const firstModel = defineModel({
            defaultThinkingLevel: "off",
            id: "test/bounded-events-first",
            name: "Bounded events first",
            thinkingLevels: ["off"],
        });
        const secondModel = defineModel({
            defaultThinkingLevel: "off",
            id: "test/bounded-events-second",
            name: "Bounded events second",
            thinkingLevels: ["off"],
        });
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: {
                defaultModelId: firstModel.id,
                defaultProviderId: "test",
                models: [firstModel, secondModel],
                providers: [{ providerId: "test", models: [firstModel, secondModel] }],
            },
        });
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-bounded-current-state-events",
        });
        await session.submitContext(ctx, { text: "large transcript ".repeat(20_000) });

        await session.update(ctx, { appendSystemPrompt: "Keep replies concise." });
        const updated = session.events.all().findLast((event) => event.type === "session_updated");
        expect(updated?.type).toBe("session_updated");
        if (updated?.type !== "session_updated") throw new Error("Missing session update.");
        expect(updated.data.session.snapshot.messages).toEqual([]);
        expect(updated.data.session.snapshot.contextMessages).toBeUndefined();
        expect(JSON.stringify(updated.data).length).toBeLessThan(20_000);

        await session.changeModel(ctx, {
            modelId: secondModel.id,
            providerId: "test",
        });
        const configured = session.events
            .all()
            .findLast((event) => event.type === "session_configuration_changed");
        expect(configured?.type).toBe("session_configuration_changed");
        if (configured?.type !== "session_configuration_changed") {
            throw new Error("Missing session configuration change.");
        }
        expect(configured.data).not.toHaveProperty("snapshot");
        expect(JSON.stringify(configured.data).length).toBeLessThan(1_000);
    });

    it("stores idempotent context without starting or queuing a run", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-context-only" });

        const first = await session.submitContext(ctx, {
            clientSubmissionId: "context-note-1",
            text: "The deployment region is eu-west-1.",
        });
        const repeated = await session.submitContext(ctx, {
            clientSubmissionId: "context-note-1",
            text: "The deployment region is eu-west-1.",
        });

        expect(repeated).toEqual(first);
        expect(session.summary().status).toBe("idle");
        expect(session.activity().kind).toBe("idle");
        expect(session.state().queuedRuns).toEqual([]);
        expect(session.state().contextMessages).toEqual([]);
        expect(session.state().messages).toMatchObject([
            {
                message: {
                    contextOnly: true,
                    id: "context-note-1",
                    identity: null,
                    role: "user",
                },
                runId: "context:context-note-1",
            },
        ]);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "message_submitted"),
        ).toHaveLength(1);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toEqual([]);
    });

    it("persists human profile identity on submitted, steering, and context messages", async () => {
        const profileId = "aprofile000000000000000003";
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-profile-message" });

        await session.submit(ctx, { identity: profileId, text: "Run this remotely." });
        await session.steer(ctx, { identity: profileId, text: "And keep this attribution." });
        await session.submitContext(ctx, {
            identity: profileId,
            text: "This context has the same author.",
        });

        const identities = session.events
            .since(undefined)
            ?.filter((event) => event.type === "message_submitted")
            .map((event) => event.data.message.identity);
        expect(identities).toEqual([profileId, profileId, profileId]);
        await session.abort(ctx);
    });

    it("keeps visible-only restored errors out of persisted model context", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/visible-only-error",
            name: "Visible-only error model",
            thinkingLevels: ["off"],
        });
        const modelCatalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "codex",
            models: [model],
            providers: [{ providerId: "codex", models: [model] }],
        };
        const denial = {
            blocks: [{ text: "Automatic permission review refused deployment.", type: "text" }],
            context: "excluded",
            id: "visible-denial",
            outcome: "continued",
            role: "error",
        } as const;
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog,
            request: { cwd: "/tmp/rig-visible-only-error" },
            restore: {
                agent: {
                    depth: 0,
                    rootSessionId: "visible-only-session",
                    type: "primary",
                },
                agentId: "visible-only-agent",
                ownerInstanceId: "alocalinstance00000000001",
                cwd: "/tmp/rig-visible-only-error",
                id: "visible-only-session",
                messages: [{ isPartial: false, message: denial, position: 0, runId: "run-1" }],
                modelId: model.id,
                models: [model],
                nextTaskId: 1,
                orderKey: "a0",
                permissionMode: "auto",
                providerId: "codex",
                queuedRuns: [],
                scope: { kind: "project", projectId: "project-1" },
                status: "idle",
                tasks: [],
                titleStatus: "idle",
                tools: [],
            },
        });

        expect(session.state().messages[0]?.message).toEqual(denial);
        expect(session.state().contextMessages).toEqual([]);
    });

    it("rejects an unsupported queued effort before changing session state", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/queued-effort",
            name: "Queued effort model",
            thinkingLevels: ["off", "low"],
        });
        const session = await (
            await InMemorySessionStore.open(ctx, {
                modelCatalog: {
                    defaultModelId: model.id,
                    defaultProviderId: "codex",
                    models: [model],
                    providers: [{ providerId: "codex", models: [model] }],
                },
            })
        ).create(ctx, { cwd: "/tmp/rig-session-test" });

        await expect(
            session.submit(ctx, { effort: "high", text: "Do not queue this." }),
        ).rejects.toThrow("Model 'openai/queued-effort' does not support 'high' reasoning.");
        expect(session.state().messages).toEqual([]);
        expect(session.state().queuedRuns).toEqual([]);
    });

    it("does not retry a queue drain that failed before consuming its run", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/queue-drain-failure",
            name: "Queue drain failure model",
            thinkingLevels: ["off"],
        });
        const modelCatalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "test",
            models: [model],
            providers: [{ providerId: "test", models: [model] }],
        };
        const deleteQueuedRun = vi.fn(() => {
            throw new Error("queue persistence failed");
        });
        const persistence: InMemorySessionPersistence = {
            clearMessages: vi.fn(),
            deleteMessagesFrom: vi.fn(),
            deleteQueuedRun,
            insertQueuedRun: vi.fn(),
            saveSession: vi.fn(),
            upsertMessage: vi.fn(),
        };
        let drainRuns = 0;
        let firstDrain: Promise<unknown> | undefined;
        const taskDrain: TaskDrain = {
            beginClose() {},
            closing: false,
            async drain() {},
            run<T>(task: () => Promise<T>): Promise<T> {
                drainRuns += 1;
                if (drainRuns > 1) return new Promise<T>(() => undefined);
                const running = Promise.resolve().then(task);
                firstDrain = running;
                return running;
            },
        };
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            metadata: {
                depth: 1,
                description: "Exercise queue failure handling",
                parentSessionId: "parent-session",
                rootSessionId: "parent-session",
                type: "subagent",
            },
            modelCatalog,
            persistence,
            request: {
                cwd: "/tmp/rig-queue-drain-failure",
                modelId: model.id,
                providerId: "test",
            },
            taskDrain,
        });

        await expect(session.submit(ctx, { text: "Keep this queued." })).resolves.toMatchObject({
            runId: expect.any(String),
        });
        await vi.waitFor(() => expect(firstDrain).toBeDefined());
        await expect(firstDrain).rejects.toThrow("queue persistence failed");
        await Promise.resolve();

        expect(deleteQueuedRun).toHaveBeenCalledTimes(1);
        expect(drainRuns).toBe(1);
        expect(session.state().queuedRuns).toHaveLength(1);
    });

    it("keeps a subagent out of the ordered list whatever position it is handed", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/subagent-position",
            name: "Subagent position model",
            thinkingLevels: ["off"],
        });
        const modelCatalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "codex",
            models: [model],
            providers: [{ providerId: "codex", models: [model] }],
        };
        const metadata = {
            depth: 1,
            description: "Inspect the ordering",
            parentSessionId: "session-parent",
            rootSessionId: "session-parent",
            type: "subagent",
        } as const;

        const created = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            metadata,
            modelCatalog,
            orderKey: "a0",
            request: { cwd: "/tmp/rig-subagent-position" },
        });
        const restored = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog,
            request: { cwd: "/tmp/rig-subagent-position" },
            restore: {
                agent: metadata,
                agentId: "agent-2",
                ownerInstanceId: "alocalinstance00000000001",
                cwd: "/tmp/rig-subagent-position",
                id: "subagent-1",
                messages: [],
                modelId: model.id,
                models: [],
                nextTaskId: 1,
                orderKey: "a1",
                permissionMode: "workspace_write",
                providerId: "codex",
                queuedRuns: [],
                scope: { kind: "project", projectId: "project-1" },
                status: "completed",
                tasks: [],
                titleStatus: "idle",
                tools: [],
            },
        });

        for (const session of [created, restored]) {
            expect(session.snapshot().orderKey).toBeUndefined();
            expect(session.summary().orderKey).toBeUndefined();
            expect(session.state().orderKey).toBe("");
        }
    });

    it("treats repeated client submission IDs as one durable message", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });

        const first = await session.submit(ctx, {
            clientSubmissionId: "mobile-message-1",
            text: "Continue.",
        });
        const repeated = await session.submit(ctx, {
            clientSubmissionId: "mobile-message-1",
            text: "Continue.",
        });

        expect(repeated).toEqual(first);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "message_submitted"),
        ).toHaveLength(1);
        await session.abort(ctx);
    });

    it("persists direct shell results as pending model history without starting a run", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, {
            cwd: "/tmp/rig-session-test",
            permissionMode: "full_access",
        });

        const result = await session.runShellCommand(ctx, {
            command: "printf persisted-shell-output",
            commandId: "shell-command-1",
        });

        expect(result).toMatchObject({
            command: "printf persisted-shell-output",
            commandId: "shell-command-1",
        });
        await vi.waitFor(() => {
            expect(session.state().messages.at(-1)).toMatchObject({
                isPartial: false,
                message: {
                    blocks: [
                        {
                            text: expect.stringContaining("<user_shell_command>"),
                            type: "text",
                        },
                    ],
                    role: "user",
                },
                runId: "shell:shell-command-1",
            });
        });
        expect(session.snapshot().snapshot.queue.at(-1)?.message).toMatchObject({
            blocks: [{ text: expect.stringContaining("persisted-shell-output"), type: "text" }],
            role: "user",
        });
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(0);
    });

    it("queues steering as a new run when no run is active", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });

        const accepted = await session.steer(ctx, {
            clientSubmissionId: "queued-after-finish",
            expectedRunId: "finished-run",
            text: "Continue in a new turn.",
        });

        expect(accepted).toMatchObject({ delivery: "run" });
        expect(
            session.events.since(undefined)?.find((event) => event.id === accepted.eventId),
        ).toMatchObject({
            data: {
                delivery: "run",
                message: { id: "queued-after-finish" },
                runId: accepted.runId,
            },
            type: "message_submitted",
        });
    });

    it("keeps the original run delivery when retrying a committed submission through steering", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });
        const submitted = await session.submit(ctx, {
            clientSubmissionId: "committed-run",
            text: "Continue in a new turn.",
        });

        await expect(
            session.steer(ctx, {
                clientSubmissionId: "committed-run",
                expectedRunId: "finished-run",
                text: "Continue in a new turn.",
            }),
        ).resolves.toEqual({ ...submitted, delivery: "run" });
        expect(
            session.events
                .since(undefined)
                ?.filter(
                    (event) =>
                        event.type === "message_submitted" &&
                        event.data.message.id === "committed-run",
                ),
        ).toHaveLength(1);
    });

    it("wakes an idle session for a notification", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });

        const delivered = await session.deliverNotification(ctx, {
            displayText: "Background work finished.",
            text: "<subagent-notification>Done</subagent-notification>",
        });

        await vi.waitFor(() =>
            expect(
                session.events.since(undefined)?.filter((event) => event.type === "run_started"),
            ).toHaveLength(1),
        );
        expect(session.snapshot().snapshot).toMatchObject({
            messages: expect.arrayContaining([
                expect.objectContaining({
                    blocks: [
                        {
                            text: "Background work finished.",
                            type: "text",
                        },
                    ],
                    role: "user",
                }),
            ]),
        });
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(1);
        expect(
            session.events.since(undefined)?.find((event) => event.type === "message_submitted"),
        ).toMatchObject({ data: { source: "notification" } });
        expect((await delivered).runId).toBe(
            session.events.since(undefined)?.find((event) => event.type === "run_started")?.data
                .runId,
        );
        await session.abort(ctx);
    });

    it("wakes an idle session for an agent message", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });

        await session.deliverAgentMessage(ctx, {
            agentSource: {
                agentId: "sender-agent-id",
                sessionId: "sender-session-id",
                title: "Sender chat",
            },
            blocks: [{ text: "Wake up and handle this.", type: "text" }],
            id: "agent-message-1",
            provenance: "agent",
            role: "user",
        });

        await vi.waitFor(() =>
            expect(
                session.events.since(undefined)?.filter((event) => event.type === "run_started"),
            ).toHaveLength(1),
        );
        expect(
            session.events.since(undefined)?.find((event) => event.type === "message_submitted"),
        ).toMatchObject({
            data: {
                delivery: "run",
                message: {
                    agentSource: {
                        agentId: "sender-agent-id",
                        sessionId: "sender-session-id",
                        title: "Sender chat",
                    },
                    id: "agent-message-1",
                    provenance: "agent",
                },
            },
        });
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(1);
        await session.abort(ctx);
    });

    it("queues later notifications as steering on the run woken by the first", async () => {
        const { session, started } = createRunningNotificationSession();

        const first = await session.deliverNotification(ctx, {
            displayText: "First background agent finished.",
            text: "<subagent-notification>First</subagent-notification>",
        });
        await started;
        const second = await session.deliverNotification(ctx, {
            displayText: "Second background agent finished.",
            text: "<subagent-notification>Second</subagent-notification>",
        });

        expect(second).toMatchObject({ delivery: "steer" });
        expect(second.runId).toBe(first.runId);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(1);
        const snapshot = session.snapshot().snapshot;
        expect(snapshot.messages).toEqual([
            expect.objectContaining({
                blocks: [{ text: "First background agent finished.", type: "text" }],
            }),
        ]);
        await session.abort(ctx);
    });

    it("preserves the user-facing stop reason when workflow cancellation rejects", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });
        const run = session.launchWorkflow(ctx, {
            code: "42",
            description: "Wait for cancellation",
            execute: ({ signal }) =>
                new Promise<never>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("Internal cancellation detail.")),
                        { once: true },
                    );
                }),
            name: "cancellation-check",
        });

        expect(session.stopWorkflow(ctx, run.runId)).toMatchObject({
            error: "The workflow was stopped.",
            status: "stopped",
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(session.getWorkflow(run.runId)).toMatchObject({
            error: "The workflow was stopped.",
            status: "stopped",
        });
        await session.abort(ctx);
    });

    it("publishes live workflow phase, progress, and completion state", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });
        const run = session.launchWorkflow(ctx, {
            code: "42",
            description: "Inspect the workflow state",
            execute: async ({ onAgentCall, onLog }) => {
                onLog("Phase: Inspect");
                onAgentCall();
                onLog("Checked the target.");
                return { agentCalls: [], output: { checked: true } };
            },
            name: "state-check",
        });

        await new Promise((resolve) => setImmediate(resolve));

        expect(session.snapshot().workflows).toEqual([
            expect.objectContaining({
                agentCount: 1,
                description: "Inspect the workflow state",
                logs: ["Phase: Inspect", "Checked the target."],
                output: { checked: true },
                phase: "Inspect",
                runId: run.runId,
                status: "completed",
            }),
        ]);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "workflow_changed"),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    data: { update: expect.objectContaining({ status: "running" }) },
                }),
                expect.objectContaining({
                    data: {
                        update: expect.objectContaining({
                            output: { checked: true },
                            status: "completed",
                        }),
                    },
                }),
            ]),
        );
        await session.abort(ctx);
    });

    it("resumes unchanged workflow code from its latest Monty checkpoint", async () => {
        const session = await (
            await InMemorySessionStore.open(ctx)
        ).create(ctx, { cwd: "/tmp/rig-session-test" });
        const checkpoint = {
            nextAgentCallIndex: 1,
            phase: "Verify",
            snapshot: new Uint8Array([1, 2, 3]),
        };
        const cachedAgent = { output: "cached", signature: "cached-signature" };
        const interrupted = session.launchWorkflow(ctx, {
            code: 'agent("check")',
            description: "Checkpoint a workflow",
            execute: async ({ onAgentResult, onCheckpoint }) => {
                onAgentResult(0, cachedAgent);
                onCheckpoint(checkpoint);
                throw new Error("Simulated workflow interruption.");
            },
            name: "checkpointed-workflow",
        });
        await new Promise((resolve) => setImmediate(resolve));

        let receivedResumeCheckpoint: unknown;
        let receivedResumeAgentCalls: readonly unknown[] = [];
        session.launchWorkflow(ctx, {
            code: 'agent("check")',
            description: "Resume a workflow",
            execute: async (options) => {
                receivedResumeCheckpoint = options.resumeCheckpoint;
                receivedResumeAgentCalls = options.resumeAgentCalls;
                return { agentCalls: options.resumeAgentCalls, output: "resumed" };
            },
            name: "checkpointed-workflow",
            resumeFromRunId: interrupted.runId,
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(receivedResumeCheckpoint).toEqual(checkpoint);
        expect(receivedResumeAgentCalls).toEqual([cachedAgent]);
        await session.abort(ctx);
    });

    it("routes the same canonical model through the explicitly selected provider", async () => {
        const sharedModel = defineModel({
            defaultThinkingLevel: "medium",
            id: "openai/shared",
            name: "Shared model",
            thinkingLevels: ["medium"],
        });
        const bedrockOnlyModel = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/bedrock-only",
            name: "Bedrock-only model",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: sharedModel.id,
            defaultProviderId: "codex",
            models: [sharedModel, bedrockOnlyModel],
            providers: [
                { providerId: "codex", models: [sharedModel] },
                { providerId: "bedrock", models: [sharedModel, bedrockOnlyModel] },
            ],
        };
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
        });

        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: sharedModel.id,
            providerId: "bedrock",
        });

        expect(session.snapshot()).toMatchObject({
            modelId: sharedModel.id,
            models: [sharedModel, bedrockOnlyModel],
            providerId: "bedrock",
        });

        await session.changeModel(ctx, { modelId: sharedModel.id, providerId: "codex" });

        expect(session.snapshot()).toMatchObject({
            modelId: sharedModel.id,
            models: [sharedModel],
            providerId: "codex",
        });
        const latestEvent = session.events.since(undefined)?.at(-1);
        expect(latestEvent).toBeDefined();
        if (latestEvent === undefined) {
            throw new Error("Expected a model change event.");
        }
        expect(latestEvent).toMatchObject({
            data: {
                modelId: sharedModel.id,
                providerId: "codex",
            },
            type: "session_configuration_changed",
        });

        const inferredSession = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: bedrockOnlyModel.id,
        });
        expect(inferredSession.snapshot()).toMatchObject({
            modelId: bedrockOnlyModel.id,
            providerId: "bedrock",
        });
    });

    it("keeps fast inference across Codex model changes and rejects unsupported providers", async () => {
        const firstCodexModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/first",
            name: "First Codex model",
            thinkingLevels: ["off"],
        });
        const secondCodexModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/second",
            name: "Second Codex model",
            thinkingLevels: ["off"],
        });
        const claudeModel = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/test",
            name: "Claude model",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: firstCodexModel.id,
            defaultProviderId: "codex",
            models: [firstCodexModel, secondCodexModel, claudeModel],
            providers: [
                {
                    providerId: "codex",
                    providerType: "codex",
                    models: [firstCodexModel, secondCodexModel],
                    serviceTiers: ["fast"],
                },
                {
                    providerId: "claude",
                    providerType: "claude",
                    models: [claudeModel],
                },
            ],
        };
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
        });
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: firstCodexModel.id,
            providerId: "codex",
            serviceTier: "fast",
        });

        await session.changeModel(ctx, { modelId: secondCodexModel.id, providerId: "codex" });

        expect(session.snapshot()).toMatchObject({
            modelId: secondCodexModel.id,
            providerId: "codex",
            serviceTier: "fast",
            snapshot: { serviceTier: "fast" },
        });
        expect(session.snapshot().snapshot.contextMessages).toBeUndefined();
        expect(session.state().serviceTier).toBe("fast");

        await session.changeServiceTier(ctx, {});
        expect(session.snapshot().serviceTier).toBeUndefined();
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: { changed: ["serviceTier"], serviceTier: null },
            type: "session_configuration_changed",
        });

        await session.changeModel(ctx, { modelId: claudeModel.id, providerId: "claude" });
        expect(session.snapshot().snapshot.contextMessages).toBeUndefined();
        await expect(session.changeServiceTier(ctx, { serviceTier: "fast" })).rejects.toThrow(
            "does not support fast inference",
        );

        const unsupportedDefault = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: claudeModel.id,
            providerId: "claude",
            serviceTier: "fast",
        });
        expect(unsupportedDefault.snapshot().serviceTier).toBeUndefined();
    });

    it("carries a model, reasoning, and fast mode change on a message and reports them as one event", async () => {
        const { store, fastModel, slowModel } = await configurableCatalog();
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: slowModel.id,
            providerId: "codex",
        });

        await session.submit(ctx, {
            effort: "high",
            modelId: fastModel.id,
            serviceTier: "fast",
            text: "Use the other model.",
        });

        await vi.waitFor(() =>
            expect(session.snapshot()).toMatchObject({
                effort: "high",
                modelId: fastModel.id,
                serviceTier: "fast",
            }),
        );
        expect(session.snapshot()).toMatchObject({
            effort: "high",
            modelId: fastModel.id,
            serviceTier: "fast",
        });
        // Three settings moved together, so they are reported once rather than as three events a
        // reader would have to reassemble.
        const configurationEvents = session.events
            .since(undefined)
            ?.filter((event) => event.type === "session_configuration_changed");
        expect(configurationEvents).toHaveLength(1);
        expect(configurationEvents?.[0]).toMatchObject({
            data: {
                changed: ["model", "effort", "serviceTier"],
                effort: "high",
                modelId: fastModel.id,
                serviceTier: "fast",
            },
        });
    });

    it("does not report a configuration field a message left where it already was", async () => {
        const { store, fastModel } = await configurableCatalog();
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: fastModel.id,
            providerId: "codex",
        });

        const submitted = await session.submit(ctx, {
            effort: "high",
            modelId: fastModel.id,
            text: "Same model.",
        });
        await vi.waitFor(() =>
            expect(
                session.events
                    .since(undefined)
                    ?.filter((event) => event.type === "session_configuration_changed"),
            ).toHaveLength(1),
        );

        const configurationEvents = session.events
            .since(undefined)
            ?.filter((event) => event.type === "session_configuration_changed");
        expect(configurationEvents).toHaveLength(1);
        // The model was already selected, so only the reasoning level actually moved.
        expect(configurationEvents?.[0]).toMatchObject({ data: { changed: ["effort"] } });
    });

    it("rejects a message whose reasoning the model it also selects cannot do", async () => {
        const { store, fastModel, slowModel } = await configurableCatalog();
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: fastModel.id,
            providerId: "codex",
        });

        // "high" is valid for the currently selected model, so a check against the current model
        // rather than the requested one would let this through.
        await expect(
            session.submit(ctx, { effort: "high", modelId: slowModel.id, text: "Think hard." }),
        ).rejects.toThrow("does not support 'high' reasoning");
        await expect(
            session.submit(ctx, { effort: "nonsense", text: "Think hard." }),
        ).rejects.toThrow("does not support 'nonsense' reasoning");
    });

    it("validates reasoning against the model an earlier message switched to", async () => {
        const { store, fastModel, slowModel } = await configurableCatalog();
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: fastModel.id,
            providerId: "codex",
        });

        await session.submit(ctx, { modelId: slowModel.id, text: "Switch models." });
        // By the time this runs the session is on the model the queued message selected.
        await expect(session.submit(ctx, { effort: "high", text: "Think hard." })).rejects.toThrow(
            "does not support 'high' reasoning",
        );
    });

    it("lets a steer with nothing to interrupt carry configuration, because it is queued", async () => {
        const { store, fastModel, slowModel } = await configurableCatalog();
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: slowModel.id,
            providerId: "codex",
        });

        // With no run in flight a steer becomes an ordinary queued message, which is the only
        // delivery that may carry configuration.
        const queued = await session.steer(ctx, { modelId: fastModel.id, text: "Change it." });
        expect(queued.delivery).toBe("run");
        await vi.waitFor(() => expect(session.snapshot().modelId).toBe(fastModel.id));
        expect(session.snapshot().modelId).toBe(fastModel.id);
    });

    it("falls back when the configured model is no longer available", async () => {
        const availableModel = defineModel({
            defaultThinkingLevel: "medium",
            id: "openai/available",
            name: "Available model",
            thinkingLevels: ["off", "medium"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: availableModel.id,
            defaultProviderId: "codex",
            models: [availableModel],
            providers: [{ providerId: "codex", models: [availableModel] }],
        };
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
        });

        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            effort: "max",
            modelId: "removed/model",
            providerId: "bedrock",
        });

        expect(session.snapshot()).toMatchObject({
            effort: "medium",
            modelId: availableModel.id,
            models: [availableModel],
            providerId: "codex",
        });
    });

    it("keeps the requested model when another enabled provider serves it", async () => {
        const sharedModel = defineModel({
            defaultThinkingLevel: "medium",
            id: "openai/shared",
            name: "Shared model",
            thinkingLevels: ["medium"],
        });
        const fallbackModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/fallback",
            name: "Fallback model",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: fallbackModel.id,
            defaultProviderId: "codex",
            models: [fallbackModel, sharedModel],
            providers: [
                { providerId: "codex", models: [fallbackModel] },
                { providerId: "openai", models: [sharedModel] },
            ],
        };
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
        });

        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            modelId: sharedModel.id,
            providerId: "bedrock",
        });

        expect(session.snapshot()).toMatchObject({
            modelId: sharedModel.id,
            models: [sharedModel],
            providerId: "openai",
        });
    });

    it("changes permissions and passes them to subagents", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            permissionMode: "read_only",
        });

        expect(session.snapshot().permissionMode).toBe("read_only");
        expect(session.requestForSubagent().permissionMode).toBe("read_only");

        await session.changePermissionMode(ctx, { permissionMode: "full_access" });

        expect(session.snapshot().permissionMode).toBe("full_access");
        expect(session.requestForSubagent().permissionMode).toBe("full_access");
        expect(session.events.since(undefined)).toContainEqual(
            expect.objectContaining({
                data: { permissionMode: "full_access" },
                type: "permission_mode_changed",
            }),
        );
    });

    it("broadcasts a composer draft to attached clients and clears it", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-session-test" });
        const delivered: unknown[] = [];
        session.events.subscribe((event) => {
            if (event.type === "session_draft_changed") delivered.push(event.data);
        });

        expect(session.snapshot().draft).toBeUndefined();

        await session.setDraft(ctx, { draft: "Fix the flaky test", origin: "terminal-a" });
        expect(session.snapshot().draft).toBe("Fix the flaky test");
        expect(session.summary().draft).toBe("Fix the flaky test");
        expect(delivered).toEqual([
            { draft: "Fix the flaky test", origin: "terminal-a", updatedAt: expect.any(Number) },
        ]);

        // Rewriting the same draft is not a change worth broadcasting.
        await session.setDraft(ctx, { draft: "Fix the flaky test" });
        expect(delivered).toHaveLength(1);

        await session.setDraft(ctx, { draft: null });
        expect(session.snapshot().draft).toBeUndefined();
        expect(delivered).toEqual([
            { draft: "Fix the flaky test", origin: "terminal-a", updatedAt: expect.any(Number) },
            { updatedAt: expect.any(Number) },
        ]);
    });

    it("keeps the draft that was typed most recently, not the one that arrived last", async () => {
        const now = Date.now();
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-session-test" });
        const delivered: unknown[] = [];
        session.events.subscribe((event) => {
            if (event.type === "session_draft_changed") delivered.push(event.data);
        });

        await session.setDraft(ctx, {
            draft: "typed second",
            origin: "phone",
            updatedAt: now - 1_000,
        });
        expect(session.snapshot().draft).toBe("typed second");
        expect(session.snapshot().draftUpdatedAt).toBe(now - 1_000);

        // A slow client delivers a message that was typed earlier. It loses.
        await session.setDraft(ctx, {
            draft: "typed first",
            origin: "terminal-a",
            updatedAt: now - 5_000,
        });
        expect(session.snapshot().draft).toBe("typed second");
        expect(delivered).toHaveLength(1);

        // A message typed after the stored one replaces it.
        await session.setDraft(ctx, {
            draft: "typed third",
            origin: "terminal-a",
            updatedAt: now - 100,
        });
        expect(session.snapshot().draft).toBe("typed third");
        expect(delivered).toHaveLength(2);

        // A stale clear cannot wipe a newer draft either.
        await session.setDraft(ctx, { draft: null, origin: "phone", updatedAt: now - 4_000 });
        expect(session.snapshot().draft).toBe("typed third");
        expect(delivered).toHaveLength(2);
    });

    it("refuses to date a draft in the future or before the skew window", async () => {
        const store = await InMemorySessionStore.open(ctx);

        // A clock running fast cannot claim a draft from the future and win
        // against everything typed after it.
        const fast = await store.create(ctx, { cwd: "/tmp/rig-session-fast" });
        const beforeFast = Date.now();
        await fast.setDraft(ctx, { draft: "from a fast clock", updatedAt: beforeFast + 3_600_000 });
        expect(fast.snapshot().draftUpdatedAt).toBeGreaterThanOrEqual(beforeFast);
        expect(fast.snapshot().draftUpdatedAt).toBeLessThanOrEqual(Date.now());

        // A clock far in the past is held at the edge of the skew window, so it
        // loses to recent drafts instead of being unable to win at all.
        const slow = await store.create(ctx, { cwd: "/tmp/rig-session-slow" });
        const beforeSlow = Date.now();
        await slow.setDraft(ctx, { draft: "from a slow clock", updatedAt: 0 });
        expect(slow.snapshot().draftUpdatedAt).toBeGreaterThanOrEqual(beforeSlow - 300_000);
        expect(slow.snapshot().draftUpdatedAt).toBeLessThanOrEqual(Date.now() - 300_000);
    });

    it("keeps drafts out of the durable event log", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-session-test" });

        await session.setDraft(ctx, { draft: "Typed but never sent" });

        // The latest draft lives on the session itself, so a reconnecting client
        // reads it from the snapshot instead of replaying every keystroke burst.
        expect(
            session.events
                .since(undefined)
                ?.some((event) => event.type === "session_draft_changed"),
        ).toBe(false);
    });

    it("treats an empty draft as no draft", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-session-test" });

        await session.setDraft(ctx, { draft: "" });

        expect(session.snapshot().draft).toBeUndefined();
    });

    it("refuses a draft that is too long to sync", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-session-test" });

        await expect(session.setDraft(ctx, { draft: "x".repeat(100_001) })).rejects.toThrow(
            "The draft is too long to sync.",
        );
        expect(session.snapshot().draft).toBeUndefined();
    });

    it("restores a draft and its event history when draft persistence rejects", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/draft-persistence-rejection",
            name: "Draft persistence rejection",
            thinkingLevels: ["off"],
        });
        const failure = new Error("draft persistence failed");
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "test",
                models: [model],
                providers: [{ models: [model], providerId: "test" }],
            },
            onAppendEvent: (_ctx, event) => {
                if (event.type === "session_draft_changed") throw failure;
            },
            request: { cwd: "/tmp/rig-draft-persistence-rejection", modelId: model.id },
        });
        await session.ready();
        const beforeEvents = [...session.events.all()];

        await expect(session.setDraft(ctx, { draft: "never durable" })).rejects.toBe(failure);

        expect(session.snapshot().draft).toBeUndefined();
        expect(session.snapshot().draftUpdatedAt).toBeUndefined();
        expect(session.events.all()).toEqual(beforeEvents);
    });

    it("does not roll back a successful draft mutation when a later concurrent one rejects", async () => {
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstPersistence = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const failure = new Error("second draft persistence failed");
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/concurrent-draft-persistence-rejection",
            name: "Concurrent draft persistence rejection",
            thinkingLevels: ["off"],
        });
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "test",
                models: [model],
                providers: [{ models: [model], providerId: "test" }],
            },
            onAppendEvent: async (_ctx, event) => {
                if (event.type !== "session_draft_changed") return;
                if (event.data.draft === "first") {
                    markFirstStarted();
                    await firstPersistence;
                } else if (event.data.draft === "second") {
                    throw failure;
                }
            },
            request: { cwd: "/tmp/rig-concurrent-draft-persistence-rejection", modelId: model.id },
        });
        await session.ready();

        const first = session.setDraft(ctx, { draft: "first" });
        await firstStarted;
        const second = session.setDraft(ctx, { draft: "second" });
        releaseFirst();

        await expect(first).resolves.toMatchObject({ draft: "first" });
        await expect(second).rejects.toBe(failure);
        expect(session.snapshot().draft).toBe("first");
    });

    it("restores event history and projections when saving an appended event rejects", async () => {
        let rejectSave = false;
        const failure = new Error("event snapshot failed");
        const saveSession = vi.fn(async () => {
            if (rejectSave) throw failure;
        });
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/event-persistence-rejection",
            name: "Event persistence rejection",
            thinkingLevels: ["off"],
        });
        const session = await InMemorySession.open(ctx, {
            createEventId: createEventIdFactory(),
            emitCreatedEvent: false,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "test",
                models: [model],
                providers: [{ models: [model], providerId: "test" }],
            },
            persistence: { saveSession } as unknown as InMemorySessionPersistence,
            request: { cwd: "/tmp/rig-event-persistence-rejection", modelId: model.id },
        });
        const beforeEvents = [...session.events.all()];
        const beforeTokenCount = session.snapshot().sessionTokenCount;
        rejectSave = true;

        await expect(session.emitCreatedEvent(ctx)).rejects.toBe(failure);

        expect(session.events.all()).toEqual(beforeEvents);
        expect(session.snapshot().lastEventId).toBeUndefined();
        expect(session.snapshot().sessionTokenCount).toEqual(beforeTokenCount);
    });

    it("keeps unread state when marking the session read fails to persist", async () => {
        const failure = Object.assign(new Error("mark read persistence failed"), {
            code: "SQLITE_IOERR",
        });
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/mark-read-persistence-rejection",
            name: "Mark read persistence rejection",
            thinkingLevels: ["off"],
        });
        const unread = { reason: "attention_needed" as const, since: 123 };
        const request = {
            cwd: "/tmp/rig-mark-read-persistence-rejection",
            modelId: model.id,
            trackUnread: true,
        };
        const seed = await InMemorySession.open(ctx, {
            createEventId: createEventIdFactory(),
            emitCreatedEvent: false,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "test",
                models: [model],
                providers: [{ models: [model], providerId: "test" }],
            },
            request,
        });
        const session = await InMemorySession.open(ctx, {
            createEventId: createEventIdFactory(),
            emitCreatedEvent: false,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "test",
                models: [model],
                providers: [{ models: [model], providerId: "test" }],
            },
            onAppendEvent: (_ctx, event) => {
                if (event.type === "session_updated") throw failure;
            },
            request,
            restore: { ...seed.state(), unread },
        });
        const beforeEvents = [...session.events.all()];

        await expect(session.markRead(ctx)).rejects.toBe(failure);

        expect(session.snapshot().unread).toEqual(unread);
        expect(session.events.all()).toEqual(beforeEvents);
    });

    it("keeps a committed event after a post-commit callback rejects", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        const failure = new Error("post-commit publication failed");
        const saveSession = vi.fn(async () => undefined);
        const persistence = {
            saveSession,
            transaction: <T>(_ctx: Context, body: (bodyCtx: Context) => T | Promise<T>) =>
                runSessionTransaction(opened.ctx, async (transactionCtx) => {
                    const result = await body(transactionCtx);
                    await deferSessionTransactionCommit(() => {
                        throw failure;
                    });
                    return result;
                }),
        } as unknown as InMemorySessionPersistence;
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/post-commit-publication-rejection",
            name: "Post-commit publication rejection",
            thinkingLevels: ["off"],
        });
        try {
            const session = await InMemorySession.open(ctx, {
                createEventId: createEventIdFactory(),
                emitCreatedEvent: false,
                modelCatalog: {
                    defaultModelId: model.id,
                    defaultProviderId: "test",
                    models: [model],
                    providers: [{ models: [model], providerId: "test" }],
                },
                persistence,
                request: { cwd: "/tmp/rig-post-commit-publication-rejection", modelId: model.id },
            });

            await expect(session.emitCreatedEvent(ctx)).rejects.toMatchObject({
                cause: failure,
                name: "SessionTransactionPostCommitError",
            });

            expect(session.events.all()).toHaveLength(1);
            expect(session.snapshot().lastEventId).toBe(session.events.lastEventId());
            expect(saveSession).toHaveBeenCalled();
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("releases each session mutation lock before cross-session post-commit observers run", async () => {
        const spans = spanLifecycleTracer();
        const opened = await openSessionDatabase(createTestRootContext(spans.tracer), ":memory:");
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/cross-session-post-commit",
            name: "Cross-session post commit",
            thinkingLevels: ["off"],
        });
        const modelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "test",
            models: [model],
            providers: [{ models: [model], providerId: "test" }],
        } satisfies ModelCatalog;
        const persistence = {
            saveSession: async () => undefined,
            transaction: <T>(_ctx: Context, body: (bodyCtx: Context) => T | Promise<T>) =>
                runSessionTransaction(opened.ctx, body),
        } as unknown as InMemorySessionPersistence;
        let left!: InMemorySession;
        let right!: InMemorySession;

        try {
            left = await InMemorySession.open(opened.ctx, {
                createEventId: createEventIdFactory(),
                emitCreatedEvent: false,
                modelCatalog,
                onAppendEvent: async (_eventCtx, event) => {
                    if (event.type !== "session_created") return;
                    await deferSessionTransactionCommit(async () => {
                        await right.setDraft(opened.ctx, { draft: "written by left" });
                    });
                },
                persistence,
                request: { cwd: "/tmp/rig-cross-session-left", modelId: model.id },
            });
            right = await InMemorySession.open(opened.ctx, {
                createEventId: createEventIdFactory(),
                emitCreatedEvent: false,
                modelCatalog,
                onAppendEvent: async (_eventCtx, event) => {
                    if (
                        event.type !== "session_draft_changed" ||
                        event.data.draft !== "written by left"
                    ) {
                        return;
                    }
                    await deferSessionTransactionCommit(async () => {
                        await left.setDraft(opened.ctx, { draft: "written by right" });
                    });
                },
                persistence,
                request: { cwd: "/tmp/rig-cross-session-right", modelId: model.id },
            });

            await expect(
                completesBeforeLockWait(left.emitCreatedEvent(opened.ctx), spans.active),
            ).resolves.toBeUndefined();
            expect(left.snapshot().draft).toBe("written by right");
            expect(right.snapshot().draft).toBe("written by left");
            expect(spans.started().filter((name) => name === "asyncLock.wait")).toEqual([]);
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("holds a structured question until the user answers it", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-session-test" });
        const request = {
            requestId: "question-1",
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [
                        { label: "PostgreSQL", description: "Use a server database." },
                        { label: "SQLite", description: "Use a local database." },
                    ],
                    question: "Which database should be used?",
                },
            ],
        };

        const pending = session.requestUserInput(ctx, request);

        await vi.waitFor(() => expect(session.snapshot().pendingUserInputs).toEqual([request]));
        expect(session.snapshot().pendingUserInputs).toEqual([request]);
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: request,
            type: "user_input_requested",
        });

        await session.answerUserInput(ctx, "question-1", { answers: { database: ["PostgreSQL"] } });

        await expect(pending).resolves.toEqual({
            status: "answered",
            answers: { database: ["PostgreSQL"] },
        });
        expect(session.snapshot().pendingUserInputs).toEqual([]);
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: {
                answers: { database: ["PostgreSQL"] },
                requestId: "question-1",
                status: "answered",
            },
            type: "user_input_resolved",
        });
    });

    it("tracks unread attention only when the root session opts in", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, {
            cwd: "/tmp/rig-session-test",
            trackUnread: true,
        });
        const request = {
            requestId: "question-unread",
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [
                        { label: "PostgreSQL", description: "Use a server database." },
                        { label: "SQLite", description: "Use a local database." },
                    ],
                    question: "Which database should be used?",
                },
            ],
        };

        const pending = session.requestUserInput(ctx, request);

        await vi.waitFor(() =>
            expect(session.snapshot()).toMatchObject({
                trackUnread: true,
                unread: { reason: "attention_needed" },
            }),
        );
        expect(session.snapshot()).toMatchObject({
            trackUnread: true,
            unread: { reason: "attention_needed" },
        });
        await expect(session.markRead(ctx)).resolves.toBe(true);
        expect(session.snapshot().unread).toBeUndefined();
        await expect(session.markRead(ctx)).resolves.toBe(false);

        await session.answerUserInput(ctx, "question-unread", {
            answers: { database: ["SQLite"] },
        });
        await expect(pending).resolves.toEqual({
            status: "answered",
            answers: { database: ["SQLite"] },
        });

        const untracked = await store.create(ctx, { cwd: "/tmp/rig-session-test" });
        const untrackedPending = untracked.requestUserInput(ctx, {
            ...request,
            requestId: "question-untracked",
        });
        await vi.waitFor(() =>
            expect(untracked.snapshot().pendingUserInputs).toEqual([
                expect.objectContaining({ requestId: "question-untracked" }),
            ]),
        );
        expect(untracked.snapshot().trackUnread).toBe(false);
        expect(untracked.snapshot().unread).toBeUndefined();
        await untracked.answerUserInput(ctx, "question-untracked", {
            answers: { database: ["PostgreSQL"] },
        });
        await untrackedPending;
    });

    it("cancels a pending question when its run is aborted", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-session-test" });
        const controller = new AbortController();
        const pending = session.requestUserInput(
            ctx,
            {
                requestId: "question-1",
                questions: [
                    {
                        header: "Choice",
                        id: "choice",
                        multiSelect: false,
                        options: [
                            { label: "One", description: "Choose one." },
                            { label: "Two", description: "Choose two." },
                        ],
                        question: "Which choice should be used?",
                    },
                ],
            },
            { signal: controller.signal },
        );

        controller.abort(ctx);

        await expect(pending).rejects.toThrow("cancelled");
        expect(session.snapshot().pendingUserInputs).toEqual([]);
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: { requestId: "question-1", status: "cancelled" },
            type: "user_input_resolved",
        });
    });
});

/** Two models on one provider that differ in the reasoning levels they accept. */
async function configurableCatalog() {
    const slowModel = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/slow",
        name: "Slow model",
        thinkingLevels: ["off"],
    });
    const fastModel = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/fast",
        name: "Fast model",
        thinkingLevels: ["off", "high"],
    });
    const catalog: ModelCatalog = {
        defaultModelId: slowModel.id,
        defaultProviderId: "codex",
        models: [slowModel, fastModel],
        providers: [
            {
                providerId: "codex",
                providerType: "codex",
                models: [slowModel, fastModel],
                serviceTiers: ["fast"],
            },
        ],
    };
    return {
        fastModel,
        slowModel,
        store: await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
        }),
    };
}

function createRunningNotificationSession(): {
    session: InMemorySession;
    started: Promise<void>;
} {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/notification-steering",
        name: "Notification steering",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream(_ctx, _model, _context, options) {
            return abortableNotificationStream(options?.signal, markStarted);
        },
    });
    return {
        session: new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            createRuntime: (options) => createTestRuntime(options, provider),
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: provider.id,
                models: [model],
                providers: [{ models: [model], providerId: provider.id }],
            },
            request: {
                cwd: "/tmp/rig-notification-steering",
                modelId: model.id,
                providerId: provider.id,
            },
        }),
        started,
    };
}

function createTestRuntime(
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
            tools: [],
        }),
        context,
        cwd: options.cwd,
        executor: provider,
        processManager,
    };
}

function abortableNotificationStream(
    signal: AbortSignal | undefined,
    onStart: () => void,
): InferenceStream {
    return {
        // eslint-disable-next-line require-yield -- This fixture waits for abort without content.
        async *[Symbol.asyncIterator]() {
            onStart();
            await new Promise<void>((resolve) => {
                if (signal?.aborted === true) {
                    resolve();
                    return;
                }
                signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("aborted");
        },
        async result() {
            throw new Error("aborted");
        },
    };
}

function spanLifecycleTracer(): {
    active(): string[];
    started(): string[];
    tracer: Tracer;
} {
    const active = new Map<string, number>();
    const started: string[] = [];
    return {
        active: () =>
            [...active].flatMap(([name, count]) => Array.from({ length: count }, () => name)),
        started: () => [...started],
        tracer: {
            startSpan: (name: string) => {
                started.push(name);
                active.set(name, (active.get(name) ?? 0) + 1);
                return {
                    end: () => {
                        const remaining = (active.get(name) ?? 1) - 1;
                        if (remaining === 0) active.delete(name);
                        else active.set(name, remaining);
                    },
                    recordException: () => undefined,
                    setStatus: () => undefined,
                } as unknown as Span;
            },
        } as Tracer,
    };
}

async function completesBeforeLockWait(
    operation: Promise<unknown>,
    activeSpans: () => string[],
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(
                        new Error(
                            `Session mutation timed out; active spans: ${activeSpans().join(", ")}`,
                        ),
                    );
                }, 250);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
