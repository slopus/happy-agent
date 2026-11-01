import { describe, expect, it } from "vitest";

import {
    WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES,
    WebSocketTunnel,
    type TunnelWebSocket,
} from "../../sources/transport/index.js";

class FakeWebSocket implements TunnelWebSocket {
    bufferedAmount = 0;
    readonly sent: Buffer[] = [];
    closedWith: { code: number; reason: string } | undefined;
    paused = false;

    send(data: Uint8Array): void {
        this.sent.push(Buffer.from(data));
    }

    close(code: number, reason: string): void {
        this.closedWith ??= { code, reason };
    }

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
    }
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

describe("WebSocketTunnel", () => {
    it("reads binary messages as bytes and ends its readable side on an empty one", async () => {
        const socket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(socket);
        const chunks: Buffer[] = [];
        let ended = false;
        tunnel.on("data", (chunk: Buffer) => chunks.push(chunk));
        tunnel.on("end", () => {
            ended = true;
        });

        tunnel.message(Buffer.from("hello "));
        tunnel.message(Buffer.from("world"));
        tunnel.message(new Uint8Array(0));
        await settle();

        expect(Buffer.concat(chunks).toString()).toBe("hello world");
        expect(ended).toBe(true);
        // The other direction is still open.
        expect(socket.closedWith).toBeUndefined();
        tunnel.write("reply");
        await settle();
        expect(socket.sent.map((data) => data.toString())).toEqual(["reply"]);
    });

    it("sends an empty message when its writable side ends, and closes once both have", async () => {
        const socket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(socket);
        tunnel.resume();

        tunnel.end("last");
        await settle();
        expect(socket.sent.map((data) => data.byteLength)).toEqual([4, 0]);
        expect(socket.closedWith).toBeUndefined();

        tunnel.message(new Uint8Array(0));
        await settle();
        expect(socket.closedWith).toEqual({ code: 1000, reason: "" });
    });

    it("splits large writes into messages of at most 1 MiB", async () => {
        const socket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(socket);

        tunnel.write(Buffer.alloc(WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES * 2 + 5));
        await settle();

        expect(socket.sent.map((data) => data.byteLength)).toEqual([
            WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES,
            WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES,
            5,
        ]);
    });

    it.each([
        ["a text message", "text", 1003],
        ["an oversized message", Buffer.alloc(WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES + 1), 1009],
    ] as const)("closes on %s", async (_name, message, code) => {
        const socket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(socket);
        let closed = false;
        tunnel.on("close", () => {
            closed = true;
        });

        tunnel.message(message);
        await settle();

        expect(socket.closedWith?.code).toBe(code);
        expect(closed).toBe(true);
    });

    it("refuses bytes after the client ended its stream", async () => {
        const socket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(socket);
        tunnel.resume();

        tunnel.message(new Uint8Array(0));
        tunnel.message(Buffer.from("late"));
        await settle();

        expect(socket.closedWith?.code).toBe(1002);
    });

    it("pauses the WebSocket while its reader is behind and resumes when it reads", async () => {
        const socket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(socket);

        tunnel.message(Buffer.alloc(64 * 1024));
        expect(socket.paused).toBe(true);
        tunnel.read();
        await settle();
        expect(socket.paused).toBe(false);
    });

    it("holds writes back while the client is behind", async () => {
        const socket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(socket);
        socket.bufferedAmount = 8 * 1024 * 1024;
        let written = false;

        tunnel.write("data", () => {
            written = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(written).toBe(false);
        socket.bufferedAmount = 0;
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(written).toBe(true);
    });

    it("ends everything when the WebSocket closes or the daemon shuts down", async () => {
        const closedSocket = new FakeWebSocket();
        const tunnel = new WebSocketTunnel(closedSocket);
        tunnel.webSocketClosed();
        await settle();
        expect(tunnel.destroyed).toBe(true);
        expect(closedSocket.closedWith).toBeUndefined();

        const stopping = new FakeWebSocket();
        const other = new WebSocketTunnel(stopping);
        other.shutdown();
        await settle();
        expect(stopping.closedWith?.code).toBe(1001);
        expect(other.destroyed).toBe(true);
    });
});
