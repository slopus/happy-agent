import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

const EXPECTED_LOGO = [
    "██████╗ ██╗ ██████╗",
    "██╔══██╗██║██╔════╝",
    "██████╔╝██║██║  ███╗",
    "██╔══██╗██║██║   ██║",
    "██║  ██║██║╚██████╔╝",
    "╚═╝  ╚═╝╚═╝ ╚═════╝",
].join("\n");

const EXPECTED_VERSION = [
    " ██╗   ██████╗    ██████╗",
    "███║   ╚════██╗   ╚════██╗",
    "╚██║    █████╔╝    █████╔╝",
    " ██║   ██╔═══╝     ╚═══██╗",
    " ██║██╗███████╗██╗██████╔╝",
    " ╚═╝╚═╝╚══════╝╚═╝╚═════╝",
].join("\n");

const EXPECTED_BANNER = EXPECTED_LOGO.split("\n")
    .map((line, index) => `  ${line.padEnd(20)}  ${EXPECTED_VERSION.split("\n")[index]}`)
    .join("\n");

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("terminal startup branding", () => {
    it("shows the Rig logo and both runtime versions", async () => {
        const cliPath = "/tmp/rig-under-test/dist/main.js";
        const packagePath = "/tmp/rig-under-test/package.json";
        const setup = [
            "mkdir -p /tmp/rig-under-test",
            "cp -R /app/packages/rig/dist /tmp/rig-under-test/dist",
            "cp /app/packages/rig/package.json /tmp/rig-under-test/package.json",
            "ln -s /app/packages/rig/node_modules /tmp/rig-under-test/node_modules",
            `node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const path = "${packagePath}"; const manifest = JSON.parse(readFileSync(path, "utf8")); manifest.version = "1.2.3"; writeFileSync(path, JSON.stringify(manifest, null, 4) + "\\n");'`,
            `exec node ${cliPath}`,
        ].join("\n");
        const gym = await createGym({
            cols: 100,
            mode: "docker",
            entrypoint: ["/bin/sh", "-lc", setup],
            inference: [],
            rows: 32,
        });
        running.add(gym);

        const startup = await gym.terminal.snapshot();
        expect(startup.text).toContain(`\n${EXPECTED_BANNER}`);
        expect(startup.text).toContain(EXPECTED_BANNER);
        expect(startup.text).toContain("Engine: 0.0.0");
        expect(startup.text).not.toContain("GitHub:");
        expect(startup.text).not.toContain(">_ Rig 1.2.3");
        expect(startup.text).not.toContain("Agentic coding CLI");
        expect(startup.text).not.toContain("private local daemon");
        expect(startup.text).toContain("Ask Rig to do anything");
        expect(startup.scroll.atBottom).toBe(true);
    }, 120_000);
});
