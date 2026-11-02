import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { normalizeServerUrl } from "../../sources/connections/impl/normalizeServerUrl.js";
import { serverConnectionId } from "../../sources/connections/impl/serverConnectionId.js";
import {
    ClientFrameStream,
    keepWebSocketAlive,
} from "../../sources/connections/impl/webSocketKeepalive.js";

describe("server URLs", () => {
    it.each([
        ["https://Happy.Example.com", "https://happy.example.com/"],
        ["https://happy.example.com:443/team", "https://happy.example.com/team/"],
        ["https://happy.example.com:8443/team/", "https://happy.example.com:8443/team/"],
        ["http://localhost:3000", "http://localhost:3000/"],
        ["http://127.0.0.1:3000/x", "http://127.0.0.1:3000/x/"],
        ["http://[::1]:3000", "http://[::1]:3000/"],
    ])("normalizes %s", (input, expected) => {
        expect(normalizeServerUrl(input)).toBe(expected);
    });

    it.each([
        "http://happy.example.com",
        "ftp://happy.example.com",
        "https://user:pass@happy.example.com",
        "https://happy.example.com/?a=1",
        "https://happy.example.com/?",
        "https://happy.example.com/#top",
        "happy.example.com",
    ])("refuses %s", (input) => {
        expect(normalizeServerUrl(input)).toBeUndefined();
    });

    it("derives a unique connection ID from the host", () => {
        expect(serverConnectionId("https://happy.example.com/", new Set())).toBe(
            "happy-example-com",
        );
        expect(
            serverConnectionId(
                "https://happy.example.com/team/",
                new Set(["happy-example-com", "happy-example-com-2"]),
            ),
        ).toBe("happy-example-com-3");
        expect(serverConnectionId("http://127.0.0.1:3000/", new Set())).toBe("server-127-0-0-1");
        expect(serverConnectionId("http://[::1]:3000/", new Set())).toBe("server-1");
    });
});

describe("WebSocket keepalive", () => {
    /** One masked client frame with `length` payload bytes. */
    function frame(length: number): Buffer {
        const header =
            length < 126
                ? Buffer.from([0x82, 0x80 | length])
                : Buffer.from([0x82, 0x80 | 126, length >> 8, length & 0xff]);
        return Buffer.concat([header, Buffer.alloc(4, 1), Buffer.alloc(length, 7)]);
    }

    function collect(stream: ClientFrameStream): Buffer[] {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        return chunks;
    }

    it("passes frames through unchanged and pings only between frames", () => {
        const stream = new ClientFrameStream();
        const chunks = collect(stream);
        const big = frame(300);
        stream.write(big.subarray(0, 3)); // inside the header
        stream.ping();
        stream.write(big.subarray(3, 100)); // inside the payload
        expect(Buffer.concat(chunks)).toEqual(big.subarray(0, 100));
        stream.write(big.subarray(100));
        const output = Buffer.concat(chunks);
        expect(output.subarray(0, big.length)).toEqual(big);
        // The ping follows the frame, masked with no payload.
        expect(output.subarray(big.length, big.length + 2)).toEqual(Buffer.from([0x89, 0x80]));
        expect(output.length).toBe(big.length + 6);

        stream.ping();
        expect(Buffer.concat(chunks).length).toBe(big.length + 12);
    });

    it("closes the client's WebSocket with 1011 after the remote stays silent", () => {
        vi.useFakeTimers();
        try {
            const client = new PassThrough();
            const remote = new PassThrough();
            const written: Buffer[] = [];
            client.on("data", (chunk: Buffer) => written.push(chunk));
            const pinged: Buffer[] = [];
            const { toRemote } = keepWebSocketAlive(client, remote, 45_000);
            toRemote.on("data", (chunk: Buffer) => pinged.push(chunk));

            vi.advanceTimersByTime(15_000);
            expect(pinged).toHaveLength(1);
            remote.write("still here");
            vi.advanceTimersByTime(30_000);
            expect(written).toEqual([]);
            vi.advanceTimersByTime(45_000);
            expect(Buffer.concat(written)).toEqual(Buffer.from([0x88, 0x02, 0x03, 0xf3]));
            expect(remote.destroyed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
