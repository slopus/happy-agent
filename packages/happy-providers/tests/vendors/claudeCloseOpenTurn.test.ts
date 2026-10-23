import { testContext } from "../testContext.js";

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { query as claudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";

/**
 * A session closed while Claude Code waits on a tool result must not let the CLI ask the model
 * again. Ending its input alone makes Claude Code answer the open call as interrupted and send one
 * more request before the SDK terminates it. This drives the real SDK against a local server and
 * counts what actually reaches the API.
 */
describe("Claude session closed during an open tool call", () => {
    it("sends no further request after the session is destroyed", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-claude-close-"));
        let requests = 0;
        const server = createServer(async (request, response) => {
            if (
                request.method !== "POST" ||
                !request.url?.startsWith("/v1/messages") ||
                request.url.includes("/count_tokens")
            ) {
                response.writeHead(404, { "content-type": "application/json" });
                response.end('{"type":"error","error":{"type":"not_found_error"}}');
                return;
            }
            await readBody(request);
            requests += 1;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(requests === 1 ? TOOL_RESPONSE : TEXT_RESPONSE);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing Claude close server port.");
        }
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "close-token" });
        if (credential === null) throw new Error("Expected a Claude test credential.");
        const session = new ClaudeSession("<SESSION_ID>", {
            instructions: "You are a careful engineer.",
            credential,
            cwd,
            env: {
                ...process.env,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
                CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
                TZ: "UTC",
            },
            model: "anthropic/opus-5-5",
            query: claudeSdkQuery,
            tools: [{ name: "Read", description: "Read a file." }],
        });
        try {
            const events: SessionEvent[] = [];
            for await (const event of session.run(testContext, {
                context: {
                    instructions: "You are a careful engineer.",
                    messages: [{ role: "user", content: [{ type: "text", text: "Read it." }] }],
                },
            })) {
                events.push(event);
            }
            expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });

            session.destroy();
            // The SDK gives a closed CLI two seconds before terminating it; wait past that.
            await new Promise((resolve) => setTimeout(resolve, 3_500));

            expect(requests).toBe(1);
        } finally {
            session.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(cwd, { force: true, recursive: true });
        }
    }, 20_000);
});

const TOOL_RESPONSE = toSse([
    {
        type: "message_start",
        message: {
            id: "msg_close_tool",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
        },
    },
    {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_close", name: "Read", input: {} },
    },
    {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/workspace/NOTES.md"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
]);

const TEXT_RESPONSE = toSse([
    {
        type: "message_start",
        message: {
            id: "msg_close_text",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
        },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
]);

function toSse(events: readonly unknown[]): string {
    return events
        .map(
            (event) =>
                `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
}

function readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.once("end", () => resolve(Buffer.concat(chunks)));
        request.once("error", reject);
    });
}
