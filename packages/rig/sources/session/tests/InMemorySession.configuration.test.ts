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
        session.submit({ text: "Start a long run." });
        await started.promise;

        await session.changePermissionMode({ permissionMode: "read_only" });

        expect(modeWhenKilled).toBe("read_only");
        release.resolve();
        await session.beginShutdown();
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
        session.submit({ text: "Start a long run." });
        await started.promise;

        const changing = session.changePermissionMode({ permissionMode: "read_only" });
        await killStarted.promise;

        expect(changeSubagentPermissionModes).toHaveBeenCalledWith(session.id, "read_only");
        releaseKill.resolve();
        await changing;
        release.resolve();
        await session.beginShutdown();
    });

    it("does not promote independently restricted descendants when the root mode increases", async () => {
        const changeSubagentPermissionModes = vi.fn(async () => {});
        const { session } = runningSession({
            agentManager: {
                changeSubagentPermissionModes,
                communicationContext: vi.fn(),
            } as unknown as AgentSessionManager,
        });

        await session.changePermissionMode({ permissionMode: "read_only" });
        await session.changePermissionMode({ permissionMode: "auto" });

        expect(changeSubagentPermissionModes).toHaveBeenCalledOnce();
        expect(changeSubagentPermissionModes).toHaveBeenCalledWith(session.id, "read_only");
        await session.beginShutdown();
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
        session.submit({ text: "Start a long run." });
        await started.promise;

        const changing = session.changePermissionMode({ permissionMode: "read_only" });
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
        await session.beginShutdown();
    });

    it("keeps a reduced permission mode durable when process shutdown fails", async () => {
        const processManager = new NativeProcessManager();
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        vi.spyOn(processManager, "killAll").mockRejectedValueOnce(
            new Error("could not stop process"),
        );
        const { session, started, release } = runningSession({ processManager });
        session.submit({ text: "Start a long run." });
        await started.promise;

        await expect(session.changePermissionMode({ permissionMode: "read_only" })).rejects.toThrow(
            "could not stop process",
        );

        expect(session.snapshot().permissionMode).toBe("read_only");
        expect(session.events.since(undefined)).toContainEqual(
            expect.objectContaining({
                data: { permissionMode: "read_only" },
                type: "permission_mode_changed",
            }),
        );
        release.resolve();
        await session.beginShutdown();
    });

    it("stops running processes before a fallible MCP projection after permission reduction", async () => {
        const processManager = new NativeProcessManager();
        const killAll = vi.spyOn(processManager, "killAll").mockResolvedValue();
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        let reductionDurable = false;
        let rejectMcpProjection = true;
        const { session, started, release } = runningSession({
            onAppendEvent(event) {
                if (
                    event.type === "permission_mode_changed" &&
                    event.data.permissionMode === "read_only"
                ) {
                    reductionDurable = true;
                } else if (
                    reductionDurable &&
                    rejectMcpProjection &&
                    event.type === "mcp_servers_changed"
                ) {
                    rejectMcpProjection = false;
                    throw new Error("could not persist MCP projection");
                }
            },
            processManager,
        });
        session.submit({ text: "Start a long run." });
        await started.promise;

        await expect(session.changePermissionMode({ permissionMode: "read_only" })).rejects.toThrow(
            "could not persist MCP projection",
        );

        expect(killAll).toHaveBeenCalledOnce();
        expect(session.snapshot().permissionMode).toBe("read_only");
        release.resolve();
        await session.beginShutdown();
    });

    it("fails closed when a permission reduction cannot be made durable", async () => {
        let runtime: CodingAssistantRuntime | undefined;
        const processManager = new NativeProcessManager();
        const killAll = vi.spyOn(processManager, "killAll").mockResolvedValue();
        vi.spyOn(processManager, "activeCount").mockReturnValue(1);
        const { session, started, release } = runningSession({
            onAppendEvent(event) {
                if (event.type === "permission_mode_changed") {
                    throw new Error("could not persist permission mode");
                }
            },
            onRuntime(created) {
                runtime = created;
            },
            processManager,
        });
        session.submit({ text: "Start a long run." });
        await started.promise;

        const changing = session.changePermissionMode({ permissionMode: "read_only" });
        release.resolve();
        await expect(changing).rejects.toThrow("could not persist permission mode");

        expect(session.snapshot().permissionMode).toBe("read_only");
        expect(runtime?.context.permissions?.mode).toBe("read_only");
        expect(killAll).toHaveBeenCalled();
        expect(session.isClosing()).toBe(true);
    });

    it("validates reasoning against a model an earlier queued message has not applied yet", async () => {
        const { session, started, release } = runningSession();

        session.submit({ text: "Start a long run." });
        await started.promise;

        // This one cannot start yet, so its model is still only a pending intent.
        session.submit({ modelId: "test/limited", text: "Switch models." });
        expect(session.state().queuedRuns).toHaveLength(1);

        // "high" suits the model selected right now, so validating against that model instead of
        // the one already queued would wrongly accept this.
        expect(() => session.submit({ effort: "high", text: "Think hard." })).toThrow(
            "Model 'test/limited' does not support 'high' reasoning.",
        );

        release.resolve();
        await session.beginShutdown();
    });

    it("refuses to change the configuration by steering a running response", async () => {
        const { session, started, release } = runningSession();

        session.submit({ text: "Start a long run." });
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
            expect(() => session.steer({ ...change, text: "Change it." })).toThrow(
                "can only be changed by submitting a message",
            );
        }

        release.resolve();
        await session.beginShutdown();
    });

    it("does not resend a message that a cross-provider switch already excluded from history", () => {
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
        const session = new InMemorySession({
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

        session.submit({ modelId: claudeModel.id, providerId: "claude", text: "Only message." });

        // The switch summarized an empty history, so the context is empty rather than absent.
        // Absent would mean "the context is the visible transcript", which still holds this
        // message, and the run would then send it a second time.
        expect(session.snapshot().snapshot.contextMessages).toEqual([]);
    });

    it("keeps compatible fork checkpoints and normalizes incompatible ones", () => {
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
        const session = new InMemorySession({
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
        onAppendEvent?: ConstructorParameters<typeof InMemorySession>[0]["onAppendEvent"];
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
    const session = new InMemorySession({
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
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
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
