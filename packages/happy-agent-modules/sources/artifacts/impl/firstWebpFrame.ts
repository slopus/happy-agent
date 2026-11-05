/**
 * The first frame of an animated WebP, rewrapped as a still WebP, because Bun.Image refuses to
 * decode an animation at all. The frame's own bitstream is copied, never re-encoded: a lossy frame
 * with an ALPH chunk becomes a VP8X still with that alpha, and any other frame becomes a plain
 * VP8 or VP8L file. Returns the bytes unchanged when they are not an animated WebP, and undefined
 * when they claim to be one but hold no readable frame.
 */
export function firstWebpFrame(bytes: Uint8Array): Uint8Array | undefined {
    if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
        return bytes;
    }
    const chunks = readChunks(bytes, 12, Math.min(bytes.byteLength, 8 + uint32(bytes, 4)));
    if (chunks === undefined) return undefined;
    const animated = chunks.find((chunk) => chunk.type === "VP8X" && chunk.data.byteLength >= 10);
    if (animated === undefined || (animated.data[0]! & 0x02) === 0) return bytes;
    const frame = chunks.find((chunk) => chunk.type === "ANMF" && chunk.data.byteLength > 16);
    if (frame === undefined) return undefined;
    const inner = readChunks(frame.data, 16, frame.data.byteLength);
    const image = inner?.find((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L");
    if (image === undefined) return undefined;
    const alpha = image.type === "VP8 " ? inner!.find((chunk) => chunk.type === "ALPH") : undefined;
    if (alpha === undefined) return riff([chunk(image.type, image.data)]);
    const header = new Uint8Array(10);
    header[0] = 0x10;
    header.set(frame.data.subarray(6, 12), 4);
    return riff([chunk("VP8X", header), chunk("ALPH", alpha.data), chunk("VP8 ", image.data)]);
}

interface Chunk {
    readonly type: string;
    readonly data: Uint8Array;
}

function readChunks(bytes: Uint8Array, start: number, end: number): Chunk[] | undefined {
    const chunks: Chunk[] = [];
    for (let offset = start; offset + 8 <= end; ) {
        const length = uint32(bytes, offset + 4);
        const data = offset + 8;
        if (data + length > end) return undefined;
        chunks.push({ type: ascii(bytes, offset, 4), data: bytes.subarray(data, data + length) });
        offset = data + length + (length % 2);
    }
    return chunks;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + data.byteLength + (data.byteLength % 2));
    out.set(Buffer.from(type, "latin1"));
    new DataView(out.buffer).setUint32(4, data.byteLength, true);
    out.set(data, 8);
    return out;
}

function riff(chunks: Uint8Array[]): Uint8Array {
    const size = chunks.reduce((total, part) => total + part.byteLength, 4);
    const out = new Uint8Array(8 + size);
    out.set(Buffer.from("RIFF", "latin1"));
    new DataView(out.buffer).setUint32(4, size, true);
    out.set(Buffer.from("WEBP", "latin1"), 8);
    let offset = 12;
    for (const part of chunks) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
