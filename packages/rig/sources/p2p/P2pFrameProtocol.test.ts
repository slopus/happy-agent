import { describe, expect, it } from "vitest";

import type { P2pFrameReader, P2pFrameWriter } from "./P2pFrameDuplex.js";
import {
    readP2pHttpRequest,
    readP2pHttpResponse,
    writeP2pHttpRequest,
    writeP2pHttpResponse,
} from "./P2pFrameProtocol.js";

describe("P2P HTTP framing", () => {
    it("round-trips request metadata and a body through partial transport writes", async () => {
        const wire = new MemoryWire();
        await writeP2pHttpRequest(wire.send, {
            body: Buffer.from("request body"),
            headers: { "content-type": "text/plain" },
            method: "POST",
            path: "/messages?scope=all",
        });

        await expect(readP2pHttpRequest(wire.recv())).resolves.toEqual({
            body: new Uint8Array(Buffer.from("request body")),
            headers: { "content-type": "text/plain" },
            method: "POST",
            path: "/messages?scope=all",
        });
    });

    it("reads large request bodies from the transport in bounded chunks", async () => {
        const wire = new MemoryWire(64 * 1024);
        const body = Buffer.alloc(128 * 1024 + 17, 42);
        await writeP2pHttpRequest(wire.send, {
            body,
            headers: {},
            method: "POST",
            path: "/messages",
        });

        const request = await readP2pHttpRequest(wire.recv());

        expect(request.body).toEqual(new Uint8Array(body));
        expect(wire.maximumReadLength).toBeLessThanOrEqual(64 * 1024);
    });

    it("streams response chunks without combining them into one body", async () => {
        const wire = new MemoryWire();
        await writeP2pHttpResponse(wire.send, {
            body: (async function* () {
                yield Buffer.from("first");
                yield Buffer.from("second");
            })(),
            headers: { "content-type": "text/event-stream" },
            status: 200,
        });
        let closed = false;
        const response = await readP2pHttpResponse(wire.recv(), () => {
            closed = true;
        });
        const chunks: string[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk).toString("utf8"));

        expect(response.status).toBe(200);
        expect(response.headers).toEqual({ "content-type": "text/event-stream" });
        expect(chunks).toEqual(["first", "second"]);
        expect(closed).toBe(true);
    });

    it("times out when a peer stops reading a response write", async () => {
        const stalledSend: P2pFrameWriter = {
            finish: async () => undefined,
            write: () => new Promise<number>(() => undefined),
        };

        await expect(
            writeP2pHttpResponse(
                stalledSend,
                {
                    body: (async function* () {
                        yield Buffer.from("response");
                    })(),
                    headers: {},
                    status: 200,
                },
                5,
            ),
        ).rejects.toThrow("stopped reading");
    });
});

class MemoryWire {
    readonly #chunks: number[] = [];
    readonly #writeLimit: number;
    maximumReadLength = 0;

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
                this.maximumReadLength = Math.max(this.maximumReadLength, length);
                const result = this.#chunks.slice(offset, offset + length);
                if (result.length !== length) throw new Error("Unexpected end of test data.");
                offset += length;
                return Uint8Array.from(result);
            },
        };
    }
}
