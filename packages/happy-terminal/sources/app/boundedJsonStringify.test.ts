import { describe, expect, it } from "vitest";

import { boundedJsonStringify } from "./boundedJsonStringify.js";

describe("boundedJsonStringify", () => {
    it("preserves ordinary JSON exactly", () => {
        expect(
            boundedJsonStringify(
                { title: "List tabs", timeout_ms: 30_000, nested: [true, null, 3] },
                4_096,
            ),
        ).toBe('{"title":"List tabs","timeout_ms":30000,"nested":[true,null,3]}');
    });

    it("bounds UTF-8 bytes and stops traversing large arrays", () => {
        let highestReadIndex = -1;
        const millionItems = new Proxy([], {
            get(_target, property) {
                if (property === "length") return 1_000_000;
                if (typeof property === "string" && /^\d+$/u.test(property)) {
                    highestReadIndex = Math.max(highestReadIndex, Number(property));
                    return Number(property);
                }
                return undefined;
            },
        });

        const rendered = boundedJsonStringify(
            { items: millionItems, unicode: "🔥".repeat(10_000) },
            256,
        );

        expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(256);
        expect(rendered).toContain("[truncated]");
        expect(highestReadIndex).toBeLessThan(200);
    });
});
