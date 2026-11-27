import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { agentDocumentChange } from "../../../sources/surfaces/documents/agentDocumentChange.js";
import {
    DOCUMENT_FRAGMENT,
    documentEditor,
} from "../../../sources/surfaces/documents/documentEditor.js";
import {
    markdownToUpdate,
    readDocument,
} from "../../../sources/surfaces/documents/readDocument.js";

/**
 * Generated documents and Markdown, the same ones on every run. Set `DOCUMENT_ROUND_TRIP_SEED`
 * and `DOCUMENT_ROUND_TRIP_RUNS` to search further; a failure prints the smallest inputs found.
 */
const RUNS = Number(process.env["DOCUMENT_ROUND_TRIP_RUNS"] ?? 600);
let seed = Number(process.env["DOCUMENT_ROUND_TRIP_SEED"] ?? 20261124);
const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const some = <T>(most: number, make: () => T): T[] =>
    Array.from({ length: 1 + Math.floor(random() * most) }, make);

/** Text a person might type, weighted towards what Markdown reads as syntax. */
const TEXTS = [
    ..."alpha|beta|a_b_c|2*3|*|_|#|# x|-|- x|>|> q|\\|[x]|[x](y)|(|~~|~|<b>|&amp;|!|![a](b)".split(
        "|",
    ),
    ..."1.|1. x|1)|`|``|---|---  -|===|+|+ x|```|~~~|[ ]|[x] done|:|**b**|*i*|é|中文|\\*|\\\\".split(
        "|",
    ),
    ..."|,| a | b |,\t,  , ,\n,\n\n,x\n,\ny,\n* x,\n_ _ _,\n- - -,\n#,\n1.,\n>,a  b,end\\,    indented".split(
        ",",
    ),
    ..."http://a.b <http://a.b> * _".split(" "),
    ...[
        "\n| - |",
        "| a |\n| - |",
        "\n:-:",
        "\n---",
        "\n===",
        "\n\\",
        "\\\n",
        "a\n\n\nb",
        "\n ",
        " \n",
    ],
];
const STYLES = [
    {},
    {},
    {},
    { bold: true },
    { italic: true },
    { strike: true },
    { code: true },
    { bold: true, italic: true },
    { bold: true, strike: true },
    { underline: true },
];
const LIST_TYPES = ["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"];
const BLOCK_TYPES = [
    ...["paragraph", "paragraph", "paragraph", "heading", "quote", "codeBlock", "divider", "table"],
    ...LIST_TYPES,
];
type Styled = { type: "text"; text: string; styles: Record<string, unknown> };
type Inline = Styled | { type: "link"; href: string; content: Styled[] };
type Block = { type: string; props?: unknown; content?: unknown; children?: Block[] };

const styled = (): Styled => ({ type: "text", text: pick(TEXTS), styles: pick(STYLES) });
/** Link text is never code: the editor's code mark excludes every other one. */
const linked = (): Styled => ({
    ...styled(),
    styles: pick(STYLES.filter((style) => !("code" in style))),
});
const inline = (): Inline[] =>
    Array.from({ length: Math.floor(random() * 4) }, () =>
        random() < 0.1
            ? {
                  type: "link" as const,
                  href: pick(["https://x.y", "https://x.y/a b", "x(y)"]),
                  content: [linked()],
              }
            : styled(),
    );
/** Whether a block shows text in Markdown: spaces and line breaks alone show as nothing. */
const shows = (content: Inline[]) =>
    content.some((node) =>
        (node.type === "link" ? node.content : [node]).some((run) =>
            run.styles["code"] === true
                ? run.text.replaceAll("\n", "") !== ""
                : run.text.trim() !== "",
        ),
    );

/** One block as an editor could hold it, with blocks nested beneath it up to two levels down. */
function block(depth: number): Block {
    const type = pick(BLOCK_TYPES);
    if (type === "divider") return { type };
    if (type === "codeBlock")
        return {
            type,
            props: { language: pick(["text", "js"]) },
            content: [
                {
                    type: "text",
                    text: pick(["", "x", "x\n\ny", "\n", "```", "a\n", "\tx"]),
                    styles: {},
                },
            ],
        };
    if (type === "table")
        return {
            type,
            content: {
                type: "tableContent",
                rows: [{ cells: [inline(), inline()] }, { cells: [inline(), inline()] }],
            },
        };
    const content = inline();
    const children = depth < 2 && random() < 0.25 ? some(2, () => block(depth + 1)) : [];
    // CommonMark cannot nest a block that is not a list beneath a list item without text, so
    // such a block reads, and is written back, as the item's next sibling.
    const nests =
        !LIST_TYPES.includes(type) ||
        shows(content) ||
        LIST_TYPES.includes(children[0]?.type ?? "");
    return {
        type,
        props:
            type === "heading"
                ? { level: 1 + Math.floor(random() * 6) }
                : type === "checkListItem"
                  ? { checked: random() < 0.5 }
                  : {},
        content,
        children: nests ? children : [],
    };
}

const LINES = [
    ...["", "", "", " ", "  ", "\t", "text", "more text", "# h", "## h2 ##", "- a", "- b"],
    ...[
        "  - nested",
        "    - deep",
        "  para in item",
        "    code?",
        "1. one",
        "2. two",
        "   under one",
    ],
    ...[
        "- [ ] todo",
        "- [x] done",
        "- [ ]",
        "> quote",
        ">",
        "> - q item",
        "---",
        "***",
        "```",
        "```js",
    ],
    ...["~~~", "| a | b |", "| --- | --- |", "| 1 | 2 |", "|  | x |", "a  ", "a\\", "===", "Title"],
    ...[
        "<div>",
        "[ref]: /url",
        "*",
        "+ plus",
        "1) paren",
        "10. ten",
        "-",
        "- ",
        "#",
        "\\",
        "&#32;",
    ],
    ...["    indented code", "\tTabbed", "x\ty", "- a\n\n\n\n  b", "**b** *i* `c` ~~s~~", "[l](u)"],
    ...["![i](u)", "https://x.y", "a_b_c * d", "\r", "_ _ _", "* * *", "- - -", "a  \n* b"],
    ...[
        "a\\\n_ _ _",
        "a\\\n1. x",
        "a\\\n# x",
        "a\\\n> x",
        "a\\\n```",
        "[`c`](u)",
        "**`c`** x",
        "*a `c` b*",
        "**a *b* c**",
        "*a **b** c* d",
        "***a** b*",
        "**a ~~b~~**",
        "\\",
        "a\\",
        "  \\",
        "> a\n>\n> b",
        "> a\n> \\",
        ">\n> a",
        "- a\n  \\\n  b",
        "**a\nb**",
        "`a\nb`",
    ],
];
const markdown = (lineEnd = "\n") =>
    some(7, () => pick(LINES)).join(lineEnd) + pick(["", "\n", "\n\n", "\n\n\n"]);

const load = (state: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
};
const EMPTY = Y.encodeStateAsUpdate(new Y.Doc());
/** A document after an agent writes `text` against the version it read, and what it reads as. */
function write(state: Uint8Array, text: string): { state: Uint8Array; changed: boolean } {
    const doc = load(state);
    const change = agentDocumentChange(load(state), readDocument(state).root, text);
    if (change !== undefined) Y.applyUpdate(doc, change);
    return { state: Y.encodeStateAsUpdate(doc), changed: change !== undefined };
}
const created = (text: string) => readDocument(markdownToUpdate(text) ?? EMPTY).text;
/** Whether the Markdown writes a space as a character reference, which nobody should have to read. */
const spelled = (text: string) => /&#(?:32|9);/.test(text);

/** Whether a line outside a code block ends in a space or a tab, which nobody reading it sees. */
function trailing(text: string): boolean {
    let fence: string | undefined;
    return text.split("\n").some((line) => {
        const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence === undefined && mark !== undefined) fence = mark;
        else if (mark !== undefined && mark.startsWith(fence!) && line.trim() === mark)
            fence = undefined;
        return fence === undefined && /[ \t]$/.test(line);
    });
}
const smallest = (failures: string[]) => failures.sort((a, b) => a.length - b.length).slice(0, 5);

describe("document Markdown round trips", () => {
    it("changes nothing when an agent writes back what it read from any editor document", () => {
        const failures: string[] = [];
        for (let run = 0; run < RUNS; run += 1) {
            const blocks = some(3, () => block(0));
            const doc = new Y.Doc();
            blocksToYXmlFragment(
                documentEditor(),
                blocks as never,
                doc.getXmlFragment(DOCUMENT_FRAGMENT),
            );
            const state = Y.encodeStateAsUpdate(doc);
            const { text, outsideModel } = readDocument(state);
            const again = write(state, text);
            if (outsideModel || again.changed || trailing(text) || spelled(text))
                failures.push(
                    `${JSON.stringify(blocks)} read ${JSON.stringify(text)}, then ${JSON.stringify(readDocument(again.state).text)}`,
                );
        }
        expect(smallest(failures)).toEqual([]);
    }, 600_000);

    it("reads any Markdown an agent writes the way a new document with it reads, and stably", () => {
        const failures: string[] = [];
        for (let run = 0; run < RUNS; run += 1) {
            const text = markdown(pick(["\n", "\n", "\r\n"]));
            const written = write(EMPTY, text);
            const read = readDocument(written.state);
            if (
                read.outsideModel ||
                read.text !== created(text) ||
                write(written.state, read.text).changed ||
                trailing(read.text) ||
                // Formatting an agent wrote as Markdown can always be shown as Markdown.
                read.omitted.includes("some formatting")
            )
                failures.push(
                    `${JSON.stringify(text)} read ${JSON.stringify(read.text)}, new ${JSON.stringify(created(text))}`,
                );
        }
        expect(smallest(failures)).toEqual([]);
    }, 600_000);

    it("turns any document into what the agent wrote, whatever it held before", () => {
        const failures: string[] = [];
        for (let run = 0; run < RUNS; run += 1) {
            const before = readDocument(write(EMPTY, markdown()).state);
            const state = Y.encodeStateAsUpdate(load(markdownToUpdate(before.text) ?? EMPTY));
            const lines = before.text.split("\n");
            const at = Math.floor(random() * (lines.length + 1));
            const edit = pick(["rewrite", "delete", "insert", "replace"] as const);
            if (edit === "delete") lines.splice(at, 1 + Math.floor(random() * 2));
            if (edit === "insert") lines.splice(at, 0, ...markdown().split("\n"));
            if (edit === "replace") lines.splice(at, 1, pick(LINES));
            const text = edit === "rewrite" ? markdown() : lines.join("\n");
            const read = readDocument(write(state, text).state);
            if (read.outsideModel || read.text !== created(text))
                failures.push(
                    `${JSON.stringify(before.text)} with ${JSON.stringify(text)} read ${JSON.stringify(read.text)}, new ${JSON.stringify(created(text))}`,
                );
        }
        expect(smallest(failures)).toEqual([]);
    }, 600_000);
});
