import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { openRemoteWebSocketTunnel } from "../../sources/connections/impl/openRemoteWebSocketTunnel.js";
import { RemoteProxyConnection } from "../../sources/connections/impl/RemoteProxyConnection.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
});

/** One remote response's worth of bytes, small enough to arrive in a single read. */
function payload(): Buffer {
    const bytes = Buffer.alloc(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    return bytes;
}

async function listen(server: Server): Promise<number> {
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    cleanup.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address");
    return address.port;
}

/**
 * The client side of a relayed tunnel that is still behind when the remote has finished and
 * closed. Like the daemon's Bun front door, it accepts writes into its queue but acknowledges
 * none of them until its own socket drains, here on `release`, and it loses whatever it still
 * holds when it is destroyed.
 */
function slowClient(): { client: Duplex; received: () => Buffer; release(): Promise<void> } {
    const received: Buffer[] = [];
    const held: { chunk: Buffer; callback: () => void }[] = [];
    let released = false;
    let ended!: () => void;
    const done = new Promise<void>((resolve) => {
        ended = resolve;
    });
    const client = new Duplex({
        allowHalfOpen: true,
        highWaterMark: 4 * 1024 * 1024,
        read() {},
        write(chunk: Buffer, _encoding, callback) {
            if (released) {
                received.push(chunk);
                callback();
            } else held.push({ chunk, callback });
        },
        final(callback) {
            callback();
            ended();
        },
        destroy(error, callback) {
            held.length = 0;
            ended();
            callback(error);
        },
    });
    return {
        client,
        received: () => {
            const all = Buffer.concat(received);
            return all.subarray(all.indexOf("\r\n\r\n") + 4);
        },
        release: async () => {
            released = true;
            for (const { chunk, callback } of held.splice(0)) {
                received.push(chunk);
                callback();
            }
            await done;
        },
    };
}

/** Wait until the remote side of the tunnel has gone away, then let the client catch up. */
async function afterRemoteCloses(closed: Promise<unknown>, release: () => Promise<void>) {
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await release();
}

describe("relayed tunnels", () => {
    it("deliver every byte a WebSocket twin sent before it closed", async () => {
        const bytes = payload();
        const server = createServer();
        const sockets = new WebSocketServer({ server });
        let closed!: () => void;
        const remoteClosed = new Promise<void>((resolve) => {
            closed = resolve;
        });
        sockets.on("connection", (socket) => {
            // The remote proxy finishes its response, half-closes and closes at once.
            socket.send(bytes, { binary: true });
            socket.send(Buffer.alloc(0), { binary: true });
            socket.close(1000);
            socket.once("close", closed);
        });
        const port = await listen(server);
        cleanup.push(() => {
            for (const client of sockets.clients) client.terminate();
        });
        const { client, received, release } = slowClient();
        void openRemoteWebSocketTunnel({
            url: `ws://127.0.0.1:${String(port)}/tunnel`,
            token: "token",
            client,
            head: Buffer.alloc(0),
            idleMs: 45_000,
            screen: async () => undefined,
            signal: new AbortController().signal,
        });
        await afterRemoteCloses(remoteClosed, release);
        expect(received().length).toBe(bytes.length);
        expect(received().equals(bytes)).toBe(true);
    });

    it("deliver every byte a CONNECT tunnel sent before it closed", async () => {
        const bytes = payload();
        const remote = createServer();
        let closed!: () => void;
        const remoteClosed = new Promise<void>((resolve) => {
            closed = resolve;
        });
        remote.on("connect", (_request: IncomingMessage, socket: Socket) => {
            socket.end(Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), bytes]));
            socket.once("close", closed);
        });
        const port = await listen(remote);
        const pool = new RemoteProxyConnection(() => connect({ host: "127.0.0.1", port }));
        cleanup.push(() => pool.close());
        const { client, received, release } = slowClient();
        const incoming = Object.assign(new Duplex({ read() {}, write: (_c, _e, done) => done() }), {
            method: "CONNECT",
            url: "/tunnel",
            headers: { host: "remote" },
            complete: true,
        }) as unknown as IncomingMessage;
        void pool.forward(incoming, client, "/tunnel", async () => "token", Buffer.alloc(0));
        await afterRemoteCloses(remoteClosed, release);
        expect(received().length).toBe(bytes.length);
        expect(received().equals(bytes)).toBe(true);
    });
});
