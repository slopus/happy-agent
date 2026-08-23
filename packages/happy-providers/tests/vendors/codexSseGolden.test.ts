import { testContext } from "../testContext.js";

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { codexCliTools } from "./codexCliTools.js";
import { codexCliPrompt } from "./codexCliPrompt.js";
import { withCodexSkills } from "@/vendors/codex/impl/withCodexSkills.js";
import { codexSkills } from "@/vendors/codex/skills/codexSkills.js";

const cases = [
    ["gpt-5.5", "codex-gpt-5-5-low"],
    ["gpt-5.6-sol", "codex-gpt-5-6-sol-low"],
    ["gpt-5.6-terra", "codex-gpt-5-6-terra-low"],
    ["gpt-5.6-luna", "codex-gpt-5-6-luna-low"],
] as const;

describe("Codex SSE goldens", () => {
    it.each(cases)("sends the captured %s SSE tool contract", async (model, stem) => {
        const golden = await fixture(`${stem}.sse.json`);
        expect(golden.source.capture).toBe("forwarded-live-inference");
        expect(golden.response.terminal).toBe("response.completed");
        const prompt = codexCliPrompt(model, "sse");
        expect(promptEnvelope(golden.request, false)).toEqual(prompt);
        let captured: Record<string, any> | undefined;
        let capturedHeaders: IncomingMessage["headers"] | undefined;
        const server = createServer(async (request, response) => {
            captured = JSON.parse(await readBody(request));
            capturedHeaders = request.headers;
            completeSse(response, undefined, "OK.");
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const provider = new CodexProvider({
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                model,
                transport: "sse",
                userAgent: golden.http.headers["user-agent"]!,
            });
            const initialMessages = prompt.systemMessages.map((content) => ({
                role: "system" as const,
                content: content.map((text) => ({ type: "text" as const, text })),
            }));
            const session = await provider.session("<SESSION_ID>", {
                instructions: prompt.instructions,
                tools: codexCliTools(model),
            });
            const events = [];
            for await (const event of session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: withCodexSkills(
                        {
                            instructions: prompt.instructions,
                            messages: [
                                ...initialMessages,
                                {
                                    role: "user",
                                    content: [{ type: "text" as const, text: "Reply with OK." }],
                                },
                            ],
                        },
                        codexSkills,
                        model,
                    ).messages,
                },
                effort: "low",
            })) {
                events.push(event);
                if (event.type === "done") expect(event.state).toBe("normal");
            }
            session.destroy();

            expect(assistantMessageFromEvents(events)).toEqual({
                role: "assistant",
                content: [{ type: "text", text: "OK." }],
            });
            expect(captured).toBeDefined();
            expect(protocolProjection(captured!)).toEqual(protocolProjection(golden.request));
            expect(normalizeRequest(captured!)).toEqual(normalizeRequest(golden.request));
            expect(captured!.prompt_cache_key).toBe("<SESSION_ID>");
            expect(Object.keys(captured!.client_metadata).sort()).toEqual([
                "session_id",
                "thread_id",
                "turn_id",
                "x-codex-installation-id",
                "x-codex-turn-metadata",
                "x-codex-window-id",
            ]);
            expect(capturedHeaders?.["session-id"]).toBe("<SESSION_ID>");
            expect(capturedHeaders?.["thread-id"]).toBe("<SESSION_ID>");
            expect(capturedHeaders?.["x-codex-beta-features"]).toBe("remote_compaction_v2");
            expect(capturedHeaders?.originator).toBe(golden.http.headers.originator);
            expect(capturedHeaders?.["user-agent"]).toBe(golden.http.headers["user-agent"]);
            expect(capturedHeaders?.["x-codex-turn-metadata"]).toBe(
                captured!.client_metadata["x-codex-turn-metadata"],
            );
            expect(requestKind(captured!)).toBe("turn");
            expect(promptEnvelope(captured!)).toEqual(promptEnvelope(golden.request));
            expect(toolDefinitions(captured!)).toEqual(await fixture(`${stem}.sse.tools.json`));
            if (model.startsWith("gpt-5.6-")) {
                expect(captured!.tools).toBeUndefined();
                expect(captured!.input[0]).toMatchObject({
                    type: "additional_tools",
                    role: "developer",
                });
                expect(capturedHeaders?.["x-openai-internal-codex-responses-lite"]).toBe("true");
                expect(captured!.input[1]).toMatchObject({
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: prompt.instructions }],
                });
            } else {
                expect(captured!.tools).toBeDefined();
                expect(captured!.input.some((item: any) => item.type === "additional_tools")).toBe(
                    false,
                );
            }
        } finally {
            server.close();
        }
    });

    it("uses native compaction and rebuilds the switched model context from its opaque item", async () => {
        const golden = await fixture("codex-gpt-5-6-multiturn.sse.json");
        const prompt = codexCliPrompt("gpt-5.6-sol", "sse");
        const captured: Record<string, any>[] = [];
        const server = createServer(async (request, response) => {
            const body = JSON.parse(await readBody(request));
            captured.push(body);
            if (body.input.at(-1)?.type === "compaction_trigger") completeCompactionSse(response);
            else completeSse(response);
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const provider = new CodexProvider({
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                transport: "sse",
            });
            const session = await provider.session("<SESSION_ID>", {
                instructions: prompt.instructions,
                tools: codexCliTools("gpt-5.6-sol"),
            });
            await drain(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text" as const, text: "first" }],
                            },
                        ],
                    },
                    effort: "low",
                    model: "gpt-5.6-sol",
                }),
            );
            const compacted = await session.compact(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "first" }],
                        },
                        {
                            role: "assistant",
                            content: [{ type: "text", text: "mock response" }],
                        },
                    ],
                },
            });
            if (compacted.status !== "completed") expect.fail("Compaction was cancelled.");
            await drain(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            ...compacted.context.messages,
                            {
                                role: "user",
                                content: [{ type: "text" as const, text: "switched" }],
                            },
                        ],
                    },
                    effort: "low",
                    model: "gpt-5.6-terra",
                }),
            );

            expect(captured[1]!.previous_response_id).toBeUndefined();
            expect(captured[1]!.input.at(-1)).toEqual({ type: "compaction_trigger" });
            expect(requestKind(captured[1]!)).toBe("compaction");
            expect(turnMetadata(captured[1]!).compaction).toEqual({
                trigger: "manual",
                reason: "user_requested",
                implementation: "responses_compaction_v2",
                phase: "standalone_turn",
                strategy: "memento",
            });
            expect(turnMetadata(captured[1]!).turn_id).not.toBe(turnMetadata(captured[0]!).turn_id);
            expect(protocolProjection(captured[1]!)).toEqual(
                protocolProjection(golden.requests[2]),
            );
            expect(compacted.compaction).toEqual({
                role: "compaction",
                content: null,
                encryptedContent: "opaque-native-compaction",
            });
            expect(captured[1]!.client_metadata["x-codex-window-id"]).toBe(
                captured[0]!.client_metadata["x-codex-window-id"],
            );
            expect(captured[2]!.client_metadata["x-codex-window-id"]).not.toBe(
                captured[1]!.client_metadata["x-codex-window-id"],
            );
            expect(captured[2]!.previous_response_id).toBeUndefined();
            expect(captured[2]!.input).toContainEqual({
                type: "compaction",
                encrypted_content: "opaque-native-compaction",
            });
            expect(protocolProjection(captured[2]!)).toEqual(
                protocolProjection(golden.requests[3]),
            );
            session.destroy();
        } finally {
            server.close();
        }
    });

    it("normalizes the selected model when compaction is the first session operation", async () => {
        let captured: Record<string, any> | undefined;
        const server = createServer(async (request, response) => {
            captured = JSON.parse(await readBody(request));
            completeCompactionSse(response);
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const session = await new CodexProvider({
                credential: {
                    name: "codex-api-key",
                    credential: { apiKey: "test" },
                } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                transport: "sse",
            }).session("<SESSION_ID>", {
                instructions: "instructions",
            });

            const result = await session.compact(testContext, {
                context: {
                    instructions: "instructions",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Conversation to compact." }],
                        },
                    ],
                },
                model: "openai/gpt-5.6-sol",
            });

            expect(result.status).toBe("completed");
            expect(captured?.model).toBe("gpt-5.6-sol");
            session.destroy();
        } finally {
            server.close();
        }
    });

    it("fits huge tool output and retries a server context-window rejection", async () => {
        const captured: Record<string, any>[] = [];
        const server = createServer(async (request, response) => {
            captured.push(JSON.parse(await readBody(request)));
            if (captured.length === 1) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        error: { message: "Maximum context length was exceeded." },
                    }),
                );
                return;
            }
            completeCompactionSse(response);
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const session = await new CodexProvider({
                credential: {
                    name: "codex-api-key",
                    credential: { apiKey: "test" },
                } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                model: "gpt-5.6-sol",
                transport: "sse",
            }).session("<SESSION_ID>", {
                instructions: "instructions",
            });
            const initialMessages = [
                {
                    role: "assistant" as const,
                    content: [
                        {
                            type: "tool_call" as const,
                            callId: "huge-call",
                            name: "exec",
                            arguments: "{}",
                            vendor: {
                                provider: "codex",
                                type: "function_call",
                            },
                        },
                    ],
                },
                {
                    role: "tool" as const,
                    callId: "huge-call",
                    content: [{ type: "text" as const, text: "x".repeat(1_200_000) }],
                    vendor: {
                        provider: "codex",
                        type: "function_call",
                    },
                },
                {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: "retain this request" }],
                },
            ];
            const compacted = await session.compact(testContext, {
                context: {
                    instructions: "instructions",
                    messages: initialMessages,
                },
            });

            expect(compacted.status).toBe("completed");
            expect(captured).toHaveLength(2);
            for (const request of captured) {
                expect(request.input).toContainEqual({
                    type: "function_call_output",
                    call_id: "huge-call",
                    output: "Output exceeded the available model context and was truncated",
                });
                expect(JSON.stringify(request.input)).toContain("retain this request");
                expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(272_000 * 4);
            }
            session.destroy();
        } finally {
            server.close();
        }
    });

    it("switches compaction hashes without provider-owned compaction", async () => {
        const captured: Record<string, any>[] = [];
        const server = createServer(async (request, response) => {
            const body = JSON.parse(await readBody(request));
            captured.push(body);
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
            const provider = new CodexProvider({
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                transport: "sse",
            });
            const session = await provider.session("<SESSION_ID>", {
                instructions: "legacy instructions",
                modelConfigurations: {
                    "openai/gpt-5.5": {
                        instructions: "legacy instructions",
                        tools: codexCliTools("gpt-5.5"),
                    },
                    "openai/gpt-5.6-sol": {
                        instructions: "target instructions",
                        tools: codexCliTools("gpt-5.6-sol"),
                    },
                },
            });
            await drain(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "system",
                                content: [{ type: "text" as const, text: "legacy system" }],
                            },
                            {
                                role: "user",
                                content: [{ type: "text" as const, text: "first" }],
                            },
                        ],
                    },
                    model: "gpt-5.5",
                }),
            );
            await drain(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "system",
                                content: [{ type: "text" as const, text: "target system" }],
                            },
                            {
                                role: "user",
                                content: [{ type: "text" as const, text: "first" }],
                            },
                            {
                                role: "user",
                                content: [{ type: "text" as const, text: "switch" }],
                            },
                        ],
                    },
                    model: "gpt-5.6-sol",
                }),
            );

            expect(captured.map((request) => request.model)).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
            expect(turnMetadata(captured[1]!).compaction).toBeUndefined();
            expect(captured[1]!.input).not.toContainEqual({ type: "compaction_trigger" });
            expect(JSON.stringify(captured[1]!.input)).toContain("target instructions");
            expect(JSON.stringify(captured[1]!.input)).toContain("target system");
            expect(JSON.stringify(captured[1]!.input)).not.toContain("legacy system");
            expect(captured[1]!.input).toContainEqual(
                expect.objectContaining({ type: "additional_tools", role: "developer" }),
            );
            session.destroy();
        } finally {
            server.close();
        }
    });

    it("replays SSE turn state only within the same user turn", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "sse");
        const headers: IncomingMessage["headers"][] = [];
        const server = createServer(async (request, response) => {
            await readBody(request);
            headers.push(request.headers);
            completeSse(response, "sticky-turn");
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("Missing port.");

        try {
            const session = await new CodexProvider({
                credential: {
                    name: "codex-api-key",
                    credential: { apiKey: "test" },
                } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                model: "gpt-5.6-sol",
                transport: "sse",
            }).session("<SESSION_ID>", {
                instructions: prompt.instructions,
                tools: codexCliTools("gpt-5.6-sol"),
            });
            const user = {
                role: "user" as const,
                content: [{ type: "text" as const, text: "first" }],
            };
            await drain(
                session.run(testContext, {
                    context: { instructions: "", messages: [user] },
                    effort: "low",
                }),
            );
            await drain(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            user,
                            {
                                role: "assistant",
                                content: [{ type: "text" as const, text: "continuation" }],
                            },
                        ],
                    },
                    effort: "low",
                }),
            );
            await drain(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            user,
                            {
                                role: "assistant",
                                content: [{ type: "text" as const, text: "continuation" }],
                            },
                            {
                                role: "user",
                                content: [{ type: "text" as const, text: "second" }],
                            },
                        ],
                    },
                    effort: "low",
                }),
            );

            expect(headers[0]?.["x-codex-turn-state"]).toBeUndefined();
            expect(headers[1]?.["x-codex-turn-state"]).toBe("sticky-turn");
            expect(headers[2]?.["x-codex-turn-state"]).toBeUndefined();
            session.destroy();
        } finally {
            server.close();
        }
    });
});

async function fixture(name: string): Promise<any> {
    return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
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

function completeSse(response: ServerResponse, turnState?: string, finalText?: string): void {
    const finalItem =
        finalText === undefined
            ? undefined
            : {
                  id: "final-message",
                  type: "message",
                  role: "assistant",
                  phase: "final_answer",
                  status: "completed",
                  content: [{ type: "output_text", text: finalText, annotations: [] }],
              };
    response.writeHead(200, {
        "content-type": "text/event-stream",
        ...(turnState === undefined ? {} : { "x-codex-turn-state": turnState }),
    });
    response.end(
        [
            ...(finalItem === undefined
                ? []
                : [
                      {
                          type: "response.output_item.done",
                          output_index: 0,
                          item: finalItem,
                      },
                  ]),
            {
                type: "response.completed",
                response: {
                    id: "response",
                    output: finalItem === undefined ? [] : [finalItem],
                    usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
                },
            },
        ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
    );
}

function completeCompactionSse(response: ServerResponse): void {
    const item = {
        type: "compaction",
        encrypted_content: "opaque-native-compaction",
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        [
            {
                type: "response.output_item.added",
                output_index: 0,
                item,
            },
            {
                type: "response.output_item.done",
                output_index: 0,
                item,
            },
            {
                type: "response.completed",
                response: {
                    id: "compaction-response",
                    output: [item],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            },
        ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
    );
}

function protocolProjection(request: Record<string, any>): Record<string, unknown> {
    return {
        model: request.model,
        tool_choice: request.tool_choice,
        parallel_tool_calls: request.parallel_tool_calls,
        reasoning: request.reasoning,
        store: request.store,
        stream: request.stream,
        include: request.include,
        text: request.text,
        hasInstructions: request.instructions !== undefined,
        hasTopLevelTools: request.tools !== undefined,
        inputTypes: [...new Set((request.input ?? []).map((item: any) => item.type))],
    };
}

function normalizeRequest(request: Record<string, any>): Record<string, unknown> {
    const normalized = structuredClone(request);
    if (normalized.client_metadata !== undefined) {
        normalized.client_metadata = Object.fromEntries(
            Object.keys(normalized.client_metadata).map((key) => [key, `<DYNAMIC:${key}>`]),
        );
    }
    normalized.input = normalizeGoldenInput(normalized.input);
    return normalized;
}

function normalizeGoldenInput(input: unknown): unknown {
    if (!Array.isArray(input)) return input;
    return input
        .filter((item: any) => !isCapturedRuntimeContext(item))
        .map((item: any) => {
            if (item?.type !== "message" || typeof item.content !== "string") return item;
            return {
                ...item,
                content: [{ type: "input_text", text: item.content }],
            };
        });
}

function isCapturedRuntimeContext(item: any): boolean {
    if (item?.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) {
        return false;
    }
    return item.content.some(
        (content: any) =>
            typeof content?.text === "string" &&
            (content.text.startsWith("<recommended_plugins>") ||
                content.text.startsWith("<environment_context>")),
    );
}

function requestKind(request: Record<string, any>): unknown {
    return turnMetadata(request).request_kind;
}

function turnMetadata(request: Record<string, any>): Record<string, any> {
    return JSON.parse(request.client_metadata["x-codex-turn-metadata"]);
}

function toolDefinitions(request: Record<string, any>): unknown[] {
    if (Array.isArray(request.tools)) return request.tools;
    return request.input.find((item: any) => item.type === "additional_tools")?.tools ?? [];
}

function promptEnvelope(
    request: Record<string, any>,
    includeSkills = true,
): {
    instructions: string;
    systemMessages: string[][];
} {
    const systemMessages = (request.input ?? [])
        .filter((item: any) => item.type === "message" && item.role === "developer")
        .map((item: any) =>
            (typeof item.content === "string" ? [item.content] : (item.content ?? []))
                .map((content: any) => (typeof content === "string" ? content : content.text))
                .filter((text: unknown): text is string => typeof text === "string"),
        )
        .map((message: string[]) =>
            includeSkills
                ? message
                : message.filter((part) => !part.startsWith("<skills_instructions>")),
        )
        .filter((message: string[]) => message.length > 0);
    const topLevelInstructions =
        typeof request.instructions === "string" ? request.instructions : undefined;
    const developerInstructions =
        topLevelInstructions === undefined && systemMessages[0]?.[0]?.startsWith("You are Codex,")
            ? systemMessages.shift()?.[0]
            : undefined;
    const instructions = topLevelInstructions ?? developerInstructions;
    if (instructions === undefined) throw new Error("SSE capture omitted instructions.");
    return { instructions, systemMessages };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _event of stream) {
        // Drain the response.
    }
}
