import { testContext } from "../testContext.js";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { CodexSession } from "@/vendors/codex/CodexSession.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { codex_server_tools, tool_search, web_search } from "@/vendors/codex/tools/index.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";

/**
 * OpenAI runs `web_search` on its own backend inside a single response, the way the Codex CLI does.
 * Rig declares it and reads the result back; it never executes or answers one.
 */
describe("Codex server tools", () => {
    it("declares web search the way the captured CLI request does", () => {
        expect(toCodexToolDefinitions(codex_server_tools)).toEqual([
            {
                type: "web_search",
                external_web_access: false,
                search_content_types: ["text", "image"],
            },
        ]);
        expect(web_search.server).toEqual({
            type: "web_search",
            external_web_access: false,
            search_content_types: ["text", "image"],
        });
    });

    it("reports a server search as provider-executed rather than a call Rig must answer", async () => {
        const { events, result } = await replay(
            [
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_1",
                        action: { type: "search", query: "Node.js current stable version" },
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            new Set(["web_search"]),
        );

        expect(serverToolCallNames(events)).toEqual(["web_search"]);
        // Nothing was asked of the client, so the turn is a finished answer rather than a loop.
        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
    });

    it("accepts the partial in-progress item Codex emits before the search action arrives", async () => {
        const { events, result } = await replay(
            [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_1",
                        status: "in_progress",
                    },
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_1",
                        status: "completed",
                        action: { type: "search", query: "Node.js current stable version" },
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            new Set(["web_search"]),
        );

        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "ws_1",
            name: "web_search",
            server: true,
        });
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_end",
                callId: "ws_1",
                arguments: '{"type":"search","query":"Node.js current stable version"}',
            }),
        );
        expect(result.stopReason).toBe("stop");
    });

    // Everything above this line reads a response. None of it can tell whether the server tool ever
    // reached a request, which is the half that was silently broken: the provider accepted the
    // callback and dropped it on the way to the session, so Rig declared no search at all and the
    // mapper was simply never given the chance to be wrong. This asserts on the bytes on the wire.
    it("puts the server search into the request the provider actually sends", async () => {
        const declared = await declaredTools(codex_server_tools);

        expect(declared).toContainEqual({
            type: "web_search",
            external_web_access: false,
            search_content_types: ["text", "image"],
        });
    });

    it("sends no search when the session defines no server tool", async () => {
        const declared = await declaredTools([]);

        expect(declared.some((tool) => tool.type === "web_search")).toBe(false);
    });

    // Compaction summarizes context that already exists, so there is nothing for it to search. It
    // never adds server tools, but it was also forwarding whatever tools it was handed — so a
    // configured one would have ridden along. It drops them instead, which is also what keeps a
    // compaction sample that calls a tool counting as a tool call rather than as provider work.
    it("declares no server search while compacting, even when handed one", async () => {
        const declared = await declaredTools(codex_server_tools, async (session) => {
            await session
                .compact(testContext, { context: { instructions: "", messages: [] } })
                .catch(() => {
                    // The stub server does not return a real compaction item; the request it was sent
                    // is the whole subject here.
                });
        });

        expect(declared.some((tool) => tool.type === "web_search")).toBe(false);
    });

    it("declares no deferred tool search while compacting", async () => {
        const declared = await declaredTools(
            [
                {
                    name: "weather_forecast",
                    description: "Read a weather forecast.",
                    parameters: Type.Object({ city: Type.String() }),
                    defer: true,
                },
                tool_search,
            ],
            async (session) => {
                await session
                    .compact(testContext, { context: { instructions: "", messages: [] } })
                    .catch(() => {
                        // The stub server does not return a real compaction item.
                    });
            },
        );

        expect(declared.some((tool) => tool.type === "tool_search")).toBe(false);
        expect(declared.some((tool) => tool.name === "weather_forecast")).toBe(false);
    });

    // A request that did not declare server search cannot receive one. Compaction sends none, so
    // this is also what keeps a compaction sample that calls a tool counting as a tool call.
    it("treats the same item as client work when no server tool was declared", async () => {
        const { events } = await replay(
            [
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "web_search",
                        input: '{"query":"anything"}',
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            new Set(),
        );

        expect(
            events.some((event) => event.type === "toolcall_start" && event.server === true),
        ).toBe(false);
    });

    it("settles deferred tool discovery inside the Codex session and continues inference", async () => {
        const bodies: Record<string, any>[] = [];
        const server = createServer(async (request, response) => {
            bodies.push(JSON.parse(await readBody(request)));
            if (bodies.length === 1) {
                completeSseWith(response, [
                    {
                        type: "response.completed",
                        response: {
                            output: [
                                {
                                    type: "tool_search_call",
                                    call_id: "search-1",
                                    execution: "client",
                                    arguments: { query: "weather forecast" },
                                },
                            ],
                            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                        },
                    },
                ]);
                return;
            }
            completeSseWith(response, [
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "message",
                                id: "message-1",
                                role: "assistant",
                                content: [
                                    {
                                        type: "output_text",
                                        text: "Forecast tool loaded.",
                                        annotations: [],
                                    },
                                ],
                            },
                        ],
                        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
                    },
                },
            ]);
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const session = new CodexSession("tool-search-session", {
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                installationId: "00000000-0000-4000-8000-000000000001",
                instructions: "Be brief.",
                tools: [
                    {
                        name: "weather_forecast",
                        description: "Read a weather forecast.",
                        parameters: Type.Object({ city: Type.String() }),
                        defer: true,
                    },
                    {
                        ...tool_search,
                        name: "discover_tools",
                        namespace: "search",
                    },
                ],
                transport: "sse",
                userAgent: "rig-test",
            });
            const events: SessionEvent[] = [];
            for await (const event of session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Check the weather." }],
                        },
                    ],
                },
                effort: "low",
                model: "gpt-5.6-sol",
            })) {
                events.push(event);
            }

            expect(events).toContainEqual(
                expect.objectContaining({
                    type: "toolcall_start",
                    name: "discover_tools",
                    namespace: "search",
                    server: true,
                }),
            );
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: "toolcall_result_end",
                    content: [],
                }),
            );
            expect(events).toContainEqual({
                type: "text_delta",
                delta: "Forecast tool loaded.",
            });
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(bodies).toHaveLength(2);
            const firstRequestTools = requestTools(bodies[0] ?? {});
            const secondRequestTools = requestTools(bodies[1] ?? {});
            expect(firstRequestTools).toContainEqual(
                expect.objectContaining({ name: "weather_forecast", defer_loading: true }),
            );
            expect(firstRequestTools).toContainEqual(
                expect.objectContaining({ type: "tool_search", execution: "client" }),
            );
            expect(firstRequestTools).toContainEqual(
                expect.objectContaining({
                    type: "tool_search",
                    description: tool_search.server.description,
                }),
            );
            expect(secondRequestTools).toContainEqual(
                expect.objectContaining({ name: "weather_forecast", defer_loading: true }),
            );
            expect(
                bodies[1]?.input.find((item: any) => item.type === "tool_search_output"),
            ).toMatchObject({
                type: "tool_search_output",
                call_id: "search-1",
                execution: "client",
                status: "completed",
                tools: [
                    {
                        type: "function",
                        name: "weather_forecast",
                        defer_loading: true,
                    },
                ],
            });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("stops a Codex turn that keeps searching without making progress", async () => {
        const bodies: Record<string, any>[] = [];
        const server = createServer(async (request, response) => {
            bodies.push(JSON.parse(await readBody(request)));
            const callId = `search-${bodies.length}`;
            completeSseWith(response, [
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "tool_search_call",
                                call_id: callId,
                                execution: "client",
                                arguments: { query: "missing capability" },
                            },
                        ],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                },
            ]);
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const session = new CodexSession("tool-search-limit-session", {
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                installationId: "00000000-0000-4000-8000-000000000001",
                instructions: "Be brief.",
                tools: [
                    {
                        name: "weather_forecast",
                        description: "Read a weather forecast.",
                        parameters: Type.Object({ city: Type.String() }),
                        defer: true,
                    },
                    tool_search,
                ],
                transport: "sse",
                userAgent: "rig-test",
            });
            const events: SessionEvent[] = [];
            for await (const event of session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text" as const, text: "Find a missing capability." },
                            ],
                        },
                    ],
                },
                effort: "low",
                model: "gpt-5.6-sol",
            })) {
                events.push(event);
            }

            expect(bodies).toHaveLength(5);
            expect(events.at(-1)).toEqual({
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "Codex exceeded the provider-internal tool discovery limit.",
            });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

/** Names of every `toolcall_start` the provider marked `server: true`, in emission order. */
function serverToolCallNames(events: readonly SessionEvent[]): readonly string[] {
    return events.flatMap((event) =>
        event.type === "toolcall_start" && event.server === true ? [event.name] : [],
    );
}

async function replay(events: readonly unknown[], serverToolNames: ReadonlySet<string>) {
    const mapped = mapOpenAIResponseStream(stream(events), {
        failureMessage: "unused",
        serverToolNames,
        vendor: "codex",
    });
    const collected: SessionEvent[] = [];
    let next = await mapped.next();
    while (next.done !== true) {
        collected.push(next.value);
        next = await mapped.next();
    }
    return { events: collected, result: next.value };
}

async function* stream(events: readonly unknown[]) {
    for (const event of events) yield event as never;
}

/**
 * Runs one real turn against a local server and returns every tool Rig declared to OpenAI.
 *
 * Which request carries them depends on the model: the classic shape sends a `tools` array, while
 * the lite shape these models use sends them ahead of the turn as `additional_tools`. Both are Rig
 * telling OpenAI what it may run, so both count, and the test does not have to know which is which.
 */
async function declaredTools(
    tools: readonly SessionTool[],
    exercise?: (session: CodexSession) => Promise<void>,
): Promise<readonly Record<string, any>[]> {
    const bodies: Record<string, any>[] = [];
    const server = createServer(async (request, response) => {
        bodies.push(JSON.parse(await readBody(request)));
        completeSse(response);
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port.");

    try {
        const session = new CodexSession("session-1", {
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            installationId: "00000000-0000-4000-8000-000000000001",
            instructions: "Be brief.",
            tools,
            transport: "sse",
            userAgent: "rig-test",
        });
        for await (const _event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Reply with OK." }],
                    },
                ],
            },
            effort: "low",
            model: "gpt-5.6-sol",
        })) {
            // Drain the response.
        }
        if (exercise !== undefined) {
            // A configured tool belongs in the turn above; what follows is the subject.
            bodies.length = 0;
            await exercise(session);
        }
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (bodies.length === 0) throw new Error("The provider sent no request.");
    return bodies.flatMap((body) => [
        ...((body.tools as readonly { type?: string }[] | undefined) ?? []),
        ...((body.input as readonly Record<string, any>[] | undefined) ?? []).flatMap(
            (item): readonly { type?: string }[] =>
                item.type === "additional_tools" ? (item.tools ?? []) : [],
        ),
    ]);
}

function requestTools(body: Record<string, any>): readonly Record<string, any>[] {
    return [
        ...((body.tools as readonly Record<string, any>[] | undefined) ?? []),
        ...((body.input as readonly Record<string, any>[] | undefined) ?? []).flatMap(
            (item): readonly Record<string, any>[] =>
                item.type === "additional_tools" ? (item.tools ?? []) : [],
        ),
    ];
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.once("end", () => {
            resolve(body);
        });
        request.once("error", reject);
    });
}

function completeSse(response: ServerResponse): void {
    completeSseWith(response, [
        {
            type: "response.completed",
            response: { output: [], usage: { total_tokens: 1 } },
        },
    ]);
}

function completeSseWith(
    response: ServerResponse,
    events: readonly Record<string, unknown>[],
): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        events
            .flatMap((event) => [`event: ${event.type}`, `data: ${JSON.stringify(event)}`, ""])
            .concat("")
            .join("\n"),
    );
}
