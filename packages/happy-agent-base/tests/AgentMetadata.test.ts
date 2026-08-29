import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    AgentKV,
    agentConfig,
    agentSystem,
    AgentSystemLocal,
    AgentSystemRef,
    withAgentConfig,
    type AgentBaseAcceptedMessage,
    type AgentModule,
    type AgentModuleScope,
    type AgentMetadataChange,
} from "../sources/index.js";
import {
    InMemoryAgentStorage,
    inMemoryStorageLock,
    providersOf,
    textTurn,
    user,
} from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agent-metadata-test");
const MESSAGE_ID = "m12345678901234567890123";
const ROOT_ID = "r12345678901234567890123";
const CHILD_ID = "c12345678901234567890123";
const EXPLICIT_CHILD_ID = "e12345678901234567890123";
const DETACHED_ID = "d12345678901234567890123";

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

function systemStorage(
    manager: InMemoryPersistence,
    stores = new Map<string, InMemoryPersistence>(),
): InMemoryAgentStorage {
    return new InMemoryAgentStorage({
        acquireLock: inMemoryStorageLock(),
        kv: new AgentKV(manager, "agentSystem."),
        persistence: (agentId) => {
            const existing = stores.get(agentId);
            if (existing !== undefined) return existing;
            const created = new InMemoryPersistence();
            stores.set(agentId, created);
            return created;
        },
    });
}

describe("message metadata and identity", () => {
    it("owns immutable metadata, passes it to both accepted hooks, and deduplicates by cuid2", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("once")]);
        const accepted: AgentBaseAcceptedMessage[] = [];
        const metadata = {
            hideFromUser: true,
            nested: { source: "client" },
        };
        const agent = await AgentBase.create(ctx, {
            id: "message-metadata",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                messageAcceptedTransact: (_hookCtx, message) => {
                    accepted.push(message);
                },
                messageAccepted: (_hookCtx, message) => {
                    accepted.push(message);
                },
            },
        });

        const first = agent.send(ctx, user("only once"), {
            id: MESSAGE_ID,
            metadata,
        });
        metadata.hideFromUser = false;
        metadata.nested.source = "mutated";
        const firstAcceptance = await first;
        await agent.waitForIdle();
        await agent.close();

        const restartedProvider = new ScriptedProvider([]);
        const restarted = await AgentBase.load(ctx, {
            id: "message-metadata",
            providers: providersOf(restartedProvider),
            provider: "scripted",
            persistence,
        });
        const retryAcceptance = await restarted.send(ctx, user("ignored retry"), {
            id: MESSAGE_ID,
            metadata: { hideFromUser: false },
        });
        await restarted.waitForIdle();

        expect(firstAcceptance).toEqual({
            id: MESSAGE_ID,
            delivery: "send",
            accepted: "created",
        });
        expect(retryAcceptance).toEqual({
            id: MESSAGE_ID,
            delivery: "send",
            accepted: "existing",
        });
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(restartedProvider.sessions).toHaveLength(0);
        expect(accepted).toHaveLength(2);
        expect(accepted[0]).toEqual({
            id: MESSAGE_ID,
            kind: "send",
            message: user("only once"),
            metadata: {
                hideFromUser: true,
                nested: { source: "client" },
            },
            profile: null,
        });
        expect(accepted[1]).toEqual(accepted[0]);
        expect(Object.isFrozen(accepted[0]?.metadata)).toBe(true);
        expect(Object.isFrozen(accepted[0]?.metadata?.nested)).toBe(true);
        const immutableNested = accepted[0]?.metadata?.nested;
        expect(immutableNested).toBeDefined();
        expect(() => {
            (immutableNested as { source: string }).source = "hook mutation";
        }).toThrow();
        expect(persistence.records.find((record) => record.type === "user")).toEqual({
            type: "user",
            id: MESSAGE_ID,
            message: user("only once"),
            metadata: {
                hideFromUser: true,
                nested: { source: "client" },
            },
        });
        await restarted.close();
    });

    it("restores pending-state and process reservations after a failed acceptance", async () => {
        class FailsFirstPendingWrite extends InMemoryPersistence {
            fail = true;

            override async writeValue(
                writeCtx: Context,
                key: string,
                value: unknown,
            ): Promise<void> {
                await super.writeValue(writeCtx, key, value);
                if (key === "owed" && this.fail) {
                    this.fail = false;
                    throw new Error("pending write failed");
                }
            }
        }
        const persistence = new FailsFirstPendingWrite();
        let releaseLoop!: () => void;
        let loopStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            loopStarted = resolve;
        });
        const released = new Promise<void>((resolve) => {
            releaseLoop = resolve;
        });
        const agent = await AgentBase.create(ctx, {
            id: "message-acceptance-rollback",
            providers: providersOf(new ScriptedProvider([textTurn("accepted")])),
            provider: "scripted",
            persistence,
            hooks: {
                beforeAgentLoop: async () => {
                    loopStarted();
                    await released;
                },
            },
        });

        await expect(agent.send(ctx, user("retry me"), { id: MESSAGE_ID })).rejects.toThrow(
            "pending write failed",
        );
        const retry = await agent.send(ctx, user("retry me"), {
            id: MESSAGE_ID,
        });
        await started;

        expect(retry.accepted).toBe("created");
        expect(persistence.values.get("owed")).toBeDefined();
        releaseLoop();
        await agent.waitForIdle();
        await agent.close();
    });

    it("lets hook actions supply message IDs and metadata", async () => {
        const accepted: AgentBaseAcceptedMessage[] = [];
        let followedUp = false;
        const agent = await AgentBase.create(ctx, {
            id: "hook-message-metadata",
            providers: providersOf(new ScriptedProvider([textTurn("first"), textTurn("second")])),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                messageAccepted: (_hookCtx, message) => {
                    accepted.push(message);
                },
                afterTurn: () => {
                    if (followedUp) return undefined;
                    followedUp = true;
                    return [
                        {
                            type: "send",
                            id: MESSAGE_ID,
                            message: user("from hook"),
                            metadata: { hideFromUser: true, origin: "hook" },
                        },
                    ];
                },
            },
        });

        await agent.send(ctx, user("begin"));
        await agent.waitForIdle();

        expect(accepted.at(-1)).toEqual({
            id: MESSAGE_ID,
            kind: "send",
            message: user("from hook"),
            metadata: { hideFromUser: true, origin: "hook" },
            profile: null,
        });
        await agent.close();
    });

    it("rejects non-cuid2 message IDs", async () => {
        const agent = await AgentBase.create(ctx, {
            id: "invalid-message-id",
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await expect(agent.send(ctx, user("invalid"), { id: "not a cuid2" })).rejects.toThrow(
            "message ID must be a cuid2",
        );
        await agent.close();
    });

    it("awaits asynchronous onEvent hooks", async () => {
        let release = (): void => undefined;
        let started = false;
        let deltaObserved = false;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const agent = await AgentBase.create(ctx, {
            id: "async-event-hook",
            providers: providersOf(new ScriptedProvider([textTurn("answer")])),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: async (_hookCtx, event) => {
                    if (event.type === "text_start") {
                        started = true;
                        await gate;
                    }
                    if (event.type === "text_delta") deltaObserved = true;
                },
            },
        });

        await agent.send(ctx, user("go"));
        await until(() => started);
        expect(deltaObserved).toBe(false);
        release();
        await agent.waitForIdle();
        expect(deltaObserved).toBe(true);
        await agent.close();
    });
});

describe("agent metadata, custom identity, and parentage", () => {
    it("updates metadata directly through AgentBase with transactional notifications", async () => {
        const persistence = new InMemoryPersistence();
        const observed: unknown[] = [];
        const reentryFailures: string[] = [];
        const directCtx = withAgentConfig(ctx, {
            metadata: { title: "Direct", source: "initial" },
        });
        let agent!: AgentBase;
        agent = await AgentBase.create(directCtx, {
            id: "direct-metadata",
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            persistence,
            hooks: {
                metadataChangedTransact: async (hookCtx, change) => {
                    observed.push({
                        phase: "transaction",
                        config: agentConfig(hookCtx),
                        change,
                    });
                    try {
                        await agent.updateMetadata(ctx, { recursive: true });
                    } catch (error: unknown) {
                        reentryFailures.push(
                            error instanceof Error ? error.message : String(error),
                        );
                    }
                },
                metadataChanged: (hookCtx, change) => {
                    observed.push({
                        phase: "committed",
                        config: agentConfig(hookCtx),
                        change,
                    });
                },
            },
        });

        await agent.updateMetadata(ctx, { title: "Updated", color: "green" });

        expect(observed).toHaveLength(2);
        expect(observed).toEqual([
            expect.objectContaining({
                phase: "transaction",
                config: {
                    metadata: {
                        title: "Updated",
                        source: "initial",
                        color: "green",
                    },
                },
            }),
            expect.objectContaining({
                phase: "committed",
                config: {
                    metadata: {
                        title: "Updated",
                        source: "initial",
                        color: "green",
                    },
                },
            }),
        ]);
        expect(persistence.values.get("agentConfig")).toEqual({
            metadata: {
                title: "Updated",
                source: "initial",
                color: "green",
            },
        });
        expect(reentryFailures).toEqual([
            expect.stringContaining("must use that transaction's context"),
        ]);
        await agent.close();
    });

    it("merges concurrent metadata updates from the transaction's current configuration", async () => {
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(
            withAgentConfig(ctx, { metadata: { title: "Base" } }),
            {
                id: "concurrent-metadata",
                providers: providersOf(new ScriptedProvider([])),
                provider: "scripted",
                persistence,
            },
        );

        await Promise.all([
            agent.updateMetadata(ctx, { color: "green" }),
            agent.updateMetadata(ctx, { source: "collaboration" }),
        ]);

        expect(persistence.values.get("agentConfig")).toEqual({
            metadata: {
                title: "Base",
                color: "green",
                source: "collaboration",
            },
        });
        await agent.close();
    });

    it("merges immutable metadata transactionally and passes it through every module scope", async () => {
        const manager = new InMemoryPersistence();
        const stores = new Map<string, InMemoryPersistence>();
        const changes: { phase: string; change: AgentMetadataChange }[] = [];
        const scopedMetadata: unknown[] = [];
        let retainedTransaction:
            | { readonly ctx: Context; readonly kv: AgentModuleScope["kv"] }
            | undefined;
        let rejectNext = false;
        const module: AgentModule = {
            name: "metadata-recorder",
            beforeStart: () => ({
                instructions: (hookCtx, scope) => {
                    scopedMetadata.push({
                        config: agentConfig(hookCtx)?.metadata,
                        scope: scope.agent.metadata,
                    });
                    return "";
                },
                metadataChangedTransact: async (hookCtx, scope, change) => {
                    expect(agentConfig(hookCtx)?.metadata).toEqual(change.metadata);
                    expect(scope.agent.metadata).toEqual(change.metadata);
                    await scope.kv.write(hookCtx, "metadata-attempt", change.metadata.title);
                    retainedTransaction = { ctx: hookCtx, kv: scope.kv };
                    changes.push({ phase: "transaction", change });
                    if (rejectNext) throw new Error("metadata rejected");
                },
                metadataChanged: (hookCtx, scope, change) => {
                    expect(agentConfig(hookCtx)?.metadata).toEqual(change.metadata);
                    expect(scope.agent.metadata).toEqual(change.metadata);
                    changes.push({ phase: "committed", change });
                },
            }),
        };
        const system = await AgentSystemLocal.create(ctx, systemStorage(manager, stores), {
            modules: [module],
            providers: providersOf(new ScriptedProvider([textTurn("one"), textTurn("two")])),
            provider: "scripted",
            models: [],
        });
        const supplied = {
            title: "Original",
            owner: { name: "Steve" },
        };
        const agent = await system.create(
            ctx,
            { metadata: supplied },
            { id: ROOT_ID, parent: null },
        );
        supplied.title = "Mutated";
        supplied.owner.name = "Someone else";

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();
        await agent.updateMetadata(ctx, { title: "Renamed", color: "blue" });
        await agent.send(ctx, user("second"));
        await agent.waitForIdle();

        const config = await system.config(ctx, ROOT_ID);
        expect(config?.metadata).toEqual({
            title: "Renamed",
            owner: { name: "Steve" },
            color: "blue",
        });
        expect(Object.isFrozen(config?.metadata)).toBe(true);
        expect(Object.isFrozen(config?.metadata?.owner)).toBe(true);
        expect(scopedMetadata).toEqual([
            {
                config: { title: "Original", owner: { name: "Steve" } },
                scope: { title: "Original", owner: { name: "Steve" } },
            },
            {
                config: {
                    title: "Renamed",
                    owner: { name: "Steve" },
                    color: "blue",
                },
                scope: {
                    title: "Renamed",
                    owner: { name: "Steve" },
                    color: "blue",
                },
            },
        ]);
        expect(changes.map(({ phase }) => phase)).toEqual(["transaction", "committed"]);
        await expect(
            retainedTransaction?.kv.write(retainedTransaction.ctx, "after-commit", true),
        ).rejects.toThrow("work its context belongs to has ended");

        rejectNext = true;
        await expect(system.updateMetadata(ctx, ROOT_ID, { title: "Rejected" })).rejects.toThrow(
            "metadata rejected",
        );
        expect((await system.config(ctx, ROOT_ID))?.metadata?.title).toBe("Renamed");
        expect(
            stores
                .get(ROOT_ID)
                ?.values.get(`kv.${ROOT_ID}.module.metadata-recorder.metadata-attempt`),
        ).toBe("Renamed");
        expect(changes.map(({ phase }) => phase)).toEqual([
            "transaction",
            "committed",
            "transaction",
        ]);
        await system.close(ctx);

        const restarted = await AgentSystemLocal.create(ctx, systemStorage(manager, stores), {
            modules: [],
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });
        expect((await restarted.config(ctx, ROOT_ID))?.metadata).toEqual({
            title: "Renamed",
            owner: { name: "Steve" },
            color: "blue",
        });
        await restarted.close(ctx);
    });

    it("starts a caller-reused ID from a clean per-agent store", async () => {
        const manager = new InMemoryPersistence();
        const stores = new Map<string, InMemoryPersistence>();
        const system = await AgentSystemLocal.create(ctx, systemStorage(manager, stores), {
            providers: providersOf(new ScriptedProvider([textTurn("old answer")])),
            provider: "scripted",
            models: [],
        });
        const original = await system.create(
            ctx,
            { metadata: { title: "Old" } },
            { id: ROOT_ID, parent: null },
        );
        await original.send(ctx, user("old conversation"), {
            id: MESSAGE_ID,
        });
        await original.waitForIdle();
        await system.delete(ctx, ROOT_ID);

        const recreated = await system.create(
            ctx,
            { metadata: { title: "New" } },
            { id: ROOT_ID, parent: null },
        );
        await recreated.waitForIdle();

        const persistence = stores.get(ROOT_ID);
        expect(persistence?.records).toEqual([]);
        // The store holds only the recreated agent's own configuration, which records this as a
        // new creation rather than carrying anything from the agent whose ID it reuses.
        expect([...persistence!.values.entries()]).toEqual([
            [
                "agentConfig",
                { metadata: { title: "New" }, provenance: { createdAt: expect.any(Number) } },
            ],
        ]);
        expect((await system.config(ctx, ROOT_ID))?.metadata).toEqual({ title: "New" });
        await system.close(ctx);
    });

    it("accepts custom cuid2 IDs and keeps durable parent relationships", async () => {
        const manager = new InMemoryPersistence();
        const stores = new Map<string, InMemoryPersistence>();
        let rootRef: AgentSystemRef | undefined;
        const module: AgentModule = {
            name: "capture-reference",
            beforeStart: () => ({
                instructions: (hookCtx: Context, _scope: AgentModuleScope) => {
                    rootRef = agentSystem(hookCtx);
                    return "";
                },
            }),
        };
        const system = await AgentSystemLocal.create(ctx, systemStorage(manager, stores), {
            modules: [module],
            providers: providersOf(new ScriptedProvider([textTurn("root")])),
            provider: "scripted",
            models: [],
        });
        const root = await system.create(ctx, {}, { id: ROOT_ID, parent: null });
        await root.send(ctx, user("capture"));
        await root.waitForIdle();

        expect(root.id).toBe(ROOT_ID);
        expect(rootRef?.agentId).toBe(ROOT_ID);
        const child = await rootRef?.create(ctx, {}, { id: CHILD_ID });
        const explicit = await rootRef?.create(
            ctx,
            {},
            {
                id: EXPLICIT_CHILD_ID,
                parent: ROOT_ID,
            },
        );
        const detached = await rootRef?.create(ctx, {}, { id: DETACHED_ID, parent: null });

        expect(child?.parent).toBe(ROOT_ID);
        expect(explicit?.parent).toBe(ROOT_ID);
        expect(detached?.parent).toBeNull();
        expect(await system.parentOf(ctx, CHILD_ID)).toBe(ROOT_ID);
        expect(await rootRef?.parentOf(ctx, EXPLICIT_CHILD_ID)).toBe(ROOT_ID);
        expect(await system.childOf(ctx, ROOT_ID)).toEqual([CHILD_ID, EXPLICIT_CHILD_ID]);
        expect((await rootRef?.resolve(ctx, CHILD_ID))?.parent).toBe(ROOT_ID);
        await child?.updateMetadata(ctx, { title: "Child" });
        await rootRef?.updateMetadata(ctx, EXPLICIT_CHILD_ID, { title: "Explicit child" });
        expect((await system.config(ctx, CHILD_ID))?.metadata?.title).toBe("Child");
        expect((await system.config(ctx, EXPLICIT_CHILD_ID))?.metadata?.title).toBe(
            "Explicit child",
        );

        await expect(
            rootRef?.create(
                ctx,
                {},
                {
                    id: "x12345678901234567890123",
                    parent: "missing-parent",
                },
            ),
        ).rejects.toThrow('Agent "missing-parent" has not been created');
        await expect(system.create(ctx, {}, { id: "not a cuid2", parent: null })).rejects.toThrow(
            "agent ID must be a cuid2",
        );
        await expect(system.create(ctx, {}, { id: ROOT_ID, parent: null })).rejects.toThrow(
            "already exists",
        );
        await system.close(ctx);

        const restarted = await AgentSystemLocal.create(ctx, systemStorage(manager, stores), {
            modules: [],
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });
        expect(await restarted.parentOf(ctx, CHILD_ID)).toBe(ROOT_ID);
        expect(await restarted.childOf(ctx, ROOT_ID)).toEqual([CHILD_ID, EXPLICIT_CHILD_ID]);
        expect((await new AgentSystemRef(restarted).resolve(ctx, CHILD_ID)).parent).toBe(ROOT_ID);
        await restarted.close(ctx);
    });
});
