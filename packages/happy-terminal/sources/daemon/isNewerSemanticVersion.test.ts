import { describe, expect, it } from "vitest";

import { isNewerSemanticVersion } from "./isNewerSemanticVersion.js";

describe("isNewerSemanticVersion", () => {
    it("orders release versions by semantic precedence", () => {
        expect(isNewerSemanticVersion("1.3.0", "1.2.9")).toBe(true);
        expect(isNewerSemanticVersion("2.0.0", "10.0.0")).toBe(false);
        expect(isNewerSemanticVersion("1.2.3", "1.2.3")).toBe(false);
    });

    it("orders prereleases below their release", () => {
        expect(isNewerSemanticVersion("1.2.3", "1.2.3-beta.2")).toBe(true);
        expect(isNewerSemanticVersion("1.2.3-beta.10", "1.2.3-beta.2")).toBe(true);
        expect(isNewerSemanticVersion("1.2.3-beta", "1.2.3-1")).toBe(true);
        expect(isNewerSemanticVersion("1.2.3-alpha-beta", "1.2.3-alpha-alpha")).toBe(true);
        expect(isNewerSemanticVersion("1.2.3-beta.2", "1.2.3")).toBe(false);
    });

    it("does not compare invalid installed versions", () => {
        expect(isNewerSemanticVersion("1.2.3", "development")).toBe(false);
    });
});
