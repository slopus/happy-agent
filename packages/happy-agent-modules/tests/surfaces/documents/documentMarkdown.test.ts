import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToMarkdown } from "../../../sources/surfaces/documents/blocksToMarkdown.js";
import {
    BLOCKNOTE_VERSION,
    DOCUMENT_FRAGMENT,
    documentEditor,
} from "../../../sources/surfaces/documents/documentEditor.js";
import {
    markdownToUpdate,
    readDocument,
} from "../../../sources/surfaces/documents/readDocument.js";

const read = (markdown: string) =>
    readDocument(markdownToUpdate(markdown) ?? new Uint8Array([0, 0])).text;

/** A document holding these blocks exactly as a BlockNote editor would store them. */
function fromBlocks(blocks: unknown[]): Uint8Array {
    const doc = new Y.Doc();
    blocksToYXmlFragment(documentEditor(), blocks as never, doc.getXmlFragment(DOCUMENT_FRAGMENT));
    return Y.encodeStateAsUpdate(doc);
}

const text = (value: string, styles: Record<string, unknown> = {}) => ({
    type: "text",
    text: value,
    styles,
});

describe("document Markdown", () => {
    it("pins the BlockNote release that defines the content model", () => {
        const require = createRequire(import.meta.url);
        let directory = dirname(require.resolve("@blocknote/core"));
        while (!directory.endsWith(join("node_modules", "@blocknote", "core")))
            directory = dirname(directory);
        const installed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
            version: string;
        };
        const declared = JSON.parse(
            readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"),
        ) as { dependencies: Record<string, string> };
        // Desktop editors pin the same release; a change here must ship on both sides together.
        expect(BLOCKNOTE_VERSION).toBe("0.51.4");
        expect(installed.version).toBe(BLOCKNOTE_VERSION);
        expect(declared.dependencies["@blocknote/core"]).toBe(BLOCKNOTE_VERSION);
    });

    it("writes ordinary text as it reads, escaping only what Markdown would treat as syntax", () => {
        const paragraph = (value: string) =>
            readDocument(fromBlocks([{ type: "paragraph", content: [text(value)] }])).text;
        expect(paragraph("a_snake_name and snake_case_words")).toBe(
            "a_snake_name and snake_case_words\n",
        );
        expect(paragraph("5 * 3 = 15 and C:\\path\\to\\file")).toBe(
            "5 * 3 = 15 and C:\\path\\to\\file\n",
        );
        expect(paragraph("a ~ b, 3 < 4, x | y, R&D")).toBe("a ~ b, 3 < 4, x | y, R&D\n");
        expect(paragraph("2*3*4")).toBe("2\\*3\\*4\n");
        expect(paragraph("_leading and trailing_")).toBe("\\_leading and trailing\\_\n");
        expect(paragraph("[not a link](x) `tick` ~~struck~~ <b> &amp;")).toBe(
            "\\[not a link](x) \\`tick\\` \\~\\~struck\\~\\~ \\<b> \\&amp;\n",
        );
        for (const start of [
            "# Title",
            "- item",
            "+ item",
            "> quote",
            "1. one",
            "2) two",
            "---",
            "===",
        ])
            expect(
                paragraph(start).startsWith("\\") || /^\d+\\/.test(paragraph(start)),
                start,
            ).toBe(true);
    });

    it("reads every escaped or formatted text back exactly", () => {
        const samples = [
            "a_snake_name",
            "_x_ *y* __z__ **w**",
            "# heading-like",
            "1. numbered-like",
            "- dash-like",
            "> quote-like",
            "~~ tilde ~ run ~~",
            "back\\slash \\* \\_ \\",
            "[brackets] ](odd)[ ![image](x)",
            "`ticks` and ``double``",
            "<http://example.com> <tag> a<b",
            "&copy; &#169; &#xA9; & alone",
            "   leading and trailing   ",
            "tab\tinside",
            "#",
            "Heading ending with #",
        ];
        for (const sample of samples) {
            const markdown = readDocument(
                fromBlocks([{ type: "paragraph", content: [text(sample)] }]),
            ).text;
            const again = readDocument(markdownToUpdate(markdown)!);
            expect(again.text, sample).toBe(markdown);
            const blocks = documentBlocks(markdownToUpdate(markdown)!);
            expect(blocks[0]?.content, sample).toEqual([text(sample)]);
        }
    });

    it("keeps formatting Markdown can write and names what it leaves out", () => {
        const reading = readDocument(
            fromBlocks([
                {
                    type: "paragraph",
                    content: [
                        text("bold", { bold: true }),
                        text(" and "),
                        text("both", { bold: true, italic: true }),
                        text(" "),
                        text("code", { code: true }),
                        text(" "),
                        text("struck", { strike: true }),
                        text(" "),
                        text("under", { underline: true }),
                        text(" "),
                        text("red", { textColor: "red" }),
                        {
                            type: "link",
                            href: "https://example.com/a b(c)",
                            content: [text("link")],
                        },
                    ],
                },
                {
                    type: "paragraph",
                    props: { textAlignment: "center" },
                    content: [text("Centered")],
                },
            ]),
        );
        expect(reading.text).toBe(
            "**bold** and ***both*** `code` ~~struck~~ under red[link](<https://example.com/a%20b(c)>)\n\nCentered\n",
        );
        expect(reading.omitted).toEqual(["underline", "text colors", "alignment"]);
        expect(readDocument(markdownToUpdate(reading.text)!).text).toBe(reading.text);
    });

    it("round-trips every block Markdown can express to a fixed point", () => {
        const source = [
            "# Plan",
            "",
            "Intro with a hard  ",
            "break and *emphasis*.",
            "",
            "## Steps",
            "",
            "1. First",
            "2. Second",
            "   - nested bullet",
            "     - deeper",
            "3. Third",
            "",
            "- [ ] open task",
            "- [x] done task",
            "- plain bullet",
            "",
            "> A quote",
            "",
            "```ts",
            "const a_b = `x`;",
            "```",
            "",
            "---",
            "",
            "| Name | Value |",
            "| --- | --- |",
            "| a_b | 1 \\| 2 |",
            "",
            "![diagram](https://example.com/d.png)",
            "",
            "###### Deep heading",
        ].join("\n");
        const first = read(source);
        expect(read(first)).toBe(first);
        expect(first).toContain("- [ ] open task\n- [x] done task\n- plain bullet");
        expect(first).toContain("2. Second\n   - nested bullet\n     - deeper\n3. Third");
        expect(first).toContain("Intro with a hard\nbreak and *emphasis*.");
        expect(first).toContain("| a_b | 1 \\| 2 |");
        expect(first).toContain("```ts\nconst a_b = `x`;\n```");
    });

    it("leaves out and flags content outside the model without changing the stored document", () => {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, fromBlocks([{ type: "paragraph", content: [text("Kept")] }]));
        const group = doc.getXmlFragment(DOCUMENT_FRAGMENT).get(0) as Y.XmlElement;
        const container = new Y.XmlElement("blockContainer");
        container.setAttribute("id", "future");
        container.insert(0, [new Y.XmlElement("futureBlock")]);
        group.insert(group.length, [container]);
        const state = Y.encodeStateAsUpdate(doc);
        const reading = readDocument(state);
        expect(reading.outsideModel).toBe(true);
        expect(reading.text).toBe("Kept\n");
        expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
        expect(
            readDocument(fromBlocks([{ type: "paragraph", content: [text("Plain")] }]))
                .outsideModel,
        ).toBe(false);
    });

    it("treats Markdown without blocks as no content", () => {
        expect(markdownToUpdate("")).toBeUndefined();
        expect(markdownToUpdate("  \n\n ")).toBeUndefined();
        expect(blocksToMarkdown([]).text).toBe("");
    });
});

function documentBlocks(state: Uint8Array): { content?: unknown }[] {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return yXmlFragmentToBlocks(documentEditor(), doc.getXmlFragment(DOCUMENT_FRAGMENT)) as never;
}
