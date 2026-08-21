import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("a streamed code fence whose opening marker ends a chunk", () => {
    it("keeps the first command line after the response settles", async () => {
        const openingChunk = ["COMMAND_BEGIN", "", "```sh", ""].join("\n");
        const command = "(cd packages/ghostty-web && pnpm publish --access public)";
        const response = `${openingChunk}${command}\n\`\`\`\nCOMMAND_END`;
        const gym = await createGym({
            cols: 90,
            inference: [
                {
                    content: [{ text: response, type: "text" }],
                    textDeltaChunkSize: openingChunk.length,
                    textDeltaDelayMs: 100,
                },
            ],
            rows: 18,
        });
        running.add(gym);

        gym.terminal.type("Show the publish command.");
        gym.terminal.press("enter");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("COMMAND_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the completed fenced command response",
            30_000,
        );

        expect(completed.text).toContain(command);
        expect(completed.text).toContain("```sh");
        expect(completed.text.split("\n").some((line) => line.trim() === "```")).toBe(true);
    });
});
