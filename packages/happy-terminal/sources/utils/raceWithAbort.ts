export const ABORTED_BY_SIGNAL = Symbol("aborted_by_signal");

export async function raceWithAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED_BY_SIGNAL> {
    // The operation may have started before its caller discovers that the signal is already
    // aborted. Always observe its rejection before either early return so that losing work cannot
    // escape as an unhandled rejection.
    void promise.catch(() => undefined);
    if (signal === undefined) return promise;
    if (signal.aborted) return ABORTED_BY_SIGNAL;

    let resolveAbort = () => {};
    const aborted = new Promise<typeof ABORTED_BY_SIGNAL>((resolve) => {
        resolveAbort = () => resolve(ABORTED_BY_SIGNAL);
    });
    signal.addEventListener("abort", resolveAbort, { once: true });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        signal.removeEventListener("abort", resolveAbort);
    }
}
