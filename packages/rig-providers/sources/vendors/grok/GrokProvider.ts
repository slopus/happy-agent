import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import { assertGrokCredential } from "@/vendors/grok/impl/assertGrokCredential.js";
import { GROK_DEFAULT_ENDPOINT } from "@/vendors/grok/impl/grokConstants.js";
import { GrokSession } from "@/vendors/grok/GrokSession.js";
import { resolveGrokModelId } from "@/vendors/grok/impl/resolveGrokModelId.js";
import type { GrokCredential } from "@/vendors/VendorCredential.js";

export interface GrokProviderOptions extends InferenceRetryOptions {
    credential: GrokCredential;
    endpoint?: string;
    model?: string;
    /** Identifies this client upstream instead of reproducing the grok-build user agent. */
    userAgent?: string;
}

export class GrokProvider extends ResponsesProvider {
    static override readonly name: string = "grok";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly credential: GrokCredential;
    readonly endpoint: string;
    readonly model: string | undefined;
    readonly userAgent: string | undefined;
    readonly #resolveInferenceMaxRetries: () => number;
    readonly #waitForInferenceRetry: InferenceRetryOptions["waitForInferenceRetry"];

    constructor(options: GrokProviderOptions) {
        super();
        assertGrokCredential(options.credential);
        this.credential = options.credential;
        const endpoint = options.endpoint?.trim();
        this.endpoint = endpoint && endpoint.length > 0 ? endpoint : GROK_DEFAULT_ENDPOINT;
        this.model = options.model === undefined ? undefined : resolveGrokModelId(options.model);
        this.userAgent = options.userAgent;
        this.#resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.#waitForInferenceRetry = options.waitForInferenceRetry;
    }

    override async session(id: string, options: SessionOptions): Promise<GrokSession> {
        return new GrokSession(id, {
            ...options,
            credential: this.credential,
            endpoint: this.endpoint,
            ...(this.model === undefined ? {} : { model: this.model }),
            resolveInferenceMaxRetries: this.#resolveInferenceMaxRetries,
            ...(this.#waitForInferenceRetry === undefined
                ? {}
                : { waitForInferenceRetry: this.#waitForInferenceRetry }),
            ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        });
    }
}
