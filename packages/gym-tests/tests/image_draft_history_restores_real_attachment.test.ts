import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const validPng32Base64 =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAARklEQVRIDe3SsQkAMAwDQQVcZP9ZMmDwBF+pe+NS2HDoJO8mvZ293RwfoK5EEqEABmyRRCiAAVskEQpgwBZJhAIYsEVI9AH7IAMiyextiAAAAABJRU5ErkJggg==";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("image draft input history", () => {
    it("restores a cleared and submitted image draft as a real attachment", async () => {
        const prompt = "Explain this image ";
        const gym = await createGym({
            mode: "docker",
            environment: {
                PATH: "/workspace/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                WAYLAND_DISPLAY: "gym-wayland-0",
            },
            files: {
                "bin/wl-paste": {
                    content: wlPasteScript,
                    mode: 0o755,
                },
            },
            inference(request, callIndex) {
                expect(callIndex).toBeLessThan(2);
                const userMessage = [...request.context.messages]
                    .reverse()
                    .find((message) => message.role === "user");
                expect(userMessage).toBeDefined();
                if (userMessage?.role !== "user" || !Array.isArray(userMessage.content)) {
                    throw new Error("Expected image-bearing user content.");
                }
                expect(userMessage.content).toEqual([
                    { text: prompt, type: "text" },
                    { data: validPng32Base64, mimeType: "image/png", type: "image" },
                ]);
                return {
                    content: [
                        {
                            text:
                                callIndex === 0
                                    ? "IMAGE_HISTORY_FIRST_DELIVERY"
                                    : "IMAGE_HISTORY_SECOND_DELIVERY",
                            type: "text",
                        },
                    ],
                };
            },
            rows: 34,
        });
        running.add(gym);

        gym.terminal.type(prompt);
        gym.terminal.write("\x16");
        await gym.terminal.waitForText("[Image #1 PNG]", 30_000);

        gym.terminal.press("escape");
        await waitForComposer(gym, "Ask Happy Terminal to do anything");
        gym.terminal.press("up");
        await waitForComposer(gym, `${prompt}[Image #1 PNG]`);
        gym.terminal.press("enter");
        await gym.terminal.waitForText("IMAGE_HISTORY_FIRST_DELIVERY", 30_000);

        gym.terminal.press("up");
        await waitForComposer(gym, `${prompt}[Image #1 PNG]`);
        gym.terminal.press("enter");
        await gym.terminal.waitForText("IMAGE_HISTORY_SECOND_DELIVERY", 30_000);

        expect(agentRequests(gym)).toHaveLength(2);
        await screenshot(gym, "image-draft-history-real-attachment.png");
    }, 90_000);
});

function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    );
}

async function waitForComposer(gym: Gym, text: string) {
    return gym.terminal.waitUntil(
        (snapshot) => composerText(snapshot) === text,
        `composer text ${JSON.stringify(text)}`,
        30_000,
    );
}

function composerText(snapshot: { rows: readonly string[] }): string | undefined {
    const footer = snapshot.rows.findIndex((row) => row.includes("gym off · /workspace"));
    const row = footer >= 2 ? snapshot.rows[footer - 2] : undefined;
    return row?.replace(/^\s*›\s?/u, "").trimEnd();
}

async function screenshot(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_SCREENSHOT_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(resolve(directory, name));
}

const wlPasteScript = `#!/bin/sh
if [ "$1" = "--list-types" ]; then
    printf 'image/png\\n'
    exit 0
fi
printf '%s' '${validPng32Base64}' | base64 -d
`;
