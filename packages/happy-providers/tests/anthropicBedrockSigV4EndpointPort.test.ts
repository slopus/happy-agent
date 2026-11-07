import { testContext } from "./testContext.js";

import { createServer, type IncomingHttpHeaders } from "node:http";

import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { describe, expect, it } from "vitest";

import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockAwsCredential } from "@/vendors/bedrock/BedrockAwsCredential.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";

const AWS = {
    accessKeyId: "TESTACCESSKEY",
    secretAccessKey: "test-secret-key",
    sessionToken: "test-session-token",
};

const RUNTIME_PATH = "/model/global.anthropic.claude-sonnet-5-5/invoke-with-response-stream";

const transports = [
    { transport: "runtime", service: "bedrock", path: RUNTIME_PATH, marker: "" },
    { transport: "mantle", service: "bedrock-mantle", path: "/v1/messages", marker: "beta=true" },
] as const;

// Every endpoint here carries the test server's own port, which is never a scheme's default.
describe.each(transports)("Anthropic Bedrock $transport SigV4 on an endpoint port", (route) => {
    it("signs the host and port the request is sent to", async () => {
        const request = await capture(route.transport, "aws", "/gw");
        expect(request.url).toBe(`/gw${route.path}${route.marker ? `?${route.marker}` : ""}`);
        expect(request.headers["host"]).toBe(`127.0.0.1:${request.port}`);
        expect(await signatureMatches(request, route.service)).toBe(true);
    });

    it("signs the endpoint's query with the host and port", async () => {
        const request = await capture(route.transport, "aws", "/gw?route=fixture&team%20id=a%2Fb");
        expect(new URL(request.url, "http://wire").pathname).toBe(`/gw${route.path}`);
        expect(new URL(request.url, "http://wire").searchParams.get("route")).toBe("fixture");
        expect(new URL(request.url, "http://wire").searchParams.get("team id")).toBe("a/b");
        expect(await signatureMatches(request, route.service)).toBe(true);
    });

    it("leaves a bearer token request unsigned", async () => {
        const request = await capture(route.transport, "bearer", "/gw?route=fixture");
        expect(request.headers["authorization"]).toBe("Bearer bedrock-port-token");
        expect(request.headers["x-amz-date"]).toBeUndefined();
    });
});

// The SDK removes `beta` from every Runtime request, since Anthropic's `?beta=true` marker means
// nothing to Bedrock Runtime; an endpoint's own `beta` goes with it. Mantle keeps an endpoint `beta`
// in place of its marker.
describe("Anthropic Bedrock endpoint parameter named beta", () => {
    it.each(["aws", "bearer"] as const)("is dropped on Runtime with %s", async (auth) => {
        const request = await capture("runtime", auth, "/gw?beta=custom&route=fixture");
        expect(request.url).toBe(`/gw${RUNTIME_PATH}?route=fixture`);
        if (auth === "aws") expect(await signatureMatches(request, "bedrock")).toBe(true);
    });

    it.each(["aws", "bearer"] as const)("replaces Mantle's marker with %s", async (auth) => {
        const request = await capture("mantle", auth, "/gw?beta=custom");
        expect(request.url).toBe("/gw/v1/messages?beta=custom");
        if (auth === "aws") expect(await signatureMatches(request, "bedrock-mantle")).toBe(true);
    });
});

interface CapturedRequest {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
    port: number;
}

async function capture(
    transport: AnthropicBedrockTransport,
    authentication: "aws" | "bearer",
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
        throw new Error("Missing Anthropic Bedrock test server port.");
    }
    const credential =
        authentication === "aws"
            ? await BedrockAwsCredential.tryLoad({ credentialProvider: async () => AWS })
            : await BedrockBearerTokenCredential.tryLoad({ bearerToken: "bedrock-port-token" });
    if (credential === null) throw new Error("Expected a Bedrock test credential.");
    const provider = new AnthropicBedrockProvider({
        credential,
        endpoint: `http://127.0.0.1:${address.port}${endpointPath}`,
        model: "global.anthropic.claude-sonnet-5-5",
        region: "us-east-1",
        transport,
        inferenceMaxRetries: 0,
    });
    const session = await provider.session("endpoint-port-session", {
        instructions: "",
        tools: [],
    });
    try {
        for await (const _event of session.run(testContext, {
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
    if (captured === undefined) throw new Error(`Anthropic Bedrock ${transport} sent no request.`);
    return { ...captured, port: address.port };
}

/** Re-signs the request as it arrived, so a signature over any other host or query cannot match. */
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
