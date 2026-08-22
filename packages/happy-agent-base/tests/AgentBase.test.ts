import type {
    BaseSession,
    SessionCompaction,
    SessionEvent,
    SessionMessage,
    SessionStream,
    SessionToolCallBlock,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AGENT_BASE_PENDING_KEY,
    AgentBase,
    agentEffort,
    agentHistoryKV,
    agentKV,
    agentModel,
    agentProvider,
    agentServiceTier,
    AgentProviders,
    defineAgentTool,
    type AgentBaseInference,
    type AgentBasePersistedEvent,
    type AgentBaseTurn,
    type AgentBaseTurnStart,
} from "../sources/index.js";
import {
    agentMessage,
    providersOf,
    queued,
    system,
    textTurn,
    user,
    userRecord,
} from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-base-test");

function recordedUser(text: string) {
    return expect.objectContaining({ type: "user", message: user(text) });
}

function storedTool(id: string, call: SessionToolCallBlock) {
    const { callId, server: _server, ...stored } = call;
    return { id, providerCallId: callId, call: stored };
}

function tool(name: string) {
    return defineAgentTool({
        name,
        returnType: Type.Object({}),
        shouldReviewInAutoMode: () => false,
        execute: () => Promise.resolve({}),
        toLLM: () => [{ type: "text", text: "ok" }],
    });
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

describe("AgentBase", () => {
    it("streams one inference from the provider session", async () => {
        const provider = new ScriptedProvider([textTurn("hello there")]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
            initialState: { instructions: "Be brief." },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events.filter((event) => event.type === "text_delta")).toHaveLength(11);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(provider.sessions).toHaveLength(1);
        const request = provider.sessions[0]?.requests[0];
        expect(request?.context.instructions).toBe("Be brief.");
        expect(request?.context.messages).toEqual([user("hi")]);
        await agent.close();
        expect(provider.sessions[0]?.destroyed).toBe(true);
    });

    it("reads mutated state on the next inference", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            [
                { type: "toolcall_start", callId: "call-1", name: "late_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("two"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { instructions: "Original instructions." },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        let executed = false;
        agent.state.instructions = "Changed instructions.";
        agent.state.tools.push(
            defineAgentTool({
                name: "late_tool",
                returnType: Type.Object({}),
                shouldReviewInAutoMode: () => false,
                execute: () => {
                    executed = true;
                    return Promise.resolve({});
                },
                toLLM: () => [],
            }),
        );
        await agent.send(ctx, user("second"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.instructions).toBe(
            "Original instructions.",
        );
        // The changed configuration recreated the provider session, so the model sees the
        // current instructions and tool descriptors.
        expect(provider.sessions[0]?.destroyed).toBe(true);
        const second = provider.sessions[1];
        expect(second?.options.instructions).toBe("Changed instructions.");
        expect(second?.requests[0]?.context.instructions).toBe("Changed instructions.");
        // The tool added after construction executed for the later turn.
        expect(executed).toBe(true);
        expect(second?.requests[1]?.context.messages.at(-1)).toMatchObject({ role: "tool" });
        await agent.close();
    });

    it("keeps a message sent during a run out of it and replays full history", async () => {
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        let agent: AgentBase;
        let sentSecond = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !sentSecond) {
                        sentSecond = true;
                        void agent.send(ctx, user("second"));
                    }
                },
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.requests).toHaveLength(2);
        expect(session?.requests[0]?.context.messages).toEqual([user("first")]);
        expect(session?.requests[1]?.context.messages).toEqual([
            user("first"),
            { role: "assistant", content: [{ type: "text", text: "one" }] },
            user("second"),
        ]);
        await agent.close();
    });

    it("executes a tool call and feeds the result into the next inference", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "read_file" },
                { type: "toolcall_delta", callId: "call-1", delta: '{"path":' },
                { type: "toolcall_end", callId: "call-1", arguments: '{"path":"a.txt"}' },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done reading"),
        ]);
        const seen: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "read_file",
                        parameters: Type.Object({ path: Type.String() }),
                        returnType: Type.Object({ contents: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: (_toolCtx, args) => {
                            // args is statically typed as { path: string } by the schema.
                            seen.push(args.path);
                            return Promise.resolve({ contents: "file contents" });
                        },
                        // result is statically typed as { contents: string } by the schema.
                        toLLM: (result) => [{ type: "text", text: result.contents }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("read it"));
        await agent.waitForIdle();

        expect(seen).toEqual(["a.txt"]);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("read it"),
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: "call-1",
                        name: "read_file",
                        arguments: '{"path":"a.txt"}',
                    },
                ],
            },
            {
                role: "tool",
                callId: "call-1",
                content: [{ type: "text", text: "file contents" }],
            },
        ]);
        await agent.close();
    });

    it("offers only schema-validated tool calls to the before-call hook", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "read_file" },
                {
                    type: "toolcall_end",
                    callId: "call-1",
                    arguments: '{"path":42}',
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("invalid"),
        ]);
        let hooks = 0;
        let executions = 0;
        const agent = await AgentBase.create(ctx, {
            id: "validated-hook-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeToolCall: () => {
                    hooks += 1;
                    return undefined;
                },
            },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "read_file",
                        parameters: Type.Object({ path: Type.String() }),
                        returnType: Type.Null(),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            executions += 1;
                            return null;
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("read it"));
        await agent.waitForIdle();

        expect(hooks).toBe(0);
        expect(executions).toBe(0);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toMatchObject({
            role: "tool",
            isError: true,
        });
        await agent.close();
    });

    it("runs tool calls in parallel and converts failures to error tool results", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-a", name: "slow_tool" },
                { type: "toolcall_end", callId: "call-a", arguments: "{}" },
                { type: "toolcall_start", callId: "call-b", name: "failing_tool" },
                { type: "toolcall_end", callId: "call-b", arguments: "{}" },
                { type: "toolcall_start", callId: "call-c", name: "missing_tool" },
                { type: "toolcall_end", callId: "call-c", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("all done"),
        ]);
        const finished: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "slow_tool",
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            await new Promise((resolve) => setTimeout(resolve, 20));
                            finished.push("slow");
                            return { value: "slow result" };
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                    defineAgentTool({
                        name: "failing_tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            finished.push("failing");
                            return Promise.reject(new Error("tool blew up"));
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The quick tool settles before the slow one: they ran in parallel.
        expect(finished).toEqual(["failing", "slow"]);
        const nextRequest = provider.sessions[0]?.requests[1]?.context.messages;
        expect(nextRequest?.slice(-3)).toEqual([
            {
                role: "tool",
                callId: "call-a",
                content: [{ type: "text", text: "slow result" }],
            },
            {
                role: "tool",
                callId: "call-b",
                content: [{ type: "text", text: "tool blew up" }],
                isError: true,
            },
            {
                role: "tool",
                callId: "call-c",
                content: [{ type: "text", text: 'Tool "missing_tool" is not available.' }],
                isError: true,
            },
        ]);
        await agent.close();
    });

    it("rejects arguments that do not match the tool schema", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "read_file" },
                { type: "toolcall_end", callId: "call-1", arguments: '{"path":123}' },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("sorry"),
        ]);
        let executed = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "read_file",
                        parameters: Type.Object({ path: Type.String() }),
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            executed = true;
                            return Promise.resolve({});
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("read it"));
        await agent.waitForIdle();

        expect(executed).toBe(false);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "call-1",
            content: [
                {
                    type: "text",
                    text: [
                        'The arguments for "read_file" did not match its schema:',
                        "- path: Expected string; received number (123).",
                    ].join("\n"),
                },
            ],
            isError: true,
        });
        await agent.close();
    });

    it("ignores server tool results while keeping the server call in the history", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "srv-1", name: "web_search", server: true },
                { type: "toolcall_end", callId: "srv-1", arguments: '{"query":"weather"}' },
                { type: "toolcall_result_start", callId: "srv-1" },
                { type: "toolcall_result_delta", callId: "srv-1", delta: "sunny" },
                {
                    type: "toolcall_result_end",
                    callId: "srv-1",
                    content: [{ type: "text", text: "sunny" }],
                },
                { type: "text_start" },
                { type: "text_delta", delta: "It is sunny." },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
        ]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("weather?"));
        await agent.waitForIdle();

        // The server call stays in the assistant message; its provider-settled result is
        // ignored — nothing executes, no tool result message joins the history, and the turn
        // needs no follow-up inference.
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(persistence.records).toEqual([
            recordedUser("weather?"),
            {
                type: "block",
                block: {
                    type: "tool_call",
                    callId: "srv-1",
                    name: "web_search",
                    arguments: '{"query":"weather"}',
                    server: true,
                },
            },
            { type: "block", block: { type: "text", text: "It is sunny." } },
        ]);
        // The result events still reach the hooks like every other stream event.
        expect(events.filter((event) => event.type.startsWith("toolcall_result"))).toHaveLength(3);
        await agent.close();
    });

    it("fails the turn when the provider ID is not registered", async () => {
        const persistence = new InMemoryPersistence();
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: new AgentProviders(),
            provider: "missing",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: 'Provider "missing" is not registered.',
            },
        ]);
        expect(persistence.records.at(-1)).toMatchObject({ type: "system" });
        await agent.close();
    });

    it("reports a thrown provider failure as an error done event", async () => {
        class FailingProvider extends ScriptedProvider {
            override session(): Promise<BaseSession> {
                return Promise.reject(new Error("no credentials"));
            }
        }
        const provider = new FailingProvider([]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "no credentials",
            },
        ]);
        await agent.close();
    });
});

describe("AgentBase persistence", () => {
    it("reloads the stored history before each turn", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("earlier question"),
            { type: "block", block: { type: "text", text: "earlier " } },
            { type: "block", block: { type: "text", text: "answer" } },
        ]);
        const provider = new ScriptedProvider([textTurn("fresh"), textTurn("again")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();
        await agent.send(ctx, user("more"));
        await agent.waitForIdle();

        // A turn answers the durable conversation, not the one this instance remembers, so
        // each turn reloads before it decides anything.
        expect(persistence.loads).toBe(2);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("earlier question"),
            {
                role: "assistant",
                content: [
                    { type: "text", text: "earlier " },
                    { type: "text", text: "answer" },
                ],
            },
            user("hi"),
        ]);
        await agent.close();
    });

    it("appends a record for the user message and each finished block", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "reasoning_start" },
                { type: "reasoning_delta", delta: "hmm" },
                { type: "reasoning_end", reasoning: "opaque" },
                { type: "text_start" },
                { type: "text_delta", delta: "sure" },
                { type: "text_end" },
                { type: "toolcall_start", callId: "call-1", name: "read_file" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("ok"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "read_file",
                        returnType: Type.Object({ contents: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: () => Promise.resolve({ contents: "contents" }),
                        toLLM: (result) => [{ type: "text", text: result.contents }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.records).toEqual([
            recordedUser("go"),
            {
                type: "block",
                block: { type: "reasoning", text: "hmm", reasoning: "opaque" },
            },
            { type: "block", block: { type: "text", text: "sure" } },
            {
                type: "block",
                block: {
                    type: "tool_call",
                    callId: "call-1",
                    name: "read_file",
                    arguments: "{}",
                },
            },
            {
                type: "tool",
                message: {
                    role: "tool",
                    callId: "call-1",
                    content: [{ type: "text", text: "contents" }],
                },
            },
            { type: "block", block: { type: "text", text: "ok" } },
        ]);
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("reassembles a turn split by a mid-turn user record", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "part one" },
                { type: "text_end" },
                { type: "text_start" },
                { type: "text_delta", delta: "part two" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
            textTurn("noted"),
        ]);
        let agent: AgentBase;
        let sentMid = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    // Interleave a user write between the turn's two block records.
                    if (event.type === "text_delta" && event.delta === "part two" && !sentMid) {
                        sentMid = true;
                        void agent.send(ctx, user("mid-turn"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const kinds = persistence.records.map((record) =>
            record.type === "user" ? "user" : "block",
        );
        // The mid-turn message waits under its pending key, so the first turn's two block
        // records stay contiguous; it enters the main store only when the follow-up turn
        // consumes it, ahead of that turn's block.
        expect(kinds).toEqual(["user", "block", "block", "user", "block"]);
        expect(persistence.pending.size).toBe(0);

        const reloadedProvider = new ScriptedProvider([textTurn("hello again")]);
        const reloaded = await AgentBase.create(ctx, {
            id: "test-agent-reloaded",
            providers: providersOf(reloadedProvider),
            provider: "scripted",
            persistence,
        });
        await reloaded.send(ctx, user("back"));
        await reloaded.waitForIdle();

        expect(reloadedProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("go"),
            {
                role: "assistant",
                content: [
                    { type: "text", text: "part one" },
                    { type: "text", text: "part two" },
                ],
            },
            user("mid-turn"),
            { role: "assistant", content: [{ type: "text", text: "noted" }] },
            user("back"),
        ]);
        await reloaded.close();
        await agent.close();
    });

    it("resolves send once the message is persisted, before the turn ends", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("slow reply")]);
        let done = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "done") done = true;
                },
            },
        });

        await agent.send(ctx, user("hi"));

        // The message is durably stored the moment send resolves: still under its pending
        // key, or already consumed into the main store if the turn got that far.
        const persisted = [
            ...[...persistence.pending.values()].map(
                (value) => (value as { message: unknown }).message,
            ),
            ...persistence.records
                .filter((record) => record.type === "user")
                .map((record) => record.message),
        ];
        expect(persisted).toEqual([user("hi")]);
        expect(done).toBe(false);
        await agent.waitForIdle();
        expect(done).toBe(true);
        await agent.close();
    });

    it("serializes concurrent sends so storage and replay order match", async () => {
        const persistence = new InMemoryPersistence();
        const write = persistence.writeValue.bind(persistence);
        persistence.writeValue = async (writeCtx, key, value) => {
            // The first write is slow; without the lock the second would land first.
            const { message } = value as Partial<ReturnType<typeof queued>>;
            if (
                message?.role === "user" &&
                message.content[0]?.type === "text" &&
                message.content[0].text === "first"
            ) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await write(writeCtx, key, value);
        };
        const provider = new ScriptedProvider([textTurn("reply")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sendMode: "all",
        });

        await Promise.all([agent.send(ctx, user("first")), agent.send(ctx, user("second"))]);
        await agent.waitForIdle();

        expect(
            persistence.records
                .filter((record) => record.type === "user")
                .map((record) => record.message),
        ).toEqual([user("first"), user("second")]);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("first"),
            user("second"),
        ]);
        await agent.close();
    });

    it("keeps a message whose write failed out of the conversation", async () => {
        const persistence = new InMemoryPersistence();
        persistence.writeValue = () => Promise.reject(new Error("disk full"));
        const provider = new ScriptedProvider([textTurn("never")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await expect(agent.send(ctx, user("hi"))).rejects.toThrow("disk full");
        await agent.waitForIdle();

        expect(persistence.records).toEqual([]);
        expect(persistence.pending.size).toBe(0);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });

    it("rolls the whole pending consumption back when one operation fails", async () => {
        const persistence = new InMemoryPersistence();
        persistence.deleteValue = () => Promise.reject(new Error("delete failed"));
        const provider = new ScriptedProvider([textTurn("never")]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "delete failed",
            },
        ]);
        // The append inside the transaction must not survive the failed delete: the message
        // stays pending only, ready for the next attempt. The failed turn itself surfaces as
        // a system record.
        expect(persistence.records).toEqual([
            {
                type: "system",
                message: {
                    role: "system",
                    content: [{ type: "text", text: "The last turn failed: delete failed" }],
                },
            },
        ]);
        expect([...persistence.pending.values()]).toEqual([
            expect.objectContaining({ message: user("hi"), options: {} }),
        ]);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });

    it("reports a failing load as an error done event while send still persists", async () => {
        const persistence = new InMemoryPersistence();
        persistence.load = () => Promise.reject(new Error("storage offline"));
        const provider = new ScriptedProvider([textTurn("never")]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "storage offline",
            },
        ]);
        // The load failed before any turn could consume the message, so it is still waiting
        // under its pending key rather than in the main context store.
        expect(persistence.records).toEqual([]);
        expect([...persistence.pending.values()]).toEqual([
            expect.objectContaining({ message: user("hi"), options: {} }),
        ]);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });

    it("commits the tool batch to storage first and lands results in call order", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-a", name: "slow_tool" },
                { type: "toolcall_end", callId: "call-a", arguments: "{}" },
                { type: "toolcall_start", callId: "call-b", name: "fast_tool" },
                { type: "toolcall_end", callId: "call-b", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        let keysDuringFast: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "slow_tool",
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            await new Promise((resolve) => setTimeout(resolve, 20));
                            return { value: "slow" };
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                    defineAgentTool({
                        name: "fast_tool",
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            // Both calls are already durable in the sorted store while running.
                            keysDuringFast = [...persistence.values.keys()].filter((key) =>
                                key.startsWith("tool."),
                            );
                            return Promise.resolve({ value: "fast" });
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(keysDuringFast).toHaveLength(2);
        expect(keysDuringFast[0]).toMatch(/^tool\.000000\.[a-z0-9]+$/);
        expect(keysDuringFast[1]).toMatch(/^tool\.000001\.[a-z0-9]+$/);
        // The fast tool finished first, but its result waited for the earlier call to commit.
        expect(
            persistence.records
                .filter((record) => record.type === "tool")
                .map((record) => record.message.callId),
        ).toEqual(["call-a", "call-b"]);
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("start resumes an interrupted tool batch, retrying only durable tools", async () => {
        const durableCall = {
            type: "tool_call" as const,
            callId: "call-a",
            name: "durable_tool",
            arguments: "{}",
        };
        const fragileCall = {
            type: "tool_call" as const,
            callId: "call-b",
            name: "fragile_tool",
            arguments: "{}",
        };
        // The crash happened after the batch was committed but before any result landed.
        const persistence = new InMemoryPersistence([
            userRecord("go"),
            { type: "block", block: durableCall },
            { type: "block", block: fragileCall },
        ]);
        persistence.values.set("tool.000000.durablecall", storedTool("durablecall", durableCall));
        persistence.values.set("tool.000001.fragilecall", storedTool("fragilecall", fragileCall));
        const provider = new ScriptedProvider([textTurn("recovered")]);
        const notice = system("Recovery finished before this notice was injected.");
        let durableRuns = 0;
        let fragileRuns = 0;
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "durable_tool",
                        durable: true,
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            durableRuns += 1;
                            return Promise.resolve({ value: "retried result" });
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                    defineAgentTool({
                        name: "fragile_tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            fragileRuns += 1;
                            return Promise.resolve({});
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        agent.start();
        await agent.waitForIdle();

        expect(durableRuns).toBe(1);
        expect(fragileRuns).toBe(0);
        expect(persistence.records.slice(-4)).toEqual([
            {
                type: "tool",
                message: {
                    role: "tool",
                    callId: "call-a",
                    content: [{ type: "text", text: "retried result" }],
                },
            },
            {
                type: "tool",
                message: {
                    role: "tool",
                    callId: "call-b",
                    content: [
                        {
                            type: "text",
                            text: "The tool call was interrupted by a restart and was not retried.",
                        },
                    ],
                    isError: true,
                },
            },
            expect.objectContaining({ type: "system", message: notice }),
            { type: "block", block: { type: "text", text: "recovered" } },
        ]);
        expect(persistence.pending.size).toBe(0);
        // The follow-up inference saw the full context: call blocks then both results.
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("go"),
            { role: "assistant", content: [durableCall, fragileCall] },
            {
                role: "tool",
                callId: "call-a",
                content: [{ type: "text", text: "retried result" }],
            },
            {
                role: "tool",
                callId: "call-b",
                content: [
                    {
                        type: "text",
                        text: "The tool call was interrupted by a restart and was not retried.",
                    },
                ],
                isError: true,
            },
            notice,
        ]);
        await agent.close();
    });

    it("start finishes a turn cut off before the assistant replied", async () => {
        const persistence = new InMemoryPersistence([userRecord("still waiting")]);
        const provider = new ScriptedProvider([textTurn("here now")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("still waiting"),
        ]);
        expect(persistence.records.at(-1)).toEqual({
            type: "block",
            block: { type: "text", text: "here now" },
        });
        await agent.close();
    });

    it("start consumes a message left pending by a crash", async () => {
        const persistence = new InMemoryPersistence();
        persistence.values.set("send.00000000000001.000000", queued(user("lost send")));
        const provider = new ScriptedProvider([textTurn("caught up")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(persistence.records).toEqual([
            recordedUser("lost send"),
            { type: "block", block: { type: "text", text: "caught up" } },
        ]);
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("carries a queued system or agent message into the context under its own role", async () => {
        const provider = new ScriptedProvider([textTurn("noted"), textTurn("acknowledged")]);
        const persistence = new InMemoryPersistence();
        const roles: string[] = [];
        const notice = system("the background process exited");
        const handoff = agentMessage("handoff");
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                messageAccepted: (_hookCtx, accepted) => {
                    roles.push(`${accepted.kind}:${accepted.message.role}`);
                },
            },
        });

        await agent.send(ctx, notice);
        await agent.waitForIdle();
        await agent.send(ctx, handoff);
        await agent.waitForIdle();
        await agent.close();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests[0]?.context.messages).toEqual([notice]);
        expect(requests[1]?.context.messages.at(-1)).toEqual(handoff);
        expect(persistence.records.filter((record) => record.type === "user")).toEqual([
            expect.objectContaining({ type: "user", message: notice }),
            expect.objectContaining({ type: "user", message: handoff }),
        ]);
        expect(roles).toEqual(["send:system", "send:agent"]);
    });

    it("resumes a system message the queue was still holding when the process died", async () => {
        const persistence = new InMemoryPersistence();
        const notice = system("the background process exited");
        persistence.values.set("send.00000000000001.000000", queued(notice));
        const provider = new ScriptedProvider([textTurn("caught up")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([notice]);
        expect(persistence.records).toEqual([
            expect.objectContaining({ type: "user", message: notice }),
            { type: "block", block: { type: "text", text: "caught up" } },
        ]);
    });

    it("closes a provider stream that is still open once the response is done", async () => {
        // Providers keep a connection behind the stream, so a response that ends before the
        // stream does must still release it rather than leave it dangling.
        class OpenStreamProvider extends ScriptedProvider {
            streamClosed = false;
            override async session(id: string, options: never): Promise<BaseSession> {
                const session = (await super.session(id, options)) as ScriptedSession;
                const run = session.run.bind(session);
                const self = this;
                session.run = (runCtx, request): SessionStream => {
                    const scripted = run(runCtx, request);
                    return (async function* () {
                        try {
                            yield* scripted;
                            // The provider would keep streaming; nobody is reading any more.
                            yield { type: "text_delta", delta: "after" } as SessionEvent;
                        } finally {
                            self.streamClosed = true;
                        }
                    })();
                };
                return session;
            }
        }
        const provider = new OpenStreamProvider([textTurn("hello")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        await until(() => provider.streamClosed);
        await agent.close();
    });

    it("abort cancels a hanging stream, keeps finished blocks, and closes the stream", async () => {
        const persistence = new InMemoryPersistence();
        let releaseHang = (): void => undefined;
        const hang = new Promise<void>((resolve) => {
            releaseHang = resolve;
        });
        class HangingProvider extends ScriptedProvider {
            streamClosed = false;
            override async session(id: string, options: never): Promise<BaseSession> {
                const session = (await super.session(id, options)) as ScriptedSession;
                const run = session.run.bind(session);
                const self = this;
                session.run = (runCtx, request): SessionStream => {
                    const scripted = run(runCtx, request);
                    return (async function* () {
                        try {
                            yield* scripted;
                            // The provider stalls here until the test releases it.
                            await hang;
                            yield { type: "text_delta", delta: "late" } as SessionEvent;
                        } finally {
                            self.streamClosed = true;
                        }
                    })();
                };
                return session;
            }
        }
        const provider = new HangingProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "finished" },
                { type: "text_end" },
                { type: "text_start" },
                { type: "text_delta", delta: "partial" },
            ],
        ]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("go"));
        await until(() =>
            events.some((event) => event.type === "text_delta" && event.delta === "partial"),
        );
        await agent.abort(ctx);
        await agent.waitForIdle();

        expect(events.at(-1)).toEqual({ type: "done", state: "cancelled" });
        // Once the stalled await settles, the requested stream closure runs its finally, and
        // the event the provider produced after the abort never reaches the hooks.
        releaseHang();
        await until(() => provider.streamClosed);
        expect(events.some((event) => event.type === "text_delta" && event.delta === "late")).toBe(
            false,
        );
        // Only the finished block survives; the unfinished one is dropped everywhere.
        expect(persistence.records).toEqual([
            recordedUser("go"),
            { type: "block", block: { type: "text", text: "finished" } },
        ]);
        await agent.close();

        const reloadedProvider = new ScriptedProvider([textTurn("next reply")]);
        const reloaded = await AgentBase.create(ctx, {
            id: "test-agent-reloaded",
            providers: providersOf(reloadedProvider),
            provider: "scripted",
            persistence,
        });
        await reloaded.send(ctx, user("next"));
        await reloaded.waitForIdle();
        expect(reloadedProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("go"),
            { role: "assistant", content: [{ type: "text", text: "finished" }] },
            user("next"),
        ]);
        await reloaded.close();
    });

    it("abort settles a hanging tool as an aborted error result without a follow-up turn", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "hang_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("never"),
        ]);
        let started = false;
        let lifetime: AbortSignal | undefined;
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "hang_tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: (toolCtx) => {
                            started = true;
                            lifetime = toolCtx.lifetime;
                            return new Promise<never>(() => undefined);
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await until(() => started);
        expect(lifetime?.aborted).toBe(false);
        await agent.abort(ctx);
        await agent.waitForIdle();
        // The running tool observed the cancellation through its context lifetime.
        expect(lifetime?.aborted).toBe(true);

        expect(persistence.records.at(-1)).toEqual({
            type: "tool",
            message: {
                role: "tool",
                callId: "call-1",
                content: [{ type: "text", text: "The tool call was aborted." }],
                isError: true,
            },
        });
        // The pending entry was consumed by the aborted result, not left for a restart.
        expect(persistence.pending.size).toBe(0);
        expect(events.at(-1)).toEqual({ type: "done", state: "cancelled" });
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("abort is a no-op when idle and the agent keeps working afterwards", async () => {
        const provider = new ScriptedProvider([textTurn("still fine")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.abort(ctx);
        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();
        await agent.abort(ctx);

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("start on an idle history loads without running inference", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("hi"),
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([textTurn("never")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(persistence.loads).toBe(1);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });
});

describe("AgentBase per-message settings", () => {
    it("applies settings carried by a message and keeps them for later messages", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "anthropic/default",
        });

        await agent.send(ctx, user("switch"), {
            model: "anthropic/better",
            effort: "high",
            serviceTier: "priority",
        });
        await agent.waitForIdle();
        await agent.send(ctx, user("plain"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.requests[0]).toMatchObject({
            model: "anthropic/better",
            effort: "high",
            serviceTier: "priority",
        });
        // The next message carried nothing, so the previous settings stay effective.
        expect(session?.requests[1]).toMatchObject({
            model: "anthropic/better",
            effort: "high",
            serviceTier: "priority",
        });
        // The agent context reflects the currently effective settings.
        const secondContext = session?.requestContexts[1];
        expect(secondContext).toBeDefined();
        if (secondContext !== undefined) {
            expect(agentModel(secondContext)).toBe("anthropic/better");
            expect(agentEffort(secondContext)).toBe("high");
            expect(agentServiceTier(secondContext)).toBe("priority");
        }
        await agent.close();
    });

    it("resets on an incompatible model change: erases history, destroys the session, and lets the hook seed the fresh context", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("claude says"), textTurn("gpt says")]);
        const providers = providersOf(provider);
        const changes: unknown[] = [];
        let retainedHistoryKV: ReturnType<typeof agentHistoryKV>;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers,
            provider: "scripted",
            persistence,
            model: "anthropic/claude",
            hooks: {
                beforeTurn: async (hookCtx) => {
                    const historyKV = agentHistoryKV(hookCtx);
                    if (historyKV === undefined) throw new Error("History KV was not installed.");
                    retainedHistoryKV ??= historyKV;
                    await historyKV.write(hookCtx, "marker", true);
                    return undefined;
                },
                modelChanged: (_hookCtx, change) => {
                    changes.push(change);
                    return system("Summary of the previous conversation.");
                },
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        expect(changes).toEqual([
            {
                previousModel: "anthropic/claude",
                model: "openai/gpt",
                previousProvider: "scripted",
                provider: "scripted",
                providers,
                wasReset: true,
            },
        ]);
        // The old session is gone and a fresh one serves the new model.
        expect(provider.sessions[0]?.destroyed).toBe(true);
        expect(provider.sessions).toHaveLength(2);
        // The fresh context starts with the injected message; everything earlier is erased,
        // durably too.
        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            system("Summary of the previous conversation."),
            user("switch"),
        ]);
        expect(persistence.records).toEqual([
            { type: "system", message: system("Summary of the previous conversation.") },
            recordedUser("switch"),
            { type: "block", block: { type: "text", text: "gpt says" } },
        ]);
        expect([...persistence.values.keys()].filter((key) => key.includes(".history."))).toEqual(
            [],
        );
        if (retainedHistoryKV === undefined) throw new Error("History KV was not observed.");
        await expect(retainedHistoryKV.read(ctx, "marker")).rejects.toThrow(
            "the work its context belongs to has ended",
        );
        await agent.close();
    });

    it("starts the fresh context completely empty when no hook injects a message", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "anthropic/claude",
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([user("switch")]);
        await agent.close();
    });

    it("appends a queued hook notice after an incompatible model reset", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const notice = system("This notice belongs to the new model context.");
        let turns = 0;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "anthropic/claude",
            hooks: {
                beforeTurn: () => {
                    turns += 1;
                    return turns === 2 ? [{ type: "inject", message: notice }] : undefined;
                },
                modelChanged: () => system("Summary for the new model."),
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            system("Summary for the new model."),
            user("switch"),
            notice,
        ]);
        await agent.close();
    });

    it("keeps history but replaces the session on a compatible model change", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const changes: unknown[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            model: "anthropic/claude-a",
            persistence: new InMemoryPersistence(),
            hooks: {
                modelChanged: (_hookCtx, change) => {
                    changes.push(change);
                    // Ignored on a compatible change: no reset happened.
                    return system("should not appear");
                },
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "anthropic/claude-b" });
        await agent.waitForIdle();

        expect(changes).toEqual([
            expect.objectContaining({
                previousModel: "anthropic/claude-a",
                model: "anthropic/claude-b",
                wasReset: false,
            }),
        ]);
        expect(provider.sessions).toHaveLength(2);
        expect(provider.sessions[0]?.destroyed).toBe(true);
        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            user("hello"),
            { role: "assistant", content: [{ type: "text", text: "first" }] },
            user("switch"),
        ]);
        await agent.close();
    });

    it("resolves a fresh Bedrock-shaped provider for a compatible model switch", async () => {
        const firstProvider = new ScriptedProvider([textTurn("from haiku")]);
        const secondProvider = new ScriptedProvider([textTurn("from sonnet")]);
        const selections: unknown[] = [];
        const providers = new AgentProviders();
        providers.add(
            "bedrock",
            async (selection) => {
                selections.push(selection);
                if (selection.model === "anthropic/claude-haiku") return firstProvider;
                if (selection.model === "anthropic/claude-sonnet") return secondProvider;
                throw new Error(`Unexpected Bedrock model: ${selection.model ?? "none"}`);
            },
            "bedrock",
        );
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers,
            provider: "bedrock",
            model: "anthropic/claude-haiku",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), {
            model: "anthropic/claude-sonnet",
        });
        await agent.waitForIdle();

        expect(selections).toEqual([
            { id: "bedrock", model: "anthropic/claude-haiku" },
            { id: "bedrock", model: "anthropic/claude-sonnet" },
        ]);
        expect(firstProvider.sessions[0]?.destroyed).toBe(true);
        expect(firstProvider.sessions[0]?.requests[0]?.model).toBe("anthropic/claude-haiku");
        expect(secondProvider.sessions[0]?.requests[0]?.model).toBe("anthropic/claude-sonnet");
        expect(secondProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("hello"),
            { role: "assistant", content: [{ type: "text", text: "from haiku" }] },
            user("switch"),
        ]);
        await agent.close();
    });

    it("resets when switching between Claude SDK and Bedrock", async () => {
        const claudeProvider = new ScriptedProvider([textTurn("from claude")]);
        const bedrockProvider = new ScriptedProvider([textTurn("from bedrock")]);
        const providers = new AgentProviders();
        providers.add("claude", claudeProvider, "claude");
        providers.add("bedrock", bedrockProvider, "bedrock");
        const changes: unknown[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers,
            provider: "claude",
            model: "anthropic/claude-x",
            persistence: new InMemoryPersistence(),
            hooks: {
                modelChanged: (_hookCtx, change) => {
                    changes.push(change);
                    return system("Claude SDK and Bedrock use separate histories.");
                },
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { provider: "bedrock" });
        await agent.waitForIdle();

        expect(changes).toEqual([
            {
                previousModel: "anthropic/claude-x",
                model: "anthropic/claude-x",
                previousProvider: "claude",
                provider: "bedrock",
                providers,
                wasReset: true,
            },
        ]);
        expect(claudeProvider.sessions[0]?.destroyed).toBe(true);
        expect(bedrockProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            system("Claude SDK and Bedrock use separate histories."),
            user("switch"),
        ]);
        await agent.close();
    });

    it.each([
        ["claude", "anthropic/claude-x"],
        ["codex", "openai/gpt-x"],
        ["grok", "xai/grok-x"],
        ["bedrock", "anthropic/claude-x"],
    ] as const)(
        "keeps history when switching between named %s providers",
        async (providerType, model) => {
            const firstProvider = new ScriptedProvider([textTurn("first")]);
            const secondProvider = new ScriptedProvider([textTurn("second")]);
            const providers = new AgentProviders();
            providers.add("personal", firstProvider, providerType);
            providers.add("work", secondProvider, providerType);
            const agent = await AgentBase.create(ctx, {
                id: "test-agent",
                providers,
                provider: "personal",
                model,
                persistence: new InMemoryPersistence(),
            });

            await agent.send(ctx, user("hello"));
            await agent.waitForIdle();
            await agent.send(ctx, user("switch"), { provider: "work" });
            await agent.waitForIdle();

            expect(firstProvider.sessions[0]?.destroyed).toBe(true);
            expect(secondProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
                user("hello"),
                { role: "assistant", content: [{ type: "text", text: "first" }] },
                user("switch"),
            ]);
            await agent.close();
        },
    );

    it("keeps Bedrock GPT history when named providers resolve to the same region", async () => {
        const firstProvider = Object.assign(new ScriptedProvider([textTurn("first")]), {
            region: "us-east-1",
        });
        const secondProvider = Object.assign(new ScriptedProvider([textTurn("second")]), {
            region: "us-east-1",
        });
        const providers = new AgentProviders();
        providers.add("personal", firstProvider, "bedrock");
        providers.add("work", secondProvider, "bedrock");
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers,
            provider: "personal",
            model: "openai/gpt-x",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { provider: "work" });
        await agent.waitForIdle();

        expect(secondProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("hello"),
            { role: "assistant", content: [{ type: "text", text: "first" }] },
            user("switch"),
        ]);
        await agent.close();
    });

    it("resets Bedrock GPT history when the region changes", async () => {
        const firstProvider = Object.assign(new ScriptedProvider([textTurn("first")]), {
            region: "us-east-1",
        });
        const secondProvider = Object.assign(new ScriptedProvider([textTurn("second")]), {
            region: "eu-west-1",
        });
        const providers = new AgentProviders();
        providers.add("personal", firstProvider, "bedrock");
        providers.add("work", secondProvider, "bedrock");
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers,
            provider: "personal",
            model: "openai/gpt-x",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { provider: "work" });
        await agent.waitForIdle();

        expect(secondProvider.sessions[0]?.requests[0]?.context.messages).toEqual([user("switch")]);
        await agent.close();
    });

    it("keeps the effective provider across a restart", async () => {
        const persistence = new InMemoryPersistence();
        const claudeProvider = new ScriptedProvider([textTurn("from claude")]);
        const bedrockProvider = new ScriptedProvider([textTurn("from bedrock")]);
        const makeProviders = (
            claude: ScriptedProvider,
            bedrock: ScriptedProvider,
        ): AgentProviders => {
            const providers = new AgentProviders();
            providers.add("claude", claude, "claude");
            providers.add("bedrock", bedrock, "bedrock");
            return providers;
        };
        const firstAgent = await AgentBase.create(ctx, {
            id: "provider-restart",
            providers: makeProviders(claudeProvider, bedrockProvider),
            provider: "claude",
            model: "anthropic/claude-x",
            persistence,
        });
        await firstAgent.send(ctx, user("switch"), { provider: "bedrock" });
        await firstAgent.waitForIdle();
        await firstAgent.close();

        const laterClaude = new ScriptedProvider([textTurn("unused")]);
        const laterBedrock = new ScriptedProvider([textTurn("still bedrock")]);
        const secondAgent = await AgentBase.create(ctx, {
            id: "provider-restart",
            providers: makeProviders(laterClaude, laterBedrock),
            provider: "claude",
            model: "anthropic/claude-x",
            persistence,
        });
        await secondAgent.send(ctx, user("plain"));
        await secondAgent.waitForIdle();

        // The durable settings restored the provider switch; the constructor default did not
        // pull the conversation back to the claude provider.
        expect(laterClaude.sessions).toHaveLength(0);
        expect(laterBedrock.sessions[0]?.requests).toHaveLength(1);
        await secondAgent.close();
    });

    it("keeps the effective settings across a restart", async () => {
        const persistence = new InMemoryPersistence();
        const firstProvider = new ScriptedProvider([textTurn("first")]);
        const firstAgent = await AgentBase.create(ctx, {
            id: "settings-restart",
            providers: providersOf(firstProvider),
            provider: "scripted",
            persistence,
            model: "anthropic/default",
        });
        await firstAgent.send(ctx, user("switch"), { model: "anthropic/better" });
        await firstAgent.waitForIdle();
        await firstAgent.close();

        const secondProvider = new ScriptedProvider([textTurn("second")]);
        const secondAgent = await AgentBase.create(ctx, {
            id: "settings-restart",
            providers: providersOf(secondProvider),
            provider: "scripted",
            persistence,
            model: "anthropic/default",
        });
        await secondAgent.send(ctx, user("plain"));
        await secondAgent.waitForIdle();

        // The previously effective model survived the restart through the durable settings.
        expect(secondProvider.sessions[0]?.requests[0]).toMatchObject({
            model: "anthropic/better",
        });
        await secondAgent.close();
    });
});

describe("AgentBase message delivery strategies", () => {
    it("answers a message that arrives while a turn is still starting up", async () => {
        // start() opens a turn that has nothing to do yet. A message sent while that turn is
        // still running its pre-turn hooks must not be swallowed by it.
        const provider = new ScriptedProvider([textTurn("answered")]);
        let releaseHook = (): void => undefined;
        const inHook = new Promise<void>((resolve) => {
            releaseHook = resolve;
        });
        let hookEntered = (): void => undefined;
        const entered = new Promise<void>((resolve) => {
            hookEntered = resolve;
        });
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeTurn: async () => {
                    hookEntered();
                    await inHook;
                    return undefined;
                },
            },
        });

        agent.start();
        await entered;
        // The send lands while the first turn sits inside its pre-turn hook.
        await agent.send(ctx, user("hello"));
        releaseHook();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([user("hello")]);
        await agent.close();
    });

    it("answers a message that lands while the history is being loaded", async () => {
        // The load replaces the in-memory queues wholesale. A send that waits on the same
        // durable queue acceptance must join the queue the load left behind, not the one it discarded.
        const provider = new ScriptedProvider([textTurn("answered")]);
        let releaseLoad = (): void => undefined;
        const inLoad = new Promise<void>((resolve) => {
            releaseLoad = resolve;
        });
        let loadEntered = (): void => undefined;
        const entered = new Promise<void>((resolve) => {
            loadEntered = resolve;
        });
        const persistence = new InMemoryPersistence();
        const load = persistence.load.bind(persistence);
        persistence.load = async () => {
            loadEntered();
            await inLoad;
            return load();
        };
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await entered;
        // The send commits while the load is in flight and must remain visible afterwards.
        const sent = agent.send(ctx, user("hello"));
        releaseLoad();
        await sent;
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([user("hello")]);
        await agent.close();
    });

    it("steering while idle triggers a new turn on its own", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answered")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.steer(ctx, user("just steering"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("just steering"),
        ]);
        expect(persistence.records).toEqual([
            recordedUser("just steering"),
            { type: "block", block: { type: "text", text: "answered" } },
        ]);
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("steering one-at-a-time answers each queued steering message separately", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        let agent: AgentBase;
        let queued = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.steer(ctx, user("steer one"));
                        void agent.steer(ctx, user("steer two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("steer one"));
        expect(requests[1]?.context.messages).not.toContainEqual(user("steer two"));
        expect(requests[2]?.context.messages.at(-1)).toEqual(user("steer two"));
        expect(requests[2]?.context.messages.at(-2)).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "two" }],
        });
        await agent.close();
    });

    it("steering all injects every queued steering message before one response", async () => {
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        let agent: AgentBase;
        let queued = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            steeringMode: "all",
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.steer(ctx, user("steer one"));
                        void agent.steer(ctx, user("steer two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("steer one"),
            user("steer two"),
        ]);
        await agent.close();
    });

    it("follow-up one-at-a-time waits for each response before draining the next", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        let agent: AgentBase;
        let queued = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.send(ctx, user("follow one"));
                        void agent.send(ctx, user("follow two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("follow one"));
        expect(requests[1]?.context.messages).not.toContainEqual(user("follow two"));
        expect(requests[2]?.context.messages.at(-1)).toEqual(user("follow two"));
        await agent.close();
    });

    it("follow-up all injects every queued follow-up before one response", async () => {
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        let agent: AgentBase;
        let queued = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sendMode: "all",
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.send(ctx, user("follow one"));
                        void agent.send(ctx, user("follow two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("follow one"),
            user("follow two"),
        ]);
        await agent.close();
    });

    it("steering takes precedence over an earlier follow-up", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        let agent: AgentBase;
        let queued = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        // The follow-up is queued first, but steering still injects first.
                        void agent.send(ctx, user("the follow-up"));
                        void agent.steer(ctx, user("the steering"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("the steering"));
        expect(requests[2]?.context.messages.at(-1)).toEqual(user("the follow-up"));
        expect(
            persistence.records
                .filter((record) => record.type === "user")
                .map((record) => record.message),
        ).toEqual([user("go"), user("the steering"), user("the follow-up")]);
        await agent.close();
    });

    it("steering injects after the tool batch finishes, before the next inference", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "lookup" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("answered"),
        ]);
        let agent: AgentBase;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "lookup",
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: () => Promise.resolve({ value: "found" }),
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                ],
            },
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "toolcall_start") {
                        void agent.steer(ctx, user("mid-tools steering"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The steering message rides into the same request as the tool result: injected after
        // the batch finished but before the follow-up inference for its results.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            {
                role: "tool",
                callId: "call-1",
                content: [{ type: "text", text: "found" }],
            },
            user("mid-tools steering"),
        ]);
        await agent.close();
    });
});

describe("AgentBase compaction", () => {
    const compactionMessage: SessionMessage = {
        role: "compaction",
        content: "summary of everything so far",
        encryptedContent: null,
    };
    const completed = (messages: SessionMessage[]): SessionCompaction => ({
        status: "completed",
        preservedMessages: [],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        context: { instructions: "", messages },
    });

    it("finishes a running compaction before reaching its drain edge", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("must not start")]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        let compactionStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            compactionStarted = resolve;
        });
        let finishCompaction!: () => void;
        const finished = new Promise<void>((resolve) => {
            finishCompaction = resolve;
        });
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeCompaction: async () => {
                    compactionStarted();
                    await finished;
                },
            },
        });
        await agent.send(ctx, user("go"));
        await agent.waitForIdle();
        await agent.compact(ctx);
        await started;

        const draining = agent.drain();
        expect(agent.drainStage).toBe("compaction");
        finishCompaction();
        await draining;

        expect(agent.drainStage).toBeUndefined();
        expect(provider.sessions[0]?.compactions).toHaveLength(1);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(persistence.records).toContainEqual({
            type: "compaction",
            messages: [compactionMessage],
        });
        await agent.close();
    });

    it("runs a compaction requested after inference before the next tool continuation", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "lookup" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 100, output: 20 } },
            ],
            textTurn("continued from the compacted context"),
        ]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        let agent!: AgentBase;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool("lookup")] },
            hooks: {
                afterInference: async (hookCtx, inference) => {
                    if (inference.state === "tool_call") await agent.compact(hookCtx);
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.compactions[0]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "call-1",
            content: [{ type: "text", text: "ok" }],
        });
        expect(session?.requests[1]?.context.messages).toEqual([compactionMessage]);
        await agent.close();
    });

    it("waits for the active tool batch, then compacts before its continuation", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "slow_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("turn finished"),
            textTurn("next reply"),
        ]);
        let started = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "slow_tool",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            started = true;
                            await new Promise((resolve) => setTimeout(resolve, 20));
                            return {};
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await until(() => started);
        const session = provider.sessions[0];
        if (session !== undefined) {
            session.compactionResults = [completed([compactionMessage, user("go")])];
        }
        const compaction = agent.compact(ctx);
        await compaction;
        await agent.waitForIdle();

        // The compaction saw the settled tool result, then the continuation ran on its
        // replacement rather than making one more request against the oversized context.
        expect(session?.compactions).toHaveLength(1);
        expect(session?.compactions[0]?.context.messages).toHaveLength(3);
        expect(session?.compactions[0]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "call-1",
            content: [],
        });
        expect(session?.requests[1]?.context.messages).toEqual([compactionMessage, user("go")]);
        // The superseded records are physically gone; later output follows the replacement.
        expect(persistence.records).toEqual([
            {
                type: "compaction",
                messages: [compactionMessage, user("go")],
            },
            { type: "block", block: { type: "text", text: "turn finished" } },
        ]);

        await agent.send(ctx, user("after compaction"));
        await agent.waitForIdle();
        expect(session?.requests.at(-1)?.context.messages).toEqual([
            compactionMessage,
            user("go"),
            { role: "assistant", content: [{ type: "text", text: "turn finished" }] },
            user("after compaction"),
        ]);
        await agent.close();
    });

    it("clears and expires hook history KV only when the compaction commits", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const observed: unknown[] = [];
        let retained: ReturnType<typeof agentHistoryKV>;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeTurn: async (hookCtx) => {
                    const historyKV = agentHistoryKV(hookCtx);
                    if (historyKV === undefined) {
                        throw new Error("The hook has no history-scoped store.");
                    }
                    retained ??= historyKV;
                    const marker = await historyKV.read(hookCtx, "marker");
                    observed.push(marker);
                    if (marker === undefined) {
                        await historyKV.write(hookCtx, "marker", "present");
                    }
                    return undefined;
                },
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();
        const session = provider.sessions[0];
        if (session !== undefined) {
            session.compactionResults = [completed([compactionMessage])];
        }
        if (retained === undefined) throw new Error("The hook did not expose history KV.");

        await agent.compact(ctx);
        await agent.waitForIdle();
        expect([...persistence.values.keys()].filter((key) => key.includes(".history."))).toEqual(
            [],
        );
        await expect(retained.write(ctx, "late", true)).rejects.toThrow(
            "the work its context belongs to has ended",
        );

        await agent.send(ctx, user("after compaction"));
        await agent.waitForIdle();

        // The turn carrying out compaction still observes the old context. The first turn after
        // the replacement receives a fresh store.
        expect(observed).toEqual([undefined, "present", undefined]);
        await agent.close();
    });

    it("compacts an idle agent without running inference", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("hi"),
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });
        // Prime the session with the scripted compaction before the first pass creates it.
        const primed = new Promise<void>((resolve) => {
            const original = provider.session.bind(provider);
            provider.session = async (id, options) => {
                const session = await original(id, options);
                (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
                resolve();
                return session;
            };
        });

        await agent.compact(ctx);
        await primed;
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(0);
        expect(provider.sessions[0]?.compactions[0]?.context.messages).toEqual([
            user("hi"),
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ]);
        expect(persistence.records.at(-1)).toEqual({
            type: "compaction",
            messages: [compactionMessage],
        });
        await agent.close();
    });

    it("runs compaction hooks around the transactional history replacement", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("hi"),
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        persistence.values.set("kv.test-agent.history.marker", "old");
        const provider = new ScriptedProvider([]);
        const order: string[] = [];
        const compactions: unknown[] = [];
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeCompaction: async (hookCtx, compaction) => {
                    order.push("before");
                    compactions.push(compaction);
                    expect(await agentHistoryKV(hookCtx)?.read(hookCtx, "marker")).toBe("old");
                },
                historyErasedTransact: async (hookCtx, compaction) => {
                    order.push("erased");
                    compactions.push(compaction);
                    const historyKV = agentHistoryKV(hookCtx);
                    expect(await historyKV?.read(hookCtx, "marker")).toBeUndefined();
                    await historyKV?.write(hookCtx, "marker", "new");
                },
                afterCompaction: async (hookCtx, compaction) => {
                    order.push("after");
                    compactions.push(compaction);
                    expect(await agentHistoryKV(hookCtx)?.read(hookCtx, "marker")).toBe("new");
                },
            },
        });

        await agent.compact(ctx);
        await agent.waitForIdle();

        expect(order).toEqual(["before", "erased", "after"]);
        expect(
            compactions.map((value) => (value as { compactionId: string }).compactionId),
        ).toEqual([
            expect.any(String),
            (compactions[0] as { compactionId: string }).compactionId,
            (compactions[0] as { compactionId: string }).compactionId,
        ]);
        expect((compactions[2] as { result: SessionCompaction }).result.status).toBe("completed");
        expect(persistence.values.get("kv.test-agent.history.marker")).toBe("new");
        await agent.close();
    });

    it("rolls history erasure back when its transactional hook fails", async () => {
        const records = [
            userRecord("hi"),
            { type: "block" as const, block: { type: "text" as const, text: "hello" } },
        ];
        const persistence = new InMemoryPersistence([...records]);
        persistence.values.set("kv.test-agent.history.marker", "keep");
        const provider = new ScriptedProvider([]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        let observedAfter = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                historyErasedTransact: () => {
                    throw new Error("history observer failed");
                },
                afterCompaction: () => {
                    observedAfter = true;
                },
            },
        });

        await agent.compact(ctx);
        await agent.waitForIdle();

        expect(persistence.records).toEqual(records);
        expect(persistence.values.get("kv.test-agent.history.marker")).toBe("keep");
        expect(observedAfter).toBe(false);
        await agent.close();
    });

    it("shares one compaction between parallel compact calls", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("hi"),
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await Promise.all([agent.compact(ctx), agent.compact(ctx), agent.compact(ctx)]);
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions).toHaveLength(1);
        expect(persistence.records.filter((record) => record.type === "compaction")).toHaveLength(
            1,
        );
        await agent.close();
    });

    it("reports a failed requested compaction through the agent run", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("hi"),
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([textTurn("still works")]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [
                { status: "failed", kind: "inference_error", message: "model unavailable" },
            ];
            return session;
        };
        const hooks: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeCompaction: (_hookCtx, compaction) => {
                    hooks.push(`before:${compaction.compactionId}`);
                },
                afterCompaction: (_hookCtx, compaction) => {
                    hooks.push(`after:${compaction.compactionId}:${compaction.result.status}`);
                },
            },
        });

        await agent.compact(ctx);
        await agent.compact(ctx);
        await agent.waitForIdle();
        expect(hooks).toEqual([
            expect.stringMatching(/^before:/u),
            expect.stringMatching(/^after:.*:failed$/u),
        ]);

        // The history is untouched and the agent keeps working.
        expect(persistence.records.filter((record) => record.type === "compaction")).toHaveLength(
            0,
        );
        await agent.send(ctx, user("still there?"));
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("hi"),
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
            user("still there?"),
        ]);
        await agent.close();
    });

    it("rolls the deletion back when the compaction record fails to write", async () => {
        const records = [
            userRecord("hi"),
            { type: "block" as const, block: { type: "text" as const, text: "hello" } },
        ];
        const persistence = new InMemoryPersistence([...records]);
        persistence.values.set("kv.test-agent.history.marker", "keep");
        const originalAppend = persistence.append.bind(persistence);
        persistence.append = async (appendContext, record) => {
            if (record.type === "compaction") throw new Error("disk full");
            await originalAppend(appendContext, record);
        };
        const provider = new ScriptedProvider([]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.compact(ctx);
        await agent.waitForIdle();

        // The clear and the replacement write commit together or not at all.
        expect(persistence.records).toEqual(records);
        expect(persistence.values.get("kv.test-agent.history.marker")).toBe("keep");
        await agent.close();
    });

    it("replays the compacted context after a reload", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("old question"),
            { type: "block", block: { type: "text", text: "old answer" } },
            { type: "compaction", messages: [compactionMessage, user("kept message")] },
            userRecord("newer question"),
            { type: "block", block: { type: "text", text: "newer answer" } },
        ]);
        const provider = new ScriptedProvider([textTurn("reply")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("latest"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            compactionMessage,
            user("kept message"),
            user("newer question"),
            { role: "assistant", content: [{ type: "text", text: "newer answer" }] },
            user("latest"),
        ]);
        await agent.close();
    });
});

describe("AgentBase instructions and tools hooks", () => {
    it("uses the instructions and tools the hooks return for the session", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "hooked" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        let executions = 0;
        const hookedTool = defineAgentTool({
            name: "hooked",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: () => {
                executions += 1;
                return Promise.resolve({});
            },
            toLLM: () => [{ type: "text", text: "ok" }],
        });
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { instructions: "state instructions" },
            hooks: {
                instructions: (hookCtx) => {
                    // The hook context carries the agent's configuration namespaces.
                    expect(agentProvider(hookCtx)).toBe("scripted");
                    return "hooked instructions";
                },
                tools: () => [hookedTool],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The hooks extend the state for the session, the request, and the tool execution
        // alike: the state instructions come first, the state tools precede the hooked ones.
        expect(provider.sessions[0]?.options.instructions).toBe(
            "state instructions\n\nhooked instructions",
        );
        expect(provider.sessions[0]?.options.tools).toEqual([hookedTool]);
        expect(provider.sessions[0]?.requests[0]?.context.instructions).toBe(
            "state instructions\n\nhooked instructions",
        );
        expect(executions).toBe(1);
        await agent.close();
    });

    it("fails the turn loudly when a configuration hook throws", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { instructions: "state instructions" },
            hooks: {
                onEvent: (_hookCtx, event) => events.push(event),
                instructions: () => {
                    throw new Error("hook broke");
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // Instructions are a correctness hook: no inference ran with a wrong prompt, and the
        // failure surfaced like any other failed turn.
        expect(provider.sessions).toHaveLength(0);
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "hook broke",
        });
        expect(persistence.records.at(-1)).toMatchObject({ type: "system" });
        await agent.close();
    });

    it("fails the turn when two tools share a name", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool("bash"), tool("bash")] },
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions).toHaveLength(0);
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "error",
            kind: "internal_error",
            message: 'Two tools are registered as "bash".',
        });
        await agent.close();
    });

    it("recreates the provider session when the tools hook output changes", async () => {
        const toolA = tool("tool_a");
        const toolB = tool("tool_b");
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        // The first inference flips the module state, exactly like a tool execution would.
        let current = [toolA];
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                tools: () => current,
                afterInference: () => {
                    current = [toolB];
                },
            },
        });

        await agent.send(ctx, user("one"));
        await agent.waitForIdle();
        await agent.send(ctx, user("two"));
        await agent.waitForIdle();

        // The next inference saw the changed descriptors and got a fresh session carrying
        // tool B; the stale session no longer serves the model.
        expect(provider.sessions).toHaveLength(2);
        expect(provider.sessions[0]?.options.tools).toEqual([toolA]);
        expect(provider.sessions[0]?.destroyed).toBe(true);
        expect(provider.sessions[1]?.options.tools).toEqual([toolB]);
        expect(provider.sessions[1]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("supports asynchronous configuration hooks", async () => {
        const asyncTool = tool("async_tool");
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                instructions: () => Promise.resolve("async instructions"),
                tools: () => Promise.resolve([asyncTool]),
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.options.instructions).toBe("async instructions");
        expect(provider.sessions[0]?.options.tools).toEqual([asyncTool]);
        await agent.close();
    });

    it("provides the configuration namespaces to tool executions too", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "check_ctx" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        let seenModel: string | undefined;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "tool-visible-model",
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "check_ctx",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: (toolCtx) => {
                            seenModel = agentModel(toolCtx);
                            return Promise.resolve({});
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(seenModel).toBe("tool-visible-model");
        await agent.close();
    });
});

describe("AgentBase inference errors", () => {
    it("continues draining queued messages after a provider-reported error", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "partial answer" },
                { type: "text_end" },
                { type: "done", state: "error", kind: "unknown", message: "model overloaded" },
            ],
            textTurn("second answer"),
        ]);
        const persistence = new InMemoryPersistence();
        const events: SessionEvent[] = [];
        let agent: AgentBase;
        let queued = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    events.push(event);
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.send(ctx, user("still waiting"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The failed response never answered the queued message, so it drained into a fresh
        // inference instead of stranding until the next trigger.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("still waiting"));
        expect(events.filter((event) => event.type === "done").map((event) => event.state)).toEqual(
            ["error", "normal"],
        );
        // The later successful response recovered the error, so the failed response leaves
        // no system message behind.
        expect(persistence.records.some((record) => record.type === "system")).toBe(false);
        await agent.close();
    });

    it("surfaces a failed turn as a system message the next inference sees", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [{ type: "done", state: "error", kind: "unknown", message: "model overloaded" }],
            textTurn("second answer"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const failure = {
            role: "system" as const,
            content: [{ type: "text" as const, text: "The last turn failed: model overloaded" }],
        };
        expect(persistence.records.at(-1)).toEqual({ type: "system", message: failure });

        // The next turn sees the surfaced failure in its context.
        await agent.send(ctx, user("again"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("go"),
            failure,
            user("again"),
        ]);
        await agent.close();
    });

    it("goes idle after an error when nothing is queued", async () => {
        const provider = new ScriptedProvider([
            [{ type: "done", state: "error", kind: "unknown", message: "model overloaded" }],
            textTurn("never"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });
});

describe("AgentBase lifecycle hooks", () => {
    it("finishes a running settlement transaction before reaching its drain edge", async () => {
        let settlementStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            settlementStarted = resolve;
        });
        let finishSettlement!: () => void;
        const finished = new Promise<void>((resolve) => {
            finishSettlement = resolve;
        });
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(new ScriptedProvider([textTurn("answer")])),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                afterAgentSettledTransact: async () => {
                    settlementStarted();
                    await finished;
                },
            },
        });
        await agent.send(ctx, user("go"));
        await started;

        const draining = agent.drain();
        expect(agent.drainStage).toBe("settlement");
        finishSettlement();
        await draining;

        expect(agent.active).toBe(false);
        expect(agent.drainStage).toBeUndefined();
        await agent.close();
    });

    it("fires the lifecycle hooks in order around a turn", async () => {
        const order: string[] = [];
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeAgentLoopTransact: () => void order.push("beforeAgentLoopTransact"),
                beforeAgentLoop: () => void order.push("beforeAgentLoop"),
                beforeTurnTransact: () => void order.push("beforeTurnTransact"),
                beforeTurn: () => void order.push("beforeTurn"),
                beforeInferenceTransact: () => void order.push("beforeInferenceTransact"),
                beforeInference: () => void order.push("beforeInference"),
                afterInferenceTransact: () => void order.push("afterInferenceTransact"),
                afterInference: () => void order.push("afterInference"),
                afterTurnTransact: () => void order.push("afterTurnTransact"),
                afterTurn: () => {
                    order.push("afterTurn");
                    return undefined;
                },
                afterAgentLoopTransact: () => void order.push("afterAgentLoopTransact"),
                afterAgentLoop: () => {
                    order.push("afterAgentLoop");
                    return undefined;
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(order).toEqual([
            "beforeAgentLoopTransact",
            "beforeAgentLoop",
            "beforeTurnTransact",
            "beforeTurn",
            "beforeInferenceTransact",
            "beforeInference",
            "afterInferenceTransact",
            "afterInference",
            "afterTurnTransact",
            "afterTurn",
            "afterAgentLoopTransact",
            "afterAgentLoop",
        ]);
        await agent.close();
    });

    it("lets beforeTurn queue a system notice before the next inference", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const notice = system("Read this before answering.");
        let injected = false;
        let turns = 0;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeTurn: () => {
                    turns += 1;
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([user("go"), notice]);
        expect(turns).toBe(1);
        await agent.close();
    });

    it("runs lifecycle transact hooks inside the transaction committing their state", async () => {
        class TransactionTracingPersistence extends InMemoryPersistence {
            readonly writes: { readonly key: string; readonly transaction: number | undefined }[] =
                [];
            #nextTransaction = 0;
            #transaction: number | undefined;

            override async transaction<Result>(
                transactionCtx: Context,
                work: (workCtx: Context) => Promise<Result>,
            ): Promise<Result> {
                const transaction = ++this.#nextTransaction;
                return await super.transaction(transactionCtx, async (workCtx) => {
                    const previous = this.#transaction;
                    this.#transaction = transaction;
                    try {
                        return await work(workCtx);
                    } finally {
                        this.#transaction = previous;
                    }
                });
            }

            override writeValue(writeCtx: Context, key: string, value: unknown): Promise<void> {
                this.writes.push({ key, transaction: this.#transaction });
                return super.writeValue(writeCtx, key, value);
            }
        }

        const persistence = new TransactionTracingPersistence();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeAgentLoopTransact: async (hookCtx) => {
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    await kv.write(hookCtx, "before-loop", true);
                },
                afterInferenceTransact: async (hookCtx) => {
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    await kv.write(hookCtx, "after-inference", true);
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const beforeLoop = persistence.writes.find(
            ({ key }) => key === "kv.test-agent.before-loop",
        );
        const afterInference = persistence.writes.find(
            ({ key }) => key === "kv.test-agent.after-inference",
        );
        expect(beforeLoop?.transaction).toBeTypeOf("number");
        expect(afterInference?.transaction).toBeTypeOf("number");
        expect(persistence.writes).toContainEqual({
            key: AGENT_BASE_PENDING_KEY,
            transaction: beforeLoop?.transaction,
        });
        expect(persistence.writes).toContainEqual({
            key: "context",
            transaction: afterInference?.transaction,
        });
        await agent.close();
    });

    it("rolls afterInferenceTransact back with the context state it observes", async () => {
        const persistence = new InMemoryPersistence();
        const ordinary: AgentBaseInference[] = [];
        const turns: AgentBaseTurn[] = [];
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterInferenceTransact: async (hookCtx) => {
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    await kv.write(hookCtx, "rolled-back-inference", true);
                    throw new Error("transactional inference observer failed");
                },
                afterInference: (_hookCtx, inference) => void ordinary.push(inference),
                afterTurn: (_hookCtx, turn) => void turns.push(turn),
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.values.has("context")).toBe(false);
        expect(persistence.values.has("kv.test-agent.rolled-back-inference")).toBe(false);
        expect(ordinary).toEqual([]);
        expect(turns).toMatchObject([{ contextTokens: undefined, aborted: false }]);
        await agent.close();
    });

    it("delivers only completed durable blocks to onEventTransact", async () => {
        const raw: SessionEvent[] = [];
        const committed: AgentBasePersistedEvent[] = [];
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "hello" },
                { type: "text_end" },
                { type: "reasoning_start" },
                { type: "reasoning_delta", delta: "thinking" },
                { type: "reasoning_end", reasoning: "opaque" },
                { type: "toolcall_start", callId: "call-1", name: "missing" },
                { type: "toolcall_delta", callId: "call-1", delta: "{}" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "normal", tokens: { input: 4, output: 2 } },
            ],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => raw.push(event),
                onEventTransact: async (hookCtx, event) => {
                    committed.push(event);
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    await kv.write(hookCtx, `event.${committed.length}`, event.type);
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(raw.map((event) => event.type)).toEqual([
            "text_start",
            "text_delta",
            "text_end",
            "reasoning_start",
            "reasoning_delta",
            "reasoning_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
            "done",
        ]);
        expect(committed).toEqual([
            { type: "text_end", block: { type: "text", text: "hello" } },
            {
                type: "reasoning_end",
                reasoning: "opaque",
                block: { type: "reasoning", text: "thinking", reasoning: "opaque" },
            },
            {
                type: "toolcall_end",
                callId: "call-1",
                arguments: "{}",
                block: {
                    type: "tool_call",
                    callId: "call-1",
                    name: "missing",
                    arguments: "{}",
                },
            },
        ]);
        expect(persistence.values.get("kv.test-agent.event.1")).toBe("text_end");
        expect(persistence.values.get("kv.test-agent.event.2")).toBe("reasoning_end");
        expect(persistence.values.get("kv.test-agent.event.3")).toBe("toolcall_end");
        await agent.close();
    });

    it("commits tool-call notes with the batch that dispatched them and the results that answer them", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "look" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        const order: string[] = [];
        let callScope = "";
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeToolCallTransact: async (hookCtx, call) => {
                    order.push(`dispatched:${call.callId}`);
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    callScope = kv.prefix;
                    await kv.write(hookCtx, "dispatched", call.name);
                },
                afterToolCallTransact: async (hookCtx, result) => {
                    order.push(`answered:${result.callId}`);
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    await kv.write(hookCtx, "answered", result.content);
                },
            },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "look",
                        returnType: Type.Null(),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            order.push("tool");
                            return Promise.resolve(null);
                        },
                        toLLM: () => [{ type: "text", text: "looked" }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("look"));
        await agent.waitForIdle();

        expect(order).toEqual(["dispatched:call-1", "tool", "answered:call-1"]);
        expect(callScope).toMatch(/^kv\.test-agent\.call\.[a-z0-9]+\.$/);
        expect([...persistence.values.keys()].filter((key) => key.startsWith(callScope))).toEqual(
            [],
        );
        await agent.close();
    });

    it("rolls a dispatched batch back when beforeToolCallTransact fails", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "look" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
        ]);
        let executions = 0;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeToolCallTransact: async (hookCtx) => {
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    await kv.write(hookCtx, "rolled-back", true);
                    throw new Error("dispatch projection failed");
                },
            },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "look",
                        returnType: Type.Null(),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            executions += 1;
                            return Promise.resolve(null);
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("look"));
        await agent.waitForIdle();

        expect(executions).toBe(0);
        expect(persistence.values.has("kv.test-agent.call.call-1.rolled-back")).toBe(false);
        // Nothing was dispatched, so nothing is owed a result after a restart either.
        expect([...persistence.values.keys()].filter((key) => key.startsWith("tool."))).toEqual([]);
        // The turn failed, so what it left the model owed is settled as an error rather than
        // as the tool having run.
        expect(persistence.records.filter((record) => record.type === "tool")).toMatchObject([
            { message: { callId: "call-1", isError: true } },
        ]);
        await agent.close();
    });

    it("rolls an onEventTransact write back with the durable block when the hook fails", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("not committed")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEventTransact: async (hookCtx) => {
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("Missing transactional agent store.");
                    await kv.write(hookCtx, "rolled-back", true);
                    throw new Error("event projection failed");
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.records.some((record) => record.type === "block")).toBe(false);
        expect(persistence.values.has("kv.test-agent.rolled-back")).toBe(false);
        await agent.close();
    });

    it("tells afterTurn the turn was aborted", async () => {
        const turns: AgentBaseTurn[] = [];
        const events: SessionEvent[] = [];
        let releaseHang = (): void => undefined;
        const hang = new Promise<void>((resolve) => {
            releaseHang = resolve;
        });
        class HangingProvider extends ScriptedProvider {
            override async session(id: string, options: never): Promise<BaseSession> {
                const session = (await super.session(id, options)) as ScriptedSession;
                const run = session.run.bind(session);
                session.run = (runCtx, request): SessionStream => {
                    const scripted = run(runCtx, request);
                    return (async function* () {
                        yield* scripted;
                        // The provider stalls until the abort interrupts the turn.
                        await hang;
                    })();
                };
                return session;
            }
        }
        const provider = new HangingProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "partial" },
                { type: "text_end" },
            ],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => events.push(event),
                afterTurn: (_hookCtx, turn) => {
                    turns.push(turn);
                    return undefined;
                },
            },
        });

        await agent.send(ctx, user("go"));
        await until(() => events.some((event) => event.type === "text_end"));
        await agent.abort(ctx);
        releaseHang();
        await agent.waitForIdle();

        // The response never reached a done event, so it measured no tokens — and the turn
        // reports plainly that it was cancelled rather than finished.
        expect(turns).toMatchObject([{ contextTokens: undefined, aborted: true }]);
        await agent.close();
    });

    it("reports the real token counts of each response to afterInference and afterTurn", async () => {
        const inferences: (AgentBaseInference | undefined)[] = [];
        const turns: AgentBaseTurn[] = [];
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "noop_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 100, output: 20 } },
            ],
            [
                { type: "text_start" },
                { type: "text_delta", delta: "done" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 400, output: 30 } },
            ],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool("noop_tool")] },
            hooks: {
                afterInference: (_hookCtx, inference) => void inferences.push(inference),
                afterTurn: (_hookCtx, turn) => {
                    turns.push(turn);
                    return undefined;
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // Each response reports what it measured; the turn carries the last measurement.
        expect(inferences).toMatchObject([
            { state: "tool_call", tokens: { input: 100, output: 20 } },
            { state: "normal", tokens: { input: 400, output: 30 } },
        ]);
        expect(new Set(inferences.map((inference) => inference?.inferenceId)).size).toBe(2);
        expect(inferences[0]?.loopId).toBe(inferences[1]?.loopId);
        expect(inferences[0]?.turnId).toBe(inferences[1]?.turnId);
        expect(turns).toMatchObject([{ contextTokens: 430, aborted: false }]);
        await agent.close();
    });

    it("reports no tokens for a failed response and keeps the turn's last measurement", async () => {
        const inferences: AgentBaseInference[] = [];
        const turns: AgentBaseTurn[] = [];
        // The tool call keeps the turn going, so the failing second inference belongs to the
        // same turn as the measured first response.
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "noop_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 200, output: 10 } },
            ],
            [{ type: "done", state: "error", kind: "unknown", message: "provider exploded" }],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool("noop_tool")] },
            hooks: {
                afterInference: (_hookCtx, inference) => void inferences.push(inference),
                afterTurn: (_hookCtx, turn) => {
                    turns.push(turn);
                    return undefined;
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(inferences).toMatchObject([
            { state: "tool_call", tokens: { input: 200, output: 10 } },
            { state: "error", tokens: undefined, errorMessage: "provider exploded" },
        ]);
        expect(new Set(inferences.map(({ inferenceId }) => inferenceId)).size).toBe(2);
        expect(inferences[0]?.loopId).toBe(inferences[1]?.loopId);
        expect(inferences[0]?.turnId).toBe(inferences[1]?.turnId);
        expect(turns).toMatchObject([{ contextTokens: 210, aborted: false }]);
        await agent.close();
    });

    it("tells beforeTurn the measured size of the context, persisted across a restart", async () => {
        const persistence = new InMemoryPersistence();
        const starts: (number | undefined)[] = [];
        const hooks = {
            beforeTurn: (_hookCtx: Context, turn: AgentBaseTurnStart) => {
                starts.push(turn.contextTokens);
                return undefined;
            },
        };
        const first = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "hello" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 500, output: 40 } },
            ],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(first),
            provider: "scripted",
            persistence,
            hooks,
        });
        // The first turn has nothing measured yet; its response then measures the context.
        await agent.send(ctx, user("go"));
        await agent.waitForIdle();
        expect(starts).toEqual([undefined]);
        expect(persistence.values.get("context")).toEqual({ tokens: 540 });
        await agent.close();

        // A fresh agent reads the size back instead of starting out uninformed.
        const restarted = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(new ScriptedProvider([textTurn("again")])),
            provider: "scripted",
            persistence,
            hooks,
        });
        await restarted.send(ctx, user("more"));
        await restarted.waitForIdle();
        expect(starts).toEqual([undefined, 540]);
        await restarted.close();
    });

    it("runs another turn in the same loop when afterTurn queues a message", async () => {
        const order: string[] = [];
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeAgentLoop: () => void order.push("beforeAgentLoop"),
                beforeTurn: () => void order.push("beforeTurn"),
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "send", message: user("follow up") }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("follow up"));
        // Both turns ran inside one loop span.
        expect(order).toEqual(["beforeAgentLoop", "beforeTurn", "beforeTurn"]);
        await agent.close();
    });

    it("lets afterTurn inject a system notice directly into history", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const notice = system("The workspace changed.");
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.records).toContainEqual(
            expect.objectContaining({ type: "system", message: notice }),
        );
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(notice);
        await agent.close();
    });

    it("finishes an accepted notice when close races its queue commit", async () => {
        let agent!: AgentBase;
        let closing: Promise<void> | undefined;
        class CloseRacingPersistence extends InMemoryPersistence {
            override async writeValue(
                writeCtx: Context,
                key: string,
                value: unknown,
            ): Promise<void> {
                await super.writeValue(writeCtx, key, value);
                if (key.startsWith("inject.") && closing === undefined) {
                    closing = agent.close();
                }
            }
        }

        const persistence = new CloseRacingPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("notice answered")]);
        const notice = system("Finish this accepted work before closing.");
        let injected = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await until(() => closing !== undefined);
        if (closing === undefined) throw new Error("Close did not race the notice commit.");
        await closing;

        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(notice);
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        expect([...persistence.values.keys()].filter((key) => key.startsWith("inject."))).toEqual(
            [],
        );
    });

    it("keeps an accepted notice active when abort lands before consumption", async () => {
        let secondLoadStarted!: () => void;
        const secondLoading = new Promise<void>((resolve) => {
            secondLoadStarted = resolve;
        });
        let releaseSecondLoad!: () => void;
        const secondLoadReleased = new Promise<void>((resolve) => {
            releaseSecondLoad = resolve;
        });
        class AbortRacingPersistence extends InMemoryPersistence {
            override async load() {
                const records = await super.load();
                if (this.loads === 2) {
                    secondLoadStarted();
                    await secondLoadReleased;
                }
                return records;
            }
        }

        const persistence = new AbortRacingPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("notice answered")]);
        const notice = system("This accepted notice survives the cancelled turn.");
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await secondLoading;
        const aborted = agent.abort(ctx);
        releaseSecondLoad();
        await aborted;
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(notice);
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        expect([...persistence.values.keys()].filter((key) => key.startsWith("inject."))).toEqual(
            [],
        );
        await agent.close();
    });

    it("retries an appended notice when abort cancels the inference answering it", async () => {
        let secondRequestStarted!: () => void;
        const secondRequest = new Promise<void>((resolve) => {
            secondRequestStarted = resolve;
        });
        let releaseSecondRequest!: () => void;
        const secondRequestReleased = new Promise<void>((resolve) => {
            releaseSecondRequest = resolve;
        });
        class NoticeAbortProvider extends ScriptedProvider {
            override async session(id: string, options: never): Promise<BaseSession> {
                const session = (await super.session(id, options)) as ScriptedSession;
                const run = session.run.bind(session);
                session.run = (runCtx, request): SessionStream => {
                    const scripted = run(runCtx, request);
                    if (session.requests.length !== 2) return scripted;
                    return (async function* () {
                        secondRequestStarted();
                        await secondRequestReleased;
                    })();
                };
                return session;
            }
        }

        const notice = system("Answer this notice after the cancelled attempt.");
        const provider = new NoticeAbortProvider([
            textTurn("first"),
            textTurn("cancelled before delivery"),
            textTurn("notice answered"),
        ]);
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
        });

        const sending = agent.send(ctx, user("go"));
        await secondRequest;
        const aborted = agent.abort(ctx);
        releaseSecondRequest();
        await aborted;
        await sending;
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(3);
        expect(provider.sessions[0]?.requests[2]?.context.messages.at(-1)).toEqual(notice);
        await agent.close();
    });

    it("applies every returned action together", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sendMode: "all",
            hooks: {
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [
                        { type: "send", message: user("first extra") },
                        { type: "send", message: user("second extra") },
                    ];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // Both actions were queued before the loop continued, so they drain into one inference.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("first extra"),
            user("second extra"),
        ]);
        await agent.close();
    });

    it("reopens the loop when afterAgentLoop steers a message", async () => {
        const order: string[] = [];
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeAgentLoop: () => void order.push("beforeAgentLoop"),
                afterAgentLoop: () => {
                    order.push("afterAgentLoop");
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "steer", message: user("one more thing") }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("one more thing"));
        // The action reopened the loop, so the loop hooks bracketed two spans.
        expect(order).toEqual([
            "beforeAgentLoop",
            "afterAgentLoop",
            "beforeAgentLoop",
            "afterAgentLoop",
        ]);
        await agent.close();
    });

    it("reopens the loop when afterAgentLoop injects a system notice", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const notice = system("Continue with the refreshed state.");
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                afterAgentLoop: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(notice);
        await agent.close();
    });

    it("triggers a compaction when afterTurn asks for one", async () => {
        const compactionMessage: SessionMessage = {
            role: "compaction",
            content: "summary of everything so far",
            encryptedContent: null,
        };
        const provider = new ScriptedProvider([textTurn("answer")]);
        let requested = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                afterTurn: () => {
                    if (requested) return undefined;
                    requested = true;
                    const session = provider.sessions[0];
                    if (session !== undefined) {
                        session.compactionResults = [
                            {
                                status: "completed",
                                preservedMessages: [],
                                usage: {
                                    input: 10,
                                    output: 5,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    totalTokens: 15,
                                },
                                context: { instructions: "", messages: [compactionMessage] },
                            },
                        ];
                    }
                    return [{ type: "compact" }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions).toHaveLength(1);
        // A fresh turn after the compaction runs on the replaced context.
        expect(provider.sessions[0]?.compactions[0]?.context.messages).toEqual([
            user("go"),
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ]);
        await agent.close();
    });

    it("injects a notice after a compaction requested by the same hook", async () => {
        const compactionMessage: SessionMessage = {
            role: "compaction",
            content: "summary",
            encryptedContent: null,
        };
        const notice = system("The compacted context has changed.");
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let requested = false;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                afterTurn: () => {
                    if (requested) return undefined;
                    requested = true;
                    const session = provider.sessions[0];
                    if (session !== undefined) {
                        session.compactionResults = [
                            {
                                status: "completed",
                                preservedMessages: [],
                                usage: {
                                    input: 10,
                                    output: 5,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    totalTokens: 15,
                                },
                                context: { instructions: "", messages: [compactionMessage] },
                            },
                        ];
                    }
                    return [{ type: "compact" }, { type: "inject", message: notice }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            compactionMessage,
            notice,
        ]);
        await agent.close();
    });
});

describe("AgentBase load retry", () => {
    it("retries a failed history load on the next turn", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("earlier"),
            { type: "block", block: { type: "text", text: "earlier reply" } },
        ]);
        const originalLoad = persistence.load.bind(persistence);
        // A turn reads the durable conversation once, before anything else it does. A read it
        // cannot complete ends the turn there, without writing anything.
        let failures = 1;
        persistence.load = () => {
            if (failures > 0) {
                failures -= 1;
                return Promise.reject(new Error("storage offline"));
            }
            return originalLoad();
        };
        const events: SessionEvent[] = [];
        const provider = new ScriptedProvider([textTurn("recovered reply")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("first try"));
        await agent.waitForIdle();
        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "storage offline",
            },
        ]);

        // The next trigger retries the load; the earlier message is still queued and drains.
        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("earlier"),
            { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
            user("first try"),
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        await agent.close();
    });
});

describe("AgentBase scoped persistence", () => {
    it("scopes a tool execution's store to its call ID", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "remember" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("remembered"),
        ]);
        const persistence = new InMemoryPersistence();
        const seen: unknown[] = [];
        let callId = "";
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "remember",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async (toolCtx, _args, call) => {
                            callId = call.id;
                            const kv = agentKV(toolCtx);
                            if (kv === undefined) throw new Error("No store on the context.");
                            await kv.write(toolCtx, "note", "stashed");
                            seen.push(await kv.read(toolCtx, "note"));
                            seen.push(await kv.list(toolCtx));
                            return {};
                        },
                        toLLM: () => [{ type: "text", text: "ok" }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(callId).toMatch(/^[a-z0-9]+$/);
        expect(persistence.values.get(`kv.test-agent.call.${callId}.note`)).toBeUndefined();
        expect(seen).toEqual(["stashed", [{ key: "note", value: "stashed" }]]);
        await agent.close();
    });

    it("gives hooks the session-scoped store", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                instructions: async (hookCtx) => {
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("No store on the context.");
                    await kv.write(hookCtx, "prepared", true);
                    return "hooked";
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.values.get("kv.test-agent.prepared")).toBe(true);
        await agent.close();
    });

    it("lets a model-change hook persist without deadlocking on the agent's lock", async () => {
        const provider = new ScriptedProvider([textTurn("claude"), textTurn("gpt")]);
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            model: "anthropic/claude",
            hooks: {
                modelChanged: async (hookCtx, change) => {
                    const kv = agentKV(hookCtx);
                    if (kv === undefined) throw new Error("No store on the context.");
                    await kv.write(hookCtx, "last-model", change.model);
                    return system("handoff");
                },
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        // The hook runs inside the transaction committing the model change; the store executed
        // directly on the held lock instead of deadlocking, and the switch completed.
        expect(persistence.values.get("kv.test-agent.last-model")).toBe("openai/gpt");
        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            system("handoff"),
            user("switch"),
        ]);
        await agent.close();
    });
});
