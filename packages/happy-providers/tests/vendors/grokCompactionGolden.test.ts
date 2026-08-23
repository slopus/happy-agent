import { testContext } from "../testContext.js";

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import type { SessionContext, SessionMessage } from "@/core/SessionContext.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { createGrokCompactionContinuation } from "@/vendors/grok/impl/grokCompaction.js";
import { grok_compaction_prompt } from "@/vendors/grok/prompts/grok_compaction_prompt.js";
import { grok_4_5_tools } from "@/vendors/grok/tools/index.js";

interface TraceExchange {
    kind: string;
    http: { headers: Record<string, string> };
    request: {
        model: string;
        input: TraceInput[];
        tools: Array<{ type: string; name: string }>;
    };
    response: {
        status: number;
        events: Array<Record<string, unknown>>;
    };
}

interface TraceInput {
    type: string;
    role?: string;
    content?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: string;
    encrypted_content?: string;
}

interface CompactionTrace {
    source: { client: string; version: string };
    scenario: { command: string; turnPrompts: string[]; followUpPrompt: string };
    exchanges: TraceExchange[];
}

const fixturePath = new URL("./fixtures/grok-4-5-compaction.sse.json", import.meta.url);

describe("Grok CLI compaction golden trace", () => {
    it("captures the real unnumbered compaction inference and its SSE response", async () => {
        const trace = await readTrace();
        const compactions = trace.exchanges.filter((exchange) => exchange.kind === "compaction");

        expect(trace.source).toEqual({
            client: "grok-cli",
            version: "grok 0.2.111 (94172f2aa4e5) [stable]",
        });
        expect(trace.scenario.command).toBe("/compact");
        expect(compactions).toHaveLength(1);
        expect(compactions[0]?.http.headers["x-grok-turn-idx"]).toBeUndefined();
        expect(compactions[0]?.response.status).toBe(200);
        expect(compactions[0]?.request.model).toBe("grok-4.5");
        expect(compactions[0]?.request.tools).toHaveLength(26);
        expect(
            compactions[0]?.response.events.some((event) => event.type === "response.completed"),
        ).toBe(true);
    });

    it("uses the exact CLI compaction prompt and continuation structure", async () => {
        const trace = await readTrace();
        const compaction = trace.exchanges.find((exchange) => exchange.kind === "compaction");
        const postCompaction = trace.exchanges.find(
            (exchange) => exchange.kind === "post_compaction",
        );
        const prompt = compaction?.request.input.at(-1)?.content;
        const summaryEvent = compaction?.response.events.find(
            (event) => event.type === "response.output_text.done",
        );
        const summary = typeof summaryEvent?.text === "string" ? summaryEvent.text : "";
        const continuation = postCompaction?.request.input.find(
            (item) =>
                item.role === "user" &&
                item.content?.startsWith("This session is being continued") === true,
        );

        expect(prompt).toBe(grok_compaction_prompt);
        expect(summary).toContain("<summary>");
        expect(summary).toContain("</summary>");
        expect(continuation?.content).toContain(createGrokCompactionContinuation(summary));
        expect(postCompaction?.request.input.some((item) => item.role === "assistant")).toBe(false);
    });

    it("supplies every prior turn to summarization but preserves only the last real query", async () => {
        const trace = await readTrace();
        const compaction = trace.exchanges.find((exchange) => exchange.kind === "compaction");
        const postCompaction = trace.exchanges.find(
            (exchange) => exchange.kind === "post_compaction",
        );
        const compactionText = messageText(compaction);
        const postCompactionText = messageText(postCompaction);
        const preservedQueries =
            postCompaction?.request.input
                .filter(
                    (item) =>
                        item.role === "user" &&
                        item.content?.startsWith("<user_query>") === true &&
                        item.content !==
                            `<user_query>\n${trace.scenario.followUpPrompt}\n</user_query>`,
                )
                .map((item) => item.content ?? "") ?? [];

        expect(trace.scenario.turnPrompts).toHaveLength(4);
        for (const [label, command] of [
            ["ALPHA", "pnpm test"],
            ["BETA", "pnpm check"],
            ["GAMMA", "pnpm build"],
            ["DELTA", "git diff --check"],
        ]) {
            expect(compactionText).toContain(`Checkpoint ${label}`);
            expect(compactionText).toContain(command);
            expect(compactionText).toContain(`${label}_ACK`);
        }
        expect(compaction?.request.input.at(-1)?.content).toBe(grok_compaction_prompt);

        expect(preservedQueries).toHaveLength(1);
        expect(preservedQueries[0]).not.toContain("Checkpoint ALPHA:");
        expect(preservedQueries[0]).not.toContain("Checkpoint BETA:");
        expect(preservedQueries[0]).not.toContain("Checkpoint GAMMA:");
        expect(preservedQueries[0]).toContain("Checkpoint DELTA:");
        expect(postCompactionText).toContain("ALPHA");
        expect(postCompactionText).toContain("pnpm test");
        expect(postCompactionText).toContain(trace.scenario.followUpPrompt);
    });

    it("makes GrokSession emit the captured compaction request contract", async () => {
        const trace = await readTrace();
        const golden = trace.exchanges.find((exchange) => exchange.kind === "compaction");
        const goldenPost = trace.exchanges.find((exchange) => exchange.kind === "post_compaction");
        if (golden === undefined) throw new Error("Missing compaction exchange.");
        if (goldenPost === undefined) throw new Error("Missing post-compaction exchange.");
        const capturedBodies: Record<string, unknown>[] = [];
        const capturedHeaders: IncomingMessage["headers"][] = [];
        const server = createServer(async (request, response) => {
            capturedHeaders.push(request.headers);
            capturedBodies.push(JSON.parse(await readBody(request)));
            const exchange = capturedBodies.length === 1 ? golden : goldenPost;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                exchange.response.events
                    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join("") + "data: [DONE]\n\n",
            );
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const context = contextFromCompactionInput(golden.request.input);
            const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test" });
            if (credential === null) throw new Error("Missing test credential.");
            const provider = new GrokProvider({
                credential,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                model: "grok-4.5",
            });
            const session = await provider.session("<SESSION_ID>", {
                instructions: context.instructions,
                tools: grok_4_5_tools,
            });
            const result = await session.compact(testContext, {
                context: {
                    instructions: context.instructions,
                    messages: context.messages,
                },
            });

            expect(result.status).toBe("completed");
            expect(capturedHeaders[0]?.["x-grok-turn-idx"]).toBeUndefined();
            expect(requestProjection(capturedBodies[0]!)).toEqual(
                requestProjection(golden.request),
            );
            if (result.status !== "completed") return;
            expect(result.context.messages.map((message) => message.role)).toEqual([
                "user",
                "user",
                "user",
                "user",
            ]);
            expect(result.preservedMessages).toHaveLength(2);
            const checkpoint = result.preservedMessages[1];
            if (checkpoint?.role !== "user") throw new Error("Expected a user checkpoint.");
            expect(messageContentText(checkpoint.content)).toContain("Checkpoint DELTA:");
            const continuation = result.context.messages[2];
            const reminder = result.context.messages[3];
            if (continuation?.role !== "user" || reminder?.role !== "user") {
                throw new Error("Expected user compaction messages.");
            }
            expect(messageContentText(continuation.content)).toContain(
                "This session is being continued",
            );
            expect(messageContentText(reminder.content)).toContain("<system-reminder>");

            for await (const _event of session.run(testContext, {
                context: {
                    instructions: result.context.instructions,
                    messages: [
                        ...result.context.messages,
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: `<user_query>\n${trace.scenario.followUpPrompt}\n</user_query>`,
                                },
                            ],
                        },
                    ],
                },
            })) {
                // Drain the first post-compaction response.
            }
            const postInput = capturedBodies[1]?.input as TraceInput[];
            const goldenPostInput = goldenPost.request.input;
            expect(postInput.map((item) => [item.type, item.role])).toEqual(
                goldenPostInput.map((item) => [item.type, item.role]),
            );
            expect(postInput[0]?.content).toBe(goldenPostInput[0]?.content);
            expect(postInput[1]?.content).toBe(goldenPostInput[1]?.content);
            expect(postInput[2]?.content).toBe(goldenPostInput[2]?.content);
            expect(goldenPostInput[3]?.content).toContain(postInput[3]?.content);
            expect(postInput[4]?.content).toMatch(/^<system-reminder>/u);
            expect(postInput[5]?.content).toBe(goldenPostInput[5]?.content);
        } finally {
            server.close();
            server.closeAllConnections();
        }
    });
});

async function readTrace(): Promise<CompactionTrace> {
    return JSON.parse(await readFile(fixturePath, "utf8")) as CompactionTrace;
}

function messageText(exchange: TraceExchange | undefined): string {
    return (
        exchange?.request.input
            .filter((item) => item.type === "message")
            .map((item) => item.content ?? "")
            .join("\n") ?? ""
    );
}

function messageContentText(content: readonly { type: string; text?: string }[]): string {
    return content
        .filter((block) => block.type === "text" && block.text !== undefined)
        .map((block) => block.text!)
        .join("");
}

function contextFromCompactionInput(input: TraceInput[]): SessionContext {
    const instructions = input[0]?.content;
    if (typeof instructions !== "string") throw new Error("Missing system instructions.");
    const messages: SessionMessage[] = [];
    let reasoning: TraceInput | undefined;
    for (const item of input.slice(1, -1)) {
        if (item.type === "reasoning") {
            reasoning = item;
        } else if (item.type === "message" && item.role === "user") {
            messages.push({
                role: "user",
                content: [{ type: "text" as const, text: item.content ?? "" }],
            });
        } else if (item.type === "message" && item.role === "assistant") {
            messages.push({
                role: "assistant",
                content: [
                    ...(reasoning === undefined
                        ? []
                        : [
                              {
                                  type: "reasoning" as const,
                                  reasoning: JSON.stringify(reasoning),
                              },
                          ]),
                    { type: "text" as const, text: item.content ?? "" },
                ],
            });
            reasoning = undefined;
        } else if (item.type === "function_call") {
            messages.push({
                role: "assistant",
                content: [
                    ...(reasoning === undefined
                        ? []
                        : [
                              {
                                  type: "reasoning" as const,
                                  reasoning: JSON.stringify(reasoning),
                              },
                          ]),
                    ...[
                        {
                            callId: item.call_id ?? "",
                            name: item.name ?? "",
                            arguments: item.arguments ?? "",
                            vendor: {
                                provider: "grok",
                                type: "function_call",
                                providerCallId: item.call_id ?? "",
                            },
                        },
                    ].map((call) => ({
                        type: "tool_call" as const,
                        ...call,
                    })),
                ],
            });
            reasoning = undefined;
        } else if (item.type === "function_call_output") {
            messages.push({
                role: "tool",
                content: [{ type: "text" as const, text: item.output ?? "" }],
                callId: item.call_id ?? "",
                vendor: { provider: "grok", type: "function_call" },
            });
        }
    }
    return { instructions, messages };
}

function requestProjection(request: Record<string, unknown>): Record<string, unknown> {
    return {
        model: request.model,
        stream: request.stream,
        store: request.store,
        temperature: request.temperature,
        tool_choice: request.tool_choice,
        include: request.include,
        reasoning: request.reasoning,
        tools: request.tools,
        input: (request.input as TraceInput[]).map(inputProjection),
    };
}

function inputProjection(input: TraceInput): Record<string, unknown> {
    if (input.type === "message") {
        const content =
            typeof input.content === "string"
                ? input.content
                : (input.content as unknown as Array<{ text?: string }>)
                      .map((part) => part.text ?? "")
                      .join("");
        return { type: input.type, role: input.role, content };
    }
    return {
        type: input.type,
        ...(input.call_id === undefined ? {} : { call_id: input.call_id }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
        ...(input.output === undefined ? {} : { output: input.output }),
        ...(input.type === "reasoning"
            ? {
                  summary: (input as unknown as { summary: unknown }).summary,
                  encrypted_content: input.encrypted_content,
              }
            : {}),
    };
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
