export function createStopOnceHandler(
    stop: () => Promise<void> | void,
    onError: (error: unknown) => void,
): () => Promise<void> {
    let stopPromise: Promise<void> | undefined;

    return () => {
        stopPromise ??= (async () => {
            await stop();
        })().catch(onError);
        return stopPromise;
    };
}
