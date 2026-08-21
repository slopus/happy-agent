export interface TaskDrain {
    readonly closing: boolean;
    beginClose(): void;
    drain(): Promise<void>;
    run<T>(task: () => Promise<T>): Promise<T>;
}

export class TrackedTaskDrain implements TaskDrain {
    readonly #tasks = new Set<Promise<unknown>>();
    #closing = false;

    get closing(): boolean {
        return this.#closing;
    }

    beginClose(): void {
        this.#closing = true;
    }

    async drain(): Promise<void> {
        this.beginClose();
        while (this.#tasks.size > 0) {
            await Promise.allSettled(this.#tasks);
        }
    }

    run<T>(task: () => Promise<T>): Promise<T> {
        if (this.#closing) {
            return Promise.reject(new Error("The local daemon is shutting down."));
        }

        const promise = Promise.resolve().then(task);
        this.#tasks.add(promise);
        void promise.then(
            () => this.#tasks.delete(promise),
            () => this.#tasks.delete(promise),
        );
        return promise;
    }
}
