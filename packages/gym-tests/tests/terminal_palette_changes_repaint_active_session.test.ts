import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
    createGym,
    renderTerminalSnapshotPng,
    type Gym,
    type TerminalCellSnapshot,
    type TerminalColorScheme,
    type TerminalSnapshot,
} from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const prompt = "Keep this turn active while the terminal palette changes.";
const composerPlaceholder = "Ask Happy Terminal to do anything";
const terminalWidth = 100;

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("terminal palette changes during an active session", () => {
    it("repaints the live surface without rewriting retained transcript rows", async () => {
        const gym = await createGym({
            cols: terminalWidth,
            inference: [
                {
                    content: [{ text: "Palette transition complete.", type: "text" }],
                    delayMs: 30_000,
                },
            ],
            terminalColorScheme: "light",
        });
        running.add(gym);

        gym.terminal.type(prompt);
        gym.terminal.press("enter");
        await gym.terminal.waitForText(prompt);

        const dark = await transition(gym, "dark");
        await captureProof(dark, "dark");

        const light = await transition(gym, "light");
        await captureProof(light, "light");

        assertStablePalette(dark, "dark");
        assertStablePalette(light, "light");
        expect(dark.scroll.atBottom).toBe(true);
        expect(light.scroll.atBottom).toBe(true);
    });
});

async function transition(gym: Gym, colorScheme: TerminalColorScheme): Promise<TerminalSnapshot> {
    gym.terminal.setColorScheme(colorScheme);
    try {
        return await gym.terminal.waitUntil(
            (snapshot) => hasCompletePalette(snapshot, colorScheme),
            `${colorScheme} whole-screen palette repaint`,
            2_000,
        );
    } catch (error) {
        const snapshot = await gym.terminal.snapshot();
        await captureProof(snapshot, colorScheme);
        throw new Error(
            `${String(error)}\nPalette diagnostics: ${JSON.stringify(paletteDiagnostics(snapshot))}`,
        );
    }
}

function paletteDiagnostics(snapshot: TerminalSnapshot): object {
    const backgrounds = new Map<string, number>();
    for (const cell of snapshot.cells) {
        const key = JSON.stringify(cell.background);
        backgrounds.set(key, (backgrounds.get(key) ?? 0) + 1);
    }
    return {
        backgrounds: Object.fromEntries(backgrounds),
        defaultBackground: snapshot.defaultBackground,
        defaultForeground: snapshot.defaultForeground,
        synchronizedOutputActive: snapshot.synchronizedOutputActive,
    };
}

function hasCompletePalette(snapshot: TerminalSnapshot, colorScheme: TerminalColorScheme): boolean {
    try {
        assertStablePalette(snapshot, colorScheme);
        return true;
    } catch {
        return false;
    }
}

function assertStablePalette(snapshot: TerminalSnapshot, colorScheme: TerminalColorScheme): void {
    const light = colorScheme === "light";
    const expectedSurface = light ? 254 : 235;
    const expectedForeground = light ? 0x0d : 0xee;
    const expectedBackground = light ? 0xee : 0x0d;
    expect(snapshot.synchronizedOutputActive).toBe(false);
    expect(snapshot.defaultForeground).toEqual({
        kind: "rgb",
        red: expectedForeground,
        green: expectedForeground,
        blue: expectedForeground,
    });
    expect(snapshot.defaultBackground).toEqual({
        kind: "rgb",
        red: expectedBackground,
        green: expectedBackground,
        blue: expectedBackground,
    });
    expect(snapshot.text).toContain("██████╗ ██╗ ██████╗");
    expect(snapshot.text).toContain(prompt);
    expect(snapshot.text).toContain("Working");
    expect(snapshot.text).toContain(composerPlaceholder);
    expect(snapshot.text).toContain("gym off · /workspace · full access");

    const waveForegrounds = foregroundPaletteIndexesForText(snapshot, "Working");
    expect(waveForegrounds).toHaveLength("Working".length);
    const minimumWaveForeground = light ? 232 : 244;
    const maximumWaveForeground = light ? 243 : 255;
    for (const foreground of waveForegrounds) {
        expect(foreground).toBeGreaterThanOrEqual(minimumWaveForeground);
        expect(foreground).toBeLessThanOrEqual(maximumWaveForeground);
    }

    const explicitBackgrounds = snapshot.cells
        .map((cell) => cell.background)
        .filter((background): background is NonNullable<typeof background> => background !== null);
    expect(
        explicitBackgrounds.filter(
            (background) =>
                !(
                    background.kind === "palette" &&
                    (background.index === expectedSurface ||
                        background.index === 254 ||
                        background.index === 244)
                ),
        ),
    ).toEqual([]);
    expect(
        explicitBackgrounds.filter(
            (background) => background.kind === "palette" && background.index === 244,
        ),
    ).toHaveLength(1);

    const promptRow = rowContaining(snapshot, prompt);
    expect(cellsOnRow(snapshot, promptRow)).toHaveLength(terminalWidth);
    expect(rowBackgroundIndexes(snapshot, promptRow)).toEqual([254]);
    const composerRow = rowContaining(snapshot, composerPlaceholder);
    expect(cellsOnRow(snapshot, composerRow)).toHaveLength(terminalWidth);
    expect(rowBackgroundIndexes(snapshot, composerRow)).toEqual(
        [244, expectedSurface].sort((left, right) => left - right),
    );
}

function cellsOnRow(snapshot: TerminalSnapshot, row: number): TerminalCellSnapshot[] {
    return snapshot.cells.filter((cell) => cell.y === row);
}

function rowBackgroundIndexes(snapshot: TerminalSnapshot, row: number): number[] {
    return [
        ...new Set(
            cellsOnRow(snapshot, row).flatMap((cell) =>
                cell.background?.kind === "palette" ? [cell.background.index] : [],
            ),
        ),
    ].sort((left, right) => left - right);
}

function foregroundPaletteIndexesForText(snapshot: TerminalSnapshot, text: string): number[] {
    const row = rowContaining(snapshot, text);
    const start = snapshot.rows[row]?.indexOf(text) ?? -1;
    return cellsOnRow(snapshot, row)
        .filter((cell) => cell.x >= start && cell.x < start + text.length)
        .map((cell) => {
            if (cell.foreground?.kind !== "palette") {
                throw new Error(
                    `Expected ${JSON.stringify(text)} to use palette foregrounds, received ${JSON.stringify(cell.foreground)}.`,
                );
            }
            return cell.foreground.index;
        });
}

function rowContaining(snapshot: TerminalSnapshot, text: string): number {
    const row = snapshot.rows.findIndex((line) => line.includes(text));
    if (row < 0) throw new Error(`Could not find ${JSON.stringify(text)} in terminal snapshot.`);
    return row;
}

async function captureProof(
    snapshot: TerminalSnapshot,
    colorScheme: TerminalColorScheme,
): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_LIVE_THEME_PROOF_DIR;
    const label = process.env.HAPPY_TERMINAL_LIVE_THEME_PROOF_LABEL;
    if (directory === undefined || label === undefined) return;
    await renderTerminalSnapshotPng(snapshot, resolve(directory, `${label}-${colorScheme}.png`));
    expect(snapshot.rows).toHaveLength(32);
}
