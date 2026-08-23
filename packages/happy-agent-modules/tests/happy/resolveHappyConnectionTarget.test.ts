import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveHappyConnectionTarget } from "../../sources/happy/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
});

describe("resolveHappyConnectionTarget", () => {
    it("uses Happy CLI server settings before credentials exist", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-target-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const sourceHome = join(home, ".happy");
        const dataDirectory = join(home, ".happy-agent");
        await mkdir(sourceHome, { recursive: true });
        await writeFile(
            join(sourceHome, "settings.json"),
            JSON.stringify({ serverUrl: "https://happy.example/" }),
        );

        await expect(
            resolveHappyConnectionTarget({ dataDirectory, environment: {}, homeDirectory: home }),
        ).resolves.toEqual({
            credentialsPath: join(dataDirectory, "happy", "access.key"),
            serverUrl: "https://happy.example",
            settingsPath: join(dataDirectory, "happy", "settings.json"),
        });
    });
});
