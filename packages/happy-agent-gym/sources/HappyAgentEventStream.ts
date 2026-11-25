import type {
    EventStreamFrame,
    EventStreamOptions,
    HappyAgentClient,
    HappyAgentEvent,
} from "@slopus/happy-agent-client";

import type { GymEventStreamOptions, GymSseFrame } from "./GymEventStream.js";

/**
 * A recorder over the public client's typed SSE iterator.
 *
 * The client owns HTTP/SSE framing and authentication. This class only starts
 * one iterator eagerly, records frames for assertions, and provides bounded
 * predicate waits for gym scenarios.
 */
export class HappyAgentEventStream {
    readonly #frames: GymSseFrame[] = [];
    readonly #waiters = new Set<() => void>();
    readonly #timeoutMs: number;
    readonly #controller = new AbortController();
    readonly #opened: Promise<void>;
    #resolveOpened: (() => void) | undefined;
    #rejectOpened: ((error: unknown) => void) | undefined;
    #failure: unknown;
    #openedSettled = false;
    #closed = false;

    constructor(client: HappyAgentClient, options: GymEventStreamOptions = {}) {
        this.#timeoutMs = options.timeoutMs ?? 10_000;
        this.#opened = new Promise<void>((resolve, reject) => {
            this.#resolveOpened = resolve;
            this.#rejectOpened = reject;
        });
        void this.#consume(client, options);
    }

    /** Resolves after the client's hello frame arrives. */
    async opened(): Promise<void> {
        await this.#opened;
    }

    /** Every frame received so far, oldest first. */
    get frames(): readonly GymSseFrame[] {
        return this.#frames;
    }

    /** The first frame matching `predicate`, including earlier frames. */
    async waitFor(
        predicate: (frame: GymSseFrame) => boolean,
        description = "a matching event",
        timeoutMs = this.#timeoutMs,
    ): Promise<GymSseFrame> {
        await this.#opened;
        const deadline = Date.now() + timeoutMs;
        let seen = 0;
        for (;;) {
            if (this.#failure !== undefined) throw this.#failure;
            while (seen < this.#frames.length) {
                const frame = this.#frames[seen];
                seen += 1;
                if (frame !== undefined && predicate(frame)) return frame;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(
                    `Timed out after ${String(timeoutMs)}ms waiting for ${description}. ` +
                        `Received: ${this.#frames.map((frame) => frame.event).join(", ")}`,
                );
            }
            await this.#changed(remaining);
        }
    }

    /** Stop reading the stream and release its socket. */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#controller.abort();
        if (!this.#openedSettled) {
            this.#openedSettled = true;
            this.#resolveOpened?.();
        }
        this.#wake();
    }

    async #consume(client: HappyAgentClient, options: GymEventStreamOptions): Promise<void> {
        const streamOptions: EventStreamOptions = {
            ...(options.after === undefined ? {} : { after: options.after }),
            ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
            signal: this.#controller.signal,
        };
        try {
            for await (const frame of client.streamEvents(streamOptions)) {
                if (this.#closed) return;
                this.#frames.push(toSseFrame(frame));
                if (!this.#openedSettled && frame.kind === "hello") {
                    this.#openedSettled = true;
                    this.#resolveOpened?.();
                }
                this.#wake();
            }
        } catch (error: unknown) {
            if (!this.#closed) {
                this.#failure = error;
                if (!this.#openedSettled) {
                    this.#openedSettled = true;
                    this.#rejectOpened?.(error);
                }
                this.#wake();
            }
        }
    }

    #wake(): void {
        for (const waiter of this.#waiters) waiter();
    }

    async #changed(timeoutMs: number): Promise<void> {
        await new Promise<void>((resolve) => {
            const finish = (): void => {
                clearTimeout(timer);
                this.#waiters.delete(finish);
                resolve();
            };
            const timer = setTimeout(finish, Math.min(timeoutMs, 50));
            timer.unref?.();
            this.#waiters.add(finish);
        });
    }
}

function toSseFrame(frame: EventStreamFrame): GymSseFrame {
    if (frame.kind === "hello") {
        return {
            data: frame.hello,
            event: "hello",
            id: undefined,
            raw: JSON.stringify(frame.hello),
        };
    }
    if (frame.kind === "document") {
        return {
            data: frame.frame.data,
            event: frame.frame.type,
            id: undefined,
            raw: JSON.stringify(frame.frame.data),
        };
    }
    if (frame.kind === "viewers") {
        return {
            data: frame.frame,
            event: "viewers.updated",
            id: undefined,
            raw: JSON.stringify(frame.frame),
        };
    }
    return {
        data: frame.event,
        event: frame.event.type,
        id: frame.cursor,
        raw: JSON.stringify(frame.event),
    };
}

/** Extract the typed public event from a recorded SSE frame; hello and live frames have none. */
export function frameEvent(frame: GymSseFrame): HappyAgentEvent | undefined {
    if (frame.event === "hello" || frame.id === undefined) return undefined;
    const data = frame.data;
    return data !== null && typeof data === "object" ? (data as HappyAgentEvent) : undefined;
}
