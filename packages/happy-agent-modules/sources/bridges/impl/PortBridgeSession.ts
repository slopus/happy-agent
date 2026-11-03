import type { Duplex } from "node:stream";

import { createId } from "@paralleldrive/cuid2";
import {
    WORKSPACE_BRIDGE_CLOSE_CODES,
    WORKSPACE_BRIDGE_MAX_CONTROL_MESSAGE_BYTES,
    workspacePortBridgeClientMessageSchema,
    type WorkspaceBridge,
    type WorkspacePortBridgeListener,
    type WorkspacePortBridgeServerMessage,
} from "@slopus/happy-agent-client";
import type { Compute, ComputeListener } from "@slopus/happy-agent-compute";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    BridgeError,
    MAX_PORT_BRIDGE_CONNECTIONS,
    MAX_PORT_BRIDGE_WAITING_CONNECTIONS,
    PORT_BRIDGE_ACCEPT_TIMEOUT_MS,
    type BridgeAdmission,
    type BridgeEnding,
    type BridgeWebSocket,
    type BridgeWebSocketBinding,
} from "../Bridge.js";
import { PortBridgeConnection } from "./PortBridgeConnection.js";

const LOOPBACK = "127.0.0.1";

export interface PortBridgeSessionOptions {
    /** The bridge's own lifetime, for logging. */
    readonly ctx: Context;
    /** The control WebSocket is attached; the bridge exists from here. Returns its resource. */
    readonly opened: (listener: WorkspacePortBridgeListener) => WorkspaceBridge;
    /** The bridge ended, whether or not it ever opened. Called once. */
    readonly ended: (ending: BridgeEnding) => void;
}

interface WaitingConnection {
    readonly socket: Duplex;
    readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * A loopback listener on the workspace's machine whose connections are relayed to the client.
 *
 * The control WebSocket announces each connection; the client accepts one by opening its own
 * WebSocket for it, or declines it. The listener is the machine's own, on this computer or on a
 * runner, and on Linux it admits only programs running as that machine's user, checked against the
 * kernel's socket table before a connection reaches the bridge at all.
 */
export class PortBridgeSession {
    readonly #options: PortBridgeSessionOptions;
    readonly #waiting = new Map<string, WaitingConnection>();
    readonly #connections = new Set<PortBridgeConnection>();
    #server: ComputeListener | undefined;
    #listener: WorkspacePortBridgeListener | undefined;
    #control: BridgeWebSocket | undefined;
    #ending: BridgeEnding | undefined;
    #opened = false;

    constructor(options: PortBridgeSessionOptions) {
        this.#options = options;
    }

    /** How the bridge ended, once it has. */
    get ending(): BridgeEnding | undefined {
        return this.#ending;
    }

    /** Binds the listener, before the WebSocket upgrade, so a taken port is refused as a status. */
    async listen(machine: Compute, port: number): Promise<WorkspacePortBridgeListener> {
        const network = machine.network;
        if (network?.listen === undefined) {
            throw new BridgeError(
                "bridge_unavailable",
                "The workspace's machine cannot listen for connections.",
            );
        }
        let server: ComputeListener;
        try {
            server = await network.listen(this.#options.ctx, {
                ...(port === 0 ? {} : { port }),
                ownerOnly: true,
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EADDRINUSE")
                throw new BridgeError(
                    "port_unavailable",
                    `Port ${String(port)} is already in use on the workspace's machine.`,
                );
            if (code === "EACCES" || code === "EPERM" || code === "EADDRNOTAVAIL")
                throw new BridgeError(
                    "port_unavailable",
                    `Happy Agent cannot listen on port ${String(port)} on the workspace's machine.`,
                );
            if (code === "ENOTSUP")
                throw new BridgeError("bridge_unavailable", (error as Error).message);
            throw error;
        }
        // Ending the bridge while it binds closes the listener before it reports ready.
        if (this.#ending !== undefined) {
            server.close();
            throw new Error("The bridge ended before its listener was ready.");
        }
        this.#server = server;
        server.onConnection((socket) => {
            this.#arrive(socket);
        });
        void server.closed.then(() => {
            this.end({
                reason: "failed",
                code: WORKSPACE_BRIDGE_CLOSE_CODES.internal,
                message: "The bridge's listener stopped working.",
            });
        });
        this.#listener = { host: LOOPBACK, port: server.port };
        return this.#listener;
    }

    attach(webSocket: BridgeWebSocket): BridgeWebSocketBinding {
        if (this.#ending !== undefined || this.#listener === undefined || this.#opened) {
            const ending = this.#ending;
            webSocket.close(
                ending?.code ?? WORKSPACE_BRIDGE_CLOSE_CODES.internal,
                ending?.message ?? "The bridge could not be opened.",
            );
            return { message: () => undefined, closed: () => undefined };
        }
        this.#control = webSocket;
        this.#opened = true;
        const bridge = this.#options.opened(this.#listener);
        if (this.#ending === undefined) {
            this.#send({ type: "ready", bridge });
            // A program may have connected between binding and the upgrade.
            for (const connectionId of this.#waiting.keys())
                this.#send({ type: "connection", connectionId });
        }
        return {
            message: (data) => {
                this.#controlMessage(data);
            },
            closed: () => {
                this.end({
                    reason: "client_closed",
                    code: WORKSPACE_BRIDGE_CLOSE_CODES.normal,
                    message: "The client closed the bridge.",
                });
            },
        };
    }

    /** Claims one waiting connection for the WebSocket that will carry it. Once only. */
    accept(connectionId: string): BridgeAdmission | undefined {
        if (this.#ending !== undefined || !this.#opened) return undefined;
        const waiting = this.#waiting.get(connectionId);
        if (waiting === undefined) return undefined;
        clearTimeout(waiting.timer);
        this.#waiting.delete(connectionId);
        if (waiting.socket.destroyed) return undefined;
        const connection = new PortBridgeConnection(waiting.socket, () => {
            this.#connections.delete(connection);
        });
        this.#connections.add(connection);
        return connection;
    }

    /** Stops the listener and ends every connection with it. */
    end(ending: BridgeEnding): void {
        if (this.#ending !== undefined) return;
        this.#ending = ending;
        this.#server?.close();
        for (const waiting of this.#waiting.values()) {
            clearTimeout(waiting.timer);
            waiting.socket.destroy();
        }
        this.#waiting.clear();
        const connectionCode =
            ending.code === WORKSPACE_BRIDGE_CLOSE_CODES.shutdown
                ? WORKSPACE_BRIDGE_CLOSE_CODES.shutdown
                : WORKSPACE_BRIDGE_CLOSE_CODES.normal;
        for (const connection of this.#connections)
            connection.end(connectionCode, "The bridge closed.");
        this.#control?.close(ending.code, ending.message);
        this.#options.ended(ending);
    }

    #arrive(socket: Duplex): void {
        socket.on("error", () => undefined);
        if (
            this.#ending !== undefined ||
            this.#waiting.size + this.#connections.size >= MAX_PORT_BRIDGE_CONNECTIONS ||
            this.#waiting.size >= MAX_PORT_BRIDGE_WAITING_CONNECTIONS
        ) {
            socket.destroy();
            return;
        }
        const connectionId = createId();
        const timer = setTimeout(() => {
            if (this.#waiting.get(connectionId)?.socket !== socket) return;
            this.#waiting.delete(connectionId);
            socket.destroy();
        }, PORT_BRIDGE_ACCEPT_TIMEOUT_MS);
        timer.unref?.();
        this.#waiting.set(connectionId, { socket, timer });
        socket.once("close", () => {
            const waiting = this.#waiting.get(connectionId);
            if (waiting?.socket !== socket) return;
            clearTimeout(waiting.timer);
            this.#waiting.delete(connectionId);
        });
        if (this.#opened) this.#send({ type: "connection", connectionId });
    }

    #controlMessage(data: Uint8Array | string): void {
        if (this.#ending !== undefined) return;
        if (typeof data !== "string") {
            this.end(protocolViolation("Control messages must be JSON text."));
            return;
        }
        if (Buffer.byteLength(data) > WORKSPACE_BRIDGE_MAX_CONTROL_MESSAGE_BYTES) {
            this.end(protocolViolation("The control message is too large."));
            return;
        }
        let message: unknown;
        try {
            message = JSON.parse(data);
        } catch {
            this.end(protocolViolation("The control message is not JSON."));
            return;
        }
        if (!Value.Check(workspacePortBridgeClientMessageSchema, message)) {
            this.end(protocolViolation("The control message is not one the bridge understands."));
            return;
        }
        // A connection that has already gone needs no answer.
        const waiting = this.#waiting.get(message.connectionId);
        if (waiting === undefined) return;
        clearTimeout(waiting.timer);
        this.#waiting.delete(message.connectionId);
        waiting.socket.destroy();
    }

    #send(message: WorkspacePortBridgeServerMessage): void {
        this.#control?.send(JSON.stringify(message));
    }
}

function protocolViolation(message: string): BridgeEnding {
    return { reason: "failed", code: WORKSPACE_BRIDGE_CLOSE_CODES.protocolViolation, message };
}
