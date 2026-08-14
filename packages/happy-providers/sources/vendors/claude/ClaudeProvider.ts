import type { ProviderModality } from "@/core/ProviderModality.js";
import type { ProviderUsage } from "@/core/ProviderUsage.js";
import { BaseProvider } from "@/core/BaseProvider.js";
import {
    createInferenceFatalRetriesResolver,
    createInferenceMaxRetriesResolver,
    sessionInferenceFatalRetriesResolver,
    sessionInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { ClaudeCredential } from "@/vendors/VendorCredential.js";
import { ClaudeSession, type ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";
import { resolveClaudeModelId } from "@/vendors/claude/impl/resolveClaudeModelId.js";

export interface ClaudeProviderOptions extends InferenceRetryOptions {
    credential: ClaudeCredential;
    env?: NodeJS.ProcessEnv;
    model?: string;
    /** Receives the account usage the limiter reports during inference. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    pathToClaudeCodeExecutable?: string;
    query?: ClaudeSdkQuery;
    /** Identifies the caller instead of Claude Code, which is the default. */
    userAgent?: string;
}

export class ClaudeProvider extends BaseProvider {
    static override readonly name = "claude";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly credential: ClaudeCredential;
    readonly env: NodeJS.ProcessEnv | undefined;
    readonly model: string | undefined;
    readonly onAccountUsage: ((usage: ProviderUsage) => void) | undefined;
    readonly pathToClaudeCodeExecutable: string | undefined;
    readonly query: ClaudeSdkQuery | undefined;
    readonly userAgent: string | undefined;
    readonly #resolveInferenceMaxRetries: () => number;
    readonly #resolveInferenceFatalRetries: () => number;
    readonly #waitForInferenceRetry: InferenceRetryOptions["waitForInferenceRetry"];

    constructor(options: ClaudeProviderOptions) {
        super();
        this.credential = options.credential;
        this.env = options.env;
        this.model = options.model === undefined ? undefined : resolveClaudeModelId(options.model);
        this.onAccountUsage = options.onAccountUsage;
        this.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
        this.query = options.query;
        this.userAgent = options.userAgent;
        this.#resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.#resolveInferenceFatalRetries = createInferenceFatalRetriesResolver(options);
        this.#waitForInferenceRetry = options.waitForInferenceRetry;
    }

    override async session(id: string, options: SessionOptions): Promise<ClaudeSession> {
        return new ClaudeSession(id, {
            ...options,
            credential: this.credential,
            ...(this.env === undefined ? {} : { env: this.env }),
            ...(this.model === undefined ? {} : { model: this.model }),
            ...(this.onAccountUsage === undefined ? {} : { onAccountUsage: this.onAccountUsage }),
            ...(this.pathToClaudeCodeExecutable === undefined
                ? {}
                : { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }),
            ...(this.query === undefined ? {} : { query: this.query }),
            resolveInferenceMaxRetries: sessionInferenceMaxRetriesResolver(
                options,
                this.#resolveInferenceMaxRetries,
            ),
            resolveInferenceFatalRetries: sessionInferenceFatalRetriesResolver(
                options,
                this.#resolveInferenceFatalRetries,
            ),
            ...(this.#waitForInferenceRetry === undefined
                ? {}
                : { waitForInferenceRetry: this.#waitForInferenceRetry }),
            ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        });
    }
}
