import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderHappyTerminalBanner } from "./renderHappyTerminalBanner.js";

describe("renderHappyTerminalBanner", () => {
    it("renders the Happy Terminal logo beside the installed version", () => {
        const rendered = stripAnsi(
            renderHappyTerminalBanner({
                brand: "\x1b[38;5;202m",
                secondary: "\x1b[2m",
                version: "1.2.3",
                width: 100,
            }).join("\n"),
        );

        const lines = rendered.split("\n");
        expect(lines).toHaveLength(6);
        expect(lines[0]).toContain("██╗  ██╗ █████╗ ██████╗ ██████╗ ██╗   ██╗");
        expect(lines[5]).toContain("TERMINAL");
        expect(rendered).toContain("██████╗");
    });

    it("places compact versions on the final logo row when block artwork does not fit", () => {
        const rendered = stripAnsi(
            renderHappyTerminalBanner({
                brand: "",
                secondary: "",
                version: "1.2.3",
                width: 40,
            }).join("\n"),
        );

        expect(rendered).toBe("  Happy Terminal 1.2.3  ");
    });

    it("keeps a compact identity in terminals too narrow for the logo", () => {
        const lines = renderHappyTerminalBanner({
            brand: "\x1b[38;5;202m",
            secondary: "\x1b[2m",
            version: "1.2.3",
            width: 12,
        });

        expect(stripAnsi(lines.join("\n"))).toBe("  Happy Te  ");
        expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
    });
});

function stripAnsi(value: string): string {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "\u001b") {
            result += value[index];
            continue;
        }
        while (index < value.length && value[index] !== "m") index += 1;
    }
    return result;
}
