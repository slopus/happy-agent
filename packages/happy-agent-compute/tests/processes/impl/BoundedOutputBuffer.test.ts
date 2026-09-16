import { describe, expect, it } from "vitest";

import { BoundedOutputBuffer } from "../../../sources/processes/index.js";

describe("BoundedOutputBuffer", () => {
    it("keeps a head and tail and reports the bytes dropped from the middle", () => {
        const buffer = new BoundedOutputBuffer(6);
        buffer.append(Buffer.from("oldest-newest"));

        expect(buffer.snapshot().toString("utf8")).toBe("old\n... 7 bytes omitted ...\nest");
        expect(buffer.totalBytes).toBe(13);
        expect(buffer.omittedBytes).toBe(7);
    });

    it("returns only the bytes after an offset", () => {
        const buffer = new BoundedOutputBuffer(4_096);
        buffer.append(Buffer.from("abcdef"));

        const fromOffset = buffer.snapshotFromOffset(2);
        expect(fromOffset.buffer.toString("utf8")).toBe("cdef");
        expect(fromOffset.totalBytes).toBe(4);
        expect(fromOffset.omittedBytes).toBe(0);
    });

    it("drains what has accumulated and starts counting again from zero", () => {
        const buffer = new BoundedOutputBuffer(4_096);
        buffer.append(Buffer.from("first"));

        const drained = buffer.drain();
        expect(drained.snapshot().toString("utf8")).toBe("first");

        buffer.append(Buffer.from("second"));
        expect(buffer.snapshot().toString("utf8")).toBe("second");
    });

    it("can hold an incomplete UTF-8 sequence for independent live readers", () => {
        const buffer = new BoundedOutputBuffer(4096);
        buffer.append(Buffer.from([0xf0, 0x9f]));
        const pending = buffer.snapshotFromOffset(0, false);
        expect(pending.buffer).toEqual(Buffer.alloc(0));
        expect(pending.totalBytes).toBe(0);
        buffer.append(Buffer.from([0x98, 0x80]));
        const completed = buffer.snapshotFromOffset(0, false);
        expect(completed.buffer.toString("utf8")).toBe("😀");
        expect(completed.totalBytes).toBe(4);
    });
});
