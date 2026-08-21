import { Duplex } from "node:stream";

import WebSocket, { type RawData } from "ws";

interface BinaryWebSocketHandlers {
    close: () => void;
    error: (error: Error) => void;
    message: (data: Uint8Array) => void;
}

interface BinaryWebSocket {
    readonly bufferedAmount: number;
    close(): void;
    pause(): void;
    resume(): void;
    send(data: Uint8Array, callback: (error?: Error) => void): void;
    subscribe(handlers: BinaryWebSocketHandlers): () => void;
}

/** A backpressure-aware duplex byte stream over the daemon's binary WebSocket. */
export class WebSocketDuplex extends Duplex {
    readonly #bufferedAmountLowWaterMark = 32 * 1024;
    #closed = false;
    #pendingWrite:
        | {
              callback: (error?: Error | null) => void;
              timer: ReturnType<typeof setTimeout> | undefined;
          }
        | undefined;
    readonly #socket: BinaryWebSocket;
    readonly #unsubscribe: () => void;

    constructor(webSocket: WebSocket) {
        super({
            allowHalfOpen: false,
            readableHighWaterMark: 64 * 1024,
            writableHighWaterMark: 64 * 1024,
        });
        this.#socket = createBinaryWebSocket(webSocket);
        this.#unsubscribe = this.#socket.subscribe({
            close: () => this.destroy(),
            error: (error) => this.destroy(error),
            message: (data) => {
                if (!this.destroyed && !this.push(Buffer.from(data))) this.#socket.pause();
            },
        });
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        if (!this.#closed) {
            this.#closed = true;
            this.#unsubscribe();
            this.#socket.close();
        }
        const pending = this.#pendingWrite;
        this.#pendingWrite = undefined;
        if (pending !== undefined) {
            if (pending.timer !== undefined) clearTimeout(pending.timer);
            pending.callback(error ?? new Error("Remote terminal WebSocket closed."));
        }
        callback(error);
    }

    override _read(): void {
        this.#socket.resume();
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        if (this.#pendingWrite !== undefined) {
            callback(new Error("A remote terminal WebSocket write is already pending."));
            return;
        }
        this.#pendingWrite = { callback, timer: undefined };
        this.#socket.send(Buffer.from(chunk), (error) => {
            if (error !== undefined) this.#settleWrite(error);
            else this.#waitForBufferedAmount();
        });
    }

    #settleWrite(error?: Error): void {
        const pending = this.#pendingWrite;
        if (pending === undefined) return;
        this.#pendingWrite = undefined;
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.callback(error);
    }

    #waitForBufferedAmount(): void {
        const pending = this.#pendingWrite;
        if (pending === undefined) return;
        if (this.#socket.bufferedAmount <= this.#bufferedAmountLowWaterMark) {
            this.#settleWrite();
            return;
        }
        pending.timer = setTimeout(() => this.#waitForBufferedAmount(), 1);
        pending.timer.unref?.();
    }
}

function createBinaryWebSocket(webSocket: WebSocket): BinaryWebSocket {
    return {
        get bufferedAmount() {
            return webSocket.bufferedAmount;
        },
        close() {
            if (webSocket.readyState === WebSocket.OPEN) webSocket.close();
            else if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
        },
        pause() {
            if (webSocket.readyState === WebSocket.OPEN) webSocket.pause();
        },
        resume() {
            if (webSocket.readyState === WebSocket.OPEN) webSocket.resume();
        },
        send(data, callback) {
            webSocket.send(data, { binary: true, compress: false }, callback);
        },
        subscribe(handlers) {
            const close = () => handlers.close();
            const error = (cause: Error) => handlers.error(cause);
            const message = (data: RawData, isBinary: boolean) => {
                if (!isBinary) {
                    handlers.error(new Error("Remote terminal WebSocket messages must be binary."));
                    return;
                }
                handlers.message(rawDataToBuffer(data));
            };
            webSocket.on("close", close);
            webSocket.on("error", error);
            webSocket.on("message", message);
            return () => {
                webSocket.off("close", close);
                webSocket.off("error", error);
                webSocket.off("message", message);
            };
        },
    };
}

function rawDataToBuffer(data: RawData): Buffer {
    if (Array.isArray(data)) return Buffer.concat(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
