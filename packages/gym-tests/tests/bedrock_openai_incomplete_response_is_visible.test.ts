import { afterEach, describe, expect, it } from "vitest";

import {
    createGym,
    type Gym,
    type HttpResponseReplacement,
    type InterceptedHttpRequest,
} from "@slopus/happy-terminal-gym";

const INCOMPLETE_ERROR = "Incomplete response returned, reason: content_filter";
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Bedrock OpenAI response semantics", () => {
    it("shows the exact incomplete reason instead of silently ending the turn", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: [
                "/bin/sh",
                "-lc",
                'sed -i "s|BEDROCK_GYM_ENDPOINT|$BEDROCK_GYM_ENDPOINT|" /home/happy-terminal/happy/config/happy.toml\nexec node /app/packages/happy-terminal/dist/main.js',
            ],
            environment: {
                AWS_BEARER_TOKEN_BEDROCK: "gym-placeholder-token",
                BEDROCK_GYM_ENDPOINT: "{{HTTP_PROXY_URL}}/openai/v1",
                NO_PROXY: "host.docker.internal",
            },
            homeFiles: {
                "Happy/Config/happy.toml": bedrockConfig(),
            },
            httpProxy: {
                handler(request) {
                    if (request.method === "POST" && isResponsesRequest(request)) {
                        return { response: incompleteResponse(request) };
                    }
                    return {
                        response: {
                            body: `Unexpected Bedrock request: ${request.method} ${request.url}`,
                            status: 404,
                        },
                    };
                },
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "bedrock",
            timeoutMs: 30_000,
        });
        running.add(gym);

        gym.terminal.type("Trigger an incomplete Bedrock response.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(INCOMPLETE_ERROR, 30_000);
        expect(screen.text).toContain("PARTIAL_BEDROCK_TEXT");
        expect(screen.text).toContain(INCOMPLETE_ERROR);
        expect(screen.text).not.toContain("Retrying incomplete response");
        expect(mainResponseRequests(gym)).toHaveLength(1);
    }, 120_000);

    it("continues when a completed response says the model has not ended its turn", async () => {
        let mainCallIndex = 0;
        const gym = await createGym({
            mode: "docker",
            entrypoint: [
                "/bin/sh",
                "-lc",
                'sed -i "s|BEDROCK_GYM_ENDPOINT|$BEDROCK_GYM_ENDPOINT|" /home/happy-terminal/happy/config/happy.toml\nexec node /app/packages/happy-terminal/dist/main.js',
            ],
            environment: {
                AWS_BEARER_TOKEN_BEDROCK: "gym-placeholder-token",
                BEDROCK_GYM_ENDPOINT: "{{HTTP_PROXY_URL}}/openai/v1",
                NO_PROXY: "host.docker.internal",
            },
            homeFiles: {
                "Happy/Config/happy.toml": bedrockConfig(),
            },
            httpProxy: {
                handler(request) {
                    if (request.method === "POST" && isResponsesRequest(request)) {
                        if (isTitleRequest(request)) {
                            return {
                                response: responsesStream("Gym Bedrock session", "completed"),
                            };
                        }
                        const response =
                            mainCallIndex++ === 0
                                ? responsesStream("FIRST_BEDROCK_SEGMENT", "completed", false)
                                : responsesStream("SECOND_BEDROCK_SEGMENT", "completed", true);
                        return { response };
                    }
                    return {
                        response: {
                            body: `Unexpected Bedrock request: ${request.method} ${request.url}`,
                            status: 404,
                        },
                    };
                },
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "bedrock",
            timeoutMs: 30_000,
        });
        running.add(gym);

        gym.terminal.type("Complete a Bedrock response that requires a follow-up.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("SECOND_BEDROCK_SEGMENT", 30_000);
        expect(screen.text).toContain("FIRST_BEDROCK_SEGMENT");
        expect(screen.text).toContain("SECOND_BEDROCK_SEGMENT");
        expect(mainResponseRequests(gym)).toHaveLength(2);
    }, 120_000);
});

function bedrockConfig(): string {
    return `
[providers.codex]
enabled = false

[providers.claude]
enabled = false

[providers.bedrock]
enabled = true
region = "us-east-1"

[providers.bedrock.model_overrides]
"openai/gpt-5.6-sol" = { endpoint = "BEDROCK_GYM_ENDPOINT" }
`;
}

function incompleteResponse(request: InterceptedHttpRequest): HttpResponseReplacement {
    const payload = JSON.parse(new TextDecoder().decode(request.body)) as { input?: unknown };
    if (JSON.stringify(payload.input).includes("Create a concise session title")) {
        return responsesStream("Gym Bedrock session", "completed");
    }
    return responsesStream("PARTIAL_BEDROCK_TEXT", "incomplete");
}

function responsesStream(
    text: string,
    status: "completed" | "incomplete",
    endTurn?: boolean,
): HttpResponseReplacement {
    const response = {
        id: `resp-${status}`,
        object: "response",
        created_at: 1,
        model: "openai.gpt-5.5",
        output: [],
        parallel_tool_calls: true,
        status,
        tool_choice: "auto",
        tools: [],
        usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 14,
        },
        ...(status === "incomplete" ? { incomplete_details: { reason: "content_filter" } } : {}),
        ...(endTurn === undefined ? {} : { end_turn: endTurn }),
    };
    const item = {
        id: "message-1",
        content: [],
        role: "assistant",
        status: "in_progress",
        type: "message",
    };
    const events = [
        { type: "response.created", sequence_number: 0, response },
        {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item,
        },
        {
            type: "response.output_text.delta",
            sequence_number: 2,
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            logprobs: [],
            delta: text,
        },
        {
            type: `response.${status}`,
            sequence_number: 3,
            response: {
                ...response,
                output: [
                    {
                        ...item,
                        status,
                        content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
                    },
                ],
            },
        },
    ];
    return {
        body: `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        headers: { "content-type": "text/event-stream" },
        status: 200,
    };
}

function isResponsesRequest(request: InterceptedHttpRequest): boolean {
    return new URL(request.url).pathname.endsWith("/responses");
}

function isTitleRequest(request: InterceptedHttpRequest): boolean {
    return new TextDecoder().decode(request.body).includes("Create a concise session title");
}

function mainResponseRequests(gym: Gym): readonly InterceptedHttpRequest[] {
    return (
        gym.httpProxy?.exchanges
            .map((exchange) => exchange.request)
            .filter(
                (request) =>
                    request.method === "POST" &&
                    isResponsesRequest(request) &&
                    !isTitleRequest(request),
            ) ?? []
    );
}
