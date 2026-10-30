/**
 * CommonMark inline links, `[label](destination "title")`, read from Markdown source so Happy links
 * can be found or replaced before a Markdown parser sees the text.
 */

import { skipCodeSpan } from "./markdownBlocks.js";

const ASCII_PUNCTUATION_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** An inline link found in Markdown source. */
export interface MarkdownInlineLink {
    /** The Markdown written between the brackets. */
    label: string;
    /** The destination with its backslash escapes removed. */
    url: string;
    /** The index after the closing parenthesis. */
    end: number;
}

/**
 * Matches a CommonMark inline link whose `[` is at `open`: a label with balanced brackets, then
 * `(`, a destination, an optional title, and `)`.
 */
export function matchInlineLink(
    markdown: string,
    open: number,
    end: number,
): MarkdownInlineLink | undefined {
    const close = labelEnd(markdown, open, end);
    if (close === undefined || markdown[close + 1] !== "(") return undefined;
    let index = skipWhitespace(markdown, close + 2, end);
    const destination = readDestination(markdown, index, end);
    if (destination === undefined) return undefined;
    index = destination.end;
    const beforeTitle = index;
    index = skipWhitespace(markdown, index, end);
    if (index > beforeTitle) {
        const title = titleEnd(markdown, index, end);
        if (title !== undefined) index = skipWhitespace(markdown, title, end);
    }
    if (markdown[index] !== ")" || index >= end) return undefined;
    return {
        label: markdown.slice(open + 1, close),
        url: destination.url.replace(ASCII_PUNCTUATION_ESCAPE, "$1"),
        end: index + 1,
    };
}

/**
 * The destination written so far when `markdown` ends inside an unfinished inline link whose `[` is
 * at `open`: the label is closed and the text stops before the link's closing `)`. An empty string
 * means the link has reached `[label]` or `[label](` with no destination yet.
 */
export function unfinishedInlineLinkDestination(
    markdown: string,
    open: number,
): string | undefined {
    const close = labelEnd(markdown, open, markdown.length);
    if (close === undefined) return undefined;
    if (close + 1 === markdown.length) return "";
    if (markdown[close + 1] !== "(") return undefined;
    const start = skipWhitespace(markdown, close + 2, markdown.length);
    const angled = markdown[start] === "<";
    const destination = markdown.slice(angled ? start + 1 : start);
    const stop = angled ? destination.search(/[<>\r\n]/) : destination.search(/[\s)]/);
    if (stop === -1) return destination;
    if (angled && destination[stop] !== ">") return undefined;
    // The destination ended; only whitespace and a title may follow before the closing `)`.
    const rest = destination.slice(angled ? stop + 1 : stop);
    return UNFINISHED_TITLE.test(rest) ? destination.slice(0, stop) : undefined;
}

const UNFINISHED_TITLE = /^\s*(?:"[^"]*"?|'[^']*'?|\([^()]*\)?)?\s*$/;

/** The index of the `]` that closes the label opened at `open`. */
function labelEnd(markdown: string, open: number, end: number): number | undefined {
    let depth = 0;
    let index = open + 1;
    while (index < end) {
        const character = markdown[index];
        if (character === "\\") {
            index += 2;
        } else if (character === "`") {
            index = skipCodeSpan(markdown, index, end, false);
        } else if (character === "[") {
            depth += 1;
            index += 1;
        } else if (character === "]") {
            if (depth === 0) return index;
            depth -= 1;
            index += 1;
        } else {
            index += 1;
        }
    }
    return undefined;
}

function readDestination(
    markdown: string,
    start: number,
    end: number,
): { url: string; end: number } | undefined {
    if (markdown[start] === "<") {
        let index = start + 1;
        while (index < end) {
            const character = markdown[index];
            if (character === "\\") index += 2;
            else if (character === ">")
                return { url: markdown.slice(start + 1, index), end: index + 1 };
            else if (character === "<" || character === "\n" || character === "\r")
                return undefined;
            else index += 1;
        }
        return undefined;
    }
    let depth = 0;
    let index = start;
    while (index < end) {
        const character = markdown[index] ?? "";
        if (character === "\\") {
            index += 2;
            continue;
        }
        if (character <= " " || character === "\u007f") break;
        if (character === "(") depth += 1;
        if (character === ")") {
            if (depth === 0) break;
            depth -= 1;
        }
        index += 1;
    }
    if (index === start || depth !== 0) return undefined;
    return { url: markdown.slice(start, Math.min(index, end)), end: Math.min(index, end) };
}

/** The index after a link title quoted with `"`, `'`, or parentheses. */
function titleEnd(markdown: string, start: number, end: number): number | undefined {
    const opening = markdown[start];
    const closing =
        opening === "(" ? ")" : opening === '"' || opening === "'" ? opening : undefined;
    if (closing === undefined) return undefined;
    let index = start + 1;
    while (index < end) {
        const character = markdown[index];
        if (character === "\\") index += 2;
        else if (character === closing) return index + 1;
        else if (opening === "(" && character === "(") return undefined;
        else index += 1;
    }
    return undefined;
}

function skipWhitespace(markdown: string, start: number, end: number): number {
    let index = start;
    while (index < end && /[ \t\r\n]/.test(markdown[index] ?? "")) index += 1;
    return index;
}
