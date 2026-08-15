import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import { defineModel, defineProvider } from "@slopus/rig-execution";
import type { Message } from "../../agent/types.js";
import type { AgentSessionManager } from "../AgentSessionManager.js";
import { InMemorySession } from "../InMemorySession.js";

/**
 * Configuration a message carries applies when that message's run starts. While a run is already
 * in flight the later messages stay queued, which is the only state where a queued change is
 * visible as pending rather than already applied.
 */
describe("InMemorySession queued configuration", () => {
    it("discards a cached inference runtime when its credential scope refreshes", async () => {
        const { capableModel, catalog } = testModels();
        const events: unknown[] = [];
        const runtimes: CodingAssistantRuntime[] = [];
        const provider = defineProvider({
            id: "test",
            models: [capableModel],
            stream() {
                throw new Error("This test only creates runtimes.");
            },
        });
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            createRuntime: (options) => {
                const runtime = createRuntime(options, provider);
                runtimes.push(runtime);
                return runtime;
            },
            modelCatalog: {
                ...catalog,
                models: [capableModel],
                providers: [{ models: [capableModel], providerId: "test" }],
            },
            onAppendEvent(_ctx, event) {
                events.push(event);
            },
            request: { cwd: "/tmp/rig-inference-scope-refresh" },
        });

        const firstContext = await runtimeContext(session);
        const close = vi.spyOn(runtimes[0]!.agent, "close");

        await session.refreshInferenceScope(ctx, {
            defaultModelId: capableModel.id,
            defaultProviderId: "test",
            models: [capableModel, catalog.models[1]!],
            providers: [
                { models: [capableModel], providerId: "test" },
                { models: [catalog.models[1]!], providerId: "extra" },
            ],
        });

        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(await runtimeContext(session)).not.toBe(firstContext);
        expect(runtimes).toHaveLength(2);
        expect(runtimes[1]).not.toBe(runtimes[0]);
        await vi.waitFor(() =>
            expect(events).toContainEqual(
                expect.objectContaining({
                    data: expect.objectContaining({
                        session: expect.objectContaining({
                            modelCatalog: expect.objectContaining({
                                providers: [
                                    expect.objectContaining({ providerId: "test" }),
                                    expect.objectContaining({ providerId: "extra" }),
                                ],
                            }),
                        }),
                    }),
                    type: "session_updated",
                }),
            ),
        );
        await session.beginShutdown(ctx);
    });

    it("aborts active inference before retiring a rotated credential runtime", async () => {
        const runtimes: CodingAssistantRuntime[] = [];
        const { catalog } = testModels();
        const { release, session, started } = runningSession({
            onRuntime(runtime) {
                runtimes.push(runtime);
            },
        });
        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;
        const close = vi.spyOn(runtimes[0]!.agent, "close");
        expect(session.snapshot().status).toBe("running");

        session.refreshInferenceScope(ctx, structuredClone(catalog));

        expect(close).not.toHaveBeenCalled();

        await vi.waitFor(() => {
            expect(close).toHaveBeenCalledOnce();
            expect(session.events.since(undefined)).toContainEqual(
                expect.objectContaining({
                    data: expect.objectContaining({ stopReason: "aborted" }),
                    type: "run_finished",
                }),
            );
        });
        expect(runtimes).toHaveLength(1);
        expect(session.snapshot().status).toBe("aborted");
        release.resolve();
        await session.beginShutdown(ctx);
    });

    it("falls back durably when a credential refresh removes the selected provider", async () => {
        const { capableModel, limitedModel } = testModels();
        const events: unknown[] = [];
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog: {
                defaultModelId: capableModel.id,
                defaultProviderId: "capable",
                models: [capableModel, limitedModel],
                providers: [
                    { models: [capableModel], providerId: "capable" },
                    { models: [limitedModel], providerId: "removed" },
                ],
            },
            onAppendEvent(_ctx, event) {
                events.push(event);
            },
            request: {
                cwd: "/tmp/rig-inference-scope-fallback",
                modelId: limitedModel.id,
                providerId: "removed",
            },
        });

        await session.refreshInferenceScope(ctx, {
            defaultModelId: capableModel.id,
            defaultProviderId: "capable",
            models: [capableModel],
            providers: [{ models: [capableModel], providerId: "capable" }],
        });

        expect(session.snapshot()).toMatchObject({
            modelId: capableModel.id,
            providerId: "capable",
        });
        await vi.waitFor(() =>
            expect(events).toContainEqual(
                expect.objectContaining({
                    data: expect.objectContaining({
                        changed: ["model"],
                        modelId: capableModel.id,
                        providerId: "capable",
                    }),
                    type: "session_configuration_changed",
                }),
            ),
        );
        await session.beginShutdown(ctx);
    });

    it("keeps the persisted credential binding when an owner ID collides with an extra", async () => {
        const { capableModel } = testModels();
        const ownerInstanceId = "aownerinstance00000000001";
        const extraOwnerInstanceId = "aextrainstance00000000001";
        const extraProviderId = `codex@${extraOwnerInstanceId}`;
        const credential = (
            bindingId: string,
            credentialOwnerInstanceId: string,
            sourceProviderId: string,
            relation: "owner" | "extra",
        ) => ({
            bindingId,
            ownerInstanceId: credentialOwnerInstanceId,
            ownerName: credentialOwnerInstanceId,
            relation,
            sourceProviderId,
            visibility: "shared" as const,
        });
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog: {
                defaultModelId: capableModel.id,
                defaultProviderId: extraProviderId,
                models: [capableModel],
                providers: [
                    {
                        credential: credential(
                            `${extraOwnerInstanceId}:codex`,
                            extraOwnerInstanceId,
                            "codex",
                            "extra",
                        ),
                        models: [capableModel],
                        providerId: extraProviderId,
                    },
                ],
            },
            ownerInstanceId,
            request: {
                cwd: "/tmp/rig-inference-binding-collision",
                modelId: capableModel.id,
                providerId: extraProviderId,
            },
        });

        const collidingCatalog: ModelCatalog = {
            defaultModelId: capableModel.id,
            defaultProviderId: extraProviderId,
            models: [capableModel],
            providers: [
                {
                    credential: credential(
                        `${ownerInstanceId}:${extraProviderId}`,
                        ownerInstanceId,
                        extraProviderId,
                        "owner",
                    ),
                    models: [capableModel],
                    providerId: extraProviderId,
                },
                {
                    credential: credential(
                        `${extraOwnerInstanceId}:codex`,
                        extraOwnerInstanceId,
                        "codex",
                        "extra",
                    ),
                    models: [capableModel],
                    providerId: `${extraProviderId}-2`,
                },
            ],
        };
        const savedBeforeCollision = session.state();
        session.refreshInferenceScope(ctx, collidingCatalog);

        expect(session.snapshot().providerId).toBe(`${extraProviderId}-2`);
        expect(session.state().credentialBindingId).toBe(`${extraOwnerInstanceId}:codex`);

        const restored = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog: collidingCatalog,
            request: { cwd: "/tmp/rig-inference-binding-collision" },
            restore: savedBeforeCollision,
        });
        expect(restored.snapshot().providerId).toBe(`${extraProviderId}-2`);
    });

    it("publishes a reduced permission mode before awaiting process shutdown", async () => {
        const processManager = new NativeProcessManager();
        let runtime: CodingAssistantRuntime | undefined;
        let modeWhenKilled: string | undefined;
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        vi.spyOn(processManager, "killAll").mockImplementation(async () => {
            modeWhenKilled = runtime?.context.permissions?.mode;
        });
        const { session, started, release } = runningSession({
            onRuntime(created) {
                runtime = created;
            },
            processManager,
        });
        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;

        await session.changePermissionMode(ctx, { permissionMode: "read_only" });

        expect(modeWhenKilled).toBe("read_only");
        release.resolve();
        await session.beginShutdown(ctx);
    });

    it("starts descendant permission reduction before root process shutdown settles", async () => {
        const processManager = new NativeProcessManager();
        const killStarted = deferred<void>();
        const releaseKill = deferred<void>();
        const changeSubagentPermissionModes = vi.fn(async () => {});
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        vi.spyOn(processManager, "killAll").mockImplementation(async () => {
            killStarted.resolve();
            await releaseKill.promise;
        });
        const { session, started, release } = runningSession({
            agentManager: {
                changeSubagentPermissionModes,
                communicationContext: vi.fn(),
            } as unknown as AgentSessionManager,
            processManager,
        });
        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;

        const changing = session.changePermissionMode(ctx, { permissionMode: "read_only" });
        await killStarted.promise;

        expect(changeSubagentPermissionModes).toHaveBeenCalledWith(ctx, session.id, "read_only");
        releaseKill.resolve();
        await changing;
        release.resolve();
        await session.beginShutdown(ctx);
    });

    it("does not promote independently restricted descendants when the root mode increases", async () => {
        const changeSubagentPermissionModes = vi.fn(async () => {});
        const { session } = runningSession({
            agentManager: {
                changeSubagentPermissionModes,
                communicationContext: vi.fn(),
            } as unknown as AgentSessionManager,
        });

        await session.changePermissionMode(ctx, { permissionMode: "read_only" });
        await session.changePermissionMode(ctx, { permissionMode: "auto" });

        expect(changeSubagentPermissionModes).toHaveBeenCalledOnce();
        expect(changeSubagentPermissionModes).toHaveBeenCalledWith(ctx, session.id, "read_only");
        await session.beginShutdown(ctx);
    });

    it("waits for local shutdown when descendant permission propagation fails", async () => {
        const processManager = new NativeProcessManager();
        const killStarted = deferred<void>();
        const releaseKill = deferred<void>();
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        vi.spyOn(processManager, "killAll").mockImplementation(async () => {
            killStarted.resolve();
            await releaseKill.promise;
        });
        const { session, started, release } = runningSession({
            agentManager: {
                changeSubagentPermissionModes: vi.fn(async () => {
                    throw new Error("descendant propagation failed");
                }),
                communicationContext: vi.fn(),
            } as unknown as AgentSessionManager,
            processManager,
        });
        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;

        const changing = session.changePermissionMode(ctx, { permissionMode: "read_only" });
        let settled = false;
        void changing.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await killStarted.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(settled).toBe(false);
        releaseKill.resolve();
        await expect(changing).rejects.toThrow("descendant propagation failed");
        release.resolve();
        await session.beginShutdown(ctx);
    });

    it("keeps a reduced permission mode durable when process shutdown fails", async () => {
        const processManager = new NativeProcessManager();
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        vi.spyOn(processManager, "killAll").mockRejectedValueOnce(
            new Error("could not stop process"),
        );
        const { session, started, release } = runningSession({ processManager });
        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;

        await expect(
            session.changePermissionMode(ctx, { permissionMode: "read_only" }),
        ).rejects.toThrow("could not stop process");

        expect(session.snapshot().permissionMode).toBe("read_only");
        expect(session.events.since(undefined)).toContainEqual(
            expect.objectContaining({
                data: { permissionMode: "read_only" },
                type: "permission_mode_changed",
            }),
        );
        release.resolve();
        await session.beginShutdown(ctx);
    });

    it("fails closed when a permission reduction cannot be made durable", async () => {
        let runtime: CodingAssistantRuntime | undefined;
        const processManager = new NativeProcessManager();
        const killAll = vi.spyOn(processManager, "killAll").mockResolvedValue();
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        const { session, started, release } = runningSession({
            onAppendEvent(_ctx, event) {
                if (event.type === "permission_mode_changed") {
                    throw new Error("could not persist permission mode");
                }
            },
            onRuntime(created) {
                runtime = created;
            },
            processManager,
        });
        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;

        const changing = session.changePermissionMode(ctx, { permissionMode: "read_only" });
        release.resolve();
        await expect(changing).rejects.toThrow("could not persist permission mode");

        expect(session.snapshot().permissionMode).toBe("read_only");
        expect(runtime?.context.permissions?.mode).toBe("read_only");
        expect(killAll).toHaveBeenCalled();
        expect(session.isClosing()).toBe(true);
    });

    it("validates reasoning against a model an earlier queued message has not applied yet", async () => {
        const { session, started, release } = runningSession();

        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;

        // This one cannot start yet, so its model is still only a pending intent.
        await session.submit(ctx, { modelId: "test/limited", text: "Switch models." });
        expect(session.state().queuedRuns).toHaveLength(1);

        // "high" suits the model selected right now, so validating against that model instead of
        // the one already queued would wrongly accept this.
        await expect(session.submit(ctx, { effort: "high", text: "Think hard." })).rejects.toThrow(
            "Model 'test/limited' does not support 'high' reasoning.",
        );

        release.resolve();
        await session.beginShutdown(ctx);
    });

    it("refuses to change the configuration by steering a running response", async () => {
        const { session, started, release } = runningSession();

        await session.submit(ctx, { text: "Start a long run." });
        await started.promise;

        // Steering reaches the model mid-run, which is exactly where a configuration change must
        // not land. The presence of the field is what is refused, whatever its value.
        for (const change of [
            { effort: "off" },
            { modelId: "test/limited" },
            { serviceTier: "fast" as const },
            // Even a value the session already holds, so the rule cannot depend on current state.
            { modelId: "test/capable" },
        ]) {
            await expect(session.steer(ctx, { ...change, text: "Change it." })).rejects.toThrow(
                "can only be changed by submitting a message",
            );
        }

        release.resolve();
        await session.beginShutdown(ctx);
    });

    it("does not resend a message that a cross-provider switch already excluded from history", async () => {
        const codexModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/codex",
            name: "Codex model",
            thinkingLevels: ["off"],
        });
        const claudeModel = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/claude",
            name: "Claude model",
            thinkingLevels: ["off"],
        });
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog: {
                defaultModelId: codexModel.id,
                defaultProviderId: "codex",
                models: [codexModel, claudeModel],
                providers: [
                    { models: [codexModel], providerId: "codex", providerType: "codex" },
                    { models: [claudeModel], providerId: "claude", providerType: "claude" },
                ],
            },
            request: { cwd: "/tmp/rig-queued-configuration", modelId: codexModel.id },
        });

        await session.submit(ctx, {
            modelId: claudeModel.id,
            providerId: "claude",
            text: "Only message.",
        });

        // The switch summarized an empty history, so the context is empty rather than absent.
        // Absent would mean "the context is the visible transcript", which still holds this
        // message, and the run would then send it a second time.
        expect(session.snapshot().snapshot.contextMessages).toEqual([]);
    });

    it("keeps compatible fork checkpoints and normalizes incompatible ones", async () => {
        const codexModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/codex",
            name: "Codex model",
            thinkingLevels: ["off"],
        });
        const claudeModel = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/claude",
            name: "Claude model",
            thinkingLevels: ["off"],
        });
        const modelCatalog: ModelCatalog = {
            defaultModelId: codexModel.id,
            defaultProviderId: "codex",
            models: [codexModel, claudeModel],
            providers: [
                { models: [codexModel], providerId: "codex", providerType: "codex" },
                { models: [claudeModel], providerId: "claude", providerType: "claude" },
            ],
        };
        const durableMessage: Message = {
            blocks: [{ type: "text", text: "OLDER_DURABLE_PARENT_HISTORY" }],
            id: "durable-parent-message",
            role: "user",
        };
        const latestMessage: Message = {
            blocks: [{ type: "text", text: "LATEST_SELECTED_PARENT_TURN" }],
            id: "latest-parent-message",
            role: "user",
        };
        const currentSpawnMessage: Message = {
            blocks: [
                {
                    arguments: { message: "CURRENT_SPAWN_CALL" },
                    id: "current-spawn-call",
                    name: "spawn_agent",
                    type: "tool_call",
                },
            ],
            id: "current-spawn-message",
            role: "agent",
        };
        const opaqueCheckpoint: Message = {
            blocks: [],
            id: "codex-checkpoint",
            providerId: "codex",
            replacedMessageIds: [durableMessage.id, latestMessage.id],
            replacementMessages: [
                {
                    role: "compaction",
                    content: null,
                    encryptedContent: "SOURCE_PROVIDER_OPAQUE_CHECKPOINT",
                    timestamp: 1,
                },
            ],
            role: "compaction",
            statistics: {
                after: { exact: true, tokens: 100 },
                before: { exact: true, tokens: 1_000 },
            },
        };
        const canonicalContext = [opaqueCheckpoint];
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            modelCatalog,
            request: {
                cwd: "/tmp/rig-subagent-context",
                modelId: codexModel.id,
                providerId: "codex",
            },
            restore: {
                agent: {
                    depth: 0,
                    rootSessionId: "parent-session",
                    type: "primary",
                },
                agentId: "parent-agent",
                ownerInstanceId: "alocalinstance00000000001",
                cwd: "/tmp/rig-subagent-context",
                id: "parent-session",
                messages: [
                    {
                        isPartial: false,
                        message: durableMessage,
                        position: 0,
                        runId: "parent-run",
                    },
                    {
                        isPartial: false,
                        message: latestMessage,
                        position: 1,
                        runId: "parent-run",
                    },
                    {
                        isPartial: false,
                        message: currentSpawnMessage,
                        position: 2,
                        runId: "parent-run",
                    },
                ],
                modelId: codexModel.id,
                models: [codexModel],
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

        expect(
            session.contextMessagesForSubagent(canonicalContext, {
                modelId: codexModel.id,
                providerId: "codex",
            }),
        ).toBe(canonicalContext);

        const incompatible = session.contextMessagesForSubagent(canonicalContext, {
            modelId: claudeModel.id,
            parentToolCallId: "current-spawn-call",
            providerId: "claude",
        });
        expect(JSON.stringify(incompatible)).toContain("<model-switch-history-context>");
        expect(JSON.stringify(incompatible)).toContain("OLDER_DURABLE_PARENT_HISTORY");
        expect(JSON.stringify(incompatible)).toContain("LATEST_SELECTED_PARENT_TURN");
        expect(JSON.stringify(incompatible)).not.toContain("CURRENT_SPAWN_CALL");
        expect(JSON.stringify(incompatible)).not.toContain("SOURCE_PROVIDER_OPAQUE_CHECKPOINT");

        const limited = session.contextMessagesForSubagent([latestMessage], {
            modelId: claudeModel.id,
            parentToolCallId: "current-spawn-call",
            providerId: "claude",
        });
        expect(JSON.stringify(limited)).toContain("LATEST_SELECTED_PARENT_TURN");
        expect(JSON.stringify(limited)).not.toContain("OLDER_DURABLE_PARENT_HISTORY");
    });
});

function testModels() {
    const capableModel = defineModel({
        defaultThinkingLevel: "off",
        id: "test/capable",
        name: "Capable model",
        thinkingLevels: ["off", "high"],
    });
    const limitedModel = defineModel({
        defaultThinkingLevel: "off",
        id: "test/limited",
        name: "Limited model",
        thinkingLevels: ["off"],
    });
    const catalog: ModelCatalog = {
        defaultModelId: capableModel.id,
        defaultProviderId: "test",
        models: [capableModel, limitedModel],
        providers: [{ models: [capableModel, limitedModel], providerId: "test" }],
    };
    return { capableModel, catalog, limitedModel };
}

function runningSession(
    options: {
        agentManager?: AgentSessionManager;
        onAppendEvent?: ConstructorParameters<typeof InMemorySession>[1]["onAppendEvent"];
        onRuntime?: (runtime: CodingAssistantRuntime) => void;
        processManager?: NativeProcessManager;
    } = {},
) {
    const started = deferred<void>();
    const release = deferred<void>();
    const { capableModel, catalog, limitedModel } = testModels();
    const provider = defineProvider({
        id: "test",
        models: [capableModel, limitedModel],
        stream() {
            return {
                async *[Symbol.asyncIterator]() {
                    started.resolve();
                    await release.promise;
                    throw new Error("released");
                },
                async result() {
                    throw new Error("released");
                },
            };
        },
    });
    const session = new InMemorySession(ctx, {
        ...(options.agentManager === undefined ? {} : { agentManager: options.agentManager }),
        createEventId: createEventIdFactory(),
        createRuntime: (runtimeOptions) => {
            const runtime = createRuntime(runtimeOptions, provider, options.processManager);
            options.onRuntime?.(runtime);
            return runtime;
        },
        modelCatalog: catalog,
        ...(options.onAppendEvent === undefined ? {} : { onAppendEvent: options.onAppendEvent }),
        request: { cwd: "/tmp/rig-queued-configuration", modelId: capableModel.id },
    });
    return { release, session, started };
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
    processManager = new NativeProcessManager(),
): CodingAssistantRuntime {
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

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}

async function runtimeContext(
    session: InMemorySession,
): Promise<Awaited<ReturnType<InMemorySession["externalControlContext"]>>> {
    return await session.externalControlContext(ctx);
}
