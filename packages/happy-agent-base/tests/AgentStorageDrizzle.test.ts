import { sql } from "drizzle-orm";
import { Type } from "@sinclair/typebox";
import {
    afterCommit,
    createContextNamespace,
    createRootContext,
    type Context,
} from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    AgentStorage,
    AgentSystemLocal,
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    defineAgentTool,
    withAgentDatabase,
    type AgentDatabase,
    type AgentModule,
    type AgentStorageLock,
    type AnyAgentTool,
} from "../sources/index.js";
import { AgentPersistenceDrizzle } from "../sources/AgentPersistenceDrizzle.js";
import { inMemoryStorageLock, providersOf, textTurn, user } from "./gym/fixtures.js";
import { databaseBackends } from "./gym/databaseBackends.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agent-storage-drizzle-test");

afterEach(() => vi.restoreAllMocks());

function lock(): (ctx: Context) => Promise<AgentStorageLock> {
    return inMemoryStorageLock();
}

// PGlite boots a WebAssembly PostgreSQL per test, and its cold start under a loaded suite can
// exceed the default five-second budget; the tests themselves are quick once the engine is up.
vi.setConfig({ testTimeout: 30_000 });

describe.each(databaseBackends)("AgentStorage Drizzle persistence ($label)", ({ open }) => {
    it("runs ordered module migrations once before beforeStart and provides the database", async () => {
        const { close, database } = await open();
        const events: string[] = [];
        const module: AgentModule<AnyAgentTool, typeof database> = {
            name: "sample",
            migrations: [
                [
                    "001-create",
                    async (_migrationCtx, migrationDatabase) => {
                        events.push("migration:001");
                        await agentDatabaseRun(
                            migrationDatabase,
                            sql`CREATE TABLE sample_module (value TEXT NOT NULL)`,
                        );
                    },
                ],
                [
                    "002-seed",
                    async (_migrationCtx, migrationDatabase) => {
                        events.push("migration:002");
                        await agentDatabaseRun(
                            migrationDatabase,
                            sql`INSERT INTO sample_module (value) VALUES ('ready')`,
                        );
                    },
                ],
            ],
            beforeStart: async (startCtx) => {
                expect(startCtx.db).toBe(database);
                const rows = await agentDatabaseRows<{ value: string }>(
                    startCtx.db,
                    sql`SELECT value FROM sample_module`,
                );
                expect(rows).toEqual([{ value: "ready" }]);
                events.push("beforeStart");
                return {
                    instructions: (_moduleCtx, scope) => {
                        expect(_moduleCtx.db).toBe(database);
                        expect(scope.agent.id).toBeDefined();
                        return "";
                    },
                };
            },
        };
        const config = {
            modules: [module],
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        };

        const first = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            config,
        );
        await first.close(ctx);
        const second = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            config,
        );
        await second.close(ctx);

        expect(events).toEqual(["migration:001", "migration:002", "beforeStart", "beforeStart"]);
        await close();
    });

    it("rolls back a failed migration marker and never reaches beforeStart", async () => {
        const { close, database } = await open();
        let beforeStart = 0;
        const module: AgentModule = {
            name: "failing",
            migrations: [
                [
                    "001-fails",
                    async (_migrationCtx, migrationDatabase) => {
                        await agentDatabaseRun(
                            migrationDatabase,
                            sql`CREATE TABLE rolled_back_module (value TEXT NOT NULL)`,
                        );
                        throw new Error("migration failed");
                    },
                ],
            ],
            beforeStart: () => {
                beforeStart += 1;
            },
        };
        const storage = new AgentStorage({ acquireLock: lock(), database });

        await expect(
            AgentSystemLocal.create(ctx, storage, {
                modules: [module],
                providers: providersOf(new ScriptedProvider([])),
                provider: "scripted",
                models: [],
            }),
        ).rejects.toThrow("migration failed");

        expect(beforeStart).toBe(0);
        const markers = await agentDatabaseRows<{ migration_key: string }>(
            database,
            sql`SELECT migration_key FROM happy_agent_migrations WHERE module_key = 'failing'`,
        );
        expect(markers).toEqual([]);
        await close();
    });

    it("runs afterCommit immediately outside a transaction and after a successful outer commit", async () => {
        const { close, database } = await open();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const events: string[] = [];
        const nestedValue = createContextNamespace("nested-transaction-value", "missing");

        await new Promise<void>((resolve) => {
            afterCommit(ctx, () => {
                events.push("immediate");
                resolve();
            });
        });
        await storage.kv.transaction(ctx, async (kv, txCtx) => {
            await kv.write(txCtx, "value", "committed");
            afterCommit(txCtx, async () => {
                events.push(String(await storage.kv.read(ctx, "value")));
            });
            afterCommit(ctx, () => {
                events.push("unrelated context");
            });
            events.push("inside");
            await nestedValue.set(txCtx, "preserved").inTx(async (nestedCtx) => {
                expect(nestedValue.get(nestedCtx)).toBe("preserved");
            });
        });

        expect(events).toEqual(["immediate", "inside", "unrelated context", "committed"]);
        await expect(
            storage.kv.transaction(ctx, async (kv, txCtx) => {
                await kv.write(txCtx, "rolled-back", true);
                afterCommit(txCtx, () => {
                    events.push("must not run");
                });
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");
        expect(await storage.kv.read(ctx, "rolled-back")).toBeUndefined();
        expect(events).not.toContain("must not run");

        await storage.kv.write(ctx, "literal%.one", 1);
        await storage.kv.write(ctx, "literal_else", 2);
        await storage.kv.write(ctx, "Case.one", 3);
        await storage.kv.write(ctx, "case.two", 4);
        await storage.kv.write(ctx, "😀.one", 5);
        await storage.kv.write(ctx, "😀x.two", 6);
        expect(await storage.kv.list(ctx, "literal%.")).toEqual([
            { key: "literal%.one", value: 1 },
        ]);
        expect(await storage.kv.list(ctx, "Case.")).toEqual([{ key: "Case.one", value: 3 }]);
        expect(await storage.kv.list(ctx, "😀.")).toEqual([{ key: "😀.one", value: 5 }]);
        await close();
    });

    it("exposes the root database and active transaction through ctx.db and ctx.inTx", async () => {
        const { close, database } = await open();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const rootCtx = withAgentDatabase(ctx, database);
        expect(rootCtx.db).toBe(database);
        let retainedCtx: Context | undefined;
        const events: string[] = [];

        await rootCtx.inTx(async (txCtx) => {
            retainedCtx = txCtx;
            expect(txCtx.db).not.toBe(database);
            expect(agentDatabase(txCtx)).toBe(txCtx.db);
            await storage.kv.write(txCtx, "host-value", "ready");
            await txCtx.inTx(async (nestedCtx) => {
                expect(nestedCtx.db).toBe(txCtx.db);
                afterCommit(nestedCtx, () => {
                    events.push("afterCommit");
                });
            });
            events.push("execute:return");
        });

        expect(events).toEqual(["execute:return", "afterCommit"]);
        expect(await storage.kv.read(rootCtx, "host-value")).toBe("ready");
        const endedCtx = retainedCtx;
        if (endedCtx === undefined) throw new Error("Transaction context was not captured.");
        expect(() => endedCtx.db).toThrow("has ended");
        await expect(endedCtx.inTx(async () => undefined)).rejects.toThrow("has ended");
        await close();
    });

    it("rolls back ctx.inTx work and drops queued post-commit callbacks", async () => {
        const { close, database } = await open();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const rootCtx = withAgentDatabase(ctx, database);
        const events: string[] = [];

        await expect(
            rootCtx.inTx(async (txCtx) => {
                await storage.kv.write(txCtx, "rolled-back", true);
                afterCommit(txCtx, () => {
                    events.push("must not run");
                });
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");

        expect(await storage.kv.read(rootCtx, "rolled-back")).toBeUndefined();
        expect(events).toEqual([]);
        await close();
    });

    it("leaves an explicitly unowned test facade's scheduling to its driver", async () => {
        type TransactionWork = (transaction: AgentDatabase) => Promise<unknown>;
        const database = {
            transaction: async (work: TransactionWork) => await work(database as AgentDatabase),
        } as unknown as AgentDatabase;
        const rootCtx = withAgentDatabase(ctx, database);
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let firstEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            firstEntered = resolve;
        });
        let secondEntered!: () => void;
        const overlapping = new Promise<void>((resolve) => {
            secondEntered = resolve;
        });
        const first = rootCtx.inTx(async () => {
            firstEntered();
            await firstGate;
        });
        await entered;
        const second = rootCtx.inTx(async () => {
            secondEntered();
        });

        await overlapping;
        releaseFirst();
        await Promise.all([first, second]);
    });

    it("rejects ctx.db and ctx.inTx when no agent database is installed", async () => {
        expect(() => ctx.db).toThrow("no agent database");
        await expect(ctx.inTx(async () => undefined)).rejects.toThrow("no agent database");
    });

    it("reuses database context extensions when modules are evaluated again", async () => {
        const firstContexts = await import("../sources/AgentContexts.js");
        const { close, database } = await open();
        const firstCtx = firstContexts.withAgentDatabase(createRootContext(), database);
        expect(firstCtx.db).toBe(database);

        vi.resetModules();
        const reloadedContexts = await import("../sources/AgentContexts.js");
        const reloadedTransactions = await import("../sources/inTx.js");
        const reloadedCtx = reloadedContexts.withAgentDatabase(createRootContext(), database);

        expect(reloadedCtx.db).toBe(database);
        expect(firstContexts.agentDatabase(reloadedCtx)).toBe(database);
        await reloadedCtx.inTx(async (txCtx) => {
            await reloadedTransactions.inTx(txCtx, async (nestedCtx) => {
                expect(nestedCtx.db).toBe(txCtx.db);
            });
        });
        await close();
    });

    it("keeps storage key-value transactions on the same ctx.inTx facade", async () => {
        const { close, database } = await open();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const rootCtx = withAgentDatabase(ctx, database);
        let activeDatabase: AgentDatabase | undefined;

        await rootCtx.inTx(async (txCtx) => {
            activeDatabase = txCtx.db;
            await storage.kv.transaction(txCtx, async (kv, nestedCtx) => {
                expect(nestedCtx.db).toBe(activeDatabase);
                await kv.write(nestedCtx, "nested-value", "ready");
            });
        });

        expect(activeDatabase).toBeDefined();
        expect(activeDatabase).not.toBe(database);
        expect(await storage.kv.read(rootCtx, "nested-value")).toBe("ready");
        await close();
    });

    it("rejects a root context reused inside a transaction instead of leaking its writes", async () => {
        const { close, database } = await open();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);

        await expect(
            withAgentDatabase(ctx, database).inTx(async (txCtx) => {
                await expect(storage.kv.write(ctx, "wrong-context", true)).rejects.toThrow(
                    "must use that transaction's context",
                );
                await storage.kv.write(txCtx, "rolled-back", true);
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");

        expect(await storage.kv.read(ctx, "wrong-context")).toBeUndefined();
        expect(await storage.kv.read(ctx, "rolled-back")).toBeUndefined();
        await close();
    });

    it("routes foreign root contexts to the right store and rejects foreign transactions", async () => {
        const first = await open();
        const second = await open();
        const firstStorage = new AgentStorage({
            acquireLock: lock(),
            database: first.database,
        });
        const secondStorage = new AgentStorage({
            acquireLock: lock(),
            database: second.database,
        });
        await firstStorage.migrate(ctx, []);
        await secondStorage.migrate(ctx, []);
        const firstRootCtx = withAgentDatabase(ctx, first.database);

        await secondStorage.kv.write(firstRootCtx, "belongs-to-second", true);
        expect(await firstStorage.kv.read(ctx, "belongs-to-second")).toBeUndefined();
        expect(await secondStorage.kv.read(ctx, "belongs-to-second")).toBe(true);

        await withAgentDatabase(ctx, first.database).inTx(async (firstTxCtx) => {
            await expect(
                secondStorage.kv.write(firstTxCtx, "must-not-cross", true),
            ).rejects.toThrow("another agent storage");
        });
        expect(await firstStorage.kv.read(ctx, "must-not-cross")).toBeUndefined();
        expect(await secondStorage.kv.read(ctx, "must-not-cross")).toBeUndefined();
        await first.close();
        await second.close();
    });

    it("publishes a transactionally created agent idle until it receives work", async () => {
        const { close, database } = await open();
        const provider = new ScriptedProvider([textTurn("answer")]);
        let loops = 0;
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            modules: [
                {
                    name: "transactional-loop-observer",
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
        });

        const agent = await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            const created = await system.create(
                txCtx,
                {},
                {
                    id: "h12345678901234567890123",
                },
            );
            expect(created.active).toBe(false);
            expect(provider.sessions).toHaveLength(0);
            return created;
        });
        await agent.waitForIdle();

        expect(agent.active).toBe(false);
        expect(loops).toBe(0);
        expect(provider.sessions).toHaveLength(0);

        await agent.send(ctx, user("answer this"));
        await agent.waitForIdle();

        expect(loops).toBe(1);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await system.close(ctx);
        await close();
    });

    it("queues live send and steer messages inside an outer transaction and starts after commit", async () => {
        const { close, database } = await open();
        const provider = new ScriptedProvider([textTurn("steered"), textTurn("committed")]);
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();
        const rootCtx = withAgentDatabase(ctx, database);

        const accepted = await rootCtx.inTx(async (txCtx) => {
            const result = await system.send(txCtx, agent.id, user("inside transaction"), {
                id: "h12345678901234567890123",
            });
            expect(
                await agent.steer(txCtx, user("transactional steering"), {
                    id: "h12345678901234567890127",
                }),
            ).toEqual({
                accepted: "created",
                delivery: "steer",
                id: "h12345678901234567890127",
            });
            expect(result.accepted).toBe("created");
            expect(agent.active).toBe(false);
            expect(provider.sessions).toEqual([]);
            return result;
        });

        expect(accepted).toEqual({
            accepted: "created",
            delivery: "send",
            id: "h12345678901234567890123",
        });
        await agent.waitForIdle();
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("transactional steering"),
        );
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(
            user("inside transaction"),
        );
        await system.close(ctx);
        await close();
    });

    it("merges transactional steering after a tool batch without reloading history", async () => {
        const loadHistory = vi.spyOn(AgentPersistenceDrizzle.prototype, "load");
        const { close, database } = await open();
        const rootCtx = withAgentDatabase(ctx, database);
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "steer" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("answered with steering"),
        ]);
        let agentId = "";
        let system!: AgentSystemLocal<typeof database>;
        const steeringTool = defineAgentTool({
            name: "steer",
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => {
                await rootCtx.inTx(async (txCtx) => {
                    await system.steer(txCtx, agentId, user("transactional steering"), {
                        id: "h12345678901234567890145",
                    });
                });
                return { value: "finished" };
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const module: AgentModule<AnyAgentTool, typeof database> = {
            name: "transactional-steering-test",
            beforeStart: () => ({ tools: () => [steeringTool] }),
        };
        system = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            {
                models: [],
                modules: [module],
                provider: "scripted",
                providers: providersOf(provider),
            },
        );
        const agent = await system.create(ctx, {});
        agentId = agent.id;

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        const historyLoads = loadHistory.mock.calls.length;
        await system.close(ctx);
        await close();
        expect(historyLoads).toBe(1);
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            {
                role: "tool",
                callId: "call-1",
                content: [{ type: "text", text: "finished" }],
            },
            user("transactional steering"),
        ]);
    });

    it("transactionally delivers to an unloaded idle target", async () => {
        const { close, database } = await open();
        const setup = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(new ScriptedProvider([])), provider: "scripted", models: [] },
        );
        const created = await setup.create(ctx, {});
        await created.waitForIdle();
        await setup.close(ctx);

        // A fresh process instantiates only agents with work left, so the target is not live.
        const provider = new ScriptedProvider([textTurn("delivered")]);
        const system = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(provider), provider: "scripted", models: [] },
        );
        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await system.send(txCtx, created.id, user("load on delivery"), {
                id: "h12345678901234567890141",
            });
        });
        const agent = await system.resolve(ctx, created.id);
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("load on delivery"),
        );
        await system.close(ctx);
        await close();
    });

    it("reuses one unloaded target for two sends in the same transaction", async () => {
        const { close, database } = await open();
        const setup = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(new ScriptedProvider([])), provider: "scripted", models: [] },
        );
        const created = await setup.create(ctx, {});
        await created.waitForIdle();
        await setup.close(ctx);

        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const system = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(provider), provider: "scripted", models: [] },
        );
        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await system.send(txCtx, created.id, user("first"), {
                id: "h12345678901234567890143",
            });
            await system.send(txCtx, created.id, user("second"), {
                id: "h12345678901234567890144",
            });
        });
        const agent = await system.resolve(ctx, created.id);
        await agent.waitForIdle();
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(user("first"));
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(user("second"));

        await system.close(ctx);
        await close();
    });

    it("reuses the canonical agent when resolution publishes during transactional loading", async () => {
        const opened = await open();
        const { close, connection, database } = opened;
        const setup = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(new ScriptedProvider([])), provider: "scripted", models: [] },
        );
        const created = await setup.create(ctx, {});
        await created.waitForIdle();
        await setup.close(ctx);

        const provider = new ScriptedProvider([textTurn("delivered once")]);
        const system = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(provider), provider: "scripted", models: [] },
        );
        const resolverRead = deferred<void>();
        const releaseResolver = deferred<void>();
        const transactionRead = deferred<void>();
        const releaseTransaction = deferred<void>();
        const originalOperation = connection.operation.bind(connection) as (
            facade: AgentDatabase,
            work: () => Promise<unknown>,
        ) => Promise<unknown>;
        let rootReads = 0;
        let interceptTransaction = false;
        let transactionIntercepted = false;
        Object.defineProperty(connection, "operation", {
            configurable: true,
            value: async (facade: AgentDatabase, work: () => Promise<unknown>) => {
                const result = await originalOperation(facade, work);
                if (facade === database && !interceptTransaction) {
                    rootReads += 1;
                    if (rootReads === 4) {
                        resolverRead.resolve();
                        await releaseResolver.promise;
                    }
                } else if (facade !== database && interceptTransaction && !transactionIntercepted) {
                    transactionIntercepted = true;
                    transactionRead.resolve();
                    await releaseTransaction.promise;
                }
                return result;
            },
        });

        const resolving = system.resolve(ctx, created.id);
        await resolverRead.promise;
        interceptTransaction = true;
        const sending = withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await system.send(txCtx, created.id, user("concurrent delivery"), {
                id: "h12345678901234567890145",
            });
        });
        await transactionRead.promise;
        releaseResolver.resolve();
        const canonical = await resolving;
        releaseTransaction.resolve();
        await sending;
        expect(await system.resolve(ctx, created.id)).toBe(canonical);
        await canonical.waitForIdle();
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("concurrent delivery"),
        );

        await system.close(ctx);
        await close();
    });

    it("leaves a loaded target idle when its transactional send rolls back", async () => {
        const { close, database } = await open();
        const setup = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(new ScriptedProvider([])), provider: "scripted", models: [] },
        );
        const created = await setup.create(ctx, {});
        await created.waitForIdle();
        await setup.close(ctx);

        const provider = new ScriptedProvider([textTurn("after rollback")]);
        const system = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(provider), provider: "scripted", models: [] },
        );
        await expect(
            withAgentDatabase(ctx, database).inTx(async (txCtx) => {
                await system.send(txCtx, created.id, user("rolled back"), {
                    id: "h12345678901234567890142",
                });
                throw new Error("roll back the load");
            }),
        ).rejects.toThrow("roll back the load");

        // The provisional object was never published and the rolled-back message is not durable.
        expect(provider.sessions).toEqual([]);
        await system.send(ctx, created.id, user("after rollback"));
        const agent = await system.resolve(ctx, created.id);
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("after rollback"),
        ]);
        await system.close(ctx);
        await close();
    });

    it("claims a distinct queue key for every send inside one transaction", async () => {
        const { close, database } = await open();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();

        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await agent.send(txCtx, user("first in transaction"), {
                id: "h12345678901234567890131",
            });
            await agent.send(txCtx, user("second in transaction"), {
                id: "h12345678901234567890132",
            });
        });
        await agent.waitForIdle();

        // Both sends landed under their own key and arrive in the order they were accepted.
        const requests = provider.sessions[0]?.requests ?? [];
        const seen = requests.at(-1)?.context.messages ?? [];
        const first = seen.findIndex(
            (message) => JSON.stringify(message) === JSON.stringify(user("first in transaction")),
        );
        const second = seen.findIndex(
            (message) => JSON.stringify(message) === JSON.stringify(user("second in transaction")),
        );
        expect(first).toBeGreaterThanOrEqual(0);
        expect(second).toBeGreaterThan(first);
        await system.close(ctx);
        await close();
    });

    it("reloads a transactional message committed while the target is already running", async () => {
        const { close, database } = await open();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let releaseInference!: () => void;
        const inferenceMayContinue = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        let inferenceEntered!: () => void;
        const inInference = new Promise<void>((resolve) => {
            inferenceEntered = resolve;
        });
        let blockFirstInference = true;
        const gate: AgentModule = {
            name: "transactional-message-gate",
            beforeStart: () => ({
                beforeInference: async () => {
                    if (!blockFirstInference) return;
                    blockFirstInference = false;
                    inferenceEntered();
                    await inferenceMayContinue;
                },
            }),
        };
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            modules: [gate],
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.send(ctx, user("already running"));
        await inInference;

        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await agent.send(txCtx, user("committed while running"), {
                id: "h12345678901234567890125",
            });
            expect(provider.sessions[0]?.requests).toEqual([]);
        });
        releaseInference();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("already running"),
        );
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(
            user("committed while running"),
        );
        await system.close(ctx);
        await close();
    });

    it("drops every live effect when an outer transactional send rolls back", async () => {
        const { close, database } = await open();
        const provider = new ScriptedProvider([textTurn("retried")]);
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();
        const rootCtx = withAgentDatabase(ctx, database);
        const messageId = "h12345678901234567890124";

        await expect(
            rootCtx.inTx(async (txCtx) => {
                expect(
                    await agent.send(txCtx, user("rolled back"), {
                        id: messageId,
                    }),
                ).toEqual({
                    accepted: "created",
                    delivery: "send",
                    id: messageId,
                });
                expect(agent.active).toBe(false);
                expect(provider.sessions).toEqual([]);
                throw new Error("roll back message");
            }),
        ).rejects.toThrow("roll back message");

        expect(agent.active).toBe(false);
        expect(provider.sessions).toEqual([]);
        expect(
            await agent.send(ctx, user("retry after rollback"), {
                id: messageId,
            }),
        ).toEqual({
            accepted: "created",
            delivery: "send",
            id: messageId,
        });
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("retry after rollback"),
        ]);
        await system.close(ctx);
        await close();
    });

    it("finishes a live transactional delete before the identity can be recreated", async () => {
        const { close, database } = await open();
        const inferenceStarted = deferred<void>();
        const releaseInference = deferred<void>();
        const module: AgentModule = {
            name: "block-inference",
            beforeStart: () => ({
                beforeInference: async () => {
                    inferenceStarted.resolve();
                    await releaseInference.promise;
                },
            }),
        };
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            modules: [module],
            providers: providersOf(new ScriptedProvider([textTurn("done")])),
            provider: "scripted",
            models: [],
        });
        const agentId = "h12345678901234567890123";
        const original = await system.create(
            ctx,
            { metadata: { title: "original" } },
            { id: agentId },
        );
        await original.send(ctx, user("run"));
        await inferenceStarted.promise;

        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await system.delete(txCtx, agentId);
            await expect(system.resolve(txCtx, agentId)).rejects.toThrow("has not been created");
            await expect(system.create(txCtx, {}, { id: agentId })).rejects.toThrow(
                "cannot be recreated until its deleting transaction commits",
            );
        });

        let recreated = false;
        const creating = system
            .create(ctx, { metadata: { title: "replacement" } }, { id: agentId })
            .then((agent) => {
                recreated = true;
                return agent;
            });
        await Promise.resolve();
        expect(recreated).toBe(false);
        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await expect(system.resolve(txCtx, agentId)).rejects.toThrow(
                "still finishing deletion",
            );
            await expect(system.create(txCtx, {}, { id: agentId })).rejects.toThrow(
                "still finishing deletion",
            );
        });
        releaseInference.resolve();
        const replacement = await creating;

        expect(replacement).not.toBe(original);
        expect(await system.resolve(ctx, agentId)).toBe(replacement);
        expect(await system.config(ctx, agentId)).toEqual({
            metadata: { title: "replacement" },
            provenance: { createdAt: expect.any(Number) },
        });
        await expect(original.updateMetadata(ctx, { stale: true })).rejects.toThrow("closed");
        await system.close(ctx);
        await close();
    });

    it("drops transactional live commands when the outer transaction rolls back", async () => {
        const { close, database } = await open();
        const provider = new ScriptedProvider([]);
        let metadataObserved = 0;
        const module: AgentModule = {
            name: "metadata-observer",
            beforeStart: () => ({
                metadataChanged: () => {
                    metadataObserved += 1;
                },
            }),
        };
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            modules: [module],
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        const createdId = "h12345678901234567890123";

        await expect(
            withAgentDatabase(ctx, database).inTx(async (txCtx) => {
                await system.create(txCtx, {}, { id: createdId });
                await agent.updateMetadata(txCtx, { title: "rolled back" });
                await agent.compact(txCtx);
                await agent.abort(txCtx);
                await system.delete(txCtx, agent.id);
                await system.close(txCtx);
                throw new Error("roll back live commands");
            }),
        ).rejects.toThrow("roll back live commands");

        expect(await system.resolve(ctx, agent.id)).toBe(agent);
        expect(await system.config(ctx, agent.id)).toEqual({
            provenance: { createdAt: expect.any(Number) },
        });
        await expect(system.resolve(ctx, createdId)).rejects.toThrow("has not been created");
        expect(metadataObserved).toBe(0);
        expect(provider.sessions).toEqual([]);
        await system.close(ctx);
        await close();
    });

    it("allows every live agent and system command from an outer storage transaction", async () => {
        const { close, database } = await open();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();
        const createdId = "h12345678901234567890123";

        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            const created = await system.create(txCtx, {}, { id: createdId });
            expect(await system.resolve(txCtx, createdId)).toBe(created);
            await agent.updateMetadata(txCtx, { direct: true });
            await system.updateMetadata(txCtx, agent.id, { title: "committed" });
            await agent.compact(txCtx);
            await agent.abort(txCtx);
            await system.delete(txCtx, createdId);
        });

        expect(await system.config(ctx, agent.id)).toEqual({
            metadata: { direct: true, title: "committed" },
            provenance: { createdAt: expect.any(Number) },
        });
        expect(await system.config(ctx, createdId)).toBeUndefined();
        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await system.close(txCtx);
        });
        await system.close(ctx);
        await expect(system.config(ctx, agent.id)).rejects.toThrow("closed");
        await close();
    });
});

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    resolve(value: Value): void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
