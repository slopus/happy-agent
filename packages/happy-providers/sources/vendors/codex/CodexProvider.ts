import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import {
    createInferenceMaxRetriesResolver,
    sessionInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import { isBedrockCredential, type CodexProviderCredential } from "@/vendors/VendorCredential.js";
import {
    BEDROCK_DEFAULT_REGION,
    bedrockMantleEndpoint,
    bedrockRuntimeOpenAIEndpoint,
} from "@/vendors/bedrock/impl/bedrockConstants.js";
import { CodexSession } from "@/vendors/codex/CodexSession.js";
import { assertCodexCredential } from "@/vendors/codex/impl/assertCodexCredential.js";
import { resolveCodexInstallationId } from "@/vendors/codex/impl/resolveCodexInstallationId.js";
import { resolveCodexSessionModelId } from "@/vendors/codex/impl/resolveCodexSessionModelId.js";
import { resolveCodexUserAgent } from "@/vendors/codex/impl/codexUserAgent.js";
import { resolveCodexStreamIdleTimeout } from "@/vendors/codex/impl/codexRetry.js";
import {
    CODEX_API_ENDPOINT,
    CODEX_CHATGPT_ENDPOINT,
    type CodexTransport,
} from "@/vendors/codex/impl/codexConstants.js";
import {
    generateCodexImage,
    type GenerateCodexImageRequest,
    type GenerateCodexImageResult,
} from "@/vendors/codex/generateCodexImage.js";

export interface CodexProviderOptions extends InferenceRetryOptions {
    bedrockTransport?: CodexBedrockTransport;
    credential: CodexProviderCredential;
    endpoint?: string;
    model?: string;
    /** Enables multi-call batches; Codex v2 uses standard Responses instead of Responses Lite. */
    parallelToolCalls?: boolean;
    region?: string;
    /** Maximum time a connected stream may remain idle, matching upstream Codex. */
    streamIdleTimeoutMs?: number;
    transport?: CodexTransport;
    /** Override only when replaying a captured native request. */
    userAgent?: string;
}

export type CodexBedrockTransport = "mantle" | "runtime";

export class CodexProvider extends ResponsesProvider {
    static override readonly name = "codex";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly credential: CodexProviderCredential;
    readonly bedrockTransport: CodexBedrockTransport | undefined;
    readonly endpoint: string;
    readonly model: string | undefined;
    readonly parallelToolCalls: boolean | undefined;
    readonly region: string;
    readonly streamIdleTimeoutMs: number;
    readonly transport: CodexTransport;
    readonly userAgent: string | undefined;
    readonly #resolveInferenceMaxRetries: () => number;
    readonly #waitForInferenceRetry: InferenceRetryOptions["waitForInferenceRetry"];

    constructor(options: CodexProviderOptions) {
        super();
        assertCodexCredential(options.credential);
        this.credential = options.credential;
        const isBedrock = isBedrockCredential(options.credential);
        const region =
            options.region?.trim() ||
            process.env.AWS_REGION?.trim() ||
            process.env.AWS_DEFAULT_REGION?.trim() ||
            BEDROCK_DEFAULT_REGION;
        this.region = region;
        this.bedrockTransport = isBedrock
            ? (options.bedrockTransport ?? defaultBedrockTransport(options.model))
            : undefined;
        this.endpoint =
            options.endpoint ??
            (isBedrock
                ? this.bedrockTransport === "runtime"
                    ? bedrockRuntimeOpenAIEndpoint(region)
                    : bedrockMantleEndpoint(region)
                : options.credential.name === "codex-session"
                  ? CODEX_CHATGPT_ENDPOINT
                  : CODEX_API_ENDPOINT);
        this.model =
            options.model === undefined
                ? undefined
                : resolveCodexSessionModelId(options.model, isBedrock, this.bedrockTransport);
        this.parallelToolCalls = options.parallelToolCalls;
        this.#resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.#waitForInferenceRetry = options.waitForInferenceRetry;
        this.streamIdleTimeoutMs = resolveCodexStreamIdleTimeout(options.streamIdleTimeoutMs);
        this.transport = isBedrock ? "sse" : (options.transport ?? "auto");
        this.userAgent = options.userAgent;
    }

    get inferenceMaxRetries(): number {
        return this.#resolveInferenceMaxRetries();
    }

    async generateImage(request: GenerateCodexImageRequest): Promise<GenerateCodexImageResult> {
        if (isBedrockCredential(this.credential)) {
            throw new Error("Codex image generation is unavailable through Bedrock.");
        }
        const userAgent = this.userAgent ?? (await resolveCodexUserAgent());
        return generateCodexImage({
            credential: this.credential,
            endpoint: this.endpoint,
            request,
            userAgent,
        });
    }

    override async session(id: string, options: SessionOptions): Promise<CodexSession> {
        const installationId = await resolveCodexInstallationId();
        const userAgent = this.userAgent ?? (await resolveCodexUserAgent());
        return new CodexSession(id, {
            ...options,
            ...(this.bedrockTransport === undefined
                ? {}
                : { bedrockTransport: this.bedrockTransport }),
            credential: this.credential,
            endpoint: this.endpoint,
            installationId,
            ...(this.model === undefined ? {} : { model: this.model }),
            ...(this.parallelToolCalls === undefined
                ? {}
                : { parallelToolCalls: this.parallelToolCalls }),
            region: this.region,
            resolveInferenceMaxRetries: sessionInferenceMaxRetriesResolver(
                options,
                () => this.inferenceMaxRetries,
            ),
            ...(this.#waitForInferenceRetry === undefined
                ? {}
                : { waitForInferenceRetry: this.#waitForInferenceRetry }),
            streamIdleTimeoutMs: this.streamIdleTimeoutMs,
            transport: this.transport,
            userAgent,
        });
    }
}

function defaultBedrockTransport(model: string | undefined): CodexBedrockTransport {
    return model === "openai/gpt-6-astra" ||
        model === "openai.gpt-6-astra" ||
        /^(?:global|us)\.openai\.gpt-6-astra$/u.test(model ?? "")
        ? "runtime"
        : "mantle";
}
