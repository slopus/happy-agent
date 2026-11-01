import { Duplex } from "node:stream";

/** The most bytes in one tunnel message, in either direction. */
export const WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES = 1024 * 1024;
/** Above this many unsent bytes, writes wait until the client catches up. */
const SEND_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const SEND_LOW_WATER_BYTES = 1024 * 1024;
/**
 * Above this many received bytes nobody has read, a WebSocket that cannot pause its reads is not
 * being kept up with at all.
 */
const MAX_UNREAD_BYTES = 16 * 1024 * 1024;

/**
 * One tunnel WebSocket, as the server that upgraded it presents it. The tunnel does not know
 * whether Node or Bun accepted it.
 */
export interface TunnelWebSocket {
    /** Bytes sent and not yet written to the client. */
    readonly bufferedAmount: number;
    /** Sends one binary message. */
    send(data: Uint8Array): void;
    close(code: number, reason: string): void;
    /** Stops reading the client's messages, where the server can. */
    pause?(): void;
    resume?(): void;
}

/**
 * The byte stream a WebSocket tunnel carries, as a socket for the workspace proxy.
 *
 * Binary messages are bytes and an empty one ends the client's direction, as a TCP half-close
 * does; ending this stream's writable side sends that empty message to the client. Once both
 * directions have ended the WebSocket closes normally. Each direction is held back while the other
 * side is behind.
 */
export class WebSocketTunnel extends Duplex {
    readonly #socket: TunnelWebSocket;
    #closed = false;
    #readEnded = false;
    #writeEnded = false;
    #paused = false;
    #waiting: ReturnType<typeof setTimeout> | undefined;

    constructor(socket: TunnelWebSocket) {
        super({ allowHalfOpen: true });
        this.#socket = socket;
    }

    /** One message from the client: bytes for a binary message, a string for a text message. */
    message(data: Uint8Array | string): void {
        if (this.#closed) return;
        if (typeof data === "string") {
            this.#close(1003, "Tunnel messages must be binary.");
            return;
        }
        if (data.byteLength > WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES) {
            this.#close(1009, "The message is too large.");
            return;
        }
        if (this.#readEnded) {
            this.#close(1002, "Bytes arrived after the tunnel's stream ended.");
            return;
        }
        if (data.byteLength === 0) {
            this.#readEnded = true;
            this.push(null);
            this.#closeWhenBothEnded();
            return;
        }
        if (this.push(Buffer.from(data))) return;
        if (this.#socket.pause !== undefined) {
            this.#paused = true;
            this.#socket.pause();
        } else if (this.readableLength > MAX_UNREAD_BYTES) {
            this.#close(1011, "The tunnel's destination is not keeping up.");
        }
    }

    /** The WebSocket closed, for whatever reason. Everything opened on the tunnel ends with it. */
    webSocketClosed(): void {
        this.#closed = true;
        this.destroy();
    }

    /** The daemon is going away. */
    shutdown(): void {
        this.#close(1001, "Happy Agent is shutting down.");
    }

    override _read(): void {
        if (!this.#paused) return;
        this.#paused = false;
        this.#socket.resume?.();
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        if (this.#closed) {
            callback(new Error("The tunnel WebSocket is closed."));
            return;
        }
        for (let offset = 0; offset < chunk.length; offset += WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES) {
            this.#socket.send(chunk.subarray(offset, offset + WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES));
        }
        if (this.#socket.bufferedAmount <= SEND_HIGH_WATER_BYTES) {
            callback();
            return;
        }
        const wait = (): void => {
            this.#waiting = setTimeout(() => {
                this.#waiting = undefined;
                if (this.#closed) callback(new Error("The tunnel WebSocket is closed."));
                else if (this.#socket.bufferedAmount <= SEND_LOW_WATER_BYTES) callback();
                else wait();
            }, 10);
            this.#waiting.unref?.();
        };
        wait();
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (!this.#closed) this.#socket.send(new Uint8Array(0));
        this.#writeEnded = true;
        callback();
        this.#closeWhenBothEnded();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        if (this.#waiting !== undefined) clearTimeout(this.#waiting);
        this.#waiting = undefined;
        if (!this.#closed) {
            this.#closed = true;
            this.#socket.close(
                error === null ? 1000 : 1011,
                error === null ? "" : "The tunnel failed.",
            );
        }
        callback(error);
    }

    #closeWhenBothEnded(): void {
        if (!this.#readEnded || !this.#writeEnded) return;
        this.#close(1000, "");
    }

    #close(code: number, reason: string): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#socket.close(code, reason);
        this.destroy();
    }
}
