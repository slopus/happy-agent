import type {
    BinaryWebSocket,
    BinaryWebSocketHandlers,
} from "@slopus/happy-agent-modules/transport";

export interface BunWebSocketState {
    handlers: BinaryWebSocketHandlers | undefined;
}

export interface BunServerWebSocket {
    close(code?: number, reason?: string): void;
    getBufferedAmount(): number;
    send(data: Uint8Array, compress?: boolean): number;
}

export function createBunBinaryWebSocket(
    webSocket: BunServerWebSocket,
    state: BunWebSocketState,
): BinaryWebSocket {
    return {
        get bufferedAmount() {
            return webSocket.getBufferedAmount();
        },
        close() {
            webSocket.close();
        },
        send(data, callback) {
            try {
                const sent = webSocket.send(data, false);
                callback(
                    sent === 0 && data.byteLength > 0
                        ? new Error("The terminal WebSocket is closed.")
                        : undefined,
                );
            } catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)));
            }
        },
        subscribe(handlers) {
            state.handlers = handlers;
            return () => {
                if (state.handlers === handlers) state.handlers = undefined;
            };
        },
    };
}
