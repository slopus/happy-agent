import { RunnerDisconnectedError } from "../RunnerErrors.js";
import { RUNNER_STREAM_CHUNK_BYTES, RUNNER_STREAM_WINDOW_BYTES } from "../runnerProtocol.js";

/** Where a sender's frames go: the current connection, or nowhere while there is none. */
export interface RunnerStreamTransmit {
    data(offset: number, chunk: Uint8Array): void;
    eof(offset: number): void;
}

/**
 * The sending half of one stream channel.
 *
 * Every byte has an offset. A sender keeps what it sent until the receiver says it consumed it, so
 * after a reconnect it can send the unacknowledged bytes again and the receiver can discard
 * duplicates by offset. Never having more than one window unacknowledged is also the flow control:
 * bytes beyond the window wait here, `full` tells the producer to stop, and `onSpace` tells it to
 * go on.
 */
export class RunnerStreamSender {
    readonly #transmit: RunnerStreamTransmit;
    readonly #retained: Array<{ offset: number; chunk: Uint8Array }> = [];
    readonly #pending: Uint8Array[] = [];
    #acknowledged = 0;
    #sent = 0;
    #ending = false;
    #endSent = false;
    #failed: Error | undefined;
    readonly #drainWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    #spaceListener: (() => void) | undefined;

    constructor(transmit: RunnerStreamTransmit) {
        this.#transmit = transmit;
    }

    /** Whether the producer should stop until `onSpace` fires. */
    get full(): boolean {
        return this.#pending.length > 0 || this.#window <= 0;
    }

    /** Called whenever the receiver frees window, so a stopped producer can resume. */
    onSpace(listener: () => void): void {
        this.#spaceListener = listener;
    }

    /** Send bytes, holding whatever does not fit in the window until it does. */
    push(chunk: Uint8Array): void {
        if (this.#ending) throw new Error("A stream channel cannot send after it ended.");
        if (chunk.byteLength === 0) return;
        this.#pending.push(chunk);
        this.#pump();
    }

    /** Send bytes and resolve once all of them fit in the window. */
    async write(chunk: Uint8Array): Promise<void> {
        if (this.#failed !== undefined) throw this.#failed;
        this.push(chunk);
        if (this.#pending.length === 0) return;
        await new Promise<void>((resolve, reject) => this.#drainWaiters.push({ resolve, reject }));
    }

    /** End the channel once everything pushed has been sent. */
    end(): void {
        if (this.#ending) return;
        this.#ending = true;
        this.#pump();
    }

    /** The receiver consumed this many bytes in total. */
    acknowledge(consumed: number): void {
        if (consumed > this.#sent) {
            throw new Error("The other side acknowledged bytes that were never sent.");
        }
        if (consumed <= this.#acknowledged) return;
        this.#acknowledged = consumed;
        while (this.#retained.length > 0) {
            const first = this.#retained[0]!;
            if (first.offset + first.chunk.byteLength <= consumed) {
                this.#retained.shift();
                continue;
            }
            if (first.offset < consumed) {
                this.#retained[0] = {
                    offset: consumed,
                    chunk: first.chunk.subarray(consumed - first.offset),
                };
            }
            break;
        }
        this.#pump();
        if (!this.full) this.#spaceListener?.();
    }

    /** Send again everything not yet acknowledged, and the end when it was already sent. */
    resend(): void {
        for (const { offset, chunk } of this.#retained) this.#transmit.data(offset, chunk);
        if (this.#endSent) this.#transmit.eof(this.#sent);
    }

    /** Nothing more will ever be acknowledged; release anyone waiting for room. */
    fail(error: Error = new RunnerDisconnectedError("The stream ended.")): void {
        this.#failed = error;
        for (const waiter of this.#drainWaiters.splice(0)) waiter.reject(error);
    }

    get #window(): number {
        return RUNNER_STREAM_WINDOW_BYTES - (this.#sent - this.#acknowledged);
    }

    #pump(): void {
        while (this.#pending.length > 0 && this.#window > 0) {
            const first = this.#pending[0]!;
            const size = Math.min(first.byteLength, this.#window, RUNNER_STREAM_CHUNK_BYTES);
            const piece = first.subarray(0, size);
            if (size === first.byteLength) this.#pending.shift();
            else this.#pending[0] = first.subarray(size);
            this.#retained.push({ offset: this.#sent, chunk: piece });
            this.#transmit.data(this.#sent, piece);
            this.#sent += size;
        }
        if (this.#pending.length > 0) return;
        for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve();
        if (this.#ending && !this.#endSent) {
            this.#endSent = true;
            this.#transmit.eof(this.#sent);
        }
    }
}
