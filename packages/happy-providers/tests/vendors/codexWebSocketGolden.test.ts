import { testContext, testContextWith } from "../testContext.js";

import { readFile } from "node:fs/promises";

import { WebSocketError } from "openai/resources/responses/internal-base";
import { beforeEach, describe, expect, it, vi } from "vitest";

const websocket = vi.hoisted(() => ({
    beforeOutputFailures: 0,
    closeBeforeSendOnce: false,
    closedConnectionsOnCreate: 0,
    connectionHeaders: [] as Record<string, string>[],
    emitCustomToolResponse: false,
    emitProductionShapeToolResponse: false,
    emptyCompletedOutput: false,
    expected101Once: false,
    failMidstreamOnce: false,
    midstreamFailures: 0,
    failToolCallMidstreamOnce: false,
    failTerminalOnce: false,
    holdWarmupOpenOnce: false,
    instances: [] as Array<{
        closeWithoutEvent: () => void;
        emitError: (error: Error) => void;
        errorListenerCount: () => number;
    }>,
    internalErrorFailures: 0,
    missingToolOutputCallId: undefined as string | undefined,
    missingPreviousResponseFailures: 0,
    endMidstreamOnce: false,
    emitTextResponses: false,
    unavailableOnce: false,
    usageTotalTokens: 0,
    turnState: undefined as string | undefined,
    sent: [] as Record<string, any>[],
}));
const sse = vi.hoisted(() => ({
    failures: 0,
    requests: [] as Record<string, any>[],
}));

vi.mock("@/vendors/codex/impl/createCodexClient.js", () => ({
    createCodexClient: () => ({
        responses: {
            create: (request: Record<string, any>) => ({
                withResponse: async () => {
                    sse.requests.push(structuredClone(request));
                    if (sse.failures > 0) {
                        sse.failures -= 1;
                        throw new Error("stream disconnected");
                    }
                    return {
                        data: (async function* () {
                            yield {
                                type: "response.completed",
                                response: {
                                    id: "sse-response",
                                    output: [],
                                    usage: {
                                        input_tokens: 0,
                                        output_tokens: 1,
                                        total_tokens: 1,
                                    },
                                },
                            };
                        })(),
                        response: new Response(),
                    };
                },
            }),
        },
    }),
}));

vi.mock("openai/resources/responses/ws", () => ({
    ResponsesWS: class MockResponsesWS {
        readonly socket = { readyState: 1 };
        private readonly errorListeners = new Set<(error: Error) => void>();
        private messages: any[] = [];
        private resolveNext: ((result: IteratorResult<any, undefined>) => void) | undefined;

        constructor(_client: unknown, options?: { headers?: Record<string, string> }) {
            if (websocket.closedConnectionsOnCreate > 0) {
                websocket.closedConnectionsOnCreate -= 1;
                this.socket.readyState = 3;
            }
            websocket.connectionHeaders.push(structuredClone(options?.headers ?? {}));
            websocket.instances.push({
                closeWithoutEvent: () => {
                    this.socket.readyState = 3;
                },
                emitError: (error) => this.emitError(error),
                errorListenerCount: () => this.errorListeners.size,
            });
        }

        emitError(error: Error): void {
            // Mirror the OpenAI SDK: unobserved errors become unhandled rejections.
            if (this.errorListeners.size === 0) {
                throw new Error("Mock SDK would create an unhandled WebSocket rejection.");
            }
            this.socket.readyState = 3;
            for (const listener of this.errorListeners) listener(error);
        }

        send(request: Record<string, any>): void {
            if (websocket.closeBeforeSendOnce) {
                websocket.closeBeforeSendOnce = false;
                this.socket.readyState = 3;
                const error = new (class WebSocketError extends Error {})(
                    "cannot send on a closed WebSocket",
                );
                if (this.errorListeners.size === 0) {
                    throw new Error("Mock SDK would create an unhandled WebSocket rejection.");
                }
                for (const listener of this.errorListeners) listener(error);
                return;
            }
            if (this.socket.readyState !== 1) throw new Error("cannot send on a closed WebSocket");
            websocket.sent.push(structuredClone(request));
            if (
                websocket.missingPreviousResponseFailures > 0 &&
                request.previous_response_id !== undefined
            ) {
                websocket.missingPreviousResponseFailures -= 1;
                const responseError = {
                    type: "invalid_request_error",
                    code: "previous_response_not_found",
                    message: `Previous response with id '${String(request.previous_response_id)}' not found.`,
                    param: "previous_response_id",
                };
                this.messages.push({
                    type: "error",
                    error: Object.assign(
                        new Error(
                            JSON.stringify({ type: "error", error: responseError, status: 400 }),
                        ),
                        { error: responseError, status: 400 },
                    ),
                });
                return;
            }
            if (websocket.missingToolOutputCallId !== undefined && request.generate !== false) {
                const callId = websocket.missingToolOutputCallId;
                websocket.missingToolOutputCallId = undefined;
                const responseError = {
                    type: "invalid_request_error",
                    code: null,
                    message: `No tool output found for custom tool call ${callId}.`,
                    param: "input",
                };
                this.messages.push({
                    type: "error",
                    error: Object.assign(
                        new WebSocketError(
                            JSON.stringify({ type: "error", error: responseError, status: 400 }),
                            {
                                type: "error",
                                code: "invalid_request_error",
                                message: responseError.message,
                                param: "input",
                                sequence_number: 1,
                            } as never,
                        ),
                        { error: responseError, status: 400 },
                    ),
                });
                return;
            }
            if (websocket.holdWarmupOpenOnce && request.generate === false) {
                websocket.holdWarmupOpenOnce = false;
                return;
            }
            if (websocket.turnState !== undefined && request.generate !== false) {
                this.messages.push({
                    type: "message",
                    message: {
                        type: "codex.response.metadata",
                        headers: { "x-codex-turn-state": websocket.turnState },
                    },
                });
            }
            if (websocket.beforeOutputFailures > 0 && request.generate !== false) {
                websocket.beforeOutputFailures -= 1;
                this.messages.push({
                    type: "error",
                    error: new Error("socket disconnected"),
                });
                return;
            }
            if (websocket.internalErrorFailures > 0 && request.generate !== false) {
                websocket.internalErrorFailures -= 1;
                const event = {
                    type: "error",
                    error: {
                        type: "internal_error",
                        code: "internal_error",
                        message: "Internal server error",
                        param: null,
                    },
                    sequence_number: 285,
                };
                this.messages.push({
                    type: "error",
                    error: new WebSocketError(JSON.stringify(event), event as never),
                });
                return;
            }
            if (websocket.failTerminalOnce && request.generate !== false) {
                websocket.failTerminalOnce = false;
                this.messages.push({
                    type: "error",
                    error: Object.assign(new Error("invalid request"), { status: 400 }),
                });
                return;
            }
            if (websocket.unavailableOnce && request.generate !== false) {
                websocket.unavailableOnce = false;
                this.messages.push({
                    type: "error",
                    error: Object.assign(new Error("not found"), { status: 404 }),
                });
                return;
            }
            if (websocket.expected101Once && request.generate !== false) {
                websocket.expected101Once = false;
                this.messages.push({
                    type: "error",
                    error: new Error(
                        "WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code",
                    ),
                });
                return;
            }
            if (websocket.endMidstreamOnce && request.generate !== false) {
                websocket.endMidstreamOnce = false;
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                            id: "partial-eof",
                            type: "message",
                            role: "assistant",
                            content: [],
                        },
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_text.delta",
                        output_index: 0,
                        content_index: 0,
                        item_id: "partial-eof",
                        delta: "partial eof",
                    },
                });
                this.messages.push({ type: "eof" });
                return;
            }
            if (websocket.failToolCallMidstreamOnce && request.generate !== false) {
                websocket.failToolCallMidstreamOnce = false;
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                            id: "partial-tool",
                            type: "function_call",
                            call_id: "call-1",
                            name: "exec",
                            arguments: "",
                        },
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.function_call_arguments.delta",
                        output_index: 0,
                        item_id: "partial-tool",
                        delta: '{"cmd":',
                    },
                });
                this.messages.push({ type: "error", error: new Error("socket disconnected") });
                return;
            }
            if (
                (websocket.failMidstreamOnce || websocket.midstreamFailures > 0) &&
                request.generate !== false
            ) {
                websocket.failMidstreamOnce = false;
                websocket.midstreamFailures = Math.max(0, websocket.midstreamFailures - 1);
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                            id: "partial",
                            type: "message",
                            role: "assistant",
                            content: [],
                        },
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_text.delta",
                        output_index: 0,
                        content_index: 0,
                        item_id: "partial",
                        delta: "partial",
                    },
                });
                this.messages.push({ type: "error", error: new Error("socket disconnected") });
                return;
            }
            const compactionItem = {
                type: "compaction",
                encrypted_content: "opaque-native-compaction",
            };
            const isCompaction = request.input?.at(-1)?.type === "compaction_trigger";
            const responseOutput = [];
            if (isCompaction) {
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: compactionItem,
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: compactionItem,
                    },
                });
                responseOutput.push(compactionItem);
            } else if (websocket.emitProductionShapeToolResponse && request.generate !== false) {
                websocket.emitProductionShapeToolResponse = false;
                const reasoningItem = {
                    id: "reasoning-item",
                    type: "reasoning",
                    encrypted_content: "opaque-reasoning",
                    summary: [],
                };
                const messageItem = {
                    id: "commentary-item",
                    type: "message",
                    role: "assistant",
                    phase: "commentary",
                    status: "completed",
                    content: [
                        {
                            type: "output_text",
                            text: "Checking.",
                            annotations: [],
                        },
                    ],
                };
                const toolItem = {
                    id: "function-tool-item",
                    type: "function_call",
                    status: "completed",
                    call_id: "function-call",
                    name: "exec_command",
                    arguments: '{"cmd":"true"}',
                };
                this.messages.push(
                    {
                        type: "message",
                        message: {
                            type: "response.output_item.added",
                            output_index: 0,
                            item: reasoningItem,
                        },
                    },
                    {
                        type: "message",
                        message: {
                            type: "response.output_item.done",
                            output_index: 0,
                            item: reasoningItem,
                        },
                    },
                    {
                        type: "message",
                        message: {
                            type: "response.output_item.added",
                            output_index: 1,
                            item: { ...messageItem, content: [] },
                        },
                    },
                    {
                        type: "message",
                        message: {
                            type: "response.output_text.delta",
                            output_index: 1,
                            content_index: 0,
                            item_id: messageItem.id,
                            delta: "Checking.",
                        },
                    },
                    {
                        type: "message",
                        message: {
                            type: "response.output_item.done",
                            output_index: 1,
                            item: messageItem,
                        },
                    },
                    {
                        type: "message",
                        message: {
                            type: "response.output_item.added",
                            output_index: 2,
                            item: { ...toolItem, arguments: "" },
                        },
                    },
                    {
                        type: "message",
                        message: {
                            type: "response.function_call_arguments.delta",
                            output_index: 2,
                            item_id: toolItem.id,
                            delta: toolItem.arguments,
                        },
                    },
                    {
                        type: "message",
                        message: {
                            type: "response.output_item.done",
                            output_index: 2,
                            item: toolItem,
                        },
                    },
                );
                responseOutput.push(reasoningItem, messageItem, toolItem);
            } else if (websocket.emitCustomToolResponse && request.generate !== false) {
                websocket.emitCustomToolResponse = false;
                const toolItem = {
                    id: "custom-tool-item",
                    type: "custom_tool_call",
                    call_id: "custom-call",
                    name: "exec",
                    input: "text(true);",
                };
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { ...toolItem, input: "" },
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.custom_tool_call_input.delta",
                        output_index: 0,
                        item_id: toolItem.id,
                        delta: toolItem.input,
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: toolItem,
                    },
                });
                responseOutput.push(toolItem);
            } else if (websocket.emitTextResponses && request.generate !== false) {
                const messageItem = {
                    id: "mock-message",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                        {
                            type: "output_text",
                            text: "mock response",
                            annotations: [],
                        },
                    ],
                };
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { ...messageItem, content: [] },
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_text.delta",
                        output_index: 0,
                        content_index: 0,
                        item_id: messageItem.id,
                        delta: "mock response",
                    },
                });
                this.messages.push({
                    type: "message",
                    message: {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: messageItem,
                    },
                });
                responseOutput.push(messageItem);
            }
            this.messages.push({
                type: "message",
                message: {
                    type: "response.completed",
                    response: {
                        id: websocket.sent.length === 1 ? "<PREVIOUS_RESPONSE_ID>" : "response",
                        output: websocket.emptyCompletedOutput ? [] : responseOutput,
                        usage: {
                            input_tokens: websocket.usageTotalTokens,
                            output_tokens: 1,
                            total_tokens: websocket.usageTotalTokens + 1,
                        },
                    },
                },
            });
        }

        close(): void {
            if (this.socket.readyState >= 2) return;
            this.socket.readyState = 3;
            const result = {
                done: false as const,
                value: { type: "close", code: 1000 },
            };
            const resolve = this.resolveNext;
            if (resolve === undefined) {
                this.messages.push(result.value);
                return;
            }
            this.resolveNext = undefined;
            resolve(result);
        }

        on(event: string, listener: (error: Error) => void): this {
            if (event === "error") this.errorListeners.add(listener);
            return this;
        }

        off(event: string, listener: (error: Error) => void): this {
            if (event === "error") this.errorListeners.delete(listener);
            return this;
        }

        [Symbol.asyncIterator](): AsyncIterator<any> {
            return {
                next: async () => {
                    const value = this.messages.shift();
                    if (value?.type === "eof") return { done: true, value: undefined };
                    if (value !== undefined) return { done: false, value };
                    return new Promise<IteratorResult<any, undefined>>((resolve) => {
                        this.resolveNext = resolve;
                    });
                },
                return: async () => ({ done: true, value: undefined }),
            };
        }
    },
}));

import { createCodexCliRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";
import {
    createResponsesLiteWarmupRequest,
    createResponsesLiteWebSocketInferenceRequest,
} from "@/protocol/responsesLite/createResponsesLiteRequest.js";
import { setCodexRequestKind } from "@/vendors/codex/impl/setCodexRequestKind.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";
import { codexCliTools } from "./codexCliTools.js";
import { codexCliPrompt } from "./codexCliPrompt.js";
import { withCodexSkills } from "@/vendors/codex/impl/withCodexSkills.js";
import { codexSkills, codexSkillsWithGithub } from "@/vendors/codex/skills/codexSkills.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";

const cases = [
    ["gpt-5.5", "codex-gpt-5-5-low"],
    ["gpt-5.6-sol", "codex-gpt-5-6-sol-low"],
    ["gpt-5.6-terra", "codex-gpt-5-6-terra-low"],
    ["gpt-5.6-luna", "codex-gpt-5-6-luna-low"],
] as const;

describe("Codex CLI mode WebSocket goldens", () => {
    beforeEach(() => {
        websocket.beforeOutputFailures = 0;
        websocket.closeBeforeSendOnce = false;
        websocket.closedConnectionsOnCreate = 0;
        websocket.connectionHeaders.splice(0);
        websocket.emitCustomToolResponse = false;
        websocket.emitProductionShapeToolResponse = false;
        websocket.emptyCompletedOutput = false;
        websocket.failMidstreamOnce = false;
        websocket.midstreamFailures = 0;
        websocket.failToolCallMidstreamOnce = false;
        websocket.failTerminalOnce = false;
        websocket.holdWarmupOpenOnce = false;
        websocket.instances.splice(0);
        websocket.internalErrorFailures = 0;
        websocket.missingToolOutputCallId = undefined;
        websocket.missingPreviousResponseFailures = 0;
        websocket.endMidstreamOnce = false;
        websocket.emitTextResponses = false;
        websocket.unavailableOnce = false;
        websocket.usageTotalTokens = 0;
        websocket.turnState = undefined;
        websocket.sent.splice(0);
        sse.failures = 0;
        sse.requests.splice(0);
    });

    it.each(cases)("matches the official %s low-effort request contract", async (model, stem) => {
        const golden = await fixture(`${stem}.websocket.json`);
        expect(golden.source.capture).toBe("forwarded-live-inference");
        expect(golden.response.terminal).toBe("response.completed");
        const literalTools = await fixture(`${stem}.tools.json`);
        const prompt = codexCliPrompt(model, "websocket");
        expect(webSocketPromptEnvelope(golden.warmup, golden.request, false)).toEqual(prompt);
        const request = createCodexCliRequest({
            clientMetadata: golden.request.client_metadata ?? {},
            context: withCodexSkills(
                {
                    instructions: prompt.instructions,
                    messages: [
                        ...prompt.systemMessages.map((content) => ({
                            role: "system" as const,
                            content: content.map((text) => ({ type: "text" as const, text })),
                        })),
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Reply with OK." }],
                        },
                    ],
                },
                codexSkillsWithGithub,
                model,
            ),
            effort: "low",
            model,
            promptCacheKey: "<SESSION_ID>",
            tools: codexCliTools(model),
        });
        const warmup =
            request.tools === undefined
                ? createResponsesLiteWarmupRequest(
                      request,
                      toCodexToolDefinitions(codexCliTools(model)),
                  )
                : { ...structuredClone(request), input: [], generate: false };
        setCodexRequestKind(warmup, "prewarm");
        const inference =
            request.tools === undefined
                ? createResponsesLiteWebSocketInferenceRequest(request)
                : request;
        const warmupRecord = Object.fromEntries(Object.entries(warmup));
        const inferenceRecord = Object.fromEntries(Object.entries(inference));

        expect(protocolProjection(inferenceRecord)).toEqual(protocolProjection(golden.request));
        expect(protocolProjection(warmupRecord)).toEqual(protocolProjection(golden.warmup));
        expect(normalizeRequest(inferenceRecord)).toEqual(normalizeRequest(golden.request));
        expect(normalizeRequest(warmupRecord)).toEqual(normalizeRequest(golden.warmup));
        expect(toolDefinitions(inferenceRecord, warmupRecord)).toEqual(literalTools);
        expect(webSocketPromptEnvelope(warmupRecord, inferenceRecord)).toEqual(
            webSocketPromptEnvelope(golden.warmup, golden.request),
        );
    });

    it.each(cases)(
        "sends the captured %s request through a mocked WebSocket",
        async (model, stem) => {
            const golden = await fixture(`${stem}.websocket.json`);
            const prompt = codexCliPrompt(model, "websocket");
            expect(webSocketPromptEnvelope(golden.warmup, golden.request, false)).toEqual(prompt);
            const provider = new CodexProvider({
                credential: {
                    name: "codex-session",
                    credential: { accessToken: "test", accountId: "account" },
                } as never,
                endpoint: "http://localhost.invalid/backend-api/codex",
                model,
                transport: "websocket",
            });
            const initialMessages = prompt.systemMessages.map((content) => ({
                role: "system" as const,
                content: content.map((text) => ({ type: "text" as const, text })),
            }));
            const session = await provider.session("<SESSION_ID>", {
                instructions: prompt.instructions,
                tools: codexCliTools(model),
            });

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
                        codexSkillsWithGithub,
                        model,
                    ).messages,
                },
                effort: "low",
            })) {
                if (event.type === "done") expect(event.state).toBe("normal");
            }

            expect(websocket.sent).toHaveLength(2);
            expect(protocolProjection(websocket.sent[0]!)).toEqual(
                protocolProjection(golden.warmup),
            );
            expect(protocolProjection(websocket.sent[1]!)).toEqual(
                protocolProjection(golden.request),
            );
            expect(normalizeRequest(websocket.sent[0]!)).toEqual(normalizeRequest(golden.warmup));
            expect(normalizeRequest(websocket.sent[1]!)).toEqual(normalizeRequest(golden.request));
            expect(websocket.sent[0]!.prompt_cache_key).toBe("<SESSION_ID>");
            expect(websocket.sent[1]!.prompt_cache_key).toBe("<SESSION_ID>");
            expect(websocket.sent[1]!.previous_response_id).toBe("<PREVIOUS_RESPONSE_ID>");
            expect(requestKind(websocket.sent[0]!)).toBe("prewarm");
            expect(requestKind(websocket.sent[1]!)).toBe("turn");
            const expectedMetadataKeys = [
                "session_id",
                "thread_id",
                "turn_id",
                "x-codex-installation-id",
                "x-codex-turn-metadata",
                "x-codex-window-id",
                "x-codex-ws-stream-request-start-ms",
                ...(model.startsWith("gpt-5.6-")
                    ? ["ws_request_header_x_openai_internal_codex_responses_lite"]
                    : []),
            ].sort();
            expect(Object.keys(websocket.sent[0]!.client_metadata).sort()).toEqual(
                expectedMetadataKeys,
            );
            expect(Object.keys(websocket.sent[1]!.client_metadata).sort()).toEqual(
                expectedMetadataKeys,
            );
            expect(
                Number(websocket.sent[1]!.client_metadata["x-codex-ws-stream-request-start-ms"]),
            ).toBeGreaterThan(0);
            expect(websocket.connectionHeaders[0]).toMatchObject({
                "OpenAI-Beta": "responses_websockets=2026-02-06",
                originator: golden.handshake.headers.originator,
                "session-id": "<SESSION_ID>",
                "thread-id": "<SESSION_ID>",
                "x-codex-beta-features": "remote_compaction_v2",
            });
            if (model.startsWith("gpt-5.6-")) {
                expect(
                    websocket.sent[1]!.client_metadata
                        .ws_request_header_x_openai_internal_codex_responses_lite,
                ).toBe("true");
                expect(
                    websocket.connectionHeaders[0]?.["x-openai-internal-codex-responses-lite"],
                ).toBeUndefined();
                expect(websocket.sent[0]!.input[0]).toMatchObject({
                    type: "additional_tools",
                    role: "developer",
                });
                expect(websocket.sent[0]!.input[1]).toMatchObject({
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: prompt.instructions }],
                });
            }
            expect(webSocketPromptEnvelope(websocket.sent[0]!, websocket.sent[1]!)).toEqual(
                webSocketPromptEnvelope(golden.warmup, golden.request),
            );
            expect(toolDefinitions(websocket.sent[1]!, websocket.sent[0]!)).toEqual(
                await fixture(`${stem}.tools.json`),
            );
            session.destroy();
        },
    );

    it("starts a fresh logical turn while reusing the WebSocket response chain", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });

        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );
        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
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

        expect(websocket.sent).toHaveLength(3);
        expect(websocket.connectionHeaders).toHaveLength(1);
        expect(websocket.sent[2]!.previous_response_id).toBe("response");
        expect(websocket.sent[2]!.input).toEqual([
            {
                type: "message",
                role: "user",
                content: "second",
            },
        ]);
        session.destroy();
    });

    it("replays full context when the remote previous response is missing", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 0, true).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const first = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "first" }],
        };
        await drain(
            session.run(testContext, {
                context: { instructions: "", messages: [first] },
                effort: "low",
            }),
        );
        websocket.missingPreviousResponseFailures = 1;

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    first,
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "second" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(blockLifecycle(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_stop",
            "done",
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason: "Previous Codex response was unavailable; replaying full context.",
        });
        expect(websocket.sent).toHaveLength(4);
        expect(websocket.sent[2]!.previous_response_id).toBe("response");
        expect(websocket.sent[3]!.previous_response_id).toBeUndefined();
        expect(JSON.stringify(websocket.sent[3]!.input)).toContain("first");
        expect(JSON.stringify(websocket.sent[3]!.input)).toContain("second");
        session.destroy();
    });

    it("retries on a fresh WebSocket when the initial connection closes before warmup", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        websocket.closeBeforeSendOnce = true;

        const events = [];
        for await (const event of session.run(testContext, {
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
        })) {
            events.push(event);
        }

        expect(blockLifecycle(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_stop",
            "done",
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.connectionHeaders).toHaveLength(2);
        expect(websocket.sent).toHaveLength(2);
        session.destroy();
    });

    it("retries a nested Codex internal server error with a human-readable notification", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        websocket.internalErrorFailures = 1;

        const events = [];
        for await (const event of session.run(testContext, {
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
        })) {
            events.push(event);
        }

        expect(blockLifecycle(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_stop",
            "done",
        ]);
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason: "Stream disconnected; reconnecting: Internal server error",
        });
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.connectionHeaders).toHaveLength(2);
        expect(websocket.sent).toHaveLength(3);
        session.destroy();
    });

    it("silently reconnects when an idle cached WebSocket closes before the next request", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 0).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const first = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "first" }],
        };
        await drain(
            session.run(testContext, {
                context: { instructions: "", messages: [first] },
                effort: "low",
            }),
        );

        websocket.instances[0]!.closeWithoutEvent();
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    first,
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "second" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(blockLifecycle(events)).toEqual(["block_start", "block_stop", "done"]);
        expect(events).not.toContainEqual(expect.objectContaining({ type: "retrying" }));
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.connectionHeaders).toHaveLength(2);
        expect(websocket.sent).toHaveLength(3);
        expect(websocket.sent[2]!.previous_response_id).toBeUndefined();
        expect(websocket.sent[2]!.input).toContainEqual({
            type: "message",
            role: "user",
            content: "first",
        });
        expect(websocket.sent[2]!.input).toContainEqual({
            type: "message",
            role: "user",
            content: "second",
        });
        session.destroy();
    });

    it("uses the normal retry path when the silent reconnect is also closed", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const first = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "first" }],
        };
        await drain(
            session.run(testContext, {
                context: { instructions: "", messages: [first] },
                effort: "low",
            }),
        );

        websocket.instances[0]!.closeWithoutEvent();
        websocket.closedConnectionsOnCreate = 1;
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    first,
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "second" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(blockLifecycle(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_stop",
            "done",
        ]);
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason:
                "Stream disconnected; reconnecting: " +
                "The Codex WebSocket closed before the request could be sent.",
        });
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.connectionHeaders).toHaveLength(3);
        expect(websocket.sent).toHaveLength(3);
        expect(websocket.sent[2]!.previous_response_id).toBeUndefined();
        expect(JSON.stringify(websocket.sent[2]!.input)).toContain("first");
        expect(JSON.stringify(websocket.sent[2]!.input)).toContain("second");
        session.destroy();
    });

    it("absorbs an idle Responses WebSocket connection-limit error without crashing", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 0).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const first = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "first" }],
        };
        await drain(
            session.run(testContext, {
                context: { instructions: "", messages: [first] },
                effort: "low",
            }),
        );

        expect(websocket.instances).toHaveLength(1);
        expect(websocket.instances[0]!.errorListenerCount()).toBeGreaterThan(0);
        const connectionLimit = new WebSocketError(
            "Responses websocket connection limit reached (60 minutes). Create a new websocket " +
                "connection to continue.",
            {
                type: "error",
                code: "websocket_connection_limit_reached",
                message:
                    "Responses websocket connection limit reached (60 minutes). Create a new " +
                    "websocket connection to continue.",
                param: null,
                sequence_number: 2,
            },
        );
        expect(() => websocket.instances[0]!.emitError(connectionLimit)).not.toThrow();

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    first,
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "second" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.connectionHeaders).toHaveLength(2);
        expect(websocket.sent.at(-1)!.previous_response_id).toBeUndefined();
        expect(JSON.stringify(websocket.sent.at(-1)!.input)).toContain("second");
        session.destroy();
    });

    it("rotates a cached WebSocket before OpenAI's sixty-minute connection limit", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const startedAt = 1_700_000_000_000;
        const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
        const session = await codexProvider("websocket", 0).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const first = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "first" }],
        };
        await drain(
            session.run(testContext, {
                context: { instructions: "", messages: [first] },
                effort: "low",
            }),
        );

        now.mockReturnValue(startedAt + 56 * 60 * 1000);
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    first,
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "second" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.connectionHeaders).toHaveLength(2);
        expect(websocket.sent.at(-1)!.previous_response_id).toBeUndefined();
        expect(JSON.stringify(websocket.sent.at(-1)!.input)).toContain("second");
        now.mockRestore();
        session.destroy();
    });

    it("sends full context on the existing connection when the rebuilt prefix diverges", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });

        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );
        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "replacement" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(websocket.sent).toHaveLength(3);
        expect(websocket.sent[2]!.previous_response_id).toBeUndefined();
        expect(websocket.sent[2]!.input).toContainEqual({
            type: "message",
            role: "user",
            content: "replacement",
        });
        session.destroy();
    });

    it("allows a model change with full context on the existing connection", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });

        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
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
        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
                        },
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "second" }],
                        },
                    ],
                },
                effort: "low",
                model: "gpt-5.6-terra",
            }),
        );

        expect(websocket.sent[2]!.model).toBe("gpt-5.6-terra");
        expect(websocket.sent[2]!.previous_response_id).toBeUndefined();
        expect(websocket.sent[2]!.input).toContainEqual({
            type: "message",
            role: "user",
            content: "first",
        });
        expect(websocket.sent[2]!.input).toContainEqual({
            type: "message",
            role: "user",
            content: "second",
        });
        session.destroy();
    });

    it("uses native compaction and carries its opaque item into a model switch", async () => {
        const golden = await fixture("codex-gpt-5-6-multiturn.websocket.json");
        websocket.emitTextResponses = true;
        websocket.turnState = "sticky-before-compaction";
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
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
        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
                        },
                        {
                            role: "assistant",
                            content: [{ type: "text" as const, text: "mock response" }],
                        },
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "second" }],
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
                    {
                        role: "user",
                        content: [{ type: "text", text: "second" }],
                    },
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "mock response" }],
                    },
                ],
            },
        });
        expect(compacted.status).toBe("completed");
        if (compacted.status !== "completed") expect.fail("Expected completed compaction.");
        await drain(
            session.run(testContext, {
                context: {
                    instructions: prompt.instructions,
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

        const compaction = websocket.sent[3]!;
        const switched = websocket.sent[4]!;
        expect(switched.client_metadata["x-codex-window-id"]).not.toBe(
            compaction.client_metadata["x-codex-window-id"],
        );
        expect(compaction.previous_response_id).toBe("response");
        expect(requestKind(compaction)).toBe("compaction");
        expect(turnMetadata(compaction).compaction).toEqual({
            trigger: "manual",
            reason: "user_requested",
            implementation: "responses_compaction_v2",
            phase: "standalone_turn",
            strategy: "memento",
        });
        expect(turnMetadata(compaction).turn_id).not.toBe(turnMetadata(websocket.sent[2]!).turn_id);
        expect(compaction.client_metadata["x-codex-turn-state"]).toBeUndefined();
        expect(compaction.input).toEqual([{ type: "compaction_trigger" }]);
        expect(protocolProjection(compaction)).toEqual(protocolProjection(golden.requests[3]));
        expect(compacted).toMatchObject({
            status: "completed",
            compaction: {
                role: "compaction",
                content: null,
                encryptedContent: "opaque-native-compaction",
            },
        });
        expect(switched.model).toBe("gpt-5.6-terra");
        expect(switched.previous_response_id).toBeUndefined();
        expect(switched.input).toContainEqual({
            type: "compaction",
            encrypted_content: "opaque-native-compaction",
        });
        expect(protocolProjection(switched)).toEqual({
            ...protocolProjection(golden.requests[4]),
            inputTypes: protocolProjection(switched).inputTypes,
        });
        expect(toolDefinitions(switched, websocket.sent[0]!)).toEqual(
            await fixture("codex-gpt-5-6-terra-low.tools.json"),
        );
        session.destroy();
    });

    it("keeps WebSocket compaction continuation with a large inline image", async () => {
        websocket.emitTextResponses = true;
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const user = {
            role: "user" as const,
            content: [
                { type: "text" as const, text: "Keep the earlier conversation." },
                {
                    type: "image" as const,
                    data: "A".repeat(1_100_000),
                    mimeType: "image/png",
                },
            ],
        };
        await drain(
            session.run(testContext, {
                context: { instructions: prompt.instructions, messages: [user] },
                effort: "low",
                model: "gpt-5.6-sol",
            }),
        );

        const compacted = await session.compact(testContext, {
            context: {
                instructions: prompt.instructions,
                messages: [
                    user,
                    {
                        role: "assistant",
                        content: [{ type: "text" as const, text: "mock response" }],
                    },
                ],
            },
        });

        expect(compacted.status).toBe("completed");
        expect(websocket.sent[2]!.previous_response_id).toBe("response");
        expect(websocket.sent[2]!.input).toEqual([{ type: "compaction_trigger" }]);
        session.destroy();
    });

    it("rolls back and retries a WebSocket request after text has already streamed", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.failMidstreamOnce = true;
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            inferenceMaxRetries: 1,
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "retry me" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events).toContainEqual({ type: "text_delta", delta: "partial" });
        expect(events).toContainEqual({ type: "block_reset" });
        expect(blockLifecycle(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_stop",
            "done",
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(events).toContainEqual(expect.objectContaining({ type: "retrying", attempt: 1 }));
        expect(websocket.sent).toHaveLength(3);
        session.destroy();
    });

    it("rolls back and retries a WebSocket request after a tool call has started", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.failToolCallMidstreamOnce = true;
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            inferenceMaxRetries: 1,
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "use a tool" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        const toolDelta = events.findIndex((event) => event.type === "toolcall_delta");
        const reset = events.findIndex((event) => event.type === "block_reset");
        expect(toolDelta).toBeGreaterThanOrEqual(0);
        expect(reset).toBeGreaterThan(toolDelta);
        expect(blockLifecycle(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_stop",
            "done",
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.sent).toHaveLength(3);
        session.destroy();
    });

    it("keeps the physical connection while incrementally extending later user turns", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            inferenceMaxRetries: 1,
            transport: "websocket",
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
            }),
        );
        await drain(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
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

        expect(websocket.connectionHeaders).toHaveLength(1);
        expect(websocket.sent[2]!.input).toEqual([
            { type: "message", role: "user", content: "second" },
        ]);
        expect(websocket.sent[2]!.previous_response_id).toBe("response");
        session.destroy();
    });

    it("reports monotonic attempts across WebSocket fallback and SSE retry", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.beforeOutputFailures = 1;
        websocket.unavailableOnce = true;
        sse.failures = 1;
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            inferenceMaxRetries: 3,
            transport: "auto",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "retry me" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(
            events.filter((event) => event.type === "retrying").map((event) => event.attempt),
        ).toEqual([1, 2, 3]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(sse.requests).toHaveLength(2);
        session.destroy();
    });

    it("falls back to SSE after the runtime rejects the WebSocket upgrade", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.expected101Once = true;
        const session = await codexProvider("auto", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "fallback" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events.filter((event) => event.type === "retrying")).toEqual([
            expect.objectContaining({ attempt: 1, reason: expect.stringContaining("SSE") }),
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(sse.requests).toHaveLength(1);
        session.destroy();
    });

    it("keeps a complete custom-tool lifecycle and continues with its custom output", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.emitCustomToolResponse = true;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const user = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "use exec" }],
        };
        const first = [];
        for await (const event of session.run(testContext, {
            context: { instructions: "", messages: [user] },
            effort: "low",
        })) {
            first.push(event);
        }

        expect(first).toContainEqual({
            type: "toolcall_start",
            callId: "custom-call",
            name: "exec",
            vendor: { provider: "codex", type: "custom_tool_call" },
        });
        expect(first).toContainEqual({
            type: "toolcall_end",
            callId: "custom-call",
            arguments: "text(true);",
        });
        expect(first.at(-1)).toMatchObject({ type: "done", state: "tool_call" });

        await drain(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        user,
                        {
                            role: "assistant",
                            content: [
                                ...[
                                    {
                                        callId: "custom-call",
                                        name: "exec",
                                        arguments: "text(true);",
                                        vendor: {
                                            provider: "codex",
                                            type: "custom_tool_call",
                                            providerCallId: "custom-call",
                                        },
                                    },
                                ].map((call) => ({
                                    type: "tool_call" as const,
                                    ...call,
                                })),
                            ],
                        },
                        {
                            role: "tool",
                            content: [{ type: "text" as const, text: "true" }],
                            callId: "custom-call",
                            vendor: { provider: "codex", type: "custom_tool_call" },
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(websocket.connectionHeaders).toHaveLength(1);
        expect(websocket.sent[2]!.previous_response_id).toBe("response");
        expect(websocket.sent[2]!.input).toEqual([
            {
                type: "custom_tool_call_output",
                call_id: "custom-call",
                output: "true",
            },
        ]);
        session.destroy();
    });

    it("continues from streamed output items when the completed response output is empty", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.emitProductionShapeToolResponse = true;
        websocket.emptyCompletedOutput = true;
        const session = await codexProvider("websocket", 1, true).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const user = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "inspect it" }],
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
                            content: [
                                {
                                    type: "reasoning",
                                    reasoning: JSON.stringify({
                                        id: "reasoning-item",
                                        type: "reasoning",
                                        encrypted_content: "opaque-reasoning",
                                        summary: [],
                                    }),
                                },
                                { type: "text", text: "Checking." },
                                {
                                    type: "tool_call",
                                    callId: "function-call",
                                    name: "exec_command",
                                    arguments: '{"cmd":"true"}',
                                    vendor: {
                                        provider: "codex",
                                        type: "function_call",
                                        providerCallId: "function-call",
                                    },
                                },
                            ],
                        },
                        {
                            role: "tool",
                            content: [{ type: "text", text: "done" }],
                            callId: "function-call",
                            vendor: { provider: "codex", type: "function_call" },
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(websocket.sent).toHaveLength(3);
        expect(websocket.sent[2]!.previous_response_id).toBe("response");
        expect(websocket.sent[2]!.input).toEqual([
            {
                type: "function_call_output",
                call_id: "function-call",
                output: "done",
            },
        ]);
        session.destroy();
    });

    it("replays full context once when a cached continuation loses a tool output", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.emitCustomToolResponse = true;
        const session = await codexProvider("websocket", 10).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const user = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "use exec" }],
        };
        const toolCall = {
            type: "tool_call" as const,
            callId: "custom-call",
            name: "exec",
            arguments: "text(true);",
            vendor: {
                provider: "codex" as const,
                type: "custom_tool_call" as const,
                providerCallId: "custom-call",
            },
        };
        await drain(
            session.run(testContext, {
                context: { instructions: "", messages: [user] },
                effort: "low",
            }),
        );
        websocket.missingToolOutputCallId = toolCall.callId;

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    user,
                    { role: "assistant", content: [toolCall] },
                    {
                        role: "tool",
                        content: [{ type: "text" as const, text: "true" }],
                        callId: toolCall.callId,
                        vendor: { provider: "codex", type: "custom_tool_call" },
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason: "Codex lost a tool result; replaying full context.",
        });
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.sent).toHaveLength(4);
        expect(websocket.sent[2]!.previous_response_id).toBe("response");
        expect(websocket.sent[3]!.previous_response_id).toBeUndefined();
        expect(websocket.sent[3]!.input).toContainEqual({
            type: "custom_tool_call_output",
            call_id: toolCall.callId,
            output: "true",
        });
        session.destroy();
    });

    it("does not retry when full caller context is missing the tool output", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 10).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        websocket.missingToolOutputCallId = "custom-call";

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "use exec" }],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_call",
                                callId: "custom-call",
                                name: "exec",
                                arguments: "text(true);",
                                vendor: {
                                    provider: "codex",
                                    type: "custom_tool_call",
                                    providerCallId: "custom-call",
                                },
                            },
                        ],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events).not.toContainEqual(expect.objectContaining({ type: "retrying" }));
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: "No tool output found for custom tool call custom-call.",
        });
        expect(websocket.sent).toHaveLength(2);
        session.destroy();
    });

    it("replays sticky turn state only while reconnecting the same user turn", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.beforeOutputFailures = 1;
        websocket.turnState = "sticky-turn";
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
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
                            content: [{ type: "text" as const, text: "retry" }],
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
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "retry" }],
                        },
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "new turn" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(websocket.connectionHeaders[0]?.["x-codex-turn-state"]).toBeUndefined();
        expect(websocket.connectionHeaders[1]?.["x-codex-turn-state"]).toBeUndefined();
        expect(websocket.connectionHeaders).toHaveLength(2);
        expect(websocket.sent[1]!.client_metadata["x-codex-turn-state"]).toBeUndefined();
        expect(websocket.sent[2]!.client_metadata["x-codex-turn-state"]).toBe("sticky-turn");
        expect(websocket.sent[3]!.client_metadata["x-codex-turn-state"]).toBeUndefined();
        session.destroy();
    });

    it("does not compact automatically when usage reaches the Codex threshold", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.usageTotalTokens = 250_000;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
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
            }),
        );
        await drain(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
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

        expect(websocket.sent).toHaveLength(3);
        expect(websocket.sent[2]!.input).toEqual([
            {
                type: "message",
                role: "user",
                content: "second",
            },
        ]);
        expect(turnMetadata(websocket.sent[2]!).compaction).toBeUndefined();
        expect(websocket.sent[2]!.input).not.toContainEqual({
            type: "compaction_trigger",
        });
        expect(websocket.sent[2]!.input).toContainEqual({
            type: "message",
            role: "user",
            content: "second",
        });
        session.destroy();
    });

    it("leaves oversized restored context for the caller to compact", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const restored = `restored-${"x".repeat(980_000)}`;
        await drain(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: restored }],
                        },
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "continue" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(websocket.sent).toHaveLength(2);
        expect(JSON.stringify(websocket.sent[1]!.input)).toContain("restored-");
        expect(turnMetadata(websocket.sent[1]!).compaction).toBeUndefined();
        expect(websocket.sent[1]!.input).not.toContainEqual({ type: "compaction_trigger" });
        expect(websocket.sent[1]!.input).toContainEqual({
            type: "message",
            role: "user",
            content: "continue",
        });
        session.destroy();
    });

    it("continues a same-turn tool result without provider-owned compaction", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.emitCustomToolResponse = true;
        websocket.usageTotalTokens = 250_000;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const user = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "use exec" }],
        };
        const toolCall = {
            callId: "custom-call",
            name: "exec",
            arguments: "text(true);",
            vendor: {
                provider: "codex" as const,
                type: "custom_tool_call" as const,
                providerCallId: "custom-call",
            },
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
                            content: [
                                ...[toolCall].map((call) => ({
                                    type: "tool_call" as const,
                                    ...call,
                                })),
                            ],
                        },
                        {
                            role: "tool",
                            content: [{ type: "text" as const, text: "true" }],
                            callId: toolCall.callId,
                            vendor: { provider: "codex", type: "custom_tool_call" },
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(websocket.sent).toHaveLength(3);
        expect(websocket.sent[2]!.input).toEqual([
            {
                type: "custom_tool_call_output",
                call_id: "custom-call",
                output: "true",
            },
        ]);
        expect(turnMetadata(websocket.sent[2]!).compaction).toBeUndefined();
        expect(websocket.sent[2]!.input).not.toContainEqual({
            type: "compaction_trigger",
        });
        expect(websocket.sent[2]!.input).toContainEqual({
            type: "custom_tool_call_output",
            call_id: "custom-call",
            output: "true",
        });
        session.destroy();
    });

    it("rebuilds complete tool history when compaction reconnects", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.emitCustomToolResponse = true;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
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
                            content: [{ type: "text" as const, text: "use exec" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );
        websocket.beforeOutputFailures = 1;

        const compacted = await session.compact(testContext, {
            context: {
                instructions: prompt.instructions,
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "use exec" }],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_call",
                                callId: "custom-call",
                                name: "exec",
                                arguments: "text(true);",
                                vendor: {
                                    provider: "codex",
                                    type: "custom_tool_call",
                                    providerCallId: "custom-call",
                                },
                            },
                        ],
                    },
                ],
            },
        });

        expect(compacted.status).toBe("completed");
        expect(websocket.sent[2]!.input).toContainEqual({ type: "compaction_trigger" });
        expect(websocket.sent[3]!.input).toContainEqual({
            type: "custom_tool_call",
            call_id: "custom-call",
            name: "exec",
            input: "text(true);",
        });
        expect(websocket.sent[3]!.input.at(-1)).toEqual({ type: "compaction_trigger" });
        session.destroy();
    });

    it("returns cancelled when compaction is aborted during retry backoff", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.beforeOutputFailures = 1;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const controller = new AbortController();
        const compacting = session.compact(testContextWith(controller.signal), {
            context: {
                instructions: prompt.instructions,
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "new caller state" }],
                    },
                ],
            },
        });
        setTimeout(() => controller.abort(), 10);

        await expect(compacting).resolves.toEqual({
            status: "cancelled",
            context: {
                instructions: prompt.instructions,
                messages: [],
            },
        });
        session.destroy();
    });

    it("installs target instructions and tools across a 5.6 to 5.5 switch without compaction", async () => {
        const sol = codexCliPrompt("gpt-5.6-sol", "websocket");
        const legacy = codexCliPrompt("gpt-5.5", "websocket");
        websocket.emitTextResponses = true;
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: sol.instructions,
            modelConfigurations: {
                "gpt-5.6-sol": {
                    instructions: sol.instructions,
                    tools: codexCliTools("gpt-5.6-sol"),
                },
                "gpt-5.5": {
                    instructions: legacy.instructions,
                    tools: codexCliTools("gpt-5.5"),
                },
            },
            tools: codexCliTools("gpt-5.6-sol"),
        });
        await drain(
            session.run(testContext, {
                context: {
                    instructions: sol.instructions,
                    messages: [
                        ...sol.systemMessages.map((content) => ({
                            role: "system" as const,
                            content: content.map((text) => ({ type: "text" as const, text })),
                        })),
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );
        await drain(
            session.run(testContext, {
                context: {
                    instructions: legacy.instructions,
                    messages: [
                        ...legacy.systemMessages.map((content) => ({
                            role: "system" as const,
                            content: content.map((text) => ({ type: "text" as const, text })),
                        })),
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
                model: "gpt-5.5",
            }),
        );

        expect(websocket.sent).toHaveLength(3);
        const switched = websocket.sent[2]!;
        expect(switched.input).not.toContainEqual({ type: "compaction_trigger" });
        expect(turnMetadata(switched).compaction).toBeUndefined();
        expect(switched.input).toContainEqual({
            type: "message",
            role: "user",
            content: "first",
        });
        expect(switched.model).toBe("gpt-5.5");
        expect(switched.reasoning).toEqual({ effort: "medium" });
        expect(switched.instructions).toBe(legacy.instructions);
        expect(JSON.stringify(switched.input)).toContain("<model_switch>");
        expect(switched.input).not.toContainEqual(expect.objectContaining({ type: "compaction" }));
        expect(toolDefinitions(switched, websocket.sent[0]!)).toEqual(
            await fixture("codex-gpt-5-5-low.tools.json"),
        );
        session.destroy();
    });

    it("does not turn native compaction into a synthetic summary message", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const provider = new CodexProvider({
            credential: {
                name: "codex-session",
                credential: { accessToken: "test", accountId: "account" },
            } as never,
            endpoint: "http://localhost.invalid/backend-api/codex",
            model: "gpt-5.6-sol",
            inferenceMaxRetries: 1,
            transport: "websocket",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });

        const compacted = await session.compact(testContext, {
            context: {
                instructions: prompt.instructions,
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "compact this" }],
                    },
                ],
            },
        });

        expect(compacted.status).toBe("completed");
        if (compacted.status !== "completed") expect.fail("Expected completed compaction.");
        expect(compacted.context.messages).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "compact this" }],
            },
            {
                role: "compaction",
                content: null,
                encryptedContent: "opaque-native-compaction",
            },
        ]);
        expect(JSON.stringify(compacted.context)).not.toContain("conversation_summary");
        session.destroy();
    });

    it("compacts the caller's history including the tool results of the finished turn", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        for await (const _event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "first" }],
                    },
                ],
            },
        })) {
            // Drain the turn so the session records what it has already transmitted.
        }

        // The caller has since finished that turn's tools and owns history the session never saw.
        // Compacting the session's own lagging copy would summarize a conversation whose tool call
        // never got an answer.
        await session.compact(testContext, {
            context: {
                instructions: prompt.instructions,
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "first" }],
                    },
                    {
                        role: "assistant",
                        content: [
                            ...[
                                {
                                    callId: "call-1",
                                    name: "shell",
                                    arguments: "{}",
                                    vendor: { providerCallId: "call-1" },
                                },
                            ].map((call) => ({
                                type: "tool_call" as const,
                                ...call,
                            })),
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "text" as const, text: "tool finished" }],
                        callId: "call-1",
                    },
                ],
            },
        });

        const compaction = websocket.sent.at(-1)!;
        expect(compaction.input).toContainEqual({ type: "compaction_trigger" });
        expect(JSON.stringify(compaction.input)).toContain("tool finished");
        session.destroy();
    });

    it("does not restore the session's original history after compaction replaces it", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const oldHistory = `OLD_HISTORY_MUST_STAY_COMPACTED_${"x".repeat(40_000)}`;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const originalHistory = [
            {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: oldHistory }],
            },
            {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "Old response." }],
            },
        ];
        await drain(
            session.run(testContext, {
                context: { instructions: "", messages: originalHistory },
                effort: "low",
            }),
        );
        const compacted = await session.compact(testContext, {
            context: {
                instructions: prompt.instructions,
                messages: originalHistory,
            },
        });
        expect(compacted.status).toBe("completed");
        if (compacted.status !== "completed") expect.fail("Expected completed compaction.");

        await drain(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        ...compacted.context.messages,
                        {
                            role: "user",
                            content: [
                                { type: "text" as const, text: "Continue after compaction." },
                            ],
                        },
                    ],
                },
                effort: "low",
                model: "gpt-5.6-terra",
            }),
        );

        const continuation = websocket.sent.at(-1)!;
        expect(continuation.previous_response_id).toBeUndefined();
        expect(continuation.input).toContainEqual({
            type: "compaction",
            encrypted_content: "opaque-native-compaction",
        });
        expect(JSON.stringify(continuation.input)).toContain("Continue after compaction.");
        expect(JSON.stringify(continuation.input)).not.toContain("OLD_HISTORY_MUST_STAY_COMPACTED");
        session.destroy();
    });

    it("compacts a reordered caller history without repeating the session's own messages", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });

        // The caller's history is authoritative even when compaction reorders it.
        await session.compact(testContext, {
            context: {
                instructions: prompt.instructions,
                messages: [
                    {
                        role: "system",
                        content: [
                            { type: "text" as const, text: "The model changed to gpt-5.6-sol." },
                        ],
                    },
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "first" }],
                    },
                    {
                        role: "assistant",
                        content: [{ type: "text" as const, text: "answered" }],
                    },
                ],
            },
        });

        const compaction = websocket.sent.at(-1)!;
        const said = JSON.stringify(compaction.input).split('"first"').length - 1;
        expect(said).toBe(1);
        session.destroy();
    });

    it("keeps provider-added system content without repeating caller-owned system content", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });

        await session.compact(testContext, {
            context: withCodexSkills(
                {
                    instructions: prompt.instructions,
                    messages: [
                        {
                            role: "system",
                            content: [{ type: "text" as const, text: "Original instructions." }],
                        },
                        {
                            role: "system",
                            content: [{ type: "text" as const, text: "Later instructions." }],
                        },
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "first" }],
                        },
                        {
                            role: "assistant",
                            content: [{ type: "text" as const, text: "answered" }],
                        },
                    ],
                },
                codexSkills,
                "gpt-5.6-sol",
            ),
        });

        const input = JSON.stringify(websocket.sent.at(-1)!.input);
        expect(input.split("Original instructions.")).toHaveLength(2);
        expect(input).toContain("<skills_instructions>");
        session.destroy();
    });

    it("rolls back and retries a stream that ends after response content", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.endMidstreamOnce = true;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "retry" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(blockLifecycle(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_stop",
            "done",
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(websocket.sent).toHaveLength(3);
        session.destroy();
    });

    it("clears terminally failed WebSocket state before session reuse", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.failTerminalOnce = true;
        const session = await codexProvider("websocket", 0).session("<SESSION_ID>", {
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
                            content: [{ type: "text" as const, text: "fail" }],
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
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "recover" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(websocket.sent[2]!.generate).toBeUndefined();
        expect(JSON.stringify(websocket.sent[2]!.input)).toContain("recover");
        expect(websocket.sent[2]!.input).toContainEqual(
            expect.objectContaining({ type: "additional_tools" }),
        );
        expect(websocket.sent[2]!.input).toContainEqual(
            expect.objectContaining({ type: "message", role: "developer" }),
        );
        session.destroy();
    });

    it("clears aborted WebSocket state before session reuse", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.failMidstreamOnce = true;
        const session = await codexProvider("websocket", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const controller = new AbortController();
        const firstEvents = [];
        for await (const event of session.run(testContextWith(controller.signal), {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "abort" }],
                    },
                ],
            },
            effort: "low",
        })) {
            firstEvents.push(event);
            if (event.type === "text_delta") controller.abort();
        }
        await drain(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "recover" }],
                        },
                    ],
                },
                effort: "low",
            }),
        );

        expect(firstEvents.at(-1)).toEqual({ type: "done", state: "cancelled" });
        expect(websocket.sent[2]!.generate).toBeUndefined();
        expect(JSON.stringify(websocket.sent[2]!.input)).toContain("recover");
        expect(websocket.sent[2]!.input).toContainEqual(
            expect.objectContaining({ type: "additional_tools" }),
        );
        expect(websocket.sent[2]!.input).toContainEqual(
            expect.objectContaining({ type: "message", role: "developer" }),
        );
        session.destroy();
    });

    it("clears a closed warmed WebSocket before an aborted stream stops at block reset", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.failMidstreamOnce = true;
        const session = await codexProvider("websocket", 0).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const controller = new AbortController();
        for await (const event of session.run(testContextWith(controller.signal), {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "abort" }],
                    },
                ],
            },
            effort: "low",
        })) {
            if (event.type === "text_delta") controller.abort();
            if (event.type === "block_reset") break;
        }

        const recoveryEvents = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "recover" }],
                    },
                ],
            },
            effort: "low",
        })) {
            recoveryEvents.push(event);
        }

        expect(recoveryEvents.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(JSON.stringify(websocket.sent.at(-1)!.input)).toContain("recover");
        session.destroy();
    });

    it("clears a closed WebSocket when warmup abort stops at block reset", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.holdWarmupOpenOnce = true;
        const session = await codexProvider("websocket", 0).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const controller = new AbortController();
        const aborted = session
            .run(testContextWith(controller.signal), {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "abort warmup" }],
                        },
                    ],
                },
                effort: "low",
            })
            [Symbol.asyncIterator]();
        expect(await aborted.next()).toEqual({ done: false, value: { type: "block_start" } });
        const reset = aborted.next();
        await vi.waitFor(() => expect(websocket.sent).toHaveLength(1));
        controller.abort();
        expect(await reset).toEqual({ done: false, value: { type: "block_reset" } });
        await aborted.return?.();

        const recoveryEvents = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "recover" }],
                    },
                ],
            },
            effort: "low",
        })) {
            recoveryEvents.push(event);
        }

        expect(recoveryEvents.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(JSON.stringify(websocket.sent.at(-1)!.input)).toContain("recover");
        session.destroy();
    });

    it("falls back immediately when WebSocket is unavailable", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.unavailableOnce = true;
        const session = await codexProvider("auto", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "fallback" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events.filter((event) => event.type === "retrying")).toHaveLength(1);
        expect(sse.requests).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        session.destroy();
    });

    it("does not fall back when the shared retry budget is zero", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.unavailableOnce = true;
        const session = await codexProvider("auto", 0).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "do not retry" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(sse.requests).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
        session.destroy();
    });

    it("does not retry SSE after fallback exhausts the shared budget", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.unavailableOnce = true;
        sse.failures = 1;
        const session = await codexProvider("auto", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "one retry only" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
        }

        expect(
            events.filter((event) => event.type === "retrying").map((event) => event.attempt),
        ).toEqual([1]);
        expect(sse.requests).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
        session.destroy();
    });

    it("stops when the turn is aborted as it announces the SSE fallback", async () => {
        const prompt = codexCliPrompt("gpt-5.6-sol", "websocket");
        websocket.unavailableOnce = true;
        const controller = new AbortController();
        const session = await codexProvider("auto", 1).session("<SESSION_ID>", {
            instructions: prompt.instructions,
            tools: codexCliTools("gpt-5.6-sol"),
        });
        const events = [];
        for await (const event of session.run(testContextWith(controller.signal), {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "fallback" }],
                    },
                ],
            },
            effort: "low",
        })) {
            events.push(event);
            if (event.type === "retrying") controller.abort();
        }

        expect(events.at(-1)).toEqual({ type: "done", state: "cancelled" });
        expect(sse.requests).toHaveLength(0);
        expect(blockLifecycle(events)).toEqual(["block_start", "block_reset", "retrying", "done"]);
        session.destroy();
    });
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _event of stream) {
        // Drain the mocked response.
    }
}

function blockLifecycle(events: readonly { type: string }[]): string[] {
    return events
        .map((event) => event.type)
        .filter(
            (type) =>
                type === "block_start" ||
                type === "block_stop" ||
                type === "block_reset" ||
                type === "retrying" ||
                type === "done",
        );
}

function codexProvider(
    transport: "auto" | "websocket",
    inferenceMaxRetries: number,
    parallelToolCalls?: boolean,
): CodexProvider {
    return new CodexProvider({
        credential: {
            name: "codex-session",
            credential: { accessToken: "test", accountId: "account" },
        } as never,
        endpoint: "http://localhost.invalid/backend-api/codex",
        model: "gpt-5.6-sol",
        ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
        inferenceMaxRetries,
        transport,
    });
}

async function fixture(name: string): Promise<any> {
    return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function protocolProjection(request: Record<string, any>): Record<string, unknown> {
    return {
        type: request.type ?? "response.create",
        model: request.model,
        tool_choice: request.tool_choice,
        parallel_tool_calls: request.parallel_tool_calls,
        reasoning: request.reasoning,
        store: request.store,
        stream: request.stream,
        include: request.include,
        text: request.text,
        generate: request.generate,
        hasInstructions: request.instructions !== undefined,
        hasTopLevelTools: request.tools !== undefined,
        inputTypes: Array.isArray(request.input)
            ? [...new Set(request.input.map((item: { type?: unknown }) => item.type))]
            : [],
    };
}

function normalizeRequest(request: Record<string, any>): Record<string, unknown> {
    const normalized = structuredClone(request);
    delete normalized.type;
    delete normalized.previous_response_id;
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

function toolDefinitions(request: Record<string, any>, warmup: Record<string, any>): unknown[] {
    if (Array.isArray(request.tools)) return request.tools;
    return (
        warmup.input?.find((item: { type?: unknown }) => item.type === "additional_tools")?.tools ??
        []
    );
}

function promptEnvelope(
    request: Record<string, any>,
    includeSkills = true,
): {
    instructions?: string;
    systemMessages: string[][];
} {
    const systemMessages = (request.input ?? [])
        .filter(
            (item: { role?: unknown; type?: unknown }) =>
                item.type === "message" && item.role === "developer",
        )
        .map((item: any) =>
            (typeof item.content === "string" ? [item.content] : (item.content ?? []))
                .map((content: { text?: unknown } | string) =>
                    typeof content === "string" ? content : content.text,
                )
                .filter((text: unknown): text is string => typeof text === "string"),
        )
        .map((message: string[]) =>
            includeSkills
                ? message
                : message.filter((part) => !part.startsWith("<skills_instructions>")),
        )
        .filter((message: string[]) => message.length > 0);
    return {
        ...(typeof request.instructions === "string" ? { instructions: request.instructions } : {}),
        systemMessages,
    };
}

function webSocketPromptEnvelope(
    warmup: Record<string, any>,
    request: Record<string, any>,
    includeSkills = true,
): { instructions: string; systemMessages: string[][] } {
    const requestPrompt = promptEnvelope(request, includeSkills);
    const warmupPrompt = promptEnvelope(warmup, includeSkills);
    const instructions = requestPrompt.instructions ?? warmupPrompt.systemMessages.flat()[0];
    if (instructions === undefined) throw new Error("WebSocket capture omitted instructions.");
    return { instructions, systemMessages: requestPrompt.systemMessages };
}
