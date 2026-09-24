import { describe, expect, it } from "vitest";

import { createGym, type HttpResponseReplacement } from "@slopus/happy-terminal-gym";

const searchCall = {
    type: "server_tool_use",
    id: "srvtoolu_search",
    name: "tool_search_tool_regex",
    input: { query: "GYM_HIDDEN_SEARCH_QUERY" },
};
const searchResult = {
    type: "tool_search_tool_result",
    tool_use_id: searchCall.id,
    content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "web_fetch" }],
    },
};
const bashCall = {
    type: "tool_use",
    id: "toolu_bash_once",
    name: "Bash",
    input: { command: "printf 'executed\\n' >> bash-executions.txt" },
};

describe("Bedrock hidden tool-search continuation", () => {
    // The Docker image consumes the published provider. This regression requires the
    // corrected provider to be released and the image rebuilt after its dependency rollout.
    it("finishes a native search across Bash execution and replays each native item exactly once", async () => {
        const requests: { messages: { role: string; content: unknown }[] }[] = [];
        const gym = await createGym({
            mode: "docker",
            providerId: "bedrock",
            modelId: "anthropic/fable-5-1",
            rows: 50,
            environment: {
                AWS_BEARER_TOKEN_BEDROCK: "gym-placeholder-token",
            },
            homeFiles: {
                "happy/config/happy.toml": [
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
                    if (
                        request.method !== "POST" ||
                        !new URL(request.url).pathname.endsWith("/invoke-with-response-stream")
                    ) {
                        return {
                            response: {
                                status: 404,
                                body: "Only scripted Bedrock inference is allowed.",
                            },
                        };
                    }
                    const body = Buffer.from(request.body).toString();
                    if (body.includes("Create a concise session title")) {
                        return {
                            response: responseFor(
                                [{ type: "text", text: "Gym search session" }],
                                "end_turn",
                            ),
                        };
                    }
                    requests.push(JSON.parse(body));
                    if (requests.length === 1) {
                        return { response: responseFor([bashCall, searchCall], "tool_use") };
                    }
                    if (requests.length === 2) {
                        // The result belongs to response A: response B has no repeated server_tool_use.
                        return {
                            response: responseFor(
                                [
                                    searchResult,
                                    { type: "text", text: "SEARCH_CONTINUATION_COMPLETE" },
                                ],
                                "end_turn",
                            ),
                        };
                    }
                    if (requests.length === 3) {
                        return {
                            response: responseFor(
                                [{ type: "text", text: "FOLLOWUP_COMPLETE" }],
                                "end_turn",
                            ),
                        };
                    }
                    return { response: { status: 500, body: "Unexpected repeated inference." } };
                },
            },
        });
        try {
            gym.terminal.type("Run the shell side effect once and finish the search.");
            gym.terminal.press("enter");
            const completed = await gym.terminal.waitUntil(
                (screen) =>
                    screen.text.includes("SEARCH_CONTINUATION_COMPLETE") &&
                    !screen.text.includes("esc to interrupt"),
                "the native search continuation to finish after Bash",
                30_000,
            );
            expect(completed.text).not.toContain("without a matching start");
            for (const hidden of [
                searchCall.id,
                searchCall.name,
                searchCall.input.query,
                "ToolSearch",
            ]) {
                expect(completed.text).not.toContain(hidden);
            }
            await expect(gym.readFile("bash-executions.txt")).resolves.toBe("executed\n");
            expect(requests).toHaveLength(2);

            gym.terminal.type("Continue the same conversation.");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("FOLLOWUP_COMPLETE", 30_000);
            expect(requests).toHaveLength(3);
            const blocks = requests[2]!.messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content : [],
            );
            expect(blocks.filter((block) => block.type === "server_tool_use")).toEqual([
                searchCall,
            ]);
            expect(blocks.filter((block) => block.type === "tool_search_tool_result")).toEqual([
                searchResult,
            ]);
            const bashIndex = blocks.findIndex((block) => block.id === bashCall.id);
            const searchIndex = blocks.findIndex((block) => block.id === searchCall.id);
            const bashResultIndex = blocks.findIndex((block) => block.tool_use_id === bashCall.id);
            const searchResultIndex = blocks.findIndex(
                (block) => block.tool_use_id === searchCall.id,
            );
            expect(bashIndex).toBeGreaterThanOrEqual(0);
            expect(searchIndex).toBeGreaterThan(bashIndex);
            expect(bashResultIndex).toBeGreaterThan(searchIndex);
            expect(searchResultIndex).toBeGreaterThan(bashResultIndex);
            expect(blocks.filter((block) => block.id === bashCall.id)).toHaveLength(1);
            expect(blocks.filter((block) => block.tool_use_id === bashCall.id)).toHaveLength(1);
            await expect(gym.readFile("bash-executions.txt")).resolves.toBe("executed\n");
        } finally {
            await gym.dispose();
        }
    }, 90_000);
});

function responseFor(
    blocks: readonly Record<string, unknown>[],
    stopReason: string,
): HttpResponseReplacement {
    const events: Record<string, unknown>[] = [
        {
            type: "message_start",
            message: {
                id: `msg_${stopReason}_${blocks.length}`,
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
    for (const [index, block] of blocks.entries()) {
        const tool = block.type === "tool_use" || block.type === "server_tool_use";
        events.push({
            type: "content_block_start",
            index,
            content_block: tool ? { ...block, input: {} } : block,
        });
        if (tool) {
            events.push({
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            });
        }
        events.push({ type: "content_block_stop", index });
    }
    events.push(
        {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
    );
    return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
    };
}
