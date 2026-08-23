import { testContext, testContextWith } from "../testContext.js";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { formatGrokCompactionSummary } from "@/vendors/grok/impl/grokCompaction.js";
import { grok_compaction_prompt } from "@/vendors/grok/prompts/grok_compaction_prompt.js";

vi.mock("@/vendors/grok/impl/waitForGrokCompactionRetry.js", () => ({
    waitForGrokCompactionRetry: () => Promise.resolve(),
}));

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
        server.closeAllConnections();
    }
});

describe("Grok compaction behavior", () => {
    it("uses the active model configuration for inference and compaction", async () => {
        const requests: Record<string, any>[] = [];
        const endpoint = await serve((request, response, index) => {
            requests.push(JSON.parse(request));
            completeText(
                response,
                index === 0
                    ? "switched response"
                    : `<summary>${"configured summary ".repeat(50)}</summary>`,
            );
        });
        const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test" });
        if (credential === null) throw new Error("Missing test credential.");
        const provider = new GrokProvider({ credential, endpoint });
        const session = await provider.session("session", {
            instructions: "Base prompt.",
            modelConfigurations: {
                "grok-switched": {
                    instructions: "Switched prompt.",
                    tools: [
                        {
                            name: "switched_tool",
                            description: "Switched tool.",
                            parameters: Type.Object({ value: Type.String() }),
                        },
                    ],
                },
            },
        });

        for await (const _event of session.run(testContext, {
            model: "grok-switched",
            context: {
                instructions: "",
                messages: [
                    {
                        role: "system",
                        content: [{ type: "text" as const, text: "Switched system message." }],
                    },
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Switch." }],
                    },
                ],
            },
        })) {
            // Drain the response.
        }
        const compacted = await session.compact(testContext, {
            context: {
                instructions: "Base prompt.",
                messages: [
                    {
                        role: "system",
                        content: [{ type: "text" as const, text: "Switched system message." }],
                    },
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Switch." }],
                    },
                    {
                        role: "assistant",
                        content: [{ type: "text" as const, text: "switched response" }],
                    },
                ],
            },
        });

        expect(compacted.status).toBe("completed");
        expect(requests.map((request) => request.model)).toEqual([
            "grok-switched",
            "grok-switched",
        ]);
        for (const request of requests) {
            expect(JSON.stringify(request.input)).toContain("Switched prompt.");
            expect(JSON.stringify(request.input)).toContain("Switched system message.");
            expect(request.tools).toEqual([
                expect.objectContaining({ type: "function", name: "switched_tool" }),
            ]);
        }
    });

    it("includes the immediately preceding assistant response in compaction", async () => {
        const requests: Record<string, unknown>[] = [];
        const endpoint = await serve((request, response, index) => {
            requests.push(JSON.parse(request));
            if (index === 0) {
                completeText(response, "assistant-only-marker");
            } else {
                completeText(response, `<summary>${"valid summary ".repeat(50)}</summary>`);
            }
        });
        const session = await createSession(endpoint);

        const runEvents = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                ],
            },
        })) {
            runEvents.push(event);
        }
        const result = await session.compact(testContext, {
            context: {
                instructions: "System prompt.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                    {
                        role: "assistant",
                        content: [{ type: "text" as const, text: "assistant-only-marker" }],
                    },
                ],
            },
        });

        expect(result.status).toBe("completed");
        expect(requests[1]).not.toHaveProperty("tool_choice");
        expect(assistantMessageFromEvents(runEvents)).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "assistant-only-marker" }],
        });
        const compactionInput = requests[1]?.input as Array<{ content?: string }>;
        expect(JSON.stringify(compactionInput)).toContain("assistant-only-marker");
    });

    it("resets partial output and emits cancelled when a run is aborted", async () => {
        const endpoint = await serve((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            sendMessageStart(response);
            send(response, {
                type: "response.output_text.delta",
                output_index: 0,
                delta: "partial",
            });
        });
        const session = await createSession(endpoint);
        const controller = new AbortController();
        const events = [];
        for await (const event of session.run(testContextWith(controller.signal), {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                ],
            },
        })) {
            events.push(event);
            if (event.type === "text_delta") controller.abort();
        }

        expect(events.map((event) => event.type)).toEqual([
            "block_start",
            "text_start",
            "text_delta",
            "block_reset",
            "done",
        ]);
        expect(events.at(-1)).toEqual({ type: "done", state: "cancelled" });
    });

    it("resamples a transient compaction HTTP failure", async () => {
        const endpoint = await serve((_request, response, index) => {
            if (index === 0) {
                response.writeHead(408, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "request timeout" } }));
                return;
            }
            completeText(response, `<summary>${"valid summary ".repeat(50)}</summary>`);
        });
        const session = await createSession(endpoint);

        const result = await session.compact(testContext, {
            context: {
                instructions: "System prompt.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                ],
            },
        });

        expect(result.status).toBe("completed");
    });

    it("keeps the original context active after rejecting a degenerate summary", async () => {
        const requests: Record<string, unknown>[] = [];
        const endpoint = await serve((request, response, index) => {
            requests.push(JSON.parse(request));
            if (index < 3) {
                completeText(response, "<summary>Too short.</summary>");
            } else {
                completeText(response, "follow-up ok");
            }
        });
        const original = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Keep this original request." }],
        };
        const session = await createSession(endpoint);

        await expect(
            session.compact(testContext, {
                context: {
                    instructions: "System prompt.",
                    messages: [original],
                },
            }),
        ).resolves.toEqual({
            status: "failed",
            kind: "invalid_summary",
            message: "Grok returned three compaction summaries shorter than 500 characters.",
        });
        for await (const _event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Follow up." }],
                    },
                ],
            },
        })) {
            // Drain the response.
        }

        const secondInput = requests[3]?.input as Array<{ content?: string }>;
        expect(secondInput.some((item) => item.content === original.content[0]!.text)).toBe(false);
        expect(secondInput.some((item) => item.content === grok_compaction_prompt)).toBe(false);
    });

    it("rejects tool output during compaction without changing context", async () => {
        const endpoint = await serve((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            sendMessageStart(response);
            send(response, {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                    type: "function_call",
                    id: "function-1",
                    call_id: "call-1",
                    name: "read_file",
                    arguments: "",
                    status: "in_progress",
                },
            });
            send(response, {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "function-1",
                delta: '{"target_file":"README.md"}',
            });
            send(response, {
                type: "response.completed",
                response: {
                    id: "response",
                    output: [],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            });
            response.end("data: [DONE]\n\n");
        });
        const session = await createSession(endpoint);

        const result = await session.compact(testContext, {
            context: {
                instructions: "System prompt.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                ],
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            kind: "tool_call",
            message: "Grok emitted tool calls in three compaction attempts.",
        });
    });

    it("resamples a degenerate draft and commits the first valid summary", async () => {
        let requests = 0;
        const endpoint = await serve((_request, response) => {
            requests += 1;
            completeText(
                response,
                requests === 1
                    ? "<summary>Too short.</summary>"
                    : `<summary>${"valid summary ".repeat(50)}</summary>`,
            );
        });
        const session = await createSession(endpoint);

        const result = await session.compact(testContext, {
            context: {
                instructions: "System prompt.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                ],
            },
        });

        expect(requests).toBe(2);
        expect(result.status).toBe("completed");
    });

    it("discards a partial summary before retrying the compaction sample", async () => {
        const endpoint = await serve((_request, response, index) => {
            if (index === 0) {
                response.writeHead(200, { "content-type": "text/event-stream" });
                sendMessageStart(response);
                send(response, {
                    type: "response.output_text.delta",
                    output_index: 0,
                    delta: "<summary>partial attempt that must be discarded",
                });
                response.end();
                return;
            }
            completeText(response, `<summary>${"winning summary ".repeat(50)}</summary>`);
        });
        const session = await createSession(endpoint);

        const result = await session.compact(testContext, {
            context: {
                instructions: "System prompt.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                ],
            },
        });

        expect(result.status).toBe("completed");
        if (result.status !== "completed") return;
        expect(result.summary).not.toContain("partial attempt");
        expect(result.summary).toContain("winning summary");
    });

    it("includes user compaction context and repositions the existing reminder", async () => {
        let requestBody: Record<string, unknown> | undefined;
        const endpoint = await serve((request, response) => {
            requestBody = JSON.parse(request);
            completeText(response, `<summary>${"valid summary ".repeat(50)}</summary>`);
        });
        const session = await createSession(endpoint);
        const result = await session.compact(testContext, {
            instructions: "Preserve the database migration decision.",
            context: {
                instructions: "System prompt.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text" as const,
                                text: "<system-reminder>Stale state.</system-reminder>",
                            },
                        ],
                    },
                ],
            },
        });

        expect(result.status).toBe("completed");
        const input = requestBody?.input as Array<{ content?: string }>;
        expect(input.at(-1)?.content).toContain(
            "**User-provided context for this compaction:**\n" +
                "Preserve the database migration decision.",
        );
        if (result.status !== "completed") return;
        expect(result.context.messages.at(-1)).toEqual({
            role: "user",
            content: [{ type: "text", text: "<system-reminder>Stale state.</system-reminder>" }],
        });
    });

    it("accepts a non-degenerate summary truncated at the output limit", async () => {
        const endpoint = await serve((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            sendMessageStart(response);
            send(response, {
                type: "response.output_text.delta",
                output_index: 0,
                delta: `<summary>${"valid summary ".repeat(50)}</summary>`,
            });
            send(response, {
                type: "response.incomplete",
                response: {
                    incomplete_details: { reason: "max_output_tokens" },
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            });
            response.end("data: [DONE]\n\n");
        });
        const session = await createSession(endpoint);

        const result = await session.compact(testContext, {
            context: {
                instructions: "System prompt.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Original query." }],
                    },
                ],
            },
        });

        expect(result.status).toBe("completed");
    });

    it("cancels an in-flight compaction without committing temporary history", async () => {
        let resolveStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        const requests: Record<string, unknown>[] = [];
        const endpoint = await serve((request, response, index) => {
            requests.push(JSON.parse(request));
            if (index === 0) {
                response.writeHead(200, { "content-type": "text/event-stream" });
                send(response, {
                    type: "response.reasoning_summary_text.delta",
                    output_index: 0,
                    delta: "draft",
                });
                resolveStarted?.();
            } else {
                completeText(response, "follow-up ok");
            }
        });
        const original = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Original query." }],
        };
        const session = await createSession(endpoint);
        const controller = new AbortController();

        const compaction = session.compact(testContextWith(controller.signal), {
            context: {
                instructions: "System prompt.",
                messages: [original],
            },
        });
        await started;
        controller.abort();

        await expect(compaction).resolves.toEqual({
            status: "cancelled",
            context: {
                instructions: "System prompt.",
                messages: [original],
            },
        });
        for await (const _event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Follow up." }],
                    },
                ],
            },
        })) {
            // Drain the response.
        }
        const secondInput = requests[1]?.input as Array<{ content?: string }>;
        expect(secondInput.some((item) => item.content === original.content[0]!.text)).toBe(false);
        expect(secondInput.some((item) => item.content === grok_compaction_prompt)).toBe(false);
    });

    it("matches Grok summary cleanup for analysis, fences, and control tokens", () => {
        expect(
            formatGrokCompactionSummary(
                "<analysis>draft</analysis><summary>1. Primary\n\n\nDone.</summary>",
            ),
        ).toBe("Summary:\n1. Primary\n\nDone.");
        expect(
            formatGrokCompactionSummary(
                "```xml\n<summary>Analysis\n</analysis>\n1. Primary\n" +
                    "Quoted <summary> token.</summary>\n```",
            ),
        ).toBe("```xml\nSummary:\n1. Primary\nQuoted <\u200bsummary> token.\n```");
    });

    it("keeps one turn index across a tool loop and increments on the next user prompt", async () => {
        const turnIndexes: Array<string | undefined> = [];
        const endpoint = await serve((_body, response, index, request) => {
            turnIndexes.push(request.headers["x-grok-turn-idx"] as string | undefined);
            if (index === 0) {
                response.writeHead(200, { "content-type": "text/event-stream" });
                send(response, {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "function_call",
                        id: "function-1",
                        call_id: "call-1",
                        name: "read_file",
                        arguments: "",
                        status: "in_progress",
                    },
                });
                send(response, {
                    type: "response.function_call_arguments.delta",
                    output_index: 0,
                    item_id: "function-1",
                    delta: '{"target_file":"README.md"}',
                });
                send(response, {
                    type: "response.completed",
                    response: {
                        id: "response",
                        output: [],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                });
                response.end("data: [DONE]\n\n");
            } else {
                completeText(response, "done");
            }
        });
        const session = await createSession(endpoint);
        const firstUser = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Inspect README." }],
        };
        const toolAssistant = {
            role: "assistant" as const,
            content: [
                {
                    type: "tool_call" as const,
                    callId: "call-1",
                    name: "read_file",
                    arguments: '{"target_file":"README.md"}',
                    vendor: { providerCallId: "call-1" },
                },
            ],
        };
        const toolResult = {
            role: "tool" as const,
            callId: "call-1",
            content: [{ type: "text" as const, text: "README contents" }],
        };

        for await (const _event of session.run(testContext, {
            context: { instructions: "", messages: [firstUser] },
        })) {
            // Drain.
        }
        for await (const _event of session.run(testContext, {
            context: { instructions: "", messages: [firstUser, toolAssistant, toolResult] },
        })) {
            // Drain.
        }
        for await (const _event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    firstUser,
                    toolAssistant,
                    toolResult,
                    {
                        role: "assistant",
                        content: [{ type: "text" as const, text: "README inspected." }],
                    },
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Now summarize it." }],
                    },
                ],
            },
        })) {
            // Drain.
        }

        expect(turnIndexes).toEqual(["1", "1", "2"]);
    });
});

async function createSession(endpoint: string) {
    const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test" });
    if (credential === null) throw new Error("Missing test credential.");
    const provider = new GrokProvider({ credential, endpoint, model: "grok-4.5" });
    return provider.session("session", {
        instructions: "System prompt.",
        tools: [],
    });
}

async function serve(
    handler: (
        body: string,
        response: ServerResponse,
        index: number,
        request: IncomingMessage,
    ) => void,
): Promise<string> {
    let index = 0;
    const server = createServer(async (request, response) => {
        handler(await readBody(request), response, index++, request);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port.");
    return `http://127.0.0.1:${address.port}/v1`;
}

function completeText(response: ServerResponse, text: string): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sendMessageStart(response);
    send(response, { type: "response.output_text.delta", output_index: 0, delta: text });
    send(response, {
        type: "response.output_item.done",
        output_index: 0,
        item: {
            type: "message",
            id: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
        },
    });
    send(response, {
        type: "response.completed",
        response: {
            id: "response",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
    });
    response.end("data: [DONE]\n\n");
}

function sendMessageStart(response: ServerResponse): void {
    send(response, {
        type: "response.output_item.added",
        output_index: 0,
        item: {
            type: "message",
            id: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
        },
    });
}

function send(response: ServerResponse, event: Record<string, unknown>): void {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.once("end", () => resolve(body));
        request.once("error", reject);
    });
}
