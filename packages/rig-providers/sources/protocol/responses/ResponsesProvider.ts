import { BaseProvider } from "@/core/BaseProvider.js";
import type { BaseSession } from "@/core/BaseSession.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { InferenceRetryOptions } from "@/core/inferenceRetrySettings.js";
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
        return new ResponsesSession(id, { ...options, ...this.options });
    }
}
