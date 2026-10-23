import { describe, expect, it } from "vitest";

import {
    mediaSourceMatches,
    splitMediaLayoutBlocks,
    stripMediaLayoutBlocks,
    type MediaLayoutBlockSegment,
} from "../sources/mediaLayoutBlocks.js";
import { parseMediaLayoutHtml } from "../sources/mediaLayoutHtml.js";
import type { MediaImageItem, MediaItem } from "../sources/protocol/messages.js";

/** Splits, and checks that the segments put back together are the input. */
function split(markdown: string): MediaLayoutBlockSegment[] {
    const segments = splitMediaLayoutBlocks(markdown);
    expect(
        segments
            .map((segment) => (segment.type === "markdown" ? segment.text : segment.html))
            .join(""),
    ).toBe(markdown);
    return segments;
}

const GRID =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">\n' +
    '  <img src="shots/before.png">\n' +
    '  <img src="shots/after.png">\n' +
    "</div>\n";

describe("splitMediaLayoutBlocks", () => {
    it("finds a grid between paragraphs, interrupting the one before it", () => {
        expect(split(`Here they are:\n${GRID}\nThe second is faster.`)).toEqual([
            { type: "markdown", text: "Here they are:\n" },
            { type: "layout", html: GRID, complete: true },
            { type: "markdown", text: "\nThe second is faster." },
        ]);
    });

    it("finds full-width images one after another as separate blocks", () => {
        const markdown =
            '<img src="a.png" style="width: 100%">\n' +
            '   <IMG SRC="b.png" style="width: 100%"/>\n' +
            "Done.";
        expect(split(markdown)).toEqual([
            { type: "layout", html: '<img src="a.png" style="width: 100%">\n', complete: true },
            {
                type: "layout",
                html: '   <IMG SRC="b.png" style="width: 100%"/>\n',
                complete: true,
            },
            { type: "markdown", text: "Done." },
        ]);
    });

    it("keeps blank lines inside a block, which a CommonMark HTML block would end at", () => {
        const html =
            "<div>\n\n" +
            '<figure>\n\n<img src="a.png">\n\n<figcaption>Before</figcaption>\n\n</figure>\n\n' +
            "<p>Notes with **no** Markdown</p>\n\n" +
            "</div>\n";
        expect(split(`${html}\nAfter.`)).toEqual([
            { type: "layout", html, complete: true },
            { type: "markdown", text: "\nAfter." },
        ]);
    });

    it("counts only the root tag, so unclosed inner tags and stray closes do not matter", () => {
        const html = '<div><p>one<p>two</span><div><img src="a.png"></div></div> trailing\n';
        expect(split(`${html}Next`)).toEqual([
            { type: "layout", html, complete: true },
            { type: "markdown", text: "Next" },
        ]);
    });

    it("skips comments and quoted attribute values when looking for the close", () => {
        const html =
            '<div title="</div>" data-x=\'>\'><!-- </div> --><img alt="a > b" src="a.png">\n</div>\n';
        expect(split(`${html}x`)).toEqual([
            { type: "layout", html, complete: true },
            { type: "markdown", text: "x" },
        ]);
    });

    it("leaves a block without an image as Markdown", () => {
        const markdown = '<div style="display:grid">\n<p>Just text</p>\n</div>\nMore';
        expect(split(markdown)).toEqual([{ type: "markdown", text: markdown }]);
    });

    it("ignores tags in fenced code, code spans, indented code, and other tags", () => {
        const markdown =
            "```html\n" +
            '<img src="a.png">\n' +
            "```\n" +
            '~~~\n<div><img src="a.png"></div>\n~~~\n' +
            'A span `opens here\n<img src="a.png"> and closes` there.\n\n' +
            '    <img src="a.png">\n' +
            '<span><img src="a.png"></span>\n' +
            '<divider><img src="a.png"></divider>\n' +
            'Inline <img src="a.png"> in a sentence.\n' +
            '> <img src="a.png">\n';
        expect(split(markdown)).toEqual([{ type: "markdown", text: markdown }]);
    });

    it("reports an unclosed block, while streaming or broken, as the incomplete last segment", () => {
        expect(split('Look:\n<div style="display:grid">\n  <img src="a.png">\n')).toEqual([
            { type: "markdown", text: "Look:\n" },
            {
                type: "layout",
                html: '<div style="display:grid">\n  <img src="a.png">\n',
                complete: false,
            },
        ]);
        expect(split('<div>\n<img src="a.png">\n</div')).toEqual([
            { type: "layout", html: '<div>\n<img src="a.png">\n</div', complete: false },
        ]);
        expect(split('<img src="a.png" alt="cut')).toEqual([
            { type: "layout", html: '<img src="a.png" alt="cut', complete: false },
        ]);
        expect(split("<div><!-- never closed </div>")).toEqual([
            { type: "layout", html: "<div><!-- never closed </div>", complete: false },
        ]);
        // A block that never closes keeps everything after it, so nothing is lost.
        const broken = '<div>\n<img src="a.png">\n\nThe rest of the reply.\n\nMore.';
        expect(split(broken)).toEqual([{ type: "layout", html: broken, complete: false }]);
    });

    it("holds a trailing partial start tag, and only that", () => {
        for (const tail of ["<", "<d", "<di", "  <fig", "<IM", "<p", "<section"]) {
            expect(split(`Text\n${tail}`)).toEqual([
                { type: "markdown", text: "Text\n" },
                { type: "layout", html: tail, complete: false },
            ]);
        }
        for (const tail of ["<h", "<span", "<happy-arti", "<d\n"]) {
            expect(split(`Text\n${tail}`)).toEqual([{ type: "markdown", text: `Text\n${tail}` }]);
        }
    });

    it("returns nothing for empty text", () => {
        expect(split("")).toEqual([]);
    });
});

describe("stripMediaLayoutBlocks", () => {
    it("removes complete blocks and closes up the blank lines around them", () => {
        expect(stripMediaLayoutBlocks(`Here they are:\n${GRID}\nThe second is faster.`)).toBe(
            "Here they are:\n\nThe second is faster.",
        );
        expect(stripMediaLayoutBlocks(`${GRID}\n\nOnly text after.`)).toBe("Only text after.");
        expect(stripMediaLayoutBlocks(`Before.\n\n${GRID}\n`)).toBe("Before.");
        expect(stripMediaLayoutBlocks(GRID)).toBe("");
    });

    it("leaves Markdown, text-only HTML, code, and broken blocks as written", () => {
        for (const markdown of [
            "Plain **Markdown**.\n\n\n\nWith gaps.",
            "<div><p>No images</p></div>",
            '```\n<img src="a.png">\n```',
            '<div>\n<img src="a.png">\n',
        ]) {
            expect(stripMediaLayoutBlocks(markdown)).toBe(markdown);
        }
    });
});

describe("mediaSourceMatches", () => {
    it("matches the path as written or the absolute path, exactly", () => {
        const source = { path: "shots/a.png", absolutePath: "/repo/shots/a.png" };
        expect(mediaSourceMatches(source, "shots/a.png")).toBe(true);
        expect(mediaSourceMatches(source, "/repo/shots/a.png")).toBe(true);
        expect(mediaSourceMatches(source, "./shots/a.png")).toBe(false);
        expect(mediaSourceMatches(source, "SHOTS/A.PNG")).toBe(false);
        expect(mediaSourceMatches(undefined, "shots/a.png")).toBe(false);
    });
});

describe("a layout block in a reply", () => {
    /** Earlier media in the conversation, oldest first: mixed aspect ratios and a Retina shot. */
    const earlier: MediaItem[] = [
        image("wide.png", 1600, 400),
        image("tall.png", 400, 1200),
        { ...image("retina.png", 2880, 1800), scale: 2 },
        image("wide.png", 1600, 500),
    ];

    function image(path: string, width: number, height: number): MediaImageItem {
        return {
            kind: "image",
            name: path,
            mimeType: "image/png",
            size: 1,
            width,
            height,
            thumbhash: "AAAA",
            source: { path, absolutePath: `/repo/${path}` },
        };
    }

    /** What a client does: resolve each src to the latest earlier item, in its own list. */
    function render(html: string) {
        const items: MediaItem[] = [];
        const parsed = parseMediaLayoutHtml(html, (src) => {
            const item = earlier.findLast((candidate) => mediaSourceMatches(candidate.source, src));
            if (item === undefined) return undefined;
            const known = items.indexOf(item);
            if (known >= 0) return known;
            items.push(item);
            return items.length - 1;
        });
        return { items, ...parsed };
    }

    it("lays out images of mixed aspect ratios and scale by their earlier items", () => {
        const [block] = split(
            '<div style="display: flex; gap: 8px; align-items: flex-start">' +
                '<img src="wide.png" style="flex: 2"><img src="/repo/tall.png" style="flex: 1">' +
                '<img src="retina.png"></div>',
        );
        expect(block?.type).toBe("layout");
        const rendered = render(block?.type === "layout" ? block.html : "");
        expect(
            rendered.items.map((item) => [
                item.width,
                item.height,
                item.kind === "image" ? item.scale : 0,
            ]),
        ).toEqual([
            [1600, 500, undefined],
            [400, 1200, undefined],
            [2880, 1800, 2],
        ]);
        expect(rendered.placed).toEqual([0, 1, 2]);
        expect(rendered.root).toEqual([
            {
                type: "element",
                tag: "div",
                style: { display: "flex", gap: "8px", alignItems: "flex-start" },
                children: [
                    { type: "item", index: 0, style: { flex: "2" } },
                    { type: "item", index: 1, style: { flex: "1" } },
                    { type: "item", index: 2 },
                ],
            },
        ]);
    });

    it("places nothing when no src names an earlier item, so the block stays Markdown", () => {
        const rendered = render(
            '<div><img src="https://example.com/x.png"><img src="other.png"></div>',
        );
        expect(rendered.placed).toEqual([]);
        expect(rendered.items).toEqual([]);
    });
});
