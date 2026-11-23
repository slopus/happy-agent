import { testContext } from "../testContext.js";

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";

/**
 * A session may refuse the provider's retry budget.
 *
 * Retries belong to the provider, and a conversation is right to sit through them. A bounded
 * request made on the side of somebody's turn is not: it holds a tool call open for every attempt
 * and the person watching learns nothing until the last one fails. So the caller opening that
 * session names its own budget, and the provider honors it instead of its own.
 */
describe("session retry budget", () => {
    const servers: Server[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => resolve());
                    }),
            ),
        );
    });

    it("sends one request when the session refuses retries", async () => {
        const { events, requests } = await run({ inferenceMaxRetries: 0 });

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "internal_server_error" },
        });
    });

    it("keeps the provider's own budget when the session names none", async () => {
        const { events, requests } = await run({});

        expect(requests).toBe(3);
        expect(events).toContainEqual(expect.objectContaining({ type: "retrying", attempt: 1 }));
    });

    it("falls back from WebSocket 405 to SSE even when inferenceMaxRetries is 0", async () => {
        let sseRequests = 0;
        let wsUpgrades = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain request body.
            }
            sseRequests += 1;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                [
                    'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1,"model":"gpt-5.6-luna","status":"in_progress","output":[]}}\n\n',
                    'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
                    'event: response.content_part.added\ndata: {"type":"response.content_part.added","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"OK"}\n\n',
                    'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":4,"item_id":"msg_1","output_index":0,"content_index":0,"text":"OK"}\n\n',
                    'event: response.content_part.done\ndata: {"type":"response.content_part.done","sequence_number":5,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"OK","annotations":[]}}\n\n',
                    'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}}\n\n',
                    'event: response.completed\ndata: {"type":"response.completed","sequence_number":7,"response":{"id":"resp_1","object":"response","created_at":1,"model":"gpt-5.6-luna","status":"completed","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n',
                ].join(""),
            );
        });
        server.on("upgrade", (_request, socket) => {
            wsUpgrades += 1;
            socket.write("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
            socket.destroy();
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        const provider = new CodexProvider({
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            inferenceMaxRetries: 2,
            model: "gpt-5.6-luna",
            transport: "auto",
            userAgent: "rig-test",
        });
        const session = await provider.session("verify-fallback", {
            inferenceMaxRetries: 0,
            instructions: "Reply with OK.",
            tools: [],
        });
        const events: SessionEvent[] = [];
        try {
            for await (const event of session.run(testContext, {
                context: {
                    instructions: "Reply with OK.",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Reply with OK." }],
                        },
                    ],
                },
                effort: "low",
            })) {
                events.push(event);
            }
        } finally {
            session.destroy();
        }

        expect(wsUpgrades).toBe(1);
        expect(sseRequests).toBe(1);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    async function run(sessionOptions: {
        inferenceMaxRetries?: number;
    }): Promise<{ events: SessionEvent[]; requests: number }> {
        let requests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            requests += 1;
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "The server had an error." } }));
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        const provider = new CodexProvider({
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            // Two retries make the difference between an honored budget and the provider's own
            // visible without spending a long backoff on it.
            inferenceMaxRetries: 2,
            model: "gpt-5.6-sol",
            transport: "sse",
            userAgent: "rig-test",
            waitForInferenceRetry: async () => {
                // The schedule itself is covered elsewhere; this test counts attempts.
            },
        });
        const session = await provider.session("session-retry-budget", {
            ...sessionOptions,
            instructions: "Be brief.",
            tools: [],
        });
        const events: SessionEvent[] = [];
        try {
            for await (const event of session.run(testContext, {
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
            })) {
                events.push(event);
            }
        } finally {
            session.destroy();
        }
        return { events, requests };
    }
});
