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

import { splitHtmlBlocks, stripHtmlBlocks } from "./htmlBlocks.js";
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

/** Splits Markdown into Markdown and the layout blocks in it. Empty Markdown is omitted. */
export function splitMediaLayoutBlocks(markdown: string): MediaLayoutBlockSegment[] {
    return splitHtmlBlocks(markdown, {
        start: (line) => BLOCK_START.exec(line)?.[1]?.toLowerCase(),
        partial: (name) => BLOCK_TAGS.some((tag) => tag.startsWith(name.toLowerCase())),
        keep: (block) => block.image,
    }).map((segment) =>
        segment.type === "markdown"
            ? segment
            : { type: "layout", html: segment.html, complete: segment.complete },
    );
}

/**
 * Markdown without its complete layout blocks, for a surface that cannot show them, such as a
 * chat service the reply is relayed to. The blank lines around a removed block close up to one.
 * An incomplete block is broken HTML rather than a layout, so it stays as written.
 */
export function stripMediaLayoutBlocks(markdown: string): string {
    return stripHtmlBlocks(
        splitMediaLayoutBlocks(markdown).map((segment) =>
            segment.type === "markdown"
                ? segment
                : { type: "block", html: segment.html, complete: segment.complete },
        ),
    );
}

/**
 * Whether an `<img src>` in a layout block names the media item with this source: `src` equals
 * the path the agent wrote or its absolute path, exactly. An item without a source never matches.
 */
export function mediaSourceMatches(source: MediaItemSource | undefined, src: string): boolean {
    return source !== undefined && (src === source.path || src === source.absolutePath);
}
