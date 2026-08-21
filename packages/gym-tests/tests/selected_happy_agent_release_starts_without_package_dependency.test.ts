import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("starting a selected Happy Agent release", () => {
    it("runs the installed binary without a Happy Agent package dependency", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: { RIG_GYM_HAPPY_AGENT_COMMAND: "" },
            homeFiles: {
                ".happy/dist/config.json": `${JSON.stringify(
                    { downloadedVersions: ["1.2.3"], selectedVersion: "1.2.3" },
                    null,
                    2,
                )}\n`,
                ".happy/dist/version/1.2.3/happy-agent": {
                    content: [
                        "#!/usr/bin/env bash",
                        'printf "%s\\n" "$*" > /home/rig/.happy/dist/selected-binary-command',
                        'exec node /app/happy-agent/dist/cli.js "$@"',
                        "",
                    ].join("\n"),
                    mode: 0o755,
                },
            },
            inference: [],
            timeoutMs: 30_000,
        });
        running.add(gym);

        const invoked = await gym.runInContainer("cat", [
            "/home/rig/.happy/dist/selected-binary-command",
        ]);
        expect(invoked.stdout.trim()).toBe("start");
        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Ask Rig to do anything");
    }, 120_000);
});
