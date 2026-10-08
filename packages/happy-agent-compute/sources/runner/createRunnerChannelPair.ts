import type { RunnerChannel, RunnerChannelReceiver } from "./RunnerChannel.js";

/**
 * Two connected in-memory channels: what one sends, the other receives.
 *
 * Delivery is asynchronous and ordered, like a real connection, so code that only works because a
 * reply arrived in the same tick fails here too. Closing either end closes both, after every frame
 * already sent has been delivered.
 */
export function createRunnerChannelPair(): readonly [RunnerChannel, RunnerChannel] {
    const left = new InMemoryRunnerChannel();
    const right = new InMemoryRunnerChannel();
    left.connect(right);
    right.connect(left);
    return [left, right];
}

class InMemoryRunnerChannel implements RunnerChannel {
    #other: InMemoryRunnerChannel | undefined;
    #receiver: RunnerChannelReceiver | undefined;
    readonly #inbox: Array<{ frame: Uint8Array } | { close: string }> = [];
    #closed = false;
    #ended = false;
    #delivering = false;

    connect(other: InMemoryRunnerChannel): void {
        this.#other = other;
    }

    send(frame: Uint8Array): void {
        if (this.#closed) return;
        this.#other?.enqueue({ frame: frame.slice() });
    }

    close(reason: string): void {
        if (this.#closed) return;
        this.#closed = true;
        this.enqueue({ close: reason });
        this.#other?.closeFromPeer(reason);
    }

    receive(receiver: RunnerChannelReceiver): void {
        if (this.#receiver !== undefined) throw new Error("A runner channel has one receiver.");
        this.#receiver = receiver;
        this.#schedule();
    }

    closeFromPeer(reason: string): void {
        if (this.#closed) return;
        this.#closed = true;
        this.enqueue({ close: reason });
    }

    enqueue(item: { frame: Uint8Array } | { close: string }): void {
        if (this.#ended) return;
        if ("close" in item) this.#ended = true;
        this.#inbox.push(item);
        this.#schedule();
    }

    #schedule(): void {
        if (this.#delivering || this.#receiver === undefined || this.#inbox.length === 0) return;
        this.#delivering = true;
        queueMicrotask(() => {
            this.#delivering = false;
            const receiver = this.#receiver;
            const item = this.#inbox.shift();
            if (receiver === undefined || item === undefined) return;
            if ("frame" in item) {
                receiver.frame(item.frame);
            } else {
                this.#inbox.length = 0;
                receiver.close(item.close);
                return;
            }
            this.#schedule();
        });
    }
}
