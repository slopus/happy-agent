/**
 * Media layout HTML: the small subset of HTML and CSS an agent writes to arrange media it showed,
 * either as `present_files`' `layout` argument or as a block in its Markdown reply. This one
 * parser turns it into the typed tree clients render, so the daemon and every client agree on
 * exactly what a layout means. No HTML ever reaches a renderer.
 */

import { html as htmlSpec, parse, type DefaultTreeAdapterTypes } from "parse5";

import { parseMediaLayoutHtmlStyle } from "./mediaLayoutHtmlStyle.js";
import type { MediaLayoutStyle } from "./protocol/mediaLayoutStyle.js";
import type { MediaLayoutNode, MediaLayoutTag } from "./protocol/messages.js";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** The most layout HTML that is read, in UTF-16 code units; a longer layout is not used. */
export const MAX_MEDIA_LAYOUT_HTML_LENGTH = 32 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 500;
const MAX_TEXT = 8000;
const MAX_ALT = 1000;

const ELEMENT_TAGS: Readonly<Record<string, MediaLayoutTag>> = {
    div: "div",
    section: "section",
    figure: "figure",
    figcaption: "figcaption",
    p: "p",
    span: "span",
    strong: "strong",
    em: "em",
    code: "code",
};
const BLOCK_TAGS: ReadonlySet<string> = new Set(["div", "section", "figure", "figcaption", "p"]);

/**
 * Tags left out together with everything inside them: they run code, load or embed something,
 * take input, or hold styling and metadata rather than content.
 */
const DROPPED_TAGS: ReadonlySet<string> = new Set([
    "applet",
    "area",
    "audio",
    "base",
    "button",
    "canvas",
    "dialog",
    "embed",
    "form",
    "frame",
    "frameset",
    "head",
    "iframe",
    "input",
    "link",
    "map",
    "math",
    "meta",
    "noscript",
    "object",
    "option",
    "portal",
    "script",
    "select",
    "slot",
    "source",
    "style",
    "svg",
    "template",
    "textarea",
    "title",
    "track",
    "video",
]);

/**
 * Names the media an `<img src>` refers to as an index into the caller's own list of items, or
 * `undefined` when it names nothing. The parser never loads `src` itself.
 */
export type MediaLayoutSourceResolver = (src: string) => number | undefined;

/** What layout HTML became. */
export interface ParsedMediaLayoutHtml {
    /** The typed tree; each item node's `index` is what the resolver returned for its `src`. */
    readonly root: MediaLayoutNode[];
    /** The indexes the tree places, in order, each once. */
    readonly placed: readonly number[];
    /** Short descriptions of what was left out, such as `position on <div>`, for the agent. */
    readonly ignored: readonly string[];
    /**
     * Whether content was lost to a limit: the whole HTML was too long, or nodes or text beyond
     * the tree's bounds were dropped. Unsupported markup left out on purpose does not count.
     */
    readonly truncated: boolean;
}

interface LayoutWalk {
    readonly resolve: MediaLayoutSourceResolver;
    readonly placed: number[];
    readonly ignored: string[];
    nodes: number;
    text: number;
    truncated: boolean;
}

/**
 * Turn media layout HTML into the typed tree a client renders.
 *
 * The HTML is parsed by parse5, a spec-compliant parser, so tags, attributes, and entities mean
 * what a browser would take them to mean, and malformed markup is repaired the way a browser
 * repairs it. The tree is then rebuilt from what the subset allows, and nothing fails: a tag the
 * subset lacks is unwrapped and its content kept, a tag that runs, loads, or embeds something is
 * left out with its content, other attributes and declarations are left out, and an image whose
 * `src` the resolver does not know, or whose item is already placed, is left out. Everything left
 * out is reported. Deciding what a layout that places nothing means is the caller's.
 */
export function parseMediaLayoutHtml(
    source: string,
    resolve: MediaLayoutSourceResolver,
): ParsedMediaLayoutHtml {
    if (source.length > MAX_MEDIA_LAYOUT_HTML_LENGTH) {
        return {
            root: [],
            placed: [],
            ignored: [
                `the whole layout, which is longer than ${String(MAX_MEDIA_LAYOUT_HTML_LENGTH)} characters`,
            ],
            truncated: true,
        };
    }
    const document = parse(source);
    const walk: LayoutWalk = {
        resolve,
        placed: [],
        ignored: [],
        nodes: 0,
        text: 0,
        truncated: false,
    };
    for (const node of document.childNodes) {
        if (node.nodeName === "#comment") note(walk, "comments");
    }
    const html = document.childNodes.find(
        (node): node is Element => "tagName" in node && node.tagName === "html",
    );
    const body = html?.childNodes.find(
        (node): node is Element => "tagName" in node && node.tagName === "body",
    );
    for (const part of html?.childNodes ?? []) {
        if (part.nodeName === "#comment") note(walk, "comments");
        if ("tagName" in part && part.tagName === "head") {
            for (const child of part.childNodes) {
                if ("tagName" in child) note(walk, `<${child.tagName}> and its contents`);
            }
        }
    }
    const root = body === undefined ? [] : children(body.childNodes, false, 0, walk);
    return { root, placed: walk.placed, ignored: walk.ignored, truncated: walk.truncated };
}

function children(
    nodes: readonly ChildNode[],
    ignoresWhitespace: boolean,
    depth: number,
    walk: LayoutWalk,
): MediaLayoutNode[] {
    const converted: MediaLayoutNode[] = [];
    for (const node of nodes) convert(node, depth, walk, converted);
    return tidyWhitespace(converted, ignoresWhitespace);
}

function convert(node: ChildNode, depth: number, walk: LayoutWalk, into: MediaLayoutNode[]): void {
    if (node.nodeName === "#text" && "value" in node) {
        const text = node.value.replaceAll(/[\t\n\f\r ]+/gu, " ");
        const room = MAX_TEXT - walk.text;
        if (room <= 0 || !count(walk)) {
            truncate(walk, `text beyond ${String(MAX_TEXT)} characters`);
            return;
        }
        if (text.length > room) truncate(walk, `text beyond ${String(MAX_TEXT)} characters`);
        const kept = text.slice(0, room);
        walk.text += kept.length;
        into.push({ type: "text", text: kept });
        return;
    }
    if (node.nodeName === "#comment") {
        note(walk, "comments");
        return;
    }
    if (!("tagName" in node)) return;
    const element = node;
    const tag = element.tagName;
    if (element.namespaceURI !== htmlSpec.NS.HTML || DROPPED_TAGS.has(tag)) {
        note(walk, `<${tag}> and its contents`);
        return;
    }
    if (tag === "img") {
        const item = imageItem(element, walk);
        if (item !== undefined) into.push(item);
        return;
    }
    if (tag === "br") {
        attributes(element, [], walk);
        if (count(walk)) into.push({ type: "break" });
        return;
    }
    const elementTag = ELEMENT_TAGS[tag];
    if (elementTag === undefined || depth >= MAX_DEPTH) {
        if (elementTag === undefined) {
            if (tag !== "html" && tag !== "body") note(walk, `<${tag}> (its content is kept)`);
        } else {
            note(
                walk,
                `elements nested more than ${String(MAX_DEPTH)} deep (their content is kept)`,
            );
        }
        for (const child of element.childNodes) convert(child, depth, walk, into);
        return;
    }
    if (!count(walk)) return;
    const style = elementStyle(element, [], walk);
    const display = style?.display ?? "";
    const flowIgnoresWhitespace = /flex|grid/u.test(display);
    into.push({
        type: "element",
        tag: elementTag,
        ...(style === undefined ? {} : { style }),
        children: children(element.childNodes, flowIgnoresWhitespace, depth + 1, walk),
    });
}

function imageItem(element: Element, walk: LayoutWalk): MediaLayoutNode | undefined {
    const src = element.attrs.find((attribute) => attribute.name === "src")?.value;
    if (src === undefined) {
        note(walk, "<img> without src");
        return undefined;
    }
    const index = walk.resolve(src);
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
        note(walk, `<img src=${quote(shorten(src))}>, which names none of the files`);
        return undefined;
    }
    if (walk.placed.includes(index)) {
        note(walk, `a second <img src=${quote(shorten(src))}>`);
        return undefined;
    }
    if (!count(walk)) return undefined;
    walk.placed.push(index);
    const style = elementStyle(element, ["src", "alt"], walk);
    const alt = element.attrs
        .find((attribute) => attribute.name === "alt")
        ?.value.replaceAll(/[\t\n\f\r ]+/gu, " ")
        .trim()
        .slice(0, Math.max(0, Math.min(MAX_ALT, MAX_TEXT - walk.text)));
    walk.text += alt?.length ?? 0;
    return {
        type: "item",
        index,
        ...(alt === undefined || alt === "" ? {} : { alt }),
        ...(style === undefined ? {} : { style }),
    };
}

/** The element's parsed style; every other attribute but `kept` is noted and left out. */
function elementStyle(
    element: Element,
    kept: readonly string[],
    walk: LayoutWalk,
): MediaLayoutStyle | undefined {
    attributes(element, ["style", ...kept], walk);
    const source = element.attrs.find((attribute) => attribute.name === "style")?.value;
    if (source === undefined) return undefined;
    const parsed = parseMediaLayoutHtmlStyle(source, element.tagName);
    for (const ignored of parsed.ignored) note(walk, ignored);
    return parsed.style;
}

function attributes(element: Element, kept: readonly string[], walk: LayoutWalk): void {
    for (const attribute of element.attrs) {
        if (kept.includes(attribute.name) && attribute.namespace === undefined) continue;
        note(walk, `the attribute ${shorten(attribute.name)} on <${element.tagName}>`);
    }
}

/**
 * Join neighbouring text, and drop whitespace that only separates blocks, starts or ends a list,
 * or sits between the items of a flex or grid container, where a browser would not show it.
 */
function tidyWhitespace(nodes: MediaLayoutNode[], ignoresWhitespace: boolean): MediaLayoutNode[] {
    const joined: MediaLayoutNode[] = [];
    for (const node of nodes) {
        const last = joined[joined.length - 1];
        if (node.type === "text" && last?.type === "text") {
            joined[joined.length - 1] = {
                type: "text",
                text: `${last.text}${node.text}`.replaceAll(/ {2,}/gu, " "),
            };
        } else {
            joined.push(node);
        }
    }
    return joined.filter((node, position) => {
        if (node.type !== "text") return true;
        if (node.text !== " ") return true;
        return !(
            ignoresWhitespace ||
            position === 0 ||
            position === joined.length - 1 ||
            isBlock(joined[position - 1]) ||
            isBlock(joined[position + 1])
        );
    });
}

function isBlock(node: MediaLayoutNode | undefined): boolean {
    return node?.type === "element" && BLOCK_TAGS.has(node.tag);
}

/** Count one more node, or say there is no room for it. */
function count(walk: LayoutWalk): boolean {
    if (walk.nodes >= MAX_NODES) {
        truncate(walk, `nodes beyond ${String(MAX_NODES)}`);
        return false;
    }
    walk.nodes += 1;
    return true;
}

function note(walk: LayoutWalk, ignored: string): void {
    if (!walk.ignored.includes(ignored)) walk.ignored.push(ignored);
}

function truncate(walk: LayoutWalk, ignored: string): void {
    walk.truncated = true;
    note(walk, ignored);
}

function shorten(text: string): string {
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Quote text for a note, with controls and bidirectional overrides made visible. */
function quote(value: string): string {
    let visible = "";
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (character === "\\") visible += "\\\\";
        else if (character === '"') visible += '\\"';
        else if (character === "\n") visible += "\\n";
        else if (character === "\r") visible += "\\r";
        else if (character === "\t") visible += "\\t";
        else if (
            codePoint < 0x20 ||
            codePoint === 0x7f ||
            (codePoint >= 0x202a && codePoint <= 0x202e) ||
            (codePoint >= 0x2066 && codePoint <= 0x2069)
        ) {
            visible += `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
        } else {
            visible += character;
        }
    }
    return `"${visible}"`;
}
