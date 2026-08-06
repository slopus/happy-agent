import { describe, expect, it } from "vitest";

import type { P2pFrameReader, P2pFrameWriter } from "./P2pFrameDuplex.js";
import { selectP2pTunnelRequestHeaders, selectP2pTunnelResponseHeaders } from "./P2pTunnel.js";
import {
    readP2pTunnelFrame,
    readP2pTunnelRequest,
    readP2pTunnelResponse,
    writeP2pTunnelChunk,
    writeP2pTunnelEnd,
    writeP2pTunnelFailure,
    writeP2pTunnelRequest,
    writeP2pTunnelResponse,
} from "./P2pTunnelProtocol.js";

describe("P2P tunnel framing", () => {
    it("round-trips a CONNECT head naming the remote daemon proxy route", async () => {
        const wire = new MemoryWire();
        await writeP2pTunnelRequest(wire.send, {
            headers: {},
            method: "CONNECT",
            path: "/projects/p1/workspaces/w1/proxy",
        });

        await expect(readP2pTunnelRequest(wire.recv())).resolves.toEqual({
            headers: {},
            method: "CONNECT",
            path: "/projects/p1/workspaces/w1/proxy",
        });
    });

    it("round-trips a GET upgrade head and its accepted response", async () => {
        const wire = new MemoryWire();
        await writeP2pTunnelRequest(wire.send, {
            headers: { connection: "Upgrade", upgrade: "websocket" },
            method: "GET",
            path: "/sessions/abc/terminal/attach?cols=80",
        });
        await writeP2pTunnelResponse(wire.send, {
            headers: { upgrade: "websocket" },
            status: 101,
        });
        const recv = wire.recv();

        const request = await readP2pTunnelRequest(recv);
        const response = await readP2pTunnelResponse(recv);

        expect(request.method).toBe("GET");
        expect(request.path).toBe("/sessions/abc/terminal/attach?cols=80");
        expect(response).toEqual({ headers: { upgrade: "websocket" }, status: 101 });
    });

    it("refuses a head that names a target host instead of a daemon route", async () => {
        const wire = new MemoryWire();

        await expect(
            writeP2pTunnelRequest(wire.send, {
                headers: {},
                method: "CONNECT",
                path: "127.0.0.1:8080",
            }),
        ).rejects.toThrow();
        await expect(
            writeP2pTunnelRequest(wire.send, {
                headers: {},
                method: "GET",
                path: "example.com:443",
            }),
        ).rejects.toThrow();
    });

    it("refuses a head whose route or headers exceed their bounds", async () => {
        const wire = new MemoryWire();

        await expect(
            writeP2pTunnelRequest(wire.send, {
                headers: {},
                method: "CONNECT",
                path: `/projects/${"p".repeat(17 * 1024)}/proxy`,
            }),
        ).rejects.toThrow();
        await expect(
            writeP2pTunnelRequest(wire.send, {
                headers: { "x-injected\r\nx": "value" },
                method: "GET",
                path: "/sessions/abc/terminal/attach",
            }),
        ).rejects.toThrow();
    });

    it("reports a refusal written in place of a response head", async () => {
        const wire = new MemoryWire();
        await writeP2pTunnelFailure(wire.send, new Error("The peer refused the tunnel."));

        await expect(readP2pTunnelResponse(wire.recv())).rejects.toThrow(
            "The peer refused the tunnel.",
        );
    });

    it("carries payload frames and an end-of-stream frame", async () => {
        const wire = new MemoryWire();
        await writeP2pTunnelChunk(wire.send, Buffer.from("hello"));
        await writeP2pTunnelEnd(wire.send);
        const recv = wire.recv();

        await expect(readP2pTunnelFrame(recv)).resolves.toEqual({
            bytes: new Uint8Array(Buffer.from("hello")),
            type: "chunk",
        });
        await expect(readP2pTunnelFrame(recv)).resolves.toEqual({ type: "end" });
    });

    it("rejects a frame larger than the negotiated bound before reading it", async () => {
        const wire = new MemoryWire(1024);
        const oversized = Buffer.alloc(5);
        oversized.writeUInt8(1, 0);
        oversized.writeUInt32BE(9_000, 1);
        await wire.send.write(oversized);

        await expect(readP2pTunnelFrame(wire.recv(), 8_000)).rejects.toThrow("oversized");
    });

    it("rejects a payload frame larger than the protocol allows on write", async () => {
        const wire = new MemoryWire(1024 * 1024);

        await expect(writeP2pTunnelChunk(wire.send, Buffer.alloc(64 * 1024 + 1))).rejects.toThrow(
            "too large",
        );
    });
});

describe("P2P tunnel headers", () => {
    it("keeps only forwardable request headers, normalized and bounded", () => {
        expect(
            selectP2pTunnelRequestHeaders({
                Authorization: "Bearer secret",
                Connection: "Upgrade",
                "proxy-authorization": "Basic secret",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                "sec-websocket-protocol": ["rig", "terminal"],
                Upgrade: "websocket",
                "x-forwarded-for": "10.0.0.1",
            }),
        ).toEqual({
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-protocol": "rig, terminal",
            upgrade: "websocket",
        });
    });

    it("drops a header value carrying control characters", () => {
        expect(
            selectP2pTunnelResponseHeaders({
                "sec-websocket-accept": "ok\r\nx-injected: yes",
                upgrade: "websocket",
            }),
        ).toEqual({ upgrade: "websocket" });
    });
});

class MemoryWire {
    readonly #chunks: number[] = [];
    readonly #writeLimit: number;

    constructor(writeLimit = 7) {
        this.#writeLimit = writeLimit;
    }

    readonly send: P2pFrameWriter = {
        finish: async () => undefined,
        write: async (bytes: Uint8Array) => {
            const written = Math.min(bytes.byteLength, this.#writeLimit);
            this.#chunks.push(...bytes.subarray(0, written));
            return written;
        },
    };

    recv(): P2pFrameReader {
        let offset = 0;
        return {
            read: async (length: number) => {
                const result = this.#chunks.slice(offset, offset + length);
                if (result.length !== length) throw new Error("Unexpected end of test data.");
                offset += length;
                return Uint8Array.from(result);
            },
        };
    }
}
