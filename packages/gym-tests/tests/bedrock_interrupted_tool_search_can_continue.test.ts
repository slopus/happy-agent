import { describe, expect, it } from "vitest";

import { createGym, type HttpResponseReplacement } from "@slopus/happy-terminal-gym";

const searchCall = {
    type: "server_tool_use",
    id: "srvtoolu_interrupted_search",
    name: "tool_search_tool_regex",
    input: { pattern: "web_fetch" },
};

describe("Bedrock interrupted tool search", () => {
    it("handles queued steering after a local tool without replaying the canceled search or repeating the tool", async () => {
        const requests: { messages: { role: string; content: unknown }[] }[] = [];
        let releaseFirst = (): void => undefined;
        const heldFirst = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const bashCall = {
            type: "tool_use",
            id: "toolu_steering_bash",
            name: "Bash",
            input: { command: "printf 'once\\n' >> steering-executions.txt" },
        };
        const gym = await createGym({
            mode: "docker",
            providerId: "bedrock",
            modelId: "anthropic/fable-5-1",
            rows: 50,
            environment: { AWS_BEARER_TOKEN_BEDROCK: "gym-placeholder-token" },
            homeFiles: {
                "happy/config/happy.toml": [
                    "[settings]",
                    "inference_max_retries = 0",
                    "[providers]",
                    "default_enable = false",
                    "[providers.bedrock]",
                    "enabled = true",
                    'region = "us-east-1"',
                    '[providers.bedrock.model_overrides."anthropic/fable-5-1"]',
                    'endpoint = "http://bedrock.gym.test"',
                    'transport = "runtime"',
                ].join("\n"),
            },
            httpProxy: {
                async handler(request) {
                    if (!new URL(request.url).pathname.endsWith("/invoke-with-response-stream")) {
                        return {
                            response: { status: 404, body: "Only scripted inference is allowed." },
                        };
                    }
                    const body = Buffer.from(request.body).toString();
                    if (body.includes("Create a concise session title")) {
                        return {
                            response: responseFor([{ type: "text", text: "Queued steering" }]),
                        };
                    }
                    requests.push(JSON.parse(body));
                    if (requests.length === 1) {
                        await heldFirst;
                        return { response: responseFor([bashCall, searchCall], false, "tool_use") };
                    }
                    if (body.includes(searchCall.id)) {
                        return {
                            response: {
                                status: 400,
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                    type: "error",
                                    error: {
                                        type: "invalid_request_error",
                                        message:
                                            "tool_search_tool_regex tool use was found without a corresponding tool_search_tool_result block",
                                    },
                                }),
                            },
                        };
                    }
                    return {
                        response: responseFor([{ type: "text", text: "QUEUED_STEERING_COMPLETE" }]),
                    };
                },
            },
        });
        try {
            gym.terminal.type("Run the shell side effect once and search for tools.");
            gym.terminal.press("enter");
            await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1);
            gym.terminal.type("STEERING_NEW_INSTRUCTION: also inspect the workspace.");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("Messages to be submitted after next tool call", 30_000);
            expect(requests).toHaveLength(1);
            releaseFirst();
            const completed = await gym.terminal.waitUntil(
                (screen) =>
                    screen.text.includes("QUEUED_STEERING_COMPLETE") &&
                    !screen.text.includes("esc to interrupt"),
                "queued steering to finish after the local tool batch",
                30_000,
            );
            expect(completed.text).not.toContain("without a corresponding");
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1])).toContain("STEERING_NEW_INSTRUCTION");
            expect(JSON.stringify(requests[1])).not.toContain(searchCall.id);
            const blocks = requests[1]!.messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content : [],
            );
            expect(blocks.filter((block) => block.id === bashCall.id)).toHaveLength(1);
            expect(blocks.filter((block) => block.tool_use_id === bashCall.id)).toHaveLength(1);
            await expect(gym.readFile("steering-executions.txt")).resolves.toBe("once\n");
        } finally {
            releaseFirst();
            await gym.dispose();
        }
    }, 90_000);

    // The runtime consumes the published provider; rerun after its release and dependency rollout.
    it("continues after a stream failure without replaying an orphaned native search", async () => {
        const requests: { messages: { role: string; content: unknown }[] }[] = [];
        const gym = await createGym({
            mode: "docker",
            providerId: "bedrock",
            modelId: "anthropic/fable-5-1",
            rows: 50,
            environment: { AWS_BEARER_TOKEN_BEDROCK: "gym-placeholder-token" },
            homeFiles: {
                "happy/config/happy.toml": [
                    "[settings]",
                    "inference_max_retries = 0",
                    "[providers]",
                    "default_enable = false",
                    "[providers.bedrock]",
                    "enabled = true",
                    'region = "us-east-1"',
                    '[providers.bedrock.model_overrides."anthropic/fable-5-1"]',
                    'endpoint = "http://bedrock.gym.test"',
                    'transport = "runtime"',
                ].join("\n"),
            },
            httpProxy: {
                handler(request) {
                    if (!new URL(request.url).pathname.endsWith("/invoke-with-response-stream")) {
                        return {
                            response: { status: 404, body: "Only scripted inference is allowed." },
                        };
                    }
                    const body = Buffer.from(request.body).toString();
                    if (body.includes("Create a concise session title")) {
                        return {
                            response: responseFor([{ type: "text", text: "Search recovery" }]),
                        };
                    }
                    requests.push(JSON.parse(body));
                    if (requests.length === 1) {
                        // A completed text block makes Base persist the preceding hidden call.
                        // The stream fails before the server supplies its search result.
                        return {
                            response: responseFor(
                                [searchCall, { type: "text", text: "SEARCH_PREFIX_PERSISTED" }],
                                true,
                            ),
                        };
                    }
                    if (body.includes(searchCall.id)) {
                        return {
                            response: {
                                status: 400,
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                    type: "error",
                                    error: {
                                        type: "invalid_request_error",
                                        message:
                                            "tool_search_tool_regex tool use was found without a corresponding tool_search_tool_result block",
                                    },
                                }),
                            },
                        };
                    }
                    return {
                        response: responseFor([{ type: "text", text: "SEARCH_RECOVERY_COMPLETE" }]),
                    };
                },
            },
        });
        try {
            gym.terminal.type("Find the fetch tool.");
            gym.terminal.press("enter");
            await gym.terminal.waitUntil(
                (screen) =>
                    screen.text.includes("SEARCH_PREFIX_PERSISTED") &&
                    screen.text.includes("Scripted search stream failure") &&
                    !screen.text.includes("esc to interrupt"),
                "the failed search turn to settle with its completed prefix",
                30_000,
            );
            gym.terminal.type("Continue.");
            gym.terminal.press("enter");
            const recovered = await gym.terminal.waitUntil(
                (screen) =>
                    screen.text.includes("SEARCH_RECOVERY_COMPLETE") &&
                    !screen.text.includes("esc to interrupt"),
                "the resumed search turn to finish",
                30_000,
            );
            expect(recovered.text).not.toContain("without a corresponding");
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1])).toContain("SEARCH_PREFIX_PERSISTED");
            expect(JSON.stringify(requests[1])).not.toContain(searchCall.id);
            gym.terminal.type("Keep going.");
            gym.terminal.press("enter");
            await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(3);
            expect(JSON.stringify(requests[2])).not.toContain(searchCall.id);
        } finally {
            await gym.dispose();
        }
    }, 90_000);
});

function responseFor(
    blocks: readonly Record<string, unknown>[],
    fail = false,
    stopReason = "end_turn",
): HttpResponseReplacement {
    const events: Record<string, unknown>[] = [
        {
            type: "message_start",
            message: {
                id: "msg_search_recovery",
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
            },
        },
    ];
    for (const [index, content_block] of blocks.entries()) {
        events.push({ type: "content_block_start", index, content_block });
        events.push({ type: "content_block_stop", index });
    }
    events.push(
        ...(fail
            ? [
                  {
                      type: "error",
                      error: { type: "api_error", message: "Scripted search stream failure." },
                  },
              ]
            : [
                  {
                      type: "message_delta",
                      delta: { stop_reason: stopReason, stop_sequence: null },
                      usage: { output_tokens: 20 },
                  },
                  { type: "message_stop" },
              ]),
    );
    return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
    };
}
