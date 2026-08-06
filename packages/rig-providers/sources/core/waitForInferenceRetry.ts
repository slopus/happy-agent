export function waitForInferenceRetry(
    attempt: number,
    signal?: AbortSignal,
    random: () => number = Math.random,
): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new DOMException("Request was aborted", "AbortError"));
    }
    const base = Math.min(30_000, 200 * 2 ** Math.max(0, attempt - 1));
    const delay = Math.round(base * (0.9 + random() * 0.2));
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            clearTimeout(timeout);
            reject(new DOMException("Request was aborted", "AbortError"));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
    });
}
