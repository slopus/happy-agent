import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { renderStartupStatusCard } from "./renderStartupStatusCard.js";
import type { StartupStatusCardModel } from "./StartupStatusCardModel.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderStartupStatusCard", () => {
    it("renders both quota windows and readable reset countdowns at wide widths", () => {
        const rendered = stripAnsi(
            renderStartupStatusCard({
                model: status({
                    fast: true,
                    usage: {
                        fiveHour: { percentLeft: 68, resetsIn: "2h 14m" },
                        weekly: { percentLeft: 84, resetsIn: "4d 6h" },
                    },
                }),
                theme: DEFAULT_TERMINAL_THEME,
                width: 96,
            }).join("\n"),
        );

        expect(rendered).toContain("Rig 1.2.3 · New session");
        expect(rendered).toContain("Model: GPT Test · Reasoning: High · Provider: Codex · Fast");
        expect(rendered).toContain("Workspace: /workspace · Environment: Local");
        expect(rendered).toContain("Access: Full access");
        expect(rendered).toContain("Engine: 4.5.6");
        expect(rendered).not.toContain("GitHub");
        expect(rendered).toContain("Usage: 5h 68% left · week 84% left");
        expect(rendered).toContain("Resets: 5h in 2h 14m · week in 4d 6h");
    });

    it("renders partial data and omits unavailable usage", () => {
        const partial = stripAnsi(
            renderStartupStatusCard({
                model: status({
                    usage: { weekly: { percentLeft: 84, resetsIn: "4d 6h" } },
                }),
                theme: DEFAULT_TERMINAL_THEME,
                width: 96,
            }).join("\n"),
        );
        expect(partial).toContain("Usage: week 84% left");
        expect(partial).toContain("Resets: week in 4d 6h");
        expect(partial).not.toContain("5h");

        const unavailable = stripAnsi(
            renderStartupStatusCard({
                model: status({ usage: {} }),
                theme: DEFAULT_TERMINAL_THEME,
                width: 96,
            }).join("\n"),
        );
        expect(unavailable).not.toContain("Usage:");
        expect(unavailable).not.toContain("Resets:");
    });

    it("keeps both percentages but drops reset countdowns at intermediate widths", () => {
        const rendered = stripAnsi(
            renderStartupStatusCard({
                model: status({
                    usage: {
                        fiveHour: { percentLeft: 68, resetsIn: "2h 14m" },
                        weekly: { percentLeft: 84, resetsIn: "4d 6h" },
                    },
                }),
                theme: DEFAULT_TERMINAL_THEME,
                width: 60,
            }).join("\n"),
        );

        expect(rendered).toContain("Usage: 5h 68% left · week 84% left");
        expect(rendered).not.toContain("Resets:");
        expect(rendered).not.toContain("2h 14m");
        expect(rendered).not.toContain("4d 6h");
    });

    it("preserves useful fields and graphemes at nineteen columns", () => {
        const lines = renderStartupStatusCard({
            model: status({
                usage: {
                    fiveHour: { percentLeft: 68, resetsIn: "2h 14m" },
                    weekly: { percentLeft: 84, resetsIn: "4d 6h" },
                },
                workspace: "/very/long/👩🏽‍💻-project",
            }),
            theme: DEFAULT_TERMINAL_THEME,
            width: 19,
        });
        const rendered = stripAnsi(lines.join("\n"));

        expect(rendered).toContain("New session");
        expect(rendered).toContain("GPT Test");
        expect(rendered).toContain("High");
        expect(rendered).toContain("Codex");
        expect(rendered).toContain("👩🏽‍💻-project");
        expect(rendered).toContain("Local");
        expect(rendered).toContain("Full access");
        expect(rendered).toContain("5h 68% left");
        expect(rendered).toContain("week 84% left");
        expect(rendered).not.toContain("Resets:");
        expect(rendered).not.toContain("2h 14m");
        expect(rendered).not.toContain("Fast");
        expect(rendered).not.toContain("�");
        expect(lines.every((line) => visibleWidth(line) <= 19)).toBe(true);
    });

    it("omits the card below four columns and never exceeds tiny widths", () => {
        expect(
            renderStartupStatusCard({
                model: status(),
                theme: DEFAULT_TERMINAL_THEME,
                width: 3,
            }),
        ).toEqual([]);
        for (let width = 4; width <= 18; width += 1) {
            expect(
                renderStartupStatusCard({
                    model: status({
                        usage: {
                            fiveHour: { percentLeft: 68, resetsIn: "2h 14m" },
                            weekly: { percentLeft: 84, resetsIn: "4d 6h" },
                        },
                    }),
                    theme: DEFAULT_TERMINAL_THEME,
                    width,
                }).every((line) => visibleWidth(line) <= width),
            ).toBe(true);
        }
    });
});

function status(overrides: Partial<StartupStatusCardModel> = {}): StartupStatusCardModel {
    return {
        access: "Full access",
        engineVersion: "4.5.6",
        environment: "Local",
        fast: false,
        model: "GPT Test",
        provider: "Codex",
        reasoning: "High",
        session: "New session",
        version: "1.2.3",
        workspace: "/workspace",
        ...overrides,
    };
}
