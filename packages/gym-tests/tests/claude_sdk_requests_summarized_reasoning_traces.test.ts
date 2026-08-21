import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym, type InterceptedHttpExchange } from "@slopus/happy-terminal-gym";

const BLOCK_MARKER = "HAPPY_TERMINAL_GYM_BLOCKED_AFTER_REASONING_INSPECTION";
const USER_PROMPT = "Inspect the Claude reasoning request.";
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Claude SDK reasoning traces", () => {
    it("requests maximum effort and summarized reasoning on the wire", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: {
                ANTHROPIC_API_KEY: "gym-placeholder-key",
                ANTHROPIC_BASE_URL: "http://api.anthropic.test",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_TELEMETRY: "1",
                HAPPY_TERMINAL_EFFORT: "max",
            },
            httpProxy: {
                handler(request) {
                    if (
                        request.method === "POST" &&
                        new URL(request.url).pathname === "/v1/messages"
                    ) {
                        return {
                            response: {
                                body: JSON.stringify({
                                    type: "error",
                                    error: {
                                        type: "invalid_request_error",
                                        message: BLOCK_MARKER,
                                    },
                                }),
                                headers: { "content-type": "application/json" },
                                status: 400,
                            },
                        };
                    }
                    return { response: { body: BLOCK_MARKER, status: 400 } };
                },
            },
            modelId: "anthropic/opus-4-8",
            providerId: "claude",
            timeoutMs: 30_000,
        });
        running.add(gym);

        gym.terminal.type(USER_PROMPT);
        gym.terminal.press("enter");

        let exchange: InterceptedHttpExchange | undefined;
        await expect
            .poll(
                () => {
                    exchange = gym.httpProxy?.exchanges.find((candidate) => {
                        if (
                            candidate.request.method !== "POST" ||
                            new URL(candidate.request.url).pathname !== "/v1/messages"
                        ) {
                            return false;
                        }
                        return Buffer.from(candidate.request.body)
                            .toString("utf8")
                            .includes(USER_PROMPT);
                    });
                    return exchange;
                },
                { timeout: 30_000 },
            )
            .toBeDefined();

        const payload = JSON.parse(
            Buffer.from(exchange!.request.body).toString("utf8"),
        ) as AnthropicRequestPayload;
        expect(payload.max_tokens).toBe(64_000);
        expect(payload.output_config).toMatchObject({ effort: "max" });
        expect(payload.thinking).toEqual({
            type: "adaptive",
            display: "summarized",
        });
    }, 120_000);
});

interface AnthropicRequestPayload {
    max_tokens?: number;
    output_config?: Record<string, unknown>;
    thinking?: Record<string, unknown>;
}
