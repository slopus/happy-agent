import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Escape in the composer", () => {
    it("clears the current draft without submitting it and keeps it in local history", async () => {
        const draft = "Recover this cleared draft.";
        const gym = await createGym({ inference: [] });
        running.add(gym);

        gym.terminal.type(draft);
        await waitForComposer(gym, draft);
        gym.terminal.press("escape");

        await waitForComposer(gym, "Ask Happy Terminal to do anything");
        expect(agentRequests(gym)).toHaveLength(0);
        await screenshot(gym, "escape-cleared-draft.png");

        gym.terminal.press("up");
        await waitForComposer(gym, draft);
        gym.terminal.press("down");
        await waitForComposer(gym, "Ask Happy Terminal to do anything");
        gym.terminal.press("up");
        await waitForComposer(gym, draft);
    }, 60_000);

    it("splits one raw coalesced Escape chunk into two idle presses", async () => {
        const draft = "Recover this raw-chunk draft.";
        const gym = await createGym({ inference: [] });
        running.add(gym);

        gym.terminal.type(draft);
        await waitForComposer(gym, draft);
        gym.terminal.write("\x1b\x1b");

        await waitForComposer(gym, "Ask Happy Terminal to do anything");
        gym.terminal.press("up");
        await waitForComposer(gym, draft);
        expect(agentRequests(gym)).toHaveLength(0);
    }, 60_000);
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
