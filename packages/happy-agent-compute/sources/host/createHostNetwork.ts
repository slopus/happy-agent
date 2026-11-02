import { connect, createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { Context } from "@steve.kite/stdlib";

import type {
    ComputeConnectOptions,
    ComputeListener,
    ComputeListenOptions,
    ComputeNetwork,
} from "../ComputeNetwork.js";
import { loopbackPeerUid } from "./impl/loopbackPeerUid.js";

/** How long a connection may take to establish. */
const HOST_CONNECT_TIMEOUT_MS = 30_000;
/** Connections a listener holds for a caller that has not subscribed yet. */
const MAX_HELD_CONNECTIONS = 64;

/**
 * Connections from this machine's own network.
 *
 * Connections are half-open, like TCP itself: the remote end finishing its replies does not end
 * what the caller is still sending, and the caller ending its side still receives every reply.
 */
export function createHostNetwork(): ComputeNetwork {
    return {
        connect: (_ctx: Context, options: ComputeConnectOptions) =>
            new Promise<Duplex>((resolve, reject) => {
                const socket = connect({
                    host: options.host,
                    port: options.port,
                    allowHalfOpen: true,
                });
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
        listen: (_ctx: Context, options: ComputeListenOptions = {}) => listenOnLoopback(options),
    };
}

function listenOnLoopback(options: ComputeListenOptions): Promise<ComputeListener> {
    return new Promise((resolve, reject) => {
        const held: Socket[] = [];
        let listener: ((socket: Duplex) => void) | undefined;
        let resolveClosed!: () => void;
        const closed = new Promise<void>((done) => {
            resolveClosed = done;
        });
        let checking = 0;
        let stopped = false;
        const deliver = (socket: Socket) => {
            if (socket.destroyed) return;
            if (stopped) {
                socket.destroy();
                return;
            }
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
        };
        const server = createServer({ pauseOnConnect: true }, (socket) => {
            if (options.ownerOnly !== true) {
                deliver(socket);
                return;
            }
            // Connections still being attributed count against the same bound as held ones.
            if (checking + held.length >= MAX_HELD_CONNECTIONS) {
                socket.destroy();
                return;
            }
            socket.on("error", () => undefined);
            checking += 1;
            void isOwnUser(socket)
                .catch(() => false)
                .then((admitted) => {
                    checking -= 1;
                    if (admitted) deliver(socket);
                    else socket.destroy();
                });
        });
        server.once("close", () => resolveClosed());
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: options.port ?? 0 }, () => {
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
                    stopped = true;
                    server.close();
                    for (const socket of held.splice(0)) socket.destroy();
                },
                closed,
            });
        });
    });
}

/**
 * Whether the connecting program runs as this process's user. Linux attributes it from the
 * kernel's socket table, and a connection it cannot attribute is refused; other systems have no
 * such table, so every local user is admitted there, as {@link ComputeListenOptions} says.
 */
async function isOwnUser(socket: Socket): Promise<boolean> {
    if (process.platform !== "linux" || process.getuid === undefined) return true;
    const uid = await loopbackPeerUid(socket);
    return uid !== undefined && uid === process.getuid();
}
