import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { Type } from "@sinclair/typebox";
import { withLifetime } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import type { SessionContext, SessionMessage } from "@/core/SessionContext.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { AnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { testContext } from "./testContext.js";

const tools: readonly SessionTool[] = [
    { name: "Bash", parameters: Type.Object({ command: Type.String() }) },
    {
        name: "ToolSearch",
        server: { type: "tool_search_tool_regex", name: "tool_search_tool_regex" },
    },
    { name: "list_projects", defer: true, parameters: Type.Object({}) },
];
const bash = { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } };
const call = (id = "search-1") => ({
    type: "server_tool_use",
    id,
    name: "tool_search_tool_regex",
    input: { pattern: "list_projects" },
});
const result = (id = "search-1") => ({
    type: "tool_search_tool_result",
    tool_use_id: id,
    content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "list_projects" }],
    },
});
const initial: SessionContext = {
    instructions: "Use the tools.",
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect and find projects." }] }],
};

describe("Bedrock server tools crossing a client-tool round trip", () => {
    it("avoids the documented missing server result error when queued steering follows client results", async () => {
        const requests: AnthropicRequest[] = [];
        const provider = await scriptedProvider(requests, (index) => {
            if (index === 0) return response([bash, call()], "tool_use");
            // Anthropic resumes a pending server call only with client tool results alone.
            // Steering text ends that turn and makes the unmatched server call invalid.
            if (JSON.stringify(requests[index]).includes("search-1")) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "invalid_request_error",
                            message:
                                "tool_search_tool_regex tool use with id search-1 was found without a corresponding tool_search_tool_result block",
                        },
                    }),
                    { status: 400, headers: { "content-type": "application/json" } },
                );
            }
            return response([{ type: "text", text: "Queued steering handled." }]);
        });
        const session = await provider.session("steering-ends-server-turn", {
            instructions: "",
            tools,
        });
        try {
            const first = await collect(session.run(testContext, { context: initial }));
            const context: SessionContext = {
                ...initial,
                messages: [
                    ...initial.messages,
                    assistantMessageFromEvents(first)!,
                    { role: "tool", callId: "bash-1", content: [{ type: "text", text: "ok" }] },
                    { role: "user", content: [{ type: "text", text: "Also inspect projects." }] },
                ],
            };
            const before = structuredClone(context);
            const second = await collect(session.run(testContext, { context }));
            expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(requests[1]?.messages[1]?.content).toEqual([bash]);
            expect(requests[1]?.messages[2]?.content).toEqual([
                {
                    type: "tool_result",
                    tool_use_id: "bash-1",
                    content: "ok",
                },
            ]);
            expect(context).toEqual(before);
        } finally {
            session.destroy();
        }
    });

    it("resumes steering after abort cuts the stream between a search call and its result", async () => {
        const requests: AnthropicRequest[] = [];
        const provider = await scriptedProvider(requests, (index) =>
            index === 0
                ? response([call(), { type: "text", text: "Saved before steering." }, result()])
                : response([{ type: "text", text: "Immediate steering handled." }]),
        );
        const session = await provider.session("interrupted-steering", { instructions: "", tools });
        try {
            const controller = new AbortController();
            const events: SessionEvent[] = [];
            for await (const event of session.run(withLifetime(testContext, controller.signal), {
                context: initial,
            })) {
                events.push(event);
                if (event.type === "text_end") controller.abort();
            }
            expect(events.at(-1)).toMatchObject({ type: "done", state: "cancelled" });
            expect(events.some((event) => event.type === "toolcall_result_end")).toBe(false);
            const finished = events.find((event) => event.type === "toolcall_end");
            if (finished?.type !== "toolcall_end")
                throw new Error("Expected the persisted search prefix.");
            const context: SessionContext = {
                ...initial,
                messages: [
                    ...initial.messages,
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_call",
                                callId: finished.callId,
                                name: "ToolSearch",
                                server: true,
                                arguments: finished.arguments,
                                vendor: finished.vendor,
                            },
                            { type: "text", text: "Saved before steering." },
                        ],
                    },
                    { role: "user", content: [{ type: "text", text: "Handle this immediately." }] },
                ],
            };
            const before = structuredClone(context);
            const resumed = await collect(session.run(testContext, { context }));
            expect(resumed.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(requests[1]?.messages[1]?.content).toEqual([
                { type: "text", text: "Saved before steering." },
            ]);
            expect(context).toEqual(before);
        } finally {
            session.destroy();
        }
    });

    it.each([false, true])(
        "starts a fresh search after steering ends the pending server turn, restart=%s",
        async (restart) => {
            const requests: AnthropicRequest[] = [];
            const provider = await scriptedProvider(requests, (index) =>
                index === 0
                    ? response([bash, call()], "tool_use")
                    : index === 1
                      ? response([
                            call("search-after-steering"),
                            result("search-after-steering"),
                            { type: "text", text: "Steering handled." },
                        ])
                      : response([{ type: "text", text: "Continued after steering." }]),
            );
            let session = await provider.session("steered-search", { instructions: "", tools });
            try {
                const first = await collect(session.run(testContext, { context: initial }));
                const context: SessionContext = {
                    ...initial,
                    messages: [
                        ...initial.messages,
                        assistantMessageFromEvents(first)!,
                        { role: "tool", callId: "bash-1", content: [{ type: "text", text: "ok" }] },
                        {
                            role: "user",
                            content: [{ type: "text", text: "Also inspect the workspace." }],
                        },
                    ],
                };
                const before = structuredClone(context);
                if (restart) {
                    session.destroy();
                    session = await provider.session("steered-search", { instructions: "", tools });
                }
                const second = await collect(session.run(testContext, { context }));
                expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(second).toContainEqual(
                    expect.objectContaining({
                        type: "toolcall_result_end",
                        callId: "search-after-steering",
                    }),
                );
                expect(requests[1]?.messages[1]?.content).toEqual([bash]);
                expect(context).toEqual(before);
                const continued: SessionContext = {
                    ...context,
                    messages: [
                        ...context.messages,
                        assistantMessageFromEvents(second)!,
                        { role: "user", content: [{ type: "text", text: "Continue." }] },
                    ],
                };
                const third = await collect(session.run(testContext, { context: continued }));
                expect(third.at(-1)).toMatchObject({ type: "done", state: "normal" });
                const blocks = requests[2]!.messages.flatMap((message) =>
                    typeof message.content === "string" ? [] : message.content,
                );
                expect(blocks.filter((block) => block.type === "server_tool_use")).toEqual([
                    call("search-after-steering"),
                ]);
                expect(blocks.filter((block) => block.type === "tool_search_tool_result")).toEqual([
                    result("search-after-steering"),
                ]);
            } finally {
                session.destroy();
            }
        },
    );

    it.each([false, true])(
        "resumes an abandoned search through the SDK after restart=%s",
        async (restart) => {
            const requests: AnthropicRequest[] = [];
            const provider = await scriptedProvider(requests, (index) => {
                if (index === 0)
                    return response(
                        [call(), { type: "text", text: "Saved prefix." }],
                        "end_turn",
                        true,
                    );
                const nativeBlocks = requests
                    .at(-1)!
                    .messages.flatMap((message) =>
                        typeof message.content === "string" ? [] : message.content,
                    );
                if (nativeBlocks.some((block) => block.type === "server_tool_use")) {
                    return new Response(
                        JSON.stringify({
                            type: "error",
                            error: {
                                type: "invalid_request_error",
                                message:
                                    "tool_search_tool_regex tool use was found without a corresponding tool_search_tool_result block",
                            },
                        }),
                        { status: 400, headers: { "content-type": "application/json" } },
                    );
                }
                return response([{ type: "text", text: "Recovered." }]);
            });
            let session = await provider.session("abandoned-search", { instructions: "", tools });
            try {
                const failed = await collect(session.run(testContext, { context: initial }));
                expect(failed.at(-1)).toMatchObject({ type: "done", state: "error" });
                const finishedCall = failed.find((event) => event.type === "toolcall_end");
                if (finishedCall?.type !== "toolcall_end")
                    throw new Error("Expected a completed search call.");
                // Base retains completed blocks from failed streams, including a hidden call
                // flushed before a completed text block. Reconstruct that durable prefix.
                const context: SessionContext = {
                    ...initial,
                    messages: [
                        ...initial.messages,
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "tool_call",
                                    callId: finishedCall.callId,
                                    name: "ToolSearch",
                                    server: true,
                                    arguments: finishedCall.arguments,
                                    vendor: finishedCall.vendor,
                                },
                                { type: "text", text: "Saved prefix." },
                            ],
                        },
                        { role: "user", content: [{ type: "text", text: "Continue." }] },
                    ],
                };
                const before = structuredClone(context);
                if (restart) {
                    session.destroy();
                    session = await provider.session("abandoned-search", {
                        instructions: "",
                        tools,
                    });
                }
                const resumed = await collect(session.run(testContext, { context }));
                expect(resumed.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(requests[1]?.messages[1]?.content).toEqual([
                    { type: "text", text: "Saved prefix." },
                ]);
                expect(context).toEqual(before);
            } finally {
                session.destroy();
            }
        },
    );

    it.each([false, true])("correlates the delayed result after restart=%s", async (restart) => {
        const requests: AnthropicRequest[] = [];
        const provider = await scriptedProvider(requests, (index) =>
            index === 0
                ? response([bash, call()], "tool_use")
                : index === 1
                  ? response([result(), { type: "text", text: "Ready." }])
                  : response([{ type: "text", text: "Continued." }]),
        );
        let session = await provider.session("mixed-server-tools", { instructions: "", tools });
        try {
            const first = await collect(session.run(testContext, { context: initial }));
            expect(first.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
            const messages: SessionMessage[] = [
                ...initial.messages,
                assistantMessageFromEvents(first)!,
                { role: "tool", callId: "bash-1", content: [{ type: "text", text: "/workspace" }] },
            ];
            if (restart) {
                session.destroy();
                session = await provider.session("mixed-server-tools", { instructions: "", tools });
            }
            const context = { ...initial, messages };
            const before = structuredClone(context);
            const second = await collect(session.run(testContext, { context }));

            // The unchanged core correlates only starts from this run. A result alone cannot pass.
            expect(second).toContainEqual(
                expect.objectContaining({
                    type: "toolcall_start",
                    callId: "search-1",
                    name: "ToolSearch",
                    server: true,
                }),
            );
            expect(second.findIndex((event) => event.type === "toolcall_start")).toBeLessThan(
                second.findIndex((event) => event.type === "toolcall_result_start"),
            );
            expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(
                second.filter((event) => event.type === "toolcall_start" && !event.server),
            ).toEqual([]);
            expect(context).toEqual(before);
            expect(requests[1]?.tools).toEqual(requests[0]?.tools);
            expect(requests[1]?.messages[1]?.content).toEqual([bash, call()]);
            expect(requests[1]?.messages[2]?.content).toEqual([
                {
                    type: "tool_result",
                    tool_use_id: "bash-1",
                    content: "/workspace",
                    cache_control: { type: "ephemeral" },
                },
            ]);

            const continued = {
                ...initial,
                messages: [
                    ...messages,
                    assistantMessageFromEvents(second)!,
                    {
                        role: "user" as const,
                        content: [{ type: "text" as const, text: "Continue." }],
                    },
                ],
            };
            const continuedBefore = structuredClone(continued);
            const third = await collect(session.run(testContext, { context: continued }));
            expect(third.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(continued).toEqual(continuedBefore);
            const nativeBlocks = requests[2]!.messages.flatMap((message) =>
                typeof message.content === "string" ? [] : message.content,
            );
            expect(nativeBlocks.filter((block) => block.type === "server_tool_use")).toEqual([
                call(),
            ]);
            expect(
                nativeBlocks.filter((block) => block.type === "tool_search_tool_result"),
            ).toEqual([result()]);
            expect(requests[2]?.messages[3]?.content).toEqual([
                result(),
                { type: "text", text: "Ready." },
            ]);
        } finally {
            session.destroy();
        }
    });

    it("reconstructs several pending calls and accepts results in their native order", async () => {
        const requests: AnthropicRequest[] = [];
        const provider = await scriptedProvider(requests, (index) =>
            index === 0
                ? response([bash, call("one"), call("two")], "tool_use")
                : response([result("two"), result("one"), { type: "text", text: "Done." }]),
        );
        const session = await provider.session("multiple-searches", { instructions: "", tools });
        try {
            const first = await collect(session.run(testContext, { context: initial }));
            const context: SessionContext = {
                ...initial,
                messages: [
                    ...initial.messages,
                    assistantMessageFromEvents(first)!,
                    { role: "tool", callId: "bash-1", content: [{ type: "text", text: "ok" }] },
                ],
            };
            const second = await collect(session.run(testContext, { context }));
            expect(
                second
                    .filter((event) => event.type === "toolcall_start")
                    .map((event) => event.callId),
            ).toEqual(["two", "one"]);
            expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
        } finally {
            session.destroy();
        }
    });

    it("rejects an unknown result without inventing a tool call", async () => {
        const provider = await scriptedProvider([], () => response([result("unknown")]));
        const session = await provider.session("unknown-search", { instructions: "", tools });
        try {
            const events = await collect(session.run(testContext, { context: initial }));
            expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
            expect(
                events.some(
                    (event) =>
                        event.type === "toolcall_start" || event.type === "toolcall_result_start",
                ),
            ).toBe(false);
        } finally {
            session.destroy();
        }
    });

    it("recreates correlation after a dropped continuation attempt without rerunning the client call", async () => {
        const requests: AnthropicRequest[] = [];
        const provider = await scriptedProvider(
            requests,
            (index) =>
                index === 0
                    ? response([bash, call()], "tool_use")
                    : index === 1
                      ? response([result()], "end_turn", true)
                      : response([result(), { type: "text", text: "Recovered." }]),
            1,
        );
        const session = await provider.session("retried-search", { instructions: "", tools });
        try {
            const first = await collect(session.run(testContext, { context: initial }));
            const context: SessionContext = {
                ...initial,
                messages: [
                    ...initial.messages,
                    assistantMessageFromEvents(first)!,
                    { role: "tool", callId: "bash-1", content: [{ type: "text", text: "ok" }] },
                ],
            };
            const before = structuredClone(context);
            const events = await collect(session.run(testContext, { context }));
            expect(events.filter((event) => event.type === "block_reset")).toHaveLength(1);
            expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(assistantMessageFromEvents(events)?.content.map((block) => block.type)).toEqual([
                "tool_call",
                "tool_result",
                "text",
            ]);
            expect(requests[2]).toEqual(requests[1]);
            expect(context).toEqual(before);
        } finally {
            session.destroy();
        }
    });

    it("keeps caller history resumable when a delayed settlement is aborted", async () => {
        const requests: AnthropicRequest[] = [];
        const provider = await scriptedProvider(requests, (index) =>
            index === 0
                ? response([bash, call()], "tool_use")
                : response([result(), { type: "text", text: "Recovered after abort." }]),
        );
        let session = await provider.session("aborted-search", { instructions: "", tools });
        try {
            const first = await collect(session.run(testContext, { context: initial }));
            const context: SessionContext = {
                ...initial,
                messages: [
                    ...initial.messages,
                    assistantMessageFromEvents(first)!,
                    { role: "tool", callId: "bash-1", content: [{ type: "text", text: "ok" }] },
                ],
            };
            const before = structuredClone(context);
            const controller = new AbortController();
            const events: SessionEvent[] = [];
            for await (const event of session.run(withLifetime(testContext, controller.signal), {
                context,
            })) {
                events.push(event);
                if (event.type === "toolcall_start") controller.abort();
            }
            expect(events.at(-1)).toMatchObject({ type: "done", state: "cancelled" });
            expect(assistantMessageFromEvents(events)).toBeUndefined();
            expect(context).toEqual(before);
            session.destroy();
            session = await provider.session("aborted-search", { instructions: "", tools });
            const resumed = await collect(session.run(testContext, { context }));
            expect(resumed.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(resumed).toContainEqual(
                expect.objectContaining({ type: "toolcall_result_end", callId: "search-1" }),
            );
            expect(requests[2]).toEqual(requests[1]);
        } finally {
            session.destroy();
        }
    });
});

async function scriptedProvider(
    requests: AnthropicRequest[],
    reply: (index: number) => Response,
    inferenceMaxRetries = 0,
) {
    const credential = await BedrockBearerTokenCredential.tryLoad({
        bearerToken: "test-only-placeholder",
    });
    if (credential === null) throw new Error("Expected a test credential.");
    return new AnthropicBedrockProvider({
        credential,
        model: "anthropic/opus-5-5",
        inferenceMaxRetries,
        client: new AnthropicBedrockMantle({
            apiKey: "test-only-placeholder",
            awsRegion: "us-east-1",
            maxRetries: 0,
            fetch: async (_url, init) => {
                requests.push(JSON.parse(String(init?.body)) as AnthropicRequest);
                return reply(requests.length - 1);
            },
        }),
    });
}

async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function response(
    blocks: readonly unknown[],
    stopReason = "end_turn",
    failAfterBlocks = false,
): Response {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg",
                type: "message",
                role: "assistant",
                model: "claude-opus-5-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
            },
        },
        ...blocks.flatMap((content_block, index) => [
            { type: "content_block_start", index, content_block },
            { type: "content_block_stop", index },
        ]),
        ...(failAfterBlocks
            ? [{ type: "error", error: { type: "api_error", message: "Scripted stream failure." } }]
            : [
                  {
                      type: "message_delta",
                      delta: { stop_reason: stopReason, stop_sequence: null },
                      usage: { output_tokens: 10 },
                  },
                  { type: "message_stop" },
              ]),
    ];
    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        {
            headers: { "content-type": "text/event-stream" },
        },
    );
}
