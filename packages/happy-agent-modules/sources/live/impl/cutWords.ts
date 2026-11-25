/**
 * Text within `bytes` of UTF-8, cut after a whole word and ending `… (cut, N more words)`, as the
 * phones cut what voice is told. Text that fits is returned unchanged.
 */
export function cutWords(text: string, bytes: number): string {
    if (Buffer.byteLength(text) <= bytes) return text;
    const words = text.split(/(\s+)/);
    let kept = "";
    let index = 0;
    for (; index < words.length; index++) {
        const next = kept + words[index]!;
        if (Buffer.byteLength(next) > bytes - 32) break;
        kept = next;
    }
    if (kept.trim() === "")
        kept = Buffer.from(text)
            .subarray(0, bytes - 32)
            .toString("utf8");
    const left = words.slice(index).filter((word) => word.trim() !== "").length;
    return `${kept.trimEnd()} … (cut, ${String(Math.max(1, left))} more words)`;
}
