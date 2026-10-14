const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;

/** Re-serializes an ICO file with its largest image first, keeping ties in their original order. */
export function orderIconLargestFirst(icon: Uint8Array): Uint8Array {
    if (icon.byteLength < HEADER_SIZE)
        throw new Error("The icon file is too short to be an ICO file.");
    const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength);
    const reserved = view.getUint16(0, true);
    const type = view.getUint16(2, true);
    const count = view.getUint16(4, true);
    if (reserved !== 0 || type !== 1 || count === 0) {
        throw new Error("The icon file does not have a valid ICO header.");
    }
    if (icon.byteLength < HEADER_SIZE + ENTRY_SIZE * count) {
        throw new Error("The icon directory extends past the end of the file.");
    }

    const entries = Array.from({ length: count }, (_, index) => {
        const base = HEADER_SIZE + ENTRY_SIZE * index;
        const bytesInRes = view.getUint32(base + 8, true);
        const imageOffset = view.getUint32(base + 12, true);
        if (imageOffset + bytesInRes > icon.byteLength) {
            throw new Error(`Icon image ${index} extends past the end of the file.`);
        }
        return {
            index,
            width: icon[base] === 0 ? 256 : icon[base]!,
            directory: icon.subarray(base, base + ENTRY_SIZE),
            image: icon.subarray(imageOffset, imageOffset + bytesInRes),
        };
    });
    entries.sort((a, b) => b.width - a.width || a.index - b.index);

    const total = entries.reduce(
        (sum, entry) => sum + entry.image.byteLength,
        HEADER_SIZE + ENTRY_SIZE * count,
    );
    const output = new Uint8Array(total);
    const outputView = new DataView(output.buffer);
    output.set(icon.subarray(0, HEADER_SIZE), 0);
    let offset = HEADER_SIZE + ENTRY_SIZE * count;
    entries.forEach((entry, position) => {
        const base = HEADER_SIZE + ENTRY_SIZE * position;
        output.set(entry.directory, base);
        outputView.setUint32(base + 12, offset, true);
        output.set(entry.image, offset);
        offset += entry.image.byteLength;
    });
    return output;
}
