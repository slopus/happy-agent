import { BaseProvider } from "@/core/BaseProvider.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import {
    createInferenceMaxRetriesResolver,
    sessionInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import { assertBedrockCredential } from "@/vendors/bedrock/impl/assertBedrockCredential.js";
import { bedrockRuntimeOpenAIEndpoint } from "@/vendors/bedrock/impl/bedrockConstants.js";
import { ChatCompletionsConnection } from "@/protocol/chatCompletions/ChatCompletionsConnection.js";
import { ChatCompletionsSession } from "@/protocol/chatCompletions/ChatCompletionsSession.js";
import { kimiCompactionInstructions } from "./prompts/kimi_compaction_instructions.js";
import { createKimiCompactedContext } from "./impl/createKimiCompactedContext.js";

export interface KimiProviderOptions extends InferenceRetryOptions {
    credential: BedrockCredential;
    region?: string;
    endpoint?: string;
    model?: string;
    userAgent?: string;
    fetch?: typeof fetch;
}

/** Kimi Code's Chat Completions protocol, served through Bedrock Runtime only. */
export class KimiProvider extends BaseProvider {
    static override readonly name = "kimi";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];
    private readonly options: KimiProviderOptions;
    private readonly retries: () => number;

    constructor(options: KimiProviderOptions) {
        super();
        assertBedrockCredential(options.credential);
        this.options = options;
        this.retries = createInferenceMaxRetriesResolver(options);
    }

    async session(id: string, options: SessionOptions): Promise<ChatCompletionsSession> {
        const region = this.options.region ?? "us-east-1";
        const model = this.options.model ?? "moonshotai/kimi-k3";
        resolveKimiModel(model, region);
        return new ChatCompletionsSession(id, {
            ...this.options,
            ...options,
            model,
            resolveInferenceMaxRetries: sessionInferenceMaxRetriesResolver(options, this.retries),
            connection: new ChatCompletionsConnection({
                ...this.options,
                region,
                endpoint: this.options.endpoint ?? bedrockRuntimeOpenAIEndpoint(region),
                userAgent: this.options.userAgent ?? "kimi-code",
            }),
            resolveModel: (selected) => resolveKimiModel(selected, region),
            generation: (request) => {
                const effort = request.effort ?? "max";
                if (effort !== "low" && effort !== "high" && effort !== "max") {
                    throw new Error("Kimi K3 supports low, high, and max reasoning effort.");
                }
                return { reasoning_effort: effort };
            },
            compactionInstructions: kimiCompactionInstructions,
            createCompactedContext: createKimiCompactedContext,
        });
    }
}

function resolveKimiModel(model: string, region: string): string {
    if (model === "moonshotai/kimi-k3" || model === "kimi-k3")
        return `${region.startsWith("us-") ? "us" : "global"}.moonshotai.kimi-k3`;
    if (model === "us.moonshotai.kimi-k3" || model === "global.moonshotai.kimi-k3") return model;
    throw new Error(`Kimi K3 is not available through this Bedrock model selection: ${model}.`);
}
