import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const rig = "node /app/packages/happy-terminal/dist/main.js";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("a startup that cannot continue", () => {
    it("explains itself instead of printing a Node stack trace", async () => {
        const gym = await createGym({
            cols: 100,
            rows: 30,
            mode: "docker",
            entrypoint: [
                "/bin/sh",
                "-lc",
                [`${rig} resume; echo "EXIT_STATUS=$?"`, "read -r _"].join("; "),
            ],
            inference: [],
            startupText: "EXIT_STATUS=",
            timeoutMs: 30_000,
        });
        running.add(gym);

        const failure = await gym.terminal.snapshot();
        expect(failure.text).toContain("✗ Happy Terminal has no saved sessions in /workspace.");
        expect(failure.text).toContain("Use --all to pick a session from another directory.");
        expect(failure.text).toContain("EXIT_STATUS=1");
        // The whole point: no raw trace, no absolute source paths, no Node internals.
        expect(failure.text).not.toContain("    at ");
        expect(failure.text).not.toContain("node:internal");
        expect(failure.text).not.toContain("/app/packages/happy-terminal/dist/main.js:");
    });
});
