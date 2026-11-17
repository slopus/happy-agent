import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { genUiPresentationSchema, toolPresentationSchema } from "../sources/index.js";

const document: unknown = JSON.parse(
    readFileSync(
        new URL("../../../docs/genui/render/compiled/01-stats.render.json", import.meta.url),
        "utf8",
    ),
);

describe("direct Gen UI presentations", () => {
    it("accepts the existing compiled fixture without artifact metadata", () => {
        const presentation = { type: "gen_ui", document };
        expect(Value.Check(genUiPresentationSchema, presentation)).toBe(true);
        expect(Value.Check(toolPresentationSchema, presentation)).toBe(true);
    });

    it("rejects authoring trees, strings, wrong formats, and oversized element maps", () => {
        for (const invalid of ["{}", { genui: 1, root: {} }, { genuiRender: 2 }, null]) {
            expect(
                Value.Check(genUiPresentationSchema, { type: "gen_ui", document: invalid }),
            ).toBe(false);
        }
        expect(
            Value.Check(genUiPresentationSchema, {
                type: "gen_ui",
                document: {
                    genuiRender: 1,
                    compiler: "1.0.0",
                    root: "text",
                    elements: Object.fromEntries(
                        Array.from({ length: 4_001 }, (_, index) => [
                            `text-${String(index)}`,
                            { type: "text", props: {} },
                        ]),
                    ),
                },
            }),
        ).toBe(false);
    });

    it("preserves unknown primitives for lenient rendering and legacy UI as opaque history", () => {
        expect(
            Value.Check(toolPresentationSchema, {
                type: "gen_ui",
                document: {
                    genuiRender: 1,
                    compiler: "future",
                    root: "future",
                    elements: { future: { type: "future", props: { future: true } } },
                },
            }),
        ).toBe(true);
        expect(Value.Check(toolPresentationSchema, { type: "ui", old: true })).toBe(true);
    });
});
