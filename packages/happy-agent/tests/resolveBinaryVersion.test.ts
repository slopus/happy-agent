import { describe, expect, it } from "vitest";

import { resolveBinaryVersion } from "../scripts/resolveBinaryVersion.js";

describe("resolveBinaryVersion", () => {
    it("uses the package version for an ordinary local build", () => {
        expect(resolveBinaryVersion("0.0.0", undefined)).toBe("0.0.0");
    });

    it("uses the explicit version for a GitHub release build", () => {
        expect(resolveBinaryVersion("0.0.0", "1.2.3-beta.4")).toBe("1.2.3-beta.4");
    });

    it("rejects a value that cannot identify a release", () => {
        expect(() => resolveBinaryVersion("0.0.0", "v1.2.3")).toThrow(
            "Happy Agent binary version is not semantic",
        );
    });
});
