import { describe, expect, it } from "vitest";

import { orderKeyAfter } from "../orderKeyAfter.js";

describe("orderKeyAfter", () => {
    const items = [
        { id: "first", orderKey: "a0" },
        { id: "second", orderKey: "a1" },
        { id: "third", orderKey: "a2" },
    ];

    it("moves an item to the beginning", () => {
        const key = orderKeyAfter(items, "third", null);
        expect(key < "a0").toBe(true);
    });

    it("moves an item between siblings", () => {
        const key = orderKeyAfter(items, "first", "second");
        expect("a1" < key && key < "a2").toBe(true);
    });

    it("moves an item to the end", () => {
        const key = orderKeyAfter(items, "first", "third");
        expect(key > "a2").toBe(true);
    });

    it("preserves an item already at the requested position", () => {
        expect(orderKeyAfter([...items].reverse(), "second", "first")).toBe("a1");
        expect(orderKeyAfter(items, "first", null)).toBe("a0");
    });

    it("rejects cross-group and self references", () => {
        expect(() => orderKeyAfter(items, "first", "missing")).toThrow("same group");
        expect(() => orderKeyAfter(items, "first", "first")).toThrow("after itself");
    });
});
