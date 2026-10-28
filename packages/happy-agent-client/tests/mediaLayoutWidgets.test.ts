import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { splitMediaLayoutBlocks } from "../sources/mediaLayoutBlocks.js";
import { parseMediaLayoutHtml } from "../sources/mediaLayoutHtml.js";
import { mediaLayoutSchema } from "../sources/protocol/messages.js";

const FILES = ["out/before.png", "out/after.png"];

/** Parse a layout naming `FILES`, check its tree against the published schema, and return it. */
function parsed(html: string) {
    const result = parseMediaLayoutHtml(html, (src) => {
        const index = FILES.indexOf(src);
        return index < 0 ? undefined : index;
    });
    if (result.root.length > 0) {
        expect(Value.Check(mediaLayoutSchema, { type: "tree", root: result.root })).toBe(true);
    }
    return result;
}

const CHART_BODY =
    '{ "labels": ["Q1", "Q2"], "series": [{ "name": "Revenue", "values": [1, 2] }], "unit": "%" }';

describe("widget nodes", () => {
    it("parses a chart from a JSON script child, defaulting to bars", () => {
        const { root, widgets, ignored, truncated } = parsed(
            `<happy-chart><script type="application/json">${CHART_BODY}</script></happy-chart>`,
        );
        expect(ignored).toEqual([]);
        expect(truncated).toBe(false);
        expect(widgets).toBe(1);
        expect(root).toEqual([
            {
                type: "chart",
                variant: "bar",
                labels: ["Q1", "Q2"],
                series: [{ name: "Revenue", values: [1, 2] }],
                unit: "%",
            },
        ]);
    });

    it("parses a chart from plain text, with its variant, null points, and style", () => {
        const { root, widgets } = parsed(
            `<happy-chart type="line" style="margin-top: 8px">{ "labels": ["a", "b", "c"], "series": [{ "values": [1, null, 3] }] }</happy-chart>`,
        );
        expect(widgets).toBe(1);
        expect(root).toEqual([
            {
                type: "chart",
                variant: "line",
                labels: ["a", "b", "c"],
                series: [{ values: [1, null, 3] }],
                style: { marginTop: "8px" },
            },
        ]);
    });

    it("parses a diagram's Mermaid source verbatim", () => {
        const source = "flowchart LR\n    a[Agent] --> d[Daemon]\n    d --> c[Client]";
        for (const html of [
            `<happy-diagram><script type="text/x-mermaid">\n${source}\n</script></happy-diagram>`,
            `<happy-diagram>\n${source}\n</happy-diagram>`,
        ]) {
            const { root, widgets, truncated } = parsed(html);
            expect(truncated).toBe(false);
            expect(widgets).toBe(1);
            expect(root).toEqual([{ type: "diagram", source }]);
        }
    });

    it("parses a code quote and dedents its body", () => {
        const { root, widgets } = parsed(
            `<happy-code language="ts" path="src/add.ts"><script type="text/plain">
                export function add(a: number, b: number) {
                    return a + b;
                }
            </script></happy-code>`,
        );
        expect(widgets).toBe(1);
        expect(root).toEqual([
            {
                type: "codeQuote",
                code: "export function add(a: number, b: number) {\n    return a + b;\n}",
                language: "ts",
                path: "src/add.ts",
            },
        ]);
    });

    it("parses a changed-files list and keeps only the shape's fields", () => {
        const { root, widgets } = parsed(
            `<happy-files><script type="application/json">[
                { "path": "src/a.ts", "status": "modified", "added": 12, "removed": 3, "extra": true },
                { "path": "src/b.ts", "status": "added", "added": 40 }
            ]</script></happy-files>`,
        );
        expect(widgets).toBe(1);
        expect(root).toEqual([
            {
                type: "files",
                files: [
                    { path: "src/a.ts", status: "modified", added: 12, removed: 3 },
                    { path: "src/b.ts", status: "added", added: 40 },
                ],
            },
        ]);
    });

    it("lays out widgets and images together", () => {
        const { root, placed, widgets, truncated } = parsed(
            `<div style="display: flex; flex-direction: column; gap: 8px">
                <img src="out/before.png">
                <happy-chart>${CHART_BODY}</happy-chart>
            </div>`,
        );
        expect(truncated).toBe(false);
        expect(placed).toEqual([0]);
        expect(widgets).toBe(1);
        expect(root).toEqual([
            {
                type: "element",
                tag: "div",
                style: { display: "flex", flexDirection: "column", gap: "8px" },
                children: [
                    { type: "item", index: 0 },
                    {
                        type: "chart",
                        variant: "bar",
                        labels: ["Q1", "Q2"],
                        series: [{ name: "Revenue", values: [1, 2] }],
                        unit: "%",
                    },
                ],
            },
        ]);
    });

    it("drops a widget whose body is not valid JSON, as content lost to a limit", () => {
        const { root, widgets, truncated, ignored } = parsed(
            "<happy-chart>not json at all</happy-chart>",
        );
        expect(root).toEqual([]);
        expect(widgets).toBe(0);
        expect(truncated).toBe(true);
        expect(ignored).toEqual(["a <happy-chart> whose body is not valid JSON"]);
    });

    it("drops a widget with an empty body", () => {
        const { widgets, truncated, ignored } = parsed("<happy-diagram>   </happy-diagram>");
        expect(widgets).toBe(0);
        expect(truncated).toBe(true);
        expect(ignored).toEqual(["a <happy-diagram> with an empty body"]);
    });

    it("drops a chart whose type names no chart", () => {
        const { widgets, truncated, ignored } = parsed(
            `<happy-chart type="pie">${CHART_BODY}</happy-chart>`,
        );
        expect(widgets).toBe(0);
        expect(truncated).toBe(true);
        expect(ignored).toEqual(['type="pie" on <happy-chart>, which names no chart']);
    });

    it("drops a widget outside its node's bounds", () => {
        const labels = JSON.stringify(Array.from({ length: 101 }, (_, i) => String(i)));
        const over = [
            `<happy-chart>{ "labels": ${labels}, "series": [{ "values": [1] }] }</happy-chart>`,
            `<happy-chart>{ "labels": ["a"], "series": [] }</happy-chart>`,
            `<happy-chart>{ "labels": ["a"], "series": [{ "values": ["x"] }] }</happy-chart>`,
            `<happy-files>[]</happy-files>`,
            `<happy-files>[{ "path": "" }]</happy-files>`,
            `<happy-files>[{ "path": "a", "added": -1 }]</happy-files>`,
            `<happy-code language="${"x".repeat(41)}">code</happy-code>`,
        ];
        for (const html of over) {
            const { root, widgets, truncated } = parsed(html);
            expect(root, html).toEqual([]);
            expect(widgets, html).toBe(0);
            expect(truncated, html).toBe(true);
        }
    });

    it("counts a widget's body toward the text budget and refuses one that passes it", () => {
        const code = "x".repeat(8000 - 10);
        const fits = parsed(`<happy-code>${code}</happy-code>`);
        expect(fits.widgets).toBe(1);
        expect(fits.truncated).toBe(false);
        const over = parsed(`<p>${"t".repeat(20)}</p><happy-code>${code}</happy-code>`);
        expect(over.widgets).toBe(0);
        expect(over.truncated).toBe(true);
        expect(over.ignored).toEqual([
            "a <happy-code> whose body passes the 8000-character budget",
        ]);
    });

    it("keeps at most 16 widgets in one tree", () => {
        const widgets = Array.from(
            { length: 17 },
            () => "<happy-diagram>flowchart LR\n a --> b</happy-diagram>",
        ).join("");
        const result = parsed(`<div>${widgets}</div>`);
        expect(result.widgets).toBe(16);
        expect(result.truncated).toBe(true);
        expect(result.ignored).toEqual(["widgets beyond 16"]);
    });

    it("drops other elements inside a widget and reads around them", () => {
        const { root, widgets, ignored } = parsed(
            `<happy-diagram><em>note</em>flowchart LR\n a --> b</happy-diagram>`,
        );
        expect(widgets).toBe(1);
        expect(ignored).toEqual(["<em> inside <happy-diagram>"]);
        expect(root).toEqual([{ type: "diagram", source: "flowchart LR\n a --> b" }]);
    });

    it("reads no body from a script of another type", () => {
        const { widgets, truncated, ignored } = parsed(
            `<happy-chart><script type="text/javascript">alert(1)</script></happy-chart>`,
        );
        expect(widgets).toBe(0);
        expect(truncated).toBe(true);
        expect(ignored).toEqual([
            "<script> inside <happy-chart>",
            "a <happy-chart> with an empty body",
        ]);
    });
});

describe("widget blocks in a reply", () => {
    it("recognizes a block holding only a widget as a layout", () => {
        const text = `The split:\n\n<happy-chart>${CHART_BODY}</happy-chart>\n\nDone.`;
        expect(splitMediaLayoutBlocks(text)).toEqual([
            { type: "markdown", text: "The split:\n\n" },
            {
                type: "layout",
                html: `<happy-chart>${CHART_BODY}</happy-chart>\n`,
                complete: true,
            },
            { type: "markdown", text: "\nDone." },
        ]);
    });

    it("recognizes a widget inside a wrapper block without any image", () => {
        const text = `<div>\n<happy-files>[{ "path": "a.ts" }]</happy-files>\n</div>`;
        expect(splitMediaLayoutBlocks(text)).toEqual([
            { type: "layout", html: text, complete: true },
        ]);
    });

    it("still treats a widgetless, imageless block as ordinary Markdown", () => {
        const text = "<div>\nOnly text.\n</div>";
        expect(splitMediaLayoutBlocks(text)).toEqual([{ type: "markdown", text }]);
    });

    it("holds an unclosed widget block as the incomplete last segment", () => {
        const text = "Streaming:\n<happy-diagram>flowchart LR\n a --> b";
        expect(splitMediaLayoutBlocks(text)).toEqual([
            { type: "markdown", text: "Streaming:\n" },
            {
                type: "layout",
                html: "<happy-diagram>flowchart LR\n a --> b",
                complete: false,
            },
        ]);
    });
});
