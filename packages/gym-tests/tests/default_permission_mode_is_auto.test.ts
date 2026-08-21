import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("default permission mode", () => {
    it("starts new sessions in Auto when no configuration overrides it", async () => {
        const gym = await createGym({
            inference: [],
            permissionMode: "from_config",
        });
        running.add(gym);

        const snapshot = await gym.terminal.snapshot();

        expect(snapshot.text).toContain("gym off · /workspace · auto");
        expect(snapshot.text).not.toContain("workspace write");
    }, 30_000);
});
