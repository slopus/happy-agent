import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("temporary menus use a fullscreen terminal surface", () => {
    it("restores the conversation and its scrollback after the subagent menu closes", async () => {
        const historyLines = Array.from(
            { length: 32 },
            (_, index) => `FULLSCREEN_HISTORY_${String(index).padStart(2, "0")}`,
        ).join("\n");
        const gym = await createGym({
            cols: 80,
            inference: [
                { content: [{ text: historyLines, type: "text" }] },
                { content: [{ text: "SECOND_TURN_OK", type: "text" }] },
            ],
            rows: 18,
        });
        running.add(gym);

        gym.terminal.type("Create enough history to exercise scrollback.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("FULLSCREEN_HISTORY_31");
        const before = await gym.terminal.snapshot();
        expect(before.scroll.totalRows).toBeGreaterThan(before.scroll.visibleRows);

        gym.terminal.type("/agents");
        gym.terminal.press("enter");
        const menu = await gym.terminal.waitForText("No delegated work has been started.");

        expect(menu.rows).toHaveLength(18);
        expect(menu.scroll.totalRows).toBe(menu.scroll.visibleRows);
        expect(menu.text).not.toContain("FULLSCREEN_HISTORY_31");

        gym.terminal.press("escape");
        const restored = await gym.terminal.waitForText("FULLSCREEN_HISTORY_31");

        expect(restored.rows).toEqual(before.rows);
        expect(restored.scroll.totalRows).toBe(before.scroll.totalRows);

        gym.terminal.type("Continue after closing the menu.");
        gym.terminal.press("enter");
        const continued = await gym.terminal.waitForText("SECOND_TURN_OK");
        expect(continued.text).toContain("Ask Happy Terminal to do anything");
    });
});
