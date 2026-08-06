import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreateIrohSecretKey } from "./loadOrCreateIrohSecretKey.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("loadOrCreateIrohSecretKey", () => {
    it("persists one private identity with owner-only permissions", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-iroh-identity-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "nested", "iroh-secret-key");

        const [first, second] = await Promise.all([
            loadOrCreateIrohSecretKey(path),
            loadOrCreateIrohSecretKey(path),
        ]);

        expect(second.public().toString()).toBe(first.public().toString());
        expect(await readFile(path)).toHaveLength(32);
        expect((await stat(path)).mode & 0o777).toBe(0o600);

        await chmod(path, 0o644);
        await loadOrCreateIrohSecretKey(path);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it("rejects a malformed saved identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-iroh-invalid-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "iroh-secret-key");
        await writeFile(path, "not a key");

        await expect(loadOrCreateIrohSecretKey(path)).rejects.toThrow(
            "must contain exactly 32 bytes",
        );
    });

    it("does not follow a symbolic link for the private identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-iroh-symlink-"));
        temporaryDirectories.push(directory);
        const target = join(directory, "outside");
        const path = join(directory, "iroh-secret-key");
        await writeFile(target, Buffer.alloc(32));
        await symlink(target, path);

        await expect(loadOrCreateIrohSecretKey(path)).rejects.toThrow();
        expect((await stat(target)).mode & 0o777).not.toBe(0o600);
    });
});
