import { describe, expect, it } from "vitest";

import { resolveTerminalTheme } from "./resolveTerminalTheme.js";

describe("resolveTerminalTheme", () => {
    it("resolves semantic roles from ANSI names, palette indexes, and RGB values", () => {
        expect(
            resolveTerminalTheme({
                accent: "cyan",
                brand: "ansi:202",
                error: "red",
                primary: "default",
                secondary: "dim",
                success: "bright-green",
                warning: "#A1b2C3",
            }),
        ).toEqual({
            accent: "\x1b[36m",
            brand: "\x1b[38;5;202m",
            error: "\x1b[31m",
            primary: "\x1b[39m",
            secondary: "\x1b[2m\x1b[39m",
            success: "\x1b[92m",
            warning: "\x1b[38;2;161;178;195m",
            inputBackground: "\x1b[48;5;235m",
            isLight: false,
        });
    });

    it("derives the Codex composer surface from the terminal background", () => {
        const config = {
            accent: "cyan",
            brand: "ansi:202",
            error: "red",
            primary: "default",
            secondary: "dim",
            success: "green",
            warning: "yellow",
        };

        expect(
            resolveTerminalTheme(config, { r: 13, g: 13, b: 13 }, "ansi256").inputBackground,
        ).toBe("\x1b[48;5;235m");
        expect(
            resolveTerminalTheme(config, { r: 24, g: 24, b: 24 }, "truecolor").inputBackground,
        ).toBe("\x1b[48;2;51;51;51m");
        expect(
            resolveTerminalTheme(config, { r: 250, g: 250, b: 250 }, "truecolor").inputBackground,
        ).toBe("\x1b[48;2;240;240;240m");
        expect(resolveTerminalTheme(config, { r: 250, g: 250, b: 250 }, "truecolor").isLight).toBe(
            true,
        );
    });

    it("rejects invalid values with the semantic role", () => {
        expect(() =>
            resolveTerminalTheme({
                accent: "cyan",
                brand: "ansi:999",
                error: "red",
                primary: "default",
                secondary: "dim",
                success: "green",
                warning: "yellow",
            }),
        ).toThrow('Invalid theme.brand value "ansi:999"');
    });
});
