import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWindowsPrivateDirectory } from "../scripts/ensureWindowsPrivateDirectory.js";

const roots: string[] = [];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "happy-private-cache-test-"));
    roots.push(root);
    return root;
}
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("Windows embedded executable cache", () => {
    it("creates a private directory atomically and safely reuses it", async () => {
        const directory = join(await fixture(), "assets");
        ensureWindowsPrivateDirectory(directory);
        expect((await stat(directory)).isDirectory()).toBe(true);
        expect(() => ensureWindowsPrivateDirectory(directory)).not.toThrow();
    }, 30_000);

    it("rejects an existing cache writable by another account without repairing it silently", async () => {
        const directory = join(await fixture(), "unsafe");
        ensureWindowsPrivateDirectory(directory);
        execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)M"], {
            windowsHide: true,
        });
        expect(() => ensureWindowsPrivateDirectory(directory)).toThrow("another account to modify");
        expect(() => ensureWindowsPrivateDirectory(directory)).toThrow("another account to modify");
    }, 30_000);

    it("rejects a junction in place of the executable cache", async () => {
        const root = await fixture();
        const target = join(root, "target");
        const link = join(root, "assets");
        await mkdir(target);
        await symlink(target, link, "junction");
        expect(() => ensureWindowsPrivateDirectory(link)).toThrow("reparse point");
    }, 30_000);
});
