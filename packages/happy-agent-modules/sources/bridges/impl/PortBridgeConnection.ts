import type { Duplex } from "node:stream";

import { WORKSPACE_BRIDGE_CLOSE_CODES } from "@slopus/happy-agent-client";

import type { BridgeAdmission, BridgeWebSocket, BridgeWebSocketBinding } from "../Bridge.js";
import { relayBridgeSocket, type BridgeRelay } from "./relayBridgeSocket.js";

/**
 * One accepted connection of a port bridge, carried by its own WebSocket.
 *
 * Either side closing ends both. Half-closed TCP is not represented: the listener does not allow
 * it, so a program that stops writing has also stopped reading.
 */
export class PortBridgeConnection implements BridgeAdmission {
    readonly #socket: Duplex;
    readonly #ended: () => void;
    #webSocket: BridgeWebSocket | undefined;
    #relay: BridgeRelay | undefined;
    #done = false;

    constructor(socket: Duplex, ended: () => void) {
        this.#socket = socket;
        this.#ended = ended;
    }

    attach(webSocket: BridgeWebSocket): BridgeWebSocketBinding {
        if (this.#done) {
            webSocket.close(WORKSPACE_BRIDGE_CLOSE_CODES.normal, "The connection closed.");
            return { message: () => undefined, closed: () => undefined };
        }
        this.#webSocket = webSocket;
        this.#relay = relayBridgeSocket(this.#socket, webSocket, (cause) => {
            if (cause === "overflow") {
                this.end(
                    WORKSPACE_BRIDGE_CLOSE_CODES.internal,
                    "The program on the workspace's machine is not reading.",
                );
            } else {
                this.end(WORKSPACE_BRIDGE_CLOSE_CODES.normal, "The connection closed.");
            }
        });
        return {
            message: (data) => {
                if (typeof data === "string") {
                    this.end(
                        WORKSPACE_BRIDGE_CLOSE_CODES.protocolViolation,
                        "Connection messages must be binary.",
                    );
                    return;
                }
                this.#relay?.write(data);
            },
            closed: () => {
                this.end(WORKSPACE_BRIDGE_CLOSE_CODES.normal, "The client closed the connection.");
            },
        };
    }

    failed(): void {
        this.end(WORKSPACE_BRIDGE_CLOSE_CODES.internal, "The connection could not be opened.");
    }

    end(code: number, reason: string): void {
        if (this.#done) return;
        this.#done = true;
        this.#relay?.stop();
        this.#socket.destroy();
        this.#webSocket?.close(code, reason);
        this.#ended();
    }
}
