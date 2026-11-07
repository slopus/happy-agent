import { testContext } from "./testContext.js";

import { createServer } from "node:http";

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import type { BaseProvider } from "@/core/BaseProvider.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { GlmProvider } from "@/vendors/glm/GlmProvider.js";
import { KimiProvider } from "@/vendors/kimi/KimiProvider.js";

const PROFILE =
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/curated-route";

const curated: SessionModelConfiguration = {
    instructions: "Curated model instructions.",
    tools: [
        {
            name: "curated_lookup",
            description: "A tool only the curated model's configuration offers.",
            parameters: Type.Object({ query: Type.String() }),
        },
    ],
};

interface Route {
    name: string;
    model: string;
    provider: (
        credential: BedrockCredential,
        endpoint: string,
        bedrockModelIds: Record<string, string>,
    ) => BaseProvider;
}

const routes: readonly Route[] = [
    {
        name: "Anthropic on Bedrock Runtime",
        model: "anthropic/opus-5-5",
        provider: (credential, endpoint, bedrockModelIds) =>
            new AnthropicBedrockProvider({
                credential,
                endpoint,
                region: "us-east-1",
                transport: "runtime",
                bedrockModelIds,
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "Anthropic on Bedrock Mantle",
        model: "anthropic/opus-5-5",
        provider: (credential, endpoint, bedrockModelIds) =>
            new AnthropicBedrockProvider({
                credential,
                endpoint,
                region: "us-east-1",
                transport: "mantle",
                bedrockModelIds,
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "Codex on Bedrock Runtime",
        model: "openai/gpt-6-sol",
        provider: (credential, endpoint, bedrockModelIds) =>
            new CodexProvider({
                credential,
                endpoint,
                model: "openai/gpt-6-sol",
                region: "us-east-1",
                bedrockTransport: "runtime",
                bedrockModelIds,
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "Codex on Bedrock Mantle",
        model: "openai/gpt-5.6-sol",
        provider: (credential, endpoint, bedrockModelIds) =>
            new CodexProvider({
                credential,
                endpoint,
                model: "openai/gpt-5.6-sol",
                region: "us-east-1",
                bedrockTransport: "mantle",
                bedrockModelIds,
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "Kimi on Bedrock Runtime",
        model: "moonshotai/kimi-k3",
        provider: (credential, endpoint, bedrockModelIds) =>
            new KimiProvider({
                credential,
                endpoint,
                region: "us-east-1",
                bedrockModelIds,
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "GLM on Bedrock Runtime",
        model: "zai/glm-5.3",
        provider: (credential, endpoint, bedrockModelIds) =>
            new GlmProvider({
                credential,
                endpoint,
                region: "us-east-1",
                bedrockModelIds,
                inferenceMaxRetries: 0,
            }),
    },
];

describe.each(routes)("$name with a mapped Bedrock model ID", (route) => {
    it("sends the mapped ARN as the wire model, unchanged and without a profile prefix", async () => {
        const request = await capture(route, { [route.model]: PROFILE });
        const sent = wireModel(request);
        expect(sent).toBe(PROFILE);
    });

    // The tool exists only in the curated model's configuration, so it reaches the request only
    // while the session still selects that configuration by the curated ID.
    it("keeps the tools of the curated model's configuration", async () => {
        const request = await capture(route, { [route.model]: PROFILE });
        expect(request.body).toContain("curated_lookup");
    });

    // Making the ARN the run model, the only route before this map, loses the curated
    // configuration: the request goes out without its tools, or Codex refuses to send one.
    it("loses the curated configuration when the ARN is the run model instead", async () => {
        const request = await capture(route, {}, PROFILE).catch(() => undefined);
        expect(request?.body ?? "").not.toContain("curated_lookup");
    });

    it("leaves a model the map does not name on its usual wire ID", async () => {
        const request = await capture(route, { "other/model": PROFILE });
        expect(wireModel(request)).not.toBe(PROFILE);
        expect(wireModel(request)).not.toContain("arn:");
    });

    it("rejects a mapped value that is not a Bedrock ARN or model ID", async () => {
        const credential = await bearer();
        expect(() =>
            route.provider(credential, "http://127.0.0.1:9/gw", {
                [route.model]: "https://example.com/model",
            }),
        ).toThrow(
            `The Bedrock model ID for ${route.model} must be a Bedrock model or inference-profile ARN or ID: https://example.com/model.`,
        );
    });
});

describe("accepted Bedrock wire model IDs", () => {
    it.each([
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5",
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
        "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/a1",
        "anthropic.claude-opus-5-5",
        "openai.gpt-oss-120b-1:0",
        "us.zai.glm-5.3",
        "eu.anthropic.claude-opus-5-5",
        "apac.anthropic.claude-sonnet-5",
        "in.moonshotai.kimi-k3",
        "global.moonshotai.kimi-k3",
        "us-gov.anthropic.claude-sonnet-5",
    ])("accepts %s", async (wire) => {
        const credential = await bearer();
        expect(
            () => new KimiProvider({ credential, bedrockModelIds: { "moonshotai/kimi-k3": wire } }),
        ).not.toThrow();
    });

    it.each(["", "kimi-k3", "moonshotai/kimi-k3", "arn:aws:s3:::bucket/key", "us. spaced.id"])(
        "rejects %j",
        async (wire) => {
            const credential = await bearer();
            expect(
                () =>
                    new KimiProvider({
                        credential,
                        bedrockModelIds: { "moonshotai/kimi-k3": wire },
                    }),
            ).toThrow(/must be a Bedrock model or inference-profile ARN or ID/u);
        },
    );

    it("does not treat an inherited property name as a mapped model", async () => {
        const request = await capture(
            {
                name: "Kimi on Bedrock Runtime",
                model: "moonshotai/kimi-k3",
                provider: (credential, endpoint, bedrockModelIds) =>
                    new KimiProvider({
                        credential,
                        endpoint,
                        region: "us-east-1",
                        bedrockModelIds,
                        inferenceMaxRetries: 0,
                    }),
            },
            {},
        );
        expect(wireModel(request)).toBe("us.moonshotai.kimi-k3");
    });
});

interface CapturedRequest {
    url: string;
    body: string;
}

/** The model a request names: Bedrock Runtime's Anthropic route carries it in the path. */
function wireModel(request: CapturedRequest): string {
    const path = /\/model\/([^/]+)\/invoke/u.exec(request.url)?.[1];
    if (path !== undefined) return decodeURIComponent(path);
    return (JSON.parse(request.body) as { model: string }).model;
}

async function bearer(): Promise<BedrockCredential> {
    const credential = await BedrockBearerTokenCredential.tryLoad({
        bearerToken: "bedrock-model-ids-token",
    });
    if (credential === null) throw new Error("Expected a Bedrock test credential.");
    return credential;
}

async function capture(
    route: Route,
    bedrockModelIds: Record<string, string>,
    runModel = route.model,
): Promise<CapturedRequest> {
    let captured: CapturedRequest | undefined;
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("end", () => {
            captured ??= {
                url: request.url ?? "",
                body: Buffer.concat(chunks).toString("utf8"),
            };
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ message: "Captured." }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Bedrock model ID test server port.");
    }
    const provider = route.provider(
        await bearer(),
        `http://127.0.0.1:${address.port}/gw`,
        bedrockModelIds,
    );
    const session = await provider.session("bedrock-model-ids", {
        instructions: "Session instructions.",
        tools: [],
        modelConfigurations: { [route.model]: curated },
    });
    try {
        for await (const _event of session.run(testContext, {
            model: runModel,
            // An unrecognized model needs an explicit effort on Codex; every route accepts high.
            effort: "high",
            context: {
                instructions: "Run instructions.",
                messages: [{ role: "user", content: [{ type: "text" as const, text: "Hello." }] }],
            },
        })) {
            // Draining the stream is what performs the request under test.
        }
    } catch {
        // The test server refuses the request once it has recorded it.
    } finally {
        session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (captured === undefined) throw new Error(`${route.name} sent no request.`);
    return captured;
}
