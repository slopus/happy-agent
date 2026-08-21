import {
    agentDatabaseRows,
    agentDatabaseRun,
    withAgentContext,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import { UsageModule } from "../../sources/usage/UsageModule.js";
import type { UsageEvent } from "../../sources/usage/UsageEvent.js";
import { getAgentTreeUsageTool } from "../../sources/usage/tools/get_agent_tree_usage.js";
import { getUsageTool } from "../../sources/usage/tools/get_usage.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
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

function scope(
    database: ReturnType<typeof moduleDatabase>["database"],
    runKV: FakeKV,
    agentId = "agent-1",
) {
    return {
        database,
        agent: {
            id: agentId,
            provider: "provider-main",
            providerKind: "codex" as const,
            model: "model-main",
            effort: "high" as const,
            tier: "priority" as const,
            permissionMode: "auto" as const,
        },
        kv: new FakeKV(),
        sharedKV: new FakeKV(),
        runKV,
    } as never;
}

function agentContext(ctx: Context, id: string): Context {
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
 * parent is, what it started, and how it was configured. Nothing else in the reference is
 * reachable from the module, so nothing else is provided here.
 */
function fakeAgents(
    roster: Readonly<
        Record<
            string,
            { readonly parent?: string; readonly createdBy?: string; readonly title?: string }
        >
    >,
): AgentSystemRef {
    return {
        parentOf: (_ctx: Context, agentId: string): Promise<string | null> =>
            Promise.resolve(roster[agentId]?.parent ?? null),
        childOf: (_ctx: Context, agentId: string): Promise<readonly string[]> =>
            Promise.resolve(Object.keys(roster).filter((id) => roster[id]?.parent === agentId)),
        config: (_ctx: Context, agentId: string): Promise<unknown> => {
            const agent = roster[agentId];
            if (agent === undefined) return Promise.resolve(undefined);
            return Promise.resolve({
                ...(agent.createdBy === undefined
                    ? {}
                    : { provenance: { createdAt: 0, createdBy: agent.createdBy } }),
                ...(agent.title === undefined ? {} : { metadata: { title: agent.title } }),
            });
        },
    } as unknown as AgentSystemRef;
}

async function inCompletion(ctx: Context, work: (txCtx: Context) => Promise<void>): Promise<void> {
    const [txCtx, drain] = withAfterCommit(ctx);
    await work(txCtx);
    await drain();
}

async function createUsageTest(name: string): Promise<{
    database: ReturnType<typeof moduleDatabase>;
    events: EventsModule;
    module: UsageModule;
}> {
    const events = new EventsModule();
    const database = moduleDatabase(events.migrations, name);
    await database.ready;
    await events.beforeStart?.(database.context);
    const module = new UsageModule(events);
    for (const [, migration] of module.migrations) {
        await migration(database.context, database.database);
    }
    return { database, events, module };
}

async function recordInference(
    ctx: Context,
    hooks: AgentModuleHooks,
    database: ReturnType<typeof moduleDatabase>["database"],
    agentId: string,
    inferenceId: string,
    tokens: { readonly input: number; readonly output: number },
): Promise<void> {
    const agentScope = scope(database, new FakeKV(), agentId);
    await hooks.beforeInferenceTransact!(ctx, agentScope, {
        loopId: "loop-1",
        turnId: `turn-${inferenceId}`,
        inferenceId,
        contextTokens: undefined,
    });
    await inCompletion(ctx, async (txCtx) => {
        await hooks.afterInferenceTransact!(txCtx, agentScope, {
            loopId: "loop-1",
            turnId: `turn-${inferenceId}`,
            inferenceId,
            contextTokens: undefined,
            state: "normal",
            tokens,
        });
    });
}

describe("UsageModule", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("uses Base inference and turn IDs inside the ambient completion transaction", async () => {
        const { database, module } = await createUsageTest("usage-base-identities");
        const ctx = database.context;
        // Only the clock is moved; the database and its promises keep real timers.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(100);
        const events: UsageEvent[] = [];
        module.onEventTransactional((_eventCtx, event) => {
            events.push(structuredClone(event));
        });
        const hooks = await resolveModuleHooks(ctx, module);
        const runKV = new FakeKV();
        const agentScope = scope(database.database, runKV);

        await hooks.beforeTurnTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-base-id",
            contextTokens: undefined,
        });
        vi.setSystemTime(125);
        await hooks.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-base-id",
            inferenceId: "inference-base-id",
            contextTokens: undefined,
        });
        vi.setSystemTime(150);
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterInferenceTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-base-id",
                inferenceId: "inference-base-id",
                contextTokens: undefined,
                state: "normal",
                tokens: { input: 10, output: 4 },
            });
        });
        vi.setSystemTime(175);
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterTurnTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-base-id",
                contextTokens: 14,
                aborted: false,
            });
        });

        const page = await module.readPage(ctx, "agent-1");
        expect(page.records).toMatchObject([
            {
                id: "inference-base-id",
                kind: "inference",
                runId: "loop-1",
                startedAt: 125,
                finishedAt: 150,
                durationMs: 25,
                tokens: { input: 10, output: 4 },
            },
            {
                id: "turn-base-id",
                kind: "turn",
                runId: "loop-1",
                startedAt: 100,
                finishedAt: 175,
                durationMs: 75,
                contextTokens: 14,
            },
        ]);
        expect(events.slice(0, 2).map((event) => event.eventId)).toEqual([
            "inference-base-id",
            "turn-base-id",
        ]);
        expect(events[2]).toMatchObject({
            type: "usage_context_changed",
            agentId: "agent-1",
            context: {
                approximate: false,
                contextTokens: 14,
                provider: "provider-main",
                model: "model-main",
            },
        });
        expect(runKV.values.size).toBe(0);
        await expect(module.read(ctx, "agent-1")).resolves.toMatchObject({
            currentContext: {
                approximate: false,
                contextTokens: 14,
                provider: "provider-main",
                model: "model-main",
            },
        });
        database.close();
    });

    it("clears the current context after a turn with no provider measurement", async () => {
        const { database, module } = await createUsageTest("usage-current-context-invalidation");
        const ctx = database.context;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(100);
        const hooks = await resolveModuleHooks(ctx, module);
        const runKV = new FakeKV();
        const agentScope = scope(database.database, runKV);

        await hooks.beforeTurnTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-1",
            contextTokens: undefined,
        });
        vi.setSystemTime(120);
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterTurnTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-1",
                contextTokens: 12,
                aborted: false,
            });
        });
        await expect(module.read(ctx, "agent-1")).resolves.toMatchObject({
            currentContext: { contextTokens: 12 },
        });

        vi.setSystemTime(140);
        await hooks.beforeTurnTransact!(ctx, agentScope, {
            loopId: "loop-2",
            turnId: "turn-2",
            contextTokens: undefined,
        });
        vi.setSystemTime(160);
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterTurnTransact!(txCtx, agentScope, {
                loopId: "loop-2",
                turnId: "turn-2",
                contextTokens: undefined,
                aborted: false,
            });
        });
        const summary = await module.read(ctx, "agent-1");
        expect(summary).not.toHaveProperty("currentContext");
        database.close();
    });

    it("allows the exported usage tool to aggregate for a host-neutral caller", async () => {
        const { database, module } = await createUsageTest("usage-host-neutral-tool");
        const ctx = database.context;
        const hooks = await resolveModuleHooks(ctx, module);
        await recordInference(ctx, hooks, database.database, "agent-1", "inference-1", {
            input: 3,
            output: 2,
        });

        const tool = getUsageTool(module, "agent-1");
        const result = await tool.execute(ctx, { aggregate: true }, {} as never);
        expect(result.agentId).toBeUndefined();
        expect(result.totalTokens).toBe(5);
        database.close();
    });

    it("builds the agent tree from the collection it started with and its own records", async () => {
        const { database, module } = await createUsageTest("usage-agent-tree");
        const ctx = database.context;
        const hooks = await resolveModuleHooks(
            ctx,
            module,
            fakeAgents({
                "agent-1": { title: "The conversation" },
                // Made by its parent with a tool, so it is that parent's own hands.
                "agent-2": { createdBy: "agent-1", parent: "agent-1" },
                // Placed under agent-1 by someone else: work handed over rather than started.
                "agent-3": { createdBy: "a-person", parent: "agent-1" },
                "agent-4": { createdBy: "agent-2", parent: "agent-2" },
            }),
        );
        await recordInference(ctx, hooks, database.database, "agent-1", "inference-1", {
            input: 6,
            output: 4,
        });
        await recordInference(ctx, hooks, database.database, "agent-2", "inference-2", {
            input: 5,
            output: 2,
        });

        const rootCtx = agentContext(ctx, "agent-1");
        const tree = await module.readAgentTreeUsage(rootCtx, "agent-1");
        expect(tree).toEqual({
            sessions: [
                {
                    agentId: "agent-1",
                    path: "/agent-1",
                    relation: "root",
                    title: "The conversation",
                    totalTokens: 10,
                },
                {
                    agentId: "agent-2",
                    parentAgentId: "agent-1",
                    path: "/agent-1/agent-2",
                    relation: "subagent",
                    totalTokens: 7,
                },
                {
                    agentId: "agent-3",
                    parentAgentId: "agent-1",
                    path: "/agent-1/agent-3",
                    relation: "delegated",
                    totalTokens: 0,
                },
                {
                    agentId: "agent-4",
                    parentAgentId: "agent-2",
                    path: "/agent-1/agent-2/agent-4",
                    relation: "subagent",
                    totalTokens: 0,
                },
            ],
            totalTokens: 17,
        });
        const tool = getAgentTreeUsageTool(module, "agent-1");
        await expect(tool.execute(rootCtx, {}, {} as never)).resolves.toEqual(tree);

        // An agent accounts for the work it started, however deep, and for nothing above it.
        await expect(module.readAgentTreeUsage(rootCtx, "agent-4")).resolves.toMatchObject({
            sessions: [{ agentId: "agent-4", relation: "root" }],
        });
        await expect(
            module.readAgentTreeUsage(agentContext(ctx, "agent-4"), "agent-1"),
        ).rejects.toThrow("agents it started");
        database.close();
    });

    it("drops reset receipts and performs each reset as an ordinary mutation", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations, "usage-reset");
        await database.ready;
        await events.beforeStart?.(database.context);
        const module = new UsageModule(events);
        const ctx = database.context;
        const resets: UsageEvent[] = [];
        module.onEvent((_eventCtx, event) => {
            if (event.type === "usage_reset") resets.push(event);
        });
        const hooks = await resolveModuleHooks(ctx, module);
        await module.migrations[0]![1](database.context, database.database);
        const beforeDrop = await agentDatabaseRows<{ name: string }>(
            database.database,
            sql`SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = 'happy_agent_usage_reset_receipts'`,
        );
        expect(beforeDrop).toHaveLength(1);

        await module.migrations[1]![1](database.context, database.database);
        await module.migrations[2]![1](database.context, database.database);
        await module.migrations[3]![1](database.context, database.database);
        const legacyRecord = {
            id: "legacy-inference",
            agentId: "agent-1",
            runId: "legacy-run",
            provider: "provider-main",
            model: "model-main",
            effort: "high",
            tier: "priority",
            kind: "inference",
            state: "normal",
            tokens: { input: 4, output: 2, cacheRead: 3, cacheWrite: 1 },
            startedAt: 0,
            finishedAt: 1,
            durationMs: 1,
        };
        await agentDatabaseRun(
            database.database,
            sql`INSERT INTO happy_agent_usage_records
                    (record_id, agent_id, run_id, finished_at, kind, record_json)
                VALUES (${legacyRecord.id}, ${legacyRecord.agentId}, ${legacyRecord.runId},
                        ${legacyRecord.finishedAt}, ${legacyRecord.kind},
                        ${JSON.stringify(legacyRecord)})`,
        );
        await module.migrations[4]![1](database.context, database.database);
        await expect(module.readAgentModelUsage(ctx, "agent-1")).resolves.toEqual({
            "provider-main": {
                "model-main": { input: 4, output: 2, cacheRead: 3, cacheWrite: 1 },
            },
        });
        const afterDrop = await agentDatabaseRows<{ name: string }>(
            database.database,
            sql`SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = 'happy_agent_usage_reset_receipts'`,
        );
        expect(afterDrop).toHaveLength(0);

        await recordInference(ctx, hooks, database.database, "agent-1", "inference-1", {
            input: 1,
            output: 1,
        });
        expect(await module.reset(ctx, "agent-1")).toBe(2);

        await recordInference(ctx, hooks, database.database, "agent-1", "inference-2", {
            input: 2,
            output: 1,
        });
        expect(await module.reset(ctx, "agent-1")).toBe(1);
        // Each reset is its own change, so each carries its own identity.
        expect(resets).toHaveLength(2);
        expect(new Set(resets.map((event) => event.eventId)).size).toBe(2);
        expect((await module.readPage(ctx, "agent-1")).records).toHaveLength(0);
        database.close();
    });
});
