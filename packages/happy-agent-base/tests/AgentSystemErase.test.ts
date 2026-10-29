import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    AgentStorage,
    AgentSystemLocal,
    AgentSystemRef,
    withAgentDatabase,
    type AgentModule,
} from "../sources/index.js";
import { inMemoryStorageLock, providersOf, textTurn, user } from "./gym/fixtures.js";
import { databaseBackends } from "./gym/databaseBackends.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agent-system-erase-test");

vi.setConfig({ testTimeout: 30_000 });

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe.each(databaseBackends)("erasing an agent ($label)", ({ open }) => {
    /** A system whose one module keeps a value in every agent's store and records lifecycles. */
    async function erasable(options: { readonly blockInference?: Promise<void> } = {}) {
        const { close, database } = await open();
        const events: string[] = [];
        const inferenceStarted = deferred();
        const module: AgentModule = {
            name: "remembers",
            beforeStart: () => ({
                messageAcceptedTransact: async (hookCtx, scope) => {
                    await scope.kv.write(hookCtx, "note", "remembered");
                },
                beforeInference: async () => {
                    inferenceStarted.resolve();
                    await options.blockInference;
                },
                agentArchivedTransact: (_hookCtx, _scope, agent) => {
                    events.push(`archived:${agent.id}`);
                },
                agentErasedTransact: (_hookCtx, _scope, agent) => {
                    events.push(`erased:${agent.id}`);
                },
                agentErased: (_hookCtx, _scope, agent) => {
                    events.push(`erased-after-commit:${agent.id}`);
                },
            }),
        };
        const storage = new AgentStorage({ acquireLock: inMemoryStorageLock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            modules: [module],
            providers: providersOf(
                new ScriptedProvider([textTurn("one"), textTurn("two"), textTurn("three")]),
            ),
            provider: "scripted",
            models: [],
        });
        const dbCtx = withAgentDatabase(ctx, database);
        const stored = async (agentId: string) => {
            const persistence = storage.persistence(agentId);
            return {
                records: (await persistence.load(dbCtx)).length,
                values: (await persistence.readValues(dbCtx, "")).map(({ key }) => key),
            };
        };
        return { close, system, storage, dbCtx, events, stored, inferenceStarted };
    }

    it("keeps what a deleted agent wrote unless asked to erase it", async () => {
        const { close, system, dbCtx, events, stored } = await erasable();
        const kept = await system.create(ctx, {}, { id: "keptagent" });
        await kept.send(ctx, user("hello"));
        await kept.waitForIdle();
        await system.delete(ctx, "keptagent");
        expect((await stored("keptagent")).records).toBeGreaterThan(0);
        expect(events).toEqual(["archived:keptagent"]);

        const erased = await system.create(
            ctx,
            { metadata: { title: "Gone" } },
            { id: "goneagent" },
        );
        await erased.send(ctx, user("hello"));
        await erased.waitForIdle();
        const before = await stored("goneagent");
        expect(before.records).toBeGreaterThan(0);
        expect(before.values).toEqual(expect.arrayContaining(["agentConfig"]));
        expect(before.values.some((key) => key.includes("note"))).toBe(true);

        await system.delete(ctx, "goneagent", { erase: true });
        expect(await stored("goneagent")).toEqual({ records: 0, values: [] });
        expect(await system.config(dbCtx, "goneagent")).toBeUndefined();
        await vi.waitFor(() =>
            expect(events).toEqual([
                "archived:keptagent",
                "archived:goneagent",
                "erased:goneagent",
                "erased-after-commit:goneagent",
            ]),
        );
        await system.close(ctx);
        await close();
    });

    it("erases a running agent from a reference without waiting for its loop", async () => {
        const release = deferred();
        const { close, system, dbCtx, stored, inferenceStarted } = await erasable({
            blockInference: release.promise,
        });
        const parent = await system.create(ctx, {}, { id: "parentagent", parent: null });
        await system.create(ctx, {}, { id: "childagent", parent: parent.id });
        const busy = await system.create(ctx, {}, { id: "busyagent", parent: null });
        await busy.send(ctx, user("work"));
        await inferenceStarted.promise;

        // The busy agent's loop is still inside inference, and the erase returns all the same.
        await new AgentSystemRef(system).erase(dbCtx, "busyagent");
        release.resolve();
        // Reading the identity waits for the close the erase left to run after its commit.
        expect(await system.config(ctx, "busyagent")).toBeUndefined();
        // Once its close has settled the stopped turn, whatever that wrote is erased too.
        await vi.waitFor(async () =>
            expect(await stored("busyagent")).toEqual({ records: 0, values: [] }),
        );
        await system.close(ctx);
        await close();
    });

    it("refuses to erase the asking agent or one of its ancestors", async () => {
        const { close, system, dbCtx } = await erasable();
        await system.create(ctx, {}, { id: "rootagent", parent: null });
        await system.create(ctx, {}, { id: "middleagent", parent: "rootagent" });
        await system.create(ctx, {}, { id: "leafagent", parent: "middleagent" });
        await system.create(ctx, {}, { id: "otheragent", parent: null });
        const fromLeaf = new AgentSystemRef(system, "leafagent");
        for (const target of ["leafagent", "middleagent", "rootagent"]) {
            await expect(fromLeaf.erase(dbCtx, target)).rejects.toThrow(
                "cannot be erased by itself or by an agent below it",
            );
            expect(await system.config(ctx, target)).toBeDefined();
        }
        await fromLeaf.erase(dbCtx, "otheragent");
        expect(await system.config(ctx, "otheragent")).toBeUndefined();
        // Erasing a parent leaves its children as roots.
        await new AgentSystemRef(system).erase(dbCtx, "middleagent");
        expect(await system.parentOf(ctx, "leafagent")).toBeNull();
        await system.close(ctx);
        await close();
    });
});
