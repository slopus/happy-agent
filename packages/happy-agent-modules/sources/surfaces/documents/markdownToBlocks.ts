import MarkdownIt from "markdown-it";

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];
type Styles = { bold?: true; italic?: true; strike?: true; code?: true };
type StyledText = { type: "text"; text: string; styles: Styles };
type Link = { type: "link"; href: string; content: StyledText[] };
export type MarkdownInline = StyledText | Link;
/** The subset of BlockNote's partial block shape that Markdown can express. */
export type MarkdownBlock = {
    type: string;
    props?: Record<string, unknown>;
    content?:
        | MarkdownInline[]
        | string
        | { type: "tableContent"; headerRows: number; rows: { cells: MarkdownInline[][] }[] };
    children?: MarkdownBlock[];
};

const markdown = new MarkdownIt("commonmark", { html: false }).enable(["table", "strikethrough"]);
const CHECKBOX = /^\[( |x|X)\](?:[ \t]|$)/;
const LIST_ITEMS = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);
const CONTAINERS = new Set(["blockquote_open", "bullet_list_open", "ordered_list_open"]);

/**
 * Parse Markdown into BlockNote blocks without a DOM. Anything Markdown and the content model do
 * not share degrades to the nearest block: HTML stays literal text and inline images become links.
 *
 * Blank lines carry empty paragraphs, the way `blocksToMarkdown` writes them: blocks are a blank
 * line apart and an empty paragraph is an empty block, so every two blank lines beyond the first
 * between two blocks are one empty paragraph. One stray blank line is nobody's paragraph.
 *
 * A newline inside a paragraph, quote, or list item is a line break, and a line holding only a
 * backslash is an empty line there. Trailing spaces or a backslash before a newline add nothing.
 */
export function markdownToBlocks(input: string): MarkdownBlock[] {
    const source = input.replace(/\r\n?/g, "\n");
    const tokens = markdown.parse(source, {});
    const lines = source.split("\n");
    let index = 0;
    /** The first line whose blank lines no block has accounted for yet. */
    let line = 0;
    let started = false;
    /**
     * The empty paragraphs standing in the blank lines before a block that starts at `start`.
     * They sit right before that block, at its level, because blank lines cannot say more.
     */
    const gap = (start: number): MarkdownBlock[] => {
        let blank = 0;
        for (let at = line; at < start; at += 1) if (/^[ \t]*$/.test(lines[at]!)) blank += 1;
        // Before the first block nothing separates, so every pair of blank lines is a paragraph.
        const count = started ? Math.floor((blank - 1) / 2) : Math.floor(blank / 2);
        line = Math.max(line, start);
        started = true;
        return Array.from({ length: Math.max(0, count) }, () => ({ type: "paragraph" }));
    };
    const blocks = (stop?: string): MarkdownBlock[] => {
        const result: MarkdownBlock[] = [];
        while (index < tokens.length && tokens[index]!.type !== stop) {
            const token = tokens[index]!;
            if (token.map !== null) {
                result.push(...gap(token.map[0]));
                // A container's own blocks account for the lines inside it.
                if (!CONTAINERS.has(token.type)) line = token.map[1];
            }
            if (token.type === "heading_open") {
                const level = Math.min(6, Math.max(1, Number(token.tag.slice(1))));
                result.push({
                    type: "heading",
                    props: { level },
                    content: inline(tokens[index + 1]?.children),
                });
                index += 3;
            } else if (token.type === "paragraph_open") {
                const children = tokens[index + 1]?.children ?? [];
                const visible = children.filter((child) => child.type !== "softbreak");
                const image =
                    visible.length === 1 && visible[0]!.type === "image" ? visible[0]! : undefined;
                result.push(
                    image === undefined
                        ? { type: "paragraph", content: textLines(tokens[index + 1]) }
                        : {
                              type: "image",
                              props: {
                                  url: String(image.attrGet("src") ?? ""),
                                  name: image.content,
                                  caption: "",
                              },
                          },
                );
                index += 3;
            } else if (token.type === "fence" || token.type === "code_block") {
                result.push({
                    type: "codeBlock",
                    props: { language: token.info.trim().split(/\s+/)[0] || "text" },
                    content: token.content.replace(/\n$/, ""),
                });
                index += 1;
            } else if (token.type === "hr") {
                result.push({ type: "divider" });
                index += 1;
            } else if (token.type === "blockquote_open") {
                const whole = quote(token);
                if (whole !== undefined) {
                    result.push(whole);
                    continue;
                }
                index += 1;
                const inner = blocks("blockquote_close");
                index += 1;
                for (const block of inner)
                    result.push(block.type === "paragraph" ? { ...block, type: "quote" } : block);
            } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
                result.push(...list(token.type === "ordered_list_open"));
            } else if (token.type === "table_open") {
                result.push(table());
            } else index += 1;
        }
        return result;
    };
    /**
     * A quote that holds only text is one block: each of its lines is a line of the quote, and
     * a line that is the quote mark alone is an empty line. `undefined` when it holds any other
     * kind of block, which the editor's quote cannot.
     */
    const quote = (open: Token): MarkdownBlock | undefined => {
        const paragraphs: Token[] = [];
        let at = index + 1;
        for (; tokens[at] !== undefined && tokens[at]!.type !== "blockquote_close"; at += 3) {
            const text = tokens[at + 1];
            if (tokens[at]!.type !== "paragraph_open" || text?.map == null) return undefined;
            const shown = (text.children ?? []).filter((child) => child.type !== "softbreak");
            if (shown.length === 1 && shown[0]!.type === "image") return undefined;
            paragraphs.push(text);
        }
        const [start, limit] = open.map ?? [line, line];
        // The quote ends at its last line that holds anything; blank lines after it are a gap.
        let end = Math.max(limit, ...paragraphs.map((text) => text.map![1]));
        while (end > start + 1 && /^[ \t]*$/.test(lines[end - 1]!)) end -= 1;
        const own = lines
            .slice(start, end)
            .map((text) => text.replace(/^[ \t]*(?:>[ \t]?)?/, "").trim());
        const parsed = paragraphs.flatMap((text) =>
            text.content.split("\n").map((part) => part.trim()),
        );
        // Inside other containers the lines carry marks that are not this quote's.
        if (own.filter((text) => text !== "").join("\n") !== parsed.join("\n")) return undefined;
        // Read as one text, the way a paragraph with these lines reads.
        const content = parseInlineMarkdown(
            own.map((text) => (text === "" ? "\\" : text)).join("\n"),
        );
        index = at + 1;
        line = end;
        return content.length === 0 ? { type: "quote" } : { type: "quote", content };
    };
    const list = (ordered: boolean): MarkdownBlock[] => {
        const close = ordered ? "ordered_list_close" : "bullet_list_close";
        const items: MarkdownBlock[] = [];
        index += 1;
        while (index < tokens.length && tokens[index]!.type !== close) {
            items.push(...gap(tokens[index]!.map?.[0] ?? line));
            // A list item's first paragraph is its own text; anything after it nests beneath.
            const source = tokens[index + 2]?.type === "inline" ? tokens[index + 2]!.content : "";
            index += 1;
            const [first, ...rest] = blocks("list_item_close");
            index += 1;
            const checkbox = ordered ? null : CHECKBOX.exec(source);
            // Only a paragraph is the item's own text; an item may start with a nested block.
            const own = first?.type === "paragraph";
            const content = own && Array.isArray(first.content) ? first.content : [];
            const beneath = first === undefined || own ? rest : [first, ...rest];
            // An item whose own line is empty has no text for another kind of block to sit
            // beneath, and reads with that block after it. It is stored the way it reads.
            const apart =
                own &&
                content.length === 0 &&
                beneath.length > 0 &&
                !LIST_ITEMS.has(beneath[0]!.type);
            const children = apart ? [] : beneath;
            items.push(
                checkbox === null
                    ? { type: ordered ? "numberedListItem" : "bulletListItem", content, children }
                    : {
                          type: "checkListItem",
                          props: { checked: checkbox[1] !== " " },
                          content: dropPrefix(content, checkbox[0].length),
                          children,
                      },
            );
            if (apart) items.push(...beneath);
        }
        index += 1;
        return items;
    };
    const table = (): MarkdownBlock => {
        const rows: { cells: MarkdownInline[][] }[] = [];
        let row: MarkdownInline[][] | undefined;
        while (index < tokens.length && tokens[index]!.type !== "table_close") {
            const token = tokens[index]!;
            if (token.type === "tr_open") row = [];
            else if (token.type === "inline" && row !== undefined) row.push(inline(token.children));
            else if (token.type === "tr_close" && row !== undefined) rows.push({ cells: row });
            index += 1;
        }
        index += 1;
        return { type: "table", content: { type: "tableContent", headerRows: 1, rows } };
    };
    const parsed = blocks();
    // The line after the final line break counts, so text that ends in one adds no paragraph.
    const trailing = gap(lines.length);
    // One empty paragraph alone reads as no text at all, so blank text that short is no content.
    return parsed.length === 0 && trailing.length < 2 ? [] : [...parsed, ...trailing];
}

/** Parse one block's inline Markdown into styled text and links. */
export function parseInlineMarkdown(source: string): MarkdownInline[] {
    return textLines(markdown.parseInline(source, {})[0]);
}

/**
 * The inline content of a block whose text may span lines. A line holding only a backslash is
 * an empty line. Markdown already reads it that way wherever a line follows; on the last line
 * the backslash would be text, so it is taken out here.
 */
function textLines(token: Token | undefined): MarkdownInline[] {
    const children = token?.children ?? [];
    const last = children.at(-1);
    const ends = token?.content.split("\n").at(-1)?.trim() === "\\";
    return inline(
        ends && last?.type === "text" && last.content === "\\" ? children.slice(0, -1) : children,
    );
}

function inline(tokens: Token[] | null | undefined): MarkdownInline[] {
    const out: MarkdownInline[] = [];
    const styles: Styles = {};
    let link: Link | undefined;
    const push = (text: string, extra: Styles = {}) => {
        if (text === "") return;
        const node: StyledText = { type: "text", text, styles: { ...styles, ...extra } };
        (link === undefined ? out : link.content).push(node);
    };
    for (const token of tokens ?? []) {
        switch (token.type) {
            case "text":
                push(token.content);
                break;
            case "code_inline":
                // The editor's code text carries no other formatting and cannot be a link's
                // text. Written together, a link stays a link and other code is code alone.
                if (link === undefined)
                    out.push({ type: "text", text: token.content, styles: { code: true } });
                else push(token.content);
                break;
            case "softbreak":
            case "hardbreak":
                // Every newline inside a block is a line break, however the line before it ends.
                push("\n");
                break;
            case "strong_open":
                styles.bold = true;
                break;
            case "strong_close":
                delete styles.bold;
                break;
            case "em_open":
                styles.italic = true;
                break;
            case "em_close":
                delete styles.italic;
                break;
            case "s_open":
                styles.strike = true;
                break;
            case "s_close":
                delete styles.strike;
                break;
            case "link_open": {
                const opened: Link = {
                    type: "link",
                    href: String(token.attrGet("href") ?? ""),
                    content: [],
                };
                link = opened;
                out.push(opened);
                break;
            }
            case "link_close":
                link = undefined;
                break;
            case "image":
                if (link === undefined)
                    out.push({
                        type: "link",
                        href: String(token.attrGet("src") ?? ""),
                        content: [
                            { type: "text", text: token.content || "image", styles: { ...styles } },
                        ],
                    });
                else push(token.content);
                break;
        }
    }
    return out;
}

/** Remove a parsed checkbox marker from the start of an item's inline content. */
function dropPrefix(content: MarkdownInline[], length: number): MarkdownInline[] {
    let remaining = length;
    const result: MarkdownInline[] = [];
    for (const node of content) {
        if (remaining > 0 && node.type === "text") {
            const cut = Math.min(remaining, node.text.length);
            remaining -= cut;
            if (cut < node.text.length) result.push({ ...node, text: node.text.slice(cut) });
            continue;
        }
        remaining = 0;
        result.push(node);
    }
    return result;
}
