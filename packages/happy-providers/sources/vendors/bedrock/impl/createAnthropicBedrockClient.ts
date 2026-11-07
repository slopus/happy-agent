import { AnthropicBedrock, AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";

export type AnthropicBedrockClient = Pick<AnthropicBedrock | AnthropicBedrockMantle, "beta">;

export function createAnthropicBedrockClient(options: {
    credential: BedrockCredential;
    endpoint?: string;
    region: string;
    transport: AnthropicBedrockTransport;
    userAgent?: string;
}): AnthropicBedrockClient {
    const userAgent = options.userAgent?.trim();
    const clientOptions = {
        awsRegion: options.region,
        maxRetries: 0,
        ...(options.endpoint === undefined ? {} : endpointOptions(options.endpoint)),
        // Left to the SDK unless the caller would rather its traffic be recognizable as its own.
        ...(userAgent === undefined || userAgent.length === 0
            ? {}
            : { defaultHeaders: { "User-Agent": userAgent } }),
    };
    if (options.credential.name === "bedrock-bearer-token") {
        const authenticated = {
            ...clientOptions,
            apiKey: options.credential.credential.bearerToken,
        };
        return options.transport === "mantle"
            ? new AnthropicBedrockMantle(authenticated)
            : new AnthropicBedrock(authenticated);
    }
    const provider = options.credential.credential.provider;
    const providerChainResolver = async () => async () => await provider();
    if (options.transport === "mantle") {
        return new AnthropicBedrockMantle({
            ...clientOptions,
            // A profile selects SigV4 ahead of an ambient bearer token. The custom provider still
            // supplies the credentials, so this name is only the SDK's authentication-mode flag.
            awsProfile: options.credential.credential.profile ?? "default",
            providerChainResolver,
        });
    }
    return new AnthropicBedrock({
        ...clientOptions,
        // Runtime defaults an omitted key from AWS_BEARER_TOKEN_BEDROCK. An explicit empty key
        // disables that fallback and leaves signing to the custom AWS credential provider.
        apiKey: "",
        providerChainResolver,
    });
}

/**
 * The SDK appends each request path to `baseURL` as text, so a query on the endpoint would swallow
 * the path and the Runtime rewrite would never match. The query travels as default parameters
 * instead, merged with each request's own.
 */
function endpointOptions(endpoint: string): {
    baseURL: string;
    defaultQuery?: Record<string, string>;
} {
    const url = new URL(endpoint);
    if (url.search === "") return { baseURL: endpoint };
    const defaultQuery = Object.fromEntries(url.searchParams);
    url.search = "";
    url.hash = "";
    return { baseURL: url.toString(), defaultQuery };
}
