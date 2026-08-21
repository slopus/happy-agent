export function createSerialTaskQueue(): <T>(task: () => Promise<T>) => Promise<T> {
    let queue = Promise.resolve();

    return <T>(task: () => Promise<T>): Promise<T> => {
        const operation = queue.then(task);
        queue = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    };
}
