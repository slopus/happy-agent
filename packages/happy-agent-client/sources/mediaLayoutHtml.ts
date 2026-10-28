/**
 * Media layout HTML: the small subset of HTML and CSS an agent writes to arrange media it showed,
 * either as `present_files`' `layout` argument or as a block in its Markdown reply. This one
 * parser turns it into the typed tree clients render, so the daemon and every client agree on
 * exactly what a layout means. No HTML ever reaches a renderer.
 */

import { Value } from "@sinclair/typebox/value";
import { html as htmlSpec, parse, type DefaultTreeAdapterTypes } from "parse5";

import { parseMediaLayoutHtmlStyle } from "./mediaLayoutHtmlStyle.js";
import type { MediaLayoutStyle } from "./protocol/mediaLayoutStyle.js";
import {
    mediaLayoutNodeSchema,
    type MediaLayoutChartVariant,
    type MediaLayoutNode,
    type MediaLayoutTag,
} from "./protocol/messages.js";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** The most layout HTML that is read, in UTF-16 code units; a longer layout is not used. */
export const MAX_MEDIA_LAYOUT_HTML_LENGTH = 32 * 1024;
const MAX_DEPTH = 12;
/**
 * How deep the HTML itself may nest, counting every element, kept or unwrapped. Content below it
 * is dropped, so neither the walk nor a renderer ever recurses further than this.
 */
const MAX_HTML_DEPTH = 32;
const MAX_NODES = 500;
const MAX_TEXT = 8000;
const MAX_ALT = 1000;
const MAX_WIDGETS = 16;

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
 * The widget tags, each becoming one typed node drawn natively: a chart, a Mermaid diagram, a
 * code quote, or a changed-files list. Their bodies are data, never layout content.
 */
export const MEDIA_LAYOUT_WIDGET_TAGS = [
    "happy-chart",
    "happy-diagram",
    "happy-code",
    "happy-files",
] as const;

/** A tag that becomes a widget node. */
export type MediaLayoutWidgetTag = (typeof MEDIA_LAYOUT_WIDGET_TAGS)[number];

const WIDGET_TAGS: ReadonlySet<string> = new Set(MEDIA_LAYOUT_WIDGET_TAGS);

/** The `<script type>`s each widget reads its body from, mirroring the artifact components. */
const WIDGET_SCRIPT_TYPES: Readonly<Record<MediaLayoutWidgetTag, readonly string[]>> = {
    "happy-chart": ["application/json"],
    "happy-diagram": ["text/x-mermaid", "text/plain"],
    "happy-code": ["text/plain"],
    "happy-files": ["application/json"],
};

const CHART_VARIANTS: ReadonlySet<string> = new Set<MediaLayoutChartVariant>([
    "bar",
    "hbar",
    "line",
    "area",
]);

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
    /** How many widget nodes the tree keeps; a tree with one resolves like one with a picture. */
    readonly widgets: number;
    /** Short descriptions of what was left out, such as `position on <div>`, for the agent. */
    readonly ignored: readonly string[];
    /**
     * Whether content was lost to a limit: the whole HTML was too long, or nodes, text, or
     * elements nested beyond the bounds were dropped. Unsupported markup left out on purpose does
     * not count.
     */
    readonly truncated: boolean;
}

interface LayoutWalk {
    readonly resolve: MediaLayoutSourceResolver;
    readonly placed: number[];
    readonly ignored: string[];
    nodes: number;
    text: number;
    widgets: number;
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
    try {
        return parseBounded(source, resolve);
    } catch {
        // The bounds below should make this unreachable; a layout must still never throw.
        return {
            root: [],
            placed: [],
            widgets: 0,
            ignored: ["the whole layout, which could not be read"],
            truncated: true,
        };
    }
}

function parseBounded(source: string, resolve: MediaLayoutSourceResolver): ParsedMediaLayoutHtml {
    if (source.length > MAX_MEDIA_LAYOUT_HTML_LENGTH) {
        return {
            root: [],
            placed: [],
            widgets: 0,
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
        widgets: 0,
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
    const root = body === undefined ? [] : children(body.childNodes, false, 0, 0, walk);
    return {
        root,
        placed: walk.placed,
        widgets: walk.widgets,
        ignored: walk.ignored,
        truncated: walk.truncated,
    };
}

/**
 * Converts nodes into the tree. `depth` counts the elements kept around them, which the tree
 * bounds by unwrapping; `htmlDepth` counts every element around them, which bounds the walk.
 */
function children(
    nodes: readonly ChildNode[],
    ignoresWhitespace: boolean,
    depth: number,
    htmlDepth: number,
    walk: LayoutWalk,
): MediaLayoutNode[] {
    const converted: MediaLayoutNode[] = [];
    for (const node of nodes) convert(node, depth, htmlDepth, walk, converted);
    return tidyWhitespace(converted, ignoresWhitespace);
}

function convert(
    node: ChildNode,
    depth: number,
    htmlDepth: number,
    walk: LayoutWalk,
    into: MediaLayoutNode[],
): void {
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
    if (htmlDepth >= MAX_HTML_DEPTH) {
        truncate(walk, `elements nested more than ${String(MAX_HTML_DEPTH)} deep`);
        return;
    }
    // Every element counts, kept or not, so no markup can make the walk outgrow the budget.
    if (!count(walk)) return;
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
        into.push({ type: "break" });
        return;
    }
    if (WIDGET_TAGS.has(tag)) {
        const widget = widgetNode(element, tag as MediaLayoutWidgetTag, walk);
        if (widget !== undefined) into.push(widget);
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
        for (const child of element.childNodes) convert(child, depth, htmlDepth + 1, walk, into);
        return;
    }
    const style = elementStyle(element, [], walk);
    const display = style?.display ?? "";
    const flowIgnoresWhitespace = /flex|grid/u.test(display);
    into.push({
        type: "element",
        tag: elementTag,
        ...(style === undefined ? {} : { style }),
        children: children(
            element.childNodes,
            flowIgnoresWhitespace,
            depth + 1,
            htmlDepth + 1,
            walk,
        ),
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

const WIDGET_WORDS: Readonly<Record<MediaLayoutWidgetTag, string>> = {
    "happy-chart": "chart",
    "happy-diagram": "diagram",
    "happy-code": "code quote",
    "happy-files": "file list",
};

/**
 * One widget element as its typed node. A widget's body is data, never layout content: the text
 * of its first `<script>` child of a type the widget takes, or the element's own text. A widget
 * that is empty, over a bound, or not the shape its node requires is dropped as content lost to a
 * limit, so a reply block holding one stays the inert text it was written as.
 */
function widgetNode(
    element: Element,
    tag: MediaLayoutWidgetTag,
    walk: LayoutWalk,
): MediaLayoutNode | undefined {
    if (walk.widgets >= MAX_WIDGETS) {
        truncate(walk, `widgets beyond ${String(MAX_WIDGETS)}`);
        return undefined;
    }
    const kept =
        tag === "happy-chart" ? ["type"] : tag === "happy-code" ? ["language", "path"] : [];
    const style = elementStyle(element, kept, walk);
    const body = widgetBody(element, tag, walk);
    if (body.trim() === "") {
        truncate(walk, `a <${tag}> with an empty body`);
        return undefined;
    }
    if (body.length > MAX_TEXT - walk.text) {
        truncate(walk, `a <${tag}> whose body passes the ${String(MAX_TEXT)}-character budget`);
        return undefined;
    }
    const node = widgetCandidate(element, tag, body, style, walk);
    if (node === undefined) return undefined;
    walk.text += body.length;
    walk.widgets += 1;
    return node;
}

/**
 * The text a widget reads. A `<script>` child carries code and JSON through the HTML parser
 * verbatim, so `<` never starts a tag inside it; any other child element is not layout content
 * and is dropped and noted.
 */
function widgetBody(element: Element, tag: MediaLayoutWidgetTag, walk: LayoutWalk): string {
    const types = WIDGET_SCRIPT_TYPES[tag];
    let script: string | undefined;
    let text = "";
    for (const child of element.childNodes) {
        if (child.nodeName === "#text" && "value" in child) {
            text += child.value;
            continue;
        }
        if (child.nodeName === "#comment") {
            note(walk, "comments");
            continue;
        }
        if (!("tagName" in child)) continue;
        void count(walk);
        if (child.tagName === "script" && script === undefined) {
            const type =
                child.attrs
                    .find((attribute) => attribute.name === "type")
                    ?.value.trim()
                    .toLowerCase() ?? "";
            if (types.includes(type)) {
                let value = "";
                for (const grandchild of child.childNodes) {
                    if (grandchild.nodeName === "#text" && "value" in grandchild)
                        value += grandchild.value;
                }
                script = value;
                continue;
            }
        }
        note(walk, `<${child.tagName}> inside <${tag}>`);
    }
    return script ?? text;
}

function widgetCandidate(
    element: Element,
    tag: MediaLayoutWidgetTag,
    body: string,
    style: MediaLayoutStyle | undefined,
    walk: LayoutWalk,
): MediaLayoutNode | undefined {
    const withStyle = style === undefined ? {} : { style };
    if (tag === "happy-diagram") {
        const source = body.replace(/^\s*\n/u, "").replace(/\s+$/u, "");
        return checked(walk, tag, { type: "diagram", source, ...withStyle });
    }
    if (tag === "happy-code") {
        const language = attributeValue(element, "language");
        const path = attributeValue(element, "path");
        return checked(walk, tag, {
            type: "codeQuote",
            code: dedent(body),
            ...(language === undefined ? {} : { language }),
            ...(path === undefined ? {} : { path }),
            ...withStyle,
        });
    }
    let data: unknown;
    try {
        data = JSON.parse(body);
    } catch {
        truncate(walk, `a <${tag}> whose body is not valid JSON`);
        return undefined;
    }
    if (tag === "happy-files") {
        const node = checked(walk, tag, { type: "files", files: data, ...withStyle });
        if (node?.type !== "files") return undefined;
        /* Rebuilt field by field: nothing the JSON carried beyond the shape travels on. */
        return {
            type: "files",
            files: node.files.map((file) => ({
                path: file.path,
                ...(file.status === undefined ? {} : { status: file.status }),
                ...(file.added === undefined ? {} : { added: file.added }),
                ...(file.removed === undefined ? {} : { removed: file.removed }),
            })),
            ...withStyle,
        };
    }
    const written = attributeValue(element, "type");
    const variant = (written ?? "bar").toLowerCase();
    if (!CHART_VARIANTS.has(variant)) {
        truncate(
            walk,
            `type=${quote(shorten(written ?? ""))} on <happy-chart>, which names no chart`,
        );
        return undefined;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        truncate(walk, "a <happy-chart> whose body is not a chart object");
        return undefined;
    }
    const record = data as Record<string, unknown>;
    const node = checked(walk, tag, {
        type: "chart",
        variant,
        labels: record.labels,
        series: record.series,
        ...(record.unit === undefined ? {} : { unit: record.unit }),
        ...withStyle,
    });
    if (node?.type !== "chart") return undefined;
    return {
        type: "chart",
        variant: node.variant,
        labels: [...node.labels],
        series: node.series.map((series) => ({
            ...(series.name === undefined ? {} : { name: series.name }),
            values: [...series.values],
        })),
        ...(node.unit === undefined ? {} : { unit: node.unit }),
        ...withStyle,
    };
}

/** The candidate against the published schema; a widget that fails it is dropped as lost content. */
function checked(
    walk: LayoutWalk,
    tag: MediaLayoutWidgetTag,
    candidate: unknown,
): MediaLayoutNode | undefined {
    if (Value.Check(mediaLayoutNodeSchema, candidate)) return candidate;
    truncate(walk, `a <${tag}> outside what a ${WIDGET_WORDS[tag]} may hold`);
    return undefined;
}

function attributeValue(element: Element, name: string): string | undefined {
    const value = element.attrs.find((attribute) => attribute.name === name)?.value;
    return value === undefined || value === "" ? undefined : value;
}

/** Code as written inside the element, without the blank lines and shared indent around it. */
function dedent(text: string): string {
    const lines = text.replace(/\r\n?/gu, "\n").split("\n");
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    let indent: number | undefined;
    for (const line of lines) {
        if (line.trim() === "") continue;
        const width = (/^[ \t]*/u.exec(line) as RegExpExecArray)[0].length;
        if (indent === undefined || width < indent) indent = width;
    }
    return lines.map((line) => line.slice(indent ?? 0)).join("\n");
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
    if (node === undefined) return false;
    if (node.type === "element") return BLOCK_TAGS.has(node.tag);
    return (
        node.type === "chart" ||
        node.type === "diagram" ||
        node.type === "codeQuote" ||
        node.type === "files"
    );
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
