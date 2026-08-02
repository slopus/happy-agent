import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import type { ProviderUsage } from "@/core/ProviderUsage.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession, type ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";
import { CLAUDE_SDK_PRIVACY_ENVIRONMENT } from "@/vendors/claude/claudeSdkPrivacyEnvironment.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

describe("ClaudeSession", () => {
    it("retries a server error after rolling back its incomplete response", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const firstClose = vi.fn();
        const waitForInferenceRetry = vi.fn(async () => {});
        let queryCount = 0;
        const query = vi.fn<ClaudeSdkQuery>(() => {
            queryCount += 1;
            return queryCount === 1
                ? midResponseServerErrorQuery(firstClose)
                : fakeQuery("RECOVERED");
        });
        const session = new ClaudeSession("mid-response-retry-session", {
            instructions: "",
            credential,
            inferenceMaxRetries: 1,
            model: "sonnet[1m]",
            query,
            tools: [],
            waitForInferenceRetry,
        });

        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [{ role: "user", content: "Retry the incomplete response." }],
                },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledOnce();
        expect(waitForInferenceRetry).toHaveBeenCalledWith(1, undefined);
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason: "Claude's response was interrupted by a server error.",
        });
        expect(textFromSessionEvents(events)).toBe("RECOVERED");
        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
        expect(query.mock.calls[0]?.[0].options?.env?.CLAUDE_CODE_MAX_RETRIES).toBe("1");
        expect(query.mock.calls[1]?.[0].options?.env?.CLAUDE_CODE_MAX_RETRIES).toBe("0");
    });

    it("surfaces a mid-response server error after exhausting the shared retry budget", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const query = vi.fn<ClaudeSdkQuery>(() =>
            midResponseServerErrorQuery(
                () => {},
                "API Error: Connection closed mid-response. The response above may be incomplete.",
                false,
            ),
        );
        const session = new ClaudeSession("mid-response-exhausted-session", {
            instructions: "",
            credential,
            inferenceMaxRetries: 1,
            model: "sonnet[1m]",
            query,
            tools: [],
            waitForInferenceRetry: async () => {},
        });

        const events = [];
        for await (const event of session.run({
            context: {
                messages: [{ role: "user", content: "Retry the incomplete response." }],
            },
        })) {
            events.push(event);
        }

        expect(query).toHaveBeenCalledTimes(2);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(1);
        expect(textFromSessionEvents(events)).toBe("");
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "internal_error",
            providerError: {
                type: "internal_server_error",
                diagnostics: { attempts: 2 },
            },
        });
        expect(
            query.mock.calls.map(([request]) => request.options?.env?.CLAUDE_CODE_MAX_RETRIES),
        ).toEqual(["1", "0"]);
    });

    it("retries a successful result with zero output tokens", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const firstClose = vi.fn();
        const query = vi.fn<ClaudeSdkQuery>(() => {
            if (query.mock.calls.length > 1) return fakeQuery("RECOVERED");
            async function* messages() {
                yield {
                    type: "result",
                    subtype: "success",
                    duration_ms: 1,
                    duration_api_ms: 1,
                    is_error: false,
                    num_turns: 1,
                    result: "",
                    stop_reason: "end_turn",
                    total_cost_usd: 0,
                    usage: {
                        input_tokens: 1,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                    modelUsage: {},
                    permission_denials: [],
                    uuid: "empty-result",
                    session_id: "empty-output-session",
                };
            }
            return Object.assign(messages(), {
                close: firstClose,
            }) as unknown as ReturnType<ClaudeSdkQuery>;
        });
        const session = new ClaudeSession("empty-output-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [],
            waitForInferenceRetry: async () => {},
        });

        const events = await collectSessionEvents(
            session.run({
                context: { messages: [{ role: "user", content: "Retry empty output." }] },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledOnce();
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason: "Claude returned a response with zero output tokens.",
        });
        expect(events.filter((event) => event.type === "token_usage")).toEqual([
            {
                type: "token_usage",
                usage: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    input: 1,
                    output: 0,
                    totalTokens: 1,
                },
            },
            {
                type: "token_usage",
                usage: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    input: 10,
                    output: 2,
                    totalTokens: 12,
                },
            },
        ]);
        expect(textFromSessionEvents(events)).toBe("RECOVERED");
        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
    });

    it("preserves a non-abort empty-response retry delay failure", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const delayError = Object.assign(new Error("retry timer failed"), {
            code: "RETRY_TIMER_FAILURE",
        });
        const session = new ClaudeSession("empty-output-delay-failure", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: () => fakeQuery("", 0),
            tools: [],
            waitForInferenceRetry: async () => {
                throw delayError;
            },
        });

        await expect(
            collectSessionEvents(
                session.run({
                    context: {
                        messages: [{ role: "user", content: "Retry empty output." }],
                    },
                }),
            ),
        ).rejects.toBe(delayError);
    });

    it("preserves weekly quota classification, reset time, retries, and the native error", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("quota-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => {
                async function* messages() {
                    yield {
                        type: "system",
                        subtype: "api_retry",
                        attempt: 2,
                        max_retries: 10,
                        retry_delay_ms: 1_500,
                        error_status: 429,
                        error: "rate_limit",
                        uuid: "quota-retry-id",
                        session_id: "quota-session",
                    };
                    yield {
                        type: "rate_limit_event",
                        rate_limit_info: {
                            status: "rejected",
                            resetsAt: 2_000,
                            overageStatus: "rejected",
                            overageDisabledReason: "org_level_disabled",
                        },
                        uuid: "quota-event-id",
                        session_id: "quota-session",
                    };
                    yield {
                        type: "assistant",
                        error: "rate_limit",
                        message: {
                            id: "assistant-message-id",
                            type: "message",
                            role: "assistant",
                            model: "claude-sonnet-5",
                            content: [],
                            stop_reason: "end_turn",
                            stop_sequence: null,
                            usage: {
                                input_tokens: 0,
                                output_tokens: 0,
                                cache_creation_input_tokens: 0,
                                cache_read_input_tokens: 0,
                            },
                        },
                        parent_tool_use_id: null,
                        uuid: "assistant-event-id",
                        session_id: "quota-session",
                    };
                    yield {
                        type: "result",
                        subtype: "success",
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: true,
                        num_turns: 1,
                        result: "You've hit your weekly limit · resets Jul 25 at 5am",
                        stop_reason: null,
                        total_cost_usd: 0,
                        usage: {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        modelUsage: {},
                        permission_denials: [],
                        uuid: "result-id",
                        session_id: "quota-session",
                    };
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as unknown as ClaudeSdkQuery,
            tools: [],
        });

        const events = [];
        for await (const event of session.run({
            context: { messages: [{ role: "user", content: "Hello." }] },
        })) {
            events.push(event);
        }

        expect(events.at(-1)).toEqual({
            type: "done",
            state: "error",
            kind: "unknown",
            message: "You've hit your weekly limit · resets Jul 25 at 5am",
            providerError: {
                type: "rate_limit",
                resetAt: 2_000_000,
                diagnostics: {
                    attempts: 3,
                    code: "rate_limit",
                    upstreamMessage: "You've hit your weekly limit · resets Jul 25 at 5am",
                },
            },
        });
    });

    it("reports the account usage the limiter volunteers during a run", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const observed: ProviderUsage[] = [];
        const session = new ClaudeSession("usage-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            onAccountUsage: (usage) => observed.push(usage),
            query: (() => {
                async function* messages() {
                    yield {
                        type: "rate_limit_event",
                        rate_limit_info: {
                            status: "allowed",
                            rateLimitType: "five_hour",
                            utilization: 0.42,
                            resetsAt: 2_000,
                        },
                        uuid: "usage-event-id",
                        session_id: "usage-session",
                    };
                    yield {
                        type: "result",
                        subtype: "success",
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: false,
                        num_turns: 1,
                        result: "Hello.",
                        stop_reason: null,
                        total_cost_usd: 0,
                        usage: {
                            input_tokens: 0,
                            output_tokens: 1,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        modelUsage: {},
                        permission_denials: [],
                        uuid: "result-id",
                        session_id: "usage-session",
                    };
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as unknown as ClaudeSdkQuery,
            tools: [],
        });

        await collectSessionEvents(
            session.run({ context: { messages: [{ role: "user", content: "Hello." }] } }),
        );

        expect(observed).toHaveLength(1);
        expect(observed[0]?.windows.fiveHour?.usedPercent).toBe(42);
    });

    it("humanizes an SDK error result whose error list is empty", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("empty-error-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => {
                async function* messages() {
                    yield {
                        type: "result",
                        subtype: "error_during_execution",
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: true,
                        num_turns: 1,
                        stop_reason: null,
                        total_cost_usd: 0,
                        usage: {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        modelUsage: {},
                        permission_denials: [],
                        errors: [],
                        uuid: "result-id",
                        session_id: "empty-error-session",
                    };
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as unknown as ClaudeSdkQuery,
            tools: [],
        });

        const events = [];
        for await (const event of session.run({
            context: { messages: [{ role: "user", content: "Hello." }] },
        })) {
            events.push(event);
        }

        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: "Claude encountered an error while running the request.",
        });
    });

    it("converts native Claude API retries into Rig retry events", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("retry-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => {
                async function* messages() {
                    yield {
                        type: "system",
                        subtype: "api_retry",
                        attempt: 2,
                        max_retries: 10,
                        retry_delay_ms: 1_500,
                        error_status: 529,
                        error: "overloaded",
                        uuid: "retry-id",
                        session_id: "retry-session",
                    };
                    yield* fakeQuery("RETRIED");
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as unknown as ClaudeSdkQuery,
            tools: [],
        });

        const events = await collectSessionEvents(
            session.run({ context: { messages: [{ role: "user", content: "Retry." }] } }),
        );

        expect(events).toContainEqual({
            type: "retrying",
            attempt: 2,
            reason: "Claude API overloaded (HTTP 529); retrying in 1.5 s, attempt 2 of 10.",
        });
    });

    it("marks trailing tool results complete before requesting continuation", async () => {
        let capturedPrompt: unknown;
        let capturedEntries: unknown;
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("tool-result-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: ((parameters) => {
                async function* messages() {
                    capturedEntries = await parameters.options?.sessionStore?.load({
                        projectKey: "test",
                        sessionId: parameters.options.resume ?? "tool-result-session",
                    });
                    if (typeof parameters.prompt !== "string") {
                        capturedPrompt = (await parameters.prompt[Symbol.asyncIterator]().next())
                            .value;
                    }
                    yield* fakeQuery("TOOL_OK");
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as ClaudeSdkQuery,
            tools: [],
        });

        await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [{ callId: "call-1", name: "Read", arguments: "{}" }],
                        },
                        {
                            role: "tool",
                            callId: "call-1",
                            content: "TOOL_RESULT",
                            isError: true,
                        },
                    ],
                },
            }),
        );

        expect(capturedEntries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "user",
                    isMeta: true,
                    message: {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "call-1",
                                content: "TOOL_RESULT",
                                is_error: true,
                            },
                        ],
                    },
                }),
            ]),
        );
        expect(capturedPrompt).toMatchObject({
            type: "user",
            message: { content: "Continue from the supplied tool result." },
        });
    });

    it("reports each inference usage instead of the result's accumulated query usage", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("per-inference-usage-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => accumulatedUsageToolQuery()) as ClaudeSdkQuery,
            tools: [
                {
                    name: "Bash",
                    type: "local",
                    description: "Run a command.",
                    parameters: Type.Object({ command: Type.String() }),
                },
            ],
        });

        const first = await collectSessionEvents(
            session.run({
                context: { messages: [{ role: "user", content: "Inspect this." }] },
            }),
        );
        expect(first.find((event) => event.type === "token_usage")).toEqual({
            type: "token_usage",
            usage: {
                cacheRead: 900,
                cacheWrite: 5,
                input: 100,
                output: 10,
                totalTokens: 1_015,
            },
        });

        const second = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Inspect this." },
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    callId: "usage-call",
                                    name: "Bash",
                                    arguments: '{"command":"pwd"}',
                                },
                            ],
                        },
                        {
                            role: "tool",
                            callId: "usage-call",
                            content: "/workspace",
                            isError: false,
                        },
                    ],
                },
            }),
        );
        expect(second.find((event) => event.type === "token_usage")).toEqual({
            type: "token_usage",
            usage: {
                cacheRead: 1_000,
                cacheWrite: 20,
                input: 150,
                output: 20,
                totalTokens: 1_190,
            },
        });
    });

    it("does not report a zero context when continued inference usage is absent", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("missing-continued-usage-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => missingContinuedUsageQuery()) as ClaudeSdkQuery,
            tools: [
                {
                    name: "Bash",
                    type: "local",
                    description: "Run a command.",
                    parameters: Type.Object({ command: Type.String() }),
                },
            ],
        });

        await collectSessionEvents(
            session.run({
                context: { messages: [{ role: "user", content: "Inspect this." }] },
            }),
        );
        const continued = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Inspect this." },
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    callId: "missing-usage-call",
                                    name: "Bash",
                                    arguments: '{"command":"pwd"}',
                                },
                            ],
                        },
                        {
                            role: "tool",
                            callId: "missing-usage-call",
                            content: "/workspace",
                            isError: false,
                        },
                    ],
                },
            }),
        );

        expect(continued.some((event) => event.type === "token_usage")).toBe(false);
        expect(continued.at(-1)).toEqual({ type: "done", state: "normal" });
    });

    it("replays after a user message interrupts a completed tool batch", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const firstClose = vi.fn();
        const query = vi.fn<ClaudeSdkQuery>(() => {
            if (query.mock.calls.length === 1) return fakeToolCallQuery(firstClose);
            return fakeQuery("RECOVERED");
        });
        const session = new ClaudeSession("interrupted-tool-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [
                {
                    name: "Bash",
                    type: "local",
                    parameters: Type.Object({ command: Type.String() }),
                },
            ],
        });

        await expect(
            collectSessionEvents(
                session.run({
                    context: { messages: [{ role: "user", content: "Run a command." }] },
                }),
            ),
        ).resolves.toContainEqual({ type: "done", state: "tool_call" });

        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Run a command." },
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    callId: "call-1",
                                    name: "Bash",
                                    arguments: '{"command":"echo done"}',
                                },
                            ],
                        },
                        {
                            role: "tool",
                            callId: "call-1",
                            content: "done",
                        },
                        { role: "user", content: "What are the last messages?" },
                    ],
                },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledOnce();
        expect(textFromSessionEvents(events)).toBe("RECOVERED");
        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
    });

    it("replays after a system notice interrupts a completed tool batch", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const firstClose = vi.fn();
        const query = vi.fn<ClaudeSdkQuery>(() => {
            if (query.mock.calls.length === 1) return fakeToolCallQuery(firstClose);
            return fakeQuery("RECOVERED");
        });
        const session = new ClaudeSession("system-interrupted-tool-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [
                {
                    name: "Bash",
                    type: "local",
                    parameters: Type.Object({ command: Type.String() }),
                },
            ],
        });

        await expect(
            collectSessionEvents(
                session.run({
                    context: { messages: [{ role: "user", content: "Run a command." }] },
                }),
            ),
        ).resolves.toContainEqual({ type: "done", state: "tool_call" });

        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Run a command." },
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    callId: "call-1",
                                    name: "Bash",
                                    arguments: '{"command":"echo done"}',
                                },
                            ],
                        },
                        {
                            role: "tool",
                            callId: "call-1",
                            content: "Interrupted by steering.",
                            isError: true,
                        },
                        {
                            role: "system",
                            content: "Background command 19 finished successfully.",
                        },
                    ],
                },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledOnce();
        expect(textFromSessionEvents(events)).toBe("RECOVERED");
        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
    });

    it("replays parallel tool results as one complete Claude user turn", async () => {
        let capturedEntries: unknown;
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("parallel-tool-replay-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: ((parameters) => {
                async function* messages() {
                    capturedEntries = await parameters.options?.sessionStore?.load({
                        projectKey: "test",
                        sessionId: parameters.options.resume ?? "parallel-tool-replay-session",
                    });
                    yield* fakeQuery("RECOVERED_PARALLEL_BATCH");
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as ClaudeSdkQuery,
            tools: [
                {
                    name: "Read",
                    type: "local",
                    parameters: Type.Object({ file_path: Type.String() }),
                },
                {
                    name: "Glob",
                    type: "local",
                    parameters: Type.Object({ pattern: Type.String() }),
                },
            ],
        });

        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Run both tools." },
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    callId: "parallel-read",
                                    name: "Read",
                                    arguments: '{"file_path":"/tmp/a"}',
                                },
                                {
                                    callId: "parallel-glob",
                                    name: "Glob",
                                    arguments: '{"pattern":"**/*.md"}',
                                },
                            ],
                        },
                        {
                            role: "tool",
                            callId: "parallel-read",
                            content: "read result",
                        },
                        {
                            role: "tool",
                            callId: "parallel-glob",
                            content: "glob result",
                        },
                        { role: "user", content: "Continue." },
                    ],
                },
            }),
        );

        expect(capturedEntries).toHaveLength(4);
        expect(capturedEntries).toMatchObject([
            { type: "user", message: { role: "user", content: "Run both tools." } },
            {
                type: "assistant",
                message: {
                    content: [{ type: "tool_use", id: "parallel-read", name: "Read" }],
                },
            },
            {
                type: "assistant",
                message: {
                    content: [{ type: "tool_use", id: "parallel-glob", name: "Glob" }],
                },
            },
            {
                type: "user",
                isMeta: true,
                message: {
                    role: "user",
                    content: [
                        { type: "tool_result", tool_use_id: "parallel-read" },
                        { type: "tool_result", tool_use_id: "parallel-glob" },
                    ],
                },
            },
        ]);
        const assistantEntries = (
            capturedEntries as Array<{
                message?: { id?: string };
                parentUuid?: string | null;
                type: string;
                uuid?: string;
            }>
        ).filter((entry) => entry.type === "assistant");
        expect(assistantEntries[0]?.message?.id).toBe(assistantEntries[1]?.message?.id);
        expect(assistantEntries[1]?.parentUuid).toBe(assistantEntries[0]?.uuid);
        expect(textFromSessionEvents(events)).toBe("RECOVERED_PARALLEL_BATCH");
    });

    it("removes the abort listener when SDK query construction throws", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const abortController = new AbortController();
        const addAbortListener = vi.spyOn(abortController.signal, "addEventListener");
        const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener");
        const session = new ClaudeSession("throwing-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => {
                throw new Error("SDK construction failed.");
            }) as ClaudeSdkQuery,
            tools: [],
        });

        await expect(
            collectSessionEvents(
                session.run({
                    abort: abortController.signal,
                    context: { messages: [{ role: "user", content: "Hello." }] },
                }),
            ),
        ).rejects.toThrow("SDK construction failed.");
        expect(addAbortListener).toHaveBeenCalledOnce();
        expect(removeAbortListener).toHaveBeenCalledOnce();
    });

    it("commits a terminal result when abort races after the terminal was observed", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const controller = new AbortController();
        const usage = {
            input_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            get output_tokens() {
                controller.abort();
                return 1;
            },
        };
        const session = new ClaudeSession("terminal-abort-race", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => {
                async function* messages() {
                    yield {
                        type: "result",
                        subtype: "success",
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: false,
                        num_turns: 1,
                        result: "completed",
                        stop_reason: "end_turn",
                        total_cost_usd: 0,
                        usage,
                        modelUsage: {},
                        permission_denials: [],
                        uuid: "terminal-abort-race-result",
                        session_id: "terminal-abort-race",
                    };
                }
                return Object.assign(messages(), { close: () => {} });
            }) as unknown as ClaudeSdkQuery,
            tools: [],
        });

        const events = await collectSessionEvents(
            session.run({
                abort: controller.signal,
                context: { messages: [{ role: "user", content: "Finish." }] },
            }),
        );

        expect(controller.signal.aborted).toBe(true);
        expect(events).toContainEqual({ type: "block_stop" });
        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
    });

    it("stops immediately when the Claude SDK does not settle after interruption", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const started = deferred<void>();
        const never = new Promise<never>(() => {});
        const close = vi.fn();
        const interrupt = vi.fn(() => never);
        const session = new ClaudeSession("stuck-abort-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => ({
                [Symbol.asyncIterator]() {
                    return this;
                },
                close,
                interrupt,
                next() {
                    started.resolve();
                    return never;
                },
            })) as unknown as ClaudeSdkQuery,
            tools: [],
        });
        const controller = new AbortController();
        const eventsPromise = collectSessionEvents(
            session.run({
                abort: controller.signal,
                context: { messages: [{ role: "user", content: "Keep waiting." }] },
            }),
        );

        await started.promise;
        controller.abort();

        await expect(settlesBeforeNextTurn(eventsPromise)).resolves.toContainEqual({
            type: "block_reset",
        });
        expect(interrupt).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

    it("starts a new Claude SDK session after abort", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const started = deferred<void>();
        const sdkSessionIds: string[] = [];
        const query = vi.fn<ClaudeSdkQuery>((parameters) => {
            sdkSessionIds.push(parameters.options?.sessionId ?? parameters.options?.resume ?? "");
            if (query.mock.calls.length > 1) return fakeQuery("NEW_SESSION_RECOVERED");
            const never = new Promise<never>(() => {});
            return {
                [Symbol.asyncIterator]() {
                    return this;
                },
                close: vi.fn(),
                interrupt: vi.fn(),
                next() {
                    started.resolve();
                    return never;
                },
            } as unknown as ReturnType<ClaudeSdkQuery>;
        });
        const session = new ClaudeSession("rotate-after-abort-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [],
        });
        const controller = new AbortController();
        const firstRun = collectSessionEvents(
            session.run({
                abort: controller.signal,
                context: { messages: [{ role: "user", content: "Keep waiting." }] },
            }),
        );

        await started.promise;
        controller.abort();
        await expect(firstRun).resolves.toContainEqual({ type: "block_reset" });
        const secondRun = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Keep waiting." },
                        { role: "user", content: "Continue." },
                    ],
                },
            }),
        );

        expect(sdkSessionIds).toHaveLength(2);
        expect(sdkSessionIds[0]).not.toBe(sdkSessionIds[1]);
        expect(textFromSessionEvents(secondRun)).toBe("NEW_SESSION_RECOVERED");
    });

    it("closes a Claude query when abort fires during query construction", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const controller = new AbortController();
        const close = vi.fn();
        const session = new ClaudeSession("construction-abort-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: (() => {
                controller.abort();
                return {
                    [Symbol.asyncIterator]() {
                        return this;
                    },
                    close,
                    next: vi.fn(() => new Promise<never>(() => {})),
                };
            }) as unknown as ClaudeSdkQuery,
            tools: [],
        });

        await expect(
            settlesBeforeNextTurn(
                collectSessionEvents(
                    session.run({
                        abort: controller.signal,
                        context: { messages: [{ role: "user", content: "Keep waiting." }] },
                    }),
                ),
            ),
        ).resolves.toContainEqual({ type: "block_reset" });
        expect(close).toHaveBeenCalledOnce();
    });

    it("replays user and tool-result images as native Claude image blocks", async () => {
        const captured: {
            entries?: unknown;
            prompt?: unknown;
        } = {};
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("image-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query: ((parameters) => {
                async function* messages() {
                    captured.entries = await parameters.options?.sessionStore?.load({
                        projectKey: "test",
                        sessionId: parameters.options.resume ?? "image-session",
                    });
                    if (typeof parameters.prompt !== "string") {
                        captured.prompt = (
                            await parameters.prompt[Symbol.asyncIterator]().next()
                        ).value;
                    }
                    yield* fakeQuery("IMAGE_OK");
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as ClaudeSdkQuery,
            tools: [],
        });

        await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [{ callId: "call-1", name: "Read", arguments: "{}" }],
                        },
                        {
                            role: "tool",
                            callId: "call-1",
                            content: "tool image",
                            input: [
                                { type: "text", text: "tool image" },
                                {
                                    type: "image",
                                    mimeType: "image/png",
                                    data: "dG9vbC1pbWFnZQ==",
                                },
                            ],
                        },
                        {
                            role: "user",
                            content: "user image",
                            input: [
                                { type: "text", text: "user image" },
                                {
                                    type: "image",
                                    mimeType: "image/webp",
                                    data: "dXNlci1pbWFnZQ==",
                                },
                            ],
                        },
                    ],
                },
            }),
        );

        expect(captured.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "user",
                    message: {
                        role: "user",
                        content: [
                            expect.objectContaining({
                                type: "tool_result",
                                content: [
                                    { type: "text", text: "tool image" },
                                    {
                                        type: "image",
                                        source: {
                                            type: "base64",
                                            media_type: "image/png",
                                            data: "dG9vbC1pbWFnZQ==",
                                        },
                                    },
                                ],
                            }),
                        ],
                    },
                }),
            ]),
        );
        expect(captured.prompt).toMatchObject({
            type: "user",
            message: {
                content: [
                    { type: "text", text: "user image" },
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: "image/webp",
                            data: "dXNlci1pbWFnZQ==",
                        },
                    },
                ],
            },
        });
    });

    it("replaces disabled Claude Code attachments with Rig context, tools, and skills", async () => {
        const calls: Parameters<ClaudeSdkQuery>[0][] = [];
        const compactionPrompts: string[] = [];
        const replies = ["FIRST", "SWITCHED"];
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const systemMessages = [
            { role: "system" as const, content: "Project instructions." },
            { role: "system" as const, content: "Golden skill description." },
        ];
        const session = new ClaudeSession("session-id", {
            instructions: "Rig system instructions.",
            credential,
            env: {
                PATH: process.env.PATH,
                ANTHROPIC_API_KEY: "wrong-api-key",
                CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3",
                CLAUDE_CODE_OAUTH_TOKEN: "wrong-oauth-token",
                CLAUDE_CODE_MAX_RETRIES: "2",
                CLAUDE_CODE_USE_BEDROCK: "1",
                CLAUDE_CODE_USE_FOUNDRY: "1",
                CLAUDE_CODE_USE_VERTEX: "1",
                DISABLE_AUTO_COMPACT: "0",
                OTEL_LOG_USER_PROMPTS: "1",
            },
            model: "opus[1m]",
            query: ((parameters) => {
                calls.push(parameters);
                return calls.length >= 3
                    ? fakeNativeCompactQuery(
                          parameters,
                          calls.length === 3 ? "SUMMARY" : "CUSTOM SUMMARY",
                          compactionPrompts,
                      )
                    : fakeQuery(replies[calls.length - 1] ?? "OK");
            }) as ClaudeSdkQuery,
            tools: [
                {
                    name: "Read",
                    type: "local",
                    description: "Read a file.",
                    parameters: Type.Object({ path: Type.String() }),
                },
            ],
        });

        const abortController = new AbortController();
        const addAbortListener = vi.spyOn(abortController.signal, "addEventListener");
        const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener");
        const first = await collectSessionEvents(
            session.run({
                abort: abortController.signal,
                context: {
                    messages: [...systemMessages, { role: "user", content: "First turn." }],
                },
            }),
        );
        const switched = await collectSessionEvents(
            session.run({
                model: "sonnet[1m]",
                context: {
                    messages: [
                        ...systemMessages,
                        { role: "user", content: "First turn." },
                        { role: "assistant", content: "FIRST" },
                        { role: "user", content: "Switch models." },
                    ],
                },
            }),
        );
        const compacted = await session.compact();
        const customCompacted = await session.compact({
            instructions: "Keep CUSTOM_MARKER.",
        });

        expect(textFromSessionEvents(first)).toBe("FIRST");
        expect(textFromSessionEvents(switched)).toBe("SWITCHED");
        expect(compacted).toMatchObject({
            status: "completed",
            summary: "SUMMARY",
            usage: {
                input: 7,
                output: 11,
                cacheRead: 101,
                cacheWrite: 13,
                totalTokens: 132,
            },
            context: {
                instructions: "Rig system instructions.",
                messages: [
                    { role: "system", content: "Project instructions." },
                    { role: "system", content: "Golden skill description." },
                    { role: "user", content: "SUMMARY" },
                ],
            },
        });
        expect(customCompacted).toMatchObject({
            status: "completed",
            summary: "CUSTOM SUMMARY",
        });
        expect(compactionPrompts).toEqual(["/compact", "/compact Keep CUSTOM_MARKER."]);
        expect(calls).toHaveLength(4);
        expect(calls.map((call) => call.options?.model)).toEqual([
            "opus[1m]",
            "sonnet[1m]",
            "sonnet[1m]",
            "sonnet[1m]",
        ]);

        const options = calls[0]?.options;
        expect(options).toMatchObject({
            allowedTools: ["mcp__rig__Read"],
            extraArgs: { "disable-slash-commands": null },
            includePartialMessages: true,
            permissionMode: "dontAsk",
            persistSession: false,
            sessionId: expect.any(String),
            settingSources: [],
            strictMcpConfig: true,
            tools: [],
        });
        // Anthropic has no conversational system role, so the configured notices keep their
        // position as reminders instead of rewriting the cached prompt prefix.
        expect(options?.systemPrompt).toContain("Rig system instructions.");
        expect(options?.systemPrompt).not.toContain("Project instructions.");
        expect(options?.systemPrompt).not.toContain("Golden skill description.");
        expect(options?.env).toMatchObject({
            ...CLAUDE_SDK_PRIVACY_ENVIRONMENT,
            ANTHROPIC_AUTH_TOKEN: "test-token",
            CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
            CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1",
            CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
            CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
            CLAUDE_CODE_MAX_RETRIES: "10",
            DISABLE_AUTO_COMPACT: "1",
        });
        expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
        expect(options?.env).not.toHaveProperty("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR");
        expect(options?.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
        expect(options?.env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
        expect(options?.env).not.toHaveProperty("CLAUDE_CODE_USE_FOUNDRY");
        expect(options?.env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
        expect(options?.settings).toEqual({ env: CLAUDE_SDK_PRIVACY_ENVIRONMENT });
        expect(addAbortListener).toHaveBeenCalledOnce();
        expect(removeAbortListener).toHaveBeenCalledOnce();
        expect(options?.mcpServers).toHaveProperty("rig");
        expect(calls[1]?.options).toMatchObject({
            persistSession: true,
            resume: expect.any(String),
        });

        const compactionOptions = calls[2]?.options;
        expect(compactionOptions).toMatchObject({
            allowedTools: ["mcp__rig__Read"],
            extraArgs: {},
            tools: [],
        });
    });

    it("uses exact compaction usage reported under Claude's canonical model key", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("fable-compaction", {
            instructions: "Rig system instructions.",
            credential,
            model: "claude-fable-5[1m]",
            query: ((parameters) =>
                fakeNativeCompactQuery(parameters, "SUMMARY", [], {
                    usageModel: "claude-fable-5",
                })) as ClaudeSdkQuery,
            tools: [],
        });

        const compacted = await session.compact({
            context: {
                messages: [
                    { role: "user", content: "Review this." },
                    { role: "assistant", content: "Reviewed." },
                ],
            },
        });

        expect(compacted).toMatchObject({
            status: "completed",
            summary: "SUMMARY",
            usage: {
                input: 7,
                output: 11,
                cacheRead: 101,
                cacheWrite: 13,
                totalTokens: 132,
            },
        });
    });

    it("replaces restored conversation history after compaction", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const replayEntries: unknown[] = [];
        let queryIndex = 0;
        let postCompactionPrompt: unknown;
        const compactionPrompts: string[] = [];
        const query = ((parameters) => {
            const index = queryIndex;
            queryIndex += 1;
            async function* messages() {
                replayEntries[index] = await parameters.options?.sessionStore?.load({
                    projectKey: "test",
                    sessionId: parameters.options.resume ?? "restored-session",
                });
                if (index === 0) {
                    yield* fakeNativeCompactQuery(parameters, "SUMMARY", compactionPrompts);
                    return;
                }
                if (typeof parameters.prompt !== "string") {
                    postCompactionPrompt = (await parameters.prompt[Symbol.asyncIterator]().next())
                        .value;
                }
                yield* fakeQuery("CONTINUED");
            }
            return Object.assign(messages(), { close: () => {} });
        }) as ClaudeSdkQuery;
        const systemMessage = { role: "system" as const, content: "Project instructions." };
        const compactedPrefix = [
            systemMessage,
            { role: "user" as const, content: "OLD QUESTION" },
            { role: "assistant" as const, content: "OLD ANSWER" },
        ];
        const retainedMessage = {
            role: "user" as const,
            content: "RETAIN THIS LATEST TURN",
        };
        const session = new ClaudeSession("restored-session", {
            instructions: "Rig system instructions.",
            credential,
            model: "opus[1m]",
            query,
            tools: [],
        });

        const compacted = await session.compact({
            context: { messages: compactedPrefix },
        });
        await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        systemMessage,
                        {
                            role: "user",
                            content: "<conversation_summary>\nSUMMARY\n</conversation_summary>",
                        },
                        retainedMessage,
                    ],
                },
            }),
        );

        expect(compacted).toMatchObject({
            status: "completed",
            preservedMessages: [systemMessage],
            context: {
                messages: [systemMessage, { role: "user", content: "SUMMARY" }],
            },
        });
        expect(JSON.stringify(replayEntries[0])).not.toContain(retainedMessage.content);
        expect(JSON.stringify(replayEntries[1])).not.toContain("OLD QUESTION");
        expect(JSON.stringify(replayEntries[1])).not.toContain("OLD ANSWER");
        expect(JSON.stringify(replayEntries[1])).toContain("SUMMARY");
        expect(postCompactionPrompt).toMatchObject({
            type: "user",
            message: { content: retainedMessage.content },
        });
    });

    it("restarts the query when the caller compacts the context inside a tool loop", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const replayEntries: unknown[] = [];
        const firstClose = vi.fn();
        const query = vi.fn<ClaudeSdkQuery>((parameters) => {
            const index = query.mock.calls.length - 1;
            if (index === 0) return fakeToolCallQuery(firstClose);
            async function* messages() {
                replayEntries[index] = await parameters.options?.sessionStore?.load({
                    projectKey: "test",
                    sessionId: parameters.options.resume ?? "compacted-tool-loop-session",
                });
                yield* fakeQuery("CONTINUED");
            }
            return Object.assign(messages(), {
                close: () => {},
            }) as unknown as ReturnType<ClaudeSdkQuery>;
        });
        const session = new ClaudeSession("compacted-tool-loop-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [
                {
                    name: "Bash",
                    type: "local",
                    parameters: Type.Object({ command: Type.String() }),
                },
            ],
        });

        await expect(
            collectSessionEvents(
                session.run({
                    context: { messages: [{ role: "user", content: "ORIGINAL QUESTION" }] },
                }),
            ),
        ).resolves.toContainEqual({ type: "done", state: "tool_call" });

        // The caller compacted while the tool ran, so the history behind the pending tool result
        // is no longer the history the live query holds.
        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        {
                            role: "user",
                            content: "<conversation_summary>\nSUMMARY\n</conversation_summary>",
                        },
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    callId: "call-1",
                                    name: "Bash",
                                    arguments: '{"command":"echo done"}',
                                },
                            ],
                        },
                        { role: "tool", callId: "call-1", content: "done" },
                    ],
                },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledOnce();
        expect(JSON.stringify(replayEntries[1])).toContain("SUMMARY");
        expect(JSON.stringify(replayEntries[1])).not.toContain("ORIGINAL QUESTION");
        expect(textFromSessionEvents(events)).toBe("CONTINUED");
    });

    it("keeps one live query when a tool result completes the batch it generated", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const query = vi.fn<ClaudeSdkQuery>(() => fakeLiveToolLoopQuery("CONTINUED"));
        const session = new ClaudeSession("live-tool-loop-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [
                {
                    name: "Bash",
                    type: "local",
                    parameters: Type.Object({ command: Type.String() }),
                },
            ],
        });

        await collectSessionEvents(
            session.run({ context: { messages: [{ role: "user", content: "Run a command." }] } }),
        );
        // The executor round trip decorates the assistant it replays with fields Claude never
        // sent back, so wire identity - not raw equality - has to drive the decision.
        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Run a command." },
                        {
                            role: "assistant",
                            content: "",
                            encryptedReasoning: "round-trip-only",
                            responseItems: [{ type: "ignored" }],
                            toolCalls: [
                                {
                                    callId: "call-1",
                                    name: "Bash",
                                    arguments: '{"command":"echo done"}',
                                },
                            ],
                        },
                        { role: "tool", callId: "call-1", content: "done" },
                    ] as never,
                },
            }),
        );

        expect(query).toHaveBeenCalledOnce();
        expect(textFromSessionEvents(events)).toBe("CONTINUED");
    });

    it("restarts when the caller edits the assistant message the query generated", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const query = vi.fn<ClaudeSdkQuery>(() => fakeQuery("ANSWER"));
        const session = new ClaudeSession("edited-assistant-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [],
        });

        await collectSessionEvents(
            session.run({ context: { messages: [{ role: "user", content: "First." }] } }),
        );
        await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "First." },
                        { role: "assistant", content: "EDITED ANSWER" },
                        { role: "user", content: "Second." },
                    ],
                },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
    });

    it("restarts rather than dropping a system notice queued behind the next prompt", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const replayEntries: unknown[] = [];
        const query = vi.fn<ClaudeSdkQuery>((parameters) => {
            const index = query.mock.calls.length - 1;
            async function* messages() {
                replayEntries[index] = await parameters.options?.sessionStore?.load({
                    projectKey: "test",
                    sessionId: parameters.options.resume ?? "system-notice-session",
                });
                yield* fakeQuery("ANSWER");
            }
            return Object.assign(messages(), {
                close: () => {},
            }) as unknown as ReturnType<ClaudeSdkQuery>;
        });
        const session = new ClaudeSession("system-notice-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [],
        });

        await collectSessionEvents(
            session.run({ context: { messages: [{ role: "user", content: "First." }] } }),
        );
        // Only the final message reaches a live query, so a notice appended beside the next
        // prompt would be silently dropped if the session continued here.
        await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "First." },
                        { role: "assistant", content: "ANSWER" },
                        { role: "system", content: "PROJECT NOTICE" },
                        { role: "user", content: "Second." },
                    ],
                },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(replayEntries[1])).toContain("PROJECT NOTICE");
    });

    it("restarts when only part of a parallel tool batch is answered", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const query: ReturnType<typeof vi.fn<ClaudeSdkQuery>> = vi.fn<ClaudeSdkQuery>(() =>
            query.mock.calls.length === 1 ? fakeParallelToolCallQuery() : fakeQuery("REPLAYED"),
        );
        const session = new ClaudeSession("partial-batch-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [
                {
                    name: "Bash",
                    type: "local",
                    parameters: Type.Object({ command: Type.String() }),
                },
            ],
        });

        await collectSessionEvents(
            session.run({ context: { messages: [{ role: "user", content: "Run two." }] } }),
        );
        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        { role: "user", content: "Run two." },
                        {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                { callId: "call-1", name: "Bash", arguments: "{}" },
                                { callId: "call-2", name: "Bash", arguments: "{}" },
                            ],
                        },
                        { role: "tool", callId: "call-1", content: "only one" },
                    ],
                },
            }),
        );

        expect(query).toHaveBeenCalledTimes(2);
        expect(textFromSessionEvents(events)).toBe("REPLAYED");
    });

    it("starts a fresh query when the caller clears back to an identical first prompt", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const query = vi.fn<ClaudeSdkQuery>(() => fakeQuery("ANSWER"));
        const session = new ClaudeSession("cleared-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [],
        });

        const firstTurn = { messages: [{ role: "user" as const, content: "Same prompt." }] };
        await collectSessionEvents(session.run({ context: firstTurn }));
        // Clearing rewinds behind an answer the live query still holds, so the identical prompt
        // must not resume that conversation.
        await collectSessionEvents(session.run({ context: firstTurn }));

        expect(query).toHaveBeenCalledTimes(2);
    });
});

async function settlesBeforeNextTurn<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            setImmediate(() => reject(new Error("The aborted Claude query outlived its turn.")));
        }),
    ]);
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value?: T) => void;
} {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value) => resolvePromise(value as T),
    };
}

function fakeNativeCompactQuery(
    parameters: Parameters<ClaudeSdkQuery>[0],
    summary: string,
    prompts: string[],
    options: { usageModel?: string } = {},
): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        if (typeof parameters.prompt === "string") {
            prompts.push(parameters.prompt);
        } else {
            for await (const prompt of parameters.prompt) {
                const content = prompt.message.content;
                prompts.push(
                    typeof content === "string"
                        ? content
                        : content
                              .filter((block) => block.type === "text")
                              .map((block) => block.text)
                              .join(""),
                );
            }
        }
        await parameters.options?.sessionStore?.append(
            { projectKey: "test", sessionId: parameters.options.resume ?? "session-id" },
            [
                {
                    type: "user",
                    isCompactSummary: true,
                    message: { role: "user", content: summary },
                },
            ],
        );
        yield {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual", pre_tokens: 100, post_tokens: 10 },
            uuid: "compact-boundary",
            session_id: "session-id",
        };
        yield {
            type: "system",
            subtype: "status",
            status: null,
            compact_result: "success",
            uuid: "compact-status",
            session_id: "session-id",
        };
        const model = options.usageModel ?? parameters.options?.model ?? "claude-sonnet-5[1m]";
        yield {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 0,
            result: "",
            stop_reason: null,
            session_id: "session-id",
            total_cost_usd: 0,
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            modelUsage: {
                [model]: {
                    inputTokens: 7,
                    outputTokens: 11,
                    cacheReadInputTokens: 101,
                    cacheCreationInputTokens: 13,
                    webSearchRequests: 0,
                    costUSD: 0,
                    contextWindow: 1_000_000,
                    maxOutputTokens: 64_000,
                },
            },
            permission_denials: [],
            uuid: "compact-result",
        };
    }
    const generator = messages();
    return Object.assign(generator, { close: () => {} }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function fakeQuery(text: string, outputTokens = 2): ReturnType<ClaudeSdkQuery> {
    const result = {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: text,
        stop_reason: "end_turn",
        session_id: "session-id",
        total_cost_usd: 0,
        usage: {
            input_tokens: 10,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "result-id",
    };
    async function* messages() {
        yield result;
    }
    const generator = messages();
    return Object.assign(generator, {
        close: () => {},
    }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function midResponseServerErrorQuery(
    close: () => void,
    message = "API Error: Server error mid-response. The response above may be incomplete.",
    includeAssistantError = true,
): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        yield streamEvent("partial-text", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "INCOMPLETE" },
        });
        if (includeAssistantError) {
            yield {
                type: "assistant",
                error: "server_error",
                message: {
                    id: "mid-response-error",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-5",
                    content: [
                        {
                            type: "text",
                            text: message,
                        },
                    ],
                    stop_reason: "stop_sequence",
                    stop_sequence: "",
                    usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                },
                parent_tool_use_id: null,
                uuid: "mid-response-assistant",
                session_id: "mid-response-retry-session",
            };
        }
        yield {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: true,
            num_turns: 1,
            result: message,
            stop_reason: "stop_sequence",
            session_id: "mid-response-retry-session",
            total_cost_usd: 0,
            usage: {
                input_tokens: 1,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "mid-response-result",
        };
    }
    return Object.assign(messages(), { close }) as unknown as ReturnType<ClaudeSdkQuery>;
}

/** Stays open after its tool call, the way a real live query awaits the pending result. */
function fakeLiveToolLoopQuery(text: string): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        yield* fakeToolCallQuery(() => {});
        yield* fakeQuery(text);
    }
    return Object.assign(messages(), {
        close: () => {},
    }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function fakeParallelToolCallQuery(): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        for (const [index, callId] of ["call-1", "call-2"].entries()) {
            yield {
                type: "stream_event",
                event: {
                    type: "content_block_start",
                    index,
                    content_block: { type: "tool_use", id: callId, name: "Bash", input: {} },
                },
                parent_tool_use_id: null,
                uuid: `tool-start-${callId}`,
                session_id: "session-id",
            };
            yield {
                type: "stream_event",
                event: {
                    type: "content_block_delta",
                    index,
                    delta: { type: "input_json_delta", partial_json: "{}" },
                },
                parent_tool_use_id: null,
                uuid: `tool-delta-${callId}`,
                session_id: "session-id",
            };
            yield {
                type: "stream_event",
                event: { type: "content_block_stop", index },
                parent_tool_use_id: null,
                uuid: `tool-stop-${callId}`,
                session_id: "session-id",
            };
        }
        yield {
            type: "stream_event",
            event: { type: "message_stop" },
            parent_tool_use_id: null,
            uuid: "message-stop",
            session_id: "session-id",
        };
    }
    return Object.assign(messages(), {
        close: () => {},
    }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function fakeToolCallQuery(close: () => void): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        yield {
            type: "stream_event",
            event: {
                type: "content_block_start",
                index: 0,
                content_block: {
                    type: "tool_use",
                    id: "call-1",
                    name: "Bash",
                    input: {},
                },
            },
            parent_tool_use_id: null,
            uuid: "tool-start",
            session_id: "session-id",
        };
        yield {
            type: "stream_event",
            event: {
                type: "content_block_delta",
                index: 0,
                delta: {
                    type: "input_json_delta",
                    partial_json: '{"command":"echo done"}',
                },
            },
            parent_tool_use_id: null,
            uuid: "tool-delta",
            session_id: "session-id",
        };
        yield {
            type: "stream_event",
            event: { type: "content_block_stop", index: 0 },
            parent_tool_use_id: null,
            uuid: "tool-stop",
            session_id: "session-id",
        };
        yield {
            type: "stream_event",
            event: { type: "message_stop" },
            parent_tool_use_id: null,
            uuid: "message-stop",
            session_id: "session-id",
        };
    }
    return Object.assign(messages(), { close }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function accumulatedUsageToolQuery(): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        yield streamEvent("first-start", {
            type: "message_start",
            message: {
                usage: {
                    input_tokens: 100,
                    output_tokens: 0,
                    cache_creation_input_tokens: 5,
                    cache_read_input_tokens: 900,
                },
            },
        });
        yield streamEvent("tool-start", {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: "usage-call",
                name: "Bash",
                input: {},
            },
        });
        yield streamEvent("tool-delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
        });
        yield streamEvent("tool-stop", { type: "content_block_stop", index: 0 });
        yield streamEvent("first-delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: {
                input_tokens: null,
                output_tokens: 10,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
            },
        });
        yield streamEvent("first-stop", { type: "message_stop" });

        yield streamEvent("second-start", {
            type: "message_start",
            message: {
                usage: {
                    input_tokens: 150,
                    output_tokens: 0,
                    cache_creation_input_tokens: 20,
                    cache_read_input_tokens: 1_000,
                },
            },
        });
        yield streamEvent("text", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Done." },
        });
        yield streamEvent("second-delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: {
                input_tokens: null,
                output_tokens: 20,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
            },
        });
        yield streamEvent("second-stop", { type: "message_stop" });
        yield {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 2,
            result: "Done.",
            stop_reason: "end_turn",
            session_id: "per-inference-usage-session",
            total_cost_usd: 0,
            usage: {
                input_tokens: 250,
                output_tokens: 30,
                cache_creation_input_tokens: 25,
                cache_read_input_tokens: 1_900,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "result",
        };
    }
    return Object.assign(messages(), { close: () => {} }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function missingContinuedUsageQuery(): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        yield streamEvent("missing-usage-tool-start", {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: "missing-usage-call",
                name: "Bash",
                input: {},
            },
        });
        yield streamEvent("missing-usage-tool-delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
        });
        yield streamEvent("missing-usage-tool-stop", {
            type: "content_block_stop",
            index: 0,
        });
        yield streamEvent("missing-usage-first-delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: {
                input_tokens: 10,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 20,
            },
        });
        yield streamEvent("missing-usage-first-stop", { type: "message_stop" });
        yield streamEvent("missing-usage-text", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Done." },
        });
        yield {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 2,
            result: "Done.",
            stop_reason: "end_turn",
            session_id: "missing-continued-usage-session",
            total_cost_usd: 0,
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 5,
                cache_read_input_tokens: 200,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "missing-usage-result",
        };
    }
    return Object.assign(messages(), { close: () => {} }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function streamEvent(uuid: string, event: Record<string, unknown>) {
    return {
        type: "stream_event" as const,
        event,
        parent_tool_use_id: null,
        uuid,
        session_id: "per-inference-usage-session",
    };
}
