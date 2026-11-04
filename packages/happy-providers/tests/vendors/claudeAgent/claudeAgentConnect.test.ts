import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, expect, it } from "vitest";

import type { AcpConnection } from "@/protocol/acp/AcpConnection.js";
import { claudeAgentConnect } from "@/vendors/claudeAgent/claudeAgentConnect.js";

const SUMMARY = "SUMMARY OF EVERYTHING SO FAR";

const servers: Server[] = [];
const connections: AcpConnection[] = [];
afterEach(() => {
    for (const connection of connections.splice(0)) connection.terminate();
    for (const server of servers.splice(0)) server.close();
});

/**
 * Anthropic's Messages API as far as Claude Code needs it. Every prompt is `cached()` tokens of
 * cache plus 10 uncached ones until Claude Code compacts it to 5k; past 200k it is refused as the
 * real API refuses it.
 */
async function fakeMessagesApi(cached: () => number) {
    let summaries = 0;
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
                response.writeHead(404).end();
                return;
            }
            const summarizing = body.includes("Your task is to create a detailed summary");
            const prompt = summarizing || body.includes(SUMMARY) ? 5_000 : cached();
            if (prompt > 200_000) {
                response.writeHead(400, { "content-type": "application/json" }).end(
                    JSON.stringify({
                        type: "error",
                        error: { type: "invalid_request_error", message: "prompt is too long" },
                    }),
                );
                return;
            }
            if (summarizing) summaries++;
            const text = summarizing ? `<summary>${SUMMARY}</summary>` : "ok";
            const events = [
                {
                    type: "message_start",
                    message: {
                        id: `msg_${Math.random()}`,
                        type: "message",
                        role: "assistant",
                        model: "claude-sonnet-4-5",
                        content: [],
                        stop_reason: null,
                        usage: {
                            input_tokens: 10,
                            cache_read_input_tokens: prompt,
                            cache_creation_input_tokens: 0,
                            output_tokens: 1,
                        },
                    },
                },
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
                { type: "content_block_stop", index: 0 },
                {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 7 },
                },
                { type: "message_stop" },
            ];
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of events) {
                response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            response.end();
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        summaries: () => summaries,
    };
}

it("lets Claude Code compact its own context and reports the context it fills", async () => {
    let cached = 30_000;
    const api = await fakeMessagesApi(() => cached);
    const directory = mkdtempSync(join(tmpdir(), "claude-agent-connect-"));
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    } as acp.Client);
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    const turn = async (text: string) =>
        (await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text }] })).usage;

    expect((await turn("first"))?.inputTokens).toBe(30_010);
    cached = 230_000;
    expect((await turn("second"))?.inputTokens).toBe(5_010);
    expect(api.summaries()).toBe(1);
}, 120_000);
