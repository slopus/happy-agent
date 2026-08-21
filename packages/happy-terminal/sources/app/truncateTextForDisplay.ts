const TRUNCATION_MARKER = "... [truncated]";

export interface TruncatedText {
    readonly text: string;
    readonly truncated: boolean;
}

export function truncateTextForDisplay(value: string, maximumCharacters: number): TruncatedText {
    const limit = Math.max(0, Math.floor(maximumCharacters));
    if (value.length <= limit) return { text: value, truncated: false };
    if (limit === 0) return { text: "", truncated: true };
    if (limit <= TRUNCATION_MARKER.length) {
        return { text: TRUNCATION_MARKER.slice(0, limit), truncated: true };
    }

    const prefixLimit = limit - TRUNCATION_MARKER.length;
    let prefix = value.slice(0, prefixLimit);
    const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
    return { text: `${prefix}${TRUNCATION_MARKER}`, truncated: true };
}
