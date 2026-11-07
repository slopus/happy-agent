import { AnthropicBedrock, AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import {
    bedrockRuntimeEndpoint,
    isBedrockChinaRegion,
} from "@/vendors/bedrock/impl/bedrockConstants.js";
import { bedrockEndpointOptions } from "@/vendors/bedrock/impl/bedrockEndpointOptions.js";

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
        ...(options.endpoint !== undefined
            ? bedrockEndpointOptions(options.endpoint)
            : // The SDK's own Runtime default only knows the commercial partition's domain.
              options.transport === "runtime" && isBedrockChinaRegion(options.region)
              ? { baseURL: bedrockRuntimeEndpoint(options.region) }
              : {}),
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
