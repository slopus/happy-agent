import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";

describe("Node P2P frame duplex", () => {
    it("preserves exact reads across arbitrary Node stream chunks", async () => {
        const recv = new PassThrough();
        const send = new PassThrough();
        const duplex = createNodeFrameDuplex(recv, send);
        recv.write(Uint8Array.of(1, 2));
        recv.write(Uint8Array.of(3, 4, 5));

        await expect(duplex.recv.read(4)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4));
        await expect(duplex.recv.read(1)).resolves.toEqual(Uint8Array.of(5));
    });

    it("writes without treating a logical frame finish as a socket close", async () => {
        const recv = new PassThrough();
        const send = new PassThrough();
        const chunks: Buffer[] = [];
        send.on("data", (chunk: Buffer) => chunks.push(chunk));
        const duplex = createNodeFrameDuplex(recv, send);

        await expect(duplex.send.write(Uint8Array.of(6, 7))).resolves.toBe(2);
        await duplex.send.finish();
        expect(Buffer.concat(chunks)).toEqual(Buffer.from([6, 7]));
        expect(send.writableEnded).toBe(false);
    });

    it("rejects a backpressured write when the stream closes without draining", async () => {
        const send = new Writable({
            highWaterMark: 1,
            write: (_chunk, _encoding, _callback) => undefined,
        });
        const duplex = createNodeFrameDuplex(new PassThrough(), send);
        const writing = duplex.send.write(Uint8Array.of(1, 2));

        send.destroy();

        await expect(writing).rejects.toThrow("closed before its write completed");
    });
});
