/**
 * Finds Happy links in Markdown source: inline links and images whose destination uses the `happy`
 * or `happy-file` scheme, plus the legacy `<happy-KIND id="…"/>` reference tags stored history still
 * holds. Links in code spans, fenced code, or behind a backslash stay literal, as Markdown reads
 * them.
 */

import {
    escapeMarkdownText,
    formatHappyUrl,
    type HappyLink,
    type HappyReference,
    happyReferencePlaceholder,
    isHappyUrl,
    MAX_HAPPY_URL_LENGTH,
    parseHappyUrl,
} from "./happyLinks.js";
import {
    isLegacyHappyReferenceTagPrefix,
    matchLegacyHappyReferenceTag,
} from "./legacyHappyReferenceTags.js";
import { skipCodeSpan, textBlocks } from "./markdownBlocks.js";
import { matchInlineLink, unfinishedInlineLinkDestination } from "./markdownInlineLinks.js";

/** One Happy link found in Markdown. */
export interface HappyLinkMatch {
    /** What the link names, or undefined when it is malformed or names an unknown kind. */
    link: HappyLink | undefined;
    /** The Markdown between the brackets, or an image's alt text. Empty for a legacy tag. */
    label: string;
    /** Whether this is an image, `![alt](happy://…)`. */
    image: boolean;
    /** The link exactly as written. */
    source: string;
    /**
     * `link` for a Markdown link to a `happy://` or `happy-file://` URL; `legacyTag` for a legacy
     * `<happy-KIND id="…"/>` reference tag.
     */
    syntax: "link" | "legacyTag";
}

/** Markdown split around its Happy links. Adjacent text is merged and empty text omitted. */
export type HappyLinkSegment = { type: "text"; text: string } | ({ type: "link" } & HappyLinkMatch);

export interface HappyLinkParseOptions {
    /**
     * The text is still streaming: a trailing incomplete Happy link, such as
     * `[Q3 report](happy://arti` or a legacy tag's `<happy-arti`, is dropped until it completes.
     */
    streaming?: boolean;
}

/** The longest unfinished trailing link a streaming client hides, so it never hides unbounded text. */
const MAX_PARTIAL_LINK_LENGTH = MAX_HAPPY_URL_LENGTH + 1024;

/** Splits Markdown into text and Happy links. */
export function parseHappyLinks(
    markdown: string,
    options: HappyLinkParseOptions = {},
): HappyLinkSegment[] {
    const { matches, end } = scan(markdown, options.streaming === true);
    const segments: HappyLinkSegment[] = [];
    let position = 0;
    for (const { start, match } of matches) {
        if (start > position)
            segments.push({ type: "text", text: markdown.slice(position, start) });
        segments.push({ type: "link", ...match });
        position = start + match.source.length;
    }
    if (end > position) segments.push({ type: "text", text: markdown.slice(position, end) });
    return segments;
}

/** Replaces every Happy link outside code with `replace`'s Markdown. */
export function replaceHappyLinks(
    markdown: string,
    replace: (match: HappyLinkMatch) => string,
    options: HappyLinkParseOptions = {},
): string {
    return parseHappyLinks(markdown, options)
        .map((segment) => (segment.type === "text" ? segment.text : replace(segment)))
        .join("");
}

/** How many trailing characters of streaming Markdown are an incomplete Happy link to hide, or 0. */
export function happyLinkPartialLength(markdown: string): number {
    return markdown.length - scan(markdown, true).end;
}

/**
 * Plain Markdown for surfaces that cannot open Happy links. An entity link becomes the name
 * `resolve` returns, escaped as literal text, else its label as written, else a placeholder such
 * as "an unavailable artifact". A file link becomes its label, or its decoded path when the label
 * is blank. A malformed link becomes its label.
 */
export function renderHappyLinksAsText(
    markdown: string,
    resolve?: (reference: HappyReference) => string | undefined,
    options: HappyLinkParseOptions = {},
): string {
    return replaceHappyLinks(
        markdown,
        ({ link, label, syntax }) => {
            if (link?.type === "reference") {
                const name = resolve?.(link.reference);
                if (name !== undefined) return escapeMarkdownText(name);
                return label.trim() === "" ? happyReferencePlaceholder(link.reference) : label;
            }
            if (label.trim() !== "") return label;
            if (link?.type === "file") return escapeMarkdownText(link.file.path);
            return syntax === "legacyTag" ? "an unavailable reference" : "";
        },
        options,
    );
}

/**
 * Rewrites legacy reference tags into canonical `happy://` links, so a renderer that handles Happy
 * links in its Markdown link component also shows old history. A tag becomes an empty-label link,
 * `[](happy://…)`, or a placeholder when no `happy://` URL can express it. Links are left exactly as
 * written.
 */
export function rewriteLegacyHappyReferenceTags(
    markdown: string,
    options: HappyLinkParseOptions = {},
): string {
    return replaceHappyLinks(
        markdown,
        ({ link, source, syntax }) => {
            if (syntax === "link") return source;
            const url = link === undefined ? undefined : tryFormat(link);
            if (url !== undefined) return `[](${url})`;
            return link?.type === "reference"
                ? happyReferencePlaceholder(link.reference)
                : "an unavailable reference";
        },
        options,
    );
}

function tryFormat(link: HappyLink): string | undefined {
    try {
        return formatHappyUrl(link);
    } catch {
        // A legacy service tag without a workspace has no `happy://` URL.
        return undefined;
    }
}

/** The complete links outside code, and where the text ends once a streaming partial is dropped. */
function scan(
    markdown: string,
    streaming: boolean,
): { matches: { start: number; match: HappyLinkMatch }[]; end: number } {
    const matches: { start: number; match: HappyLinkMatch }[] = [];
    if (!streaming && !/happy/i.test(markdown)) return { matches, end: markdown.length };
    for (const block of textBlocks(markdown)) {
        const last = block.end === markdown.length;
        let index = block.start;
        while (index < block.end) {
            const character = markdown[index];
            if (character === "\\") {
                index += 2;
            } else if (character === "`") {
                index = skipCodeSpan(markdown, index, block.end, streaming && last);
            } else if (character === "<") {
                const tag = matchLegacyHappyReferenceTag(markdown, index);
                if (tag !== undefined) {
                    matches.push({
                        start: index,
                        match: {
                            link:
                                tag.reference === undefined
                                    ? undefined
                                    : { type: "reference", reference: tag.reference },
                            label: "",
                            image: false,
                            source: markdown.slice(index, tag.end),
                            syntax: "legacyTag",
                        },
                    });
                    index = tag.end;
                } else if (
                    streaming &&
                    last &&
                    isLegacyHappyReferenceTagPrefix(markdown.slice(index))
                ) {
                    return { matches, end: index };
                } else {
                    index += 1;
                }
            } else if (character === "[" || (character === "!" && markdown[index + 1] === "[")) {
                const image = character === "!";
                const open = image ? index + 1 : index;
                const found = matchInlineLink(markdown, open, block.end);
                if (found !== undefined && isHappyUrl(found.url)) {
                    matches.push({
                        start: index,
                        match: {
                            link: parseHappyUrl(found.url),
                            label: found.label,
                            image,
                            source: markdown.slice(index, found.end),
                            syntax: "link",
                        },
                    });
                    index = found.end;
                } else if (
                    found === undefined &&
                    streaming &&
                    last &&
                    isUnfinishedHappyLink(markdown, index, open)
                ) {
                    return { matches, end: index };
                } else {
                    index += image ? 2 : 1;
                }
            } else {
                index += 1;
            }
        }
    }
    return { matches, end: markdown.length };
}

/** Whether the text from `start` to the end is an inline link that could still become a Happy one. */
function isUnfinishedHappyLink(markdown: string, start: number, open: number): boolean {
    if (markdown.length - start > MAX_PARTIAL_LINK_LENGTH) return false;
    const destination = unfinishedInlineLinkDestination(markdown, open);
    if (destination === undefined) return false;
    return isSchemePrefix(destination.toLowerCase());
}

/** Whether a lowercased destination is, or could still grow into, a `happy:` or `happy-file:` URL. */
function isSchemePrefix(destination: string): boolean {
    return ["happy:", "happy-file:"].some((scheme) =>
        destination.length <= scheme.length
            ? scheme.startsWith(destination)
            : destination.startsWith(scheme),
    );
}
