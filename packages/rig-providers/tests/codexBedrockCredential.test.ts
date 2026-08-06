import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { CodexApiKeyCredential } from "@/vendors/codex/CodexApiKeyCredential.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSession } from "@/vendors/codex/CodexSession.js";
import { CODEX_API_ENDPOINT, CODEX_CHATGPT_ENDPOINT } from "@/vendors/codex/impl/codexConstants.js";
import { getCodexModelProperties } from "@/vendors/codex/impl/getCodexModelProperties.js";
import { codex_coding_agent_instructions } from "@/vendors/codex/prompts/codex_coding_agent_instructions.js";
import {
    context_checkpoint_compaction_instructions,
    context_checkpoint_summary_prefix,
} from "@/vendors/codex/prompts/context_checkpoint_compaction_instructions.js";
import { read_only_permissions } from "@/vendors/codex/prompts/read_only_permissions.js";
import { apply_patch } from "@/vendors/codex/tools/apply_patch.js";
import { exec_command } from "@/vendors/codex/tools/exec_command.js";
import { request_user_input } from "@/vendors/codex/tools/request_user_input.js";
import { tool_search } from "@/vendors/codex/tools/tool_search.js";
import { update_plan } from "@/vendors/codex/tools/update_plan.js";
import { view_image } from "@/vendors/codex/tools/view_image.js";
import { write_stdin } from "@/vendors/codex/tools/write_stdin.js";
import { withCodexSkills } from "@/vendors/codex/impl/withCodexSkills.js";
import { codexSkills } from "@/vendors/codex/skills/codexSkills.js";

describe("CodexProvider credential behavior", () => {
    it("keeps native Codex credentials on their matching endpoints and transport", async () => {
        const apiKey = await CodexApiKeyCredential.tryLoad({ apiKey: "codex-test-key" });
        expect(apiKey).not.toBeNull();

        const apiProvider = new CodexProvider({ credential: apiKey! });
        expect(apiProvider.endpoint).toBe(CODEX_API_ENDPOINT);
        expect(apiProvider.transport).toBe("auto");

        expect(
            () =>
                new CodexProvider({
                    credential: {
                        name: "codex-session",
                        credential: {
                            accessToken: "session-test-token",
                            accountId: "account-test-id",
                        },
                    } as never,
                }),
        ).not.toThrow();
        const sessionProvider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: {
                    accessToken: "session-test-token",
                    accountId: "account-test-id",
                },
            } as never,
        });
        expect(sessionProvider.endpoint).toBe(CODEX_CHATGPT_ENDPOINT);
        expect(sessionProvider.transport).toBe("auto");
    });

    it("selects regional Bedrock Mantle and SSE from a Bedrock credential", async () => {
        const credential = await BedrockBearerTokenCredential.tryLoad({
            bearerToken: "bedrock-test-token",
        });
        expect(credential).not.toBeNull();

        const provider = new CodexProvider({
            credential: credential!,
            region: "us-west-2",
            transport: "websocket",
        });

        expect(provider.endpoint).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1");
        expect(provider.transport).toBe("sse");
        for (const model of [
            "openai.gpt-5.5",
            "openai.gpt-5.6-sol",
            "openai.gpt-5.6-terra",
            "openai.gpt-5.6-luna",
        ]) {
            expect(getCodexModelProperties(model)).toMatchObject({
                compactionHash: "2911",
                responsesLite: false,
            });
        }
    });

    it.each(["server_error", "invalid_prompt"])(
        "retries a Bedrock %s response failure before surfacing it",
        async (failureCode) => {
            let requests = 0;
            const server = createServer(async (request, response) => {
                for await (const _chunk of request) {
                    // Drain the request before answering.
                }
                requests += 1;
                if (requests === 1) {
                    response.writeHead(200, { "content-type": "text/event-stream" });
                    response.end(
                        `data: ${JSON.stringify({
                            type: "response.failed",
                            sequence_number: 1,
                            response: {
                                error: {
                                    code: failureCode,
                                    message:
                                        "The server had an error while processing your request. Sorry about that!",
                                },
                                incomplete_details: null,
                            },
                        })}\n\ndata: [DONE]\n\n`,
                    );
                    return;
                }
                completeTextSse(response, "recovered", 2);
            });
            await new Promise<void>((resolve, reject) => {
                server.listen(0, "127.0.0.1", resolve);
                server.once("error", reject);
            });
            const address = server.address();
            if (typeof address !== "object" || address === null)
                expect.fail("Missing server port.");
            const credential = await BedrockBearerTokenCredential.tryLoad({
                bearerToken: "bedrock-test-token",
            });

            try {
                const session = new CodexSession("bedrock-retry", {
                    credential: credential!,
                    endpoint: `http://127.0.0.1:${address.port}/openai/v1`,
                    installationId: "test-installation",
                    instructions: "instructions",
                    model: "openai.gpt-5.6-sol",
                    inferenceMaxRetries: 1,
                    transport: "sse",
                    userAgent: "rig-test",
                });
                const events = [];
                for await (const event of session.run({
                    context: { messages: [{ role: "user", content: "retry me" }] },
                })) {
                    events.push(event);
                }

                expect(events.map((event) => event.type)).toEqual([
                    "block_start",
                    "block_reset",
                    "retrying",
                    "block_start",
                    "token_usage",
                    "response_items",
                    "block_stop",
                    "done",
                ]);
                expect(events).toContainEqual(
                    expect.objectContaining({ type: "retrying", attempt: 1 }),
                );
                expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
                expect(requests).toBe(2);
                session.destroy();
            } finally {
                server.close();
            }
        },
    );

    it("retries a completed Bedrock response with zero output tokens", async () => {
        let requests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            requests += 1;
            if (requests === 1) {
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.end(
                    `data: ${JSON.stringify({
                        type: "response.completed",
                        response: {
                            id: "response-empty",
                            output: [],
                            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                        },
                    })}\n\ndata: [DONE]\n\n`,
                );
                return;
            }
            completeTextSse(response, "recovered", 2);
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");
        const credential = await BedrockBearerTokenCredential.tryLoad({
            bearerToken: "bedrock-test-token",
        });

        try {
            const session = new CodexSession("bedrock-empty-retry", {
                credential: credential!,
                endpoint: `http://127.0.0.1:${address.port}/openai/v1`,
                installationId: "test-installation",
                instructions: "instructions",
                model: "openai.gpt-5.6-sol",
                inferenceMaxRetries: 1,
                waitForInferenceRetry: async () => {},
                transport: "sse",
                userAgent: "rig-test",
            });
            const events = [];
            for await (const event of session.run({
                context: { messages: [{ role: "user", content: "retry empty output" }] },
            })) {
                events.push(event);
            }

            expect(requests).toBe(2);
            expect(events.map((event) => event.type)).toEqual([
                "block_start",
                "block_reset",
                "token_usage",
                "retrying",
                "block_start",
                "token_usage",
                "response_items",
                "block_stop",
                "done",
            ]);
            expect(events).toContainEqual({
                type: "retrying",
                attempt: 1,
                reason: "Codex returned a response with zero output tokens.",
            });
            expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
            session.destroy();
        } finally {
            server.close();
        }
    });

    it("keeps Bedrock failure diagnostics on an exhausted terminal response", async () => {
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                `data: ${JSON.stringify({
                    type: "response.failed",
                    sequence_number: 1,
                    response: {
                        id: "response-bedrock-terminal",
                        error: {
                            code: "server_error",
                            message: "Internal server error",
                        },
                        incomplete_details: null,
                    },
                })}\n\ndata: [DONE]\n\n`,
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");
        const credential = await BedrockBearerTokenCredential.tryLoad({
            bearerToken: "bedrock-test-token",
        });

        try {
            const session = new CodexSession("bedrock-terminal-failure", {
                credential: credential!,
                endpoint: `http://127.0.0.1:${address.port}/openai/v1`,
                installationId: "test-installation",
                instructions: "instructions",
                model: "openai.gpt-5.6-sol",
                inferenceMaxRetries: 0,
                transport: "sse",
                userAgent: "rig-test",
            });
            const events = [];
            for await (const event of session.run({
                context: { messages: [{ role: "user", content: "fail once" }] },
            })) {
                events.push(event);
            }

            expect(events.at(-1)).toEqual({
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "Internal server error",
                providerError: {
                    type: "internal_server_error",
                    diagnostics: {
                        attempts: 1,
                        code: "server_error",
                        errorType: "response.failed",
                        responseId: "response-bedrock-terminal",
                        upstreamMessage: "Internal server error",
                    },
                },
            });
            session.destroy();
        } finally {
            server.close();
        }
    });

    it("keeps the Bedrock HTTP status, code, request ID, and retry directive", async () => {
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            response.writeHead(424, {
                "content-type": "application/json",
                "x-amzn-requestid": "bedrock-request-424",
                "x-should-retry": "false",
            });
            response.end(
                JSON.stringify({
                    code: "model_backend_failure",
                    message: "Internal server error",
                }),
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");
        const credential = await BedrockBearerTokenCredential.tryLoad({
            bearerToken: "bedrock-test-token",
        });

        try {
            const session = new CodexSession("bedrock-http-failure", {
                credential: credential!,
                endpoint: `http://127.0.0.1:${address.port}/openai/v1`,
                installationId: "test-installation",
                instructions: "instructions",
                model: "openai.gpt-5.6-sol",
                inferenceMaxRetries: 5,
                transport: "sse",
                userAgent: "rig-test",
            });
            const events = [];
            for await (const event of session.run({
                context: { messages: [{ role: "user", content: "fail at HTTP" }] },
            })) {
                events.push(event);
            }

            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                kind: "internal_error",
                providerError: {
                    type: "internal_server_error",
                    diagnostics: {
                        attempts: 1,
                        code: "model_backend_failure",
                        requestId: "bedrock-request-424",
                        retryDirective: false,
                        status: 424,
                        upstreamMessage: expect.stringContaining("Internal server error"),
                    },
                },
            });
            expect(events.some((event) => event.type === "retrying")).toBe(false);
            session.destroy();
        } finally {
            server.close();
        }
    });

    it.each([
        ["openai.gpt-5.6-sol", "codex-bedrock-gpt-5-6-sol-low.sse.json"],
        ["openai.gpt-5.6-terra", "codex-bedrock-gpt-5-6-terra-low.sse.json"],
        ["openai.gpt-5.6-luna", "codex-bedrock-gpt-5-6-luna-low.sse.json"],
    ] as const)(
        "sends captured %s requests with Bedrock bearer auth and Mantle headers",
        async (model, fixtureName) => {
            const golden = JSON.parse(
                await readFile(
                    new URL(`./vendors/fixtures/${fixtureName}`, import.meta.url),
                    "utf8",
                ),
            ) as {
                http: { headers: Record<string, string> };
                request: Record<string, unknown>;
            };
            const environmentMessage = (
                golden.request.input as {
                    content?: { text?: string }[];
                    role?: string;
                }[]
            ).find((item) => item.role === "user")?.content?.[0]?.text;
            expect(environmentMessage).toBeDefined();
            const goldenToolSearch = (
                golden.request.tools as { type?: string; description?: string }[]
            ).find((tool) => tool.type === "tool_search");
            const goldenToolSearchDescription = goldenToolSearch?.description;
            if (goldenToolSearchDescription === undefined)
                expect.fail("Bedrock capture omitted the tool_search description.");
            let captured:
                | {
                      headers: Record<string, string | string[] | undefined>;
                      path: string | undefined;
                      payload: Record<string, unknown>;
                  }
                | undefined;
            const server = createServer(async (request, response) => {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                captured = {
                    headers: request.headers,
                    path: request.url,
                    payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                };
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.end(
                    'data: {"type":"response.completed","response":{"id":"bedrock-response","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
                );
            });
            await new Promise<void>((resolve, reject) => {
                server.listen(0, "127.0.0.1", resolve);
                server.once("error", reject);
            });
            const address = server.address();
            if (typeof address !== "object" || address === null)
                expect.fail("Missing server port.");
            const credential = await BedrockBearerTokenCredential.tryLoad({
                bearerToken: "bedrock-test-token",
            });

            try {
                const provider = new CodexProvider({
                    credential: credential!,
                    endpoint: `http://127.0.0.1:${address.port}/openai/v1`,
                    model,
                    userAgent: golden.http.headers["user-agent"]!,
                });
                const initialMessages = [
                    { role: "system" as const, content: read_only_permissions },
                    { role: "user" as const, content: environmentMessage! },
                ];
                const session = await provider.session("bedrock-session", {
                    instructions: codex_coding_agent_instructions,
                    tools: [
                        exec_command,
                        write_stdin,
                        update_plan,
                        request_user_input,
                        apply_patch,
                        view_image,
                        { ...tool_search, description: goldenToolSearchDescription },
                    ],
                });
                for await (const event of session.run({
                    context: {
                        messages: withCodexSkills(
                            {
                                instructions: codex_coding_agent_instructions,
                                messages: [
                                    ...initialMessages,
                                    { role: "user", content: "Reply with OK." },
                                ],
                            },
                            codexSkills,
                            model,
                        ).messages,
                    },
                    effort: "low",
                })) {
                    if (event.type === "done") expect(event.state).toBe("normal");
                }

                expect(captured?.path).toBe("/openai/v1/responses");
                expect(captured?.headers.authorization).toBe("Bearer bedrock-test-token");
                expect(captured?.headers["x-amzn-mantle-client-agent"]).toBe("codex");
                expect(captured?.headers["x-codex-beta-features"]).toBe("remote_compaction_v2");
                expect(captured?.headers.originator).toBe("codex_exec");
                expect(captured?.headers["user-agent"]).toBe(golden.http.headers["user-agent"]);
                expect(normalizePayload(captured!.payload)).toEqual(
                    normalizePayload(golden.request),
                );
                expect(session.transport).toBe("sse");
                session.destroy();
            } finally {
                server.close();
            }
        },
    );

    it("uses local Bedrock compaction and replaces prior synthetic summaries", async () => {
        const captured: Record<string, any>[] = [];
        let normalResponseCount = 0;
        let compactionCount = 0;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            captured.push(body);
            const isCompaction = body.input.some(
                (item: any) =>
                    Array.isArray(item.content) &&
                    item.content.some(
                        (content: any) =>
                            content.text === context_checkpoint_compaction_instructions,
                    ),
            );
            if (isCompaction) {
                compactionCount += 1;
                completeTextSse(response, `summary-${compactionCount}`, 2);
            } else {
                normalResponseCount += 1;
                completeTextSse(
                    response,
                    `reply-${normalResponseCount}`,
                    normalResponseCount === 1 ? 250_000 : 2,
                );
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");
        const credential = await BedrockBearerTokenCredential.tryLoad({
            bearerToken: "bedrock-test-token",
        });

        try {
            const session = await new CodexProvider({
                credential: credential!,
                endpoint: `http://127.0.0.1:${address.port}/openai/v1`,
                model: "openai.gpt-5.6-sol",
            }).session("bedrock-compaction", {
                instructions: "instructions",
            });
            await drain(
                session.run({
                    context: { messages: [{ role: "user", content: "first" }] },
                }),
            );
            await drain(
                session.run({
                    context: {
                        messages: [
                            { role: "user", content: "first" },
                            { role: "assistant", content: "reply-1" },
                            { role: "user", content: "second" },
                        ],
                    },
                }),
            );
            const compacted = await session.compact();
            if (compacted.status !== "completed") expect.fail("Compaction failed.");

            expect(captured).toHaveLength(3);
            const secondTurnMetadata = turnMetadata(captured[1]!);
            const manualMetadata = turnMetadata(captured[2]!);
            expect(secondTurnMetadata.compaction).toBeUndefined();
            expect(manualMetadata.compaction).toEqual({
                trigger: "manual",
                reason: "user_requested",
                implementation: "responses",
                phase: "standalone_turn",
                strategy: "memento",
            });
            expect(secondTurnMetadata.turn_id).not.toBe(turnMetadata(captured[0]!).turn_id);
            expect(manualMetadata.turn_id).not.toBe(secondTurnMetadata.turn_id);
            expect(captured[1]!.input).not.toContainEqual({ type: "compaction_trigger" });
            expect(captured[2]!.input).not.toContainEqual({ type: "compaction_trigger" });
            expect(captured[1]!.input).not.toContainEqual(
                expect.objectContaining({
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: context_checkpoint_compaction_instructions,
                        },
                    ],
                }),
            );
            expect(captured[2]!.input).toContainEqual(
                expect.objectContaining({
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: context_checkpoint_compaction_instructions,
                        },
                    ],
                }),
            );
            expect(compacted.preservedMessages).toEqual([
                { role: "user", content: "first" },
                { role: "user", content: "second" },
            ]);
            expect(
                compacted.context.messages.filter(
                    (message) =>
                        message.role === "user" &&
                        message.content.startsWith(`${context_checkpoint_summary_prefix}\n`),
                ),
            ).toHaveLength(1);
            expect(JSON.stringify(compacted.context)).toContain("summary-1");
            session.destroy();
        } finally {
            server.close();
        }
    });
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _event of stream) {
        // Drain the mocked response.
    }
}

function turnMetadata(request: Record<string, any>): Record<string, any> {
    return JSON.parse(request.client_metadata["x-codex-turn-metadata"]);
}

function completeTextSse(
    response: import("node:http").ServerResponse,
    text: string,
    total: number,
) {
    const item = {
        id: `message-${text}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        [
            { type: "response.output_item.done", output_index: 0, item },
            {
                type: "response.completed",
                response: {
                    id: `response-${text}`,
                    output: [item],
                    usage: { input_tokens: total - 1, output_tokens: 1, total_tokens: total },
                },
            },
        ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
    );
}

function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const normalized = structuredClone(payload);
    normalized.prompt_cache_key = "<SESSION_ID>";
    if (typeof normalized.client_metadata === "object" && normalized.client_metadata !== null) {
        normalized.client_metadata = Object.fromEntries(
            Object.keys(normalized.client_metadata).map((key) => [key, `<DYNAMIC:${key}>`]),
        );
    }
    for (const item of normalized.input as { content?: { text?: string }[] }[]) {
        for (const content of item.content ?? []) {
            if (typeof content.text === "string") {
                content.text = content.text.replaceAll(
                    "/private<CAPTURE_DIRECTORY>/codex-home/",
                    "/private<CAPTURE_DIRECTORY>/",
                );
            }
        }
    }
    return normalized;
}
