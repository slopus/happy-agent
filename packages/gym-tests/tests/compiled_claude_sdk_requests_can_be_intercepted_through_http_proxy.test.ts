import { afterEach, describe, expect, it } from "vitest";

import {
    createGym,
    type Gym,
    type HttpResponseReplacement,
    type InterceptedHttpRequest,
} from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("compiled Claude SDK requests through an intercepting HTTP proxy", () => {
    it("captures the exact Anthropic prompt and replaces the model response", async () => {
        const userMarker = "CLAUDE_SDK_PROXY_CAPTURE_MARKER";
        const responseMarker = "COMPILED_CLAUDE_SDK_PROXY_RESPONSE";
        const gym = await createGym({
            mode: "docker",
            environment: {
                ANTHROPIC_API_KEY: "gym-placeholder-key",
                ANTHROPIC_BASE_URL: "http://api.anthropic.test",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_TELEMETRY: "1",
            },
            httpProxy: {
                handler(request) {
                    if (request.method === "CONNECT") {
                        return {
                            response: { body: "TLS traffic disabled in this gym.", status: 502 },
                        };
                    }
                    if (new URL(request.url).pathname === "/v1/messages") {
                        const payload = requestPayload(request);
                        return {
                            response: anthropicStreamResponse(
                                request,
                                payload.model === "claude-haiku-4-5"
                                    ? "Gym proxy capture"
                                    : responseMarker,
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

        gym.terminal.type(`Reply once with the mocked response. ${userMarker}`);
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(responseMarker, 30_000);
        expect(screen.text).toContain(responseMarker);

        const messageExchanges = gym.httpProxy?.exchanges.filter(
            (exchange) =>
                exchange.request.method === "POST" &&
                new URL(exchange.request.url).pathname === "/v1/messages",
        );
        expect(messageExchanges?.length).toBeGreaterThanOrEqual(1);
        expect(
            messageExchanges?.every((exchange) => exchange.responseSource === "interceptor"),
        ).toBe(true);
        expect(
            messageExchanges?.every(
                (exchange) =>
                    exchange.request.url === "http://api.anthropic.test/v1/messages?beta=true",
            ),
        ).toBe(true);

        const metadataExchange = messageExchanges?.find(
            (exchange) => requestPayload(exchange.request).model === "claude-haiku-4-5",
        );
        const agentExchange = messageExchanges?.find(
            (exchange) => requestPayload(exchange.request).model === "claude-sonnet-4-6",
        );
        expect(metadataExchange).toBeUndefined();
        expect(agentExchange).toBeDefined();

        const agentPayload = JSON.stringify(requestPayload(agentExchange!.request));
        expect(agentPayload).toContain(userMarker);
        expect(agentPayload).toContain("The current working directory is /workspace.");
        expect(agentPayload).toContain("/workspace");
    }, 120_000);

    it("keeps one Claude session identity across main turns without Claude transcripts", async () => {
        const firstPrompt = "FIRST_CLAUDE_SESSION_ID_TURN";
        const secondPrompt = "SECOND_CLAUDE_SESSION_ID_TURN";
        const firstResponse = "FIRST_CLAUDE_SESSION_ID_RESPONSE";
        const secondResponse = "SECOND_CLAUDE_SESSION_ID_RESPONSE";
        const gym = await createGym({
            mode: "docker",
            environment: {
                ANTHROPIC_API_KEY: "gym-placeholder-key",
                ANTHROPIC_BASE_URL: "http://api.anthropic.test",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_TELEMETRY: "1",
            },
            httpProxy: {
                handler(request) {
                    if (request.method === "CONNECT") {
                        return {
                            response: { body: "TLS traffic disabled in this gym.", status: 502 },
                        };
                    }
                    if (new URL(request.url).pathname === "/v1/messages") {
                        const payload = requestPayload(request);
                        const serialized = JSON.stringify(payload.messages);
                        return {
                            response: anthropicStreamResponse(
                                request,
                                payload.model === "claude-haiku-4-5"
                                    ? "Gym session identity"
                                    : serialized.includes(secondPrompt)
                                      ? secondResponse
                                      : firstResponse,
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

        gym.terminal.type(firstPrompt);
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes(firstResponse) &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                !snapshot.text.includes("esc to interrupt"),
            "the first Claude turn to return to the idle composer",
            30_000,
        );
        gym.terminal.type(secondPrompt);
        gym.terminal.press("enter");
        await gym.terminal.waitForText(secondResponse, 30_000);

        const mainExchanges = gym.httpProxy!.exchanges.filter((exchange) => {
            if (exchange.request.method !== "POST") return false;
            return requestPayload(exchange.request).model === "claude-sonnet-4-6";
        });
        expect(mainExchanges).toHaveLength(2);
        const sessionIds = mainExchanges.map((exchange) =>
            claudeSessionId(requestPayload(exchange.request)),
        );
        expect(sessionIds[0]).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(sessionIds[1]).toBe(sessionIds[0]);

        const transcriptFiles = await gym.runInContainer("sh", [
            "-c",
            "find /home/happy-terminal/.claude/projects -type f -print 2>/dev/null || true",
        ]);
        expect(transcriptFiles.stdout).toBe("");
    }, 120_000);
});

function anthropicStreamResponse(
    request: InterceptedHttpRequest,
    text: string,
): HttpResponseReplacement {
    const payload = requestPayload(request);
    const model = payload.model ?? "claude-sonnet-4-6";
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg_gym_proxy_capture",
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
        headers: {
            "content-type": "text/event-stream",
        },
        status: 200,
    };
}

function requestPayload(request: InterceptedHttpRequest): AnthropicRequestPayload {
    return JSON.parse(bodyText(request)) as AnthropicRequestPayload;
}

function claudeSessionId(payload: AnthropicRequestPayload): string {
    const userId = payload.metadata?.user_id;
    if (typeof userId !== "string") throw new Error("Claude request metadata has no user_id.");
    const parsed = JSON.parse(userId) as { session_id?: unknown };
    if (typeof parsed.session_id !== "string") {
        throw new Error("Claude request metadata user_id has no session_id.");
    }
    return parsed.session_id;
}

interface AnthropicRequestPayload extends Record<string, unknown> {
    messages?: unknown;
    metadata?: { user_id?: unknown };
    model?: string;
}

function bodyText(message: { body: Uint8Array }): string {
    return Buffer.from(message.body).toString("utf8");
}
