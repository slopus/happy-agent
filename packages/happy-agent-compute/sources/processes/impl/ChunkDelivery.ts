/**
 * Hands one output stream's chunks to its listener, holding them while nobody is listening or
 * while delivery is paused.
 *
 * Holding is bounded by backpressure rather than by dropping: once `limit` bytes are held, `push`
 * returns false and the producer is expected to stop reading until `onSpace` fires. Nothing that
 * was pushed is ever lost.
 */
export class ChunkDelivery {
    readonly #limit: number;
    readonly #onDelivered: ((bytes: number) => void) | undefined;
    readonly #queue: Uint8Array[] = [];
    #queuedBytes = 0;
    #listener: ((chunk: Uint8Array) => void) | undefined;
    #paused = false;
    #ended = false;
    #flushing = false;
    #spaceListener: (() => void) | undefined;
    readonly #drainedWaiters: Array<() => void> = [];

    constructor(limit: number, onDelivered?: (bytes: number) => void) {
        this.#limit = limit;
        this.#onDelivered = onDelivered;
    }

    /** Whether the producer should stop until there is space again. */
    get full(): boolean {
        return this.#queuedBytes >= this.#limit;
    }

    /** Add a chunk. Returns false once the producer should stop reading. */
    push(chunk: Uint8Array): boolean {
        if (this.#ended || chunk.byteLength === 0) return !this.full;
        this.#queue.push(chunk);
        this.#queuedBytes += chunk.byteLength;
        this.#flush();
        return !this.full;
    }

    /** No more chunks will arrive. */
    end(): void {
        if (this.#ended) return;
        this.#ended = true;
        this.#flush();
    }

    listen(listener: (chunk: Uint8Array) => void): () => void {
        this.#listener = listener;
        this.#flush();
        return () => {
            if (this.#listener === listener) this.#listener = undefined;
        };
    }

    setPaused(paused: boolean): void {
        this.#paused = paused;
        if (!paused) this.#flush();
    }

    /** Called whenever held bytes fall below the limit, so a stopped producer can resume. */
    onSpace(listener: () => void): void {
        this.#spaceListener = listener;
    }

    /** Resolves once the stream has ended and every chunk has been delivered. */
    drained(): Promise<void> {
        if (this.#ended && this.#queue.length === 0) return Promise.resolve();
        return new Promise((resolve) => this.#drainedWaiters.push(resolve));
    }

    #flush(): void {
        if (this.#flushing) return;
        this.#flushing = true;
        try {
            while (this.#queue.length > 0 && this.#listener !== undefined && !this.#paused) {
                const wasFull = this.full;
                const chunk = this.#queue.shift()!;
                this.#queuedBytes -= chunk.byteLength;
                this.#listener(chunk);
                this.#onDelivered?.(chunk.byteLength);
                if (wasFull && !this.full) this.#spaceListener?.();
            }
        } finally {
            this.#flushing = false;
        }
        if (this.#ended && this.#queue.length === 0) {
            for (const resolve of this.#drainedWaiters.splice(0)) resolve();
        }
    }
}
