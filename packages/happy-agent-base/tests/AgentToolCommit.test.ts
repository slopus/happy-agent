import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { afterCommit, createRootContext, type Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    AgentKV,
    agentKV,
    cuid2Schema,
    defineAgentTool,
    type AgentBasePersistedEvent,
    type AgentToolCall,
} from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agent-tool-commit-test");

function toolCallTurn(providerCallId: string, name: string): SessionEvent[] {
    return [
        { type: "toolcall_start", callId: providerCallId, name },
        { type: "toolcall_end", callId: providerCallId, arguments: "{}" },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

function generatedCallId() {
    return expect.stringMatching(/^[a-z][a-z0-9]{1,31}$/);
}

const resultSchema = Type.Object({ value: Type.String() });
type Result = { readonly value: string };

describe("transactional tool commits", () => {
    it("replaces the provider ID with one Base CUID2 before persistence and execution", async () => {
        const providerCallId = "provider.call.with.dots";
        const persistence = new InMemoryPersistence();
        const events: SessionEvent[] = [];
        const persistedEvents: AgentBasePersistedEvent[] = [];
        let received: AgentToolCall<typeof resultSchema> | undefined;
        let secondCommit: Result | undefined;
        let storedDuringExecution: unknown;
        let operationFactoryCalls = 0;
        const tool = defineAgentTool({
            name: "transactional",
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                received = call;
                storedDuringExecution = [...persistence.values.entries()].find(([key]) =>
                    key.startsWith("tool."),
                )?.[1];
                return await call.kv.transaction(toolCtx, async (kv, txCtx) => {
                    await kv.write(txCtx, "temporary", "value");
                    const operationId = await kv.getOrCreate(txCtx, "operation", () => {
                        operationFactoryCalls += 1;
                        return "operation-1";
                    });
                    expect(await kv.getOrCreate(txCtx, "operation", () => "operation-2")).toBe(
                        operationId,
                    );
                    const first = await call.commit(txCtx, { value: "committed first" });
                    secondCommit = await call.commit(txCtx, {
                        invalid: "ignored after winner",
                    } as never);
                    expect(first).toEqual({ value: "committed first" });
                    return { value: "ignored return" };
                });
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const provider = new ScriptedProvider([
            [
                {
                    type: "toolcall_start",
                    callId: providerCallId,
                    name: tool.name,
                    vendor: { provider: "test", opaque: true },
                },
                { type: "toolcall_end", callId: providerCallId, arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "transactional-tool",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => events.push(event),
                onEventTransact: (_hookCtx, event) => {
                    persistedEvents.push(event);
                },
            },
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"));
        await agent.waitForIdle();

        expect(Value.Check(cuid2Schema, received?.id)).toBe(true);
        expect(received?.id).not.toBe(providerCallId);
        expect(received).not.toHaveProperty("providerCallId");
        expect(secondCommit).toEqual({ value: "committed first" });
        expect(operationFactoryCalls).toBe(1);
        expect(storedDuringExecution).toMatchObject({
            id: received?.id,
            call: { type: "tool_call", name: tool.name, arguments: "{}" },
        });
        expect(storedDuringExecution).not.toHaveProperty("providerCallId");
        expect(JSON.stringify(storedDuringExecution)).not.toContain(providerCallId);
        expect(events.filter((event) => event.type.startsWith("toolcall_"))).toEqual([
            { type: "toolcall_start", callId: received?.id, name: tool.name },
            { type: "toolcall_end", callId: received?.id, arguments: "{}" },
        ]);
        expect(persistedEvents.filter((event) => event.type === "toolcall_end")).toEqual([
            {
                type: "toolcall_end",
                callId: received?.id,
                arguments: "{}",
                block: {
                    type: "tool_call",
                    callId: received?.id,
                    name: tool.name,
                    arguments: "{}",
                },
            },
        ]);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: providerCallId,
            content: [{ type: "text", text: "committed first" }],
        });
        expect(
            [...persistence.values.keys()].filter((key) =>
                key.startsWith(`kv.transactional-tool.call.${received?.id}.`),
            ),
        ).toEqual([]);
        await agent.close();
    });

    it("erases the bound KV atomically for ordinary returned results too", async () => {
        const persistence = new InMemoryPersistence();
        let id = "";
        let lateCommit!: () => Promise<Result>;
        const tool = defineAgentTool({
            name: "ordinary",
            returnType: resultSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                id = call.id;
                lateCommit = async () =>
                    await call.commit(toolCtx, { value: "too late to commit" });
                await call.kv.write(toolCtx, "temporary", true);
                return { value: "ordinary result" };
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const agent = await AgentBase.create(ctx, {
            id: "ordinary-tool",
            providers: providersOf(
                new ScriptedProvider([
                    toolCallTurn("provider-ordinary", tool.name),
                    textTurn("ok"),
                ]),
            ),
            provider: "scripted",
            persistence,
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"));
        await agent.waitForIdle();

        expect(id).not.toBe("");
        await expect(lateCommit()).rejects.toThrow("can no longer commit");
        expect(
            [...persistence.values.keys()].filter((key) =>
                key.startsWith(`kv.ordinary-tool.call.${id}.`),
            ),
        ).toEqual([]);
        await agent.close();
    });

    it("keeps call KV available when result rendering rejects a commit before persistence", async () => {
        let firstFailure: unknown;
        const tool = defineAgentTool({
            name: "render_retry",
            returnType: resultSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                try {
                    await call.commit(toolCtx, { value: "bad rendering" });
                } catch (error: unknown) {
                    firstFailure = error;
                }
                await call.kv.write(toolCtx, "retry-still-live", true);
                return await call.commit(toolCtx, { value: "good rendering" });
            },
            toLLM: (result) => {
                if (result.value === "bad rendering") throw new Error("render failed");
                return [{ type: "text", text: result.value }];
            },
        });
        const provider = new ScriptedProvider([
            toolCallTurn("provider-render-retry", tool.name),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "render-retry-tool",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"));
        await agent.waitForIdle();

        expect(firstFailure).toMatchObject({ message: "render failed" });
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "provider-render-retry",
            content: [{ type: "text", text: "good rendering" }],
        });
        await agent.close();
    });

    it("rejects writes after a bounded scope has ended", async () => {
        const callKV = new AgentKV(new InMemoryPersistence(), "call.");
        const lifetime = new AbortController();
        const bounded = callKV.until(lifetime.signal);
        lifetime.abort();
        await expect(bounded.write(ctx, "value", true)).rejects.toThrow(
            "the work its context belongs to has ended",
        );
    });

    it("persists one internal identity for undispatched error settlement and clears its KV", async () => {
        const persistence = new InMemoryPersistence();
        const prefixes: string[] = [];
        let failSettlement = true;
        const hooks = {
            afterToolCallTransact: async (hookCtx: Context) => {
                const kv = agentKV(hookCtx);
                if (kv === undefined) throw new Error("missing call KV");
                prefixes.push(kv.prefix);
                await kv.write(hookCtx, "temporary", true);
                if (failSettlement) {
                    failSettlement = false;
                    throw new Error("retry settlement");
                }
            },
        };
        const first = await AgentBase.create(ctx, {
            id: "undispatched-tool-settlement",
            providers: providersOf(
                new ScriptedProvider([
                    [
                        {
                            type: "toolcall_start",
                            callId: "provider-undispatched",
                            name: "missing",
                        },
                        {
                            type: "toolcall_end",
                            callId: "provider-undispatched",
                            arguments: "{}",
                        },
                        {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: "provider failed",
                        },
                    ],
                ]),
            ),
            provider: "scripted",
            persistence,
            hooks,
        });
        await first.send(ctx, user("begin"));
        while (prefixes.length === 0) await Promise.resolve();
        await first.close();

        const second = await AgentBase.load(ctx, {
            id: "undispatched-tool-settlement",
            providers: providersOf(new ScriptedProvider([textTurn("continued")])),
            provider: "scripted",
            persistence,
            hooks,
        });
        second.start();
        await second.waitForIdle();

        expect(prefixes).toHaveLength(2);
        expect(prefixes[1]).toBe(prefixes[0]);
        expect(
            [...persistence.values.keys()].filter((key) => key.startsWith(prefixes[0]!)),
        ).toEqual([]);
        await second.close();
    });

    it("settles from a committed result without waiting for execute to return", async () => {
        let postCommitWrite: unknown;
        let committed!: () => void;
        const committedResult = new Promise<void>((resolve) => {
            committed = resolve;
        });
        const tool = defineAgentTool({
            name: "commit_then_wait",
            returnType: resultSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                await call.commit(toolCtx, { value: "already durable" });
                committed();
                try {
                    await call.kv.write(ctx, "recreated", true);
                } catch (error: unknown) {
                    postCommitWrite = error;
                }
                return await new Promise<Result>(() => undefined);
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const provider = new ScriptedProvider([
            toolCallTurn("provider-early", tool.name),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "early-tool-commit",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"));
        await committedResult;
        await agent.waitForIdle();

        expect(postCommitWrite).toMatchObject({
            message: "The store cannot be used: the work its context belongs to has ended.",
        });
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "provider-early",
            content: [{ type: "text", text: "already durable" }],
        });
        await agent.close();
    });

    it("commits transactional execute only after the tool exits", async () => {
        const persistence = new InMemoryPersistence();
        const events: string[] = [];
        let release!: () => void;
        let staged!: () => void;
        const mayExit = new Promise<void>((resolve) => {
            release = resolve;
        });
        const reachedPause = new Promise<void>((resolve) => {
            staged = resolve;
        });
        const tool = defineAgentTool({
            name: "transactional_exit",
            returnType: resultSchema,
            durable: true,
            transactional: true,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                events.push("execute");
                await persistence.writeValue(toolCtx, "transactional.marker", "committed");
                afterCommit(toolCtx, () => {
                    events.push("committed");
                });
                await call.commit(toolCtx, { value: "committed winner" });
                events.push("call.commit returned");
                staged();
                await mayExit;
                events.push("execute returned");
                return { value: "ignored return" };
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const provider = new ScriptedProvider([
            toolCallTurn("provider-transactional-exit", tool.name),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "transactional-exit",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"));
        await reachedPause;

        expect(persistence.values.has("transactional.marker")).toBe(false);
        expect(events).toEqual(["execute", "call.commit returned"]);
        expect(provider.sessions[0]?.requests).toHaveLength(1);

        release();
        await agent.waitForIdle();

        expect(persistence.values.get("transactional.marker")).toBe("committed");
        expect(events).toEqual([
            "execute",
            "call.commit returned",
            "execute returned",
            "committed",
        ]);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "provider-transactional-exit",
            content: [{ type: "text", text: "committed winner" }],
        });
        await agent.close();
    });

    it("rolls back transactional execute and a nested call.commit when the tool throws", async () => {
        const persistence = new InMemoryPersistence();
        let committed = false;
        const tool = defineAgentTool({
            name: "transactional_throw",
            returnType: resultSchema,
            durable: true,
            transactional: true,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                await persistence.writeValue(toolCtx, "transactional.rolled-back", true);
                afterCommit(toolCtx, () => {
                    committed = true;
                });
                await call.commit(toolCtx, { value: "must roll back" });
                throw new Error("transactional failure");
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const provider = new ScriptedProvider([
            toolCallTurn("provider-transactional-throw", tool.name),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "transactional-throw",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"));
        await agent.waitForIdle();

        expect(persistence.values.has("transactional.rolled-back")).toBe(false);
        expect(committed).toBe(false);
        expect([...persistence.values.keys()].some((key) => key.startsWith("toolResult."))).toBe(
            false,
        );
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "provider-transactional-throw",
            content: [{ type: "text", text: "transactional failure" }],
            isError: true,
        });
        await agent.close();
    });

    it.each([
        {
            failure: "invalid result",
            expected: 'Tool "transactional_invalid result" returned an invalid result.',
        },
        {
            failure: "render failure",
            expected: "transactional render failure",
        },
    ])("rolls back transactional execute on $failure", async ({ failure, expected }) => {
        const persistence = new InMemoryPersistence();
        const name = `transactional_${failure}`;
        const tool = defineAgentTool({
            name,
            returnType: resultSchema,
            transactional: true,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx) => {
                await persistence.writeValue(toolCtx, "transactional.invalid", true);
                if (failure === "invalid result") return { invalid: true } as never;
                return { value: "cannot render" };
            },
            toLLM: (result) => {
                if (failure === "render failure") {
                    throw new Error("transactional render failure");
                }
                return [{ type: "text", text: result.value }];
            },
        });
        const provider = new ScriptedProvider([
            toolCallTurn(`provider-${failure}`, tool.name),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: `transactional-${failure}`,
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"));
        await agent.waitForIdle();

        expect(persistence.values.has("transactional.invalid")).toBe(false);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: `provider-${failure}`,
            content: [{ type: "text", text: expected }],
            isError: true,
        });
        await agent.close();
    });

    it("leaves ordinary execute outside a transaction while wrapping transactional execute", async () => {
        class TracingPersistence extends InMemoryPersistence {
            readonly events: string[] = [];

            override async transaction<Returned>(
                transactionCtx: Context,
                work: (workCtx: Context) => Promise<Returned>,
            ): Promise<Returned> {
                this.events.push("transaction:begin");
                try {
                    const result = await super.transaction(transactionCtx, work);
                    this.events.push("transaction:commit");
                    return result;
                } catch (error: unknown) {
                    this.events.push("transaction:rollback");
                    throw error;
                }
            }
        }

        const run = async (transactional: boolean): Promise<readonly string[]> => {
            const persistence = new TracingPersistence();
            const implementation = async (): Promise<Result> => {
                persistence.events.push("execute:start");
                await Promise.resolve();
                persistence.events.push("execute:end");
                return { value: "done" };
            };
            const tool = transactional
                ? defineAgentTool({
                      name: "transaction_order",
                      returnType: resultSchema,
                      transactional: true,
                      shouldReviewInAutoMode: () => false,
                      execute: implementation,
                      toLLM: (result) => [{ type: "text", text: result.value }],
                  })
                : defineAgentTool({
                      name: "ordinary_order",
                      returnType: resultSchema,
                      shouldReviewInAutoMode: () => false,
                      execute: implementation,
                      toLLM: (result) => [{ type: "text", text: result.value }],
                  });
            const agent = await AgentBase.create(ctx, {
                id: transactional ? "transaction-order" : "ordinary-order",
                providers: providersOf(
                    new ScriptedProvider([
                        toolCallTurn(
                            transactional
                                ? "provider-transaction-order"
                                : "provider-ordinary-order",
                            tool.name,
                        ),
                        textTurn("continued"),
                    ]),
                ),
                provider: "scripted",
                persistence,
                hooks: {
                    beforeToolCall: () => {
                        persistence.events.push("before");
                        return undefined;
                    },
                },
                initialState: { tools: [tool] },
            });

            await agent.send(ctx, user("run it"));
            await agent.waitForIdle();
            const relevant = persistence.events.slice(persistence.events.indexOf("before"));
            await agent.close();
            return relevant;
        };

        const ordinary = await run(false);
        expect(ordinary.indexOf("execute:start")).toBeGreaterThan(ordinary.indexOf("before"));
        expect(ordinary.indexOf("transaction:begin")).toBeGreaterThan(
            ordinary.indexOf("execute:end"),
        );

        const transactional = await run(true);
        expect(transactional.indexOf("transaction:begin")).toBeGreaterThan(
            transactional.indexOf("before"),
        );
        expect(transactional.indexOf("transaction:begin")).toBeLessThan(
            transactional.indexOf("execute:start"),
        );
        expect(transactional.lastIndexOf("transaction:commit")).toBeGreaterThan(
            transactional.indexOf("execute:end"),
        );
    });

    it.each(["abort", "close"] as const)(
        "keeps the committed winner when %s races the still-running execution",
        async (ending) => {
            const persistence = new InMemoryPersistence();
            let committed!: () => void;
            const committedResult = new Promise<void>((resolve) => {
                committed = resolve;
            });
            const tool = defineAgentTool({
                name: `commit_before_${ending}`,
                returnType: resultSchema,
                shouldReviewInAutoMode: () => false,
                execute: async (toolCtx, _args, call) => {
                    await call.commit(toolCtx, { value: "winner" });
                    committed();
                    return await new Promise<Result>(() => undefined);
                },
                toLLM: (result) => [{ type: "text", text: result.value }],
            });
            const agent = await AgentBase.create(ctx, {
                id: `commit-${ending}-race`,
                providers: providersOf(
                    new ScriptedProvider([
                        toolCallTurn(`provider-${ending}`, tool.name),
                        textTurn("continued"),
                    ]),
                ),
                provider: "scripted",
                persistence,
                initialState: { tools: [tool] },
            });

            await agent.send(ctx, user("run it"));
            await committedResult;
            if (ending === "abort") {
                await agent.abort(ctx);
                await agent.waitForIdle();
            } else {
                await agent.close();
            }

            expect(persistence.records.findLast((record) => record.type === "tool")).toMatchObject({
                type: "tool",
                id: generatedCallId(),
                message: {
                    callId: `provider-${ending}`,
                    content: [{ type: "text", text: "winner" }],
                },
            });
            if (ending === "abort") await agent.close();
        },
    );
});
