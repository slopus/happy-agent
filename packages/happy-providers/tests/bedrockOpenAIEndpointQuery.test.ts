import { testContext } from "./testContext.js";

import { createServer, type IncomingHttpHeaders } from "node:http";

import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { describe, expect, it } from "vitest";

import type { BaseProvider } from "@/core/BaseProvider.js";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import { BedrockAwsCredential } from "@/vendors/bedrock/BedrockAwsCredential.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { GlmProvider } from "@/vendors/glm/GlmProvider.js";
import { KimiProvider } from "@/vendors/kimi/KimiProvider.js";

const AWS = {
    accessKeyId: "TESTACCESSKEY",
    secretAccessKey: "test-secret-key",
    sessionToken: "test-session-token",
};

type Authentication = "bearer" | "aws";

const routes = [
    {
        name: "Codex on Bedrock Mantle",
        path: "/responses",
        service: "bedrock-mantle",
        provider: (credential: BedrockCredential, endpoint: string) =>
            new CodexProvider({
                credential,
                endpoint,
                model: "openai/gpt-5.4",
                region: "us-east-1",
                bedrockTransport: "mantle",
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "Codex on Bedrock Runtime",
        service: "bedrock",
        path: "/responses",
        provider: (credential: BedrockCredential, endpoint: string) =>
            new CodexProvider({
                credential,
                endpoint,
                model: "openai/gpt-6-astra",
                region: "us-east-1",
                bedrockTransport: "runtime",
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "Kimi on Bedrock Runtime",
        service: "bedrock",
        path: "/chat/completions",
        provider: (credential: BedrockCredential, endpoint: string) =>
            new KimiProvider({ credential, endpoint, region: "us-east-1", inferenceMaxRetries: 0 }),
    },
    {
        name: "GLM on Bedrock Runtime",
        service: "bedrock",
        path: "/chat/completions",
        provider: (credential: BedrockCredential, endpoint: string) =>
            new GlmProvider({ credential, endpoint, region: "us-east-1", inferenceMaxRetries: 0 }),
    },
    {
        name: "Kimi on a Bedrock Mantle route",
        service: "bedrock-mantle",
        path: "/chat/completions",
        provider: (credential: BedrockCredential, endpoint: string) =>
            new KimiProvider({
                credential,
                endpoint,
                region: "us-east-1",
                bedrockTransport: "mantle",
                inferenceMaxRetries: 0,
            }),
    },
    {
        name: "GLM on a Bedrock Mantle route",
        service: "bedrock-mantle",
        path: "/chat/completions",
        provider: (credential: BedrockCredential, endpoint: string) =>
            new GlmProvider({
                credential,
                endpoint,
                region: "us-east-1",
                bedrockTransport: "mantle",
                inferenceMaxRetries: 0,
            }),
    },
] as const;

describe.each(routes)("$name endpoint with a query string", (route) => {
    it.each(["bearer", "aws"] as const)(
        "keeps the base path and the endpoint's query with %s authentication",
        async (authentication) => {
            const request = await capture(route, authentication, "/gw/openai/v1?route=fixture");
            expect(request.url).toBe(`/gw/openai/v1${route.path}?route=fixture`);
            if (authentication === "aws")
                expect(await signatureMatches(request, route.service)).toBe(true);
        },
    );

    it("encodes the query's names and values as the SDK sends every parameter", async () => {
        const request = await capture(route, "bearer", "/gw?team%20id=a%2Fb%26c&empty=");
        expect(request.url).toBe(`/gw${route.path}?team%20id=a%2Fb%26c&empty=`);
    });

    it("sends only the last value of a name the endpoint repeats", async () => {
        const request = await capture(route, "bearer", "/gw?route=first&route=last");
        expect(request.url).toBe(`/gw${route.path}?route=last`);
    });

    it("leaves an endpoint without a query exactly as it was", async () => {
        const request = await capture(route, "bearer", "/gw/openai/v1");
        expect(request.url).toBe(`/gw/openai/v1${route.path}`);
    });
});

// The test server's own port is never a scheme's default, so these also cover a custom port.
describe.each(routes)("$name endpoint on a port of its own", (route) => {
    it("signs the host and port the request is sent to for the route's service", async () => {
        const request = await capture(route, "aws", "/gw/openai/v1");
        expect(request.url).toBe(`/gw/openai/v1${route.path}`);
        expect(request.headers.host).toBe(`127.0.0.1:${request.port}`);
        expect(request.headers.authorization).toMatch(
            new RegExp(`/us-east-1/${route.service}/aws4_request,`, "u"),
        );
        expect(await signatureMatches(request, route.service)).toBe(true);
    });

    it("sends a bearer token unsigned", async () => {
        const request = await capture(route, "bearer", "/gw/openai/v1");
        expect(request.headers.authorization).toBe("Bearer bedrock-query-token");
        expect(request.headers["x-amz-date"]).toBeUndefined();
    });
});

describe.each(["runtime", "mantle"] as const)(
    "Codex on Bedrock %s with a model ARN",
    (transport) => {
        it.each([
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.openai.gpt-6-astra",
            "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6",
        ])("sends %s unchanged as the model", async (arn) => {
            const request = await capture(
                {
                    name: `Codex on Bedrock ${transport}`,
                    effort: "medium",
                    provider: (credential, endpoint) =>
                        new CodexProvider({
                            credential,
                            endpoint,
                            model: arn,
                            region: "us-east-1",
                            bedrockTransport: transport,
                            inferenceMaxRetries: 0,
                        }),
                },
                "aws",
                "/gw/openai/v1",
            );
            expect(JSON.parse(request.body)).toMatchObject({ model: arn });
            expect(
                await signatureMatches(
                    request,
                    transport === "runtime" ? "bedrock" : "bedrock-mantle",
                ),
            ).toBe(true);
        });
    },
);

interface CapturedRequest {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
    port: number;
}

interface Route {
    name: string;
    provider: (credential: BedrockCredential, endpoint: string) => BaseProvider;
    /** Codex requires an explicit effort for a model it does not recognize, such as an ARN. */
    effort?: "medium";
}

async function capture(
    route: Route,
    authentication: Authentication,
    endpointPath: string,
): Promise<CapturedRequest> {
    let captured: Omit<CapturedRequest, "port"> | undefined;
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("end", () => {
            captured ??= {
                method: request.method ?? "",
                url: request.url ?? "",
                headers: request.headers,
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
        throw new Error("Missing Bedrock endpoint test server port.");
    }
    const credential =
        authentication === "bearer"
            ? await BedrockBearerTokenCredential.tryLoad({ bearerToken: "bedrock-query-token" })
            : await BedrockAwsCredential.tryLoad({ credentialProvider: async () => AWS });
    if (credential === null) throw new Error("Expected a Bedrock test credential.");
    const provider: BaseProvider = route.provider(
        credential,
        `http://127.0.0.1:${address.port}${endpointPath}`,
    );
    const session = await provider.session("endpoint-query-session", {
        instructions: "",
        tools: [],
    });
    try {
        for await (const _event of session.run(testContext, {
            ...(route.effort === undefined ? {} : { effort: route.effort }),
            context: {
                instructions: "",
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
    return { ...captured, port: address.port };
}

/** Re-signs the request as it arrived, so a signature that left out its query cannot match. */
async function signatureMatches(request: CapturedRequest, service: string): Promise<boolean> {
    const authorization = request.headers["authorization"];
    const date = request.headers["x-amz-date"];
    if (typeof authorization !== "string" || typeof date !== "string") return false;
    const signedNames = /SignedHeaders=([^,]+)/u.exec(authorization)?.[1]?.split(";") ?? [];
    const headers = Object.fromEntries(
        signedNames.map((name) => [name, String(request.headers[name] ?? "")]),
    );
    const url = new URL(request.url, `http://127.0.0.1:${request.port}`);
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of url.searchParams) {
        const existing = query[name];
        query[name] =
            existing === undefined
                ? value
                : typeof existing === "string"
                  ? [existing, value]
                  : [...existing, value];
    }
    const signer = new SignatureV4({
        credentials: AWS,
        region: "us-east-1",
        service,
        sha256: Hash.bind(null, "sha256"),
    });
    const expected = await signer.sign(
        {
            method: request.method,
            protocol: "http:",
            hostname: "127.0.0.1",
            port: request.port,
            path: url.pathname,
            query,
            headers,
            body: request.body,
        },
        {
            signingDate: new Date(
                date.replace(
                    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u,
                    "$1-$2-$3T$4:$5:$6Z",
                ),
            ),
        },
    );
    return expected.headers["authorization"] === authorization;
}
