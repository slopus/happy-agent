import { describe, expect, it } from "vitest";

import { renderExploration } from "./renderExploration.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderExploration", () => {
    it("renders structured rows and coalesces adjacent reads", () => {
        const rendered = renderExploration(
            [
                {
                    type: "exploration",
                    operations: [
                        { kind: "list", target: "src" },
                        { command: "rg needle src", kind: "search", path: "src", query: "needle" },
                    ],
                },
                { type: "exploration", operations: [{ kind: "read", name: "one.ts" }] },
                {
                    type: "exploration",
                    operations: [
                        { kind: "read", name: "one.ts" },
                        { kind: "read", name: "two.ts" },
                    ],
                },
            ],
            {
                accent: "",
                brand: "",
                primary: "",
                status: "",
                title: "Explored",
                width: 80,
            },
        ).map((line) => stripAnsi(line).trimEnd());

        expect(rendered).toEqual([
            "• Explored",
            "  └ List src",
            "    Search needle in src",
            "    Read one.ts, two.ts",
        ]);
    });
});
