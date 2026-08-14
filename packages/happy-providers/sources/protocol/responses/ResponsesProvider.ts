import { BaseProvider } from "@/core/BaseProvider.js";
import type { BaseSession } from "@/core/BaseSession.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import {
    createInferenceFatalRetriesResolver,
    createInferenceMaxRetriesResolver,
    sessionInferenceFatalRetriesResolver,
    sessionInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import { ResponsesSession } from "@/protocol/responses/ResponsesSession.js";
import type { ResponsesCapabilities } from "@/protocol/responses/ResponsesCapabilities.js";

export interface ResponsesProviderOptions extends InferenceRetryOptions {
    apiKey: string;
    endpoint: string;
    model?: string;
    headers?: Readonly<Record<string, string>>;
    fetch?: typeof fetch;
    nativeCompaction?: boolean;
    capabilities?: ResponsesCapabilities;
}

export class ResponsesProvider extends BaseProvider {
    static override readonly name: string = "responses";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    private readonly options: ResponsesProviderOptions | undefined;

    constructor(options?: ResponsesProviderOptions) {
        super();
        this.options = options;
    }

    async session(id: string, options: SessionOptions): Promise<BaseSession> {
        if (this.options === undefined) {
            throw new Error("ResponsesProvider requires an endpoint and API key.");
        }
        // Provider options carry the transport configuration, but a session naming its own retry
        // budget outranks the provider's, like every other provider here.
        return new ResponsesSession(id, {
            ...options,
            ...this.options,
            resolveInferenceFatalRetries: sessionInferenceFatalRetriesResolver(
                options,
                createInferenceFatalRetriesResolver(this.options),
            ),
            resolveInferenceMaxRetries: sessionInferenceMaxRetriesResolver(
                options,
                createInferenceMaxRetriesResolver(this.options),
            ),
        });
    }
}
