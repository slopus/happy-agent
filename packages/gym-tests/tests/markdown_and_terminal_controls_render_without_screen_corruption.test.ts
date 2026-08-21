import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Markdown and terminal controls render without screen corruption", () => {
    it("sanitizes CSI and OSC sequences while preserving code and wide Unicode", async () => {
        const response = [
            "MARKDOWN_BEGIN",
            "",
            "## Rendered heading",
            "",
            "- Wide text: 日本語 👩🏽‍💻 e\u0301",
            "- A very long token: " + "abcdef0123456789".repeat(10),
            "",
            "```ts",
            "const answer: number = 42;",
            "```",
            "",
            "CONTROL_A\x1b[2JCONTROL_B\x1b]0;CORRUPTED_TITLE\x07CONTROL_C",
            "MARKDOWN_END",
        ].join("\n");
        const gym = await createGym({
            cols: 48,
            inference: [
                { content: [{ text: response, type: "text" }] },
                { content: [{ text: "CONTROL_FOLLOW_UP_ACCEPTED", type: "text" }] },
            ],
            rows: 18,
        });
        running.add(gym);
        const baseline = (await gym.terminal.snapshot()).scroll;

        gym.terminal.type("Render hostile Markdown safely.");
        gym.terminal.press("enter");
        const rendered = await gym.terminal.waitForText("MARKDOWN_END", 30_000);
        expect(rendered.title).toContain("Happy Terminal");
        expect(rendered.title).not.toContain("CORRUPTED_TITLE");
        expect(rendered.text).toContain("CONTROL_ACONTROL_BCONTROL_C");
        expect(rendered.text).toContain("const answer: number = 42;");
        expect(rendered.text).toContain("Ask Happy Terminal to do anything");
        expect(rendered.text).toContain("gym off · /workspace");
        expect(rendered.text).not.toContain("\x1b[2J");
        expect(rendered.text).not.toContain("�");
        expect(rendered.rows).toHaveLength(18);
        expect(rendered.scroll.atBottom).toBe(true);
        expect(rendered.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(rendered.scroll.topArrivalCount).toBe(baseline.topArrivalCount);

        gym.terminal.type("Verify the terminal remains usable.");
        gym.terminal.press("enter");
        const followUp = await gym.terminal.waitForText("CONTROL_FOLLOW_UP_ACCEPTED", 30_000);
        expect(followUp.title).toContain("Happy Terminal");
        expect(followUp.scroll.atBottom).toBe(true);
        expect(followUp.text).not.toContain("�");
    });
});
