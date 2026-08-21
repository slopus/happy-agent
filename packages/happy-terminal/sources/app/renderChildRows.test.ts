import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderChildRows } from "./renderChildRows.js";

describe("renderChildRows", () => {
    it("uses one branch marker for wrapped and subsequent rows", () => {
        expect(
            renderChildRows(
                [
                    { text: "alpha beta gamma", wrap: true },
                    { text: "delta", wrap: true },
                ],
                { width: 12 },
            ).map((line) => line.trimEnd()),
        ).toEqual(["  └ alpha", "    beta", "    gamma", "    delta"]);
    });

    it("limits a child preview without adding another marker", () => {
        expect(
            renderChildRows(
                [
                    { lineLimit: 2, text: "alpha beta gamma", wrap: true },
                    { text: "delta", wrap: true },
                ],
                { width: 12 },
            ).map((line) => line.trimEnd()),
        ).toEqual(["  └ alpha", "    beta", "    delta"]);
    });

    it("preserves nested indentation on wrapped continuation rows", () => {
        const rendered = renderChildRows(
            [
                { text: "Provider" },
                { text: "  Model" },
                { text: "    1.4k total · 1.2k input · 100 output" },
            ],
            { width: 28 },
        );

        expect(rendered.map((line) => line.trimEnd())).toEqual([
            "  └ Provider",
            "      Model",
            "        1.4k total · 1.2k",
            "        input · 100 output",
        ]);
        expect(rendered.every((line) => visibleWidth(line) <= 28)).toBe(true);
    });
});
