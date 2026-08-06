import { BaseProvider } from "@/core/BaseProvider.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import {
    AnthropicBedrockSession,
    type AnthropicBedrockClient,
} from "@/vendors/bedrock/AnthropicBedrockSession.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import { assertBedrockCredential } from "@/vendors/bedrock/impl/assertBedrockCredential.js";
import { BEDROCK_DEFAULT_REGION } from "@/vendors/bedrock/impl/bedrockConstants.js";

export interface AnthropicBedrockProviderOptions extends InferenceRetryOptions {
    credential: BedrockCredential;
    client?: AnthropicBedrockClient;
    endpoint?: string;
    model?: string;
    region?: string;
    transport?: AnthropicBedrockTransport;
    /** Identifies the caller instead of the Anthropic SDK, which is the default. */
    userAgent?: string;
}

export class AnthropicBedrockProvider extends BaseProvider {
    static override readonly name = "anthropic-bedrock";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly credential: BedrockCredential;
    readonly client: AnthropicBedrockClient | undefined;
    readonly endpoint: string | undefined;
    readonly model: string | undefined;
    readonly region: string;
    readonly transport: AnthropicBedrockTransport;
    readonly userAgent: string | undefined;
    readonly #resolveInferenceMaxRetries: () => number;
    readonly #waitForInferenceRetry: InferenceRetryOptions["waitForInferenceRetry"];

    constructor(options: AnthropicBedrockProviderOptions) {
        super();
        assertBedrockCredential(options.credential);
        this.credential = options.credential;
        this.client = options.client;
        this.endpoint = options.endpoint;
        this.model = options.model;
        this.region = options.region?.trim() || BEDROCK_DEFAULT_REGION;
        this.transport = options.transport ?? "mantle";
        this.userAgent = options.userAgent;
        this.#resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.#waitForInferenceRetry = options.waitForInferenceRetry;
    }

    override async session(id: string, options: SessionOptions): Promise<AnthropicBedrockSession> {
        return new AnthropicBedrockSession(id, {
            ...options,
            credential: this.credential,
            ...(this.client === undefined ? {} : { client: this.client }),
            ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
            ...(this.model === undefined ? {} : { model: this.model }),
            region: this.region,
            resolveInferenceMaxRetries: this.#resolveInferenceMaxRetries,
            ...(this.#waitForInferenceRetry === undefined
                ? {}
                : { waitForInferenceRetry: this.#waitForInferenceRetry }),
            transport: this.transport,
            ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        });
    }
}
