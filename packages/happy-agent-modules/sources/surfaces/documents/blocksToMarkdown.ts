import MarkdownIt from "markdown-it";
import { parseInlineMarkdown, type MarkdownInline } from "./markdownToBlocks.js";

/** A BlockNote block as `docToBlocks` returns it, typed only as far as Markdown needs. */
export type DocumentBlock = {
    type: string;
    props?: Record<string, unknown>;
    content?: unknown;
    children?: DocumentBlock[];
};

/** Content that exists in the document but that Markdown cannot show. */
export type OmittedContent =
    | "underline"
    | "text colors"
    | "highlights"
    | "alignment"
    | "toggles"
    | "nesting"
    | "trailing line breaks"
    | "some formatting";

type Text = { type: "text"; text: string; styles?: Record<string, unknown> };
type Link = { type: "link"; href: string; content: Text[] };
type Context = { omitted: Set<OmittedContent>; table: boolean; singleLine: boolean };

const LIST_TYPES = new Set([
    "bulletListItem",
    "numberedListItem",
    "checkListItem",
    "toggleListItem",
]);
const normalizer = new MarkdownIt("commonmark");
const ENTITY = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Serialize blocks as normalized Markdown. Text is escaped only where Markdown would otherwise
 * read it as syntax, so ordinary text such as `a_snake_name` reads as written. Every block's
 * inline Markdown is parsed back before it is used; formatting that would not survive that round
 * trip is left out rather than turned into different text.
 */
export function blocksToMarkdown(blocks: readonly DocumentBlock[]): {
    text: string;
    omitted: Set<OmittedContent>;
} {
    const omitted = new Set<OmittedContent>();
    const text = serializeBlocks(blocks, "", omitted);
    return { text: text === "" ? "" : `${text}\n`, omitted };
}

/**
 * One block's own Markdown, without its children or list numbering. Agent edits match blocks by
 * this signature, so a block whose Markdown the agent left alone is never rewritten.
 */
export function blockSignature(block: DocumentBlock): string {
    return ownMarkdown({ ...block, children: [] }, 1, new Set()).join("\n");
}

function serializeBlocks(
    blocks: readonly DocumentBlock[],
    indent: string,
    omitted: Set<OmittedContent>,
): string {
    const chunks: { text: string; type: string }[] = [];
    let number = 0;
    for (const block of blocks) {
        number = block.type === "numberedListItem" ? number + 1 : 0;
        recordBlockProps(block, omitted);
        const lines = ownMarkdown(block, number, omitted);
        const marker = listMarkerWidth(block, number);
        const continuation = indent + " ".repeat(marker);
        let text = lines
            .map((line, index) => (index === 0 ? indent : continuation) + line)
            .join("\n");
        const children = block.children ?? [];
        if (children.length > 0) {
            if (LIST_TYPES.has(block.type)) {
                // A nested list stays tight; any other child needs a blank line to belong here.
                const gap = LIST_TYPES.has(children[0]!.type) ? "\n" : "\n\n";
                text += `${gap}${serializeBlocks(children, continuation, omitted)}`;
            } else {
                // Markdown can only nest beneath list items; other children follow as siblings.
                omitted.add("nesting");
                text += `\n\n${serializeBlocks(children, indent, omitted)}`;
            }
        }
        chunks.push({ text, type: block.type });
    }
    let out = "";
    chunks.forEach((chunk, index) => {
        const previous = chunks[index - 1];
        if (previous !== undefined) {
            // Consecutive items of one kind of list stay tight; everything else is a new block.
            const sameList =
                LIST_TYPES.has(chunk.type) &&
                (previous.type === chunk.type ||
                    (bulletLike(previous.type) && bulletLike(chunk.type)));
            out += sameList ? "\n" : "\n\n";
        }
        out += chunk.text;
    });
    return out;
}

function bulletLike(type: string): boolean {
    return type === "bulletListItem" || type === "checkListItem" || type === "toggleListItem";
}

function listMarkerWidth(block: DocumentBlock, number: number): number {
    if (block.type === "numberedListItem") return `${number}. `.length;
    return LIST_TYPES.has(block.type) ? 2 : 0;
}

/** The lines of one block, without children or indentation. */
function ownMarkdown(block: DocumentBlock, number: number, omitted: Set<OmittedContent>): string[] {
    const props = block.props ?? {};
    const lines = (singleLine = false) =>
        inlineMarkdown(block.content, { omitted, table: false, singleLine }).split("\n");
    switch (block.type) {
        case "heading": {
            const level = Math.min(6, Math.max(1, Number(props["level"]) || 1));
            // A trailing run of `#` after a space would read as the heading's closing sequence.
            const text = (lines(true)[0] ?? "").replace(/(\s)#(#*)$/, "$1\\#$2");
            return [`${"#".repeat(level)}${text === "" ? "" : ` ${text}`}`];
        }
        case "bulletListItem":
        case "toggleListItem":
            return prefixed("- ", lines());
        case "numberedListItem":
            return prefixed(`${number}. `, lines());
        case "checkListItem":
            return prefixed(`- [${props["checked"] === true ? "x" : " "}] `, lines());
        case "quote":
            return lines().map((line) => (line === "" ? ">" : `> ${line}`));
        case "codeBlock": {
            const code = plainText(block.content);
            const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
            const language = typeof props["language"] === "string" ? props["language"] : "text";
            return [`${fence}${language === "text" ? "" : language}`, ...code.split("\n"), fence];
        }
        case "divider":
            return ["---"];
        case "image": {
            const name = String(props["name"] || props["caption"] || "");
            return [
                `![${escapeText(name, { omitted, table: false, singleLine: true }, true)}](${destination(String(props["url"] ?? ""))})`,
            ];
        }
        case "file":
        case "audio":
        case "video": {
            const url = String(props["url"] ?? "");
            const name = String(props["name"] || url);
            if (url === "")
                return [
                    escapeLine(
                        escapeText(name, { omitted, table: false, singleLine: true }, false),
                    ),
                ];
            return [
                `[${escapeText(name, { omitted, table: false, singleLine: true }, true)}](${destination(url)})`,
            ];
        }
        case "table":
            return tableMarkdown(block.content, omitted);
        default:
            return lines();
    }
}

function prefixed(marker: string, lines: string[]): string[] {
    return lines.map((line, index) => (index === 0 ? marker + line : line));
}

function tableMarkdown(content: unknown, omitted: Set<OmittedContent>): string[] {
    const rows = (content as { rows?: { cells?: unknown[] }[] } | undefined)?.rows ?? [];
    if (rows.length === 0) return [];
    const width = Math.max(1, ...rows.map((row) => row.cells?.length ?? 0));
    const render = (row: { cells?: unknown[] }) => {
        const cells = Array.from({ length: width }, (_, index) => {
            const cell = row.cells?.[index];
            const inline = Array.isArray(cell)
                ? cell
                : (cell as { content?: unknown } | undefined)?.content;
            return inlineMarkdown(inline, { omitted, table: true, singleLine: true });
        });
        return `| ${cells.join(" | ")} |`;
    };
    return [
        render(rows[0]!),
        `| ${Array(width).fill("---").join(" | ")} |`,
        ...rows.slice(1).map(render),
    ];
}

/**
 * Inline content as Markdown. Hard breaks become `\` line ends. When the result would not parse
 * back to the same text and styles, emphasis is dropped; if even that fails, links are too.
 */
function inlineMarkdown(content: unknown, context: Context): string {
    if (typeof content === "string")
        return escapeLines(escapeText(content, context, false), context);
    const nodes = normalizeInline(content, context);
    for (const level of ["all", "noEmphasis", "plain"] as const) {
        const markdown = escapeLines(renderInline(nodes, context, level), context);
        if (level !== "all") context.omitted.add("some formatting");
        if (sameInline(parseInlineMarkdown(markdown), expected(nodes, level))) return markdown;
    }
    return escapeLines(escapeText(plainText(content), context, false), context);
}

/** Text and links with only the styles Markdown can express; other styles are recorded. */
function normalizeInline(content: unknown, context: Context): (Text | Link)[] {
    if (!Array.isArray(content)) return [];
    const text = (node: Text): Text => {
        const styles = node.styles ?? {};
        if (styles["underline"] === true) context.omitted.add("underline");
        if (styles["textColor"] !== undefined && styles["textColor"] !== "default")
            context.omitted.add("text colors");
        if (styles["backgroundColor"] !== undefined && styles["backgroundColor"] !== "default")
            context.omitted.add("highlights");
        const kept: Record<string, true> = {};
        for (const key of ["bold", "italic", "strike", "code"])
            if (styles[key] === true) kept[key] = true;
        const value = context.singleLine ? node.text.replaceAll("\n", " ") : node.text;
        return { type: "text", text: value, styles: kept };
    };
    const out: (Text | Link)[] = [];
    for (const node of content as (Text | Link)[]) {
        if (node?.type === "link")
            out.push({
                type: "link",
                href: node.href,
                content: sharedWhitespace(
                    node.content.map(text).filter((child) => child.text !== ""),
                ) as Text[],
            });
        else if (node?.type === "text" && node.text !== "") out.push(text(node));
    }
    if (dropTrailingBreaks(out)) context.omitted.add("trailing line breaks");
    return sharedWhitespace(out);
}

/**
 * A line break that ends a block shows as nothing in Markdown: a `\` there is a backslash, not a
 * break. Leave such breaks out, so a block reads as text that parses back to the same block.
 */
function dropTrailingBreaks(nodes: (Text | Link)[]): boolean {
    let dropped = false;
    for (let last = nodes.at(-1); last !== undefined; last = nodes.at(-1)) {
        if (last.type === "link") {
            dropped = dropTrailingBreaks(last.content) || dropped;
            if (last.content.length > 0) break;
        } else {
            const kept = last.text.replace(/\n+$/, "");
            dropped ||= kept !== last.text;
            if (kept !== "") {
                nodes[nodes.length - 1] = { ...last, text: kept };
                break;
            }
        }
        nodes.pop();
    }
    return dropped;
}

/**
 * Formatting on whitespace alone is invisible and cannot be written in Markdown, so a
 * whitespace-only run keeps just the emphasis both its neighbours have.
 */
function sharedWhitespace(nodes: (Text | Link)[]): (Text | Link)[] {
    return nodes.map((node, index) => {
        if (node.type !== "text" || node.text.trim() !== "") return node;
        const styles = (other: Text | Link | undefined) =>
            other?.type === "text" ? (other.styles ?? {}) : {};
        const before = styles(nodes[index - 1]);
        const after = styles(nodes[index + 1]);
        const kept: Record<string, true> = {};
        for (const key of ["bold", "italic", "strike"])
            if (before[key] === true && after[key] === true) kept[key] = true;
        return { ...node, styles: kept };
    });
}

function renderInline(
    nodes: readonly (Text | Link)[],
    context: Context,
    level: "all" | "noEmphasis" | "plain",
): string {
    let out = "";
    let open: string[] = [];
    const emphasis = (styles: Record<string, unknown>) =>
        level === "all"
            ? (["bold", "italic", "strike"] as const).filter((key) => styles[key] === true)
            : [];
    const close = (keep: readonly string[]) => {
        // Close from the innermost delimiter until only a prefix that stays open remains.
        let shared = 0;
        while (shared < open.length && keep.includes(open[shared]!)) shared += 1;
        for (const style of open.slice(shared).reverse()) out += DELIMITERS[style]!;
        open = open.slice(0, shared);
    };
    const text = (node: Text, inLink: boolean) => {
        const styles = emphasis(node.styles ?? {});
        // Delimiters never sit next to whitespace, or they would not open or close.
        const leading = /^\s*/.exec(node.text)![0];
        const trailing = node.text.length > leading.length ? /\s*$/.exec(node.text)![0] : "";
        const core = node.text.slice(leading.length, node.text.length - trailing.length);
        if (core === "") {
            close(styles);
            out += escapeText(node.text, context, inLink);
            return;
        }
        close(styles);
        out += escapeText(leading, context, inLink);
        for (const style of styles)
            if (!open.includes(style)) {
                out += DELIMITERS[style]!;
                open.push(style);
            }
        out +=
            level !== "plain" && node.styles?.["code"] === true
                ? codeSpan(core)
                : escapeText(core, context, inLink);
        if (trailing !== "") {
            close([]);
            out += escapeText(trailing, context, inLink);
        }
    };
    for (const node of nodes) {
        if (node.type === "link" && level !== "plain") {
            close([]);
            out += "[";
            for (const child of node.content) text(child, true);
            close([]);
            out += `](${destination(node.href)})`;
        } else if (node.type === "link") {
            for (const child of node.content) text(child, false);
        } else text(node, false);
    }
    close([]);
    return out;
}

const DELIMITERS: Record<string, string> = { bold: "**", italic: "*", strike: "~~" };

/** What parsing the rendered Markdown must give back, at the formatting level that was used. */
function expected(
    nodes: readonly (Text | Link)[],
    level: "all" | "noEmphasis" | "plain",
): MarkdownInline[] {
    const styles = (node: Text) => {
        const kept: Record<string, true> = {};
        for (const key of level === "all"
            ? ["bold", "italic", "strike", "code"]
            : level === "noEmphasis"
              ? ["code"]
              : [])
            if (node.styles?.[key] === true) kept[key] = true;
        return kept;
    };
    const out: MarkdownInline[] = [];
    for (const node of nodes) {
        if (node.type === "link" && level !== "plain")
            out.push({
                type: "link",
                href: normalizer.normalizeLink(node.href),
                content: node.content.map((child) => ({
                    type: "text",
                    text: child.text,
                    styles: styles(child),
                })),
            });
        else if (node.type === "link")
            for (const child of node.content)
                out.push({ type: "text", text: child.text, styles: styles(child) });
        else out.push({ type: "text", text: node.text, styles: styles(node) });
    }
    return mergeText(out);
}

function sameInline(actual: MarkdownInline[], wanted: MarkdownInline[]): boolean {
    return JSON.stringify(mergeText(actual)) === JSON.stringify(wanted);
}

/** Adjacent text with the same styles is one run, however it was split. */
function mergeText(nodes: readonly MarkdownInline[]): MarkdownInline[] {
    const out: MarkdownInline[] = [];
    for (const node of nodes) {
        if (node.type === "link") {
            out.push({ ...node, content: mergeText(node.content) as Text[] as never });
            continue;
        }
        const styles = Object.fromEntries(
            Object.entries(node.styles).sort(([a], [b]) => a.localeCompare(b)),
        );
        const last = out.at(-1);
        if (last?.type === "text" && JSON.stringify(last.styles) === JSON.stringify(styles))
            out[out.length - 1] = { ...last, text: last.text + node.text };
        else if (node.text !== "") out.push({ type: "text", text: node.text, styles });
    }
    return out;
}

function codeSpan(text: string): string {
    const fence = "`".repeat(longestRun(text, "`") + 1);
    const pad =
        text.startsWith("`") ||
        text.endsWith("`") ||
        (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "")
            ? " "
            : "";
    return `${fence}${pad}${text}${pad}${fence}`;
}

function longestRun(text: string, char: string): number {
    let longest = 0;
    let run = 0;
    for (const c of text) {
        run = c === char ? run + 1 : 0;
        longest = Math.max(longest, run);
    }
    return longest;
}

/** A link destination, in the normalized form Markdown parsing would give it back in. */
function destination(href: string): string {
    if (href === "") return "";
    const url = normalizer.normalizeLink(href);
    if (/[\s<>()]/.test(url))
        return `<${url.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("\n", "%0A")}>`;
    return url.replaceAll("\\", "\\\\");
}

/**
 * Escape characters Markdown would read as inline syntax. Emphasis characters inside words, a
 * lone `~`, and brackets that cannot start a link stay as written.
 */
function escapeText(text: string, context: Context, inLink: boolean): string {
    let out = "";
    const chars = [...text];
    chars.forEach((char, index) => {
        const before = chars[index - 1];
        const after = chars[index + 1];
        const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
        const word = (c: string | undefined) => c !== undefined && WORD.test(c);
        let escape = false;
        switch (char) {
            case "\\":
                escape = after === undefined || after === "\n" || PUNCTUATION.test(after);
                break;
            case "`":
            case "[":
                escape = true;
                break;
            case "]":
                escape = inLink;
                break;
            case "*":
                escape = !(space(before) && space(after));
                break;
            case "_":
                escape = !((word(before) && word(after)) || (space(before) && space(after)));
                break;
            case "~":
                escape = before === "~" || after === "~";
                break;
            case "<":
                escape = after !== undefined && /[A-Za-z/!?]/.test(after);
                break;
            case "&":
                escape = ENTITY.test(chars.slice(index).join(""));
                break;
            case "|":
                escape = context.table;
                break;
        }
        out += escape ? `\\${char}` : char;
    });
    return out;
}

/** Turn hard breaks into `\` line ends and protect every line from block syntax. */
function escapeLines(markdown: string, context: Context): string {
    const lines = markdown.split("\n");
    return lines
        .map((line, index) => {
            let escaped = escapeLine(line);
            if (index < lines.length - 1) escaped = `${escaped}\\`;
            return escaped;
        })
        .join(context.singleLine ? " " : "\n");
}

/**
 * Keep a line from starting a heading, quote, list, fence, rule, or setext underline, and keep
 * its leading and trailing whitespace, which Markdown would otherwise drop.
 */
function escapeLine(line: string): string {
    if (line === "") return line;
    let out = line;
    const indent = /^[ \t]*/.exec(out)![0];
    let rest = out.slice(indent.length);
    if (
        /^#{1,6}(\s|$)/.test(rest) ||
        rest.startsWith(">") ||
        /^[-+](\s|$)/.test(rest) ||
        /^[-=]+\s*$/.test(rest) ||
        rest.startsWith("~~~")
    )
        rest = `\\${rest}`;
    else {
        const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(rest);
        if (ordered !== null) rest = `${ordered[1]}\\${rest.slice(ordered[1]!.length)}`;
    }
    out = indent === "" ? rest : `${whitespaceEntity(indent[0]!)}${indent.slice(1)}${rest}`;
    const trailing = /[ \t]+$/.exec(out);
    if (trailing !== null && out.length > trailing[0].length)
        out = `${out.slice(0, out.length - 1)}${whitespaceEntity(out.at(-1)!)}`;
    return out;
}

function whitespaceEntity(char: string): string {
    return char === "\t" ? "&#9;" : "&#32;";
}

function plainText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((node: { type?: string; text?: string; content?: unknown }) =>
            node.type === "link" ? plainText(node.content) : (node.text ?? ""),
        )
        .join("");
}

function recordBlockProps(block: DocumentBlock, omitted: Set<OmittedContent>): void {
    const props = block.props ?? {};
    if (props["textColor"] !== undefined && props["textColor"] !== "default")
        omitted.add("text colors");
    if (props["backgroundColor"] !== undefined && props["backgroundColor"] !== "default")
        omitted.add("highlights");
    if (props["textAlignment"] !== undefined && props["textAlignment"] !== "left")
        omitted.add("alignment");
    if (block.type === "toggleListItem" || props["isToggleable"] === true) omitted.add("toggles");
}
