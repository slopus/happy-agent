import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { parseMediaLayoutHtml } from "../sources/mediaLayoutHtml.js";
import { mediaLayoutStyleValue } from "../sources/protocol/mediaLayoutStyle.js";
import { mediaLayoutSchema, type MediaLayoutNode } from "../sources/protocol/messages.js";

const FILES = ["out/overview.png", "out/before.png", "out/after.png"];
const PLACE_ALL = '<img src="out/overview.png"><img src="out/before.png"><img src="out/after.png">';

/** Parse a layout naming `filepaths`, check its tree against the published schema, and return it. */
function parsed(html: string, filepaths: readonly string[] = FILES) {
    const result = parseMediaLayoutHtml(html, (src) => {
        const index = filepaths.indexOf(src);
        return index < 0 ? undefined : index;
    });
    if (result.root.length > 0) {
        expect(Value.Check(mediaLayoutSchema, { type: "tree", root: result.root })).toBe(true);
    }
    // Every style value the parser emits passes the check a client runs again.
    for (const style of styles(result.root)) {
        for (const [key, value] of Object.entries(style)) {
            expect(mediaLayoutStyleValue(key, value as string), key).toBe(value);
        }
    }
    return result;
}

function styles(nodes: readonly MediaLayoutNode[]): object[] {
    return nodes.flatMap((node) => [
        ...("style" in node && node.style !== undefined ? [node.style] : []),
        ...(node.type === "element" ? styles(node.children) : []),
    ]);
}

describe("parseMediaLayoutHtml", () => {
    it("turns figures, grids, and natural-size images into a typed tree", () => {
        const { root, ignored, placed, truncated } = parsed(`
            <img src="out/overview.png" alt="Dashboard overview" style="width: 100%">
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin: 12px auto 0">
              <figure><img src="out/before.png"><figcaption style="tone: muted; font-size: small">Before</figcaption></figure>
              <figure><img src="out/after.png" style="object-fit: scale-down; object-position: right top"><figcaption>After</figcaption></figure>
            </div>`);
        expect(ignored).toEqual([]);
        expect(placed).toEqual([0, 1, 2]);
        expect(truncated).toBe(false);
        expect(root).toEqual([
            { type: "item", index: 0, alt: "Dashboard overview", style: { width: "100%" } },
            {
                type: "element",
                tag: "div",
                style: {
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                    gap: "12px",
                    margin: "12px auto 0",
                },
                children: [
                    {
                        type: "element",
                        tag: "figure",
                        children: [
                            { type: "item", index: 1 },
                            {
                                type: "element",
                                tag: "figcaption",
                                style: { tone: "muted", fontSize: "small" },
                                children: [{ type: "text", text: "Before" }],
                            },
                        ],
                    },
                    {
                        type: "element",
                        tag: "figure",
                        children: [
                            {
                                type: "item",
                                index: 2,
                                style: { objectFit: "scale-down", objectPosition: "right top" },
                            },
                            {
                                type: "element",
                                tag: "figcaption",
                                children: [{ type: "text", text: "After" }],
                            },
                        ],
                    },
                ],
            },
        ]);
    });

    it("reads tags, attributes, keywords, and entities case-insensitively, as a browser would", () => {
        const { root, ignored } = parsed(
            `<DIV STYLE="DISPLAY: FLEX; Justify-Content: Space-Between; FLEX: 1 0 50%; place-items: first baseline center">` +
                `<P>Q3 &amp; Q4 <STRONG style="font-weight: 700">up</STRONG><BR>&lt;b&gt;</P>` +
                `<IMG SRC="out/overview.png"><img src="out/before.png"><img src="out/after.png"></DIV>`,
        );
        expect(ignored).toEqual([]);
        expect(root).toEqual([
            {
                type: "element",
                tag: "div",
                style: {
                    display: "flex",
                    justifyContent: "space-between",
                    flex: "1 0 50%",
                    placeItems: "first baseline center",
                },
                children: [
                    {
                        type: "element",
                        tag: "p",
                        children: [
                            { type: "text", text: "Q3 & Q4 " },
                            {
                                type: "element",
                                tag: "strong",
                                style: { fontWeight: "700" },
                                children: [{ type: "text", text: "up" }],
                            },
                            { type: "break" },
                            { type: "text", text: "<b>" },
                        ],
                    },
                    { type: "item", index: 0 },
                    { type: "item", index: 1 },
                    { type: "item", index: 2 },
                ],
            },
        ]);
    });

    it("keeps the allowed declarations of a style and reports the rest", () => {
        const { root, ignored } = parsed(
            `<section style="position: fixed; z-index: 9; color: red; background: url(x.png); ` +
                `width: 50vw; height: min-content; animation: spin 1s; transition: all 1s; ` +
                `content: x; cursor: pointer; pointer-events: none; transform: rotate(1deg); ` +
                `width: var(--w); margin: -4px; display: inline-block !important; ` +
                `aspect-ratio: auto 16/9; line-height: 1.5; border-radius: 8px; ` +
                `grid-column: 1 / -1; /* note */ text-align: justify">x</section>${PLACE_ALL}`,
        );
        expect(root?.[0]).toEqual({
            type: "element",
            tag: "section",
            style: {
                height: "min-content",
                aspectRatio: "auto 16 / 9",
                lineHeight: "1.5",
                borderRadius: "8px",
                gridColumn: "1 / -1",
                textAlign: "justify",
            },
            children: [{ type: "text", text: "x" }],
        });
        expect(ignored).toEqual([
            "position on <section>",
            "z-index on <section>",
            "color on <section>",
            "background on <section>",
            "width: 50vw on <section>",
            "animation on <section>",
            "transition on <section>",
            "content on <section>",
            "cursor on <section>",
            "pointer-events on <section>",
            "transform on <section>",
            "width: var(--w) on <section>",
            "margin: -4px on <section>",
            "display: inline-block !important on <section>",
        ]);
    });

    it("leaves out a whole style that hides its values behind escapes or quotes", () => {
        for (const style of [
            "width: u\\72l(x)",
            "font-family: &quot;a; display: none&quot;",
            "width: u&#92;72l(x)",
        ]) {
            const { root, ignored } = parsed(`<div style="${style}">x</div>${PLACE_ALL}`);
            expect(root?.[0]).toEqual({
                type: "element",
                tag: "div",
                children: [{ type: "text", text: "x" }],
            });
            expect(ignored).toEqual(["style with escapes or quotes on <div>"]);
        }
    });

    it("unwraps tags it does not know and keeps their content", () => {
        const { root, ignored } = parsed(
            `<table><tr><td><h1>Title</h1></td></tr></table>` +
                `<a href="https://example.com"><img src="out/overview.png"></a>` +
                `<picture><source srcset="x.png"><img src="out/before.png"></picture>` +
                `<ul><li><img src="out/after.png"></li></ul>`,
        );
        expect(root).toEqual([
            { type: "text", text: "Title" },
            { type: "item", index: 0 },
            { type: "item", index: 1 },
            { type: "item", index: 2 },
        ]);
        expect(ignored).toEqual([
            "<table> (its content is kept)",
            "<tbody> (its content is kept)",
            "<tr> (its content is kept)",
            "<td> (its content is kept)",
            "<h1> (its content is kept)",
            "<a> (its content is kept)",
            "<picture> (its content is kept)",
            "<source> and its contents",
            "<ul> (its content is kept)",
            "<li> (its content is kept)",
        ]);
    });

    it.each([
        ["script", "<script>alert(1)</script>"],
        ["style", "<style>div { color: red }</style>"],
        ["svg", "<svg><script>alert(1)</script><text>hidden</text></svg>"],
        ["math", "<math><mi>x</mi></math>"],
        ["iframe", '<iframe src="https://example.com">hidden</iframe>'],
        ["object", '<object data="x">hidden</object>'],
        ["embed", '<embed src="x">'],
        ["form", "<form><button>hidden</button></form>"],
        ["video", "<video>hidden</video>"],
        ["template", "<template><img src='out/overview.png'></template>"],
        ["textarea", "<textarea>hidden</textarea>"],
    ])("leaves out <%s> together with its contents", (tag, html) => {
        const { root, ignored } = parsed(`<div>${html}</div>${PLACE_ALL}`);
        expect(root?.[0]).toEqual({ type: "element", tag: "div", children: [] });
        expect(ignored).toContain(`<${tag}> and its contents`);
        expect(JSON.stringify(root)).not.toContain("hidden");
    });

    it.each([
        ["link", '<link rel="stylesheet" href="x.css">'],
        ["meta", '<meta http-equiv="refresh" content="0">'],
        ["base", '<base href="https://example.com/">'],
        ["title", "<title>x</title>"],
    ])("leaves out <%s>, which a parser moves into the document head", (tag, html) => {
        expect(parsed(`${html}${PLACE_ALL}`).ignored).toContain(`<${tag}> and its contents`);
    });

    it("reports comments and ignores doctypes, CDATA, and document wrappers", () => {
        const { root, ignored } = parsed(
            `<!doctype html><html><head></head><body><!-- note --><![CDATA[x]]><?xml version="1.0"?>${PLACE_ALL}</body></html>`,
        );
        expect(root).toEqual([
            { type: "item", index: 0 },
            { type: "item", index: 1 },
            { type: "item", index: 2 },
        ]);
        expect(ignored).toEqual(["comments"]);
    });

    it("leaves out other attributes", () => {
        const { root, ignored } = parsed(
            `<div class="card" id="main" onclick="alert(1)" data-x="1" aria-label="x">` +
                `<img src="out/overview.png" srcset="x.png 2x" onerror="alert(1)" alt="Shot"><br style="display: none">` +
                `</div><img src="out/before.png"><img src="out/after.png">`,
        );
        expect(root?.[0]).toEqual({
            type: "element",
            tag: "div",
            children: [{ type: "item", index: 0, alt: "Shot" }, { type: "break" }],
        });
        expect(ignored).toEqual([
            "the attribute class on <div>",
            "the attribute id on <div>",
            "the attribute onclick on <div>",
            "the attribute data-x on <div>",
            "the attribute aria-label on <div>",
            "the attribute srcset on <img>",
            "the attribute onerror on <img>",
            "the attribute style on <br>",
        ]);
    });

    it("drops an image the resolver does not know, or whose item is already placed", () => {
        const sources = [
            "https://example.com/out/overview.png",
            "data:image/png;base64,iVBORw0KGgo=",
            "&#106;avascript:alert(1)",
            "file:///etc/passwd",
            "./out/overview.png",
            "OUT/OVERVIEW.PNG",
        ];
        const { root, ignored, placed } = parsed(
            `${sources.map((src) => `<img src="${src}">`).join("")}<img>` +
                `<img src="out/before.png"><img src="out/before.png">`,
        );
        expect(root).toEqual([{ type: "item", index: 1 }]);
        expect(placed).toEqual([1]);
        expect(ignored).toEqual([
            '<img src="https://example.com/out/overview.png">, which names none of the files',
            '<img src="data:image/png;base64,iVBORw0KGgo=">, which names none of the files',
            '<img src="javascript:alert(1)">, which names none of the files',
            '<img src="file:///etc/passwd">, which names none of the files',
            '<img src="./out/overview.png">, which names none of the files',
            '<img src="OUT/OVERVIEW.PNG">, which names none of the files',
            "<img> without src",
            'a second <img src="out/before.png">',
        ]);
    });

    it("places nothing for text-only HTML, and reads nothing of HTML that is too long", () => {
        const none = parsed("<p>Just a caption</p><table></table>");
        expect(none.placed).toEqual([]);
        expect(none.truncated).toBe(false);
        expect(none.root).toEqual([
            { type: "element", tag: "p", children: [{ type: "text", text: "Just a caption" }] },
        ]);
        expect(none.ignored).toEqual(["<table> (its content is kept)"]);
        const long = parsed(PLACE_ALL + " ".repeat(32 * 1024));
        expect(long).toEqual({
            root: [],
            placed: [],
            ignored: ["the whole layout, which is longer than 32768 characters"],
            truncated: true,
        });
    });

    it("never resolves the same item twice, and ignores an index that is not one", () => {
        const resolved: string[] = [];
        const result = parseMediaLayoutHtml(
            '<img src="a.png"><img src="./a.png"><img src="b.png"><img src="c.png">',
            (src) => {
                resolved.push(src);
                return src === "b.png" ? -1 : src === "c.png" ? 1.5 : 7;
            },
        );
        expect(resolved).toEqual(["a.png", "./a.png", "b.png", "c.png"]);
        expect(result.root).toEqual([{ type: "item", index: 7 }]);
        expect(result.placed).toEqual([7]);
    });

    it("drops whitespace that only indents block-level content and keeps spaces between words", () => {
        const { root } = parsed(`
            <div>
                <p>One <em>two</em></p>
                <img src="out/overview.png"> <img src="out/before.png">
            </div>
            <div style="display: inline-grid">  <img src="out/after.png">  </div>`);
        expect(root).toEqual([
            {
                type: "element",
                tag: "div",
                children: [
                    {
                        type: "element",
                        tag: "p",
                        children: [
                            { type: "text", text: "One " },
                            {
                                type: "element",
                                tag: "em",
                                children: [{ type: "text", text: "two" }],
                            },
                        ],
                    },
                    { type: "item", index: 0 },
                    { type: "text", text: " " },
                    { type: "item", index: 1 },
                ],
            },
            {
                type: "element",
                tag: "div",
                style: { display: "inline-grid" },
                children: [{ type: "item", index: 2 }],
            },
        ]);
    });

    it("bounds nesting, nodes, and text by keeping what fits and reporting the rest", () => {
        const nested = (depth: number) => `${"<div>".repeat(depth)}deep${"</div>".repeat(depth)}`;
        const deep = parsed(nested(14) + PLACE_ALL);
        expect(deep.ignored).toEqual(["elements nested more than 12 deep (their content is kept)"]);
        expect(deep.truncated).toBe(false);
        expect(JSON.stringify(deep.root)).toContain("deep");

        const many = parsed(PLACE_ALL + "<br>".repeat(600));
        expect(many.ignored).toEqual(["nodes beyond 500"]);
        expect(many.truncated).toBe(true);

        const wordy = parsed(`${PLACE_ALL}<p>${"x".repeat(5000)}</p><p>${"y".repeat(5000)}</p>`);
        expect(wordy.ignored).toEqual(["text beyond 8000 characters"]);
        expect(wordy.truncated).toBe(true);
        const text =
            JSON.stringify(wordy.root)
                .match(/[xy]{2,}/gu)
                ?.join("") ?? "";
        expect(text.length).toBe(8000);
    });
});
