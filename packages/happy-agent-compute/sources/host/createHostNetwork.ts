import { connect, createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { Context } from "@steve.kite/stdlib";

import type { ComputeConnectOptions, ComputeListener, ComputeNetwork } from "../ComputeNetwork.js";

/** How long a connection may take to establish. */
const HOST_CONNECT_TIMEOUT_MS = 30_000;
/** Connections a listener holds for a caller that has not subscribed yet. */
const MAX_HELD_CONNECTIONS = 64;

/** Connections from this machine's own network. */
export function createHostNetwork(): ComputeNetwork {
    return {
        connect: (_ctx: Context, options: ComputeConnectOptions) =>
            new Promise<Duplex>((resolve, reject) => {
                const socket = connect({ host: options.host, port: options.port });
                const timer = setTimeout(() => {
                    socket.destroy();
                    reject(
                        Object.assign(
                            new Error(
                                `Connecting to ${options.host}:${String(options.port)} timed out.`,
                            ),
                            { code: "ETIMEDOUT" },
                        ),
                    );
                }, HOST_CONNECT_TIMEOUT_MS);
                timer.unref();
                socket.once("connect", () => {
                    clearTimeout(timer);
                    socket.removeListener("error", reject);
                    resolve(socket);
                });
                socket.once("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
            }),
        listen: () => listenOnLoopback(),
    };
}

function listenOnLoopback(): Promise<ComputeListener> {
    return new Promise((resolve, reject) => {
        const held: Socket[] = [];
        let listener: ((socket: Duplex) => void) | undefined;
        let resolveClosed!: () => void;
        const closed = new Promise<void>((done) => {
            resolveClosed = done;
        });
        const server = createServer({ pauseOnConnect: true }, (socket) => {
            if (listener !== undefined) {
                listener(socket);
                return;
            }
            if (held.length >= MAX_HELD_CONNECTIONS) {
                socket.destroy();
                return;
            }
            held.push(socket);
            socket.once("close", () => {
                const index = held.indexOf(socket);
                if (index >= 0) held.splice(index, 1);
            });
        });
        server.once("close", () => resolveClosed());
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            server.removeListener("error", reject);
            const address = server.address();
            if (address === null || typeof address === "string") {
                server.close();
                reject(new Error("The loopback listener has no port."));
                return;
            }
            resolve({
                port: address.port,
                onConnection(next) {
                    listener = next;
                    for (const socket of held.splice(0)) next(socket);
                    return () => {
                        if (listener === next) listener = undefined;
                    };
                },
                close() {
                    server.close();
                    for (const socket of held.splice(0)) socket.destroy();
                },
                closed,
            });
        });
    });
}
