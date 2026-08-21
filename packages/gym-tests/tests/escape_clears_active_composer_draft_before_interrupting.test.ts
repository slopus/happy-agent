import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Escape with an active composer draft", () => {
    it("clears the draft before a later empty-composer Escape stops inference", async () => {
        const draft = "Clear this unsent draft first.";
        const gym = await createGym({
            inference: [
                {
                    content: [{ text: "UNREACHABLE_DELAYED_RESPONSE", type: "text" }],
                    delayMs: 60_000,
                },
            ],
        });
        running.add(gym);

        submit(gym, "Start a response that I will stop.");
        await gym.terminal.waitForText("esc to interrupt", 30_000);
        gym.terminal.type(draft);
        await gym.terminal.waitForText(draft, 30_000);

        gym.terminal.press("escape");
        const cleared = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.text.includes("esc to interrupt"),
            "the first Escape to clear the draft without stopping inference",
            30_000,
        );
        expect(cleared.text).not.toContain("Session interrupted");
        expect(agentRequests(gym)).toHaveLength(1);

        gym.terminal.press("escape");
        const stopped = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session interrupted") &&
                !snapshot.text.includes("esc to interrupt") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the empty-composer Escape to stop inference",
            30_000,
        );
        expect(agentRequests(gym)).toHaveLength(1);
        await screenshot(gym, "escape-cleared-draft-then-stopped.png");
        expect(stopped.text).not.toContain("UNREACHABLE_DELAYED_RESPONSE");
    }, 90_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    );
}

async function screenshot(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_SCREENSHOT_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(resolve(directory, name));
}
