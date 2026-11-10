import { testContext } from "../testContext.js";

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionImageBlock, SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";

/** Claude Code refuses a request holding any image whose base64 data exceeds this many bytes. */
const CLAUDE_IMAGE_BASE64_LIMIT = 5 * 1024 * 1024;
const PNG_1X1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Claude Code checks every image in a request before sending it, and refuses the whole request
 * when one image's base64 data is over its limit. Rig replays its full history on every new query,
 * so an oversized image that once entered the conversation used to fail every later turn at once.
 * These tests drive the real SDK against a local server and inspect what reaches the API.
 */
describe("Claude images over the request limit", () => {
    it.each([
        ["just over", CLAUDE_IMAGE_BASE64_LIMIT + 4],
        ["well over", 3 * CLAUDE_IMAGE_BASE64_LIMIT],
    ])(
        "continues after a user image %s the limit in history",
        async (_label, length) => {
            await withServer(async (harness) => {
                const requests = await harness.run([
                    {
                        role: "user",
                        content: [{ type: "text", text: "Here is the screenshot." }, image(length)],
                    },
                    { role: "assistant", content: [{ type: "text", text: "Got it." }] },
                    user("What did it show?"),
                ]);

                expect(requests).toHaveLength(1);
                const [first, , last] = conversation(requests[0]!);
                expect(blocks(first)).toEqual([
                    { type: "text", text: "Here is the screenshot." },
                    { type: "text", text: omitted(length) },
                ]);
                expect(blocks(last)).toEqual([{ type: "text", text: "What did it show?" }]);
                expect(JSON.stringify(requests[0])).not.toContain("AAAAAAAAAAAAAAAA");
            });
        },
        60_000,
    );

    it("continues after an oversized tool-result image in history", async () => {
        await withServer(async (harness) => {
            const length = CLAUDE_IMAGE_BASE64_LIMIT + 4;
            const requests = await harness.run([
                user("Take a screenshot."),
                screenshotCall(),
                {
                    role: "tool",
                    callId: "call-shot",
                    content: [{ type: "text", text: "Captured." }, image(length)],
                },
                { role: "assistant", content: [{ type: "text", text: "Done." }] },
                user("Describe it."),
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(blocks(messages[2])).toEqual([
                {
                    type: "tool_result",
                    tool_use_id: "call-shot",
                    content: [
                        { type: "text", text: "Captured." },
                        { type: "text", text: omitted(length) },
                    ],
                },
            ]);
        });
    }, 60_000);

    it("answers a new prompt carrying an oversized image", async () => {
        await withServer(async (harness) => {
            const length = CLAUDE_IMAGE_BASE64_LIMIT + 4;
            const requests = await harness.run([
                { role: "user", content: [{ type: "text", text: "Look." }, image(length)] },
            ]);

            expect(requests).toHaveLength(1);
            expect(blocks(conversation(requests[0]!)[0])).toEqual([
                { type: "text", text: "Look." },
                { type: "text", text: omitted(length) },
            ]);
        });
    }, 60_000);

    it("leaves an image exactly at the limit to Claude Code", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                {
                    role: "user",
                    content: [{ type: "text", text: "Look." }, image(CLAUDE_IMAGE_BASE64_LIMIT)],
                },
            ]);

            // Claude Code downsizes a large prompt image itself; this fixture is not a real
            // picture, so it answers with its own note rather than the provider's.
            expect(requests).toHaveLength(1);
            const [, shown] = blocks(conversation(requests[0]!)[0]);
            expect(shown).toMatchObject({ type: "text" });
            expect(shown?.text).toContain("Image could not be processed");
        });
    }, 60_000);

    it("keeps an image within the limit unchanged", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                { role: "user", content: [{ type: "text", text: "Look." }, pngImage()] },
            ]);

            expect(requests).toHaveLength(1);
            expect(blocks(conversation(requests[0]!)[0])).toEqual([
                { type: "text", text: "Look." },
                {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
                },
            ]);
        });
    }, 60_000);

    it("continues the live query after a tool answers with an oversized image", async () => {
        await withServer(async (harness) => {
            const length = CLAUDE_IMAGE_BASE64_LIMIT + 4;
            harness.respondWithToolCall();
            const session = harness.session();
            const prompt = user("Take a screenshot.");
            const call = await harness.runOn(session, [prompt], "tool_call");
            const callId = call.message.content.find((block) => block.type === "tool_call");
            if (callId?.type !== "tool_call") throw new Error("Expected a tool call.");
            const after = await harness.runOn(
                session,
                [
                    prompt,
                    call.message,
                    {
                        role: "tool",
                        callId: callId.callId,
                        content: [{ type: "text", text: "Captured." }, image(length)],
                    },
                ],
                "normal",
            );

            // Claude Code processes a live MCP image itself; the oversized data never reaches the API.
            expect(after.requests).toHaveLength(1);
            expect(JSON.stringify(after.requests[0])).not.toContain("AAAAAAAAAAAAAAAA");
        });
    }, 60_000);
});

function omitted(length: number): string {
    const megabytes = (Math.ceil((length / (1024 * 1024)) * 10) / 10).toFixed(1);
    return `[Image omitted: its base64 data is ${megabytes} MB, over Claude's 5 MB limit for one image.]`;
}

/** Valid base64 of the given length, which must be a multiple of four. */
function image(length: number): SessionImageBlock {
    return { type: "image", mimeType: "image/png", data: "A".repeat(length) };
}

function pngImage(): SessionImageBlock {
    return { type: "image", mimeType: "image/png", data: PNG_1X1 };
}

function user(text: string): SessionMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function screenshotCall(): SessionMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", callId: "call-shot", name: "Screenshot", arguments: "{}" }],
    };
}

interface CapturedRequest {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ name: string }>;
}

/** The request's conversation without Claude Code's environment message. */
function conversation(request: CapturedRequest): CapturedRequest["messages"] {
    return request.messages.filter((message) => message.role !== "system");
}

/** Content blocks without the cache breakpoint Claude Code places on the newest turn. */
function blocks(
    message: CapturedRequest["messages"][number] | undefined,
): Array<Record<string, unknown>> {
    if (message === undefined) return [];
    if (typeof message.content === "string") return [{ type: "text", text: message.content }];
    return (message.content as Array<Record<string, unknown>>).map(
        ({ cache_control: _cacheControl, ...block }) => block,
    );
}

interface Harness {
    respondWithToolCall: () => void;
    run: (messages: SessionMessage[]) => Promise<CapturedRequest[]>;
    runOn: (
        session: ClaudeSession,
        messages: SessionMessage[],
        state: "normal" | "tool_call",
    ) => Promise<{
        message: Extract<SessionMessage, { role: "assistant" }>;
        requests: CapturedRequest[];
    }>;
    session: () => ClaudeSession;
}

async function withServer(scenario: (harness: Harness) => Promise<void>): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "rig-claude-oversized-image-"));
    const requests: CapturedRequest[] = [];
    let toolCallsOwed = 0;
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
        const body = JSON.parse((await readBody(request)).toString("utf8")) as CapturedRequest;
        requests.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (toolCallsOwed > 0) {
            toolCallsOwed -= 1;
            const name = body.tools?.find((tool) => tool.name.endsWith("Screenshot"))?.name;
            if (name === undefined) throw new Error("The request did not offer Screenshot.");
            response.end(toolUseResponse(name));
            return;
        }
        response.end(textResponse("It showed the login page."));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Claude image server port.");
    }
    const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "image-token" });
    if (credential === null) throw new Error("Expected a Claude test credential.");
    const sessions: ClaudeSession[] = [];
    const session = () => {
        const created = new ClaudeSession("<SESSION_ID>", {
            instructions: "You are a careful engineer.",
            credential,
            cwd,
            env: {
                ...process.env,
                CLAUDE_CONFIG_DIR: cwd,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
                CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
                TZ: "UTC",
            },
            model: "anthropic/opus-5-5",
            tools: [{ name: "Screenshot", description: "Capture the screen." }],
        });
        sessions.push(created);
        return created;
    };
    const runOn: Harness["runOn"] = async (active, messages, state) => {
        const first = requests.length;
        const events: SessionEvent[] = [];
        for await (const event of active.run(testContext, {
            context: { instructions: "You are a careful engineer.", messages },
        })) {
            events.push(event);
        }
        expect(events.at(-1)).toMatchObject({ type: "done", state });
        const message = assistantMessageFromEvents(events);
        if (message === undefined) throw new Error("Missing reconstructed assistant message.");
        return { message, requests: requests.slice(first) };
    };
    try {
        await scenario({
            respondWithToolCall: () => {
                toolCallsOwed += 1;
            },
            run: async (messages) => (await runOn(session(), messages, "normal")).requests,
            runOn,
            session,
        });
    } finally {
        for (const created of sessions) created.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(cwd, { force: true, maxRetries: 5, recursive: true });
    }
}

function textResponse(text: string): string {
    return toSse([
        messageStart(),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 9 },
        },
        { type: "message_stop" },
    ]);
}

function toolUseResponse(name: string): string {
    return toSse([
        messageStart(),
        {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_shot", name, input: {} },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
        },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 9 },
        },
        { type: "message_stop" },
    ]);
}

function messageStart() {
    return {
        type: "message_start",
        message: {
            id: "msg_oversized_image",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
        },
    };
}

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
