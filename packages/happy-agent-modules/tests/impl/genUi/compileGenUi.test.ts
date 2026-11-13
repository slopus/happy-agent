import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileGenUi, genUiImageSources } from "../../../sources/impl/genUi/compileGenUi.js";
import {
    compileGenUiChart,
    formatChartNumber,
} from "../../../sources/impl/genUi/compileGenUiChart.js";
import { parseInlineMarkdown } from "../../../sources/impl/genUi/parseInlineMarkdown.js";
import {
    genUiRenderLimitErrors,
    validateGenUiDocument,
    validateGenUiRenderDocument,
    type GenUiDocument,
} from "../../../sources/impl/genUi/validateGenUiDocument.js";

const spec = fileURLToPath(new URL("../../../../../docs/genui", import.meta.url));

function documentOf(source: unknown): GenUiDocument {
    const validation = validateGenUiDocument(JSON.stringify(source));
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    return validation.document;
}

/** Compile with every image measured as a 1600×1067 photo. */
function compile(document: GenUiDocument) {
    return compileGenUi(
        document,
        new Map(
            genUiImageSources(document).map((source) => [
                source.src,
                { file: source.src, width: 1600, height: 1067, thumbhash: "AAAA" },
            ]),
        ),
    );
}

describe("the Gen UI compiler", () => {
    const examples = readdirSync(join(spec, "examples")).filter((name) =>
        name.endsWith(".genui.json"),
    );

    it.each(examples)("compiles the example %s to a valid render document", (name) => {
        const validation = validateGenUiDocument(
            readFileSync(join(spec, "examples", name), "utf8"),
        );
        if (!validation.ok) throw new Error(validation.errors.join("\n"));
        const render = compile(validation.document);
        expect(validateGenUiRenderDocument(render)).toEqual([]);
        expect(render.elements[render.root]).toBeDefined();
    });

    it("matches the checked-in compiled examples, which renderers use as fixtures", () => {
        for (const name of examples) {
            const validation = validateGenUiDocument(
                readFileSync(join(spec, "examples", name), "utf8"),
            );
            if (!validation.ok) throw new Error(name);
            const images = new Map(
                genUiImageSources(validation.document).map((source) => [
                    source.src,
                    {
                        file: source.src,
                        width: 1600,
                        height: 1067,
                        thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
                    },
                ]),
            );
            const golden = readFileSync(
                join(spec, "render", "compiled", name.replace(/\.genui\.json$/, ".render.json")),
                "utf8",
            );
            expect(`${JSON.stringify(compileGenUi(validation.document, images), null, 2)}\n`).toBe(
                golden,
            );
        }
    });

    it("lowers a card with its header, children, and actions with resolved variants", () => {
        const copy = (text: string) => ({ type: "copy", text });
        const render = compile(
            documentOf({
                genui: 1,
                root: {
                    type: "card",
                    title: "Deploy",
                    badge: { text: "Live", tone: "success" },
                    children: [{ type: "text", text: "Ready" }],
                    actions: [
                        { type: "button", id: "go", label: "Go", action: copy("go") },
                        { type: "button", label: "Stop", action: copy("stop") },
                    ],
                },
            }),
        );
        expect(render.root).toBe("card");
        expect(render.elements.card).toEqual({
            type: "box",
            props: { role: "card", gap: "blocks" },
            children: ["card.header", "text", "card.actions"],
        });
        expect(render.elements["card.header"]?.children).toEqual(["card.title", "card.badge"]);
        expect(render.elements["card.actions"]?.children).toEqual(["go", "button"]);
        expect(render.elements.go?.props.variant).toBe("primary");
        expect(render.elements.button?.props.variant).toBe("secondary");
    });

    it("passes colour names through as tones, and behaves as neutral where a tone means something", () => {
        const render = compile(
            documentOf({
                genui: 1,
                root: {
                    type: "card",
                    badge: { text: "Desktop", tone: "blue" },
                    children: [
                        { type: "callout", text: "Grouped", tone: "teal" },
                        { type: "text", text: "Tag", tone: "pink" },
                    ],
                    actions: [
                        {
                            type: "button",
                            label: "Go",
                            tone: "orange",
                            action: { type: "copy", text: "go" },
                        },
                    ],
                },
            }),
        );
        expect(render.elements["card.badge"]?.props).toEqual({ text: "Desktop", tone: "blue" });
        expect(render.elements.callout?.props).toMatchObject({ role: "notice", tone: "teal" });
        // A colour picks the neutral callout icon.
        expect(render.elements["callout.icon"]?.props).toEqual({
            name: "info",
            tone: "teal",
            role: "leading",
        });
        expect(render.elements.text?.props).toMatchObject({ tone: "pink" });
        expect(render.elements.button?.props).toMatchObject({ tone: "orange", variant: "primary" });
    });

    it("keys nodes by id, else by type numbered in document order, around ids", () => {
        const render = compile(
            documentOf({
                genui: 1,
                root: {
                    type: "stack",
                    children: [
                        { type: "text", text: "One" },
                        { type: "text", id: "text-2", text: "Named" },
                        { type: "text", text: "Three" },
                    ],
                },
            }),
        );
        expect(render.elements.stack?.children).toEqual(["text", "text-2", "text-3"]);
        expect(render.elements["text-3"]?.props.spans).toEqual([{ text: "Three" }]);
    });

    it("turns a wide table into blocks on phones and a grid on wide layouts", () => {
        const render = compile(
            documentOf({
                genui: 1,
                root: {
                    type: "table",
                    id: "t",
                    columns: [
                        { key: "name", label: "Name" },
                        { key: "runs", label: "Runs", kind: "number" },
                        { key: "state", label: "State", kind: "badge" },
                        { key: "owner", label: "Owner" },
                    ],
                    rows: [
                        {
                            name: "api",
                            runs: "50",
                            state: { text: "Flaky", tone: "warning" },
                            owner: "Kai",
                        },
                    ],
                },
            }),
        );
        expect(render.elements.t?.type).toBe("switch");
        expect(render.elements["t.regular"]?.type).toBe("grid");
        expect(render.elements["t.compact"]?.type).toBe("box");
        expect(render.elements["t.compact.0.line"]?.children).toEqual([
            "t.compact.0.title",
            "t.compact.0.badge",
        ]);
        expect(render.elements["t.compact.0.badge"]?.props).toEqual({
            text: "Flaky",
            tone: "warning",
        });
        expect(render.elements["t.compact.0.title"]?.props).toMatchObject({ role: "rowhead" });
        expect(render.elements["t.regular.0.0"]?.props).toMatchObject({ role: "rowhead" });
        expect(render.elements["t.regular.0.3"]?.props).toMatchObject({ role: "cell" });
        expect(render.elements["t.compact.0"]?.props).toMatchObject({ role: "record" });
        // Grid cells take their column's alignment and carry none of their own.
        expect(render.elements["t.regular.0.1"]?.props).toEqual({
            spans: [{ text: "50" }],
            role: "number",
            fixed: true,
        });
    });

    it("reports a document whose render would be over the render limits", () => {
        const columns = ["a", "b", "c", "d", "e", "f"].map((key) => ({ key, label: key }));
        const rows = Array.from({ length: 30 }, () =>
            Object.fromEntries(columns.map((column) => [column.key, "x"])),
        );
        const render = compile(
            documentOf({
                genui: 1,
                root: {
                    type: "stack",
                    children: Array.from({ length: 12 }, () => ({ type: "table", columns, rows })),
                },
            }),
        );
        expect(genUiRenderLimitErrors(render)).toEqual([
            expect.stringMatching(
                /^document: compiles to \d+ render elements, more than 4000; show fewer rows/,
            ),
        ]);
    });
});

describe("inline Markdown", () => {
    it("parses strong, emphasis, code, and links into spans", () => {
        expect(
            parseInlineMarkdown(
                "A **bold** _and *nested* move_ with `x*y`, [**our** docs](https://x.dev).",
            ),
        ).toEqual([
            { text: "A " },
            { text: "bold", strong: true },
            { text: " " },
            { text: "and nested move", emphasis: true },
            { text: " with " },
            { text: "x*y", code: true },
            { text: ", " },
            { text: "our", link: "https://x.dev", strong: true },
            { text: " docs", link: "https://x.dev" },
            { text: "." },
        ]);
    });

    it("keeps unclosed marks, escapes, and block syntax as literal text", () => {
        expect(parseInlineMarkdown("2 * 3 = 6, \\*not\\*, # heading")).toEqual([
            { text: "2 * 3 = 6, *not*, # heading" },
        ]);
        expect(parseInlineMarkdown("")).toEqual([{ text: "" }]);
    });
});

describe("charts", () => {
    it("abbreviates numbers and puts a negative sign before the prefix", () => {
        expect(formatChartNumber(1240000, { prefix: "$" })).toBe("$1.2M");
        expect(formatChartNumber(-1200, { prefix: "$" })).toBe("-$1.2k");
        expect(formatChartNumber(42, { suffix: " ms" })).toBe("42 ms");
        expect(formatChartNumber(2_500_000_000)).toBe("2.5B");
    });

    it("starts bars at zero and a high line near its values, with round ticks", () => {
        const bar = compileGenUiChart({
            kind: "bar",
            labels: ["a", "b"],
            series: [{ name: "s", values: [90, 110] }],
        });
        expect(bar.y?.ticks.map((tick) => tick.value)).toEqual([0, 50, 100, 150]);
        const line = compileGenUiChart({
            kind: "line",
            labels: ["a", "b", "c"],
            series: [
                { name: "s", values: [90, 110] },
                { name: "t", values: [95, 100, 105], emphasis: true },
            ],
        });
        expect(line.y?.min).toBe(90);
        expect(line.y?.ticks.map((tick) => tick.label)).toEqual(["90", "95", "100", "105", "110"]);
        expect(line.series.map((series) => [series.values, series.color])).toEqual([
            [[90, 110, null], "muted"],
            [[95, 100, 105], 2],
        ]);
        expect(line.series[0]?.labels).toEqual(["90", "110", null]);
    });

    it("gives named series their colour and still mutes them beside an emphasised one", () => {
        const chart = compileGenUiChart({
            kind: "bar",
            labels: ["a"],
            series: [
                { name: "s", values: [1], color: "brown" },
                { name: "t", values: [2] },
                { name: "u", values: [3], color: "teal", emphasis: true },
                { name: "v", values: [4], color: "pink" },
            ],
        });
        expect(chart.series.map((series) => series.color)).toEqual([
            "muted",
            "muted",
            "teal",
            "muted",
        ]);
        expect(
            compileGenUiChart({
                kind: "line",
                labels: ["a"],
                series: [
                    { name: "s", values: [1], color: "brown" },
                    { name: "t", values: [2] },
                ],
            }).legend?.map((row) => row.color),
        ).toEqual(["brown", 2]);
    });

    it("draws a donut's positive slices with its total and summary", () => {
        expect(
            compileGenUiChart({
                kind: "donut",
                labels: ["Cloud", "Office", "Refunds"],
                series: [{ name: "Spend", values: [300, 100, -20] }],
                format: { prefix: "$" },
            }),
        ).toMatchObject({
            slices: [
                { label: "Cloud", value: 300, color: 1 },
                { label: "Office", value: 100, color: 2 },
            ],
            center: { value: "$400", label: "Total" },
            summary: "Donut chart of Spend, total $400: Cloud $300 (75%), Office $100 (25%).",
        });
    });
});
