export const DEFAULT_INFERENCE_MAX_RETRIES = 10;
export const MAX_INFERENCE_MAX_RETRIES = 100;

export function resolveInferenceMaxRetries(value?: number): number {
    if (value === undefined) return DEFAULT_INFERENCE_MAX_RETRIES;
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw new TypeError("inferenceMaxRetries must be a finite nonnegative integer.");
    }
    return Math.min(value, MAX_INFERENCE_MAX_RETRIES);
}

export interface InferenceRetryOptions {
    /** Maximum provider-owned retries. Ten retries permit up to eleven total attempts. */
    inferenceMaxRetries?: number;
    /** Resolves the current limit so long-lived sessions follow runtime configuration changes. */
    resolveInferenceMaxRetries?: () => number;
    /** Test seam for provider-owned empty-response backoff. */
    waitForInferenceRetry?: (attempt: number, signal?: AbortSignal) => Promise<void>;
}

export function createInferenceMaxRetriesResolver(options: InferenceRetryOptions): () => number {
    const configured =
        options.resolveInferenceMaxRetries ??
        (() => resolveInferenceMaxRetries(options.inferenceMaxRetries));
    const resolve = (): number => resolveInferenceMaxRetries(configured());
    resolve();
    return resolve;
}
