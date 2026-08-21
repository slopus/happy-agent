import { afterEach, describe, expect, it } from "vitest";

import {
    createGym,
    type Gym,
    type TerminalCellSnapshot,
    type TerminalSnapshot,
} from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Codex composer and footer visual contract", () => {
    it("derives the composer surface and renders a quiet lower-case status line", async () => {
        const gym = await createGym({
            inference: [{ content: [{ text: "Visual contract captured.", type: "text" }] }],
        });
        running.add(gym);

        gym.terminal.type("Capture the visual contract.");
        gym.terminal.press("enter");

        const snapshot = await gym.terminal.waitForText("Visual contract captured.", 30_000);
        const inputRow = rowContaining(snapshot, "Ask Happy Terminal to do anything");
        const surfaceRows = [inputRow - 1, inputRow + 1];
        for (const row of surfaceRows) {
            expect(cellsOnRow(snapshot, row)).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        background: { kind: "palette", index: 235 },
                    }),
                ]),
            );
            expect(
                cellsOnRow(snapshot, row).every(
                    (cell) => cell.background?.kind === "palette" && cell.background.index === 235,
                ),
            ).toBe(true);
        }

        const footer = "gym off · /workspace · full access";
        expect(snapshot.text).toContain(footer);
        const footerRow = rowContaining(snapshot, footer);
        expect(footerRow).toBe(inputRow + 2);
        expect(snapshot.rows[footerRow + 1]).toBe("");
        expect(stylesForText(snapshot, "gym off", footerRow)).toEqual([
            expect.objectContaining({ foreground: { kind: "palette", index: 3 } }),
        ]);
        expect(stylesForText(snapshot, "/workspace", footerRow)).toEqual([
            expect.objectContaining({ foreground: { kind: "palette", index: 2 } }),
        ]);
        expect(stylesForText(snapshot, "full access", footerRow)).toEqual([
            expect.objectContaining({ dim: true, foreground: null }),
        ]);
    }, 120_000);
});

function cellsOnRow(snapshot: TerminalSnapshot, row: number): TerminalCellSnapshot[] {
    return snapshot.cells.filter((cell) => cell.y === row);
}

function rowContaining(snapshot: TerminalSnapshot, text: string): number {
    const row = snapshot.rows.findIndex((line) => line.includes(text));
    if (row < 0) throw new Error(`Could not find ${JSON.stringify(text)} in terminal snapshot.`);
    return row;
}

function stylesForText(
    snapshot: TerminalSnapshot,
    text: string,
    row = rowContaining(snapshot, text),
): TerminalCellSnapshot[] {
    const start = snapshot.rows[row]?.indexOf(text) ?? -1;
    const cells = snapshot.cells.filter(
        (cell) => cell.y === row && cell.x >= start && cell.x < start + text.length,
    );
    return cells.filter(
        (cell, index) =>
            index === 0 ||
            JSON.stringify({ dim: cell.dim, foreground: cell.foreground }) !==
                JSON.stringify({
                    dim: cells[index - 1]?.dim,
                    foreground: cells[index - 1]?.foreground,
                }),
    );
}
