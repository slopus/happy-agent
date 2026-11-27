import {
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ArtifactsModule } from "../../../sources/artifacts/index.js";
import type { BotsModule } from "../../../sources/bots/index.js";
import type { ComputeModule } from "../../../sources/compute/index.js";
import type { ConfigModule } from "../../../sources/config/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import type { RunnersModule } from "../../../sources/runners/index.js";
import {
    DOCUMENT_FRAGMENT,
    documentEditor,
} from "../../../sources/surfaces/documents/documentEditor.js";
import { SurfacesModule } from "../../../sources/surfaces/index.js";
import { SurfacesPersistence } from "../../../sources/surfaces/persistence/SurfacesPersistence.js";
import type { TasksModule } from "../../../sources/tasks/index.js";
import type { TeamModule } from "../../../sources/team/index.js";
import { moduleDatabase } from "../../support/moduleDatabase.js";

type Block = { id: string; type: string; content: unknown; children: Block[] };
type Written = { document: { seq: number; text: string }; changed: boolean };

const close: (() => void)[] = [];
afterEach(() => {
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

/**
 * The real Surfaces module over an in-memory database, driven the way an agent and a person
 * drive it: the agent through its document tools, the person through the Yjs changes an editor
 * sends.
 */
async function desk() {
    const durable = new DurableFunctionsModule();
    const surfaces = new SurfacesModule(
        durable,
        {
            enabled: true,
            getUser: async (_ctx: unknown, id: string) => ({ id, authentication: "jwt" }),
        } as unknown as TeamModule,
        { forAgent: async () => undefined } as unknown as BotsModule,
        { get: async () => undefined } as unknown as TasksModule,
        { get: async () => undefined } as unknown as ArtifactsModule,
        {
            resolve: async () => ({}),
            shouldReviewPath: async () => false,
        } as unknown as ComputeModule,
        {} as ConfigModule,
        { localExecution: true } as RunnersModule,
    );
    const db = moduleDatabase(
        [...durable.migrations, ...surfaces.migrations],
        "document-round-trip-test",
    );
    ensureAgentDatabaseConnection(db.database);
    close.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    const ctx = db.context;
    const hooks = surfaces.beforeStart(ctx, {} as AgentSystemRef);
    const kv = new SurfacesPersistence(db.database).kv();
    const scope = { agent: { id: "writer" }, kv: kv.scoped("writer") } as AgentModuleScope;
    await scope.kv.write(ctx, "owner", "alice");
    const tools = await hooks.tools!(ctx, scope);
    const call = (name: string, input: Record<string, unknown>) =>
        tools.find((tool) => tool.name === name)!.execute(ctx, input as never, {} as never);
    const person = { userId: "alice", agentId: null };
    const state = async (surfaceId: string) => {
        const doc = new Y.Doc();
        const { update } = await surfaces.documentState(ctx, surfaceId, {});
        Y.applyUpdate(doc, Buffer.from(update, "base64"));
        return doc;
    };
    /** One Yjs change to the document, sent the way a person's editor sends it. */
    const change = async (surfaceId: string, edit: (fragment: Y.XmlFragment) => void) => {
        const doc = await state(surfaceId);
        const vector = Y.encodeStateVector(doc);
        doc.transact(() => edit(doc.getXmlFragment(DOCUMENT_FRAGMENT)));
        await surfaces.changeDocument(
            ctx,
            surfaceId,
            Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64"),
            person,
            null,
        );
    };
    return {
        call,
        /** A document Surface as a person makes one, optionally with initial Markdown. */
        create: async (text?: string) =>
            (
                await surfaces.create(
                    ctx,
                    { type: "document", name: "Notes", ...(text === undefined ? {} : { text }) },
                    "alice",
                    undefined,
                    person,
                )
            ).id,
        read: async (surfaceId: string) =>
            ((await call("read_document", { surfaceId })) as Written).document,
        update: (surfaceId: string, seq: number, text: string) =>
            call("update_document", { surfaceId, seq, text }) as Promise<Written>,
        edit: (surfaceId: string, old_string: string, new_string: string, replace_all?: boolean) =>
            call("edit_document", {
                surfaceId,
                old_string,
                new_string,
                ...(replace_all === undefined ? {} : { replace_all }),
            }),
        tool: (name: string) => tools.find((tool) => tool.name === name)!,
        ctx,
        /** Replace the document's blocks as a person's editor would, in one Yjs change. */
        type: (surfaceId: string, blocks: unknown[]) =>
            change(surfaceId, (fragment) => {
                fragment.delete(0, fragment.length);
                blocksToYXmlFragment(documentEditor(), blocks as never, fragment);
            }),
        change,
        blocks: async (surfaceId: string) =>
            yXmlFragmentToBlocks(
                documentEditor(),
                (await state(surfaceId)).getXmlFragment(DOCUMENT_FRAGMENT),
            ) as unknown as Block[],
    };
}

const text = (value: string, styles: Record<string, unknown> = {}) => ({
    type: "text",
    text: value,
    styles,
});
const link = (value: string) => ({ type: "link", href: "https://x.y", content: [text(value)] });
const block = (type: string, value = "", props: Record<string, unknown> = {}, children = []) => ({
    type,
    props,
    content: value === "" ? [] : [text(value)],
    children,
});
const p = (value = "", children: unknown[] = []) => ({
    ...block("paragraph", value),
    children,
});
const bullet = (value = "", children: unknown[] = []) => ({
    ...block("bulletListItem", value),
    children,
});

/**
 * Markdown an agent writes into a document, and the literal Markdown the document then reads as.
 * Writing what was read must change nothing, whatever the case.
 */
const WRITTEN: [name: string, written: string, reads: string][] = [
    ["plain paragraphs", "First.\n\nSecond.\n", "First.\n\nSecond.\n"],
    ["text without a final newline", "Only line", "Only line\n"],
    ["whitespace-only text", "   \n\t\n", ""],
    ["one stray blank line adds nothing", "a\n\n\nb\n", "a\n\nb\n"],
    ["one leading newline adds nothing", "\na\n", "a\n"],
    ["one extra final newline adds nothing", "a\n\n", "a\n"],
    ["three blank lines are one empty paragraph", "a\n\n\n\nb\n", "a\n\n\n\nb\n"],
    ["four blank lines are still one", "a\n\n\n\n\nb\n", "a\n\n\n\nb\n"],
    ["five blank lines are two", "a\n\n\n\n\n\nb\n", "a\n\n\n\n\n\nb\n"],
    ["an empty paragraph at the start", "\n\na\n", "\n\na\n"],
    ["an empty paragraph at the end", "a\n\n\n", "a\n\n\n"],
    ["two empty paragraphs at the end", "a\n\n\n\n\n", "a\n\n\n\n\n"],
    ["only empty paragraphs", "\n\n\n", "\n\n\n"],
    ["whitespace-only lines count as blank", "a\n \n\t\n  \nb\n", "a\n\n\n\nb\n"],
    ["CRLF blank runs", "a\r\n\r\n\r\n\r\nb\r\n", "a\n\n\n\nb\n"],
    ["CRLF line ends", "a\r\n\r\nb\r\n", "a\n\nb\n"],
    ["trailing spaces on a line", "a   \n\nb \n", "a\n\nb\n"],
    [
        "a newline inside a paragraph is a line break",
        "first line\nsecond line\n",
        "first line\nsecond line\n",
    ],
    ["trailing spaces before a newline add nothing", "a  \nb   \n", "a\nb\n"],
    ["a backslash before a newline adds nothing", "a\\\nb\n", "a\nb\n"],
    [
        "an empty line inside a paragraph and a list item",
        "a\n\\\nb\n\n- x\n  \\\n  y\n\nback\\\\\nslash\n",
        "a\n\\\nb\n\n- x\n  \\\n  y\n\nback\\\\\nslash\n",
    ],
    ["an empty line that starts a paragraph", "\\\na\n", "\\\na\n"],
    ["empty lines that end a paragraph", "a\n\\\n\\\n\nb\n", "a\n\\\n\\\n\nb\n"],
    ["a paragraph that is one backslash is an empty paragraph", "a\n\n\\\n\nb\n", "a\n\n\n\nb\n"],
    [
        "a list item that is one backslash, with a paragraph beneath it",
        "-\n  \\\n\n  beneath\n",
        "-\n\nbeneath\n",
    ],
    ["a list item continued on the next line", "- a\n  b\n- c\n", "- a\n  b\n- c\n"],
    [
        "a quote, a divider and an image",
        "> quoted\n> more\n\n---\n\n![a cat](https://img/cat.png)\n",
        "> quoted\n> more\n\n---\n\n![a cat](https://img/cat.png)\n",
    ],
    [
        "emphasis across a line break, and a link written once on each line",
        "**a\nb** [c\nd](https://x.y)\n",
        "**a\nb** [c](https://x.y)\n[d](https://x.y)\n",
    ],
    [
        "a line break in a heading and a table cell cannot be written",
        "# a\\\n\n| a |\n| --- |\n| 1 |\n",
        "# a\\\\\n\n| a |\n| --- |\n| 1 |\n",
    ],
    ["a code block keeps its blank lines", "```js\nx\n\n\n\ny\n```\n", "```js\nx\n\n\n\ny\n```\n"],
    ["a code block of only blank lines", "```\n\n\n\n```\n", "```\n\n\n\n```\n"],
    ["a code block between paragraphs", "a\n\n```\nx\n```\n\nb\n", "a\n\n```\nx\n```\n\nb\n"],
    ["an indented code block", "a\n\n    x\n\n\n    y\n", "a\n\n```\nx\n\n\ny\n```\n"],
    ["a tight bullet list", "- a\n- b\n", "- a\n- b\n"],
    ["a loose bullet list reads tight", "- a\n\n- b\n", "- a\n- b\n"],
    ["an empty paragraph between list items", "- a\n\n\n\n- b\n", "- a\n\n\n\n- b\n"],
    ["a nested list", "- a\n  - b\n    - c\n- d\n", "- a\n  - b\n    - c\n- d\n"],
    [
        "a list item with a paragraph beneath it",
        "- a\n\n  beneath\n- b\n",
        "- a\n\n  beneath\n- b\n",
    ],
    [
        "bullets, numbers, and checks mixed",
        "- a\n  1. one\n  2. two\n- [ ] todo\n- [x] done\n\n1. first\n",
        "- a\n  1. one\n  2. two\n- [ ] todo\n- [x] done\n\n1. first\n",
    ],
    ["a numbered list", "1. a\n2. b\n3. c\n", "1. a\n2. b\n3. c\n"],
    ["a check list", "- [ ] open\n- [x] done\n", "- [ ] open\n- [x] done\n"],
    [
        "a table with empty cells",
        "| A | B |\n| --- | --- |\n|  | x |\n| y |  |\n",
        "| A | B |\n| --- | --- |\n|  | x |\n| y |  |\n",
    ],
    [
        "a table as the first block",
        "| A |\n| --- |\n| 1 |\n\nafter\n",
        "| A |\n| --- |\n| 1 |\n\nafter\n",
    ],
    [
        "a table as the last block",
        "before\n\n| A |\n| --- |\n| 1 |\n",
        "before\n\n| A |\n| --- |\n| 1 |\n",
    ],
    [
        "a table between empty paragraphs",
        "a\n\n\n\n| A |\n| --- |\n| 1 |\n\n\n\nb\n",
        "a\n\n\n\n| A |\n| --- |\n| 1 |\n\n\n\nb\n",
    ],
    [
        "headings at every level",
        "# 1\n## 2\n### 3\n#### 4\n##### 5\n###### 6\n",
        "# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6\n",
    ],
    ["a setext heading", "Title\n=====\n\nbody\n", "# Title\n\nbody\n"],
    [
        "links",
        "[site](https://example.com/a_b?c=1) and <https://example.com>\n",
        "[site](https://example.com/a_b?c=1) and [https://example.com](https://example.com)\n",
    ],
    [
        "emphasis and code",
        "**bold** *italic* ~~struck~~ `code` ***both***\n",
        "**bold** *italic* ~~struck~~ `code` ***both***\n",
    ],
    [
        "escaped characters",
        "\\# not a heading\n\n1\\. not a list\n\n\\*not emphasis\\* a_b_c 2 * 3\n",
        "\\# not a heading\n\n1\\. not a list\n\n\\*not emphasis\\* a_b_c 2 * 3\n",
    ],
    ["an empty check item", "- [ ]\n- [x] done\n", "- [ ]\n- [x] done\n"],
    [
        "list items without text",
        "-\n- [ ]\n- [x]\n- [ ] next\n\n1.\n2. two\n",
        "-\n- [ ]\n- [x]\n- [ ] next\n\n1.\n2. two\n",
    ],
    ["list items that are a marker and a space", "- [ ] \n- \n\n1. \n", "- [ ]\n-\n\n1.\n"],
    ["italic inside bold", "**Note: *important* thing**\n", "**Note: *important* thing**\n"],
    ["bold inside italic", "*a **b** c*\n", "*a **b** c*\n"],
    ["struck text inside bold", "**bold and ~~struck~~ text**\n", "**bold and ~~struck~~ text**\n"],
    [
        "emphasis that starts or ends inside other emphasis",
        "***a** b* and **a *b*** and ***a* b**\n",
        "***a** b* and **a *b*** and ***a* b**\n",
    ],
    [
        "nested emphasis in a list item, a heading, and a table cell",
        "- **a *b* c**\n\n# **a *b* c**\n\n| **a *b* c** |\n| --- |\n| 1 |\n",
        "- **a *b* c**\n\n# **a *b* c**\n\n| **a *b* c** |\n| --- |\n| 1 |\n",
    ],
    [
        "bold around a link",
        "**a [link](https://x.y) c**\n",
        "**a** [**link**](https://x.y) **c**\n",
    ],
    ["an empty quote", "a\n\n>\n\nb\n", "a\n\n>\n\nb\n"],
    [
        "a heading that starts like a list",
        "## 1. Setup\n\n# - not a list\n",
        "## 1. Setup\n\n# - not a list\n",
    ],
    ["a heading that is a number sign", "# \\#\n", "# \\#\n"],
    [
        "a table cell with a number sign and a pipe",
        "| # | a \\| b |\n| --- | --- |\n| 1. x | - y |\n",
        "| # | a \\| b |\n| --- | --- |\n| 1. x | - y |\n",
    ],
    [
        "a code span with a pipe in a table cell",
        "| `a\\|b` |\n| --- |\n| 1 |\n",
        "| `a\\|b` |\n| --- |\n| 1 |\n",
    ],
    ["tabs in text and code", "a\tb\n\n```\n\tx\n```\n", "a\tb\n\n```\n\tx\n```\n"],
    ["a line break at the end of a block", "a\\\n\nb  \n", "a\\\\\n\nb\n"],
    [
        "a link whose text is code",
        "See [`run()`](https://example.com) and **`bold code`** and *a `b` c*.\n",
        "See [run()](https://example.com) and `bold code` and *a* `b` *c*.\n",
    ],
    ["a quote with an empty line", "> one\n>\n> two\n", "> one\n>\n> two\n"],
    ["two quotes", "> one\n\n> two\n", "> one\n\n> two\n"],
    ["a quote that starts and ends with an empty line", ">\n> q\n>\n", ">\n> q\n>\n"],
    ["a divider", "a\n\n---\n\nb\n", "a\n\n---\n\nb\n"],
    ["HTML stays text", "<b>bold</b>\n", "\\<b>bold\\</b>\n"],
    ["spaces written as character references at a block's edges", "&#32;a&#32;\n", "a\n"],
    ["spaces only", "   ", ""],
];

/** Documents as a person leaves them in the editor, and the literal Markdown they read as. */
const TYPED: [name: string, blocks: unknown[], reads: string][] = [
    ["one empty paragraph", [p()], ""],
    ["text then Enter", [p("yo"), p()], "yo\n\n\n"],
    [
        "empty paragraphs around text",
        [p(), p("a"), p(), p(), p("b"), p()],
        "\n\na\n\n\n\n\n\nb\n\n\n",
    ],
    ["only empty paragraphs", [p(), p(), p()], "\n\n\n\n\n"],
    ["an empty paragraph between list items", [bullet("a"), p(), bullet("b")], "- a\n\n\n\n- b\n"],
    [
        "an empty paragraph beneath a list item",
        [bullet("a", [p(), bullet("b")]), p("c")],
        "- a\n\n\n\n  - b\n\nc\n",
    ],
    [
        "an empty paragraph nested beneath a paragraph",
        [p("a", [p(), p("b")]), p("c")],
        "a\n\n\n\nb\n\nc\n",
    ],
    ["an empty heading", [block("heading", "", { level: 2 }), p("a")], "##\n\na\n"],
    ["an empty bullet", [bullet(), bullet("a")], "-\n- a\n"],
    ["an empty numbered item", [block("numberedListItem"), p("a")], "1.\n\na\n"],
    ["an empty code block", [{ type: "codeBlock", content: [] }, p("a")], "```\n\n```\n\na\n"],
    ["an empty check item", [block("checkListItem"), p("a")], "- [ ]\n\na\n"],
    ["an empty quote", [block("quote"), p("a")], ">\n\na\n"],
    [
        "line breaks that end a block",
        [p("a\n"), bullet("b\n\n"), p("c")],
        "a\n\\\n\n- b\n  \\\n  \\\n\nc\n",
    ],
    ["a line break", [p("first\nsecond")], "first\nsecond\n"],
    [
        "line breaks at the start and end of a paragraph and in a row",
        [p("\na"), p("a\n"), p("a\n\n\nb"), p("\n")],
        "\\\na\n\na\n\\\n\na\n\\\n\\\nb\n\n\n",
    ],
    [
        "empty lines inside a list item and a quote",
        [bullet("x\n\ny"), block("numberedListItem", "n\n"), block("quote", "q\n\nr")],
        "- x\n  \\\n  y\n\n1. n\n   \\\n\n> q\n>\n> r\n",
    ],
    [
        "code and bold text holding a line break",
        [
            {
                ...p(),
                content: [text("a\nb", { code: true }), text(" "), text("c\nd", { bold: true })],
            },
        ],
        "`a`\n`b` **c\nd**\n",
    ],
    [
        "a line break in a heading and a table cell",
        [
            block("heading", "a\nb", { level: 2 }),
            {
                type: "table",
                content: {
                    type: "tableContent",
                    rows: [{ cells: [[text("x\ny")]] }, { cells: [[text("1")]] }],
                },
            },
        ],
        "## a b\n\n| x y |\n| --- |\n| 1 |\n",
    ],
    [
        "a table row and its rule typed into one paragraph",
        [p("| a |\n| --- |\n| 1 |"), p("a\n---"), p("a\n===")],
        "| a |\n\\| --- |\n| 1 |\n\na\n\\---\n\na\n\\===\n",
    ],
    ["a paragraph of one line break", [p("a"), p("\n"), p("b")], "a\n\n\n\nb\n"],
    [
        "text an underline splits",
        [{ ...p(), content: [text("a"), text("_", { underline: true }), text("b")] }],
        "a_b\n",
    ],
    ["an empty bullet above a nested bullet", [bullet("", [bullet("x")])], "-\n  - x\n"],
    ["an empty bullet beneath a bullet", [bullet("a", [bullet()]), p("b")], "- a\n\n  -\n\nb\n"],
    [
        "an empty paragraph that ends a list item",
        [bullet("a", [p()]), bullet("b")],
        "- a\n\n\n\n- b\n",
    ],
    ["spaced dashes", [p("---  -")], "\\---  -\n"],
    ["a star after a line break", [p("a\n* b")], "a\n\\* b\n"],
    [
        "spaced underscores after a line break",
        [p("a\n_ _ _"), p("a\n_ _ _\nb")],
        "a\n_ _ \\_\n\na\n\\_ _ _\nb\n",
    ],
    ["a heading that is a number sign", [block("heading", "#", { level: 2 })], "## \\#\n"],
    [
        "a code span with a pipe in a table cell",
        [
            {
                type: "table",
                content: {
                    type: "tableContent",
                    rows: [{ cells: [[text("a|b", { code: true })]] }, { cells: [[text("1")]] }],
                },
            },
        ],
        "| `a\\|b` |\n| --- |\n| 1 |\n",
    ],
    [
        "bold that ends in a space",
        [
            {
                ...p(),
                content: [text("word ", { bold: true }), text("next"), text(" x ", { code: true })],
            },
        ],
        "**word** next`  x  `\n",
    ],
    [
        "code that starts with a space, and code that is one",
        [
            {
                ...p(),
                content: [text(" lead", { code: true }), text("a"), text(" ", { code: true })],
            },
        ],
        "` lead`a` `\n",
    ],
    [
        "bold text with an italic word, and the other way round",
        [
            {
                ...p(),
                content: [
                    text("a ", { bold: true }),
                    text("b", { bold: true, italic: true }),
                    text(" c", { bold: true }),
                ],
            },
            {
                ...p(),
                content: [text("a", { bold: true, italic: true }), text(" b", { italic: true })],
            },
        ],
        "**a *b* c**\n\n***a** b*\n",
    ],
    [
        "bold and italic that overlap",
        [
            {
                ...p(),
                content: [
                    text("a ", { bold: true }),
                    text("b", { bold: true, italic: true }),
                    text(" c", { italic: true }),
                ],
            },
        ],
        "**a** ***b*** *c*\n",
    ],
    [
        "spaces formatted two ways between two kinds of emphasis",
        [
            {
                ...p(),
                content: [
                    text("x ", { bold: true, strike: true }),
                    text("  ", { strike: true }),
                    text("b", { bold: true, italic: true }),
                ],
            },
        ],
        "**~~x~~   *b***\n",
    ],
    ["a carriage return in text", [p("x\ry")], "x&#13;y\n"],
    ["leading and trailing spaces", [p("  a  ")], "a\n"],
    ["a paragraph of spaces is an empty paragraph", [p("a"), p("   "), p("b")], "a\n\n\n\nb\n"],
    [
        "spaces around a paragraph's lines",
        [p("  leading"), p("trailing  "), p("    four spaces"), p("a\n  b  \nc"), p("x\r\ny")],
        "leading\n\ntrailing\n\nfour spaces\n\na\nb\nc\n\nx\ny\n",
    ],
    [
        "spaces around the text of a heading, list items and table cells",
        [
            block("heading", " T ", { level: 2 }),
            bullet(" a "),
            block("numberedListItem", " n"),
            block("checkListItem", "c ", { checked: true }),
            bullet("x\n\ny"),
            {
                type: "table",
                content: {
                    type: "tableContent",
                    rows: [
                        { cells: [[text(" a ")], [text("b ")]] },
                        { cells: [[text(" 1")], [text("2")]] },
                    ],
                },
            },
        ],
        "## T\n\n- a\n\n1. n\n\n- [x] c\n- x\n  \\\n  y\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    ],
    [
        "a mark that starts or ends with a space",
        [
            { ...p(), content: [text(" bold", { bold: true })] },
            { ...p(), content: [text("a"), text(" b ", { bold: true }), text("c")] },
            { ...p(), content: [text(" s ", { strike: true })] },
            { ...p(), content: [text("i ", { italic: true }), text("next")] },
        ],
        "**bold**\n\na **b** c\n\n~~s~~\n\n*i* next\n",
    ],
    [
        "a line of spaces inside a block is an empty line",
        [p("a\n \nb"), block("quote", "q\n  \nr"), bullet(" \n ")],
        "a\n\\\nb\n\n> q\n>\n> r\n\n-\n",
    ],
    [
        "links to one place on two lines, and in a table cell",
        [
            { ...p(), content: [link("a"), text("\n "), link("b")] },
            {
                type: "table",
                content: {
                    type: "tableContent",
                    rows: [{ cells: [[link("a"), text("\n "), link("b")]] }, { cells: [[]] }],
                },
            },
        ],
        "[a](https://x.y)\n[b](https://x.y)\n\n| [a ](https://x.y) [b](https://x.y) |\n| --- |\n|  |\n",
    ],
    [
        "spaces between two marked runs stay",
        [
            { ...p(), content: [text("a ", { bold: true }), text(" b", { italic: true })] },
            {
                ...p(),
                content: [text("a", { bold: true }), text(" "), text("b", { italic: true })],
            },
            {
                ...p(),
                content: [text(" a", { bold: true }), text("  "), text("b ", { code: true })],
            },
        ],
        "**a**  *b*\n\n**a** *b*\n\n**a**  `b `\n",
    ],
    ["text that looks like a blank-line run", [p("a\n\n\nb")], "a\n\\\n\\\nb\n"],
    [
        "a table with an empty header",
        [
            {
                type: "table",
                content: {
                    type: "tableContent",
                    rows: [{ cells: [[], []] }, { cells: [[text("x")], []] }],
                },
            },
        ],
        "|  |  |\n| --- | --- |\n| x |  |\n",
    ],
];

/**
 * One exact replacement in a document: what it read as, the edit, and what it reads as after.
 * A null result means the edit is refused with that message and the document stays as it was.
 */
const EDITED: [
    name: string,
    before: string,
    edit: [old: string, fresh: string, all?: boolean],
    after: string | { refused: string },
    result?: { changed: boolean; replacements: number },
][] = [
    [
        "one word",
        "# Plan\n\nShip on Monday.\n",
        ["Monday", "Friday"],
        "# Plan\n\nShip on Friday.\n",
    ],
    [
        "a new block after a line",
        "# Plan\n\nFirst.\n",
        ["First.\n", "First.\n\n- [ ] Second\n"],
        "# Plan\n\nFirst.\n\n- [ ] Second\n",
    ],
    [
        "a block removed with its blank line",
        "one\n\ntwo\n\nthree\n",
        ["two\n\n", ""],
        "one\n\nthree\n",
    ],
    ["empty paragraphs removed", "one\n\n\n\n\n\ntwo\n", ["\n\n\n\n\n\n", "\n\n"], "one\n\ntwo\n"],
    ["an empty paragraph added", "one\n\ntwo\n", ["one\n\n", "one\n\n\n\n"], "one\n\n\n\ntwo\n"],
    [
        "every occurrence",
        "- a cat\n- a dog\n\nA cat and a dog.\n",
        ["a ", "the ", true],
        "- the cat\n- the dog\n\nA cat and the dog.\n",
        { changed: true, replacements: 3 },
    ],
    [
        "a table cell",
        "| Name | Role |\n| --- | --- |\n| Ada | Dev |\n",
        ["| Ada | Dev |", "| Ada | Lead |\n| Bo | Dev |"],
        "| Name | Role |\n| --- | --- |\n| Ada | Lead |\n| Bo | Dev |\n",
    ],
    [
        "text with replacement patterns kept literal",
        "Price: X\n",
        ["X", "$& and $1"],
        "Price: $& and $1\n",
    ],
    [
        "Markdown that reads back the same",
        "one\n\ntwo\n",
        ["one\n\ntwo", "one\n\n\ntwo"],
        "one\n\ntwo\n",
        { changed: false, replacements: 1 },
    ],
    [
        "text that is not there",
        "one\n",
        ["two", "three"],
        { refused: "This text does not appear in the document." },
    ],
    [
        "text that appears twice",
        "a cat, a dog\n",
        ["a ", "the "],
        {
            refused:
                "This text appears 2 times in the document. Add surrounding context to make it unique, or replace every occurrence.",
        },
    ],
    [
        "a replacement that is the same text",
        "one\n",
        ["one", "one"],
        { refused: "The replacement is identical to the text it replaces." },
    ],
    [
        "nothing to replace",
        "one\n",
        ["", "two"],
        {
            refused:
                "old_string is empty; name the text to replace, or write the whole document with update_document.",
        },
    ],
    [
        "an empty document",
        "",
        ["one", "two"],
        { refused: "This text does not appear in the document." },
    ],
];

describe("document tools round-trip Markdown", () => {
    it.each(EDITED)("agent edits %s", async (_name, before, [old, fresh, all], after, result) => {
        const t = await desk();
        const surfaceId = await t.create(before);
        const seq = (await t.read(surfaceId)).seq;
        if (typeof after !== "string") {
            await expect(t.edit(surfaceId, old, fresh, all)).rejects.toMatchObject({
                code: "invalid_request",
                message: after.refused,
            });
            expect(await t.read(surfaceId)).toMatchObject({ text: before, seq });
            return;
        }
        const expected = result ?? { changed: true, replacements: 1 };
        expect(await t.edit(surfaceId, old, fresh, all)).toEqual({
            ...expected,
            seq: expected.changed ? seq + 1 : seq,
        });
        expect((await t.read(surfaceId)).text).toBe(after);
    });

    it("edits one block and leaves the others, and what Markdown cannot show, as they were", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [
            block("heading", "Plan", { level: 1, textColor: "red" }),
            p(),
            { ...p(), content: [text("Ship on "), text("Monday", { underline: true }), text(".")] },
            p("Parent", [p("Nested beneath a paragraph")]),
        ]);
        const before = await t.blocks(surfaceId);
        expect(await t.edit(surfaceId, "Ship on", "We ship on")).toEqual({
            seq: 2,
            changed: true,
            replacements: 1,
        });
        const after = await t.blocks(surfaceId);
        expect(after[2]).toMatchObject({
            id: before[2]!.id,
            content: [
                { text: "We ship on " },
                { text: "Monday", styles: { underline: true } },
                { text: "." },
            ],
        });
        expect([after[0], after[1], after[3]]).toEqual([before[0], before[1], before[3]]);
    });

    it("refuses an edit to a document holding content outside the content model", async () => {
        const t = await desk();
        const surfaceId = await t.create("Kept\n");
        await t.change(surfaceId, (fragment) => {
            const container = new Y.XmlElement("blockContainer");
            container.insert(0, [new Y.XmlElement("futureBlock")]);
            (fragment.get(0) as Y.XmlElement).insert(1, [container]);
        });
        await expect(t.edit(surfaceId, "Kept", "Replaced")).rejects.toMatchObject({
            code: "invalid_request",
            message: expect.stringContaining("cannot represent"),
        });
        expect(await t.read(surfaceId)).toMatchObject({ text: "Kept\n", seq: 2 });
    });

    it("reviews an edit as a shared write that needs no filesystem access", async () => {
        const t = await desk();
        const edit = t.tool("edit_document");
        expect(edit.defer).toBe(true);
        expect(edit.durable).toBe(true);
        expect(edit.transactional).toBe(true);
        expect(edit.requiresAutoOrFullAccess).toBe(true);
        expect(edit.shouldReviewInAutoMode!({}, t.ctx)).toBe(true);
        expect(edit.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(edit.describeAutoPermissionAction!({ surfaceId: "s1" }, t.ctx)).toBe(
            'editing the shared document in Surface "s1" while preserving history. Access: shared data write; no filesystem access',
        );
        expect(t.tool("update_document").description).toContain("use edit_document instead");
    });

    it("records an edit as the agent's change for the person it works for", async () => {
        const t = await desk();
        const surfaceId = await t.create("one\n");
        await t.edit(surfaceId, "one", "two");
        expect(await t.call("list_document_versions", { surfaceId })).toMatchObject({
            updates: [
                { seq: 1 },
                { seq: 2, source: "tool", actor: { userId: "alice", agentId: "writer" } },
            ],
        });
    });

    it("writes into a document nobody has edited", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        expect(await t.read(surfaceId)).toMatchObject({ text: "", seq: 0 });
        expect(await t.update(surfaceId, 0, "Draft from notes.\n")).toMatchObject({
            changed: true,
            document: { seq: 1, text: "Draft from notes.\n" },
        });
    });

    it("takes out the empty paragraphs an agent removes and keeps every other block", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [
            block("heading", "lol", { level: 1 }),
            p(),
            p(),
            p("Team"),
            p(),
            block("heading", "Bots", { level: 2 }),
            bullet("one"),
            p(),
        ]);
        const before = await t.blocks(surfaceId);
        const read = await t.read(surfaceId);
        expect(read.text).toBe("# lol\n\n\n\n\n\nTeam\n\n\n\n## Bots\n\n- one\n\n\n");
        const written = await t.update(surfaceId, read.seq, "# lol\n\nTeam\n\n## Bots\n\n- one\n");
        expect(written).toMatchObject({
            changed: true,
            document: { text: "# lol\n\nTeam\n\n## Bots\n\n- one\n" },
        });
        expect((await t.blocks(surfaceId)).map((entry) => entry.id)).toEqual(
            [0, 3, 5, 6].map((index) => before[index]!.id),
        );
    });

    it("leaves no empty paragraph behind when an agent rewrites the whole document", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [p("yo"), p()]);
        const read = await t.read(surfaceId);
        expect(read.text).toBe("yo\n\n\n");
        const rewritten = "Notes, not decisions.\n\n## Goals\n\n- Ship it\n";
        expect((await t.update(surfaceId, read.seq, rewritten)).document.text).toBe(rewritten);
    });

    it("writes into a document again after clearing it", async () => {
        const t = await desk();
        const surfaceId = await t.create("Draft from notes.\n");
        expect(await t.update(surfaceId, 1, "")).toMatchObject({
            changed: true,
            document: { seq: 2, text: "" },
        });
        expect(await t.update(surfaceId, 2, "")).toMatchObject({
            changed: false,
            document: { seq: 2, text: "" },
        });
        expect(await t.update(surfaceId, 2, "# Second draft\n")).toMatchObject({
            changed: true,
            document: { seq: 3, text: "# Second draft\n" },
        });
    });

    it("adds an empty paragraph and keeps a kept one where and what it was", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [p("a"), p(), p("b"), p("c")]);
        const before = await t.blocks(surfaceId);
        const written = await t.update(surfaceId, 1, "a, edited\n\n\n\nb\n\n\n\nc\n");
        expect(written.document.text).toBe("a, edited\n\n\n\nb\n\n\n\nc\n");
        const after = await t.blocks(surfaceId);
        expect(after.map((entry) => entry.content)).toMatchObject([
            [{ text: "a, edited" }],
            [],
            [{ text: "b" }],
            [],
            [{ text: "c" }],
        ]);
        expect([0, 1, 2, 4].map((index) => after[index]!.id)).toEqual(
            before.map((entry) => entry.id),
        );
    });

    it("does not let an empty paragraph that stays adopt the block after it", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [p("x"), p()]);
        const written = await t.update(surfaceId, 1, "- a\n\n\n\n  beneath a\n");
        expect(written.document.text).toBe("- a\n\n\n\n  beneath a\n");
        expect(await t.blocks(surfaceId)).toMatchObject([
            { type: "bulletListItem", children: [{ content: [] }, { type: "paragraph" }] },
        ]);
    });

    it("keeps an empty paragraph a person added after the agent read", async () => {
        const t = await desk();
        const surfaceId = await t.create("a\n\nb\n");
        // Enter at the end of the first paragraph.
        await t.change(surfaceId, (fragment) => {
            const container = new Y.XmlElement("blockContainer");
            container.setAttribute("id", "typed");
            container.insert(0, [new Y.XmlElement("paragraph")]);
            (fragment.get(0) as Y.XmlElement).insert(1, [container]);
        });
        expect((await t.update(surfaceId, 1, "a\n\nb, edited\n")).document).toMatchObject({
            seq: 3,
            text: "a\n\n\n\nb, edited\n",
        });
    });

    it("puts a new first block first", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [p("one"), p("two")]);
        expect((await t.update(surfaceId, 1, "zero\n\none\n\ntwo\n")).document.text).toBe(
            "zero\n\none\n\ntwo\n",
        );
    });

    it("keeps the spaces at a block's edges until an agent rewrites that block", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [p("  a  "), p("   "), p("b "), bullet(" c\n d ")]);
        const before = await t.blocks(surfaceId);
        const read = await t.read(surfaceId);
        expect(read.text).toBe("a\n\n\n\nb\n\n- c\n  d\n");
        // Writing back what was read stores nothing, so every space is where it was.
        const again = await t.update(surfaceId, read.seq, read.text);
        expect(again).toMatchObject({ changed: false, document: { seq: read.seq } });
        expect(await t.blocks(surfaceId)).toEqual(before);
        // Only the block the agent rewrites is stored as the agent wrote it.
        const written = await t.update(surfaceId, read.seq, "a\n\n\n\nb, edited\n\n- c\n  d\n");
        expect(written).toMatchObject({ changed: true });
        const after = await t.blocks(surfaceId);
        expect(after.map((item) => item.content)).toEqual([
            before[0]!.content,
            before[1]!.content,
            [text("b, edited")],
            before[3]!.content,
        ]);
        expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    });

    it("shows a line break that ends a block and keeps it through an edit elsewhere", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [p("a\n"), p("b")]);
        const before = await t.blocks(surfaceId);
        const read = (await t.call("read_document", { surfaceId })) as { omitted?: string };
        expect(read).toMatchObject({ document: { text: "a\n\\\n\nb\n" } });
        expect(read.omitted).toBeUndefined();
        await t.update(surfaceId, 1, "a\n\\\n\nb, edited\n");
        expect((await t.blocks(surfaceId))[0]).toEqual(before[0]);
        // Taking the empty line out takes the line break out.
        const written = await t.update(surfaceId, 2, "a\n\nb, edited\n");
        expect(written).toMatchObject({ changed: true, document: { text: "a\n\nb, edited\n" } });
        expect((await t.blocks(surfaceId))[0]!.content).toEqual([text("a")]);
    });

    it("says when line breaks cannot be shown", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [block("heading", "a\nb", { level: 2 }), p("\n"), p("c")]);
        const before = await t.blocks(surfaceId);
        const read = await t.call("read_document", { surfaceId });
        expect(read).toMatchObject({
            document: { text: "## a b\n\n\n\nc\n" },
            omitted: expect.stringContaining("some line breaks"),
        });
        // Editing another block leaves the line breaks where they were.
        await t.update(surfaceId, 1, "## a b\n\n\n\nc, edited\n");
        expect((await t.blocks(surfaceId)).slice(0, 2)).toEqual(before.slice(0, 2));
    });

    it("keeps a block that shows as nothing but is not an empty paragraph", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, [p("a"), { type: "file" }, p("b")]);
        const before = await t.blocks(surfaceId);
        expect((await t.read(surfaceId)).text).toBe("a\n\n\n\nb\n");
        expect((await t.update(surfaceId, 1, "a\n\nb\n")).changed).toBe(false);
        expect(await t.blocks(surfaceId)).toEqual(before);
    });

    it("still refuses a document whose only content is outside the content model", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.change(surfaceId, (fragment) =>
            fragment.insert(0, [new Y.XmlElement("futureBlock")]),
        );
        await expect(t.update(surfaceId, 1, "Replaced\n")).rejects.toMatchObject({
            code: "invalid_request",
            message: expect.stringContaining("cannot represent"),
        });
        expect(await t.read(surfaceId)).toMatchObject({ text: "", seq: 1 });
    });

    it.each(WRITTEN)("agent writes %s", async (_name, written, reads) => {
        const t = await desk();
        const surfaceId = await t.create();
        const first = await t.update(surfaceId, 0, written);
        expect(first.document.text).toBe(reads);
        expect((await t.read(surfaceId)).text).toBe(reads);
        const again = await t.update(surfaceId, first.document.seq, reads);
        expect(again).toMatchObject({ changed: false, document: { seq: first.document.seq } });
        // A document created with the same Markdown reads the same.
        expect((await t.read(await t.create(written))).text).toBe(reads);
    });

    it.each(TYPED)("person leaves %s", async (_name, blocks, reads) => {
        const t = await desk();
        const surfaceId = await t.create();
        await t.type(surfaceId, blocks);
        const before = await t.blocks(surfaceId);
        const read = await t.read(surfaceId);
        expect(read.text).toBe(reads);
        const again = await t.update(surfaceId, read.seq, read.text);
        expect(again).toMatchObject({ changed: false, document: { seq: read.seq, text: reads } });
        expect(await t.blocks(surfaceId)).toEqual(before);
    });
});
