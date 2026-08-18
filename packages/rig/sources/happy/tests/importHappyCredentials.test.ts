import { mkdtemp, readFile, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { importHappyCredentials } from "../importHappyCredentials.js";

const temporaryDirectories: string[] = [];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("importHappyCredentials", () => {
    it("validates and atomically imports current Happy credentials and server settings", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-happy-import-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const rigHome = join(home, ".happy", "rig");
        const happyHome = join(home, ".happy");
        await mkdir(happyHome, { recursive: true });
        const source = {
            encryption: {
                machineKey: Buffer.alloc(32, 1).toString("base64"),
                publicKey: Buffer.alloc(32, 2).toString("base64"),
            },
            token: "happy-token",
        };
        await writeFile(join(happyHome, "access.key"), JSON.stringify(source));
        await writeFile(
            join(happyHome, "settings.json"),
            JSON.stringify({ machineId: "machine-1", serverUrl: "https://happy.example" }),
        );

        const imported = await importHappyCredentials({
            environment: {},
            homeDirectory: home,
            rigHome,
        });

        expect(imported).toMatchObject({
            imported: true,
            serverUrl: "https://happy.example",
        });
        expect(imported?.machineId).toBeDefined();
        expect(imported?.machineId).toMatch(uuidPattern);
        expect(imported?.machineId).not.toBe("machine-1");
        expect(JSON.parse(await readFile(join(rigHome, "happy", "machine.json"), "utf8"))).toEqual({
            id: imported?.machineId,
        });
        expect(await readFile(join(rigHome, "happy", "access.key"), "utf8")).toBe(
            `${JSON.stringify(source, null, 2)}\n`,
        );
        expect((await stat(join(rigHome, "happy"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(rigHome, "happy", "access.key"))).mode & 0o777).toBe(0o600);
        expect((await stat(join(rigHome, "happy", "machine.json"))).mode & 0o777).toBe(0o600);
    });

    it("keeps a valid Rig copy when the Happy source is malformed", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-happy-existing-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const rigHome = join(home, ".happy", "rig");
        await mkdir(join(home, ".happy"), { recursive: true });
        await mkdir(join(rigHome, "happy"), { recursive: true });
        await writeFile(join(home, ".happy", "access.key"), "not-json");
        const existing = {
            secret: Buffer.alloc(32, 3).toString("base64"),
            token: "existing-token",
        };
        await writeFile(join(rigHome, "happy", "access.key"), JSON.stringify(existing));

        const imported = await importHappyCredentials({
            environment: {},
            homeDirectory: home,
            rigHome,
        });

        expect(imported).toMatchObject({
            imported: false,
            serverUrl: "https://api.cluster-fluster.com",
        });
        expect(imported?.credentials).toMatchObject({ token: "existing-token" });
    });

    it("keeps newer direct Rig credentials while importing newer Happy settings", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-happy-newest-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const rigHome = join(home, ".happy", "rig");
        const sourceHome = join(home, ".happy");
        const targetHome = join(rigHome, "happy");
        await mkdir(sourceHome, { recursive: true });
        await mkdir(targetHome, { recursive: true });
        const source = {
            secret: Buffer.alloc(32, 1).toString("base64"),
            token: "older-source",
        };
        const target = {
            secret: Buffer.alloc(32, 2).toString("base64"),
            token: "newer-rig-login",
        };
        const sourceCredentialsPath = join(sourceHome, "access.key");
        const targetCredentialsPath = join(targetHome, "access.key");
        await writeFile(sourceCredentialsPath, JSON.stringify(source));
        await writeFile(targetCredentialsPath, JSON.stringify(target));
        await utimes(sourceCredentialsPath, new Date(1_000), new Date(1_000));
        await utimes(targetCredentialsPath, new Date(2_000), new Date(2_000));
        await writeFile(
            join(sourceHome, "settings.json"),
            JSON.stringify({ serverUrl: "https://new-settings.example" }),
        );

        const imported = await importHappyCredentials({
            environment: {},
            homeDirectory: home,
            rigHome,
        });

        expect(imported).toMatchObject({
            imported: false,
            serverUrl: "https://new-settings.example",
        });
        expect(imported?.credentials).toMatchObject({ token: "newer-rig-login" });
    });

    it("imports an explicitly configured home that holds a different account, even when older", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-happy-switch-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const rigHome = join(home, ".happy", "rig");
        const sourceHome = join(home, "dev-home");
        const targetHome = join(rigHome, "happy");
        await mkdir(sourceHome, { recursive: true });
        await mkdir(targetHome, { recursive: true });
        const source = {
            secret: Buffer.alloc(32, 1).toString("base64"),
            token: "dev-account",
        };
        const target = {
            secret: Buffer.alloc(32, 2).toString("base64"),
            token: "cached-prod-account",
        };
        const sourceCredentialsPath = join(sourceHome, "access.key");
        const targetCredentialsPath = join(targetHome, "access.key");
        await writeFile(sourceCredentialsPath, JSON.stringify(source));
        await writeFile(targetCredentialsPath, JSON.stringify(target));
        await utimes(sourceCredentialsPath, new Date(1_000), new Date(1_000));
        await utimes(targetCredentialsPath, new Date(2_000), new Date(2_000));
        await writeFile(
            join(sourceHome, "settings.json"),
            JSON.stringify({ serverUrl: "https://dev-account.example" }),
        );
        await writeFile(
            join(targetHome, "settings.json"),
            JSON.stringify({ serverUrl: "https://cached-prod.example" }),
        );
        await utimes(join(sourceHome, "settings.json"), new Date(1_000), new Date(1_000));
        await utimes(join(targetHome, "settings.json"), new Date(2_000), new Date(2_000));

        const imported = await importHappyCredentials({
            environment: { HAPPY_HOME_DIR: sourceHome },
            homeDirectory: home,
            rigHome,
        });

        expect(imported).toMatchObject({
            imported: true,
            serverUrl: "https://dev-account.example",
        });
        expect(imported?.credentials).toMatchObject({ token: "dev-account" });
    });

    it("still protects a direct Rig login from an explicit home holding the same account", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-happy-same-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const rigHome = join(home, ".happy", "rig");
        const sourceHome = join(home, "dev-home");
        const targetHome = join(rigHome, "happy");
        await mkdir(sourceHome, { recursive: true });
        await mkdir(targetHome, { recursive: true });
        const sharedSecret = Buffer.alloc(32, 1).toString("base64");
        const sourceCredentialsPath = join(sourceHome, "access.key");
        const targetCredentialsPath = join(targetHome, "access.key");
        await writeFile(
            sourceCredentialsPath,
            JSON.stringify({ secret: sharedSecret, token: "older-token" }),
        );
        await writeFile(
            targetCredentialsPath,
            JSON.stringify({ secret: sharedSecret, token: "newer-token" }),
        );
        await utimes(sourceCredentialsPath, new Date(1_000), new Date(1_000));
        await utimes(targetCredentialsPath, new Date(2_000), new Date(2_000));

        const imported = await importHappyCredentials({
            environment: { HAPPY_HOME_DIR: sourceHome },
            homeDirectory: home,
            rigHome,
        });

        expect(imported).toMatchObject({ imported: false });
        expect(imported?.credentials).toMatchObject({ token: "newer-token" });
    });

    it("keeps loading credentials when imported Happy settings cannot be written", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-happy-settings-write-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const rigHome = join(home, ".happy", "rig");
        const sourceHome = join(home, ".happy");
        const targetHome = join(rigHome, "happy");
        await mkdir(sourceHome, { recursive: true });
        await mkdir(targetHome, { recursive: true });
        const credentials = {
            secret: Buffer.alloc(32, 4).toString("base64"),
            token: "working-token",
        };
        await writeFile(join(targetHome, "access.key"), JSON.stringify(credentials));
        const sourceSettingsPath = join(sourceHome, "settings.json");
        await writeFile(
            sourceSettingsPath,
            JSON.stringify({ serverUrl: "https://unwritable-settings.example" }),
        );
        const targetSettingsPath = join(targetHome, "settings.json");
        await mkdir(targetSettingsPath);
        await utimes(targetSettingsPath, new Date(3_000), new Date(3_000));
        await utimes(sourceSettingsPath, new Date(4_000), new Date(4_000));

        const imported = await importHappyCredentials({
            environment: {},
            homeDirectory: home,
            rigHome,
        });

        expect(imported).toMatchObject({
            imported: false,
            serverUrl: "https://unwritable-settings.example",
        });
        expect(imported?.credentials).toMatchObject({ token: "working-token" });
    });

    it("uses distinct persistent machine identities for separate daemon sockets", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-happy-daemon-scopes-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const rigHome = join(home, ".happy", "rig");
        await mkdir(join(home, ".happy"), { recursive: true });
        await writeFile(
            join(home, ".happy", "access.key"),
            JSON.stringify({
                secret: Buffer.alloc(32, 6).toString("base64"),
                token: "shared-token",
            }),
        );

        const first = await importHappyCredentials({
            environment: {},
            homeDirectory: home,
            machineScope: "/tmp/rig-first.sock",
            rigHome,
        });
        const second = await importHappyCredentials({
            environment: {},
            homeDirectory: home,
            machineScope: "/tmp/rig-second.sock",
            rigHome,
        });
        const restored = await importHappyCredentials({
            environment: {},
            homeDirectory: home,
            machineScope: "/tmp/rig-first.sock",
            rigHome,
        });

        expect(first?.machineId).toBeDefined();
        expect(second?.machineId).toBeDefined();
        expect(restored?.machineId).toBeDefined();
        expect(first?.machineId).toMatch(uuidPattern);
        expect(second?.machineId).toMatch(uuidPattern);
        expect(restored?.machineId).toMatch(uuidPattern);
        expect(first?.machineId).toBe(restored?.machineId);
        expect(first?.machineId).not.toBe(second?.machineId);
    });
});
