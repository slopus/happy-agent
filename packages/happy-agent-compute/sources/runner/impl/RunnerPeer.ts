import type { RunnerChannel } from "../RunnerChannel.js";
import type { RunnerFrameHeader } from "../runnerProtocol.js";
import { decodeRunnerFrame, encodeRunnerFrame, type RunnerFrame } from "./runnerFrameCodec.js";

/** How often a quiet connection proves it is still alive. */
export const RUNNER_PING_INTERVAL_MS = 15_000;
/** How long a connection may stay silent before it is treated as dead. */
export const RUNNER_IDLE_TIMEOUT_MS = 45_000;

export interface RunnerPeerOptions {
    readonly channel: RunnerChannel;
    /** Every frame except liveness pings and pongs, which the peer answers itself. */
    readonly onFrame: (frame: RunnerFrame) => void;
    /** Called once, when the connection ends for any reason. */
    readonly onClose: (reason: string) => void;
    readonly pingIntervalMs?: number;
    readonly idleTimeoutMs?: number;
}

/**
 * One side of a runner connection: framing, liveness, and a single place where the connection ends.
 *
 * A link can die without either end being told — a laptop lid closes, a NAT forgets a mapping — so
 * each side pings a quiet connection and gives up on one that has been silent for too long. Any
 * frame counts as proof of life. A malformed frame ends the connection instead of being skipped,
 * because a peer that has broken the protocol once cannot be trusted to frame the next one.
 */
export class RunnerPeer {
    readonly #channel: RunnerChannel;
    readonly #onFrame: (frame: RunnerFrame) => void;
    readonly #onClose: (reason: string) => void;
    readonly #idleTimeoutMs: number;
    readonly #pingTimer: NodeJS.Timeout;
    #lastReceivedAt = Date.now();
    #nextNonce = 1;
    #closed = false;

    constructor(options: RunnerPeerOptions) {
        this.#channel = options.channel;
        this.#onFrame = options.onFrame;
        this.#onClose = options.onClose;
        this.#idleTimeoutMs = options.idleTimeoutMs ?? RUNNER_IDLE_TIMEOUT_MS;
        const pingIntervalMs = options.pingIntervalMs ?? RUNNER_PING_INTERVAL_MS;
        this.#pingTimer = setInterval(() => this.#checkLiveness(), pingIntervalMs);
        this.#pingTimer.unref?.();
        this.#channel.receive({
            frame: (bytes) => this.#receive(bytes),
            close: (reason) => this.#finish(reason),
        });
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** Send one frame. Returns false when the connection has already ended. */
    send(header: RunnerFrameHeader, body?: Uint8Array): boolean {
        if (this.#closed) return false;
        this.#channel.send(encodeRunnerFrame(header, body));
        return true;
    }

    /** End the connection, telling the other side why when it can still hear. */
    close(reason: string, options: { goodbye?: boolean } = {}): void {
        if (this.#closed) return;
        if (options.goodbye === true) this.send({ type: "goodbye", reason });
        this.#finish(reason);
        this.#channel.close(reason);
    }

    #receive(bytes: Uint8Array): void {
        if (this.#closed) return;
        this.#lastReceivedAt = Date.now();
        let frame: RunnerFrame;
        try {
            frame = decodeRunnerFrame(bytes);
        } catch (error) {
            this.close(error instanceof Error ? error.message : String(error));
            return;
        }
        if (frame.header.type === "ping") {
            this.send({ type: "pong", nonce: frame.header.nonce });
            return;
        }
        if (frame.header.type === "pong") return;
        try {
            this.#onFrame(frame);
        } catch (error) {
            this.close(error instanceof Error ? error.message : String(error));
        }
    }

    #checkLiveness(): void {
        if (this.#closed) return;
        if (Date.now() - this.#lastReceivedAt >= this.#idleTimeoutMs) {
            this.close("The other side stopped responding.");
            return;
        }
        this.send({ type: "ping", nonce: this.#nextNonce++ });
    }

    #finish(reason: string): void {
        if (this.#closed) return;
        this.#closed = true;
        clearInterval(this.#pingTimer);
        this.#onClose(reason);
    }
}
