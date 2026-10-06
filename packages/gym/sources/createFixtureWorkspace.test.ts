import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureWorkspace } from "./createFixtureWorkspace.js";

describe.skipIf(process.platform === "win32")("shared Docker fixture permissions", () => {
    it("lets the container user create siblings and edit seeded files despite a different host UID", async () => {
        const root = await createFixtureWorkspace({ "happy/config/happy.toml": "fixture\n" });
        try {
            for (const path of ["happy", "happy/config"]) {
                expect((await stat(join(root, path))).mode & 0o003).toBe(0o003);
            }
            expect((await stat(join(root, "happy/config/happy.toml"))).mode & 0o002).toBe(0o002);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("preserves explicitly requested file permissions", async () => {
        const root = await createFixtureWorkspace({
            "bin/script": { content: "fixture", mode: 0o755 },
        });
        try {
            expect((await stat(join(root, "bin/script"))).mode & 0o777).toBe(0o755);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
