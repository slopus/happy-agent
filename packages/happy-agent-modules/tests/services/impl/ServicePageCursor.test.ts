import { describe, expect, it } from "vitest";
import {
    servicePageCursor,
    readServicePageCursor,
} from "../../../sources/services/impl/ServicePageCursor.js";

describe("service pagination positions", () => {
    it("binds an exclusive history position to one workspace and selection", () => {
        const cursor = servicePageCursor("aaworkspace", true, 42)!;
        expect(cursor.length).toBeLessThanOrEqual(512);
        expect(readServicePageCursor("aaworkspace", true, cursor)).toBe(42);
        expect(() => readServicePageCursor("otherworkspace", true, cursor)).toThrow();
        expect(() => readServicePageCursor("aaworkspace", false, cursor)).toThrow();
        expect(servicePageCursor("aaworkspace", true, null)).toBeNull();
        expect(readServicePageCursor("aaworkspace", true, undefined)).toBeUndefined();
    });
    it("rejects malformed, oversized, noncanonical and invalid numeric positions", () => {
        for (const value of [
            "",
            "!",
            "a".repeat(513),
            Buffer.from("null").toString("base64url"),
            Buffer.from("{}").toString("base64url"),
        ]) {
            expect(() => readServicePageCursor("aaworkspace", true, value)).toThrow();
        }
        for (const before of [-1, 0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
            expect(() => servicePageCursor("aaworkspace", true, before)).toThrow();
    });
});
