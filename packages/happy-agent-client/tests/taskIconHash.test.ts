import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { taskIconSchema } from "../sources/protocol/tasks.js";

describe("task icon artwork digests", () => {
    it("keeps slug-only icons compatible and accepts an additive SHA-256 digest", () => {
        const legacy = { type: "library", slug: "code-review" };
        expect(Value.Check(taskIconSchema, legacy)).toBe(true);
        expect(Value.Check(taskIconSchema, { ...legacy, hash: "a".repeat(64) })).toBe(true);
        for (const hash of ["", "abc", "A".repeat(64), "z".repeat(64), null]) {
            expect(Value.Check(taskIconSchema, { ...legacy, hash })).toBe(false);
        }
    });
});
