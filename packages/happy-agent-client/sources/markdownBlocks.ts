/**
 * The parts of Markdown where inline syntax is live: outside fenced code, and outside code spans.
 * Happy links scan with these, so they agree with Markdown on what is code.
 */

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
    const start = fencePrefixEnd(line);
    const marker = line[start];
    if (marker !== "`" && marker !== "~") return undefined;
    const length = runLength(line, start, marker);
    if (length < 3) return undefined;
    const info = line.slice(start + length);
    // A line terminator is not part of an info string, so a line holding one opens nothing.
    if (/[\r\u2028\u2029]/u.test(info)) return undefined;
    if (marker === "`" && info.includes("`")) return undefined;
    return { marker, length };
}

/** Whether `line` closes the open `fence`. */
export function isFenceClose(line: string, fence: MarkdownFence): boolean {
    const start = fencePrefixEnd(line);
    const marker = line[start];
    if (marker !== fence.marker) return false;
    const length = runLength(line, start, marker);
    return length >= fence.length && /^[ \t\r]*$/u.test(line.slice(start + length));
}

/**
 * Where a fence marker may start: after indentation and blockquote markers, each `>` taking at
 * most one following space or tab, and any spaces after them. A scan rather than a pattern, so a
 * long run of spaces or markers cannot make it backtrack.
 */
function fencePrefixEnd(line: string): number {
    let index = 0;
    while (line[index] === " " || line[index] === "\t") index += 1;
    while (line[index] === ">") {
        index += 1;
        if (line[index] === " " || line[index] === "\t") index += 1;
    }
    while (line[index] === " " || line[index] === "\t") index += 1;
    return index;
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
