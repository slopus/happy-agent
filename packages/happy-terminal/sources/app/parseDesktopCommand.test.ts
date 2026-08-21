import { describe, expect, it } from "vitest";

import { parseDesktopCommand } from "./parseDesktopCommand.js";

describe("parseDesktopCommand", () => {
    it("uses the normal build and launch flow by default", () => {
        expect(parseDesktopCommand([])).toEqual({
            buildOnly: false,
            forceBuild: false,
            skipBuild: false,
        });
    });

    it("parses the local source checkout and build controls", () => {
        expect(
            parseDesktopCommand(["--happy2-root=/source/happy2", "--build-only", "--force-build"]),
        ).toEqual({
            buildOnly: true,
            forceBuild: true,
            happy2Root: "/source/happy2",
            skipBuild: false,
        });
    });

    it("rejects contradictory build controls", () => {
        expect(() => parseDesktopCommand(["--skip-build", "--force-build"])).toThrow(
            "cannot skip and force the desktop build",
        );
    });

    it("rejects an unknown option", () => {
        expect(() => parseDesktopCommand(["--source"])).toThrow(
            "Unknown happy-terminal desktop option '--source'.",
        );
    });
});
