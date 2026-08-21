import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym, type TerminalSnapshot } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("light terminals without background-color query support", () => {
    it("uses light surfaces for submitted messages and the composer", async () => {
        const gym = await createGym({
            inference: [{ content: [{ text: "Theme-aware response.", type: "text" }] }],
            terminalBackgroundColorQuery: false,
            terminalColorScheme: "light",
        });
        running.add(gym);

        gym.terminal.type("Respect the light theme.");
        gym.terminal.press("enter");

        // Without an OSC 11 background reply, the light appearance comes from the
        // color-scheme report alone, so surfaces derive from the pure-white fallback.
        const snapshot = await gym.terminal.waitForText("Theme-aware response.");
        expect(rowBackgroundIndexes(snapshot, "Respect the light theme.")).toEqual([255]);
        expect(rowBackgroundIndexes(snapshot, "Ask Happy Terminal to do anything")).toEqual([
            244, 255,
        ]);
    }, 20_000);
});

function rowBackgroundIndexes(snapshot: TerminalSnapshot, text: string): number[] {
    const row = snapshot.rows.findIndex((line) => line.includes(text));
    if (row < 0) throw new Error(`Could not find ${JSON.stringify(text)} in terminal snapshot.`);
    return [
        ...new Set(
            snapshot.cells.flatMap((cell) =>
                cell.y === row && cell.background?.kind === "palette"
                    ? [cell.background.index]
                    : [],
            ),
        ),
    ].sort((left, right) => left - right);
}
