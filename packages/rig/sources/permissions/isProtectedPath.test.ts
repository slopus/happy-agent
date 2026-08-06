import { describe, expect, it } from "vitest";

import { isProtectedPath } from "./isProtectedPath.js";

describe("isProtectedPath", () => {
    it("matches the configured path and descendants only", () => {
        const protectedPaths = ["/workspace/plans"];

        expect(isProtectedPath("/workspace/plans", protectedPaths)).toBe(true);
        expect(isProtectedPath("/workspace/plans/one.md", protectedPaths)).toBe(true);
        expect(isProtectedPath("/workspace/plans-old", protectedPaths)).toBe(false);
        expect(isProtectedPath("/workspace/other", protectedPaths)).toBe(false);
    });
});
