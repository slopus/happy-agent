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
import {
    assertBedrockModelIds,
    mappedBedrockModelId,
} from "@/vendors/bedrock/impl/assertBedrockModelIds.js";
import { isBedrockModelArn } from "@/vendors/bedrock/impl/isBedrockModelArn.js";
import { bedrockRuntimeOpenAIEndpoint } from "@/vendors/bedrock/impl/bedrockConstants.js";
import { ChatCompletionsConnection } from "@/protocol/chatCompletions/ChatCompletionsConnection.js";
import { ChatCompletionsSession } from "@/protocol/chatCompletions/ChatCompletionsSession.js";
import { kimiCompactionInstructions } from "./prompts/kimi_compaction_instructions.js";
import { createKimiCompactedContext } from "./impl/createKimiCompactedContext.js";

export interface KimiProviderOptions extends InferenceRetryOptions {
    /**
     * Wire model IDs keyed by the caller's model ID, such as an application-inference-profile ARN.
     * Only the request's `model` changes; everything else stays keyed by the caller's model ID.
     */
    bedrockModelIds?: Readonly<Record<string, string>>;
    /**
     * Runtime by default. AWS does not serve this model on Mantle, so Mantle has no default
     * endpoint and is selected only together with an explicit `endpoint`, signed as `bedrock-mantle`.
     */
    bedrockTransport?: "runtime" | "mantle";
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
        assertBedrockModelIds(options.bedrockModelIds);
        if (options.bedrockTransport === "mantle" && options.endpoint === undefined) {
            throw new Error(
                "AWS does not serve Kimi K3 on Bedrock Mantle. Pass the endpoint of a Mantle-compatible route to use the Mantle transport.",
            );
        }
        this.options = options;
        this.retries = createInferenceMaxRetriesResolver(options);
    }

    async session(id: string, options: SessionOptions): Promise<ChatCompletionsSession> {
        const region = this.options.region ?? "us-east-1";
        const transport = this.options.bedrockTransport ?? "runtime";
        const model = this.options.model ?? "moonshotai/kimi-k3";
        const wireModel = (selected: string) =>
            mappedBedrockModelId(this.options.bedrockModelIds, selected) ??
            resolveKimiModel(selected, region, transport);
        wireModel(model);
        return new ChatCompletionsSession(id, {
            ...this.options,
            ...options,
            model,
            resolveInferenceMaxRetries: sessionInferenceMaxRetriesResolver(options, this.retries),
            connection: new ChatCompletionsConnection({
                ...this.options,
                region,
                endpoint: this.options.endpoint ?? bedrockRuntimeOpenAIEndpoint(region),
                service: transport === "mantle" ? "bedrock-mantle" : "bedrock",
                userAgent: this.options.userAgent ?? "kimi-code",
            }),
            stripSchemaPatterns: true,
            resolveModel: wireModel,
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

/**
 * Runtime needs a cross-region profile, chosen by source region; Mantle names models without one.
 * Explicit profiles and Bedrock ARNs are sent unchanged.
 */
function resolveKimiModel(model: string, region: string, transport: "runtime" | "mantle"): string {
    if (model === "moonshotai/kimi-k3" || model === "kimi-k3") {
        if (transport === "mantle") return "moonshotai.kimi-k3";
        return `${region.startsWith("us-") ? "us" : "global"}.moonshotai.kimi-k3`;
    }
    if (
        model === "us.moonshotai.kimi-k3" ||
        model === "global.moonshotai.kimi-k3" ||
        model === "in.moonshotai.kimi-k3"
    )
        return model;
    if (transport === "mantle" && model === "moonshotai.kimi-k3") return model;
    if (isBedrockModelArn(model)) return model;
    throw new Error(`Kimi K3 is not available through this Bedrock model selection: ${model}.`);
}
