export function waitForAbortOrTimeout(
    signals: readonly AbortSignal[],
    timeoutMs: number,
): Promise<void> {
    return new Promise((resolve) => {
        const uniqueSignals = [...new Set(signals)];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            if (timer !== undefined) clearTimeout(timer);
            for (const signal of uniqueSignals) {
                signal.removeEventListener("abort", finish);
            }
            resolve();
        };
        if (uniqueSignals.some((signal) => signal.aborted)) {
            finish();
            return;
        }
        for (const signal of uniqueSignals) {
            signal.addEventListener("abort", finish, { once: true });
        }
        timer = setTimeout(finish, timeoutMs);
    });
}
