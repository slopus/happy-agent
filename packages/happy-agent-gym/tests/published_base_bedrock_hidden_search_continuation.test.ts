import { Type } from "@sinclair/typebox";
import { AgentBase, AgentProviders, defineAgentTool } from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryPersistence } from "../../happy-agent-base/tests/gym/InMemoryPersistence.js";

// This boundary deliberately keeps AgentBase at its published version. Build the candidate
// provider first; set HAPPY_GYM_PUBLISHED_PROVIDER=1 to reproduce against the published adapter.
afterEach(() => vi.unstubAllGlobals());

describe("published AgentBase with a Bedrock native search continuation", () => {
    it.each([false, true])(
        "executes the client tool once, hides search events, and replays one native pair after recreation (retry: %s)",
        async (retry) => {
            const providerModule =
                process.env.HAPPY_GYM_PUBLISHED_PROVIDER === "1"
                    ? "@slopus/happy-providers"
                    : new URL("../../happy-providers/dist/index.js", import.meta.url).href;
            // A consumer-only typecheck need not build the candidate provider. Its published
            // interface remains the boundary; only this regression loads the built copy.
            const providerImplementation: typeof import("@slopus/happy-providers") = await import(
                providerModule
            );
            const ctx = createRootContext().named("bedrock-search-continuation-boundary");
            const search = {
                type: "server_tool_use",
                id: "srvtoolu_search",
                name: "tool_search_tool_bm25",
                input: { query: "read a web page" },
            };
            const result = {
                type: "tool_search_tool_result",
                tool_use_id: search.id,
                content: { type: "tool_search_tool_search_result", tool_references: [] },
            };
            const bash = {
                type: "tool_use",
                id: "toolu_bash",
                name: "Bash",
                input: { command: "record one execution" },
            };
            const requests: { messages: { role: string; content: unknown }[] }[] = [];
            vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
                const body =
                    typeof init?.body === "string"
                        ? init.body
                        : await new Request(input, init).text();
                requests.push(JSON.parse(body));
                if (requests.length === 1) return responseFor([bash, search], "tool_use");
                if (retry && requests.length === 2) return responseFor([result], "end_turn", true);
                if (requests.length === (retry ? 3 : 2))
                    return responseFor([result, { type: "text", text: "CONTINUED" }], "end_turn");
                if (requests.length === (retry ? 4 : 3))
                    return responseFor([{ type: "text", text: "RECREATED" }], "end_turn");
                throw new Error("Unexpected additional inference request.");
            });
            const credential = await providerImplementation.BedrockBearerTokenCredential.tryLoad({
                bearerToken: "test-only-placeholder",
            });
            if (credential === null)
                throw new Error("The explicit test credential was not created.");
            const providers = new AgentProviders();
            providers.add(
                "bedrock",
                new providerImplementation.AnthropicProvider({
                    credential,
                    model: "anthropic/fable-5-1",
                    transport: "mantle",
                    inferenceMaxRetries: 1,
                    waitForInferenceRetry: async () => {},
                }),
                "bedrock",
            );
            const persistence = new InMemoryPersistence();
            const events: SessionEvent[] = [];
            const executions: string[] = [];
            const options = {
                id: "bedrock-search-agent",
                providers,
                provider: "bedrock",
                model: "anthropic/fable-5-1",
                persistence,
                hooks: {
                    onEvent: (_ctx: typeof ctx, event: SessionEvent) => {
                        events.push(event);
                    },
                },
                initialState: {
                    tools: [
                        defineAgentTool({
                            name: "Bash",
                            parameters: Type.Object({ command: Type.String() }),
                            returnType: Type.Object({}),
                            shouldReviewInAutoMode: () => false,
                            execute: (_ctx, args) => {
                                executions.push(args.command);
                                return Promise.resolve({});
                            },
                            toLLM: () => [{ type: "text" as const, text: "Executed once." }],
                        }),
                        defineAgentTool({
                            name: "ToolSearch",
                            server: { type: "tool_search_tool_bm25_20251119", name: search.name },
                            persistInHistory: false,
                            visibleToUser: false,
                            returnType: Type.Object({}),
                            shouldReviewInAutoMode: () => false,
                            execute: () =>
                                Promise.reject(new Error("Only Bedrock executes native search.")),
                            toLLM: () => [],
                        }),
                    ],
                },
            };
            let agent = await AgentBase.create(ctx, options);
            try {
                await agent.send(ctx, {
                    role: "user",
                    content: [{ type: "text", text: "Execute and continue." }],
                });
                await agent.waitForIdle();
                expect(
                    events.filter((event) => event.type === "done").at(-1),
                    JSON.stringify(events),
                ).toMatchObject({
                    state: "normal",
                });
                expect(events).toContainEqual({ type: "text_delta", delta: "CONTINUED" });
                expect(executions).toEqual([bash.input.command]);
                expect(requests).toHaveLength(retry ? 3 : 2);
                expect(JSON.stringify(events)).not.toContain("ToolSearch");
                expect(JSON.stringify(events)).not.toContain(search.id);
                expect(JSON.stringify(events)).not.toContain(search.input.query);

                await agent.close();
                agent = await AgentBase.create(ctx, options);
                await agent.send(ctx, {
                    role: "user",
                    content: [{ type: "text", text: "Continue after recreation." }],
                });
                await agent.waitForIdle();
                expect(events).toContainEqual({ type: "text_delta", delta: "RECREATED" });
                expect(requests).toHaveLength(retry ? 4 : 3);
                expect(executions).toEqual([bash.input.command]);
                const blocks = requests
                    .at(-1)!
                    .messages.flatMap((message) =>
                        Array.isArray(message.content) ? message.content : [],
                    );
                expect(blocks.filter((block) => block.type === "server_tool_use")).toEqual([
                    search,
                ]);
                expect(blocks.filter((block) => block.type === "tool_search_tool_result")).toEqual([
                    result,
                ]);
                expect(blocks.filter((block) => block.id === bash.id)).toHaveLength(1);
                expect(blocks.filter((block) => block.tool_use_id === bash.id)).toHaveLength(1);
                const bashIndex = blocks.findIndex((block) => block.id === bash.id);
                const searchIndex = blocks.findIndex((block) => block.id === search.id);
                const bashResultIndex = blocks.findIndex((block) => block.tool_use_id === bash.id);
                const searchResultIndex = blocks.findIndex(
                    (block) => block.tool_use_id === search.id,
                );
                expect(bashIndex).toBeGreaterThanOrEqual(0);
                expect(searchIndex).toBeGreaterThan(bashIndex);
                expect(bashResultIndex).toBeGreaterThan(searchIndex);
                expect(searchResultIndex).toBeGreaterThan(bashResultIndex);
            } finally {
                await agent.close();
            }
        },
    );
});

function responseFor(
    blocks: readonly Record<string, unknown>[],
    stopReason: string,
    failAfterBlocks = false,
): Response {
    const events: Record<string, unknown>[] = [
        {
            type: "message_start",
            message: {
                id: `msg_${stopReason}_${blocks.length}`,
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
            },
        },
    ];
    for (const [index, block] of blocks.entries()) {
        const tool = block.type === "tool_use" || block.type === "server_tool_use";
        events.push({
            type: "content_block_start",
            index,
            content_block: tool ? { ...block, input: {} } : block,
        });
        if (tool)
            events.push({
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            });
        events.push({ type: "content_block_stop", index });
    }
    if (failAfterBlocks) {
        events.push({
            type: "error",
            error: {
                type: "api_error",
                message: "Scripted failure after the completed search result.",
            },
        });
    } else
        events.push(
            {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: 20 },
            },
            { type: "message_stop" },
        );
    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
    );
}
