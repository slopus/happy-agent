import { TextDecoder } from "node:util";

/** Media types whose bytes are text even though they are not `text/*`. */
const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/manifest+json",
    "application/xml",
    "application/yaml",
    "image/svg+xml",
]);

/**
 * A window of a file's bytes as text, or `undefined` when the file is not text.
 *
 * The window may start or end inside a character: a leading partial character is skipped and a
 * trailing one is left for the next window, so the text never shows a broken character. A file of
 * a known binary type is never text, and one of an unknown type is text only when its bytes are
 * valid UTF-8.
 */
export function decodeArtifactText(
    mimeType: string,
    bytes: Uint8Array,
    window: { readonly atStart: boolean; readonly atEnd: boolean },
): { readonly text: string; readonly consumed: number } | undefined {
    let start = 0;
    if (!window.atStart) {
        while (start < Math.min(3, bytes.byteLength) && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
            start += 1;
        }
    }
    let end = bytes.byteLength;
    if (!window.atEnd) end = start + completeUtf8Length(bytes.subarray(start));
    const known = mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType);
    if (!known && mimeType !== "application/octet-stream") return undefined;
    try {
        const text = new TextDecoder("utf-8", { fatal: !known }).decode(bytes.subarray(start, end));
        return { text, consumed: end };
    } catch {
        return undefined;
    }
}

/** How many leading bytes end on a whole UTF-8 character. */
function completeUtf8Length(bytes: Uint8Array): number {
    for (let back = 1; back <= Math.min(3, bytes.byteLength); back += 1) {
        const byte = bytes[bytes.byteLength - back] ?? 0;
        if ((byte & 0xc0) === 0x80) continue;
        const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return width > back ? bytes.byteLength - back : bytes.byteLength;
    }
    return bytes.byteLength;
}
