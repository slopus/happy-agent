import type { SessionCompaction, SessionEvent, SessionMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase, defineAgentTool, type AgentBasePersistedEvent } from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";

const completedCompaction = (messages: SessionMessage[]): SessionCompaction => ({
    status: "completed",
    preservedMessages: [],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    context: { instructions: "", messages },
});

function discoveryTool(options?: {
    readonly capabilities?: readonly string[];
    readonly searchKeywords?: readonly string[];
    readonly persistInHistory?: boolean;
    readonly visibleToUser?: boolean;
}) {
    return defineAgentTool({
        name: "inspect",
        server: { type: "tool_search", execution: "client" },
        description: "Inspect the workspace.",
        returnType: Type.Object({}),
        shouldReviewInAutoMode: () => false,
        execute: () => Promise.reject(new Error("A server tool must not execute in Base.")),
        toLLM: () => [],
        ...options,
    });
}

function contextOnlyServerTool() {
    return defineAgentTool({
        name: "web_search",
        namespace: "search",
        server: { type: "web_search", execution: "server" },
        persistInHistory: false,
        visibleToUser: false,
        returnType: Type.Object({}),
        shouldReviewInAutoMode: () => false,
        execute: () => Promise.reject(new Error("A server tool must not execute in Base.")),
        toLLM: () => [],
    });
}

function serverTurn(): SessionEvent[] {
    return [
        {
            type: "toolcall_start",
            callId: "server-call",
            name: "web_search",
            namespace: "search",
            server: true,
        },
        { type: "toolcall_delta", callId: "server-call", delta: '{"query":"weather"}' },
        {
            type: "toolcall_end",
            callId: "server-call",
            arguments: '{"query":"weather"}',
        },
        { type: "toolcall_result_start", callId: "server-call" },
        { type: "toolcall_result_delta", callId: "server-call", delta: "sunny" },
        {
            type: "toolcall_result_end",
            callId: "server-call",
            content: [{ type: "text", text: "sunny" }],
        },
        { type: "text_start" },
        { type: "text_delta", delta: "Found it." },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

function interruptedServerTurn(): SessionEvent[] {
    return [
        {
            type: "toolcall_start",
            callId: "server-call",
            name: "web_search",
            namespace: "search",
            server: true,
        },
        {
            type: "toolcall_end",
            callId: "server-call",
            arguments: '{"query":"weather"}',
        },
        {
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "Search transport disconnected.",
        },
    ];
}

function completedCallOnlyServerTurn(): SessionEvent[] {
    return [
        {
            type: "toolcall_start",
            callId: "server-call",
            name: "web_search",
            namespace: "search",
            server: true,
        },
        {
            type: "toolcall_end",
            callId: "server-call",
            arguments: '{"query":"weather"}',
        },
        { type: "text_start" },
        { type: "text_delta", delta: "Found it." },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

describe("Agent tool discovery metadata", () => {
    it("derives deterministic capabilities and keys only provider-facing discovery changes", async () => {
        const ctx = createRootContext().named("tool-discovery-metadata-test");
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
            textTurn("four"),
        ]);
        let toolResolutions = 0;
        const agent = await AgentBase.create(ctx, {
            id: "tool-discovery-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                instructions: () => "Hook instructions.",
                tools: () => {
                    toolResolutions += 1;
                    return [
                        defineAgentTool({
                            name: "test",
                            capabilities: ["search FILES", " Run tests ", "  "],
                            returnType: Type.Object({}),
                            shouldReviewInAutoMode: () => false,
                            execute: () => Promise.resolve({}),
                            toLLM: () => [],
                        }),
                    ];
                },
            },
            initialState: {
                instructions: "Base instructions.",
                tools: [
                    discoveryTool({
                        capabilities: [" Search files ", "SEARCH FILES"],
                        searchKeywords: ["workspace", "inspect"],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.options.instructions).toBe(
            [
                "Base instructions.",
                "Hook instructions.",
                "Tool capabilities:\n- Search files\n- Run tests",
            ].join("\n\n"),
        );
        expect(provider.sessions[0]?.options.tools?.[0]).toMatchObject({
            searchKeywords: ["workspace", "inspect"],
        });

        // Publication is Base-owned and does not alter the provider session identity.
        agent.state.tools[0] = discoveryTool({
            capabilities: [" Search files ", "SEARCH FILES"],
            searchKeywords: ["workspace", "inspect"],
            persistInHistory: false,
            visibleToUser: false,
        });
        await agent.send(ctx, user("second"));
        await agent.waitForIdle();
        expect(provider.sessions).toHaveLength(1);

        // Native discovery metadata is provider-facing and therefore recreates the session.
        agent.state.tools[0] = discoveryTool({
            capabilities: [" Search files ", "SEARCH FILES"],
            searchKeywords: ["workspace", "inspect", "files"],
            persistInHistory: false,
            visibleToUser: false,
        });
        await agent.send(ctx, user("third"));
        await agent.waitForIdle();
        expect(provider.sessions).toHaveLength(2);

        // Capability changes recreate through the derived instructions, not a second tool read.
        agent.state.tools[0] = discoveryTool({
            capabilities: ["Search files", "Read metadata"],
            searchKeywords: ["workspace", "inspect", "files"],
        });
        await agent.send(ctx, user("fourth"));
        await agent.waitForIdle();
        expect(provider.sessions).toHaveLength(3);
        expect(provider.sessions[2]?.options.instructions).toContain("- Read metadata");
        expect(toolResolutions).toBe(4);
        await agent.close();
    });

    it("uses one resolved tool snapshot for a compaction", async () => {
        const ctx = createRootContext().named("tool-discovery-compaction-test");
        const provider = new ScriptedProvider([textTurn("answer")]);
        const originalSession = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await originalSession(id, options);
            (session as ScriptedSession).compactionResults = [
                completedCompaction([
                    { role: "compaction", content: "summary", encryptedContent: null },
                ]),
            ];
            return session;
        };
        let toolResolutions = 0;
        const agent = await AgentBase.create(ctx, {
            id: "tool-discovery-compaction-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                tools: () => {
                    toolResolutions += 1;
                    return [discoveryTool({ capabilities: ["Inspect files"] })];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();
        expect(toolResolutions).toBe(1);
        await agent.compact(ctx);
        await agent.waitForIdle();

        expect(toolResolutions).toBe(2);
        expect(provider.sessions[0]?.compactions[0]?.context.instructions).toBe(
            "Tool capabilities:\n- Inspect files",
        );
        await agent.close();
    });
});

describe("Agent tool publication policy", () => {
    it("keeps a context-only server lifecycle private while preserving it across restart", async () => {
        const ctx = createRootContext().named("context-only-server-tool-test");
        const persistence = new InMemoryPersistence();
        const raw: SessionEvent[] = [];
        const history: AgentBasePersistedEvent[] = [];
        const firstProvider = new ScriptedProvider([serverTurn()]);
        const first = await AgentBase.create(ctx, {
            id: "context-only-server-agent",
            providers: providersOf(firstProvider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => raw.push(event),
                onEventTransact: (_hookCtx, event) => void history.push(event),
            },
            initialState: { tools: [contextOnlyServerTool()] },
        });

        await first.send(ctx, user("search"));
        await first.waitForIdle();
        await first.close();

        expect(raw.map((event) => event.type)).toEqual([
            "text_start",
            "text_delta",
            "text_end",
            "done",
        ]);
        expect(history).toEqual([{ type: "text_end", block: { type: "text", text: "Found it." } }]);
        expect(persistence.records).toContainEqual(
            expect.objectContaining({
                type: "block",
                block: expect.objectContaining({
                    type: "tool_call",
                    name: "web_search",
                    arguments: '{"query":"weather"}',
                    server: true,
                }),
            }),
        );
        expect(persistence.records).toContainEqual(
            expect.objectContaining({
                type: "block",
                block: expect.objectContaining({
                    type: "tool_result",
                    content: [{ type: "text", text: "sunny" }],
                }),
            }),
        );

        const secondProvider = new ScriptedProvider([textTurn("reloaded")]);
        const second = await AgentBase.load(ctx, {
            id: "context-only-server-agent",
            providers: providersOf(secondProvider),
            provider: "scripted",
            persistence,
            initialState: { tools: [contextOnlyServerTool()] },
        });
        await second.send(ctx, user("again"));
        await second.waitForIdle();

        const replay = secondProvider.sessions[0]?.requests[0]?.context.messages;
        expect(replay).toContainEqual(
            expect.objectContaining({
                role: "assistant",
                content: expect.arrayContaining([
                    expect.objectContaining({ type: "tool_call", name: "web_search" }),
                    expect.objectContaining({ type: "tool_result" }),
                ]),
            }),
        );
        await second.close();
    });

    it("does not persist a provider-local search call until its result completes", async () => {
        const ctx = createRootContext().named("interrupted-context-only-server-tool-test");
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "interrupted-context-only-server-agent",
            providers: providersOf(new ScriptedProvider([interruptedServerTurn()])),
            provider: "scripted",
            persistence,
            initialState: { tools: [contextOnlyServerTool()] },
        });

        await agent.send(ctx, user("search"));
        await agent.waitForIdle();

        expect(persistence.records).not.toContainEqual(
            expect.objectContaining({
                type: "block",
                block: expect.objectContaining({ type: "tool_call", name: "web_search" }),
            }),
        );
        await agent.close();
    });

    it("persists a hidden provider call that completed successfully without exposing a result", async () => {
        const ctx = createRootContext().named("completed-call-only-server-tool-test");
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "completed-call-only-server-agent",
            providers: providersOf(new ScriptedProvider([completedCallOnlyServerTurn()])),
            provider: "scripted",
            persistence,
            initialState: { tools: [contextOnlyServerTool()] },
        });

        await agent.send(ctx, user("search"));
        await agent.waitForIdle();

        expect(persistence.records).toContainEqual(
            expect.objectContaining({
                type: "block",
                block: expect.objectContaining({ type: "tool_call", name: "web_search" }),
            }),
        );
        const persistedBlocks = persistence.records.flatMap((record) =>
            record.type === "block" ? [record.block] : [],
        );
        expect(persistedBlocks.map((block) => block.type)).toEqual(["tool_call", "text"]);
        await agent.close();
    });

    it("rejects publication suppression on a Base-executed tool", async () => {
        const ctx = createRootContext().named("executable-tool-publication-test");
        const provider = new ScriptedProvider([textTurn("unused")]);
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "executable-tool-publication-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "context_tool",
                        persistInHistory: false,
                        visibleToUser: false,
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () => Promise.resolve({}),
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("run"));
        await agent.waitForIdle();

        expect(provider.sessions).toHaveLength(0);
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "error",
            kind: "internal_error",
            message:
                'Tool "context_tool" may hide publication only when the provider owns it through a server descriptor.',
        });
        await agent.close();
    });
});
