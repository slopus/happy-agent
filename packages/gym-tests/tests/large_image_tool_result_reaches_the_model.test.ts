import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** Two megabytes of image bytes become more than two mebibytes of base64. */
function largeImageBytes(): Uint8Array {
    const bytes = new Uint8Array(2_000_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    return bytes;
}

describe("a tool result carrying a large image", () => {
    it("reaches the model instead of ending the run", async () => {
        const gym = await createGym({
            files: { "large.png": largeImageBytes() },
            inference(_request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: { path: "large.png" },
                                id: "view-1",
                                name: "view_image",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                return { content: [{ text: "The image is visible.", type: "text" }] };
            },
        });
        running.add(gym);

        gym.terminal.type("Look at large.png.");
        gym.terminal.press("enter");

        const answered = await gym.terminal.waitForText("The image is visible.", 60_000);
        expect(answered.text).not.toContain("durable limit");
    });
});
