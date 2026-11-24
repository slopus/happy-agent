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
    ["CRLF line ends", "a\r\n\r\nb\r\n", "a\n\nb\n"],
    ["trailing spaces on a line", "a   \n\nb \n", "a\n\nb\n"],
    ["a two-space hard break", "a  \nb\n", "a\\\nb\n"],
    ["a backslash hard break", "a\\\nb\n", "a\\\nb\n"],
    ["a soft break joins the lines", "a\nb\n", "a b\n"],
    ["a code block keeps its blank lines", "```js\nx\n\n\n\ny\n```\n", "```js\nx\n\n\n\ny\n```\n"],
    ["a code block of only blank lines", "```\n\n\n\n```\n", "```\n\n\n\n```\n"],
    ["a code block between paragraphs", "a\n\n```\nx\n```\n\nb\n", "a\n\n```\nx\n```\n\nb\n"],
    ["an indented code block", "a\n\n    x\n\n\n    y\n", "a\n\n```\nx\n\n\ny\n```\n"],
    ["a tight bullet list", "- a\n- b\n", "- a\n- b\n"],
    ["a loose bullet list reads tight", "- a\n\n- b\n", "- a\n- b\n"],
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
    ["a quote", "> one\n>\n> two\n", "> one\n\n> two\n"],
    ["a divider", "a\n\n---\n\nb\n", "a\n\n---\n\nb\n"],
    ["HTML stays text", "<b>bold</b>\n", "\\<b>bold\\</b>\n"],
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
        "- a\n\n  \n\n  - b\n\nc\n",
    ],
    [
        "an empty paragraph nested beneath a paragraph",
        [p("a", [p(), p("b")]), p("c")],
        "a\n\n\n\nb\n\nc\n",
    ],
    ["an empty heading", [block("heading", "", { level: 2 }), p("a")], "##\n\na\n"],
    ["an empty bullet", [bullet(), bullet("a")], "- \n- a\n"],
    ["an empty numbered item", [block("numberedListItem"), p("a")], "1. \n\na\n"],
    ["an empty code block", [{ type: "codeBlock", content: [] }, p("a")], "```\n\n```\n\na\n"],
    ["leading and trailing spaces", [p("  a  ")], "&#32; a &#32;\n"],
    ["a paragraph of spaces", [p("a"), p("   "), p("b")], "a\n\n&#32; &#32;\n\nb\n"],
    ["text that looks like a blank-line run", [p("a\n\n\nb")], "a\\\n\\\n\\\nb\n"],
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

describe("document tools round-trip Markdown", () => {
    it("writes into a document nobody has edited", async () => {
        const t = await desk();
        const surfaceId = await t.create();
        expect(await t.read(surfaceId)).toMatchObject({ text: "", seq: 0 });
        expect(await t.update(surfaceId, 0, "Draft from notes.\n")).toMatchObject({
            changed: true,
            document: { seq: 1, text: "Draft from notes.\n" },
        });
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
