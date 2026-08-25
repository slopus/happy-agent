import {
    agentDatabaseRun,
    type AgentModuleScope,
    type AgentSystemRef,
    withAgentContext,
} from "@slopus/happy-agent-base";
import { withAfterCommit, withLogger, type Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import {
    MAX_USAGE_GROUPS,
    MAX_USAGE_OUTPUT_CHARACTERS,
    MAX_USAGE_TREE_PATH_LENGTH,
    MAX_USAGE_TREE_SESSIONS,
    type UsageAgentTree,
    type UsageInferenceRecord,
    type UsageSummary,
    type UsageTurnRecord,
} from "../../sources/usage/Usage.js";
import {
    USAGE_GROUP_PAGE_SIZE,
    USAGE_OUTPUT_CHARACTERS,
    USAGE_PAGE_SIZE,
    UsageModule,
} from "../../sources/usage/UsageModule.js";
import { UsageDatabase } from "../../sources/usage/impl/usageDatabase.js";
import type { UsageEvent } from "../../sources/usage/UsageEvent.js";
import { getAgentTreeUsageTool } from "../../sources/usage/tools/get_agent_tree_usage.js";
import { getUsageTool } from "../../sources/usage/tools/get_usage.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

class FakeKV {
    readonly values = new Map<string, unknown>();

    async read(_ctx: Context, key: string): Promise<unknown> {
        return structuredClone(this.values.get(key));
    }

    async write(_ctx: Context, key: string, value: unknown): Promise<void> {
        this.values.set(key, structuredClone(value));
    }

    async delete(_ctx: Context, key: string): Promise<void> {
        this.values.delete(key);
    }
}

type UsageDatabaseHandle = ModuleDatabase & {
    readonly database: import("@slopus/happy-agent-base").AgentDatabase;
};

async function withUsageDatabase<T>(
    name: string,
    callback: (database: UsageDatabaseHandle) => Promise<T>,
): Promise<T> {
    const events = new EventsModule();
    const database = moduleDatabase(events.migrations, name) as UsageDatabaseHandle;
    await database.ready;
    await events.beforeStart?.(database.context);
    const module = new UsageModule(events);
    try {
        for (const [, migration] of module.migrations) {
            await migration(database.context, database.database);
        }
        return await callback(database);
    } finally {
        database.close();
    }
}

function makeScope(
    database: UsageDatabaseHandle["database"],
    runKV = new FakeKV(),
    overrides: Record<string, unknown> = {},
): AgentModuleScope {
    return {
        database,
        agent: {
            id: "agent-1",
            provider: "provider-main",
            providerKind: "codex",
            model: "model-main",
            effort: "high",
            tier: "priority",
            permissionMode: "auto",
            ...overrides,
        },
        kv: new FakeKV(),
        sharedKV: new FakeKV(),
        runKV,
    } as never;
}

async function runWithAfterCommit<T>(
    ctx: Context,
    callback: (txCtx: Context) => Promise<T>,
): Promise<T> {
    const [txCtx, drain] = withAfterCommit(ctx);
    const result = await callback(txCtx);
    await drain();
    return result;
}

function inferenceRecord(
    id: string,
    agentId: string,
    finishedAt: number,
    overrides: Partial<UsageInferenceRecord> = {},
): UsageInferenceRecord {
    const startedAt = overrides.startedAt ?? finishedAt - 10;
    return {
        id,
        agentId,
        provider: "provider-main",
        model: "model-main",
        effort: "high",
        tier: "priority",
        kind: "inference",
        state: "normal",
        tokens: { input: 3, output: 2 },
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ...overrides,
    };
}

function turnRecord(
    id: string,
    agentId: string,
    finishedAt: number,
    overrides: Partial<UsageTurnRecord> = {},
): UsageTurnRecord {
    const startedAt = overrides.startedAt ?? finishedAt - 10;
    return {
        id,
        agentId,
        provider: "provider-main",
        model: "model-main",
        effort: "high",
        tier: "priority",
        kind: "turn",
        aborted: false,
        contextTokens: 25,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ...overrides,
    };
}

async function insertRawRecord(
    database: UsageDatabaseHandle,
    record: UsageInferenceRecord | UsageTurnRecord,
): Promise<void> {
    await agentDatabaseRun(
        database.database,
        sql`INSERT INTO happy_agent_usage_records
            (record_id, agent_id, run_id, finished_at, kind, record_json)
            VALUES (${record.id}, ${record.agentId}, ${record.runId ?? null},
                    ${record.finishedAt}, ${record.kind}, ${JSON.stringify(record)})`,
    );
}

function agentContext(ctx: Context, id = "agent-1"): Context {
    return withAgentContext(ctx, {
        id,
        provider: "provider-main",
        model: "model-main",
        effort: "high",
        serviceTier: "priority",
        permissionMode: "auto",
    });
}

/**
 * A collection of agents shaped the way the usage module uses `AgentSystemRef`: who an agent's
 * parent is, what it started, and how it was configured.
 */
function fakeAgents(
    roster: Readonly<Record<string, { readonly parent?: string; readonly createdBy?: string }>>,
): AgentSystemRef {
    return {
        parentOf: (_ctx: Context, agentId: string): Promise<string | null> =>
            Promise.resolve(roster[agentId]?.parent ?? null),
        childOf: (_ctx: Context, agentId: string): Promise<readonly string[]> =>
            Promise.resolve(Object.keys(roster).filter((id) => roster[id]?.parent === agentId)),
        config: (_ctx: Context, agentId: string): Promise<unknown> => {
            const agent = roster[agentId];
            if (agent === undefined) return Promise.resolve(undefined);
            return Promise.resolve(
                agent.createdBy === undefined
                    ? {}
                    : { provenance: { createdAt: 0, createdBy: agent.createdBy } },
            );
        },
    } as unknown as AgentSystemRef;
}

/** A module already started against a collection, the way the system starts one. */
async function startedModule(ctx: Context, agents: AgentSystemRef): Promise<UsageModule> {
    const module = new UsageModule(new EventsModule());
    await resolveModuleHooks(ctx, module, agents);
    return module;
}

/**
 * The same context with a log a test can read.
 *
 * Usage reports every advisory failure through `ctx.log.warn`, so the log is where a test sees
 * one. Nothing else about the context changes.
 */
function capturingContext(ctx: Context): [Context, readonly unknown[][]] {
    const warnings: unknown[][] = [];
    const context = withLogger(ctx, {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (_logContext, ...args) => {
            warnings.push(args);
        },
        error: () => {},
        fatal: () => {},
    });
    return [context, warnings];
}

/** The phases an advisory usage failure was reported for. */
function warnedPhases(warnings: readonly unknown[][]): readonly string[] {
    return warnings.map((warning) => (warning[1] as { readonly phase: string }).phase);
}

describe("UsageModule edge cases", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("preserves provider attribution, error state, and aborted turn fields", async () => {
        await withUsageDatabase("usage-attribution-fields", async (database) => {
            // Only the clock is moved; the database and its promises keep real timers.
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(100);
            const module = new UsageModule(new EventsModule());
            const hooks = await resolveModuleHooks(database.context, module);
            const runKV = new FakeKV();
            const scope = makeScope(database.database, runKV);

            await hooks.beforeInferenceTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "inference",
                contextTokens: undefined,
            });
            vi.setSystemTime(140);
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterInferenceTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    inferenceId: "inference",
                    contextTokens: undefined,
                    state: "error",
                    errorMessage: "provider failed",
                    tokens: { input: 9, output: 2 },
                });
            });

            await hooks.beforeTurnTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                contextTokens: undefined,
            });
            vi.setSystemTime(150);
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterTurnTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: 0,
                    aborted: true,
                });
            });

            await expect(
                database.context.inTx(async (ctx) => module.readPage(ctx, "agent-1")),
            ).resolves.toMatchObject({
                records: [
                    {
                        id: "inference",
                        provider: "provider-main",
                        model: "model-main",
                        effort: "high",
                        tier: "priority",
                        state: "error",
                        errorMessage: "provider failed",
                        durationMs: 40,
                    },
                    {
                        id: "turn",
                        aborted: true,
                        contextTokens: 0,
                        durationMs: 10,
                    },
                ],
            });
        });
    });

    it("treats missing provider tokens as an advisory observation failure and clears pending state", async () => {
        await withUsageDatabase("usage-missing-tokens", async (database) => {
            const [ctx, warnings] = capturingContext(database.context);
            const module = new UsageModule(new EventsModule());
            const hooks = await resolveModuleHooks(ctx, module);
            const runKV = new FakeKV();
            const scope = makeScope(database.database, runKV);

            await hooks.beforeInferenceTransact!(ctx, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "missing",
                contextTokens: undefined,
            });
            await runWithAfterCommit(ctx, async (txCtx) => {
                await hooks.afterInferenceTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    inferenceId: "missing",
                    contextTokens: undefined,
                    state: "normal",
                    tokens: undefined,
                });
            });

            expect(runKV.values).toEqual(new Map());
            expect((await module.readPage(database.context, "agent-1")).records).toEqual([]);
            expect(warnedPhases(warnings)).toEqual(["after_inference"]);
            expect(warnings[0]?.[2]).toMatchObject({
                message: expect.stringContaining("token"),
            });
        });
    });

    it("rejects clocks that move backward or exceed duration bounds without failing the turn", async () => {
        await withUsageDatabase("usage-clock-errors", async (database) => {
            const [ctx, warnings] = capturingContext(database.context);
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(200);
            const module = new UsageModule(new EventsModule());
            const hooks = await resolveModuleHooks(ctx, module);
            const scope = makeScope(database.database);

            await hooks.beforeTurnTransact!(ctx, scope, {
                loopId: "loop",
                turnId: "turn",
                contextTokens: undefined,
            });
            vi.setSystemTime(100);
            await runWithAfterCommit(ctx, async (txCtx) => {
                await hooks.afterTurnTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: undefined,
                    aborted: false,
                });
            });

            expect((await module.readPage(database.context, "agent-1")).records).toEqual([]);
            expect(warnedPhases(warnings)).toEqual(["after_turn"]);
            expect(warnings[0]?.[2]).toMatchObject({
                message: expect.stringContaining("backwards"),
            });
        });
    });

    it("survives a fresh module instance and rejects malformed JSON at the persistence boundary", async () => {
        await withUsageDatabase("usage-reload-and-malformed-json", async (database) => {
            await insertRawRecord(database, inferenceRecord("reload", "agent-1", 10));
            const fresh = new UsageModule(new EventsModule());
            await expect(fresh.readPage(database.context, "agent-1")).resolves.toMatchObject({
                totalRecords: 1,
                records: [{ id: "reload" }],
            });

            await agentDatabaseRun(
                database.database,
                sql`UPDATE happy_agent_usage_records
                    SET record_json = '{malformed'
                    WHERE record_id = 'reload'`,
            );
            await expect(fresh.readPage(database.context, "agent-1")).rejects.toThrow();
            await expect(
                fresh.aggregate(database.context, { agentId: "agent-1" }),
            ).rejects.toThrow();
        });
    });

    it("rejects semantically invalid persisted duration from raw-page reads", async () => {
        await withUsageDatabase("usage-invalid-persisted-duration", async (database) => {
            const invalid = inferenceRecord("invalid-duration", "agent-1", 20, {
                durationMs: 999,
            });
            await insertRawRecord(database, invalid);
            await expect(
                new UsageModule(new EventsModule()).readPage(database.context, "agent-1"),
            ).rejects.toThrow("duration");
        });
    });

    it("rejects semantically invalid persisted duration from aggregate reads", async () => {
        await withUsageDatabase("usage-invalid-aggregate-duration", async (database) => {
            const invalid = inferenceRecord("invalid-aggregate-duration", "agent-1", 20, {
                durationMs: 999,
            });
            await insertRawRecord(database, invalid);
            /*
             * Aggregate parsing must enforce the same semantic invariants as
             * readPage.  A shape-valid but inconsistent row must never become
             * a trusted total.
             */
            await expect(
                new UsageModule(new EventsModule()).aggregate(database.context, {
                    agentId: "agent-1",
                }),
            ).rejects.toThrow("duration");
        });
    });

    it("keeps every record forever and exposes precise page cursors", async () => {
        await withUsageDatabase("usage-retention-and-cursors", async (database) => {
            const store = new UsageDatabase();
            const total = 501;
            for (let index = 0; index < total; index++) {
                await store.record(
                    database.context,
                    inferenceRecord(`record-${index}`, "agent-1", index + 10),
                );
            }
            const module = await startedModule(database.context, fakeAgents({ "agent-1": {} }));
            const first = await module.readPage(database.context, "agent-1", { limit: 7 });
            expect(first.records).toHaveLength(7);
            // Nothing was evicted, so the oldest record is still the very first one written.
            expect(first.records[0]?.id).toBe("record-0");
            expect(first.nextCursor).toBe(7);
            if (first.nextCursor === undefined) throw new Error("Expected a continuation cursor");
            const second = await module.readPage(database.context, "agent-1", {
                cursor: first.nextCursor,
                limit: 7,
            });
            expect(second.cursor).toBe(7);
            expect(second.records[0]?.id).toBe("record-7");
            expect(second.nextCursor).toBe(14);
            const final = await module.readPage(database.context, "agent-1", {
                cursor: total - 3,
                limit: 7,
            });
            expect(final.records).toHaveLength(3);
            expect(final.nextCursor).toBeUndefined();
            expect(final.totalRecords).toBe(total);
            await expect(module.readAgentModelUsage(database.context, "agent-1")).resolves.toEqual({
                "provider-main": {
                    "model-main": {
                        input: 3 * total,
                        output: 2 * total,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                },
            });
            await expect(
                module.readAgentTreeUsage(database.context, "agent-1"),
            ).resolves.toMatchObject({ totalTokens: 5 * total });
            // The aggregate counts every record rather than the newest page of them.
            await expect(module.read(database.context, "agent-1")).resolves.toMatchObject({
                inferenceCount: total,
            });
        });
    });

    it("rejects semantically invalid persisted duration from run and window reads", async () => {
        await withUsageDatabase("usage-invalid-token-duration", async (database) => {
            const invalid = inferenceRecord("invalid-token-duration", "agent-1", 20, {
                runId: "run-1",
                durationMs: 999,
            });
            await insertRawRecord(database, invalid);
            const module = await startedModule(database.context, fakeAgents({ "agent-1": {} }));
            /*
             * Summing tokens in SQL must enforce the same invariant that parsing every scoped
             * record used to. A row that contradicts itself is not a trustworthy source of
             * tokens either, so neither the run nor the installation-wide windows may spend it.
             */
            await expect(module.readRun(database.context, "agent-1", "run-1")).rejects.toThrow(
                "duration",
            );
            await expect(module.readWindowUsage(database.context, [0])).rejects.toThrow("duration");
        });
    });

    it("aggregates and pages past more distinct groups than one page can hold", async () => {
        await withUsageDatabase("usage-many-groups", async (database) => {
            const store = new UsageDatabase();
            // More combinations than the old record cap allowed to exist at once, so the group
            // collection is larger than any single page of it.
            const total = 520;
            for (let index = 0; index < total; index++) {
                await store.record(
                    database.context,
                    inferenceRecord(`record-${index}`, "agent-1", index + 10, {
                        model: `model-${String(index).padStart(4, "0")}`,
                    }),
                );
            }
            const module = await startedModule(database.context, fakeAgents({ "agent-1": {} }));
            const first = await module.read(database.context, "agent-1");
            expect(first.totalGroups).toBe(total);
            expect(first.groups).toHaveLength(USAGE_GROUP_PAGE_SIZE);

            // Walk every page; the groups must come out complete, in order, and never repeated.
            const seen: string[] = [];
            let cursor: number | undefined = 0;
            while (cursor !== undefined) {
                const page = await module.read(database.context, "agent-1", { cursor });
                for (const group of page.groups) seen.push(group.model ?? "");
                cursor = page.nextCursor;
            }
            expect(seen).toHaveLength(total);
            expect(new Set(seen).size).toBe(total);
            expect(seen[0]).toBe("model-0000");
            expect(seen[total - 1]).toBe(`model-${String(total - 1).padStart(4, "0")}`);
        });
    });

    it("reports an older model in a window that busier recent models cannot evict", async () => {
        await withUsageDatabase("usage-windows-keep-older-models", async (database) => {
            const store = new UsageDatabase();
            const now = 1_800_000_000_000;
            const hourMs = 60 * 60 * 1_000;
            const dayMs = 24 * hourMs;
            // One older run, then far more recent traffic than the store ever used to retain.
            const older = now - 2 * dayMs;
            await store.record(
                database.context,
                inferenceRecord("older-fable", "agent-1", older + 10, {
                    startedAt: older,
                    model: "anthropic/fable-5",
                    tokens: { input: 7, output: 3 },
                }),
            );
            for (let index = 0; index < 600; index++) {
                const startedAt = now - 1_000;
                await store.record(
                    database.context,
                    inferenceRecord(`recent-${index}`, "agent-1", startedAt + 10, {
                        startedAt,
                        model: "anthropic/opus-5",
                        tokens: { input: 1, output: 1 },
                    }),
                );
            }
            const module = await startedModule(database.context, fakeAgents({ "agent-1": {} }));

            // Both windows come from one read, so each must still describe only its own span.
            const [hour, week] = await module.readWindowUsage(database.context, [
                now - hourMs,
                now - 7 * dayMs,
            ]);
            expect(hour?.["provider-main"]?.["anthropic/opus-5"]).toEqual({
                input: 600,
                output: 600,
                cacheRead: 0,
                cacheWrite: 0,
            });
            // The older model started outside this window, so it must not be counted in it.
            expect(hour?.["provider-main"]?.["anthropic/fable-5"]).toBeUndefined();

            // The week still knows about the older model: nothing evicted it.
            expect(week?.["provider-main"]?.["anthropic/fable-5"]).toEqual({
                input: 7,
                output: 3,
                cacheRead: 0,
                cacheWrite: 0,
            });
            expect(week?.["provider-main"]?.["anthropic/opus-5"]?.input).toBe(600);
        });
    });

    it("pages aggregate groups without skipping or repeating a group", async () => {
        await withUsageDatabase("usage-group-cursors", async (database) => {
            for (const [index, provider] of ["provider-a", "provider-b", "provider-c"].entries()) {
                await insertRawRecord(
                    database,
                    inferenceRecord(`group-${index}`, "agent-1", index + 11, {
                        provider,
                    }),
                );
            }
            const module = new UsageModule(new EventsModule());
            const pages: UsageSummary[] = [];
            let cursor = 0;
            while (true) {
                const page = await module.aggregate(database.context, {
                    agentId: "agent-1",
                    cursor,
                    maxGroups: 1,
                });
                pages.push(page);
                if (page.nextCursor === undefined) break;
                expect(page.nextCursor).toBe(cursor + page.groups.length);
                cursor = page.nextCursor;
            }
            expect(pages.map((page) => page.groups[0]?.provider)).toEqual([
                "provider-a",
                "provider-b",
                "provider-c",
            ]);
            expect(
                new Set(pages.flatMap((page) => page.groups.map((group) => group.provider))).size,
            ).toBe(3);
        });
    });

    it("rejects invalid page and aggregate bounds before touching storage", async () => {
        await withUsageDatabase("usage-query-bounds", async (database) => {
            const module = new UsageModule(new EventsModule());
            await expect(
                module.readPage(database.context, "agent-1", { limit: USAGE_PAGE_SIZE }),
            ).resolves.toMatchObject({ agentId: "agent-1", cursor: 0 });
            await expect(
                module.readPage(database.context, "agent-1", { limit: USAGE_PAGE_SIZE + 1 }),
            ).rejects.toThrow(`cannot exceed ${USAGE_PAGE_SIZE}`);
            await expect(
                module.readPage(database.context, "agent-1", { cursor: -1 }),
            ).rejects.toThrow("invalid");
            await expect(
                module.aggregate(database.context, {
                    agentId: "agent-1",
                    maxGroups: USAGE_GROUP_PAGE_SIZE + 1,
                }),
            ).rejects.toThrow(`cannot exceed ${USAGE_GROUP_PAGE_SIZE}`);
            await expect(
                module.aggregate(database.context, { agentId: "agent-1", cursor: -1 }),
            ).rejects.toThrow("invalid");
        });
    });

    it("enforces the current-agent boundary for reads, aggregate reads, and resets", async () => {
        await withUsageDatabase("usage-agent-boundary", async (database) => {
            await insertRawRecord(database, inferenceRecord("owned", "agent-1", 10));
            await insertRawRecord(database, inferenceRecord("other", "agent-2", 11));
            const module = new UsageModule(new EventsModule());
            const current = agentContext(database.context, "agent-1");

            await expect(module.read(current, "agent-2")).rejects.toThrow("current agent");
            await expect(module.aggregate(current, {})).rejects.toThrow();
            await expect(module.aggregate(current, { agentId: "agent-2" })).rejects.toThrow(
                "current agent",
            );
            await expect(module.reset(current, "agent-2")).rejects.toThrow("current agent");
            await expect(module.resetAll(current)).rejects.toThrow();
            await expect(module.read(current, "agent-1")).resolves.toMatchObject({
                agentId: "agent-1",
                totalTokens: 5,
            });
        });
    });

    it("keeps host-neutral usage tools targetable while agent tools remain self-scoped", async () => {
        await withUsageDatabase("usage-tool-scope", async (database) => {
            await insertRawRecord(database, inferenceRecord("a", "agent-1", 11));
            await insertRawRecord(database, inferenceRecord("b", "agent-2", 12));
            const module = new UsageModule(new EventsModule());
            const hostTool = getUsageTool(module);
            expect(Value.Check(hostTool.parameters!, { target: "agent-2" })).toBe(true);
            await expect(
                hostTool.execute(database.context, { target: "agent-2" }, undefined as never),
            ).resolves.toMatchObject({ agentId: "agent-2", totalTokens: 5 });
            await expect(
                hostTool.execute(database.context, { aggregate: true }, undefined as never),
            ).resolves.toMatchObject({ totalTokens: 10 });

            const agentTool = getUsageTool(module, "agent-1");
            expect(Value.Check(agentTool.parameters!, { target: "agent-2" })).toBe(false);
            await expect(
                agentTool.execute(
                    agentContext(database.context),
                    { target: "agent-2" } as never,
                    undefined as never,
                ),
            ).rejects.toThrow("current agent");
            await expect(
                agentTool.execute(
                    agentContext(database.context),
                    { aggregate: true },
                    undefined as never,
                ),
            ).resolves.toMatchObject({ agentId: "agent-1", totalTokens: 5 });
            expect(agentTool.durable).toBe(true);
            expect(agentTool.reloadable).toBe(true);
            expect(agentTool.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);
        });
    });

    it("keeps one finite tree out of a collection that reports a cycle", async () => {
        await withUsageDatabase("usage-tree-validation", async (database) => {
            // A collection that answers with a loop is a broken collection, not a deeper tree.
            const module = await startedModule(
                database.context,
                fakeAgents({
                    "agent-1": { parent: "agent-2" },
                    "agent-2": { createdBy: "agent-1", parent: "agent-1" },
                }),
            );
            const tree = await module.readAgentTreeUsage(database.context, "agent-1");
            expect(tree.sessions.map((session) => session.agentId)).toEqual(["agent-1", "agent-2"]);
            expect(tree.sessions[0]).toMatchObject({ relation: "root", path: "/agent-1" });
            expect(tree.sessions[1]).toMatchObject({
                parentAgentId: "agent-1",
                path: "/agent-1/agent-2",
            });
        });
    });

    it("refuses a subtree larger or deeper than one snapshot can describe", async () => {
        await withUsageDatabase("usage-tree-limits", async (database) => {
            const wide: Record<string, { parent?: string; createdBy?: string }> = {
                "agent-root": {},
            };
            for (let index = 0; index < MAX_USAGE_TREE_SESSIONS; index += 1) {
                wide[`agent-${index}`] = { createdBy: "agent-root", parent: "agent-root" };
            }
            const wideModule = await startedModule(database.context, fakeAgents(wide));
            await expect(
                wideModule.readAgentTreeUsage(database.context, "agent-root"),
            ).rejects.toThrow("larger than one snapshot can hold");

            const deep: Record<string, { parent?: string; createdBy?: string }> = {
                "agent-0": {},
            };
            const nameLength = "agent-0".length + 1;
            for (let index = 1; index <= MAX_USAGE_TREE_PATH_LENGTH / nameLength + 1; index += 1) {
                deep[`agent-${index}`] = {
                    createdBy: `agent-${index - 1}`,
                    parent: `agent-${index - 1}`,
                };
            }
            const deepModule = await startedModule(database.context, fakeAgents(deep));
            await expect(
                deepModule.readAgentTreeUsage(database.context, "agent-0"),
            ).rejects.toThrow("deeper than one snapshot can name");
        });
    });

    it("answers a subtree read only from inside that subtree, and never before it has started", async () => {
        await withUsageDatabase("usage-tree-authorization", async (database) => {
            await expect(
                new UsageModule(new EventsModule()).readAgentTreeUsage(database.context, "agent-1"),
            ).rejects.toThrow("before it started");

            const module = await startedModule(
                database.context,
                fakeAgents({
                    "agent-1": {},
                    "agent-2": { createdBy: "agent-1", parent: "agent-1" },
                    "agent-3": { createdBy: "agent-2", parent: "agent-2" },
                    elsewhere: {},
                }),
            );
            // Host code names no agent, so no agent-facing policy applies to it.
            await expect(
                module.readAgentTreeUsage(database.context, "agent-1"),
            ).resolves.toMatchObject({ sessions: [{ agentId: "agent-1" }, {}, {}] });
            await expect(
                module.readAgentTreeUsage(agentContext(database.context), "agent-3"),
            ).resolves.toMatchObject({ sessions: [{ agentId: "agent-3", relation: "root" }] });
            await expect(
                module.readAgentTreeUsage(agentContext(database.context, "elsewhere"), "agent-2"),
            ).rejects.toThrow("agents it started");
            await expect(
                module.readAgentTreeUsage(agentContext(database.context, "agent-3"), "agent-1"),
            ).rejects.toThrow("agents it started");
        });
    });

    it("renders bounded model output without emitting a partial group row", async () => {
        await withUsageDatabase("usage-output-bounds", async (database) => {
            const module = new UsageModule(new EventsModule());
            const summary: UsageSummary = {
                agentId: "agent-1",
                cursor: 0,
                totalGroups: 2,
                inferenceCount: 2,
                turnCount: 0,
                inputTokens: 2,
                outputTokens: 2,
                totalTokens: 4,
                inferenceDurationMs: 20,
                turnDurationMs: 0,
                totalDurationMs: 20,
                groups: [
                    {
                        provider: "p".repeat(256),
                        model: "m".repeat(256),
                        effort: "max",
                        tier: "priority",
                        inferenceCount: 1,
                        turnCount: 0,
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 2,
                        inferenceDurationMs: 10,
                        turnDurationMs: 0,
                        totalDurationMs: 10,
                    },
                ],
                nextCursor: 1,
            };
            const output = module.formatForModel(summary, 256);
            expect(output.length).toBeLessThanOrEqual(256);
            expect(output).toContain("cursor=1");
            expect(output).not.toContain("p".repeat(256));
            // A caller may ask for a tighter budget than the module's own, never a wider one.
            expect(module.formatForModel(summary).length).toBeLessThanOrEqual(
                USAGE_OUTPUT_CHARACTERS,
            );
            expect(() => module.formatForModel(summary, USAGE_OUTPUT_CHARACTERS + 1)).toThrow(
                "bound",
            );
            expect(() => module.formatForModel(summary, MAX_USAGE_OUTPUT_CHARACTERS + 1)).toThrow(
                "bound",
            );
        });
    });

    it("publishes stable deeply frozen events to both kinds of subscriber", async () => {
        await withUsageDatabase("usage-events-stable", async (database) => {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(100);
            const transactional: UsageEvent[] = [];
            const postCommit: UsageEvent[] = [];
            const module = new UsageModule(new EventsModule());
            module.onEventTransactional((_ctx: Context, event: UsageEvent) => {
                transactional.push(event);
                expect(Object.isFrozen(event)).toBe(true);
                if (event.type === "usage_recorded") {
                    const record = event.record;
                    if (record.kind !== "inference") {
                        throw new Error("Expected an inference usage event");
                    }
                    expect(Object.isFrozen(record)).toBe(true);
                    expect(() => {
                        record.tokens.input = 99;
                    }).toThrow();
                }
            });
            module.onEvent((_ctx: Context, event: UsageEvent) => {
                postCommit.push(event);
            });
            const hooks = await resolveModuleHooks(database.context, module);
            const scope = makeScope(database.database);
            await hooks.beforeInferenceTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "event-id",
                contextTokens: undefined,
            });
            vi.setSystemTime(110);
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterInferenceTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    inferenceId: "event-id",
                    contextTokens: undefined,
                    state: "normal",
                    tokens: { input: 3, output: 2 },
                });
            });
            expect(postCommit).toHaveLength(2);
            expect(postCommit[0]).toBe(transactional[0]);
            expect(postCommit[1]).toBe(transactional[1]);
            expect(postCommit).toEqual([
                {
                    type: "usage_recorded",
                    eventId: "event-id",
                    at: 110,
                    record: expect.objectContaining({ id: "event-id" }),
                },
                expect.objectContaining({
                    type: "usage_context_changed",
                    at: 110,
                    agentId: "agent-1",
                    context: expect.objectContaining({ contextTokens: 5 }),
                }),
            ]);
        });
    });

    it("contains a hostile post-commit subscriber failure after the record is durable", async () => {
        await withUsageDatabase("usage-post-commit-errors", async (database) => {
            const [ctx, warnings] = capturingContext(database.context);
            const hostile = {
                get message(): never {
                    throw new Error("message trap");
                },
                [Symbol.toPrimitive](): never {
                    throw new Error("primitive trap");
                },
            };
            const announced: string[] = [];
            const module = new UsageModule(new EventsModule());
            module.onEvent(async () => {
                throw hostile;
            });
            module.onEvent((_eventCtx: Context, event: UsageEvent) => {
                announced.push(event.type);
            });
            const hooks = await resolveModuleHooks(ctx, module);
            const scope = makeScope(database.database);
            await hooks.beforeInferenceTransact!(ctx, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "post-error",
                contextTokens: undefined,
            });
            await expect(
                runWithAfterCommit(ctx, async (txCtx) => {
                    await hooks.afterInferenceTransact!(txCtx, scope, {
                        loopId: "loop",
                        turnId: "turn",
                        inferenceId: "post-error",
                        contextTokens: undefined,
                        state: "normal",
                        tokens: { input: 1, output: 1 },
                    });
                }),
            ).resolves.toBeUndefined();
            expect(warnedPhases(warnings)).toEqual([
                "post_commit_subscriber",
                "post_commit_subscriber",
            ]);
            // One failing subscriber cannot starve the subscribers queued behind it.
            expect(announced).toEqual(["usage_recorded", "usage_context_changed"]);
            await expect(module.readPage(database.context, "agent-1")).resolves.toMatchObject({
                records: [{ id: "post-error" }],
            });
        });
    });

    it("does not publish reset events or delete rows when an outer transaction rolls back", async () => {
        await withUsageDatabase("usage-reset-rollback", async (database) => {
            await insertRawRecord(database, inferenceRecord("rollback", "agent-1", 10));
            const events: UsageEvent[] = [];
            const module = new UsageModule(new EventsModule());
            module.onEvent((_ctx: Context, event: UsageEvent) => {
                events.push(event);
            });
            await expect(
                database.context.inTx(async (outer) => {
                    await module.reset(outer, "agent-1");
                    throw new Error("abort outer transaction");
                }),
            ).rejects.toThrow("abort outer transaction");
            expect(events).toEqual([]);
            await expect(module.readPage(database.context, "agent-1")).resolves.toMatchObject({
                totalRecords: 1,
                records: [{ id: "rollback" }],
            });
        });
    });

    it("does not let a transactional subscriber failure escape advisory accounting", async () => {
        await withUsageDatabase("usage-transactional-listener-failure", async (database) => {
            const [ctx, warnings] = capturingContext(database.context);
            const module = new UsageModule(new EventsModule());
            module.onEventTransactional(() => {
                throw new Error("transactional projection failed");
            });
            const hooks = await resolveModuleHooks(ctx, module);
            const scope = makeScope(database.database);
            await hooks.beforeInferenceTransact!(ctx, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "transactional-failure",
                contextTokens: undefined,
            });
            await expect(
                ctx.inTx(async (txCtx) => {
                    await hooks.afterInferenceTransact!(txCtx, scope, {
                        loopId: "loop",
                        turnId: "turn",
                        inferenceId: "transactional-failure",
                        contextTokens: undefined,
                        state: "normal",
                        tokens: { input: 1, output: 1 },
                    });
                }),
            ).resolves.toBeUndefined();
            expect(warnedPhases(warnings)).toEqual(["after_inference"]);
            expect(warnings[0]?.[2]).toMatchObject({
                message: expect.stringContaining("projection"),
            });
            /*
             * Accounting is advisory: the record remains durable even when
             * an optional transactional observer fails.
             */
            await expect(module.readPage(database.context, "agent-1")).resolves.toMatchObject({
                records: [{ id: "transactional-failure" }],
            });
        });
    });

    it("takes nothing, and keeps one set of bounds no caller can widen", async () => {
        expect(new UsageModule(new EventsModule())).toBeInstanceOf(UsageModule);
        await withUsageDatabase("usage-fixed-bounds", async (database) => {
            const module = new UsageModule(new EventsModule());
            await expect(
                module.readPage(database.context, "agent-1", { limit: USAGE_PAGE_SIZE }),
            ).resolves.toMatchObject({ agentId: "agent-1", cursor: 0 });
            await expect(
                module.readPage(database.context, "agent-1", { limit: USAGE_PAGE_SIZE + 1 }),
            ).rejects.toThrow(`cannot exceed ${USAGE_PAGE_SIZE}`);
            await expect(
                module.aggregate(database.context, { maxGroups: USAGE_GROUP_PAGE_SIZE }),
            ).resolves.toMatchObject({ cursor: 0 });
            await expect(
                module.aggregate(database.context, { maxGroups: USAGE_GROUP_PAGE_SIZE + 1 }),
            ).rejects.toThrow(`cannot exceed ${USAGE_GROUP_PAGE_SIZE}`);
        });
    });

    it("names every agent in the tree by its full path from the root of the snapshot", async () => {
        await withUsageDatabase("usage-tree-paths", async (database) => {
            const module = await startedModule(
                database.context,
                fakeAgents({
                    "agent-1": {},
                    "agent-2": { createdBy: "agent-1", parent: "agent-1" },
                    "agent-3": { createdBy: "agent-2", parent: "agent-2" },
                }),
            );
            const fromRoot = await module.readAgentTreeUsage(database.context, "agent-1");
            expect(fromRoot.sessions.map((session) => session.path)).toEqual([
                "/agent-1",
                "/agent-1/agent-2",
                "/agent-1/agent-2/agent-3",
            ]);
            // A snapshot rooted lower names paths from its own root, not from the collection's.
            const fromMiddle = await module.readAgentTreeUsage(database.context, "agent-2");
            expect(fromMiddle.sessions.map((session) => session.path)).toEqual([
                "/agent-2",
                "/agent-2/agent-3",
            ]);
        });
    });

    it("keeps reset events bounded and reports the removed count", async () => {
        await withUsageDatabase("usage-reset-event-count", async (database) => {
            for (let index = 0; index < 3; index++) {
                await insertRawRecord(
                    database,
                    inferenceRecord(`reset-${index}`, "agent-1", index + 10),
                );
            }
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(100);
            const events: UsageEvent[] = [];
            const module = new UsageModule(new EventsModule());
            module.onEventTransactional((_ctx: Context, event: UsageEvent) => {
                events.push(event);
            });
            await expect(module.reset(database.context, "agent-1")).resolves.toBe(3);
            expect(events).toEqual([
                {
                    type: "usage_reset",
                    eventId: expect.any(String),
                    at: 100,
                    agentId: "agent-1",
                    removed: 3,
                },
            ]);
            await expect(module.reset(database.context, "agent-1")).resolves.toBe(0);
            expect(events).toHaveLength(1);
        });
    });

    it("returns exact collection aggregates and latest context measurements", async () => {
        await withUsageDatabase("usage-collection-aggregate", async (database) => {
            const store = new UsageDatabase();
            await store.record(database.context, inferenceRecord("one", "agent-1", 10));
            await store.record(
                database.context,
                turnRecord("turn-1", "agent-1", 20, { contextTokens: 50 }),
            );
            await store.record(
                database.context,
                inferenceRecord("two", "agent-2", 30, {
                    provider: "provider-other",
                    model: "model-other",
                    tokens: { input: 4, output: 6 },
                }),
            );
            const summary = await new UsageModule(new EventsModule()).aggregate(
                database.context,
                {},
            );
            expect(summary).toMatchObject({
                totalTokens: 15,
                inferenceCount: 2,
                turnCount: 1,
                currentContext: {
                    contextTokens: 10,
                    provider: "provider-other",
                },
            });
            expect(summary.groups).toHaveLength(2);
            expect(summary.groups.map((group) => group.provider)).toEqual([
                "provider-main",
                "provider-other",
            ]);
        });
    });

    it("keeps model-facing tree output bounded at the minimum budget", async () => {
        await withUsageDatabase("usage-tree-output", async (database) => {
            const module = new UsageModule(new EventsModule());
            const large: UsageAgentTree = {
                sessions: [
                    { agentId: "agent-1", path: "/agent-1", relation: "root", totalTokens: 10 },
                    ...Array.from({ length: 20 }, (_, index) => ({
                        agentId: `agent-${index + 2}`,
                        parentAgentId: "agent-1",
                        path: `/agent-1/agent-${index + 2}`,
                        relation: "delegated" as const,
                        totalTokens: index,
                    })),
                ],
                totalTokens: 0,
            };
            const bounded: UsageAgentTree = {
                sessions: large.sessions,
                totalTokens: large.sessions.reduce(
                    (total, session) => total + session.totalTokens,
                    0,
                ),
            };
            const output = module.formatAgentTreeUsageForModel(bounded, 256);
            expect(output.length).toBeLessThanOrEqual(256);
            expect(output).toContain("Agent tree usage");
        });
    });

    it("validates aggregate shape and rejects forged totals/cursors from persisted storage", async () => {
        await withUsageDatabase("usage-summary-invariants", async (database) => {
            await insertRawRecord(database, inferenceRecord("summary", "agent-1", 10));
            const module = new UsageModule(new EventsModule());
            const summary = await module.aggregate(database.context, {
                agentId: "agent-1",
            });
            expect(summary.totalTokens).toBe(summary.inputTokens + summary.outputTokens);
            expect(summary.totalDurationMs).toBe(
                summary.inferenceDurationMs + summary.turnDurationMs,
            );
            await expect(
                module.aggregate(database.context, {
                    agentId: "agent-1",
                    cursor: MAX_USAGE_GROUPS,
                }),
            ).rejects.toThrow("wrong scope or page");
        });
    });

    it("keeps agent-tree tool output and contract bounded", async () => {
        await withUsageDatabase("usage-tree-tool-contract", async (database) => {
            const module = await startedModule(
                database.context,
                fakeAgents({
                    "agent-1": {},
                    "agent-2": { createdBy: "agent-1", parent: "agent-1" },
                }),
            );
            const tool = getAgentTreeUsageTool(module, "agent-1");
            expect(tool.name).toBe("get_agent_tree_usage");
            expect(tool.durable).toBe(true);
            expect(tool.reloadable).toBe(true);
            expect(tool.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);
            const result = await tool.execute(
                agentContext(database.context),
                {},
                undefined as never,
            );
            expect(result).toEqual(
                await module.readAgentTreeUsage(agentContext(database.context), "agent-1"),
            );
            const rendered = tool
                .toLLM(result)
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("");
            expect(rendered.length).toBeLessThanOrEqual(MAX_USAGE_OUTPUT_CHARACTERS);
            expect(rendered).toContain("agent-2");
        });
    });
});
