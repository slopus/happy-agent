import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { orderIconLargestFirst } from "../scripts/orderIconLargestFirst.js";

function buildIcon(images: { widthByte: number; bytes: number[] }[]): Uint8Array {
    const header = 6 + 16 * images.length;
    const total = header + images.reduce((sum, image) => sum + image.bytes.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, images.length, true);
    let offset = header;
    images.forEach((image, index) => {
        const base = 6 + 16 * index;
        out[base] = image.widthByte;
        out[base + 1] = image.widthByte;
        view.setUint16(base + 4, 1, true);
        view.setUint16(base + 6, 32, true);
        view.setUint32(base + 8, image.bytes.length, true);
        view.setUint32(base + 12, offset, true);
        out.set(image.bytes, offset);
        offset += image.bytes.length;
    });
    return out;
}

function readEntries(icon: Uint8Array) {
    const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength);
    return Array.from({ length: view.getUint16(4, true) }, (_, index) => {
        const base = 6 + 16 * index;
        const size = view.getUint32(base + 8, true);
        const offset = view.getUint32(base + 12, true);
        return {
            width: icon[base] === 0 ? 256 : icon[base]!,
            offset,
            bytes: Array.from(icon.subarray(offset, offset + size)),
        };
    });
}

describe("orderIconLargestFirst", () => {
    it("puts the largest image first with correct offsets and unchanged bytes", () => {
        const source = buildIcon([
            { widthByte: 16, bytes: [1, 1, 1] },
            { widthByte: 0, bytes: [2, 2, 2, 2, 2] },
            { widthByte: 32, bytes: [3, 3] },
        ]);
        const entries = readEntries(orderIconLargestFirst(source));
        expect(entries.map((entry) => entry.width)).toEqual([256, 32, 16]);
        expect(entries.map((entry) => entry.offset)).toEqual([54, 59, 61]);
        expect(entries.map((entry) => entry.bytes)).toEqual([
            [2, 2, 2, 2, 2],
            [3, 3],
            [1, 1, 1],
        ]);
    });

    it("keeps the original order for equal widths", () => {
        const source = buildIcon([
            { widthByte: 32, bytes: [1] },
            { widthByte: 32, bytes: [2] },
        ]);
        expect(readEntries(orderIconLargestFirst(source)).map((entry) => entry.bytes[0])).toEqual([
            1, 2,
        ]);
    });

    it("rejects a malformed header", () => {
        const source = buildIcon([{ widthByte: 16, bytes: [1] }]);
        source[2] = 2;
        expect(() => orderIconLargestFirst(source)).toThrow(/valid ICO header/);
    });

    it("rejects an image outside the file", () => {
        const source = buildIcon([{ widthByte: 16, bytes: [1, 2] }]);
        new DataView(source.buffer).setUint32(6 + 8, 100, true);
        expect(() => orderIconLargestFirst(source)).toThrow(/past the end/);
    });

    const trayIcon = [
        resolve(
            import.meta.dirname,
            "../../happy-agent-modules/sources/menuBar/native/windows/happy.ico",
        ),
    ].find((candidate) => existsSync(candidate));

    it.skipIf(!trayIcon)("orders the real tray icon with 256px first", () => {
        const source = new Uint8Array(readFileSync(trayIcon!));
        const before = readEntries(source);
        const after = readEntries(orderIconLargestFirst(source));
        expect(after).toHaveLength(before.length);
        expect(after[0]!.width).toBe(256);
    });
});
