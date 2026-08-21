import { afterEach, describe, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("inference HTTP error is visible", () => {
    it("renders the host-scripted provider failure in the real CLI", async () => {
        const gym = await createGym({
            inference: [{ body: "scripted invalid request", httpStatus: 400 }],
        });
        running.add(gym);

        gym.terminal.type("Trigger the failure.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("scripted invalid request");
    });
});
