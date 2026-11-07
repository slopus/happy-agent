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
import { isBedrockModelArn } from "@/vendors/bedrock/impl/isBedrockModelArn.js";
import { bedrockRuntimeOpenAIEndpoint } from "@/vendors/bedrock/impl/bedrockConstants.js";
import { ChatCompletionsConnection } from "@/protocol/chatCompletions/ChatCompletionsConnection.js";
import { ChatCompletionsSession } from "@/protocol/chatCompletions/ChatCompletionsSession.js";
import { glmCompactionInstructions } from "./prompts/glm_compaction_instructions.js";
import { createGlmCompactedContext } from "./impl/createGlmCompactedContext.js";

export interface GlmProviderOptions extends InferenceRetryOptions {
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

/** Z.ai GLM 5.3 through the OpenAI-compatible Bedrock Runtime API. */
export class GlmProvider extends BaseProvider {
    static override readonly name = "glm";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];
    private readonly options: GlmProviderOptions;
    private readonly retries: () => number;

    constructor(options: GlmProviderOptions) {
        super();
        assertBedrockCredential(options.credential);
        if (options.bedrockTransport === "mantle" && options.endpoint === undefined) {
            throw new Error(
                "AWS does not serve GLM 5.3 on Bedrock Mantle. Pass the endpoint of a Mantle-compatible route to use the Mantle transport.",
            );
        }
        this.options = options;
        this.retries = createInferenceMaxRetriesResolver(options);
    }

    async session(id: string, options: SessionOptions): Promise<ChatCompletionsSession> {
        const region = this.options.region ?? "us-east-1";
        const transport = this.options.bedrockTransport ?? "runtime";
        const model = this.options.model ?? "zai/glm-5.3";
        resolveGlmModel(model, region, transport);
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
                userAgent: this.options.userAgent ?? "claude-code/2.1.207",
            }),
            stripSchemaPatterns: true,
            resolveModel: (selected) => resolveGlmModel(selected, region, transport),
            generation: (request) => {
                const effort = request.effort ?? "max";
                if (effort !== "low" && effort !== "high" && effort !== "max")
                    throw new Error("GLM 5.3 supports low, high, and max reasoning effort.");
                if (
                    request.context.messages.some(
                        (message) =>
                            message.role !== "compaction" &&
                            message.content.some((block) => block.type === "image"),
                    )
                ) {
                    throw new Error("GLM 5.3 supports text input only.");
                }
                return { reasoning_effort: effort };
            },
            compactionInstructions: glmCompactionInstructions,
            createCompactedContext: createGlmCompactedContext,
        });
    }
}

/**
 * Runtime needs a cross-region profile, chosen by source region; Mantle names models without one.
 * Explicit profiles and Bedrock ARNs are sent unchanged.
 */
function resolveGlmModel(model: string, region: string, transport: "runtime" | "mantle"): string {
    if (model === "zai/glm-5.3" || model === "glm-5.3") {
        if (transport === "mantle") return "zai.glm-5.3";
        return `${region.startsWith("us-") ? "us" : "global"}.zai.glm-5.3`;
    }
    if (model === "us.zai.glm-5.3" || model === "global.zai.glm-5.3") return model;
    if (transport === "mantle" && model === "zai.glm-5.3") return model;
    if (isBedrockModelArn(model)) return model;
    throw new Error(`GLM 5.3 is not available through this Bedrock model selection: ${model}.`);
}
