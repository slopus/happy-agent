/**
 * HTML blocks in Markdown: blocks that start at the start of a line indented at most three spaces,
 * outside fenced code and outside a code span, and run until their root element closes, counting
 * only that tag, so blank lines inside never end them. Media layouts (`mediaLayoutBlocks`) and
 * inline action blocks (`chatActionBlocks`) are both found this way, each with its own rules.
 */

import { fenceOpening, isFenceClose, type MarkdownFence } from "./markdownBlocks.js";

const PARTIAL_START = /^ {0,3}<([a-z]*)$/iu;
const BLANK_LINE = /^[ \t\r]*$/u;
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/uy;

/** How `splitHtmlBlocks` finds one kind of block. */
export interface HtmlBlockRules {
    /** The root tag a line starts a block with, lowercased, or undefined when it starts none. */
    readonly start: (line: string) => string | undefined;
    /** Whether an unfinished last line `<name` could still become a block start. */
    readonly partial: (name: string) => boolean;
    /** Whether a complete block is one; otherwise its text stays Markdown. */
    readonly keep: (block: { readonly image: boolean }) => boolean;
}

/** One block or stretch of Markdown found by `splitHtmlBlocks`. */
export type HtmlBlockSegment =
    | { type: "markdown"; text: string }
    | { type: "block"; html: string; complete: boolean };

/**
 * Splits Markdown around HTML blocks that start at the start of a line indented at most three
 * spaces, outside fenced code and outside a code span, and run until their root element closes.
 * Media layouts and inline action blocks are both found this way, each with its own rules.
 */
export function splitHtmlBlocks(markdown: string, rules: HtmlBlockRules): HtmlBlockSegment[] {
    const segments: HtmlBlockSegment[] = [];
    const pushMarkdown = (text: string): void => {
        if (text === "") return;
        const last = segments[segments.length - 1];
        if (last?.type === "markdown") last.text += text;
        else segments.push({ type: "markdown", text });
    };
    let markdownStart = 0;
    let lineStart = 0;
    let fence: MarkdownFence | undefined;
    const spans = new CodeSpans(markdown);
    // Where the code span covering the current paragraph's text ends; nothing starts before it.
    let codeUntil = 0;
    while (lineStart < markdown.length) {
        const newline = markdown.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? markdown.length : newline + 1;
        const line = markdown.slice(lineStart, newline === -1 ? markdown.length : newline);
        if (fence !== undefined) {
            if (isFenceClose(line, fence)) fence = undefined;
            lineStart = lineEnd;
            continue;
        }
        const opening = fenceOpening(line);
        if (opening !== undefined) {
            fence = opening;
            lineStart = lineEnd;
            continue;
        }
        if (BLANK_LINE.test(line)) {
            lineStart = lineEnd;
            continue;
        }
        if (lineStart >= codeUntil) {
            const tag = rules.start(line);
            if (tag !== undefined) {
                const block = scanBlock(markdown, lineStart + line.indexOf("<"), tag);
                pushMarkdown(markdown.slice(markdownStart, lineStart));
                const html = markdown.slice(lineStart, block.end);
                if (!block.complete) {
                    segments.push({ type: "block", html, complete: false });
                    return segments;
                }
                if (rules.keep(block)) segments.push({ type: "block", html, complete: true });
                else pushMarkdown(html);
                markdownStart = block.end;
                lineStart = block.end;
                continue;
            }
            if (newline === -1 && isPartialStart(line, rules)) {
                pushMarkdown(markdown.slice(markdownStart, lineStart));
                segments.push({ type: "block", html: line, complete: false });
                return segments;
            }
        }
        codeUntil = spans.skip(Math.max(lineStart, codeUntil), lineEnd, codeUntil);
        lineStart = lineEnd;
    }
    pushMarkdown(markdown.slice(markdownStart));
    return segments;
}

/**
 * The text of `segments` without their complete blocks, closing up the blank lines around each
 * removed block to one. An incomplete block stays as written.
 */
export function stripHtmlBlocks(segments: readonly HtmlBlockSegment[]): string {
    const parts: string[] = [];
    let removed = false;
    for (const segment of segments) {
        if (segment.type === "block" && segment.complete) {
            removed = true;
            continue;
        }
        let part = segment.type === "markdown" ? segment.text : segment.html;
        if (removed) {
            part = part.slice(leadingBlankLinesLength(part));
            if (part === "") continue;
            if (parts.length > 0) {
                const last = parts.length - 1;
                const before = parts[last]!;
                parts[last] =
                    `${before.slice(0, before.length - trailingBlankLinesLength(before))}\n\n`;
            }
            removed = false;
        }
        parts.push(part);
    }
    const text = parts.join("");
    return removed ? text.trimEnd() : text;
}

/** How many leading characters of `text` are whole blank lines. */
function leadingBlankLinesLength(text: string): number {
    let length = 0;
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === "\n") length = index + 1;
        else if (character !== " " && character !== "\t" && character !== "\r") break;
        index += 1;
    }
    return length;
}

/** How many trailing characters of `text` are line breaks with the spaces after them. */
function trailingBlankLinesLength(text: string): number {
    let length = 0;
    let index = text.length - 1;
    while (index >= 0) {
        const character = text[index];
        if (character === "\n") length = text.length - index;
        else if (character !== " " && character !== "\t" && character !== "\r") break;
        index -= 1;
    }
    return length;
}

/** Whether a final line without its newline could still become a block start. */
function isPartialStart(line: string, rules: HtmlBlockRules): boolean {
    const name = PARTIAL_START.exec(line)?.[1];
    return name !== undefined && rules.partial(name);
}

/**
 * Where the block whose root `tag` opens at `start` ends: after the line its root element closes
 * on. Comments and quoted attribute values are skipped. Incomplete when the root never closes, or
 * a tag or comment is cut off.
 */
function scanBlock(
    markdown: string,
    start: number,
    tag: string,
): { end: number; complete: boolean; image: boolean } {
    const incomplete = { end: markdown.length, complete: false, image: false };
    let depth = 0;
    let image = false;
    let index = start;
    while (index < markdown.length) {
        if (markdown[index] !== "<") {
            index += 1;
            continue;
        }
        if (markdown.startsWith("<!--", index)) {
            const close = markdown.indexOf("-->", index + 4);
            if (close === -1) return incomplete;
            index = close + 3;
            continue;
        }
        const closing = markdown[index + 1] === "/";
        TAG_NAME.lastIndex = index + (closing ? 2 : 1);
        const name = TAG_NAME.exec(markdown)?.[0].toLowerCase();
        if (name === undefined) {
            index += 1;
            continue;
        }
        const tagEnd = closing
            ? markdown.indexOf(">", TAG_NAME.lastIndex)
            : openTagEnd(markdown, TAG_NAME.lastIndex);
        if (tagEnd === -1) return incomplete;
        index = tagEnd + 1;
        if (!closing && name === "img") image = true;
        if (name !== tag) continue;
        if (closing) depth -= 1;
        else if (tag !== "img") depth += 1;
        if (depth > 0) continue;
        const newline = markdown.indexOf("\n", index);
        return { end: newline === -1 ? markdown.length : newline + 1, complete: true, image };
    }
    return incomplete;
}

/** The index of the `>` ending an open tag whose attributes start at `index`, or -1. */
function openTagEnd(markdown: string, index: number): number {
    let position = index;
    let afterEquals = false;
    while (position < markdown.length) {
        const character = markdown[position];
        if (character === ">") return position;
        if ((character === '"' || character === "'") && afterEquals) {
            const close = markdown.indexOf(character, position + 1);
            if (close === -1) return -1;
            position = close + 1;
            afterEquals = false;
            continue;
        }
        if (character === "=") afterEquals = true;
        else if (!/\s/u.test(character ?? "")) afterEquals = false;
        position += 1;
    }
    return -1;
}

/**
 * The code spans of one text, found in a single pass however they are asked for. Callers ask in
 * increasing order of position, so each lookup resumes where the last stopped: finding a span's
 * closing run and its paragraph's end costs time in proportion to the text, not to the text for
 * every span.
 */
class CodeSpans {
    readonly #markdown: string;
    /** The maximal backtick runs by length, each list in increasing order; built on first use. */
    #runs: Map<number, number[]> | undefined;
    /** Per run length, how many of its runs lie before every position asked about so far. */
    readonly #passed = new Map<number, number>();
    #paragraph: { readonly from: number; readonly end: number } | undefined;

    constructor(markdown: string) {
        this.#markdown = markdown;
    }

    /**
     * Skips the code spans that open in `[from, lineEnd)`, returning where the last one ends, or
     * `codeUntil` when none opens. A span is bounded by its paragraph, which a blank line or a
     * fence ends. Backticks without a closing run of the same length are literal.
     */
    skip(from: number, lineEnd: number, codeUntil: number): number {
        const markdown = this.#markdown;
        let until = codeUntil;
        let index = from;
        while (index < lineEnd) {
            const next = markdown.indexOf("`", index);
            if (next === -1 || next >= lineEnd) break;
            if (isEscaped(markdown, index, next)) {
                index = next + 1;
                continue;
            }
            let length = 1;
            while (markdown[next + length] === "`") length += 1;
            const close = this.#closing(next + length, length, this.#paragraphEnd(lineEnd));
            index = close === undefined ? next + length : close + length;
            if (close !== undefined) until = index;
        }
        return until;
    }

    /** The first maximal run of exactly `length` backticks at or after `from`, before `end`. */
    #closing(from: number, length: number, end: number): number | undefined {
        this.#runs ??= backtickRuns(this.#markdown);
        const runs = this.#runs.get(length);
        if (runs === undefined) return undefined;
        let passed = this.#passed.get(length) ?? 0;
        while (passed < runs.length && runs[passed]! < from) passed += 1;
        this.#passed.set(length, passed);
        const run = runs[passed];
        return run !== undefined && run < end ? run : undefined;
    }

    /** Where the paragraph holding the line at `from` ends: its next blank or fence line. */
    #paragraphEnd(from: number): number {
        const known = this.#paragraph;
        if (known !== undefined && known.from <= from && from <= known.end) return known.end;
        const markdown = this.#markdown;
        let lineStart = from;
        let end = markdown.length;
        while (lineStart < markdown.length) {
            const newline = markdown.indexOf("\n", lineStart);
            const line = markdown.slice(lineStart, newline === -1 ? markdown.length : newline);
            if (BLANK_LINE.test(line) || fenceOpening(line) !== undefined) {
                end = lineStart;
                break;
            }
            if (newline === -1) break;
            lineStart = newline + 1;
        }
        this.#paragraph = { from, end };
        return end;
    }
}

/**
 * Whether the backtick at `at` is escaped by an odd run of backslashes that starts at or after
 * `from`, where the caller's scan stands; a backslash escapes the character after it.
 */
function isEscaped(markdown: string, from: number, at: number): boolean {
    let backslashes = 0;
    while (at - backslashes - 1 >= from && markdown[at - backslashes - 1] === "\\") {
        backslashes += 1;
    }
    return backslashes % 2 === 1;
}

function backtickRuns(markdown: string): Map<number, number[]> {
    const runs = new Map<number, number[]>();
    let index = markdown.indexOf("`");
    while (index !== -1) {
        let length = 1;
        while (markdown[index + length] === "`") length += 1;
        const list = runs.get(length);
        if (list === undefined) runs.set(length, [index]);
        else list.push(index);
        index = markdown.indexOf("`", index + length);
    }
    return runs;
}
