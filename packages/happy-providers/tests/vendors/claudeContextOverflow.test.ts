import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionMessage } from "@/core/SessionContext.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { testContext } from "../testContext.js";

describe("Claude context limits through the real SDK", () => {
    const sessions: ClaudeSession[] = [];
    const servers: Server[] = [];

    afterEach(async () => {
        for (const session of sessions.splice(0)) session.destroy();
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.closeAllConnections();
                        server.close(() => resolve());
                    }),
            ),
        );
    });

    it.each(["anthropic/fable-5-1", "claude-fable-5-1[1m]"])(
        "continues %s after a 235k-token response",
        { timeout: 30_000 },
        async (model) => {
            let requests = 0;
            const session = await createSession((response) => {
                requests += 1;
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.end(successResponse());
            }, model);
            const messages: SessionMessage[] = [
                { role: "user", content: [{ type: "text", text: "Start." }] },
            ];
            const first = await run(session, messages);
            expect(first.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(first).toContainEqual(
                expect.objectContaining({
                    type: "token_usage",
                    usage: expect.objectContaining({ input: 235_170 }),
                }),
            );
            messages.push(
                { role: "assistant", content: [{ type: "text", text: "Ready." }] },
                { role: "user", content: [{ type: "text", text: "Continue." }] },
            );
            const second = await run(session, messages);
            expect(
                second.at(-1),
                JSON.stringify({ requests, outcome: second.at(-1) }),
            ).toMatchObject({ type: "done", state: "normal" });
            expect(requests).toBe(2);
        },
    );

    it(
        "reports an HTTP prompt overflow once without committing assistant text",
        { timeout: 30_000 },
        async () => {
            let requests = 0;
            const session = await createSession((response) => {
                requests += 1;
                response.writeHead(400, {
                    "content-type": "application/json",
                    "request-id": "overflow-test",
                });
                response.end(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "invalid_request_error",
                            message: "prompt is too long: 1000001 tokens > 1000000 maximum",
                        },
                    }),
                );
            });
            const events = await run(session, [
                { role: "user", content: [{ type: "text", text: "Overflow." }] },
            ]);
            expect(events.filter((event) => event.type.startsWith("text_"))).toEqual([]);
            expect(events.filter((event) => event.type === "done")).toEqual([
                expect.objectContaining({
                    type: "done",
                    state: "error",
                    kind: "context_overflow",
                    message: "Prompt is too long",
                }),
            ]);
            // Claude owns its streaming-to-non-streaming fallback. Both HTTP failures must
            // still become one terminal event, never a completed assistant text block.
            expect(requests).toBe(2);
        },
    );

    async function createSession(
        respond: (response: import("node:http").ServerResponse) => void,
        model = "anthropic/fable-5-1",
    ): Promise<ClaudeSession> {
        const server = createServer((request, response) => {
            request.resume();
            if (request.method === "POST" && request.url?.split("?")[0] === "/v1/messages") {
                respond(response);
            } else {
                response.writeHead(404, { "content-type": "application/json" });
                response.end('{"type":"error","error":{"type":"not_found_error"}}');
            }
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port.");
        const credential = await ClaudeAuthTokenCredential.tryLoad({
            authToken: "test-only-token",
        });
        if (credential === null) throw new Error("Expected a test credential.");
        const session = new ClaudeSession("claude-overflow-transport", {
            instructions: "",
            credential,
            env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}` },
            model,
            tools: [],
        });
        sessions.push(session);
        return session;
    }
});

async function run(session: ClaudeSession, messages: SessionMessage[]): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of session.run(testContext, {
        context: { instructions: "", messages },
    })) {
        events.push(event);
    }
    return events;
}

function successResponse(): string {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg_large_context",
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 235_170,
                    output_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready." } },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
    ];
    return events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
}
