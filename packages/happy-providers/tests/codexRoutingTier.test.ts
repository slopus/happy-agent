import { createServer } from "node:http";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { expect, it, vi } from "vitest";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { collectSessionEvents } from "./helpers/collectSessionEvents.js";
import { testContext } from "./testContext.js";

const requestSchema = Type.Object({
    service_tier: Type.Optional(Type.String()),
    generate: Type.Optional(Type.Boolean()),
});

it("does not send ChatGPT routing hints to API-key endpoints", async () => {
    const requests: Request[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        requests.push(new Request(input, init));
        const item = {
            id: "message",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
        };
        return new Response(
            [
                { type: "response.output_item.done", output_index: 0, item },
                {
                    type: "response.completed",
                    response: {
                        id: "response",
                        output: [item],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                },
            ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
            { headers: { "content-type": "text/event-stream" } },
        );
    });
    const session = await new CodexProvider({
        credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
        endpoint: "https://api.example.test/v1",
        model: "gpt-6-astra",
        transport: "sse",
        inferenceMaxRetries: 0,
    }).session("api-key-routing-test", { instructions: "Test", tools: [] });
    try {
        await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "Test",
                    messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
                },
                serviceTier: "ultrafast",
            }),
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]!.headers.has("x-codex-routing-hint")).toBe(false);
        expect(await requests[0]!.json()).toMatchObject({ service_tier: "ultrafast" });
    } finally {
        await session.destroy();
        fetchSpy.mockRestore();
    }
});

it("routes each Codex speed over SSE, including a Regular reset", async () => {
    const received: { hint: string | undefined; tier: string | undefined }[] = [];
    const reply = (warmup = false) => {
        const item = {
            id: "message",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            status: "completed",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
        };
        return [
            ...(warmup ? [] : [{ type: "response.output_item.done", output_index: 0, item }]),
            {
                type: "response.completed",
                response: {
                    id: `response-${received.length}`,
                    output: warmup ? [] : [item],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            },
        ];
    };
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Value.Parse(requestSchema, JSON.parse(Buffer.concat(chunks).toString()));
        received.push({
            hint: request.headers["x-codex-routing-hint"]?.toString(),
            tier: body.service_tier,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
            reply()
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    const session = await new CodexProvider({
        credential: {
            name: "codex-session",
            credential: { accessToken: "test", accountId: "test" },
        } as never,
        endpoint: `http://127.0.0.1:${address.port}`,
        model: "gpt-6-astra",
        transport: "sse",
        inferenceMaxRetries: 0,
    }).session("routing-tier-test", { instructions: "Test", tools: [] });
    try {
        for (const tier of [undefined, "priority", "ultrafast", undefined]) {
            const events = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: "Test",
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: `Turn ${received.length}` }],
                            },
                        ],
                    },
                    ...(tier === undefined ? {} : { serviceTier: tier }),
                }),
            );
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        }
        expect(received).toEqual([
            { hint: "model=gpt-6-astra", tier: undefined },
            { hint: "model=gpt-6-astra;tier=priority", tier: "priority" },
            { hint: "model=gpt-6-astra;tier=ultrafast", tier: "ultrafast" },
            { hint: "model=gpt-6-astra", tier: undefined },
        ]);
    } finally {
        await session.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});
