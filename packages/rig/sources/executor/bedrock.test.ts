import { createServer } from "node:http";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
    Executor,
    modelAnthropicOpus5,
    modelAnthropicOpus48,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Sol,
    modelOpenaiGpt56Terra,
} from "@slopus/rig-execution";
import { bedrockExecution } from "./bedrockExecution.js";
import { getBedrockModelRoute } from "./getBedrockModelRoute.js";
import { resolveBedrockModelTransport } from "../model-catalog/bedrock/resolveBedrockModelTransport.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";

const ctx = createTestRootContext().named("bedrock-provider-test");

describe("Amazon Bedrock provider", () => {
    it("requires the Bedrock bearer token", () => {
        expect(() => bedrockExecution({ env: {} })).toThrow("AWS_BEARER_TOKEN_BEDROCK");
    });

    it("uses Rig model IDs and Bedrock-specific limits", () => {
        for (const model of [modelOpenaiGpt56Sol, modelOpenaiGpt56Terra, modelOpenaiGpt56Luna]) {
            const route = getBedrockModelRoute(model.id);
            expect(route?.model.id).toBe(model.id);
            expect(route?.model.contextWindow).toBe(272_000);
            expect(route?.model.thinkingLevels).toContain("max");
            expect(route?.model.thinkingLevels).not.toContain("ultra");
        }
    });

    it("prefers Mantle for Anthropic models and retains Runtime as the regional fallback", () => {
        const route = getBedrockModelRoute(modelAnthropicOpus48.id);
        if (route === undefined) expect.fail("Missing Anthropic Opus 4.8 route.");

        expect(route.transports).toEqual([
            {
                transport: "mantle",
                regions: [
                    "ap-northeast-1",
                    "eu-north-1",
                    "eu-west-1",
                    "us-east-1",
                    "us-gov-west-1",
                ],
            },
            {
                transport: "runtime",
                regions: expect.arrayContaining(["us-east-1", "us-west-2"]),
            },
        ]);
        expect(resolveBedrockModelTransport(route, "us-east-1", undefined)).toBe("mantle");
        expect(resolveBedrockModelTransport(route, "us-west-2", undefined)).toBe("runtime");
        expect(resolveBedrockModelTransport(route, "us-east-1", { transport: "runtime" })).toBe(
            "runtime",
        );
    });

    it("routes OpenAI models through the Codex Bedrock session with tools", async () => {
        let requestBody: Record<string, unknown> | undefined;
        let requestPath: string | undefined;
        let authorization: string | undefined;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requestPath = request.url;
            authorization = request.headers.authorization;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                [
                    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"message-1","role":"assistant","status":"in_progress","content":[]}}',
                    'data: {"type":"response.output_text.delta","output_index":0,"delta":"ok"}',
                    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"message-1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok","annotations":[]}]}}',
                    'data: {"type":"response.completed","response":{"id":"response-1","model":"openai.gpt-5.6-sol","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
                    "data: [DONE]",
                    "",
                ].join("\n\n"),
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");
        const endpoint = `http://127.0.0.1:${address.port}/openai/v1`;
        const provider = new Executor([
            bedrockExecution({
                bearerToken: "bedrock-token",
                modelOverrides: { [modelOpenaiGpt56Sol.id]: { endpoint } },
                region: "us-east-1",
            }),
        ]);

        try {
            const message = await provider
                .stream(ctx, modelOpenaiGpt56Sol, {
                    messages: [{ role: "user", content: "Reply with ok.", timestamp: 1 }],
                    tools: [
                        {
                            name: "list_files",
                            description: "List files in a directory.",
                            parameters: Type.Object({ path: Type.String() }),
                        },
                    ],
                })
                .result();

            expect(requestPath).toBe("/openai/v1/responses");
            expect(authorization).toBe("Bearer bedrock-token");
            // The Codex Bedrock path uses the dotted v1 model id and forwards the
            // caller's tools; the old tool-less Bedrock session never sent tools.
            expect(requestBody).toMatchObject({
                model: "openai.gpt-5.6-sol",
                parallel_tool_calls: true,
                stream: true,
                tool_choice: "auto",
            });
            expect(
                (requestBody?.tools as { name?: string }[] | undefined)?.map((tool) => tool.name),
            ).toContain("list_files");
            expect(message).toMatchObject({
                content: [{ type: "text", text: "ok" }],
                provider: "bedrock",
                stopReason: "stop",
            });
        } finally {
            await provider.close?.();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
        }
    });

    it("routes Anthropic models through direct Bedrock Messages inference", async () => {
        let requestBody: Record<string, unknown> | undefined;
        let requestPath: string | undefined;
        let authorization: string | undefined;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requestPath = request.url;
            authorization = request.headers.authorization;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                [
                    'event: message_start\ndata: {"type":"message_start","message":{"id":"message-1","type":"message","role":"assistant","content":[],"model":"anthropic.claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
                    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
                    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
                    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
                    'event: message_stop\ndata: {"type":"message_stop"}',
                    "",
                ].join("\n\n"),
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");
        const endpoint = `http://127.0.0.1:${address.port}`;
        const provider = new Executor([
            bedrockExecution({
                bearerToken: "bedrock-token",
                modelOverrides: {
                    [modelAnthropicOpus48.id]: { endpoint, transport: "runtime" },
                },
                region: "us-east-1",
            }),
        ]);

        try {
            const message = await provider
                .stream(ctx, modelAnthropicOpus48, {
                    messages: [{ role: "user", content: "Reply with ok.", timestamp: 1 }],
                })
                .result();

            expect(requestPath).toBe(
                "/model/us.anthropic.claude-opus-4-8/invoke-with-response-stream",
            );
            expect(authorization).toBe("Bearer bedrock-token");
            expect(requestBody).toMatchObject({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 64_000,
                thinking: { type: "adaptive" },
            });
            expect(requestBody).not.toHaveProperty("model");
            expect(requestBody).not.toHaveProperty("stream");
            expect(message).toMatchObject({
                content: [{ type: "text", text: "ok" }],
                provider: "bedrock",
                stopReason: "stop",
            });
        } finally {
            await provider.close?.();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
        }
    });

    it("routes Anthropic models through preferred Bedrock Mantle inference", async () => {
        let requestBody: Record<string, unknown> | undefined;
        let requestPath: string | undefined;
        let anthropicBeta: string | undefined;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requestPath = request.url;
            anthropicBeta =
                typeof request.headers["anthropic-beta"] === "string"
                    ? request.headers["anthropic-beta"]
                    : undefined;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                [
                    'event: message_start\ndata: {"type":"message_start","message":{"id":"message-1","type":"message","role":"assistant","content":[],"model":"anthropic.claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
                    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
                    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
                    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
                    'event: message_stop\ndata: {"type":"message_stop"}',
                    "",
                ].join("\n\n"),
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");
        const endpoint = `http://127.0.0.1:${address.port}`;
        const provider = new Executor([
            bedrockExecution({
                bearerToken: "bedrock-token",
                modelOverrides: { [modelAnthropicOpus48.id]: { endpoint } },
                region: "us-east-1",
            }),
        ]);

        try {
            const message = await provider
                .stream(ctx, modelAnthropicOpus48, {
                    messages: [{ role: "user", content: "Reply with ok.", timestamp: 1 }],
                })
                .result();

            expect(requestPath).toBe("/v1/messages?beta=true");
            expect(anthropicBeta).toBe("context-1m-2025-08-07,interleaved-thinking-2025-05-14");
            expect(requestBody).toMatchObject({
                model: "anthropic.claude-opus-4-8",
                max_tokens: 64_000,
                stream: true,
                thinking: { type: "adaptive" },
            });
            expect(requestBody).not.toHaveProperty("anthropic_version");
            expect(requestBody).not.toHaveProperty("anthropic_beta");
            expect(requestBody).not.toHaveProperty("betas");
            expect(message).toMatchObject({
                content: [{ type: "text", text: "ok" }],
                provider: "bedrock",
                stopReason: "stop",
            });
        } finally {
            await provider.close?.();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
        }
    });

    it("only exposes Mantle models in regions where AWS serves them", () => {
        const provider = new Executor([
            bedrockExecution({
                bearerToken: "bedrock-token",
                region: "us-west-2",
            }),
        ]);

        expect(provider.models.map((model) => model.id)).toContain(modelOpenaiGpt56Terra.id);
        expect(provider.models.map((model) => model.id)).toContain(modelOpenaiGpt56Luna.id);
        expect(provider.models.map((model) => model.id)).not.toContain(modelOpenaiGpt56Sol.id);
    });

    it("uses model-specific regions and endpoints for availability", () => {
        const provider = new Executor([
            bedrockExecution({
                bearerToken: "bedrock-token",
                modelOverrides: {
                    [modelAnthropicOpus48.id]: {
                        endpoint: "https://runtime.example",
                        transport: "runtime",
                    },
                    [modelOpenaiGpt56Sol.id]: {
                        endpoint: "https://mantle.example/openai/v1",
                    },
                    [modelOpenaiGpt56Terra.id]: { region: "us-east-1" },
                },
                region: "private-region-1",
            }),
        ]);

        expect(provider.models.map((model) => model.id)).toContain(modelOpenaiGpt56Sol.id);
        expect(provider.models.map((model) => model.id)).toContain(modelOpenaiGpt56Terra.id);
        expect(provider.models.map((model) => model.id)).toContain(modelAnthropicOpus48.id);
    });

    it("exposes every GPT-5.6 variant in its documented US East regions", () => {
        for (const region of ["us-east-1", "us-east-2"]) {
            const provider = new Executor([
                bedrockExecution({
                    bearerToken: "bedrock-token",
                    region,
                }),
            ]);

            expect(provider.models.map((model) => model.id)).toEqual(
                expect.arrayContaining([
                    modelOpenaiGpt56Sol.id,
                    modelOpenaiGpt56Terra.id,
                    modelOpenaiGpt56Luna.id,
                ]),
            );
        }
    });

    it("only exposes the Anthropic models documented for Bedrock Mantle in GovCloud", () => {
        const provider = new Executor([
            bedrockExecution({
                bearerToken: "bedrock-token",
                region: "us-gov-west-1",
            }),
        ]);

        expect(provider.models.map((model) => model.id)).toEqual([
            modelAnthropicOpus5.id,
            modelAnthropicOpus48.id,
        ]);
    });
});
