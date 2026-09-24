import { Type } from "@sinclair/typebox";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AGENT_BASE_PENDING_KEY,
    AgentBase,
    agentBaseStoreOwesWork,
    agentRunKV,
    defineAgentTool,
    type AgentRecord,
} from "../sources/index.js";
import { providersOf, queued, textTurn, user, userRecord } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-base-lifecycle-edges");
const LOOP_ID = "l12345678901234567890123";
const INFERENCE_ID = "i12345678901234567890123";
const CALL_ID = "c12345678901234567890123";

function sendKeys(persistence: InMemoryPersistence): string[] {
    return [...persistence.values.keys()].filter((key) => key.startsWith("send."));
}

/** What a process killed right after the latest commit would leave behind. */
interface StoreImage {
    readonly records: AgentRecord[];
    readonly values: Map<string, unknown>;
}

/**
 * A store that lets a test act right after the run durably records that it decided to settle,
 * and that keeps an image of itself after every commit, so each point a crash could land is
 * inspectable.
 */
class SettlingPersistence extends InMemoryPersistence {
    readonly images: StoreImage[] = [];
    onSettlementStage: (() => Promise<void>) | undefined;
    #settlementStageWritten = false;

    override async writeValue(c: Context, key: string, value: unknown): Promise<void> {
        await super.writeValue(c, key, value);
        const stage = (value as { stage?: string } | undefined)?.stage;
        if (key === AGENT_BASE_PENDING_KEY && stage === "settlement") {
            this.#settlementStageWritten = true;
        }
    }

    override async transaction<Result>(
        c: Context,
        work: (c: Context) => Promise<Result>,
    ): Promise<Result> {
        const result = await super.transaction(c, work);
        this.images.push({
            records: structuredClone(this.records),
            values: new Map(structuredClone([...this.values])),
        });
        if (this.#settlementStageWritten) {
            this.#settlementStageWritten = false;
            const hook = this.onSettlementStage;
            this.onSettlementStage = undefined;
            await hook?.();
        }
        return result;
    }
}

function toolCallTurn(callId: string, name: string): SessionEvent[] {
    return [
        { type: "toolcall_start", callId, name },
        { type: "toolcall_end", callId, arguments: "{}" },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

describe("a message accepted while the run settles", () => {
    it("stays owed at every commit and is answered by the same process", async () => {
        const persistence = new SettlingPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agent = await AgentBase.create(ctx, {
            id: "settle-race",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });
        persistence.onSettlementStage = async () => {
            await persistence.outsideTransaction(() => agent.send(ctx, user("racing")));
        };

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        expect(persistence.onSettlementStage).toBeUndefined();
        // A crash after any commit finds a queued message only in a store that still owes it.
        for (const image of persistence.images) {
            const queuedMessages = [...image.values.keys()].some((key) => key.startsWith("send."));
            if (queuedMessages) expect(image.values.has(AGENT_BASE_PENDING_KEY)).toBe(true);
        }
        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(sendKeys(persistence)).toHaveLength(0);
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("stays owed when it commits before the settlement stage is recorded", async () => {
        let agent!: AgentBase;
        // Armed by the last hook before the loop decides to settle; fires on the loop's next
        // store operation, which records the settlement stage.
        let armed = false;
        let raced = false;
        class DecisionWindowPersistence extends SettlingPersistence {
            async #race(): Promise<void> {
                if (!armed) return;
                armed = false;
                raced = true;
                await this.outsideTransaction(() => agent.send(ctx, user("racing")));
            }

            override async writeValue(c: Context, key: string, value: unknown): Promise<void> {
                await this.#race();
                await super.writeValue(c, key, value);
            }

            override async transaction<Result>(
                c: Context,
                work: (c: Context) => Promise<Result>,
            ): Promise<Result> {
                await this.#race();
                return await super.transaction(c, work);
            }
        }
        const persistence = new DecisionWindowPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let loops = 0;
        agent = await AgentBase.create(ctx, {
            id: "decision-window",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentLoop: () => {
                    loops += 1;
                    if (loops === 1) armed = true;
                },
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        expect(raced).toBe(true);
        for (const image of persistence.images) {
            const queuedMessages = [...image.values.keys()].some((key) => key.startsWith("send."));
            if (queuedMessages) expect(image.values.has(AGENT_BASE_PENDING_KEY)).toBe(true);
        }
        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(sendKeys(persistence)).toHaveLength(0);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("stays owed across a drain, so the next owner answers it", async () => {
        const persistence = new SettlingPersistence();
        const provider = new ScriptedProvider([textTurn("first")]);
        const agent = await AgentBase.create(ctx, {
            id: "settle-drain",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });
        let drained: Promise<void> | undefined;
        persistence.onSettlementStage = async () => {
            drained = agent.drain();
            await persistence.outsideTransaction(() => agent.send(ctx, user("racing")));
        };

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();
        await drained;
        await agent.close();

        expect(sendKeys(persistence)).toHaveLength(1);
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(true);
        const next = new ScriptedProvider([textTurn("second")]);
        const successor = await AgentBase.loadActive(ctx, {
            id: "settle-drain",
            providers: providersOf(next),
            provider: "scripted",
            persistence,
        });
        expect(successor).toBeDefined();
        successor!.start();
        await successor!.waitForIdle();
        expect(next.sessions[0]?.requests).toHaveLength(1);
        expect(sendKeys(persistence)).toHaveLength(0);
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        await successor!.close();
    });
});

describe("an abort", () => {
    it("leaves accepted messages queued without owing a turn", async () => {
        const persistence = new InMemoryPersistence();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        const blocking = defineAgentTool({
            name: "block",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: (toolCtx) =>
                new Promise((resolve) => {
                    started();
                    toolCtx.lifetime?.addEventListener("abort", () => resolve({}));
                }),
            toLLM: () => [],
        });
        const provider = new ScriptedProvider([toolCallTurn("c1", "block"), textTurn("unused")]);
        const agent = await AgentBase.create(ctx, {
            id: "abort-queue",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [blocking] },
        });

        await agent.send(ctx, user("first"));
        await running;
        await agent.send(ctx, user("second"));
        await agent.abort(ctx);
        await agent.waitForIdle();

        expect(agent.active).toBe(false);
        expect(sendKeys(persistence)).toHaveLength(1);
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("that lands before the first turn leaves the message queued and the store settled", async () => {
        let agent!: AgentBase;
        let aborted = false;
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("unused")]);
        agent = await AgentBase.create(ctx, {
            id: "abort-before-turn",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeAgentLoop: async () => {
                    if (aborted) return;
                    aborted = true;
                    await agent.abort(ctx);
                },
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        expect(aborted).toBe(true);
        expect(provider.sessions[0]?.requests ?? []).toHaveLength(0);
        expect(sendKeys(persistence)).toHaveLength(1);
        expect(agent.active).toBe(false);
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        await agent.close();
    });

    it("does not swallow a message sent after it, before the aborted turn starts", async () => {
        let agent!: AgentBase;
        let aborted = false;
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        agent = await AgentBase.create(ctx, {
            id: "send-after-early-abort",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeAgentLoop: async () => {
                    if (aborted) return;
                    aborted = true;
                    await agent.abort(ctx);
                    await persistence.outsideTransaction(() => agent.send(ctx, user("second")));
                },
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        expect(aborted).toBe(true);
        // The message sent after the abort asked for a turn; that turn answers the queue, the
        // message the abort left behind included.
        const answered = (provider.sessions[0]?.requests ?? []).flatMap((request) =>
            request.context.messages.flatMap((message) =>
                message.role === "user"
                    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                    : [],
            ),
        );
        expect(answered).toContain("second");
        expect(sendKeys(persistence)).toHaveLength(0);
        expect(agent.active).toBe(false);
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        await agent.close();
    });

    it("that lands after the settlement commit does not leave the store owing work", async () => {
        let agent!: AgentBase;
        let raced = false;
        class RacingPersistence extends InMemoryPersistence {
            override async transaction<Result>(
                c: Context,
                work: (c: Context) => Promise<Result>,
            ): Promise<Result> {
                const owedBefore = this.values.has(AGENT_BASE_PENDING_KEY);
                const result = await super.transaction(c, work);
                if (!raced && owedBefore && !this.values.has(AGENT_BASE_PENDING_KEY)) {
                    raced = true;
                    // The run has just committed its settlement and has not yet unwound. A
                    // message arrives and the user presses stop, both inside that window.
                    await this.outsideTransaction(() => agent.send(ctx, user("late")));
                    await agent.abort(ctx);
                }
                return result;
            }
        }
        const persistence = new RacingPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("unused")]);
        agent = await AgentBase.create(ctx, {
            id: "abort-window",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        expect(raced).toBe(true);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(sendKeys(persistence)).toHaveLength(1);
        expect(agent.active).toBe(false);
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        await agent.close();
    });

    it("that arrives before tool dispatch starts no tool", async () => {
        let agent!: AgentBase;
        let executions = 0;
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            toolCallTurn("call-1", "side_effect"),
            textTurn("unused"),
        ]);
        agent = await AgentBase.create(ctx, {
            id: "abort-before-dispatch",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "side_effect",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            executions += 1;
                            return Promise.resolve({});
                        },
                        toLLM: () => [{ type: "text", text: "ok" }],
                    }),
                ],
            },
            hooks: {
                afterInference: async () => {
                    await agent.abort(ctx);
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(executions).toBe(0);
        const results = persistence.records.filter((record) => record.type === "tool");
        expect(results).toHaveLength(1);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("revokes an abandoned tool's call state once its result commits", async () => {
        const persistence = new InMemoryPersistence();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        let wrote: Promise<string> | undefined;
        const sticky = defineAgentTool({
            name: "sticky",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: (toolCtx, _args, call) =>
                new Promise((resolve) => {
                    started();
                    toolCtx.lifetime?.addEventListener("abort", () => {
                        // A tool that ignores its own lifetime and keeps writing through a
                        // context of its own after the batch has answered for it.
                        wrote = new Promise<void>((done) => setTimeout(done, 30)).then(() =>
                            call.kv.write(ctx, "leftover", 1).then(
                                () => "written",
                                () => "refused",
                            ),
                        );
                        void wrote.finally(() => resolve({}));
                    });
                }),
            toLLM: () => [],
        });
        const provider = new ScriptedProvider([toolCallTurn("c1", "sticky"), textTurn("unused")]);
        const agent = await AgentBase.create(ctx, {
            id: "abandoned-tool",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [sticky] },
        });

        await agent.send(ctx, user("first"));
        await running;
        await agent.abort(ctx);
        await agent.waitForIdle();

        expect(await wrote).toBe("refused");
        expect([...persistence.values.keys()].filter((key) => key.includes(".call."))).toEqual([]);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("revokes an abandoned tool's run state once its result commits", async () => {
        const persistence = new InMemoryPersistence();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        let wrote: Promise<string> | undefined;
        const sticky = defineAgentTool({
            name: "sticky",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: (toolCtx) =>
                new Promise((resolve) => {
                    started();
                    const runKV = agentRunKV(toolCtx);
                    toolCtx.lifetime?.addEventListener("abort", () => {
                        wrote = new Promise<void>((done) => setTimeout(done, 30)).then(() =>
                            runKV === undefined
                                ? "missing"
                                : runKV.write(ctx, "leftover", 1).then(
                                      () => "written",
                                      () => "refused",
                                  ),
                        );
                        void wrote.finally(() => resolve({}));
                    });
                }),
            toLLM: () => [],
        });
        const provider = new ScriptedProvider([toolCallTurn("c1", "sticky"), textTurn("unused")]);
        const agent = await AgentBase.create(ctx, {
            id: "abandoned-run-state",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [sticky] },
        });

        await agent.send(ctx, user("first"));
        await running;
        await agent.abort(ctx);
        await agent.waitForIdle();

        expect(await wrote).toBe("refused");
        expect([...persistence.values.keys()].filter((key) => key.includes(".run."))).toEqual([]);
        expect(agent.active).toBe(false);
        await agent.close();
    });
});

describe("a restart after a crash mid-response", () => {
    it("resets the interrupted block and continues the response", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("question"),
            { type: "block", block: { type: "text", text: "finished first block" } },
        ]);
        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "inference",
            loopId: LOOP_ID,
            inferenceId: INFERENCE_ID,
        });
        const events: string[] = [];
        const provider = new ScriptedProvider([textTurn("rest of the answer")]);
        const agent = await AgentBase.load(ctx, {
            id: "stale-block",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_c, event) => void events.push(event.type) },
        });
        expect(agent.active).toBe(true);

        agent.start();
        await agent.waitForIdle();

        expect(events).toContain("block_reset");
        expect(events.indexOf("block_reset")).toBeLessThan(events.indexOf("text_start"));
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        await agent.close();
    });

    it("resets the interrupted block before a compaction can record over it", async () => {
        // The first process died streaming the answer to the question: its listener still shows
        // the start of a block that will never finish.
        const persistence = new InMemoryPersistence([userRecord("question")]);
        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "inference",
            loopId: LOOP_ID,
            inferenceId: INFERENCE_ID,
        });
        const events: string[] = [];
        const onEvent = (_c: Context, event: SessionEvent): void => void events.push(event.type);

        // The restarted process compacts first and dies during the compaction.
        let compacting!: () => void;
        const compactionStarted = new Promise<void>((resolve) => {
            compacting = resolve;
        });
        const restarted = await AgentBase.load(ctx, {
            id: "reset-before-compaction",
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent,
                beforeCompaction: () => {
                    compacting();
                    return new Promise<void>(() => undefined);
                },
            },
        });
        void restarted.compact(ctx);
        await compactionStarted;
        const crashed = new InMemoryPersistence(structuredClone(persistence.records));
        for (const [key, value] of persistence.values) {
            crashed.values.set(key, structuredClone(value));
        }

        // The next process continues the response the first one was streaming.
        const provider = new ScriptedProvider([textTurn("the answer")]);
        const successor = await AgentBase.load(ctx, {
            id: "reset-before-compaction",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: crashed,
            hooks: { onEvent },
        });
        successor.start();
        await successor.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(events).toContain("block_reset");
        expect(events.indexOf("block_reset")).toBeLessThan(events.indexOf("text_start"));
        expect(await agentBaseStoreOwesWork(ctx, crashed)).toBe(false);
        await successor.close();
    });

    it("resets the interrupted block before a resumed tool batch can record over it", async () => {
        // The first process died streaming the response after its tool call: the call is
        // durable, the listener still shows the start of the block that followed it.
        const persistence = new InMemoryPersistence([
            userRecord("question"),
            {
                type: "block",
                id: CALL_ID,
                block: { type: "tool_call", callId: CALL_ID, name: "block", arguments: "{}" },
            },
        ]);
        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "inference",
            loopId: LOOP_ID,
            inferenceId: INFERENCE_ID,
        });
        const events: string[] = [];
        const onEvent = (_c: Context, event: SessionEvent): void => void events.push(event.type);

        // The restarted process dispatches the owed call and dies while the tool runs.
        let running!: () => void;
        const toolStarted = new Promise<void>((resolve) => {
            running = resolve;
        });
        const hanging = defineAgentTool({
            name: "block",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: () => {
                running();
                return new Promise<never>(() => undefined);
            },
            toLLM: () => [],
        });
        const restarted = await AgentBase.load(ctx, {
            id: "reset-before-tools",
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            persistence,
            initialState: { tools: [hanging] },
            hooks: { onEvent },
        });
        restarted.start();
        await toolStarted;
        const crashed = new InMemoryPersistence(structuredClone(persistence.records));
        for (const [key, value] of persistence.values) {
            crashed.values.set(key, structuredClone(value));
        }

        // The next process answers the call and continues the response.
        const answered = defineAgentTool({
            name: "block",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: () => Promise.resolve({}),
            toLLM: () => [],
        });
        const provider = new ScriptedProvider([textTurn("the answer")]);
        const successor = await AgentBase.load(ctx, {
            id: "reset-before-tools",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: crashed,
            initialState: { tools: [answered] },
            hooks: { onEvent },
        });
        successor.start();
        await successor.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(events).toContain("block_reset");
        expect(events.indexOf("block_reset")).toBeLessThan(events.indexOf("text_start"));
        expect(await agentBaseStoreOwesWork(ctx, crashed)).toBe(false);
        await successor.close();
    });
});

describe("a provider stream that ends without done", () => {
    it("keeps only the completed blocks and answers no unfinished call", async () => {
        const persistence = new InMemoryPersistence();
        const events: string[] = [];
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "hi" },
                { type: "text_end" },
                { type: "toolcall_start", callId: "p1", name: "tool" },
            ],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "truncated-call",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () => Promise.resolve({}),
                        toLLM: () => [],
                    }),
                ],
            },
            hooks: { onEvent: (_c, event) => void events.push(event.type) },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.records.map((record) => record.type)).toEqual(["user", "block"]);
        expect(events.slice(events.indexOf("toolcall_start"))).toContain("block_reset");
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("still answers the messages queued behind it", async () => {
        const persistence = new InMemoryPersistence();
        persistence.values.set("send.00000000000001.000000", queued(user("one")));
        persistence.values.set("send.00000000000001.000001", queued(user("two")));
        persistence.values.set(AGENT_BASE_PENDING_KEY, { stage: "inference", loopId: LOOP_ID });
        const truncated: SessionEvent[] = [
            { type: "text_start" },
            { type: "text_delta", delta: "partial" },
            { type: "text_end" },
        ];
        const provider = new ScriptedProvider([truncated, textTurn("answer to two")]);
        const agent = await AgentBase.create(ctx, {
            id: "truncated-queue",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(sendKeys(persistence)).toHaveLength(0);
        expect(agent.active).toBe(false);
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        await agent.close();
    });
});

describe("a turn that fails", () => {
    it("leaves the message it could not take queued and the store settled", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("unused")]);
        let attempts = 0;
        const agent = await AgentBase.create(ctx, {
            id: "failed-turn",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                messageAcceptedTransact: () => {
                    attempts += 1;
                    throw new Error("the record could not be written");
                },
            },
        });

        await agent.send(ctx, user("unrecordable"));
        await agent.waitForIdle();

        // The failure answers the turn, so nothing retries it until something asks again.
        expect(attempts).toBe(1);
        expect(provider.sessions[0]?.requests ?? []).toHaveLength(0);
        expect(sendKeys(persistence)).toHaveLength(1);
        expect(agent.active).toBe(false);
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        await agent.close();
    });
});
