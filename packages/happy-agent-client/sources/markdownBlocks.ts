/**
 * The parts of Markdown where inline syntax is live: outside fenced code, and outside code spans.
 * Reference tags and file links both scan with these, so they agree on what is code.
 */

const FENCE_OPEN = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/;
const BLANK_LINE = /^[ \t\r]*$/;

/**
 * The runs of Markdown that are neither fenced code nor blank lines, each including its line
 * endings. A code span cannot cross a blank line, so each run bounds the spans inside it. A fence
 * without a closing line runs to the end, which is also how a streaming fence reads.
 */
export function textBlocks(markdown: string): { start: number; end: number }[] {
    const blocks: { start: number; end: number }[] = [];
    let blockStart: number | undefined;
    let fence: MarkdownFence | undefined;
    let lineStart = 0;
    while (lineStart < markdown.length) {
        const newline = markdown.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? markdown.length : newline + 1;
        const line = markdown.slice(lineStart, newline === -1 ? markdown.length : newline);
        if (fence !== undefined) {
            if (isFenceClose(line, fence)) fence = undefined;
        } else {
            const open = fenceOpening(line);
            if (open !== undefined) {
                if (blockStart !== undefined) blocks.push({ start: blockStart, end: lineStart });
                blockStart = undefined;
                fence = open;
            } else if (BLANK_LINE.test(line)) {
                if (blockStart !== undefined) blocks.push({ start: blockStart, end: lineStart });
                blockStart = undefined;
            } else {
                blockStart ??= lineStart;
            }
        }
        lineStart = lineEnd;
    }
    if (blockStart !== undefined) blocks.push({ start: blockStart, end: markdown.length });
    return blocks;
}

/** A fenced code block's opening run, when `line` opens one. */
export interface MarkdownFence {
    readonly marker: string;
    readonly length: number;
}

/** The fence `line` opens, or `undefined` when it opens none. */
export function fenceOpening(line: string): MarkdownFence | undefined {
    const open = FENCE_OPEN.exec(line);
    const marker = open?.[1];
    const info = open?.[2] ?? "";
    if (marker === undefined || (marker.startsWith("`") && info.includes("`"))) return undefined;
    return { marker: marker.charAt(0), length: marker.length };
}

/** Whether `line` closes the open `fence`. */
export function isFenceClose(line: string, fence: MarkdownFence): boolean {
    const close = /^[ \t]*(?:>[ \t]?)*[ \t]*(`+|~+)[ \t\r]*$/.exec(line)?.[1];
    return close !== undefined && close.charAt(0) === fence.marker && close.length >= fence.length;
}

/**
 * Skips a code span that opens at `start`, returning the index after it. Backticks with no
 * closing run of the same length are literal, except at the end of streaming text, where the
 * closing run may still arrive and everything after the opening run reads as code.
 */
export function skipCodeSpan(markdown: string, start: number, end: number, open: boolean): number {
    const length = runLength(markdown, start, "`");
    let index = start + length;
    while (index < end) {
        const next = markdown.indexOf("`", index);
        if (next === -1 || next >= end) break;
        const closing = runLength(markdown, next, "`");
        if (closing === length) return next + closing;
        index = next + closing;
    }
    return open ? end : start + length;
}

function runLength(text: string, start: number, character: string): number {
    let index = start;
    while (text[index] === character) index += 1;
    return index - start;
}
