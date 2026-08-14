export const DEFAULT_INFERENCE_MAX_RETRIES = 10;
export const DEFAULT_INFERENCE_FATAL_RETRIES = 0;
export const MAX_INFERENCE_MAX_RETRIES = 100;

export function resolveInferenceMaxRetries(value?: number): number {
    return resolveRetrySetting(value, DEFAULT_INFERENCE_MAX_RETRIES, "inferenceMaxRetries");
}

export function resolveInferenceFatalRetries(value?: number): number {
    return resolveRetrySetting(value, DEFAULT_INFERENCE_FATAL_RETRIES, "inferenceFatalRetries");
}

function resolveRetrySetting(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw new TypeError(`${name} must be a finite nonnegative integer.`);
    }
    return Math.min(value, MAX_INFERENCE_MAX_RETRIES);
}

export interface InferenceRetryOptions {
    /** Maximum provider-owned retries of transient failures. Ten permit up to eleven attempts. */
    readonly inferenceMaxRetries?: number;
    /**
     * Maximum provider-owned retries of fatal failures: rejections such as a model refusal or a
     * spent account that would otherwise end the run the moment they arrive. Zero, the default,
     * reports them immediately. Cancellation and context overflow are never retried, because the
     * caller owns both.
     */
    readonly inferenceFatalRetries?: number;
    /** Resolves the current limit so long-lived sessions follow runtime configuration changes. */
    resolveInferenceMaxRetries?: () => number;
    /** Resolves the current fatal limit the same way. */
    resolveInferenceFatalRetries?: () => number;
    /** Test seam for provider-owned empty-response backoff. */
    waitForInferenceRetry?: (attempt: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Lets one session opt out of the provider's retry budget.
 *
 * A provider decides how its own conversation recovers, but a caller running a single bounded
 * request on the side is answering to something else — a tool call waiting on it, with a person
 * watching. Waiting out ten attempts there spends minutes to reach a failure the caller would
 * rather have had at once, so the session may name its own budget and the provider honors it.
 */
export function sessionInferenceMaxRetriesResolver(
    options: { inferenceMaxRetries?: number },
    providerResolver: () => number,
): () => number {
    if (options.inferenceMaxRetries === undefined) return providerResolver;
    const configured = resolveInferenceMaxRetries(options.inferenceMaxRetries);
    return () => configured;
}

/** The same session-level override for the fatal budget. */
export function sessionInferenceFatalRetriesResolver(
    options: { inferenceFatalRetries?: number },
    providerResolver: () => number,
): () => number {
    if (options.inferenceFatalRetries === undefined) return providerResolver;
    const configured = resolveInferenceFatalRetries(options.inferenceFatalRetries);
    return () => configured;
}

export function createInferenceMaxRetriesResolver(options: InferenceRetryOptions): () => number {
    const configured =
        options.resolveInferenceMaxRetries ??
        (() => resolveInferenceMaxRetries(options.inferenceMaxRetries));
    const resolve = (): number => resolveInferenceMaxRetries(configured());
    resolve();
    return resolve;
}

export function createInferenceFatalRetriesResolver(options: InferenceRetryOptions): () => number {
    const configured =
        options.resolveInferenceFatalRetries ??
        (() => resolveInferenceFatalRetries(options.inferenceFatalRetries));
    const resolve = (): number => resolveInferenceFatalRetries(configured());
    resolve();
    return resolve;
}
