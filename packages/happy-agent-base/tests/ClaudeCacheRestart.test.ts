import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    AnthropicProvider,
    ClaudeAuthTokenCredential,
    resolveClaudeCodeExecutablePath,
    type SessionEvent,
} from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it } from "vitest";

import { openClaudeRestartGym } from "./gym/openClaudeRestartGym.js";

const requestSchema = Type.Object({
    system: Type.Array(Type.Unknown()),
    tools: Type.Array(Type.Unknown()),
    messages: Type.Array(
        Type.Object({
            role: Type.String(),
            content: Type.Union([
                Type.String(),
                Type.Array(Type.Record(Type.String(), Type.Unknown())),
            ]),
        }),
    ),
});

it("replays signed reasoning and the cacheable prefix after Agent Base and SQLite restart", async () => {
    const ctx = createRootContext().named("claude-cache-restart-test");
    const directory = await mkdtemp(join(tmpdir(), "agent-base-claude-cache-"));
    const requests: ReturnType<typeof parseRequest>[] = [];
    const server = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
            response.writeHead(404).end();
            return;
        }
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requests.push(parseRequest(Buffer.concat(chunks).toString("utf8")));
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(thinkingResponse(requests.length));
        } catch {
            response.writeHead(400).end("Invalid test request");
        }
    });
    let gym: Awaited<ReturnType<typeof openClaudeRestartGym>> | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port");
        const credential = await ClaudeAuthTokenCredential.tryLoad({
            authToken: "test-only-token",
        });
        if (credential === null) throw new Error("Missing test credential");
        const open = () =>
            openClaudeRestartGym(ctx, {
                databasePath: join(directory, "agent.sqlite"),
                instructions: "Keep the prompt and signed reasoning stable across turns.",
                model: "anthropic/fable-5-1",
                provider: new AnthropicProvider({
                    credential,
                    inferenceMaxRetries: 0,
                    pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
                    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}` },
                }),
            });
        gym = await open();
        expectSuccessful(await gym.ask("First turn."));
        expectSuccessful(await gym.ask("Continue without restarting."));
        const beforeRestart = await gym.records();
        expect(
            beforeRestart.filter(
                (record) => record.type === "block" && record.block.type === "reasoning",
            ),
        ).toEqual(
            [1, 2].map((turn) => ({
                type: "block",
                block: {
                    type: "reasoning",
                    text: `Reasoning ${turn}`,
                    reasoning: `SIGNED_REASONING_${turn}`,
                },
            })),
        );

        await gym.close();
        gym = undefined;
        gym = await open();
        expect(await gym.records()).toEqual(beforeRestart);
        const resumedEvents = await gym.ask("Continue after restarting.");
        expectSuccessful(resumedEvents);
        expect(requests).toHaveLength(3);
        const continued = requests[1]!;
        const restarted = requests[2]!;
        expect(restarted.system).toEqual(continued.system);
        expect(restarted.tools).toEqual(continued.tools);
        expect(restarted.system).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "1h" } }),
            ]),
        );
        // The old live tail becomes history when the new user turn is appended.
        expect(restarted.messages.slice(0, continued.messages.length - 1)).toEqual(
            continued.messages.slice(0, -1),
        );
        expect(restarted.messages.filter((message) => message.role === "assistant")).toEqual(
            [1, 2].map((turn) => ({
                role: "assistant",
                content: [
                    {
                        type: "thinking",
                        thinking: `Reasoning ${turn}`,
                        signature: `SIGNED_REASONING_${turn}`,
                    },
                    { type: "text", text: `Answer ${turn}` },
                ],
            })),
        );
        // Synthetic usage checks accounting only; a live test is needed to prove backend hits.
        expect(resumedEvents.filter((event) => event.type === "token_usage").at(-1)).toMatchObject({
            usage: { cacheRead: 4096, cacheWrite: 0, input: 4106, output: 20 },
        });
    } finally {
        await gym?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);

function parseRequest(body: string) {
    return Value.Parse(requestSchema, JSON.parse(body));
}

function expectSuccessful(events: readonly SessionEvent[]) {
    expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
}

function thinkingResponse(turn: number): string {
    const events = [
        {
            type: "message_start",
            message: {
                id: `msg_cache_${turn}`,
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 10,
                    output_tokens: 1,
                    cache_creation_input_tokens: turn === 1 ? 4096 : 0,
                    cache_read_input_tokens: turn === 1 ? 0 : 4096,
                },
            },
        },
        {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: `Reasoning ${turn}` },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: `SIGNED_REASONING_${turn}` },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: `Answer ${turn}` },
        },
        { type: "content_block_stop", index: 1 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
    ];
    return events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
}
