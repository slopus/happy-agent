import { createServer, connect, type Server, type Socket } from "node:net";

export type TcpRelayTarget =
    | { readonly socketPath: string }
    | { readonly host: string; readonly port: number };

export interface TcpRelay {
    readonly port: number;
    close(): Promise<void>;
}

/** Give Tailcat a loopback TCP port even when the daemon itself owns a Unix socket. */
export async function startTcpRelay(target: TcpRelayTarget): Promise<TcpRelay> {
    const sockets = new Set<Socket>();
    const server = createServer({ pauseOnConnect: true }, (incoming) => {
        sockets.add(incoming);
        incoming.once("close", () => sockets.delete(incoming));
        const upstream =
            "socketPath" in target
                ? connect(target.socketPath)
                : connect({ host: connectableHost(target.host), port: target.port });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));

        const closePair = () => {
            incoming.destroy();
            upstream.destroy();
        };
        incoming.once("error", closePair);
        upstream.once("error", closePair);
        upstream.once("connect", () => {
            if (incoming.destroyed) {
                upstream.destroy();
                return;
            }
            incoming.pipe(upstream);
            upstream.pipe(incoming);
            incoming.resume();
        });
    });
    try {
        await listen(server);
    } catch (error) {
        await closeServer(server, sockets).catch(() => undefined);
        throw error;
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
        await closeServer(server, sockets);
        throw new Error("The Tailcat TCP relay has no loopback port.");
    }
    let closing: Promise<void> | undefined;
    return {
        port: address.port,
        close: () => {
            closing ??= closeServer(server, sockets);
            return closing;
        },
    };
}

function connectableHost(host: string): string {
    if (host === "0.0.0.0") return "127.0.0.1";
    if (host === "::" || host === "0:0:0:0:0:0:0:0") return "::1";
    return host;
}

async function listen(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
            server.off("listening", listening);
            reject(error);
        };
        const listening = () => {
            server.off("error", failed);
            resolve();
        };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen({ host: "127.0.0.1", port: 0 });
    });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    }).catch((error: unknown) => {
        if (!(error instanceof Error) || !/not running/i.test(error.message)) throw error;
    });
}
