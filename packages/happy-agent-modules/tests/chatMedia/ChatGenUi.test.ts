import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { compileChatGenUi } from "../../sources/chatMedia/impl/compileChatGenUi.js";
import { genUiTool } from "../../sources/chatMedia/tools/gen_ui.js";

const fixtures = new URL("../../../../docs/genui/", import.meta.url);
const source = readFileSync(new URL("examples/01-stats.genui.json", fixtures), "utf8");
const compiled: unknown = JSON.parse(
    readFileSync(new URL("render/compiled/01-stats.render.json", fixtures), "utf8"),
);
const documentOf = (root: unknown) => JSON.stringify({ genui: 1, fallback: "A view.", root });
const button = (action: unknown) => documentOf({ type: "button", label: "Continue", action });

describe("direct chat Gen UI", () => {
    it("takes the root node directly and retains component-specific fields", () => {
        const parameters = genUiTool().parameters;
        if (parameters === undefined) throw new Error("Gen UI requires a root node schema.");
        expect(parameters.additionalProperties).toBe(true);
        expect(Value.Check(parameters, { type: "text", text: "Hello" })).toBe(true);
        expect(
            Value.Check(parameters, { type: "stack", children: [{ type: "text", text: "Hello" }] }),
        ).toBe(true);
        for (const input of [
            null,
            [],
            "{}",
            {},
            { type: "" },
            { document: {} },
            { genui: 1, root: { type: "text", text: "Hello" } },
        ]) {
            expect(Value.Check(parameters, input)).toBe(false);
        }
    });

    it("matches the cross-platform compiler fixture exactly and is deterministic", () => {
        expect(compileChatGenUi(source)).toEqual({ type: "gen_ui", document: compiled });
        expect(compileChatGenUi(source)).toEqual(compileChatGenUi(source));
    });

    it("returns only a small confirmation to the model, not the render tree", () => {
        const result = genUiTool().toLLM({ shown: true, presentation: compileChatGenUi(source) });
        expect(JSON.stringify(result)).toContain("no artifact was created");
        expect(JSON.stringify(result)).toContain("revenue $1.24M");
        expect(JSON.stringify(result)).not.toContain("genuiRender");
    });

    it.each(["assets/photo.png", "https://example.com/photo.png", "file:///private/photo.png"])(
        "refuses image references without resolving %s",
        (src) => {
            expect(() =>
                compileChatGenUi(documentOf({ type: "image", src, alt: "Photo" })),
            ).toThrow(/root<image>\.src: direct chat Gen UI does not support images/);
        },
    );

    it.each(["13-secret", "14-cluster-secret"])("refuses artifact-only %s actions", (name) => {
        const input = readFileSync(new URL(`examples/${name}.genui.json`, fixtures), "utf8");
        expect(() => compileChatGenUi(input)).toThrow(/supports only message, open, and copy/);
    });

    it("refuses plugins and tool execution", () => {
        expect(() =>
            compileChatGenUi(button({ type: "plugin", plugin: { id: "example" } })),
        ).toThrow(/supports only message, open, and copy/);
        expect(() =>
            compileChatGenUi(button({ type: "tool", name: "exec_command", input: {} })),
        ).toThrow(/supports only message, open, and copy/);
    });

    it.each([
        "http://example.com",
        "https:example.com",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://person:pass@example.com",
        " https://example.com",
        "https://example.com/a b",
        "https://example.com\\other",
    ])("refuses unsafe open and Markdown links: %s", (url) => {
        expect(() => compileChatGenUi(button({ type: "open", url }))).toThrow(/HTTPS/);
        // The Markdown parser may preserve malformed links as text rather than a link.
        if (!url.includes(" ") && !url.includes(")") && !url.includes("\\")) {
            expect(() =>
                compileChatGenUi(documentOf({ type: "text", text: `[Read more](${url})` })),
            ).toThrow(/HTTPS/);
        }
    });

    it.each([
        { type: "message", text: "Break down Q3" },
        { type: "copy", text: "$1.24M" },
        { type: "copy", text: "" },
        { type: "open", url: "https://example.com/report" },
    ])("keeps safe action $type unchanged", (action) => {
        expect(compileChatGenUi(button(action)).document.elements.button?.props.action).toEqual(
            action,
        );
    });

    it("reports invalid props, nesting, authoring bytes, and render expansion", () => {
        expect(() =>
            compileChatGenUi(documentOf({ type: "stat", label: "Revenue", value: 123 })),
        ).toThrow(/root<stat>\.value/);
        expect(() => compileChatGenUi(" ".repeat(256 * 1024 + 1))).toThrow(/larger/);
        expect(() =>
            compileChatGenUi(documentOf({ type: "text", text: "é".repeat(128 * 1024) })),
        ).toThrow(/larger/);
        expect(() =>
            compileChatGenUi(
                documentOf({
                    type: "stack",
                    children: Array.from({ length: 200 }, () => ({ type: "text", text: "Item" })),
                }),
            ),
        ).toThrow(/more than 200 nodes/);
        let nested: unknown = { type: "text", text: "Deep" };
        for (let depth = 0; depth < 7; depth++) nested = { type: "stack", children: [nested] };
        expect(() => compileChatGenUi(documentOf(nested))).toThrow(/nested deeper/);
        const columns = ["a", "b", "c", "d", "e", "f"].map((key) => ({ key, label: key }));
        const rows = Array.from({ length: 30 }, () =>
            Object.fromEntries(columns.map(({ key }) => [key, "x"])),
        );
        expect(() =>
            compileChatGenUi(
                documentOf({
                    type: "stack",
                    children: Array.from({ length: 12 }, () => ({ type: "table", columns, rows })),
                }),
            ),
        ).toThrow(/more than 4000/);
    });
});
