/**
 * Media layout blocks: plain HTML an agent writes in its Markdown reply to arrange media it
 * already showed in the conversation, such as
 * `<div style="display: grid; grid-template-columns: 1fr 1fr"><img src="a.png"><img src="b.png"></div>`.
 * This finds the blocks; `parseMediaLayoutHtml` reads each one, and a client resolves every
 * `<img src>` to an earlier media item with `mediaSourceMatches`. Nothing is ever loaded from
 * `src`.
 *
 * A block starts at the start of a line, indented at most three spaces, with `<div`, `<section`,
 * `<figure`, `<p`, or `<img`, outside fenced code and outside a code span. It runs until its root
 * element closes, counting only that tag, so blank lines inside it never end it, and then takes
 * the rest of the line it closes on. A block holding no `<img>` is ordinary Markdown.
 */

import { fenceOpening, isFenceClose, skipCodeSpan, type MarkdownFence } from "./markdownBlocks.js";
import type { MediaItemSource } from "./protocol/messages.js";

/**
 * Markdown split around its layout blocks; the segments' text joined in order is the input.
 * A `layout` segment that is not `complete` is always the last: its root element never closed,
 * either because the text is still streaming or because the agent never closed it.
 */
export type MediaLayoutBlockSegment =
    | { type: "markdown"; text: string }
    | { type: "layout"; html: string; complete: boolean };

const BLOCK_TAGS = ["div", "section", "figure", "p", "img"] as const;
const BLOCK_START = /^ {0,3}<(div|section|figure|p|img)(?=[\t\n\f\r />]|$)/iu;
const PARTIAL_START = /^ {0,3}<([a-z]*)$/iu;
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
                if (block.image) segments.push({ type: "layout", html, complete: true });
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
        codeUntil = skipCodeSpans(markdown, Math.max(lineStart, codeUntil), lineEnd, codeUntil);
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
    let text = "";
    let removed = false;
    for (const segment of splitMediaLayoutBlocks(markdown)) {
        if (segment.type === "layout" && segment.complete) {
            removed = true;
            continue;
        }
        let part = segment.type === "markdown" ? segment.text : segment.html;
        if (removed) {
            part = part.replace(/^(?:[ \t]*\r?\n)+/u, "");
            if (part === "") continue;
            text = text === "" ? "" : `${text.replace(/(?:\r?\n[ \t]*)+$/u, "")}\n\n`;
            removed = false;
        }
        text += part;
    }
    return removed ? text.replace(/\s+$/u, "") : text;
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
 * Skips the code spans that open in `[from, lineEnd)`, returning where the last one ends, or
 * `codeUntil` when none opens. A span is bounded by its paragraph, which a blank line or a fence
 * ends.
 */
function skipCodeSpans(markdown: string, from: number, lineEnd: number, codeUntil: number): number {
    let until = codeUntil;
    let index = from;
    let end: number | undefined;
    while (index < lineEnd) {
        const character = markdown[index];
        if (character === "\\") {
            index += 2;
        } else if (character === "`") {
            end ??= paragraphEnd(markdown, lineEnd);
            index = skipCodeSpan(markdown, index, end, false);
            until = index;
        } else {
            index += 1;
        }
    }
    return until;
}

function paragraphEnd(markdown: string, from: number): number {
    let lineStart = from;
    while (lineStart < markdown.length) {
        const newline = markdown.indexOf("\n", lineStart);
        const line = markdown.slice(lineStart, newline === -1 ? markdown.length : newline);
        if (BLANK_LINE.test(line) || fenceOpening(line) !== undefined) return lineStart;
        if (newline === -1) return markdown.length;
        lineStart = newline + 1;
    }
    return markdown.length;
}
