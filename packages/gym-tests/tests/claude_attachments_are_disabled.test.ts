import { afterEach, describe, expect, it } from "vitest";

import {
    createGym,
    type Gym,
    type HttpResponseReplacement,
    type InterceptedHttpRequest,
} from "@slopus/happy-terminal-gym";

const MODEL = "claude-sonnet-5";
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Claude SDK attachments", () => {
    it("leaves dynamic context to Happy Agent and preserves an append-only wire prefix", async () => {
        let responseIndex = 0;
        const gym = await createGym({
            mode: "docker",
            environment: {
                ANTHROPIC_API_KEY: "gym-placeholder-key",
                ANTHROPIC_BASE_URL: "http://api.anthropic.test",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                CLAUDE_CODE_OVERRIDE_DATE: "1900-01-01",
                DISABLE_TELEMETRY: "1",
            },
            files: {
                "CLAUDE.md": "CLAUDE_MD_MUST_NOT_REACH_ANTHROPIC",
            },
            httpProxy: {
                handler(request) {
                    if (request.method === "CONNECT") {
                        return {
                            response: { body: "TLS traffic disabled in this gym.", status: 502 },
                        };
                    }
                    if (new URL(request.url).pathname === "/v1/messages") {
                        responseIndex += 1;
                        return {
                            response: anthropicStreamResponse(
                                request,
                                `CLAUDE_ATTACHMENTS_RESPONSE_${responseIndex}`,
                            ),
                        };
                    }
                    return {
                        response: {
                            body: `Unexpected compiled Claude SDK request: ${request.method} ${request.url}`,
                            status: 404,
                        },
                    };
                },
            },
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
            timeoutMs: 30_000,
        });
        running.add(gym);

        for (let turn = 1; turn <= 3; turn += 1) {
            gym.terminal.type(`CLAUDE_ATTACHMENTS_PROMPT_${turn}`);
            gym.terminal.press("enter");
            await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes(`CLAUDE_ATTACHMENTS_RESPONSE_${turn}`) &&
                    snapshot.text.includes("Ask Happy Terminal to do anything") &&
                    !snapshot.text.includes("esc to interrupt"),
                `Claude attachment turn ${turn} to return to the idle composer`,
                30_000,
            );
        }

        const payloads = gym.httpProxy!.exchanges.flatMap((exchange) => {
            if (exchange.request.method !== "POST") return [];
            const payload = requestPayload(exchange.request);
            return payload.model === MODEL ? [payload] : [];
        });
        expect(payloads).toHaveLength(3);

        const [firstPayload, secondPayload, thirdPayload] = payloads;
        if (
            firstPayload === undefined ||
            secondPayload === undefined ||
            thirdPayload === undefined
        ) {
            throw new Error("Claude attachment test did not capture all three requests.");
        }
        const firstMessages = normalizedMessages(firstPayload);
        const secondMessages = normalizedMessages(secondPayload);
        const thirdMessages = normalizedMessages(thirdPayload);
        const wireText = JSON.stringify(payloads);
        expect(wireText).not.toContain("1900-01-01");
        expect(wireText).not.toContain("CLAUDE_MD_MUST_NOT_REACH_ANTHROPIC");
        expect(wireText).not.toContain("# MCP Server Instructions");
        expect(wireText).not.toContain("Available agent types for the Agent tool:");
        expect(secondMessages.slice(0, firstMessages.length)).toEqual(firstMessages);
        expect(thirdMessages.slice(0, secondMessages.length)).toEqual(secondMessages);
    }, 120_000);
});

function anthropicStreamResponse(
    request: InterceptedHttpRequest,
    text: string,
): HttpResponseReplacement {
    const payload = requestPayload(request);
    const model = payload.model ?? MODEL;
    const events = [
        {
            type: "message_start",
            message: {
                id: `msg_gym_attachments_${text}`,
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    output_tokens: 1,
                },
            },
        },
        {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
    ];
    return {
        body: events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`)
            .join("\n"),
        headers: { "content-type": "text/event-stream" },
        status: 200,
    };
}

function requestPayload(request: InterceptedHttpRequest): AnthropicRequestPayload {
    return JSON.parse(Buffer.from(request.body).toString("utf8")) as AnthropicRequestPayload;
}

function normalizedMessages(payload: AnthropicRequestPayload): unknown[] {
    if (!Array.isArray(payload.messages)) throw new Error("Claude request has no messages array.");
    return stripCacheControl(payload.messages) as unknown[];
}

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).flatMap(([key, child]) =>
            key === "cache_control" ? [] : [[key, stripCacheControl(child)]],
        ),
    );
}

interface AnthropicRequestPayload extends Record<string, unknown> {
    messages?: unknown;
    model?: string;
}
