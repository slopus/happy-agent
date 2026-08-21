import { describe, expect, it } from "vitest";

import { renderHappyTerminalVersion } from "./renderHappyTerminalVersion.js";

describe("renderHappyTerminalVersion", () => {
    it("renders numeric semantic versions with the supplied block glyphs", () => {
        expect(renderHappyTerminalVersion("1.2.3", 80)).toEqual([
            " ██╗   ██████╗    ██████╗",
            "███║   ╚════██╗   ╚════██╗",
            "╚██║    █████╔╝    █████╔╝",
            " ██║   ██╔═══╝     ╚═══██╗",
            " ██║██╗███████╗██╗██████╔╝",
            " ╚═╝╚═╝╚══════╝╚═╝╚═════╝",
        ]);
    });

    it("renders every supplied version glyph and wraps the final period at 80 columns", () => {
        expect(renderHappyTerminalVersion("0123456789.", 80)).toEqual([
            " ██████╗  ██╗██████╗ ██████╗ ██╗  ██╗███████╗ ██████╗ ███████╗ █████╗  █████╗",
            "██╔═████╗███║╚════██╗╚════██╗██║  ██║██╔════╝██╔════╝ ╚════██║██╔══██╗██╔══██╗",
            "██║██╔██║╚██║ █████╔╝ █████╔╝███████║███████╗███████╗     ██╔╝╚█████╔╝╚██████║",
            "████╔╝██║ ██║██╔═══╝  ╚═══██╗╚════██║╚════██║██╔═══██╗   ██╔╝ ██╔══██╗ ╚═══██║",
            "╚██████╔╝ ██║███████╗██████╔╝     ██║███████║╚██████╔╝   ██║  ╚█████╔╝ █████╔╝",
            " ╚═════╝  ╚═╝╚══════╝╚═════╝      ╚═╝╚══════╝ ╚═════╝    ╚═╝   ╚════╝  ╚════╝",
            "██╗",
            "╚═╝",
        ]);
    });

    it("uses compact text when the artwork does not fit or has unsupported characters", () => {
        expect(renderHappyTerminalVersion("123.456", 12)).toEqual(["123.456"]);
        expect(renderHappyTerminalVersion("1.2.3-beta.1", 80)).toEqual(["1.2.3-beta.1"]);
    });
});
