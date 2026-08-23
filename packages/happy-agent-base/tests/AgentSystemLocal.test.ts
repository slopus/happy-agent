import { Type } from "@sinclair/typebox";
import {
    createRootContext,
    GracefulShutdown,
    withShutdown,
    type Context,
} from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentKV,
    agentConfig,
    agentModuleConfig,
    AgentSystemLocal,
    AgentSystemRef,
    agentSystem as agentsFromContext,
    defineAgentTool,
    type AgentConfig,
    type AgentEnvironment,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
} from "../sources/index.js";
import {
    InMemoryAgentStorage,
    inMemoryStorageLock,
    providersOf,
    queued,
    textTurn,
    user,
} from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agentSystem-test");
const LOOP_ID = "l12345678901234567890123";

/** A complete environment, since an agent either knows one fully or not at all. */
function environmentOf(workingDirectory: string): AgentEnvironment {
    return {
        osVersion: "25.5.0",
        platform: "darwin",
        workingDirectory,
        shell: "/bin/zsh",
    };
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

function managerKV(persistence: InMemoryPersistence): AgentKV {
    return new AgentKV(persistence, "agentSystem.");
}

describe("AgentSystemLocal", () => {
    it("keeps a freshly created agent idle until it receives work", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        let loops = 0;
        const system = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                modules: [
                    {
                        name: "loop-observer",
                        beforeStart: () => ({
                            beforeAgentLoop: () => {
                                loops += 1;
                            },
                        }),
                    },
                ],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );

        const agent = await system.create(ctx, {}, { id: "freshagent123456789012345" });
        await agent.waitForIdle();

        expect(agent.active).toBe(false);
        expect(loops).toBe(0);
        expect(provider.sessions).toHaveLength(0);

        await agent.send(ctx, user("answer this"));
        await agent.waitForIdle();

        expect(loops).toBe(1);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await system.close(ctx);
    });

    it("awaits beforeStart before agents and afterStart after agents", async () => {
        const provider = new ScriptedProvider([textTurn("resumed")]);
        const managerPersistence = new InMemoryPersistence();
        const activePersistence = new InMemoryPersistence();
        managerPersistence.values.set("agentSystem.config.active", {});
        activePersistence.values.set("send.0001", queued(user("continue")));
        activePersistence.values.set("owed", { stage: "inference", loopId: LOOP_ID });
        const events: string[] = [];
        const releases = new Map<string, () => void>();
        const references: AgentSystemRef[] = [];
        const startModule = (name: string): AgentModule =>
            new (class implements AgentModule {
                readonly name = name;

                beforeStart(startCtx: Context, agents: AgentSystemRef): Promise<AgentModuleHooks> {
                    events.push(`beforeStart:${name}:start`);
                    references.push(agents);
                    expect(agentsFromContext(startCtx)).toBe(agents);
                    return new Promise((resolve) => {
                        releases.set(name, () => {
                            events.push(`beforeStart:${name}:end`);
                            resolve({
                                afterStart: async (
                                    afterStartCtx: Context,
                                    afterStartAgents: AgentSystemRef,
                                ): Promise<void> => {
                                    expect(agentsFromContext(afterStartCtx)).toBe(afterStartAgents);
                                    expect(
                                        (await afterStartAgents.resolve(afterStartCtx, "active"))
                                            .id,
                                    ).toBe("active");
                                    events.push(`afterStart:${name}`);
                                },
                                beforeAgentLoop: async (
                                    hookCtx: Context,
                                    scope: AgentModuleScope,
                                ): Promise<void> => {
                                    const loopAgents = agentsFromContext(hookCtx);
                                    expect(
                                        (await loopAgents?.resolve(hookCtx, scope.agent.id))?.id,
                                    ).toBe(scope.agent.id);
                                    events.push(`agentLoop:${name}`);
                                },
                                instructions: (): string => {
                                    events.push(`instructions:${name}`);
                                    return "";
                                },
                            });
                        });
                    });
                }
            })();
        const storage = new InMemoryAgentStorage({
            acquireLock: inMemoryStorageLock(),
            kv: managerKV(managerPersistence),
            persistence: (agentId) => {
                events.push(`restore:${agentId}`);
                return activePersistence;
            },
        });

        const creating = AgentSystemLocal.create(ctx, storage, {
            modules: [startModule("first"), startModule("second")],
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        await until(() => releases.size === 2);

        // Both hooks started together, and no restored agent can reach another module hook yet.
        expect(events).toEqual(["beforeStart:first:start", "beforeStart:second:start"]);
        expect(provider.sessions).toHaveLength(0);
        await expect(references[0]?.resolve(ctx, "active")).rejects.toThrow("not ready");

        releases.get("first")?.();
        await Promise.resolve();
        expect(provider.sessions).toHaveLength(0);
        releases.get("second")?.();

        const system = await creating;
        const active = await system.resolve(ctx, "active");
        await active.waitForIdle();
        const beforeFinished = events.indexOf("beforeStart:second:end");
        const restored = events.indexOf("restore:active");
        expect(beforeFinished).toBeGreaterThan(-1);
        expect(restored).toBeGreaterThan(beforeFinished);
        expect(events.indexOf("afterStart:first")).toBeGreaterThan(restored);
        expect(events.indexOf("afterStart:second")).toBeGreaterThan(restored);
        expect(events.indexOf("instructions:first")).toBeGreaterThan(beforeFinished);
        expect(events.indexOf("instructions:second")).toBeGreaterThan(beforeFinished);
        expect(events.indexOf("agentLoop:first")).toBeGreaterThan(restored);
        expect(events.indexOf("agentLoop:second")).toBeGreaterThan(restored);
        await system.close(ctx);
    });

    it("waits for every startup restoration before releasing a failed startup's lock", async () => {
        const managerPersistence = new InMemoryPersistence();
        managerPersistence.values.set("agentSystem.config.failed", {});
        managerPersistence.values.set("agentSystem.config.slow", {});
        let locked = false;
        let slowStarted = false;
        let slowFinishedWhileLocked = false;
        let releaseSlow = (): void => undefined;
        const acquireLock = () => {
            if (locked) return Promise.reject(new Error("The agent store is already locked."));
            locked = true;
            return Promise.resolve({
                release: () => {
                    locked = false;
                    return Promise.resolve();
                },
            });
        };
        const failedPersistence = new (class extends InMemoryPersistence {
            override readValues(
                readCtx: Context,
                prefix: string,
            ): ReturnType<InMemoryPersistence["readValues"]> {
                if (prefix === "owed") {
                    return Promise.reject(new Error("Failed to restore one agent."));
                }
                return super.readValues(readCtx, prefix);
            }
        })();
        const slowPersistence = new (class extends InMemoryPersistence {
            override async readValues(
                readCtx: Context,
                prefix: string,
            ): ReturnType<InMemoryPersistence["readValues"]> {
                if (prefix === "owed") {
                    slowStarted = true;
                    await new Promise<void>((resolve) => {
                        releaseSlow = resolve;
                    });
                    slowFinishedWhileLocked = locked;
                }
                return await super.readValues(readCtx, prefix);
            }
        })();
        slowPersistence.values.set("owed", { stage: "inference", loopId: LOOP_ID });
        const storage = (): InMemoryAgentStorage =>
            new InMemoryAgentStorage({
                acquireLock,
                kv: managerKV(managerPersistence),
                persistence: (agentId) =>
                    agentId === "failed" ? failedPersistence : slowPersistence,
            });
        const options = {
            modules: [],
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        };

        const creating = AgentSystemLocal.create(ctx, storage(), options);
        await until(() => slowStarted);
        await expect(AgentSystemLocal.create(ctx, storage(), options)).rejects.toThrow(
            "already locked",
        );
        releaseSlow();
        await expect(creating).rejects.toThrow("Failed to restore one agent.");

        expect({ locked, slowFinishedWhileLocked }).toEqual({
            locked: false,
            slowFinishedWhileLocked: true,
        });
    });

    it("releases the storage lock when a module start hook fails", async () => {
        const acquireLock = inMemoryStorageLock();
        const managerPersistence = new InMemoryPersistence();
        const storage = (): InMemoryAgentStorage =>
            new InMemoryAgentStorage({
                acquireLock,
                kv: managerKV(managerPersistence),
                persistence: () => new InMemoryPersistence(),
            });
        const providers = providersOf(new ScriptedProvider([]));
        let releaseSlow = (): void => undefined;
        let slowStarted = false;
        const failing: AgentModule = {
            name: "failing",
            beforeStart: () => Promise.reject(new Error("Module initialization failed.")),
        };
        const slow: AgentModule = {
            name: "slow",
            beforeStart: () =>
                new Promise((resolve) => {
                    slowStarted = true;
                    releaseSlow = resolve;
                }),
        };

        const creation = AgentSystemLocal.create(ctx, storage(), {
            modules: [failing, slow],
            providers,
            provider: "scripted",
            models: [],
        });
        let settled = false;
        void creation.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await until(() => slowStarted);
        await Promise.resolve();
        expect(settled).toBe(false);
        await expect(
            AgentSystemLocal.create(ctx, storage(), {
                modules: [],
                providers,
                provider: "scripted",
                models: [],
            }),
        ).rejects.toThrow("already locked");

        releaseSlow();
        await expect(creation).rejects.toThrow("Module initialization failed.");
        const recovered = await AgentSystemLocal.create(ctx, storage(), {
            modules: [],
            providers,
            provider: "scripted",
            models: [],
        });
        await recovered.close(ctx);

        await expect(
            AgentSystemLocal.create(ctx, storage(), {
                modules: [
                    {
                        name: "failing-after",
                        beforeStart: () => ({
                            afterStart: () =>
                                Promise.reject(new Error("Module post-start failed.")),
                        }),
                    },
                ],
                providers,
                provider: "scripted",
                models: [],
            }),
        ).rejects.toThrow("Module post-start failed.");
        const recoveredAgain = await AgentSystemLocal.create(ctx, storage(), {
            modules: [],
            providers,
            provider: "scripted",
            models: [],
        });
        await recoveredAgain.close(ctx);
    });

    it("owns its durable store exclusively until the system closes", async () => {
        const acquireLock = inMemoryStorageLock();
        const managerPersistence = new InMemoryPersistence();
        const agentStores = new Map<string, InMemoryPersistence>();
        const storage = (): InMemoryAgentStorage =>
            new InMemoryAgentStorage({
                acquireLock,
                kv: managerKV(managerPersistence),
                persistence: (agentId) => {
                    const existing = agentStores.get(agentId);
                    if (existing !== undefined) return existing;
                    const created = new InMemoryPersistence();
                    agentStores.set(agentId, created);
                    return created;
                },
            });
        const options = {
            modules: [],
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        };

        const firstStorage = storage();
        const first = await AgentSystemLocal.create(ctx, firstStorage, options);
        await expect(AgentSystemLocal.create(ctx, firstStorage, options)).rejects.toThrow(
            "already owned",
        );
        await expect(AgentSystemLocal.create(ctx, storage(), options)).rejects.toThrow(
            "already locked",
        );

        await first.close(ctx);
        const second = await AgentSystemLocal.create(ctx, storage(), options);
        // An old owner's repeated close must not release the new owner's lock.
        await first.close(ctx);
        await expect(AgentSystemLocal.create(ctx, storage(), options)).rejects.toThrow(
            "already locked",
        );
        await expect(first.resolve(ctx, "missing")).rejects.toThrow("system is closed");
        await second.close(ctx);
    });

    it("finishes the current agent operation, stops its loop, and releases its shutdown lock", async () => {
        const coordinator = new GracefulShutdown();
        const shutdownCtx = withShutdown(
            createRootContext().named("agentSystem-graceful-shutdown-test"),
            coordinator,
        );
        const acquireLock = inMemoryStorageLock();
        const managerPersistence = new InMemoryPersistence();
        const agentPersistence = new InMemoryPersistence();
        const storage = (): InMemoryAgentStorage =>
            new InMemoryAgentStorage({
                acquireLock,
                kv: managerKV(managerPersistence),
                persistence: () => agentPersistence,
            });
        let operationStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            operationStarted = resolve;
        });
        let finishOperation!: () => void;
        const operationFinished = new Promise<void>((resolve) => {
            finishOperation = resolve;
        });
        let firstOperation = true;
        const operationGate: AgentModule = {
            name: "operation-gate",
            beforeStart: () => ({
                beforeInference: async () => {
                    if (!firstOperation) return;
                    firstOperation = false;
                    operationStarted();
                    await operationFinished;
                },
            }),
        };
        const firstProvider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const first = await AgentSystemLocal.create(shutdownCtx, storage(), {
            modules: [operationGate],
            providers: providersOf(firstProvider),
            provider: "scripted",
            models: [],
            sendMode: "one-at-a-time",
        });
        const agent = await first.create(shutdownCtx, {}, { id: "shutdownagent" });
        await agent.send(shutdownCtx, user("first"));
        await started;
        await agent.send(shutdownCtx, user("second"));

        const closing = coordinator.shutdown({ timeout: 1_000 });
        expect(coordinator.pending()).toContain("agent-system");
        finishOperation();
        await expect(closing).resolves.toEqual({ failed: [], timedOut: [] });

        expect(firstProvider.sessions[0]?.requests).toHaveLength(1);
        expect(agentPersistence.values.has("owed")).toBe(true);
        const resumedProvider = new ScriptedProvider([textTurn("second")]);
        const resumed = await AgentSystemLocal.create(ctx, storage(), {
            providers: providersOf(resumedProvider),
            provider: "scripted",
            models: [],
            sendMode: "one-at-a-time",
        });
        const resumedAgent = await resumed.resolve(ctx, "shutdownagent");
        await resumedAgent.waitForIdle();
        expect(resumedProvider.sessions[0]?.requests).toHaveLength(1);
        expect(resumedProvider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("second"),
        );
        await resumed.close(ctx);
    });

    it("drains after inference without dispatching its returned tools or queued messages", async () => {
        const managerPersistence = new InMemoryPersistence();
        const agentPersistence = new InMemoryPersistence();
        let inferenceFinished!: () => void;
        const finished = new Promise<void>((resolve) => {
            inferenceFinished = resolve;
        });
        let releaseInference!: () => void;
        const released = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        let toolCalls = 0;
        const gate: AgentModule = {
            name: "drain-inference-gate",
            beforeStart: () => ({
                tools: () => [
                    defineAgentTool({
                        name: "drain_tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            toolCalls += 1;
                            return {};
                        },
                        toLLM: () => [],
                    }),
                ],
                afterInference: async () => {
                    inferenceFinished();
                    await released;
                },
            }),
        };
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "drain_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("must not start"),
        ]);
        const system = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(managerPersistence),
                persistence: () => agentPersistence,
            }),
            {
                modules: [gate],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );
        const agent = await system.create(ctx, {}, { id: "draininferenceagent" });
        await agent.send(ctx, user("run the tool"));
        await finished;

        const draining = system.drain();
        expect(system.drainProgress()).toEqual({
            agents: [{ id: "draininferenceagent", stage: "inference" }],
            count: 1,
        });
        expect(system.drainProgress(0)).toEqual({ agents: [], count: 1, truncated: true });
        expect(system.drain()).toBe(draining);
        await agent.steer(ctx, user("keep this queued"));
        releaseInference();
        await draining;

        expect(system.drainProgress()).toEqual({ agents: [], count: 0 });
        expect(toolCalls).toBe(0);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(agent.active).toBe(true);
        expect([...agentPersistence.values.keys()]).toContainEqual(
            expect.stringMatching(/^steering\./),
        );
        agent.start();
        await Promise.resolve();
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await system.close(ctx);
    });

    it("drains a running tool batch and reports it without starting follow-up inference", async () => {
        const managerPersistence = new InMemoryPersistence();
        const agentPersistence = new InMemoryPersistence();
        let toolStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            toolStarted = resolve;
        });
        let finishTool!: () => void;
        const finished = new Promise<void>((resolve) => {
            finishTool = resolve;
        });
        let completed = false;
        const toolModule: AgentModule = {
            name: "drain-running-tool",
            beforeStart: () => ({
                tools: () => [
                    defineAgentTool({
                        name: "drain_running_tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            toolStarted();
                            await finished;
                            completed = true;
                            return {};
                        },
                        toLLM: () => [{ type: "text", text: "finished" }],
                    }),
                ],
            }),
        };
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "drain_running_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("must not start"),
        ]);
        const system = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(managerPersistence),
                persistence: () => agentPersistence,
            }),
            {
                modules: [toolModule],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );
        const agent = await system.create(ctx, {}, { id: "draintoolagent" });
        await agent.send(ctx, user("run the tool"));
        await started;

        let drained = false;
        const draining = system.drain().then(() => {
            drained = true;
        });
        expect(system.drainProgress()).toEqual({
            agents: [{ id: "draintoolagent", stage: "tools" }],
            count: 1,
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        finishTool();
        await draining;

        expect(completed).toBe(true);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(agentPersistence.records).toContainEqual(expect.objectContaining({ type: "tool" }));
        await system.close(ctx);
    });

    it("waits for an in-flight tool without starting its follow-up inference", async () => {
        const coordinator = new GracefulShutdown();
        const shutdownCtx = withShutdown(
            createRootContext().named("agentSystem-tool-shutdown-test"),
            coordinator,
        );
        const managerPersistence = new InMemoryPersistence();
        const agentPersistence = new InMemoryPersistence();
        let toolStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            toolStarted = resolve;
        });
        let finishTool!: () => void;
        const toolFinished = new Promise<void>((resolve) => {
            finishTool = resolve;
        });
        let completed = false;
        const toolModule: AgentModule = {
            name: "shutdown-tool",
            beforeStart: () => ({
                tools: () => [
                    defineAgentTool({
                        name: "shutdown_tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            toolStarted();
                            await toolFinished;
                            completed = true;
                            return {};
                        },
                        toLLM: () => [{ type: "text", text: "finished" }],
                    }),
                ],
            }),
        };
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "shutdown_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("follow-up"),
        ]);
        const system = await AgentSystemLocal.create(
            shutdownCtx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(managerPersistence),
                persistence: () => agentPersistence,
            }),
            {
                modules: [toolModule],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );
        const agent = await system.create(shutdownCtx, {}, { id: "shutdowntoolagent" });
        await agent.send(shutdownCtx, user("run the tool"));
        await started;

        let closed = false;
        const closing = coordinator.shutdown({ timeout: 1_000 }).then((report) => {
            closed = true;
            return report;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(completed).toBe(false);
        finishTool();
        await expect(closing).resolves.toEqual({ failed: [], timedOut: [] });

        expect(completed).toBe(true);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(agentPersistence.records).toContainEqual(expect.objectContaining({ type: "tool" }));
    });

    it("caches the resolved agent and its store, and tells modules which agent they serve", async () => {
        const provider = new ScriptedProvider([]);
        const managerPersistence = new InMemoryPersistence();
        const served: string[] = [];
        const owners: (AgentSystemRef | undefined)[] = [];

        const module = (moduleName: string): AgentModule =>
            new (class implements AgentModule {
                readonly name = moduleName;

                beforeStart() {
                    return {
                        instructions: (hookCtx: Context, scope: AgentModuleScope): string => {
                            owners.push(agentsFromContext(hookCtx));
                            served.push(`${this.name}:${scope.agent.id}`);
                            return "";
                        },
                    };
                }
            })();

        let stores = 0;
        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(managerPersistence),
                persistence: () => {
                    stores += 1;
                    return new InMemoryPersistence();
                },
            }),
            {
                modules: [module("first"), module("second")],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );

        const firstAgent = await agentSystem.create(ctx, {
            environment: environmentOf("/tmp/agent-1"),
        });
        const secondAgent = await agentSystem.resolve(ctx, firstAgent.id);
        expect(firstAgent).toBe(secondAgent);
        expect(stores).toBe(1);

        await firstAgent.send(ctx, user("go"));
        await firstAgent.waitForIdle();

        // Both modules were told the same agent, in the order the collection was given them.
        expect(served).toEqual([`first:${firstAgent.id}`, `second:${firstAgent.id}`]);
        // And each was handed the collection as a reference, never the collection itself.
        expect(owners[0]).toBeInstanceOf(AgentSystemRef);
        expect(owners[1]).toBe(owners[0]);
        await firstAgent.close();
    });

    it("resolves and resumes every durably active agent on start", async () => {
        const activeProvider = new ScriptedProvider([textTurn("resumed")]);
        const idleProvider = new ScriptedProvider([]);
        const activePersistence = new InMemoryPersistence();
        const idlePersistence = new InMemoryPersistence();
        const managerPersistence = new InMemoryPersistence();
        activePersistence.values.set("send.0001", queued(user("continue")));
        // The message was accepted and never answered, so the agent is durably owing an answer.
        activePersistence.values.set("owed", { stage: "inference", loopId: LOOP_ID });
        // Both agentSystem were created by the previous process, so this one only resolves them.
        managerPersistence.values.set("agentSystem.config.active", {
            environment: environmentOf("/work/active"),
        });
        managerPersistence.values.set("agentSystem.config.idle", {});
        const loaded: string[] = [];

        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(managerPersistence),
                persistence: (id) => {
                    loaded.push(id);
                    return id === "active" ? activePersistence : idlePersistence;
                },
            }),
            {
                modules: [],
                providers: providersOf(activeProvider),
                provider: "scripted",
                models: [],
            },
        );

        await agentSystem.resolve(ctx, "idle");
        const active = await agentSystem.resolve(ctx, "active");
        await active.waitForIdle();

        // The active one was resumed by the start itself; the idle one waited to be asked for.
        expect(loaded).toEqual(["active", "idle"]);
        expect(activeProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("continue"),
        ]);
        expect(idleProvider.sessions).toHaveLength(0);
        await active.close();
        await (await agentSystem.resolve(ctx, "idle")).close();
    });

    it("resolves agentSystem automatically for session operations", async () => {
        const provider = new ScriptedProvider([textTurn("sent"), textTurn("steered")]);
        const persistence = new InMemoryPersistence();
        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => persistence,
            }),
            { modules: [], providers: providersOf(provider), provider: "scripted", models: [] },
        );

        const created = await agentSystem.create(ctx, {});
        await agentSystem.send(ctx, created.id, user("send"));
        const agent = await agentSystem.resolve(ctx, created.id);
        await agent.waitForIdle();
        await agentSystem.steer(ctx, created.id, user("steer"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.requests).toHaveLength(2);
        expect(session?.requests[0]?.context.messages[0]).toEqual(user("send"));
        expect(session?.requests[1]?.context.messages.at(-1)).toEqual(user("steer"));

        session?.compactionResults.push({
            status: "completed",
            preservedMessages: [],
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
            },
            context: { instructions: "", messages: [] },
        });
        await agentSystem.compact(ctx, created.id);
        await agent.waitForIdle();
        expect(session?.compactions).toHaveLength(1);

        await agentSystem.abort(ctx, created.id);
        await agent.close();
    });
});

describe("AgentSystemLocal queue modes", () => {
    it("passes all-at-once steering and send modes to every loaded agent", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        let queuedSteering = false;
        let queuedSends = false;
        const queueModule: AgentModule = {
            name: "queue-mode-observer",
            beforeStart: (_startCtx, agents) => ({
                onEvent: (eventCtx, scope, event) => {
                    if (event.type !== "text_delta") return;
                    if (event.delta === "o" && !queuedSteering) {
                        queuedSteering = true;
                        void agents.steer(eventCtx, scope.agent.id, user("steer one"));
                        void agents.steer(eventCtx, scope.agent.id, user("steer two"));
                    }
                    if (event.delta === "t" && !queuedSends) {
                        queuedSends = true;
                        void agents.send(eventCtx, scope.agent.id, user("send one"));
                        void agents.send(eventCtx, scope.agent.id, user("send two"));
                    }
                },
            }),
        };
        const system = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                models: [],
                modules: [queueModule],
                providers: providersOf(provider),
                provider: "scripted",
                sendMode: "all",
                steeringMode: "all",
            },
        );
        try {
            const agent = await system.create(ctx, {});
            await agent.send(ctx, user("go"));
            await agent.waitForIdle();

            const requests = provider.sessions[0]?.requests ?? [];
            expect(requests).toHaveLength(3);
            expect(requests[1]?.context.messages.slice(-2)).toEqual([
                user("steer one"),
                user("steer two"),
            ]);
            expect(requests[2]?.context.messages.slice(-2)).toEqual([
                user("send one"),
                user("send two"),
            ]);
        } finally {
            await system.close(ctx);
        }
    });
});

describe("AgentSystemLocal configuration", () => {
    /**
     * A collection over the given manager storage, with one module that records what each
     * agent's configuration looks like from inside that agent's own hooks. The module instance
     * is shared, so the configuration reaches it through the context of the agent it is running
     * for rather than through its construction.
     */
    async function collectionOf(
        managerPersistence: InMemoryPersistence,
        seen: AgentConfig[],
        settings: (Record<string, unknown> | undefined)[],
        provider: ScriptedProvider = new ScriptedProvider([]),
    ): Promise<AgentSystemLocal> {
        const recorder: AgentModule = new (class implements AgentModule {
            readonly name = "recorder";

            beforeStart() {
                return {
                    instructions(hookCtx: Context): string {
                        const config = agentConfig(hookCtx);
                        if (config !== undefined) seen.push(config);
                        settings.push(agentModuleConfig(hookCtx, "recorder"));
                        return "";
                    },
                };
            }
        })();
        return await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(managerPersistence),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                modules: [recorder],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );
    }

    const config: AgentConfig = {
        environment: environmentOf("/work"),
        modules: { recorder: { verbosity: "high" } },
    };

    it("carries the created configuration to every module and keeps it across a restart", async () => {
        const managerPersistence = new InMemoryPersistence();
        const seen: AgentConfig[] = [];
        const settings: (Record<string, unknown> | undefined)[] = [];
        const agentSystem = await collectionOf(
            managerPersistence,
            seen,
            settings,
            new ScriptedProvider([textTurn("first"), textTurn("second")]),
        );

        const agent = await agentSystem.create(ctx, config);
        await agent.send(ctx, user("go"));
        await agent.waitForIdle();
        // The collection states where the agent came from, so what a module sees is what was
        // passed plus that. Nothing created this one, so it is recorded as having no creator.
        const created = { ...config, provenance: { createdAt: expect.any(Number) } };
        expect(seen).toEqual([created]);
        // A module sees only its own opaque entry, which the collection never interprets.
        expect(settings).toEqual([{ verbosity: "high" }]);
        expect(await agentSystem.config(ctx, agent.id)).toEqual(created);
        await agent.close();

        // A fresh collection over the same storage resolves the very same agent.
        const restarted = await collectionOf(
            managerPersistence,
            seen,
            settings,
            new ScriptedProvider([textTurn("third")]),
        );
        const resolved = await restarted.resolve(ctx, agent.id);
        await resolved.send(ctx, user("again"));
        await resolved.waitForIdle();
        expect(seen).toEqual([created, created]);
        await resolved.close();
    });

    it("refuses to resolve an agent that was never created", async () => {
        const agentSystem = await collectionOf(new InMemoryPersistence(), [], []);
        await expect(agentSystem.resolve(ctx, "missing")).rejects.toThrow(
            'Agent "missing" has not been created.',
        );
        expect(await agentSystem.config(ctx, "missing")).toBeUndefined();
    });

    it("rejects a configuration that does not match the schema", async () => {
        const agentSystem = await collectionOf(new InMemoryPersistence(), [], []);
        await expect(
            agentSystem.create(ctx, {
                // An environment is all or nothing: a partial one is not a configuration.
                environment: { platform: "darwin" },
            } as unknown as AgentConfig),
        ).rejects.toThrow("is not valid.");
    });
});

describe("AgentSystemLocal shared modules", () => {
    /** A module instance that records, per agent, everything it was told from the context. */
    class SharedRecorder implements AgentModule {
        static readonly instances: SharedRecorder[] = [];

        readonly name = "shared-recorder";
        /** Which agents this one instance served, in the order it first saw them. */
        readonly served: string[] = [];
        /** The configuration each of those agents was created with, as the hook was told it. */
        readonly configurations: (AgentConfig | undefined)[] = [];

        constructor() {
            SharedRecorder.instances.push(this);
        }

        beforeStart() {
            return {
                instructions: (hookCtx: Context, scope: AgentModuleScope): string => {
                    const id = scope.agent.id;
                    if (!this.served.includes(id)) {
                        this.served.push(id);
                        this.configurations.push(agentConfig(hookCtx));
                    }
                    return `shared for ${id}`;
                },
            };
        }
    }

    async function collectionOf(
        provider: ScriptedProvider,
        modules: readonly AgentModule[],
    ): Promise<AgentSystemLocal> {
        return await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            { modules, providers: providersOf(provider), provider: "scripted", models: [] },
        );
    }

    it("gives every agent the one instance the collection was built with", async () => {
        SharedRecorder.instances.length = 0;
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agentSystem = await collectionOf(provider, [new SharedRecorder()]);

        const first = await agentSystem.create(ctx, {});
        const second = await agentSystem.create(ctx, {});

        // One instance for the whole collection, serving both agents.
        expect(SharedRecorder.instances).toHaveLength(1);
        expect(first.module("shared-recorder")).toBe(second.module("shared-recorder"));

        // That instance serves both agents, and its instructions open every prompt.
        await first.send(ctx, user("first"));
        await first.waitForIdle();
        await second.send(ctx, user("second"));
        await second.waitForIdle();
        expect(SharedRecorder.instances[0]?.served).toEqual([first.id, second.id]);
        expect(provider.sessions.map((session) => session.options.instructions)).toEqual([
            `shared for ${first.id}`,
            `shared for ${second.id}`,
        ]);

        await first.close();
        await second.close();
    });

    it("gives a module one store shared by every agent, beside a store of its own", async () => {
        /** A module that leaves a note for whichever agent runs next. */
        class Postbox implements AgentModule {
            readonly name = "postbox";
            /** What each agent found in the shared store, and in its own, before writing. */
            readonly found: { shared: unknown; own: unknown }[] = [];

            beforeStart() {
                return {
                    instructions: async (
                        hookCtx: Context,
                        scope: AgentModuleScope,
                    ): Promise<string> => {
                        this.found.push({
                            shared: await scope.sharedKV.read(hookCtx, "note"),
                            own: await scope.kv.read(hookCtx, "note"),
                        });
                        await scope.sharedKV.write(hookCtx, "note", `from ${scope.agent.id}`);
                        await scope.kv.write(hookCtx, "note", "mine");
                        return "";
                    },
                };
            }
        }
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const postbox = new Postbox();
        const agentSystem = await collectionOf(provider, [postbox]);

        const first = await agentSystem.create(ctx, {});
        await first.send(ctx, user("first"));
        await first.waitForIdle();
        const second = await agentSystem.create(ctx, {});
        await second.send(ctx, user("second"));
        await second.waitForIdle();

        // The second agent reads what the first left in the shared store, and nothing in its own.
        expect(postbox.found).toEqual([
            { shared: undefined, own: undefined },
            { shared: `from ${first.id}`, own: undefined },
        ]);
        await first.close();
        await second.close();
    });

    it("hands modules the collection as a reference rather than itself", async () => {
        let seen: unknown;
        class Peek implements AgentModule {
            readonly name = "peek";

            beforeStart() {
                return {
                    instructions: (hookCtx: Context): string => {
                        seen = agentsFromContext(hookCtx);
                        return "";
                    },
                };
            }
        }
        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                modules: [new Peek()],
                providers: providersOf(new ScriptedProvider([textTurn("answer")])),
                provider: "scripted",
                models: [],
            },
        );

        const agent = await agentSystem.create(ctx, {});
        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(seen).toBeInstanceOf(AgentSystemRef);
        // Nothing that ends an agent's life, or waits for one, is reachable from inside.
        expect(Object.getOwnPropertyNames(Object.getPrototypeOf(seen)).sort()).toEqual([
            "abort",
            "childOf",
            "compact",
            "config",
            "constructor",
            "create",
            "models",
            "parentOf",
            "resolve",
            "send",
            "steer",
            "updateMetadata",
        ]);
        await agent.close();
    });

    it("observes created, restored, and archived agents around durable module projections", async () => {
        const manager = new InMemoryPersistence();
        const stores = new Map<string, InMemoryPersistence>();
        const acquireLock = inMemoryStorageLock();
        const events: string[] = [];
        const snapshots: unknown[] = [];
        let restoredRefId: string | undefined;
        const lifecycleModule: AgentModule = {
            name: "lifecycle",
            beforeStart: () => ({
                agentCreatedTransact: async (hookCtx, scope, agent) => {
                    await scope.sharedKV.write(hookCtx, agent.id, "created");
                    events.push("created:transact");
                },
                agentCreated: async (hookCtx, scope, agent) => {
                    events.push(`created:${String(await scope.sharedKV.read(hookCtx, agent.id))}`);
                    snapshots.push(agent);
                },
                agentRestoredTransact: async (hookCtx, scope, agent) => {
                    await scope.sharedKV.write(hookCtx, agent.id, "restored");
                    events.push("restored:transact");
                },
                agentRestored: async (hookCtx, scope, agent) => {
                    restoredRefId = (await scope.agents.resolve(hookCtx, agent.id)).id;
                    events.push(`restored:${String(await scope.sharedKV.read(hookCtx, agent.id))}`);
                    snapshots.push(agent);
                },
                agentArchivedTransact: async (hookCtx, scope, agent) => {
                    await scope.sharedKV.write(hookCtx, agent.id, "archived");
                    events.push("archived:transact");
                },
                agentArchived: async (hookCtx, scope, agent) => {
                    events.push(`archived:${String(await scope.sharedKV.read(hookCtx, agent.id))}`);
                    snapshots.push(agent);
                },
            }),
        };
        const storage = () =>
            new InMemoryAgentStorage({
                acquireLock,
                kv: managerKV(manager),
                persistence: (agentId) => {
                    const existing = stores.get(agentId);
                    if (existing !== undefined) return existing;
                    const created = new InMemoryPersistence();
                    stores.set(agentId, created);
                    return created;
                },
            });
        const options = {
            modules: [lifecycleModule],
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        };
        const first = await AgentSystemLocal.create(ctx, storage(), options);
        const agent = await first.create(
            ctx,
            { metadata: { title: "Owned", nested: { value: "stable" } } },
            { id: "a12345678901234567890123" },
        );
        await first.close(ctx);

        const second = await AgentSystemLocal.create(ctx, storage(), options);
        await second.delete(ctx, agent.id);
        await second.close(ctx);

        expect(events).toEqual([
            "created:transact",
            "created:created",
            "restored:transact",
            "restored:restored",
            "archived:transact",
            "archived:archived",
        ]);
        expect(snapshots).toHaveLength(3);
        expect(Object.isFrozen(snapshots[0])).toBe(true);
        expect(Object.isFrozen((snapshots[0] as { metadata: unknown }).metadata)).toBe(true);
        expect(restoredRefId).toBe(agent.id);
        expect(snapshots).toEqual([
            {
                id: agent.id,
                metadata: { title: "Owned", nested: { value: "stable" } },
            },
            {
                id: agent.id,
                metadata: { title: "Owned", nested: { value: "stable" } },
            },
            {
                id: agent.id,
                metadata: { title: "Owned", nested: { value: "stable" } },
            },
        ]);
    });

    it("rolls lifecycle projections back and suppresses observation when creation fails", async () => {
        const manager = new InMemoryPersistence();
        let observed = 0;
        const system = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(manager),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                modules: [
                    {
                        name: "reject-created",
                        beforeStart: () => ({
                            agentCreatedTransact: async (hookCtx, scope, agent) => {
                                await scope.sharedKV.write(hookCtx, agent.id, "must roll back");
                                throw new Error("creation projection failed");
                            },
                            agentCreated: () => {
                                observed += 1;
                            },
                        }),
                    },
                ],
                providers: providersOf(new ScriptedProvider([])),
                provider: "scripted",
                models: [],
            },
        );

        await expect(system.create(ctx, {}, { id: "f12345678901234567890123" })).rejects.toThrow(
            "creation projection failed",
        );

        expect(await system.config(ctx, "f12345678901234567890123")).toBeUndefined();
        expect(
            manager.values.has("agentSystem.modules.reject-created.f12345678901234567890123"),
        ).toBe(false);
        expect(observed).toBe(0);
        await system.close(ctx);
    });

    it("rejects reentry through a transactional lifecycle ref without restricting observers", async () => {
        let transactionalError = "";
        let observerResolved = false;
        const system = await AgentSystemLocal.create(
            ctx,
            new InMemoryAgentStorage({
                acquireLock: inMemoryStorageLock(),
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                modules: [
                    {
                        name: "lifecycle-reentry",
                        beforeStart: () => ({
                            agentCreatedTransact: async (hookCtx, scope, agent) => {
                                try {
                                    await scope.agents.resolve(hookCtx, agent.id);
                                } catch (error: unknown) {
                                    transactionalError =
                                        error instanceof Error ? error.message : String(error);
                                }
                            },
                            agentCreated: async (hookCtx, scope, agent) => {
                                observerResolved =
                                    (await scope.agents.resolve(hookCtx, agent.id)).id === agent.id;
                            },
                        }),
                    },
                ],
                providers: providersOf(new ScriptedProvider([])),
                provider: "scripted",
                models: [],
            },
        );

        await system.create(ctx, {}, { id: "g12345678901234567890123" });
        await until(() => observerResolved);

        expect(transactionalError).toContain("transactional lifecycle hook");
        await system.close(ctx);
    });
});
