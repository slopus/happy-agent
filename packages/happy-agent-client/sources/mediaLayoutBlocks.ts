/**
 * Media layout blocks: plain HTML an agent writes in its Markdown reply to arrange media it
 * already showed in the conversation, such as
 * `<div style="display: grid; grid-template-columns: 1fr 1fr"><img src="a.png"><img src="b.png"></div>`.
 * This finds the blocks; `parseMediaLayoutHtml` reads each one, and a client resolves every
 * `<img src>` to an earlier media item with `mediaSourceMatches`. Nothing is ever loaded from
 * `src`.
 *
 * A block starts at the start of a line, indented at most three spaces, with `<div`, `<section`,
 * `<figure`, `<p`, `<img`, or a widget tag — `<happy-chart`, `<happy-diagram`, `<happy-code`, or
 * `<happy-files` — outside fenced code and outside a code span. It runs until its root element
 * closes, counting only that tag, so blank lines inside it never end it, and then takes the rest
 * of the line it closes on. A block holding no `<img>` and no widget tag is ordinary Markdown.
 */

import { fenceOpening, isFenceClose, type MarkdownFence } from "./markdownBlocks.js";
import type { MediaItemSource } from "./protocol/messages.js";

/**
 * Markdown split around its layout blocks; the segments' text joined in order is the input.
 * A `layout` segment that is not `complete` is always the last: its root element never closed,
 * either because the text is still streaming or because the agent never closed it.
 */
export type MediaLayoutBlockSegment =
    | { type: "markdown"; text: string }
    | { type: "layout"; html: string; complete: boolean };

const WIDGET_TAGS = ["happy-chart", "happy-diagram", "happy-code", "happy-files"] as const;
const BLOCK_TAGS = ["div", "section", "figure", "p", "img", ...WIDGET_TAGS] as const;
const BLOCK_START =
    /^ {0,3}<(div|section|figure|p|img|happy-chart|happy-diagram|happy-code|happy-files)(?=[\t\n\f\r />]|$)/iu;
const PARTIAL_START = /^ {0,3}<([a-z][a-z-]*|)$/iu;
const BLANK_LINE = /^[ \t\r]*$/u;
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/uy;

/** Splits Markdown into Markdown and the layout blocks in it. Empty Markdown is omitted. */
export function splitMediaLayoutBlocks(markdown: string): MediaLayoutBlockSegment[] {
    const segments: MediaLayoutBlockSegment[] = [];
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
            const start = BLOCK_START.exec(line);
            if (start !== null) {
                const tag = (start[1] ?? "").toLowerCase();
                const block = scanBlock(
                    markdown,
                    lineStart + start[0].length - tag.length - 1,
                    tag,
                );
                pushMarkdown(markdown.slice(markdownStart, lineStart));
                const html = markdown.slice(lineStart, block.end);
                if (!block.complete) {
                    segments.push({ type: "layout", html, complete: false });
                    return segments;
                }
                if (block.resolving) segments.push({ type: "layout", html, complete: true });
                else pushMarkdown(html);
                markdownStart = block.end;
                lineStart = block.end;
                continue;
            }
            if (newline === -1 && isPartialStart(line)) {
                pushMarkdown(markdown.slice(markdownStart, lineStart));
                segments.push({ type: "layout", html: line, complete: false });
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
 * Markdown without its complete layout blocks, for a surface that cannot show them, such as a
 * chat service the reply is relayed to. The blank lines around a removed block close up to one.
 * An incomplete block is broken HTML rather than a layout, so it stays as written.
 */
export function stripMediaLayoutBlocks(markdown: string): string {
    const parts: string[] = [];
    let removed = false;
    for (const segment of splitMediaLayoutBlocks(markdown)) {
        if (segment.type === "layout" && segment.complete) {
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

/**
 * Whether an `<img src>` in a layout block names the media item with this source: `src` equals
 * the path the agent wrote or its absolute path, exactly. An item without a source never matches.
 */
export function mediaSourceMatches(source: MediaItemSource | undefined, src: string): boolean {
    return source !== undefined && (src === source.path || src === source.absolutePath);
}

/** Whether a final line without its newline could still become a block start. */
function isPartialStart(line: string): boolean {
    const name = PARTIAL_START.exec(line)?.[1]?.toLowerCase();
    return name !== undefined && BLOCK_TAGS.some((tag) => tag.startsWith(name));
}

/**
 * Where the block whose root `tag` opens at `start` ends: after the line its root element closes
 * on. Comments and quoted attribute values are skipped. Incomplete when the root never closes, or
 * a tag or comment is cut off. `resolving` says whether the block holds an `<img>` or a widget
 * tag; one that holds neither is ordinary Markdown.
 */
function scanBlock(
    markdown: string,
    start: number,
    tag: string,
): { end: number; complete: boolean; resolving: boolean } {
    const incomplete = { end: markdown.length, complete: false, resolving: false };
    let depth = 0;
    let resolving = false;
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
        if (!closing && (name === "img" || (WIDGET_TAGS as readonly string[]).includes(name)))
            resolving = true;
        if (name !== tag) continue;
        if (closing) depth -= 1;
        else if (tag !== "img") depth += 1;
        if (depth > 0) continue;
        const newline = markdown.indexOf("\n", index);
        return { end: newline === -1 ? markdown.length : newline + 1, complete: true, resolving };
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
