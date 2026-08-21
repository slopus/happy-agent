const TRUNCATION_MARKER = "... [truncated]";

export function truncateUtf8BytesForDisplay(value: string, maximumBytes: number): string {
    const limit = Math.max(0, Math.floor(maximumBytes));
    if (Buffer.byteLength(value) <= limit) return value;
    if (limit === 0) return "";
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
    if (limit <= markerBytes) return TRUNCATION_MARKER.slice(0, limit);

    const prefixBytes = limit - markerBytes;
    let low = 0;
    let high = Math.min(value.length, prefixBytes);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle)) <= prefixBytes) low = middle;
        else high = middle - 1;
    }
    let prefix = value.slice(0, low);
    const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
    return `${prefix}${TRUNCATION_MARKER}`;
}
