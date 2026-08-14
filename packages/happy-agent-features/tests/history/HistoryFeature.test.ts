import { Type } from "@sinclair/typebox";
import {
    Agent,
    defineAgentTool,
    type AgentBasePersistedEvent,
    type AgentFeature,
    type AgentFeatureScope,
} from "@slopus/happy-agent-base";
import type {
    SessionEvent,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    formatHistoryPage,
    HistoryFeature,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_ARGUMENT_DEPTH,
    MAX_HISTORY_ARGUMENT_BYTES,
    MAX_HISTORY_TEXT_LENGTH,
    type HistoryPage,
    type HistoryStore,
} from "../../sources/index.js";
import { InMemoryHistoryStore } from "../support/InMemoryHistoryStore.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { providersOf, sharedKV, textTurn, toolCallTurn, user } from "../support/fixtures.js";

const ctx = createRootContext().named("happy-agent-features-history");

/** A tool that answers with whatever it was asked, so a run has tool activity to record. */
const echoTool = defineAgentTool({
    name: "echo",
    description: "Repeat the given text.",
    parameters: Type.Object({ text: Type.String() }),
    returnType: Type.Object({ text: Type.String() }),
    shouldReviewInAutoMode: () => false,
    execute: (_ctx, args) => Promise.resolve({ text: args.text }),
    toLLM: (result) => [{ type: "text", text: result.text }],
});

/** A tool that always fails, so a failed call has something to be recorded as. */
const failingTool = defineAgentTool({
    name: "fail",
    description: "Always fails.",
    parameters: Type.Object({}),
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => false,
    execute: () => Promise.reject(new Error("the tool gave up")),
    toLLM: () => [{ type: "text", text: "" }],
});

/** The one feature a test needs beyond history itself: something for the model to call. */
const toolsFeature: AgentFeature = {
    name: "test-tools",
    tools: () => [echoTool, failingTool],
};

/** An agent recording into a store a test can look inside. */
async function historyAgent(
    script: SessionEvent[][],
    options: {
        failureMode?: "best-effort" | "propagate";
        resolveTarget?: (
            ctx: Context,
            requesterAgentId: string,
            requestedTarget: string,
        ) => string | undefined | Promise<string | undefined>;
    } = {},
) {
    const store = new InMemoryHistoryStore();
    const history = new HistoryFeature({ store, ...options });
    const agent = await Agent.create(ctx, {
        id: "history-agent",
        providers: providersOf(new ScriptedProvider(script)),
        provider: "scripted",
        model: "scripted/model",
        persistence: new InMemoryPersistence(),
        sharedKV: sharedKV(),
        features: [history, toolsFeature],
    });
    return { agent, history, store };
}

describe("HistoryFeature", () => {
    it("records what the agent said, called, and was told", async () => {
        const { agent, history, store } = await historyAgent([
            [
                { type: "reasoning_start" },
                { type: "reasoning_delta", delta: "thinking it over" },
                { type: "reasoning_end" },
                { type: "text_start" },
                { type: "text_delta", delta: "let me check" },
                { type: "text_end" },
                { type: "toolcall_start", callId: "call-1", name: "echo" },
                {
                    type: "toolcall_end",
                    callId: "call-1",
                    arguments: JSON.stringify({ text: "the answer" }),
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);

        await agent.send(ctx, user("what is the answer"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const recorded = store.messages.get(agent.id) ?? [];
        expect(recorded.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "assistant",
            "assistant",
        ]);
        expect(recorded[1]?.blocks).toEqual([
            { type: "thinking", thinking: "thinking it over" },
            { type: "text", text: "let me check" },
            {
                type: "tool_call",
                callId: "call-1",
                name: "echo",
                arguments: { text: "the answer" },
            },
        ]);
        expect(recorded[1]?.model).toBe("scripted/model");
        expect(recorded[2]?.recordId).toMatch(/^tool:/);
        expect(recorded[2]?.blocks).toEqual([
            {
                type: "tool_result",
                callId: "call-1",
                toolName: "echo",
                output: "the answer",
            },
        ]);
    });

    it("records a failed tool call as the failure it was", async () => {
        const { agent, store } = await historyAgent([
            toolCallTurn("call-1", "fail", "{}"),
            textTurn("that did not work"),
        ]);

        await agent.send(ctx, user("try the failing tool"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const results = (store.messages.get(agent.id) ?? [])
            .filter((message) => message.blocks.some((block) => block.type === "tool_result"))
            .map((message) => ({
                message,
                result: message.blocks.find((block) => block.type === "tool_result"),
            }));
        expect(results).toEqual([
            {
                message: expect.objectContaining({ recordId: expect.stringMatching(/^tool:/) }),
                result: {
                    type: "tool_result",
                    callId: "call-1",
                    toolName: "fail",
                    output: "the tool gave up",
                    isError: true,
                },
            },
        ]);
    });

    it("keeps tool names isolated across call-scoped feature stores", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        const first = historyScope(new Map());
        const second = historyScope(new Map());
        const callA = {
            arguments: "{}",
            callId: "call-a",
            name: "alpha",
            type: "tool_call",
        } satisfies SessionToolCallBlock;
        const callB = {
            arguments: "{}",
            callId: "call-b",
            name: "beta",
            type: "tool_call",
        } satisfies SessionToolCallBlock;
        const resultA = {
            callId: "call-a",
            content: [{ text: "A", type: "text" }],
            role: "tool",
        } satisfies SessionToolResultMessage;
        const resultB = {
            callId: "call-b",
            content: [{ text: "B", type: "text" }],
            role: "tool",
        } satisfies SessionToolResultMessage;

        await history.beforeToolCallTransact(ctx, first, callA);
        await history.beforeToolCallTransact(ctx, second, callB);
        await history.afterToolCallTransact(ctx, second, resultB);
        await history.afterToolCallTransact(ctx, first, resultA);
        await history.beforeToolCallTransact(ctx, first, callA);
        await history.afterToolCallTransact(ctx, first, {
            ...resultA,
            content: [{ text: "A again", type: "text" }],
        });

        const records = store.messages.get("settled-agent") ?? [];
        expect(records.map((message) => message.blocks[0])).toEqual([
            {
                callId: "call-b",
                output: "B",
                toolName: "beta",
                type: "tool_result",
            },
            {
                callId: "call-a",
                output: "A",
                toolName: "alpha",
                type: "tool_result",
            },
            {
                callId: "call-a",
                output: "A again",
                toolName: "alpha",
                type: "tool_result",
            },
        ]);
        expect(new Set(records.map((message) => message.recordId)).size).toBe(3);
    });

    it("deduplicates an exact retry before enforcing the archive capacity", async () => {
        const store = new InMemoryHistoryStore({ maxRecords: 1 });
        const message = {
            blocks: [{ text: "once", type: "text" as const }],
            recordId: "capacity-retry",
            role: "user" as const,
        };
        await store.append(ctx, "capacity-agent", [message]);
        await store.append(ctx, "capacity-agent", [message]);
        await expect(
            store.append(ctx, "capacity-agent", [
                { ...message, recordId: "capacity-new", blocks: [{ text: "new", type: "text" }] },
            ]),
        ).rejects.toThrow("record limit");
    });

    it("never lets a broken store fail the run", async () => {
        const { agent, store } = await historyAgent([textTurn("answered anyway")], {
            failureMode: "best-effort",
        });
        store.broken = true;

        await agent.send(ctx, user("say something"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(store.messages.size).toBe(0);
    });

    it("propagates a strict archive failure instead of silently dropping a manual record", async () => {
        const { agent, store, history } = await historyAgent([]);
        store.broken = true;

        await expect(
            history.record(ctx, agent.id, {
                blocks: [{ text: "must be durable", type: "text" }],
                role: "user",
            }),
        ).rejects.toThrow("The history store is unavailable.");
        await agent.close();
    });

    it("flushes pending response blocks at settlement exactly once", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        const values = new Map<string, unknown>();
        const scope = historyScope(values);
        const event = {
            block: { text: "recovered response", type: "text" },
            type: "text_end",
        } satisfies AgentBasePersistedEvent;

        await history.onEventTransact(ctx, scope, event);
        await history.afterAgentSettledTransact(ctx, scope);
        await history.afterAgentSettledTransact(ctx, scope);

        expect(store.messages.get("settled-agent")).toEqual([
            expect.objectContaining({
                blocks: [{ text: "recovered response", type: "text" }],
                model: "scripted/model",
                provider: "scripted",
                role: "assistant",
            }),
        ]);
        expect(values).toEqual(new Map());
    });

    it("keeps pending blocks when strict settlement archival fails", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        const values = new Map<string, unknown>();
        const scope = historyScope(values);
        await history.onEventTransact(ctx, scope, {
            block: { text: "must survive", type: "text" },
            type: "text_end",
        } satisfies AgentBasePersistedEvent);
        store.broken = true;

        await expect(history.afterAgentSettledTransact(ctx, scope)).rejects.toThrow(
            "The history store is unavailable.",
        );
        expect(values.has("pending_blocks")).toBe(true);
    });

    it("rolls strict transactional archive failures back and retries accepted and inference records", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        const values = new Map<string, unknown>();
        const scope = historyScope(values);

        store.failuresRemaining = 1;
        await expect(
            history.messageAcceptedTransact(ctx, scope, {
                id: "accepted-retry-user",
                kind: "send",
                message: { content: [{ text: "retry user", type: "text" }], role: "user" },
            }),
        ).rejects.toThrow("The history store is unavailable.");
        expect(store.messages.get("settled-agent")).toBeUndefined();
        await history.messageAcceptedTransact(ctx, scope, {
            id: "accepted-retry-user",
            kind: "send",
            message: { content: [{ text: "retry user", type: "text" }], role: "user" },
        });

        await history.onEventTransact(ctx, scope, {
            block: { text: "retry assistant", type: "text" },
            type: "text_end",
        } satisfies AgentBasePersistedEvent);
        store.failuresRemaining = 1;
        await expect(
            history.afterInferenceTransact(ctx, scope, {
                state: "normal",
                tokens: { input: 1, output: 1 },
            }),
        ).rejects.toThrow("The history store is unavailable.");
        expect(values.has("pending_blocks")).toBe(true);

        await history.afterInferenceTransact(ctx, scope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        const messages = store.messages.get("settled-agent") ?? [];
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(values.has("pending_blocks")).toBe(false);
        expect(values.has("pending_record_id")).toBe(false);
    });

    it("rejects malformed pending blocks instead of archiving unchecked data", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        const values = new Map<string, unknown>([["pending_blocks", [{ type: "unknown" }]]]);

        await expect(history.afterAgentSettledTransact(ctx, historyScope(values))).rejects.toThrow(
            "History feature found invalid pending blocks.",
        );
        expect(store.messages.size).toBe(0);
    });

    it("pages, searches, and renders what it recorded", async () => {
        const { agent, history } = await historyAgent([]);
        for (let index = 0; index < 12; index += 1) {
            await history.record(ctx, agent.id, {
                role: index % 2 === 0 ? "user" : "assistant",
                blocks: [{ type: "text", text: `MESSAGE_${index + 1}` }],
            });
        }
        await agent.close();

        const first = await history.read(ctx, agent.id, { limit: 5 });
        expect(first.totalMessages).toBe(12);
        expect(first.messages.map((record) => record.position)).toEqual([0, 1, 2, 3, 4]);
        expect(first.nextCursor).toBe(5);
        expect(first.previousCursor).toBeUndefined();

        const next = await history.read(ctx, agent.id, { cursor: first.nextCursor ?? 0, limit: 5 });
        expect(next.messages.map((record) => record.position)).toEqual([5, 6, 7, 8, 9]);
        expect(next.previousCursor).toBe(0);

        const last = await history.read(ctx, agent.id, { from: "end", limit: 3 });
        expect(last.messages.map((record) => record.position)).toEqual([9, 10, 11]);
        const beyondEnd = await history.read(ctx, agent.id, { cursor: 99, limit: 2 });
        expect(beyondEnd.messages).toEqual([]);
        expect(beyondEnd.cursor).toBe(99);

        const searched = await history.read(ctx, agent.id, { query: "message_7" });
        expect(searched.matchedMessages).toBe(1);
        expect(formatHistoryPage(searched).history).toContain("7. USER");

        const users = await history.read(ctx, agent.id, { roles: ["user"] });
        expect(users.matchedMessages).toBe(6);
        expect(users.matchedStats.userMessages).toBe(6);
    });

    it("uses Unicode case folding for in-memory searches", async () => {
        const { agent, history } = await historyAgent([]);
        await history.record(ctx, agent.id, {
            role: "user",
            blocks: [{ type: "text", text: "ÄPFEL" }],
        });

        const page = await history.read(ctx, agent.id, { query: "äpfel", limit: 1 });
        expect(page.messages.map((record) => record.message.blocks[0])).toEqual([
            { type: "text", text: "ÄPFEL" },
        ]);
        await agent.close();
    });

    it("answers the model's own read through the tool", async () => {
        const { agent, history } = await historyAgent([]);
        await history.record(ctx, agent.id, {
            role: "user",
            blocks: [{ type: "text", text: "remember the port is 8080" }],
        });
        const tools = await Promise.all(
            [history].map((feature) => feature.tools(ctx, { agent: { id: agent.id } } as never)),
        );
        await agent.close();

        const tool = tools.flat()[0];
        if (tool === undefined) throw new Error("The feature offered no tool.");
        expect(tool.name).toBe("read_agent_history");
        const result = (await tool.execute(ctx, { query: "8080" })) as {
            history: string;
            matched_messages: number;
            total_messages: number;
        };
        expect(result.matched_messages).toBe(1);
        expect(result.total_messages).toBe(1);
        expect(result.history).toContain("remember the port is 8080");
    });

    it("denies related-agent reads by default and accepts an injected resolver", async () => {
        const { agent, history, store } = await historyAgent([]);
        await history.record(ctx, agent.id, {
            blocks: [{ text: "self history", type: "text" }],
            role: "user",
        });
        await history.record(ctx, "related-agent", {
            blocks: [{ text: "related history", type: "text" }],
            role: "user",
        });
        const defaultTool = history.tools(ctx, { agent: { id: agent.id } } as never)[0];
        if (defaultTool === undefined) throw new Error("The feature offered no history tool.");
        await expect(defaultTool.execute(ctx, { target: "related-agent" })).rejects.toThrow(
            "History access is limited",
        );

        const allowingHistory = new HistoryFeature({
            resolveTarget: async (_ctx, requester, target) =>
                requester === agent.id && target === "related-agent" ? target : undefined,
            store,
        });
        const allowingTool = allowingHistory.tools(ctx, { agent: { id: agent.id } } as never)[0];
        if (allowingTool === undefined) throw new Error("The feature offered no history tool.");
        const result = (await allowingTool.execute(ctx, {
            target: "related-agent",
        })) as { history: string };
        expect(result.history).toContain("related history");
        await agent.close();
    });

    it("enforces message and page bounds at the public boundary", async () => {
        const { agent, history } = await historyAgent([]);

        await expect(history.read(ctx, agent.id, { limit: 0 } as never)).rejects.toThrow(
            "invalid page query",
        );
        await expect(
            history.read(ctx, agent.id, { limit: MAX_HISTORY_PAGE_SIZE + 1 } as never),
        ).rejects.toThrow("invalid page query");
        await expect(
            history.record(ctx, agent.id, {
                blocks: [
                    {
                        text: "x".repeat(MAX_HISTORY_TEXT_LENGTH + 1),
                        type: "text",
                    },
                ],
                role: "user",
            }),
        ).rejects.toThrow("invalid message");

        await agent.close();
    });

    it("bounds recursive tool arguments by depth and encoded bytes", async () => {
        const { agent, history } = await historyAgent([]);
        let nested: unknown = "leaf";
        for (let index = 0; index <= MAX_HISTORY_ARGUMENT_DEPTH; index += 1) {
            nested = { nested };
        }
        await expect(
            history.record(ctx, agent.id, {
                blocks: [
                    {
                        arguments: nested,
                        callId: "depth-call",
                        name: "depth",
                        type: "tool_call",
                    },
                ],
                role: "assistant",
            } as never),
        ).rejects.toThrow("invalid message");
        await expect(
            history.record(ctx, agent.id, {
                blocks: [
                    {
                        arguments: "x".repeat(MAX_HISTORY_ARGUMENT_BYTES + 1),
                        callId: "bytes-call",
                        name: "bytes",
                        type: "tool_call",
                    },
                ],
                role: "assistant",
            } as never),
        ).rejects.toThrow("invalid message");
        await agent.close();
    });

    it("rejects a stalled cursor or duplicate persisted identity from an adapter", async () => {
        const message = {
            blocks: [{ text: "one", type: "text" as const }],
            recordId: "record-1",
            role: "user" as const,
        };
        const stats = {
            assistantMessages: 0,
            messages: 1,
            textCharacters: 3,
            thinkingBlocks: 0,
            toolCalls: 0,
            toolResults: 0,
            userMessages: 1,
        };
        const stalledPage: HistoryPage = {
            agentId: "history-agent",
            cursor: 0,
            matchedMessages: 1,
            matchedStats: stats,
            messages: [{ message, position: 0 }],
            nextCursor: 0,
            totalMessages: 1,
            totalStats: stats,
        };
        const stalledHistory = new HistoryFeature({
            store: fixedHistoryStore(stalledPage),
        });
        await expect(stalledHistory.read(ctx, "history-agent", { limit: 1 })).rejects.toThrow(
            "stalled next cursor",
        );

        const { nextCursor: _stalledNextCursor, ...stalledPageWithoutNext } = stalledPage;
        const duplicatePage: HistoryPage = {
            ...stalledPageWithoutNext,
            messages: [
                { message, position: 0 },
                { message, position: 1 },
            ],
            matchedMessages: 2,
            matchedStats: { ...stats, messages: 2, textCharacters: 6, userMessages: 2 },
            totalMessages: 2,
            totalStats: { ...stats, messages: 2, textCharacters: 6, userMessages: 2 },
        };
        const duplicateHistory = new HistoryFeature({
            store: fixedHistoryStore(duplicatePage),
        });
        await expect(duplicateHistory.read(ctx, "history-agent", { limit: 2 })).rejects.toThrow(
            "invalid record",
        );

        const truncatedFromEnd: HistoryPage = {
            ...stalledPageWithoutNext,
            cursor: 1,
            matchedMessages: 2,
            matchedStats: { ...stats, messages: 2, textCharacters: 6, userMessages: 2 },
            messages: [{ message, position: 1 }],
            totalMessages: 2,
            totalStats: { ...stats, messages: 2, textCharacters: 6, userMessages: 2 },
        };
        const missingOlderCursor = new HistoryFeature({
            store: {
                append: async () => undefined,
                read: async () => truncatedFromEnd,
            },
        });
        await expect(
            missingOlderCursor.read(ctx, "history-agent", { from: "end", limit: 1 }),
        ).rejects.toThrow("older page");

        const emptyBeyondEnd: HistoryPage = {
            ...truncatedFromEnd,
            cursor: 99,
            messages: [],
            matchedMessages: 2,
        };
        const missingBeyondEndCursor = new HistoryFeature({
            store: {
                append: async () => undefined,
                read: async () => emptyBeyondEnd,
            },
        });
        await expect(
            missingBeyondEndCursor.read(ctx, "history-agent", { cursor: 99, limit: 1 }),
        ).rejects.toThrow("older page");
    });
});

function historyScope(values: Map<string, unknown>): AgentFeatureScope {
    return {
        agent: {
            id: "settled-agent",
            model: "scripted/model",
            provider: "scripted",
        },
        runKV: {
            delete: async (_ctx: unknown, key: string) => {
                values.delete(key);
            },
            read: async (_ctx: unknown, key: string) => values.get(key),
            write: async (_ctx: unknown, key: string, value: unknown) => {
                values.set(key, value);
            },
        },
    } as unknown as AgentFeatureScope;
}

function fixedHistoryStore(page: HistoryPage): HistoryStore {
    return {
        append: async () => undefined,
        read: async () => page,
    };
}
