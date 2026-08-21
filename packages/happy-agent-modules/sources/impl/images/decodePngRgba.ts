import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode the bounded, non-interlaced PNG emitted by Bun.Image into RGBA for ThumbHash. */
export function decodePngRgba(bytes: Uint8Array): {
    readonly data: Buffer;
    readonly height: number;
    readonly width: number;
} {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (input.byteLength < 33 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error("The image pipeline returned an invalid PNG.");
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = -1;
    let bitDepth = -1;
    let interlace = -1;
    const compressed: Buffer[] = [];
    while (offset + 12 <= input.byteLength) {
        const length = input.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > input.byteLength) throw new Error("The image pipeline returned a truncated PNG.");
        const type = input.subarray(offset + 4, offset + 8).toString("ascii");
        const data = input.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
            if (length !== 13)
                throw new Error("The image pipeline returned an invalid PNG header.");
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8] ?? -1;
            colorType = data[9] ?? -1;
            interlace = data[12] ?? -1;
        } else if (type === "IDAT") compressed.push(data);
        else if (type === "IEND") break;
        offset = end;
    }
    const channels =
        colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
    if (
        width < 1 ||
        height < 1 ||
        width > 100 ||
        height > 100 ||
        bitDepth !== 8 ||
        interlace !== 0 ||
        channels === 0 ||
        compressed.length === 0
    ) {
        throw new Error("The image pipeline returned an unsupported PNG layout.");
    }
    const stride = width * channels;
    const inflated = inflateSync(Buffer.concat(compressed), {
        maxOutputLength: (stride + 1) * height,
    });
    if (inflated.byteLength !== (stride + 1) * height) {
        throw new Error("The image pipeline returned invalid PNG pixels.");
    }
    const decoded = Buffer.allocUnsafe(stride * height);
    let sourceOffset = 0;
    for (let row = 0; row < height; row += 1) {
        const filter = inflated[sourceOffset] ?? -1;
        sourceOffset += 1;
        const rowOffset = row * stride;
        for (let column = 0; column < stride; column += 1) {
            const encoded = inflated[sourceOffset + column] ?? 0;
            const left = column >= channels ? (decoded[rowOffset + column - channels] ?? 0) : 0;
            const above = row > 0 ? (decoded[rowOffset + column - stride] ?? 0) : 0;
            const upperLeft =
                row > 0 && column >= channels
                    ? (decoded[rowOffset + column - stride - channels] ?? 0)
                    : 0;
            const predictor =
                filter === 0
                    ? 0
                    : filter === 1
                      ? left
                      : filter === 2
                        ? above
                        : filter === 3
                          ? Math.floor((left + above) / 2)
                          : filter === 4
                            ? paeth(left, above, upperLeft)
                            : undefined;
            if (predictor === undefined) {
                throw new Error("The image pipeline returned an unknown PNG filter.");
            }
            decoded[rowOffset + column] = (encoded + predictor) & 0xff;
        }
        sourceOffset += stride;
    }
    if (channels === 4) return { data: decoded, height, width };
    const rgba = Buffer.allocUnsafe(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
        const source = pixel * channels;
        const target = pixel * 4;
        if (channels === 3) {
            rgba[target] = decoded[source] ?? 0;
            rgba[target + 1] = decoded[source + 1] ?? 0;
            rgba[target + 2] = decoded[source + 2] ?? 0;
            rgba[target + 3] = 255;
        } else {
            const luminance = decoded[source] ?? 0;
            rgba[target] = luminance;
            rgba[target + 1] = luminance;
            rgba[target + 2] = luminance;
            rgba[target + 3] = channels === 2 ? (decoded[source + 1] ?? 0) : 255;
        }
    }
    return { data: rgba, height, width };
}

function paeth(left: number, above: number, upperLeft: number): number {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
}
