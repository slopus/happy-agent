import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("starting Rig with an already-running daemon", () => {
    it("connects to its socket without comparing the Rig package version", async () => {
        const cliPath = "/tmp/rig-under-test/dist/main.js";
        const packagePath = "/tmp/rig-under-test/package.json";
        const setup = [
            "mkdir -p /tmp/rig-under-test",
            "cp -R /app/packages/rig/dist /tmp/rig-under-test/dist",
            "cp /app/packages/rig/package.json /tmp/rig-under-test/package.json",
            "ln -s /app/packages/rig/node_modules /tmp/rig-under-test/node_modules",
            `node ${cliPath} daemon start`,
            `node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const path = "${packagePath}"; const manifest = JSON.parse(readFileSync(path, "utf8")); manifest.version = "999.999.999"; writeFileSync(path, JSON.stringify(manifest, null, 4) + "\\n");'`,
            `exec node ${cliPath}`,
        ].join("\n");
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["/bin/sh", "-lc", setup],
            inference: [],
            timeoutMs: 20_000,
        });
        running.add(gym);

        const started = await gym.terminal.snapshot();
        expect(started.text).toContain("Ask Rig to do anything");
        expect(started.text).not.toContain("Restart local daemon?");
        expect(started.text).not.toContain("Restart daemon");
    });
});
