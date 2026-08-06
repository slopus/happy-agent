import { chmod, lstat, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { loadOrCreateP2pIdentity } from "./loadOrCreateP2pIdentity.js";

const directories: string[] = [];

afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    for (const directory of directories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
});

describe("loadOrCreateP2pIdentity", () => {
    it("refuses a stable instance ID that is not a cuid2", () => {
        expect(() => createP2pInstanceIdentity("not-an-id")).toThrow("cuid2");
    });

    it("creates one stable cuid2 identity and owner-only signing key", async () => {
        const path = await identityPath();

        const first = await loadOrCreateP2pIdentity(path);
        const second = await loadOrCreateP2pIdentity(path);

        expect(first.instanceId).toMatch(/^[a-z][a-z0-9]{1,31}$/u);
        expect(second).toMatchObject({
            instanceId: first.instanceId,
            publicKey: first.publicKey,
        });
        const sender = createP2pInstanceIdentity();
        const encrypted = sender.encryptFor(
            Buffer.from("survives restart", "utf8"),
            first.publicKey,
        );
        expect(Buffer.from(second.decryptFrom(encrypted, sender.publicKey)).toString("utf8")).toBe(
            "survives restart",
        );
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
    });

    it("converges concurrent creators and repairs permissive permissions", async () => {
        const path = await identityPath();

        const identities = await Promise.all(
            Array.from({ length: 8 }, () => loadOrCreateP2pIdentity(path)),
        );
        expect(new Set(identities.map((identity) => identity.instanceId))).toHaveLength(1);
        expect(new Set(identities.map((identity) => identity.publicKey))).toHaveLength(1);

        await chmod(path, 0o644);
        await loadOrCreateP2pIdentity(path);
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
    });

    it("refuses to follow a symlink for the private identity", async () => {
        const path = await identityPath();
        const target = `${path}.target`;
        await import("node:fs/promises").then(({ writeFile }) => writeFile(target, "{}"));
        await symlink(target, path);

        await expect(loadOrCreateP2pIdentity(path)).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe("{}");
    });
});

async function identityPath(): Promise<string> {
    const directory = await createTestSocketDirectory();
    directories.push(directory);
    return join(directory, "identity.json");
}
