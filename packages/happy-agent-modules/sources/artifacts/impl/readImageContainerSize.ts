/**
 * The size of a WebP or GIF, read from its container rather than decoded, so an animation is
 * measured without decoding every frame: a WebP's VP8X canvas, or the size in its single VP8 or
 * VP8L frame, and a GIF's logical screen. Undefined when the bytes are not that format.
 */
export function readImageContainerSize(
    bytes: Uint8Array,
    format: "webp" | "gif",
): { readonly width: number; readonly height: number } | undefined {
    return format === "webp" ? readWebpHeader(bytes) : readGifHeader(bytes);
}

function readWebpHeader(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
        return undefined;
    }
    const end = Math.min(bytes.byteLength, 8 + view.getUint32(4, true));
    let size: { width: number; height: number } | undefined;
    let canvas: { width: number; height: number } | undefined;
    for (let offset = 12; offset + 8 <= end; ) {
        const type = ascii(bytes, offset, 4);
        const length = view.getUint32(offset + 4, true);
        const data = offset + 8;
        if (data + length > end) return undefined;
        if (type === "VP8X" && length >= 10) {
            canvas = { width: uint24(bytes, data + 4) + 1, height: uint24(bytes, data + 7) + 1 };
        } else if (type === "VP8 " && length >= 10 && size === undefined) {
            if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
                return undefined;
            }
            size = {
                width: view.getUint16(data + 6, true) & 0x3fff,
                height: view.getUint16(data + 8, true) & 0x3fff,
            };
        } else if (type === "VP8L" && length >= 5 && size === undefined) {
            if (bytes[data] !== 0x2f) return undefined;
            const bits = view.getUint32(data + 1, true);
            size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        offset = data + length + (length % 2);
    }
    const measured = canvas ?? size;
    if (measured === undefined || measured.width < 1 || measured.height < 1) return undefined;
    return measured;
}

function readGifHeader(bytes: Uint8Array) {
    const signature = ascii(bytes, 0, 6);
    if (bytes.byteLength < 13 || (signature !== "GIF87a" && signature !== "GIF89a")) {
        return undefined;
    }
    const width = bytes[6]! | (bytes[7]! << 8);
    const height = bytes[8]! | (bytes[9]! << 8);
    if (width < 1 || height < 1) return undefined;
    return { width, height };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}
