let pending: Promise<void> = Promise.resolve();

export function runWithRuntimeConfigLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation, operation);
    pending = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}
