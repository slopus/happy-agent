import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProtectedPathMonitor } from "../../sources/host/impl/createProtectedPathMonitor.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// Windows ACLs can protect only paths that exist, so a missing protected project path is guarded
// by this monitor rather than by an empty placeholder left in the user's project.
describe.runIf(process.platform === "linux" || process.platform === "win32")(
    "protected path monitor",
    () => {
        it("removes protected files and folders a command creates, and reports it", async () => {
            const root = await mkdtemp(join(tmpdir(), "happy-protected-"));
            roots.push(root);
            const file = join(root, "happy.toml");
            const folder = join(root, ".agents");
            const monitor = await createProtectedPathMonitor([file, folder]);

            await writeFile(file, "[network]\n");
            // The monitor may already have removed the folder; either way it must not survive.
            await mkdir(folder).catch(() => undefined);
            await writeFile(join(folder, "skill.md"), "injected\n").catch(() => undefined);

            expect(await monitor.stop()).toBe(true);
            expect(existsSync(file)).toBe(false);
            expect(existsSync(folder)).toBe(false);
        });

        it("creates nothing and reports nothing when the command stays away", async () => {
            const root = await mkdtemp(join(tmpdir(), "happy-protected-"));
            roots.push(root);
            const file = join(root, "happy.toml");
            const monitor = await createProtectedPathMonitor([file]);
            await writeFile(join(root, "ordinary.txt"), "fine\n");

            expect(await monitor.stop()).toBe(false);
            expect(existsSync(file)).toBe(false);
            expect(existsSync(join(root, "ordinary.txt"))).toBe(true);
        });
    },
);
