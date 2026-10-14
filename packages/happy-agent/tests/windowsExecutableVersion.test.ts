import { describe, expect, it } from "vitest";

import { windowsExecutableVersion } from "../scripts/windowsExecutableVersion.js";

describe("windowsExecutableVersion", () => {
    it("appends a zero revision to a plain version", () => {
        expect(windowsExecutableVersion("0.4.86")).toBe("0.4.86.0");
    });

    it("drops the prerelease label", () => {
        expect(windowsExecutableVersion("0.4.87-preview.3")).toBe("0.4.87.0");
    });

    it("drops build metadata", () => {
        expect(windowsExecutableVersion("1.2.3+build.7")).toBe("1.2.3.0");
    });

    it("rejects a component Windows cannot store", () => {
        expect(() => windowsExecutableVersion("1.2.65536")).toThrow(
            "Cannot express 1.2.65536 as a Windows executable version",
        );
    });

    it("rejects a value that is not semantic", () => {
        expect(() => windowsExecutableVersion("v1.2.3")).toThrow("Windows executable version");
    });
});
