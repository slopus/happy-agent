import { BaseProvider } from "@/core/BaseProvider.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { SessionReasoningEffort, SessionRunRequest } from "@/core/SessionRunRequest.js";
import {
    createInferenceMaxRetriesResolver,
    sessionInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import { ChatCompletionsConnection } from "@/protocol/chatCompletions/ChatCompletionsConnection.js";
import { ChatCompletionsSession } from "@/protocol/chatCompletions/ChatCompletionsSession.js";
import { createGlmCompactedContext } from "@/vendors/glm/impl/createGlmCompactedContext.js";
import { glmCompactionInstructions } from "@/vendors/glm/prompts/glm_compaction_instructions.js";

/** One model an OpenAI-compatible endpoint serves, as its configuration describes it. */
export interface OpenAICompatibleModel {
    /** The model ID sent on the wire, which is also the ID callers select. */
    readonly id: string;
    /** Whether the model accepts image input. Text-only models reject images before transport. */
    readonly inputTypes?: readonly ProviderModality[];
    /**
     * Reasoning efforts the endpoint accepts as `reasoning_effort`. When omitted, no effort is
     * sent and the endpoint's own default applies.
     */
    readonly efforts?: readonly SessionReasoningEffort[];
    /** Extra top-level request fields for this model, merged over the provider's own. */
    readonly request?: Readonly<Record<string, unknown>>;
}

export interface OpenAICompatibleProviderOptions extends InferenceRetryOptions {
    /** The bearer API key. */
    apiKey: string;
    /** The API base URL, such as `https://openrouter.ai/api/v1`; `/chat/completions` is appended. */
    endpoint: string;
    /** How the vendor is named in errors people read, such as "OpenRouter". */
    vendor: string;
    /** Every model this endpoint may be asked for. */
    models: readonly OpenAICompatibleModel[];
    /** The selected model; the first configured model when omitted. */
    model?: string;
    /**
     * Extra top-level fields sent with every request, such as OpenRouter's
     * `reasoning: { enabled: true }`. Protocol fields this provider owns cannot be replaced.
     */
    request?: Readonly<Record<string, unknown>>;
    /** Extra headers sent with every request. */
    headers?: Readonly<Record<string, string>>;
    /**
     * Where assistant reasoning is replayed on later turns. OpenRouter accepts `reasoning`;
     * endpoints that reject replayed reasoning use null. Null when omitted.
     */
    reasoningField?: "reasoning_content" | "reasoning" | null;
    userAgent?: string;
    fetch?: typeof fetch;
}

/** Fields the Chat Completions protocol owns; configured extras never replace them. */
const PROTOCOL_FIELDS = new Set([
    "model",
    "messages",
    "stream",
    "stream_options",
    "tools",
    "response_format",
]);

/**
 * Any endpoint speaking OpenAI's Chat Completions API with a bearer key: OpenRouter, Together,
 * Fireworks, DeepSeek, vLLM, LM Studio, and the like.
 *
 * There is no vendor harness to reproduce here, so the session carries exactly what the caller
 * supplies. Compaction follows Claude Code's non-Claude contract, the same one GLM uses, because
 * that is the harness these models are given.
 */
export class OpenAICompatibleProvider extends BaseProvider {
    static override readonly name = "openai_compatible";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];
    private readonly options: OpenAICompatibleProviderOptions;
    private readonly retries: () => number;
    private readonly selected: OpenAICompatibleModel;

    constructor(options: OpenAICompatibleProviderOptions) {
        super();
        if (!options.apiKey.trim()) throw new Error(`${options.vendor} needs an API key.`);
        const selected =
            options.model === undefined
                ? options.models[0]
                : options.models.find((candidate) => candidate.id === options.model);
        if (selected === undefined) {
            throw new Error(
                `${options.vendor} is not configured to serve ${options.model ?? "any model"}.`,
            );
        }
        for (const extras of [options.request, ...options.models.map((model) => model.request)]) {
            const reserved = Object.keys(extras ?? {}).find((key) => PROTOCOL_FIELDS.has(key));
            if (reserved !== undefined) {
                throw new Error(`The request field "${reserved}" cannot be configured.`);
            }
        }
        this.options = options;
        this.selected = selected;
        this.retries = createInferenceMaxRetriesResolver(options);
    }

    /** What the selected model accepts, which is what its configuration says. */
    override get inputTypes(): readonly ProviderModality[] {
        return this.selected.inputTypes ?? ["text"];
    }

    async session(id: string, options: SessionOptions): Promise<ChatCompletionsSession> {
        const models = new Map(this.options.models.map((model) => [model.id, model]));
        const vendor = this.options.vendor;
        return new ChatCompletionsSession(id, {
            ...this.options,
            ...options,
            model: this.selected.id,
            resolveInferenceMaxRetries: sessionInferenceMaxRetriesResolver(options, this.retries),
            connection: new ChatCompletionsConnection({
                apiKey: this.options.apiKey,
                endpoint: this.options.endpoint,
                vendor,
                ...(this.options.headers === undefined ? {} : { headers: this.options.headers }),
                ...(this.options.userAgent === undefined
                    ? {}
                    : { userAgent: this.options.userAgent }),
                ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
            }),
            resolveModel: (selected) => {
                if (!models.has(selected))
                    throw new Error(`${vendor} is not configured to serve ${selected}.`);
                return selected;
            },
            generation: (request) => generation(models, request, this.selected.id, this.options),
            compactionInstructions: glmCompactionInstructions,
            createCompactedContext: createGlmCompactedContext,
            reasoningField: this.options.reasoningField ?? null,
            vendor: { name: vendor, fullName: vendor },
        });
    }
}

function generation(
    models: ReadonlyMap<string, OpenAICompatibleModel>,
    request: SessionRunRequest,
    fallback: string,
    options: OpenAICompatibleProviderOptions,
): Readonly<Record<string, unknown>> {
    const model = models.get(request.model ?? fallback)!;
    if (
        !(model.inputTypes ?? ["text"]).includes("image") &&
        request.context.messages.some(
            (message) =>
                message.role !== "compaction" &&
                message.content.some((block) => block.type === "image"),
        )
    ) {
        throw new Error(`${model.id} supports text input only.`);
    }
    const effort = request.effort;
    if (effort === "ultra" && model.efforts === undefined) {
        throw new Error(`${model.id} does not advertise Ultra reasoning effort.`);
    }
    let reasoningEffort: Record<string, unknown> = {};
    if (effort !== undefined && model.efforts !== undefined) {
        if (!model.efforts.includes(effort)) {
            throw new Error(
                `${model.id} supports ${model.efforts.join(", ")} reasoning effort, not ${effort}.`,
            );
        }
        reasoningEffort = { reasoning_effort: effort === "off" ? "none" : effort };
    }
    return { ...options.request, ...model.request, ...reasoningEffort };
}
