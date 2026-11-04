import {
    withAgentContext,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { UsageModule } from "../../sources/usage/UsageModule.js";
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
    agentId: string,
): AgentModuleScope {
    return {
        database,
        agent: {
            id: agentId,
            provider: "codex",
            providerKind: "codex",
            model: "openai/gpt-5.6-sol",
            effort: "high",
            permissionMode: "auto",
        },
        kv: new FakeKV(),
        sharedKV: new FakeKV(),
        runKV: new FakeKV(),
    } as never;
}

async function inCompletion(ctx: Context, work: (txCtx: Context) => Promise<void>): Promise<void> {
    const [txCtx, drain] = withAfterCommit(ctx);
    await work(txCtx);
    await drain();
}

async function acceptRun(
    events: EventsModule,
    ctx: Context,
    agentId: string,
    messageId: string,
    kind: "message" | "steering",
): Promise<string> {
    return await ctx.inTx(
        async (txCtx) =>
            await events.runIdForAccepted(txCtx, agentId, {
                id: messageId,
                kind,
                message: { role: "user", content: [{ type: "text", text: messageId }] },
                // Only a person's steering opens a successor run.
                metadata: USER_MESSAGE_ORIGIN_METADATA,
            } as never),
    );
}

async function recordInference(
    ctx: Context,
    eventsHooks: AgentModuleHooks,
    usageHooks: AgentModuleHooks,
    agentScope: AgentModuleScope,
    input: {
        inferenceId: string;
        loopId: string;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    },
): Promise<void> {
    await usageHooks.beforeInferenceTransact?.(ctx, agentScope, {
        loopId: input.loopId,
        turnId: `turn-${input.inferenceId}`,
        inferenceId: input.inferenceId,
        contextTokens: undefined,
    });
    const event = {
        type: "token_usage" as const,
        usage: {
            input: input.input,
            output: input.output,
            cacheRead: input.cacheRead,
            cacheWrite: input.cacheWrite,
            totalTokens: input.input + input.output,
        },
    };
    await eventsHooks.onEvent?.(ctx, agentScope, event);
    await usageHooks.onEvent?.(ctx, agentScope, event);
    await inCompletion(ctx, async (txCtx) => {
        await usageHooks.afterInferenceTransact?.(txCtx, agentScope, {
            loopId: input.loopId,
            turnId: `turn-${input.inferenceId}`,
            inferenceId: input.inferenceId,
            contextTokens: undefined,
            state: "normal",
            tokens: { input: input.input, output: input.output },
        });
    });
}

async function createEnvironment(name: string, agents: AgentSystemRef) {
    const events = new EventsModule();
    const usage = new UsageModule(events);
    const database = moduleDatabase([...events.migrations, ...usage.migrations], name);
    await database.ready;
    const eventsHooks = await resolveModuleHooks(database.context, events, agents);
    const usageHooks = await resolveModuleHooks(database.context, usage, agents);
    return { database, events, eventsHooks, usage, usageHooks };
}

describe("UsageModule run attribution", () => {
    it("persists exact multi-inference run usage across steering and restart", async () => {
        const agents = {
            parentOf: () => Promise.resolve(null),
        } as unknown as AgentSystemRef;
        const environment = await createEnvironment("usage-run-restart", agents);
        const { database, events, eventsHooks, usage, usageHooks } = environment;
        try {
            const agentScope = scope(database.database, "agent-1");
            const firstRunId = await acceptRun(
                events,
                database.context,
                "agent-1",
                "message-1",
                "message",
            );
            await recordInference(database.context, eventsHooks, usageHooks, agentScope, {
                inferenceId: "inference-1",
                loopId: "loop-1",
                input: 100,
                output: 10,
                cacheRead: 60,
                cacheWrite: 5,
            });
            await recordInference(database.context, eventsHooks, usageHooks, agentScope, {
                inferenceId: "inference-2",
                loopId: "loop-1",
                input: 150,
                output: 20,
                cacheRead: 90,
                cacheWrite: 8,
            });

            const secondRunId = await acceptRun(
                events,
                database.context,
                "agent-1",
                "message-2",
                "steering",
            );
            expect(secondRunId).not.toBe(firstRunId);
            await recordInference(database.context, eventsHooks, usageHooks, agentScope, {
                inferenceId: "inference-3",
                loopId: "loop-2",
                input: 70,
                output: 7,
                cacheRead: 30,
                cacheWrite: 3,
            });

            await expect(usage.readRun(database.context, "agent-1", firstRunId)).resolves.toEqual({
                agentId: "agent-1",
                runId: firstRunId,
                usage: {
                    codex: {
                        "openai/gpt-5.6-sol": {
                            input: 250,
                            output: 30,
                            cacheRead: 150,
                            cacheWrite: 13,
                        },
                    },
                },
                costUsd: null,
            });

            await expect(
                usage.readRuns(database.context, "agent-1", [
                    secondRunId,
                    "run-unknown",
                    firstRunId,
                ]),
            ).resolves.toEqual([
                await usage.readRun(database.context, "agent-1", secondRunId),
                { agentId: "agent-1", runId: "run-unknown", usage: {}, costUsd: null },
                await usage.readRun(database.context, "agent-1", firstRunId),
            ]);
            await expect(usage.readRuns(database.context, "agent-1", [])).resolves.toEqual([]);

            const restartedEvents = new EventsModule();
            await restartedEvents.beforeStart?.(database.context);
            const restartedUsage = new UsageModule(restartedEvents);
            await restartedUsage.beforeStart?.(database.context, agents);
            await expect(
                restartedUsage.readRun(database.context, "agent-1", secondRunId),
            ).resolves.toEqual({
                agentId: "agent-1",
                runId: secondRunId,
                usage: {
                    codex: {
                        "openai/gpt-5.6-sol": {
                            input: 70,
                            output: 7,
                            cacheRead: 30,
                            cacheWrite: 3,
                        },
                    },
                },
                costUsd: null,
            });
        } finally {
            database.close();
        }
    });

    it("isolates run usage by agent and enforces agent-context access", async () => {
        const agents = {
            parentOf: (_ctx: Context, agentId: string) =>
                Promise.resolve(agentId === "child-agent" ? "parent-agent" : null),
        } as unknown as AgentSystemRef;
        const environment = await createEnvironment("usage-run-isolation", agents);
        const { database, events, eventsHooks, usage, usageHooks } = environment;
        try {
            const parentRunId = await acceptRun(
                events,
                database.context,
                "parent-agent",
                "parent-message",
                "message",
            );
            await recordInference(
                database.context,
                eventsHooks,
                usageHooks,
                scope(database.database, "parent-agent"),
                {
                    inferenceId: "parent-inference",
                    loopId: "parent-loop",
                    input: 20,
                    output: 2,
                    cacheRead: 10,
                    cacheWrite: 1,
                },
            );
            const childRunId = await acceptRun(
                events,
                database.context,
                "child-agent",
                "child-message",
                "message",
            );
            await recordInference(
                database.context,
                eventsHooks,
                usageHooks,
                scope(database.database, "child-agent"),
                {
                    inferenceId: "child-inference",
                    loopId: "child-loop",
                    input: 40,
                    output: 4,
                    cacheRead: 25,
                    cacheWrite: 2,
                },
            );

            await expect(
                usage.readRun(database.context, "parent-agent", childRunId),
            ).resolves.toMatchObject({ usage: {} });
            await expect(
                usage.readRun(database.context, "child-agent", childRunId),
            ).resolves.toMatchObject({
                usage: {
                    codex: {
                        "openai/gpt-5.6-sol": { input: 40, output: 4 },
                    },
                },
            });

            const childContext = withAgentContext(database.context, {
                id: "child-agent",
                provider: "codex",
                model: "openai/gpt-5.6-sol",
                permissionMode: "auto",
            });
            await expect(usage.readRun(childContext, "parent-agent", parentRunId)).rejects.toThrow(
                "limited to the current agent",
            );
            await expect(
                usage.readRuns(database.context, "parent-agent", [childRunId, parentRunId]),
            ).resolves.toMatchObject([{ usage: {} }, { runId: parentRunId }]);
            await expect(
                usage.readRuns(childContext, "parent-agent", [parentRunId]),
            ).rejects.toThrow("limited to the current agent");
        } finally {
            database.close();
        }
    });
});
