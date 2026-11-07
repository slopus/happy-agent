import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialsProvider } from "openai/providers/bedrock/aws";

import { bedrockSigningQuery } from "@/vendors/bedrock/impl/bedrockEndpointOptions.js";

const SIGNATURE_HEADERS = [
    "authorization",
    "x-amz-date",
    "x-amz-security-token",
    "x-amz-content-sha256",
];

/**
 * The Anthropic Bedrock SDK signs `host` as the endpoint's hostname alone, while the request goes
 * out with `host: hostname:port`, so AWS rejects every SigV4 request to an endpoint with a port of
 * its own. This fetch signs the request again over the host it is actually sent to. It is installed
 * only for such an endpoint, leaving default-port requests exactly as the SDK signs them.
 */
export function signBedrockEndpointPort(
    credentials: AwsCredentialsProvider,
    region: string,
    service: "bedrock" | "bedrock-mantle",
): typeof fetch {
    const signer = new SignatureV4({
        credentials: async () => await credentials(),
        region,
        service,
        sha256: Hash.bind(null, "sha256"),
    });
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        for (const name of SIGNATURE_HEADERS) headers.delete(name);
        headers.delete("connection");
        headers.set("host", url.host);
        const body = init?.body;
        if (body !== undefined && body !== null && typeof body !== "string") {
            throw new Error(
                "Bedrock SigV4 requests to an endpoint port require a replayable body.",
            );
        }
        const method = (
            init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const signed = await signer.sign({
            method,
            protocol: url.protocol,
            hostname: url.hostname,
            port: Number(url.port),
            path: url.pathname,
            query: bedrockSigningQuery(url),
            headers: Object.fromEntries(headers.entries()),
            ...(typeof body === "string" ? { body } : {}),
        });
        // Looked up per request, so anything that wraps the global fetch still sees this call.
        return await globalThis.fetch(url, { ...init, method, headers: signed.headers });
    };
}
