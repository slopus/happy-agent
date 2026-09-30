import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WebSocketError } from "openai/resources/responses/internal-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testContext, testContextWith } from "./testContext.js";
import { CodexApiKeyCredential } from "@/vendors/codex/CodexApiKeyCredential.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import type { CodexAccessProgram } from "@/vendors/codex/impl/codexAccessProgram.js";

const outboundRequestSchema = Type.Object(
    {
        access_programs: Type.Optional(
            Type.Object({
                cyber: Type.Union([
                    Type.Literal("standard"),
                    Type.Literal("daybreak_blue"),
                    Type.Literal("daybreak_red"),
                ]),
            }),
        ),
        generate: Type.Optional(Type.Boolean()),
        input: Type.Optional(Type.Array(Type.Unknown())),
        previous_response_id: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);
type OutboundRequest = Static<typeof outboundRequestSchema>;
const recordedFailureSchema = Type.Object({
    status: Type.Integer(),
    headers: Type.Record(Type.String(), Type.String()),
    body: Type.Object({
        error: Type.Object({
            code: Type.String(),
            param: Type.String(),
            type: Type.String(),
            message: Type.String(),
        }),
    }),
});

const wire = vi.hoisted(() => ({
    websocketRequests: [] as unknown[],
    websocketFailures: [] as unknown[],
    websocketInstances: 0,
    sseRequests: [] as unknown[],
    sseFailures: [] as Array<{
        status: number;
        code: string;
        param: string;
        type?: string;
        message?: string;
        headers?: Readonly<Record<string, string>>;
    }>,
    sseStreamFailures: [] as Array<{
        code: string;
        param: string;
        type: string;
        before?: unknown[];
    }>,
    abortOnSseFailure: undefined as AbortController | undefined,
}));

// Installation identity is a persisted host file, irrelevant to request program selection.
vi.mock("@/vendors/codex/impl/resolveCodexInstallationId.js", () => ({
    resolveCodexInstallationId: async () => "fake-installation",
}));

vi.mock("openai/resources/responses/ws", () => ({
    ResponsesWS: class FakeResponsesWS {
        readonly socket = { readyState: 1 };
        private messages: Array<{ type: string; message?: unknown; error?: unknown }> = [];
        private resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;

        constructor() {
            wire.websocketInstances += 1;
        }

        send(request: unknown): void {
            wire.websocketRequests.push(structuredClone(request));
            if (!Value.Check(outboundRequestSchema, request)) throw new Error("Bad request shape.");
            const failure = request.generate === false ? undefined : wire.websocketFailures.shift();
            if (failure !== undefined) {
                this.messages.push({ type: "error", error: failure });
                return;
            }
            this.messages.push({
                type: "message",
                message: {
                    type: "response.completed",
                    response: {
                        id: `response-${wire.websocketRequests.length}`,
                        output: [],
                        usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
                    },
                },
            });
        }

        close(): void {
            this.socket.readyState = 3;
            const result = { done: false as const, value: { type: "close", code: 1000 } };
            if (this.resolveNext === undefined) {
                this.messages.push(result.value);
            } else {
                this.resolveNext(result);
                this.resolveNext = undefined;
            }
        }

        on(_event: string, _listener: (error: Error) => void): this {
            return this;
        }
        off(_event: string, _listener: (error: Error) => void): this {
            return this;
        }

        [Symbol.asyncIterator](): AsyncIterator<unknown> {
            return {
                next: async () => {
                    const value = this.messages.shift();
                    if (value !== undefined) return { done: false, value };
                    return await new Promise<IteratorResult<unknown>>((resolve) => {
                        this.resolveNext = resolve;
                    });
                },
                return: async () => ({ done: true, value: undefined }),
            };
        }
    },
}));

let authDirectory: string;

beforeEach(async () => {
    wire.websocketRequests.length = 0;
    wire.websocketFailures.length = 0;
    wire.websocketInstances = 0;
    wire.sseRequests.length = 0;
    wire.sseFailures.length = 0;
    wire.sseStreamFailures.length = 0;
    wire.abortOnSseFailure = undefined;
    authDirectory = await mkdtemp(join(tmpdir(), "codex-access-program-test-"));
    await writeFile(
        join(authDirectory, "auth.json"),
        JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: { access_token: "fake-token", account_id: "fake-account", id_token: null },
        }),
    );
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = input instanceof Request ? await input.text() : String(init?.body);
        const request: unknown = JSON.parse(body);
        wire.sseRequests.push(request);
        const failure = wire.sseFailures.shift();
        if (failure !== undefined) {
            wire.abortOnSseFailure?.abort();
            return new Response(
                new TextEncoder().encode(
                    JSON.stringify({
                        error: {
                            code: failure.code,
                            param: failure.param,
                            type: failure.type ?? "invalid_request_error",
                            message: failure.message ?? "Access program unavailable",
                        },
                    }),
                ),
                {
                    status: failure.status,
                    headers: failure.headers ?? { "content-type": "application/json" },
                },
            );
        }
        const streamed = wire.sseStreamFailures.shift();
        if (streamed !== undefined) {
            const events = [
                ...(streamed.before ?? []),
                {
                    type: "error",
                    code: streamed.code,
                    param: streamed.param,
                    error: { type: streamed.type, code: streamed.code, param: streamed.param },
                    message: "Access program unavailable",
                },
            ];
            return new Response(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
                {
                    headers: { "content-type": "text/event-stream" },
                },
            );
        }
        const response = {
            type: "response.completed",
            response: {
                id: `response-${wire.sseRequests.length}`,
                output: [],
                usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
            },
        };
        return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        });
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(authDirectory, { recursive: true, force: true });
});

async function nativeProvider(options: {
    cyberAccessProgram?: CodexAccessProgram;
    inferenceMaxRetries?: number;
    parallelToolCalls?: boolean;
    transport: "sse" | "websocket";
}): Promise<CodexProvider> {
    const credential = await CodexSessionCredential.tryLoad({
        authFile: join(authDirectory, "auth.json"),
    });
    if (credential === null) throw new Error("Fake native credential was not loaded.");
    return new CodexProvider({
        credential,
        endpoint: "https://codex-test.invalid/backend-api",
        transport: options.transport,
        ...(options.parallelToolCalls === undefined
            ? {}
            : { parallelToolCalls: options.parallelToolCalls }),
        userAgent: "codex-access-program-test",
        inferenceMaxRetries: options.inferenceMaxRetries ?? 0,
        ...(options.cyberAccessProgram === undefined
            ? {}
            : { cyberAccessProgram: options.cyberAccessProgram }),
    });
}

async function runOne(
    session: Awaited<ReturnType<CodexProvider["session"]>>,
    text = "Hello",
    signal?: AbortSignal,
) {
    const events = [];
    for await (const event of session.run(
        signal === undefined ? testContext : testContextWith(signal),
        {
            model: "gpt-6-luna",
            context: {
                instructions: "Test",
                messages: [{ role: "user", content: [{ type: "text", text }] }],
            },
        },
    ))
        events.push(event);
    return events;
}

function captured(transport: "sse" | "websocket"): OutboundRequest[] {
    const requests = transport === "sse" ? wire.sseRequests : wire.websocketRequests;
    return requests.map((request) => {
        expect(Value.Check(outboundRequestSchema, request)).toBe(true);
        if (!Value.Check(outboundRequestSchema, request)) throw new Error("Bad request shape.");
        return request;
    });
}

describe("Codex access programs", () => {
    it.each(["sse", "websocket"] as const)(
        "sends omitted, standard, blue and red programs over %s in both envelope variants",
        async (transport) => {
            for (const parallelToolCalls of [false, true]) {
                for (const selected of [
                    undefined,
                    "standard",
                    "daybreak_blue",
                    "daybreak_red",
                ] as const) {
                    const prior = captured(transport).length;
                    const provider = await nativeProvider({ transport, parallelToolCalls });
                    const session = await provider.session(
                        `session-${parallelToolCalls}-${selected}`,
                        {
                            instructions: "Test",
                            tools: [],
                            ...(selected === undefined ? {} : { cyberAccessProgram: selected }),
                        },
                    );
                    try {
                        expect((await runOne(session)).at(-1)).toMatchObject({
                            type: "done",
                            state: "normal",
                        });
                    } finally {
                        await session.destroy();
                    }
                    const last = captured(transport).at(-1);
                    expect(last?.access_programs).toEqual(
                        selected === undefined ? undefined : { cyber: selected },
                    );
                    expect(Reflect.get(last ?? {}, "tools") === undefined).toBe(!parallelToolCalls);
                    if (transport === "websocket") {
                        const frames = captured(transport).slice(prior);
                        expect(frames[0]?.generate).toBe(false);
                        expect(frames[0]?.access_programs).toEqual(last?.access_programs);
                    }
                }
            }
        },
    );

    it("keeps session overrides and sibling selections independent", async () => {
        const provider = await nativeProvider({
            transport: "sse",
            cyberAccessProgram: "daybreak_blue",
        });
        const ordinary = await provider.session("ordinary", {
            instructions: "Test",
            tools: [],
            cyberAccessProgram: "standard",
        });
        const blue = await provider.session("blue", { instructions: "Test", tools: [] });
        const red = await provider.session("red", {
            instructions: "Test",
            tools: [],
            cyberAccessProgram: "daybreak_red",
        });
        try {
            for (const session of [ordinary, blue, red]) {
                expect((await runOne(session)).at(-1)).toMatchObject({
                    type: "done",
                    state: "normal",
                });
            }
            expect(captured("sse").map((request) => request.access_programs?.cyber)).toEqual([
                "standard",
                "daybreak_blue",
                "daybreak_red",
            ]);
        } finally {
            await Promise.all([ordinary.destroy(), blue.destroy(), red.destroy()]);
        }
    });

    it("rejects unknown selections and explicit programs without ChatGPT session auth", async () => {
        const provider = await nativeProvider({ transport: "sse" });
        await expect(
            provider.session("bad", {
                instructions: "Test",
                tools: [],
                // @ts-expect-error Exercise validation for untyped callers.
                cyberAccessProgram: "other",
            }),
        ).rejects.toThrow(/access program/i);
        await expect(
            provider.session("null", {
                instructions: "Test",
                // @ts-expect-error Null is not an omitted selection.
                cyberAccessProgram: null,
            }),
        ).rejects.toThrow(/access program/i);
        const key = await CodexApiKeyCredential.tryLoad({ apiKey: "fake-key" });
        if (key === null) throw new Error("Fake API key was not loaded.");
        expect(
            () => new CodexProvider({ credential: key, cyberAccessProgram: "standard" }),
        ).toThrow(/ChatGPT Codex session/i);
        await expect(
            new CodexProvider({ credential: key }).session("key", {
                instructions: "Test",
                tools: [],
                cyberAccessProgram: "daybreak_red",
            }),
        ).rejects.toThrow(/ChatGPT Codex session/i);
        const bedrock = await BedrockBearerTokenCredential.tryLoad({ bearerToken: "fake-bedrock" });
        if (bedrock === null) throw new Error("Fake Bedrock token was not loaded.");
        expect(
            () => new CodexProvider({ credential: bedrock, cyberAccessProgram: "daybreak_blue" }),
        ).toThrow(/ChatGPT Codex session/i);
        await expect(
            new CodexProvider({ credential: bedrock }).session("bedrock", {
                instructions: "Test",
                tools: [],
                cyberAccessProgram: "standard",
            }),
        ).rejects.toThrow(/ChatGPT Codex session/i);
        expect(captured("sse")).toEqual([]);
    });

    it("falls back from unavailable blue once and keeps explicit standard on the next turn", async () => {
        const recorded: unknown = JSON.parse(
            await readFile(
                new URL("./vendors/fixtures/codexAccessProgramUnavailable.json", import.meta.url),
                "utf8",
            ),
        );
        if (!Value.Check(recordedFailureSchema, recorded))
            throw new Error("Invalid recorded response.");
        wire.sseFailures.push({
            status: recorded.status,
            headers: recorded.headers,
            ...recorded.body.error,
        });
        const provider = await nativeProvider({
            transport: "sse",
            cyberAccessProgram: "daybreak_blue",
            inferenceMaxRetries: 1,
        });
        const session = await provider.session("fallback", { instructions: "Test", tools: [] });
        try {
            const events = await runOne(session);
            expect(
                events.some(
                    (event) =>
                        event.type === "retrying" && /blue|standard/i.test(JSON.stringify(event)),
                ),
            ).toBe(true);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect((await runOne(session, "Next")).at(-1)).toMatchObject({
                type: "done",
                state: "normal",
            });
            expect(captured("sse").map((request) => request.access_programs?.cyber)).toEqual([
                "daybreak_blue",
                "standard",
                "standard",
            ]);
        } finally {
            await session.destroy();
        }
    });

    it("falls back from unavailable red after WebSocket warmup, discarding its previous response chain", async () => {
        const programError = {
            type: "invalid_request_error",
            code: "invalid_access_program",
            param: "access_programs.cyber",
            message: "Access program unavailable",
        };
        const frame = { type: "error", error: programError, sequence_number: 1 };
        wire.websocketFailures.push(new WebSocketError(JSON.stringify(frame), frame as never));
        const provider = await nativeProvider({
            transport: "websocket",
            cyberAccessProgram: "daybreak_red",
            inferenceMaxRetries: 1,
        });
        const red = await provider.session("red-fallback", { instructions: "Test", tools: [] });
        const blue = await provider.session("blue-sibling", {
            instructions: "Test",
            tools: [],
            cyberAccessProgram: "daybreak_blue",
        });
        try {
            const events = await runOne(red);
            expect(
                events.some(
                    (event) =>
                        event.type === "retrying" && /red|standard/i.test(JSON.stringify(event)),
                ),
            ).toBe(true);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect((await runOne(red, "Next")).at(-1)).toMatchObject({
                type: "done",
                state: "normal",
            });
            expect((await runOne(blue)).at(-1)).toMatchObject({ type: "done", state: "normal" });
            const inference = captured("websocket").filter((request) => request.generate !== false);
            expect(inference.map((request) => request.access_programs?.cyber)).toEqual([
                "daybreak_red",
                "standard",
                "standard",
                "daybreak_blue",
            ]);
            expect(inference[1]?.previous_response_id).not.toBe(inference[0]?.previous_response_id);
            expect(inference[1]?.input).toEqual(inference[0]?.input);
            expect(wire.websocketInstances).toBeGreaterThan(1);
        } finally {
            await Promise.all([red.destroy(), blue.destroy()]);
        }
    });

    it.each([
        {
            code: "invalid_access_program",
            param: "access_programs.cyber",
            status: 403,
            type: "invalid_request_error",
            selected: "standard" as const,
        },
        {
            code: "policy_code",
            param: "access_programs.cyber",
            status: 400,
            type: "policy_error",
            selected: "daybreak_blue" as const,
        },
        {
            code: "invalid_access_program",
            param: "access_programs.cyber",
            status: 400,
            type: "policy_error",
            selected: "daybreak_blue" as const,
        },
        {
            code: "invalid_request_error",
            param: "access_programs.cyber",
            status: 400,
            type: "invalid_request_error",
            selected: "daybreak_blue" as const,
        },
        {
            code: "usage_limit_reached",
            param: "access_programs.cyber",
            status: 403,
            type: "insufficient_quota",
            selected: "daybreak_red" as const,
        },
        {
            code: "invalid_access_program",
            param: "model",
            status: 400,
            type: "invalid_request_error",
            selected: "daybreak_blue" as const,
        },
        {
            code: "invalid_access_program",
            param: "access_programs.cyber",
            status: 401,
            type: "invalid_request_error",
            selected: "daybreak_blue" as const,
        },
        {
            code: "invalid_access_program",
            param: "access_programs.cyber",
            status: 429,
            type: "invalid_request_error",
            selected: "daybreak_red" as const,
        },
    ])(
        "does not mask a $code rejection for $selected",
        async ({ code, param, status, type, selected }) => {
            wire.sseFailures.push({ code, param, status, type });
            const provider = await nativeProvider({ transport: "sse", inferenceMaxRetries: 1 });
            const session = await provider.session("terminal", {
                instructions: "Test",
                tools: [],
                cyberAccessProgram: selected,
            });
            try {
                const events = await runOne(session);
                expect(events.at(-1)).toMatchObject({ type: "done" });
                expect(
                    events.some(
                        (event) =>
                            event.type === "retrying" && /standard/i.test(JSON.stringify(event)),
                    ),
                ).toBe(false);
                expect(
                    captured("sse").every((request) => request.access_programs?.cyber === selected),
                ).toBe(true);
            } finally {
                await session.destroy();
            }
        },
    );

    it("does not spend an unavailable-program fallback when the retry budget is zero", async () => {
        wire.sseFailures.push({
            status: 400,
            code: "invalid_access_program",
            param: "access_programs.cyber",
        });
        const provider = await nativeProvider({
            transport: "sse",
            cyberAccessProgram: "daybreak_blue",
        });
        const session = await provider.session("no-budget", { instructions: "Test", tools: [] });
        try {
            const events = await runOne(session);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
            expect(captured("sse").map((request) => request.access_programs?.cyber)).toEqual([
                "daybreak_blue",
            ]);
        } finally {
            await session.destroy();
        }
    });

    it("never falls back twice when Standard is rejected after Blue", async () => {
        wire.sseFailures.push(
            { status: 400, code: "invalid_access_program", param: "access_programs.cyber" },
            { status: 400, code: "invalid_access_program", param: "access_programs.cyber" },
        );
        const provider = await nativeProvider({
            transport: "sse",
            cyberAccessProgram: "daybreak_blue",
            inferenceMaxRetries: 3,
        });
        const session = await provider.session("standard-rejected", {
            instructions: "Test",
            tools: [],
        });
        try {
            const events = await runOne(session);
            expect(
                events.filter(
                    (event) =>
                        event.type === "retrying" && /Standard access/.test(JSON.stringify(event)),
                ),
            ).toHaveLength(1);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
            expect(captured("sse").map((request) => request.access_programs?.cyber)).toEqual([
                "daybreak_blue",
                "standard",
            ]);
        } finally {
            await session.destroy();
        }
    });

    it("does not fall back after cancellation of a rejected request", async () => {
        wire.sseFailures.push({
            status: 400,
            code: "invalid_access_program",
            param: "access_programs.cyber",
        });
        const controller = new AbortController();
        wire.abortOnSseFailure = controller;
        const provider = await nativeProvider({
            transport: "sse",
            cyberAccessProgram: "daybreak_blue",
            inferenceMaxRetries: 2,
        });
        const session = await provider.session("cancelled", { instructions: "Test", tools: [] });
        try {
            const events = await runOne(session, "Hello", controller.signal);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "cancelled" });
            expect(captured("sse").map((request) => request.access_programs?.cyber)).toEqual([
                "daybreak_blue",
            ]);
        } finally {
            await session.destroy();
        }
    });

    it("preserves the parameter on an SSE streaming error before output", async () => {
        wire.sseStreamFailures.push({
            code: "invalid_access_program",
            param: "access_programs.cyber",
            type: "invalid_request_error",
        });
        const provider = await nativeProvider({
            transport: "sse",
            cyberAccessProgram: "daybreak_red",
            inferenceMaxRetries: 1,
        });
        const session = await provider.session("stream-rejection", {
            instructions: "Test",
            tools: [],
        });
        try {
            const events = await runOne(session);
            expect(
                events.some(
                    (event) => event.type === "retrying" && /Red/.test(JSON.stringify(event)),
                ),
            ).toBe(true);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(captured("sse").map((request) => request.access_programs?.cyber)).toEqual([
                "daybreak_red",
                "standard",
            ]);
        } finally {
            await session.destroy();
        }
    });

    it.each([
        {
            name: "text",
            before: [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { id: "text-1", type: "message", role: "assistant", content: [] },
                },
                {
                    type: "response.output_text.delta",
                    output_index: 0,
                    content_index: 0,
                    item_id: "text-1",
                    delta: "Visible text",
                },
            ],
        },
        {
            name: "tool call",
            before: [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        id: "tool-1",
                        type: "function_call",
                        call_id: "call-1",
                        name: "exec_command",
                        arguments: "",
                    },
                },
                {
                    type: "response.function_call_arguments.delta",
                    output_index: 0,
                    item_id: "tool-1",
                    delta: '{"cmd":',
                },
            ],
        },
    ])("does not change to Standard after $name has started", async ({ before }) => {
        wire.sseStreamFailures.push({
            code: "invalid_access_program",
            param: "access_programs.cyber",
            type: "invalid_request_error",
            before,
        });
        const provider = await nativeProvider({
            transport: "sse",
            cyberAccessProgram: "daybreak_blue",
            inferenceMaxRetries: 1,
        });
        const session = await provider.session("partial-output", {
            instructions: "Test",
            tools: [],
        });
        try {
            const events = await runOne(session);
            expect(
                events.some(
                    (event) =>
                        event.type !== "done" &&
                        event.type !== "block_start" &&
                        event.type !== "block_stop" &&
                        event.type !== "block_reset",
                ),
            ).toBe(true);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
            expect(captured("sse").map((request) => request.access_programs?.cyber)).toEqual([
                "daybreak_blue",
            ]);
        } finally {
            await session.destroy();
        }
    });
});
