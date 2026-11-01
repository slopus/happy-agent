import { describe, expect, it } from "vitest";
import { isH264Mp4 } from "../../sources/stories/storyStore.js";

function box(type: string, body: Buffer = Buffer.alloc(0), wide = false): Buffer {
    const header = Buffer.alloc(wide ? 16 : 8);
    header.writeUInt32BE(wide ? 1 : 8 + body.length);
    header.write(type, 4, "latin1");
    if (wide) header.writeBigUInt64BE(BigInt(header.length + body.length), 8);
    return Buffer.concat([header, body]);
}
const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom"));
function track(codec: string, wide = false): Buffer {
    let result = box(
        "stsd",
        Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box(codec, Buffer.alloc(78))]),
    );
    for (const kind of ["stbl", "minf", "mdia", "trak", "moov"]) result = box(kind, result, wide);
    return result;
}

describe("H.264 story media", () => {
    it("accepts avc1 and avc3 sample entries inside moov, including extended box sizes", () => {
        for (const codec of ["avc1", "avc3"])
            for (const wide of [false, true])
                expect(isH264Mp4(Buffer.concat([ftyp, track(codec, wide)]))).toBe(true);
    });
    it("rejects H.264 markers in frame data, unrelated metadata, or another codec's track", () => {
        for (const body of [
            box("mdat", Buffer.from("avc1 avc3")),
            box("moov", box("udta", Buffer.from("stsd avc1"))),
            Buffer.concat([track("hvc1"), box("mdat", Buffer.from("avc1"))]),
        ])
            expect(isH264Mp4(Buffer.concat([ftyp, body]))).toBe(false);
    });
    it("refuses truncated and impossible boxes without reading outside them", () => {
        for (const body of [
            Buffer.from([0, 0, 0, 1, 109, 111, 111, 118]),
            box("moov", Buffer.alloc(1)),
            Buffer.from([0xff, 0xff, 0xff, 0xff, 109, 111, 111, 118]),
        ])
            expect(isH264Mp4(Buffer.concat([ftyp, body]))).toBe(false);
    });
});
