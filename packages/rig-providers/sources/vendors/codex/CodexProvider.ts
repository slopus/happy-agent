import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { CodexProviderCredential } from "@/vendors/VendorCredential.js";
import {
    BEDROCK_DEFAULT_REGION,
    bedrockMantleEndpoint,
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
    credential: CodexProviderCredential;
    endpoint?: string;
    /**
     * Tools OpenAI runs on its own backend, such as its own `web_search`. Opting in is what gives
     * a session live results; a session that asks for nothing gets nothing. Asked for once per
     * request, so what the caller may declare can narrow without a new session.
     */
    hostedTools?: () => readonly SessionTool[];
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

export class CodexProvider extends ResponsesProvider {
    static override readonly name = "codex";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly credential: CodexProviderCredential;
    readonly endpoint: string;
    readonly hostedTools: (() => readonly SessionTool[]) | undefined;
    readonly model: string | undefined;
    readonly parallelToolCalls: boolean | undefined;
    readonly streamIdleTimeoutMs: number;
    readonly transport: CodexTransport;
    readonly userAgent: string | undefined;
    readonly #resolveInferenceMaxRetries: () => number;
    readonly #waitForInferenceRetry: InferenceRetryOptions["waitForInferenceRetry"];

    constructor(options: CodexProviderOptions) {
        super();
        assertCodexCredential(options.credential);
        this.credential = options.credential;
        const isBedrock = options.credential.name === "bedrock-bearer-token";
        const region =
            options.region?.trim() ||
            process.env.AWS_REGION?.trim() ||
            process.env.AWS_DEFAULT_REGION?.trim() ||
            BEDROCK_DEFAULT_REGION;
        this.hostedTools = options.hostedTools;
        this.endpoint =
            options.endpoint ??
            (isBedrock
                ? bedrockMantleEndpoint(region)
                : options.credential.name === "codex-session"
                  ? CODEX_CHATGPT_ENDPOINT
                  : CODEX_API_ENDPOINT);
        this.model =
            options.model === undefined
                ? undefined
                : resolveCodexSessionModelId(options.model, isBedrock);
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
        if (this.credential.name === "bedrock-bearer-token") {
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
            credential: this.credential,
            endpoint: this.endpoint,
            ...(this.hostedTools === undefined ? {} : { hostedTools: this.hostedTools }),
            installationId,
            ...(this.model === undefined ? {} : { model: this.model }),
            ...(this.parallelToolCalls === undefined
                ? {}
                : { parallelToolCalls: this.parallelToolCalls }),
            resolveInferenceMaxRetries: () => this.inferenceMaxRetries,
            ...(this.#waitForInferenceRetry === undefined
                ? {}
                : { waitForInferenceRetry: this.#waitForInferenceRetry }),
            streamIdleTimeoutMs: this.streamIdleTimeoutMs,
            transport: this.transport,
            userAgent,
        });
    }
}
