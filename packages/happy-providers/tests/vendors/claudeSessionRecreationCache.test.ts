import { testContext } from "../testContext.js";

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { query as claudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";

import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";

/**
 * Anthropic addresses its cache by prefix content, so a session that is destroyed and rebuilt only
 * keeps its cache if it reproduces the very same bytes. Rebuilding replays the conversation instead
 * of continuing the live one, which is where a turn can quietly lose the reasoning it was signed
 * with. These tests compare the request a rebuilt session sends against the request the surviving
 * session sends for the same turn: equal prefixes hit, and any dropped block shows up as a diff.
 */
describe("Claude session recreation cache", () => {
    it("preserves the replayable cache prefix and lets the SDK project reasoning", async () => {
        await withServer(async (harness) => {
            const liveSession = harness.session();
            const first = await harness.run(liveSession, [user("Refactor the parser.")]);
            const replayed = replayContext(first.events);
            const originalHistory = structuredClone(replayed);

            // The surviving session continues its live query; the rebuilt one has to replay.
            const continued = await harness.run(liveSession, [
                ...replayed,
                user("Now update the tests."),
            ]);
            liveSession.destroy();
            const recreated = await harness.run(harness.session(), [
                ...replayed,
                user("Now update the tests."),
            ]);

            expect(reasoningBlocks(continued.request)).toHaveLength(1);
            expect(reasoningBlocks(recreated.request)).toHaveLength(0);
            expect(cachePrefixWithoutReasoning(recreated.request)).toEqual(
                cachePrefixWithoutReasoning(continued.request),
            );
            expect(replayed).toEqual(originalHistory);
        });
    }, 15_000);

    it("restarts the real SDK query when caller-owned reasoning diverges", async () => {
        await withServer(async (harness) => {
            const session = harness.session();
            const first = await harness.run(session, [user("Refactor the parser.")]);
            const original = replayContext(first.events);
            const assistant = original[1];
            if (assistant?.role !== "assistant") throw new Error("Expected assistant history.");

            const restarted = await harness.run(session, [
                original[0]!,
                {
                    ...assistant,
                    content: assistant.content.map((block) =>
                        block.type === "reasoning"
                            ? {
                                  type: "reasoning" as const,
                                  text: "CALLER_EDITED_REASONING",
                                  reasoning: "GOLDEN_SIGNATURE",
                              }
                            : block,
                    ),
                },
                user("Now update the tests."),
            ]);
            const wireMessages = JSON.stringify(restarted.request.messages);

            expect(reasoningBlocks(restarted.request)).toHaveLength(0);
            expect(wireMessages).not.toContain("The parser entry point is misnamed.");
            expect(wireMessages).toContain("Now update the tests.");
        });
    }, 15_000);
});

function user(content: string): SessionMessage {
    return { role: "user", content: [{ type: "text", text: content }] };
}

/** Rebuilds the transcript the way the caller does, from the events the run emitted. */
function replayContext(events: readonly SessionEvent[]): SessionMessage[] {
    const assistant = assistantMessageFromEvents(events);
    if (assistant === undefined) throw new Error("Missing reconstructed assistant message.");
    return [user("Refactor the parser."), assistant];
}

interface CapturedRequest {
    messages: Array<{ role: string; content: unknown }>;
    system: unknown;
    tools: unknown;
}

function cachePrefixWithoutReasoning(request: CapturedRequest) {
    return {
        system: request.system,
        tools: request.tools,
        messages: request.messages.map((message) => ({
            ...message,
            content: Array.isArray(message.content)
                ? message.content.filter((block) => !isReasoningBlock(block))
                : message.content,
        })),
    };
}

function reasoningBlocks(request: CapturedRequest): unknown[] {
    return request.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter(isReasoningBlock) : [],
    );
}

function isReasoningBlock(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        (value.type === "thinking" || value.type === "redacted_thinking")
    );
}

async function withServer(
    scenario: (harness: {
        run: (
            session: ClaudeSession,
            messages: SessionMessage[],
        ) => Promise<{ events: SessionEvent[]; request: CapturedRequest }>;
        session: () => ClaudeSession;
    }) => Promise<void>,
): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "rig-claude-recreation-"));
    const requests: CapturedRequest[] = [];
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
        requests.push(JSON.parse((await readBody(request)).toString("utf8")) as CapturedRequest);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(THINKING_RESPONSE);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Claude recreation server port.");
    }
    const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "recreation-token" });
    if (credential === null) throw new Error("Expected a Claude test credential.");
    const env = {
        ...process.env,
        ANTHROPIC_API_KEY: "must-be-cleared",
        CLAUDE_CODE_OAUTH_TOKEN: "must-also-be-cleared",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
        TZ: "UTC",
    };
    const sessions: ClaudeSession[] = [];
    try {
        await scenario({
            run: async (session, messages) => {
                const events: SessionEvent[] = [];
                for await (const event of session.run(testContext, {
                    context: {
                        instructions: "You are a careful engineer.",
                        messages,
                    },
                })) {
                    events.push(event);
                }
                const request = requests.at(-1);
                if (request === undefined) throw new Error("The run sent no request.");
                return { events, request };
            },
            session: () => {
                // Every session shares one id, because a rebuild is the same conversation resumed.
                const session = new ClaudeSession("<SESSION_ID>", {
                    instructions: "You are a careful engineer.",
                    credential,
                    env,
                    model: "anthropic/opus-4-8",
                    query: claudeSdkQuery,
                    tools: [],
                });
                sessions.push(session);
                return session;
            },
        });
    } finally {
        for (const session of sessions) session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(cwd, { force: true, recursive: true });
    }
}

const THINKING_RESPONSE = toSse([
    {
        type: "message_start",
        message: {
            id: "msg_recreation",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-8",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
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
        delta: { type: "thinking_delta", thinking: "The parser entry point is misnamed." },
    },
    {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "GOLDEN_SIGNATURE" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Renamed the entry point." },
    },
    { type: "content_block_stop", index: 1 },
    {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 9 },
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
