import type { AgentModuleHooks, AgentModuleScope, AgentSystemRef } from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { CompactionsModule } from "../../sources/compactions/index.js";
import { EventsModule, type AgentEvent } from "../../sources/events/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { UsageModule } from "../../sources/usage/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

class FakeKV {
    async read(): Promise<undefined> {
        return undefined;
    }

    async write(): Promise<void> {}

    async delete(): Promise<void> {}
}

function scope(
    database: ReturnType<typeof moduleDatabase>["database"],
    agentId = "agent1",
): AgentModuleScope {
    return {
        database,
        agent: {
            id: agentId,
            provider: "gym",
            providerKind: "codex",
            model: "openai/gym",
            effort: "medium",
            permissionMode: "auto",
        },
        historyKV: new FakeKV(),
        kv: new FakeKV(),
        runKV: new FakeKV(),
        sharedKV: new FakeKV(),
    } as never;
}

function completedResult() {
    return {
        status: "completed" as const,
        preservedMessages: [],
        usage: {
            input: 120,
            output: 20,
            cacheRead: 80,
            cacheWrite: 5,
            totalTokens: 140,
        },
        context: { instructions: "", messages: [] },
    };
}

async function inCompletion(ctx: Context, work: (txCtx: Context) => Promise<void>): Promise<void> {
    const [txCtx, drain] = withAfterCommit(ctx);
    await work(txCtx);
    await drain();
}

async function createEnvironment(name: string) {
    const compactCalls: string[] = [];
    const agents = {
        compact: async (_ctx: Context, agentId: string) => {
            compactCalls.push(agentId);
        },
        parentOf: () => Promise.resolve(null),
    } as unknown as AgentSystemRef;
    const events = new EventsModule();
    const history = new HistoryModule(events);
    const usage = new UsageModule(events);
    const compactions = new CompactionsModule(events, usage, history);
    const database = moduleDatabase(
        [
            ...events.migrations,
            ...history.migrations,
            ...usage.migrations,
            ...compactions.migrations,
        ],
        name,
    );
    await database.ready;
    await events.beforeStart?.(database.context);
    const hooks = await resolveModuleHooks(database.context, compactions, agents);
    return { agents, compactCalls, compactions, database, events, history, hooks, usage };
}

async function startBaseAttempt(
    hooks: AgentModuleHooks,
    ctx: Context,
    agentScope: AgentModuleScope,
    input: {
        readonly compactionId: string;
        readonly contextTokens?: number;
        readonly loopId?: string;
    },
): Promise<void> {
    await hooks.beforeCompaction?.(ctx, agentScope, {
        compactionId: input.compactionId,
        contextTokens: input.contextTokens,
        loopId: input.loopId ?? "loop1",
        turnId: "turn1",
    });
}

describe("CompactionsModule", () => {
    const databases: ReturnType<typeof moduleDatabase>[] = [];

    afterEach(() => {
        for (const database of databases.splice(0)) database.close();
    });

    it("contributes the argument-free compaction command", async () => {
        const environment = await createEnvironment("compactions-slash-command");
        databases.push(environment.database);

        await expect(
            environment.compactions.slashCommands(environment.database.context, "agent1"),
        ).resolves.toEqual([
            {
                description: "Summarize older messages to free context space.",
                hasArguments: false,
                kind: "compaction",
                name: "compact",
            },
        ]);
    });

    it("records successful manual lifecycle and the first replacement measurement", async () => {
        const environment = await createEnvironment("compactions-manual-success");
        databases.push(environment.database);
        const { compactCalls, compactions, database, hooks } = environment;
        const lifecycleEvents: AgentEvent[] = [];
        environment.events.subscribe((event) => {
            if (event.type.startsWith("compaction.message-")) lifecycleEvents.push(event);
        });

        const started = await compactions.startManual(database.context, "agent1");
        expect(started).toMatchObject({ status: "running", trigger: "manual" });
        expect(compactCalls).toEqual(["agent1"]);
        await startBaseAttempt(hooks, database.context, scope(database.database), {
            compactionId: "basecompaction1",
            contextTokens: 201_000,
        });
        await inCompletion(database.context, async (txCtx) => {
            await hooks.historyErasedTransact?.(txCtx, scope(database.database), {
                compactionId: "basecompaction1",
                contextTokens: 201_000,
                loopId: "loop1",
                turnId: "turn1",
                result: completedResult(),
            });
        });
        expect(
            (await compactions.listPage(database.context, "agent1")).compactions[0],
        ).toMatchObject({
            id: started.id,
            status: "completed",
            tokensBefore: 120,
        });

        await inCompletion(database.context, async (txCtx) => {
            await hooks.afterInferenceTransact?.(txCtx, scope(database.database), {
                inferenceId: "inference1",
                contextTokens: undefined,
                loopId: "loop2",
                state: "normal",
                tokens: { input: 40_000, output: 2_000 },
                turnId: "turn2",
            });
        });
        expect(
            (await compactions.listPage(database.context, "agent1")).compactions[0],
        ).toMatchObject({ status: "completed", tokensAfter: 42_000 });
        expect(lifecycleEvents.map((event) => event.type)).toEqual([
            "compaction.message-created",
            "compaction.message-updated",
            "compaction.message-updated",
            "compaction.message-updated",
        ]);
    });

    it("replaces the prior context estimate with exact compaction request usage", async () => {
        const environment = await createEnvironment("compactions-exact-source-usage");
        databases.push(environment.database);
        const { compactions, database, hooks } = environment;

        await startBaseAttempt(hooks, database.context, scope(database.database), {
            compactionId: "exactsource1",
            contextTokens: 551_000,
        });
        await inCompletion(database.context, async (txCtx) => {
            await hooks.historyErasedTransact?.(txCtx, scope(database.database), {
                compactionId: "exactsource1",
                contextTokens: 551_000,
                loopId: "loop1",
                turnId: "turn1",
                result: {
                    status: "completed",
                    preservedMessages: [],
                    usage: {
                        input: 1_102_000,
                        output: 29_800,
                        cacheRead: 1_000_000,
                        cacheWrite: 50_000,
                        totalTokens: 1_131_800,
                    },
                    context: { instructions: "", messages: [] },
                },
            });
        });

        expect(
            (await compactions.listPage(database.context, "agent1")).compactions[0],
        ).toMatchObject({
            status: "completed",
            tokensBefore: 1_102_000,
        });
    });

    it("keeps a positive provisional size when provider usage is zeroed", async () => {
        const environment = await createEnvironment("compactions-zero-source-usage");
        databases.push(environment.database);
        const { compactions, database, hooks } = environment;

        await startBaseAttempt(hooks, database.context, scope(database.database), {
            compactionId: "zerosource1",
            contextTokens: 551_000,
        });
        await inCompletion(database.context, async (txCtx) => {
            await hooks.historyErasedTransact?.(txCtx, scope(database.database), {
                compactionId: "zerosource1",
                contextTokens: 551_000,
                loopId: "loop1",
                turnId: "turn1",
                result: {
                    status: "completed",
                    preservedMessages: [],
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                    },
                    context: { instructions: "", messages: [] },
                },
            });
        });

        expect(
            (await compactions.listPage(database.context, "agent1")).compactions[0],
        ).toMatchObject({
            status: "completed",
            tokensBefore: 551_000,
        });
    });

    it("settles a failed manual provider outcome with its reason", async () => {
        const environment = await createEnvironment("compactions-manual-failure");
        databases.push(environment.database);
        const { compactions, database, hooks } = environment;
        await compactions.startManual(database.context, "agent1");
        await startBaseAttempt(hooks, database.context, scope(database.database), {
            compactionId: "basecompaction2",
        });
        await hooks.afterCompaction?.(database.context, scope(database.database), {
            compactionId: "basecompaction2",
            contextTokens: undefined,
            loopId: "loop1",
            turnId: "turn1",
            result: {
                status: "failed",
                kind: "inference_error",
                message: "The provider rejected compaction.",
            },
        });
        expect(
            (await compactions.listPage(database.context, "agent1")).compactions[0],
        ).toMatchObject({
            failureReason: "The provider rejected compaction.",
            status: "failed",
            trigger: "manual",
        });
        expect(await compactions.running(database.context, "agent1")).toBeUndefined();
    });

    it("associates automatic compaction with the exact active run", async () => {
        const environment = await createEnvironment("compactions-automatic-run");
        databases.push(environment.database);
        const { compactions, database, events, hooks } = environment;
        const runId = await database.context.inTx(
            async (txCtx) =>
                await events.runIdForAccepted(txCtx, "agent1", {
                    id: "message1",
                    kind: "message",
                    message: { content: [{ type: "text", text: "hello" }] },
                } as never),
        );
        await startBaseAttempt(hooks, database.context, scope(database.database), {
            compactionId: "automatic1",
            contextTokens: 245_000,
            loopId: "loopautomatic1",
        });
        expect(
            (await compactions.listPage(database.context, "agent1")).compactions[0],
        ).toMatchObject({
            id: "automatic1",
            runId,
            status: "running",
            trigger: "automatic",
        });
    });

    it("fails a running attempt during restart reconciliation", async () => {
        const environment = await createEnvironment("compactions-restart");
        databases.push(environment.database);
        const { agents, compactions, database, events, history, usage } = environment;
        const running = await compactions.startManual(database.context, "agent1");

        const restarted = new CompactionsModule(events, usage, history);
        await resolveModuleHooks(database.context, restarted, agents);
        expect((await restarted.listPage(database.context, "agent1")).compactions[0]).toMatchObject(
            {
                id: running.id,
                failureReason: "Compaction was interrupted when the daemon restarted.",
                status: "failed",
            },
        );
        expect(await restarted.running(database.context, "agent1")).toBeUndefined();
    });
});
