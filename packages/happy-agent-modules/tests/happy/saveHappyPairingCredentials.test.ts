import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveHappyPairingCredentials } from "../../sources/happy/credentials/saveHappyPairingCredentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

describe("saveHappyPairingCredentials", () => {
    it("preserves settings, records the issuing server, and protects both files", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-pairing-save-"));
        temporaryDirectories.push(directory);
        const settingsPath = join(directory, "settings.json");
        const credentialsPath = join(directory, "access.key");
        await mkdir(directory, { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ machineId: "phone-machine" }));

        await saveHappyPairingCredentials(
            {
                credentialsPath,
                serverUrl: "https://happy.example",
                settingsPath,
            },
            { secret: Buffer.alloc(32, 7).toString("base64"), token: "happy-token" },
        );

        await expect(readJson(settingsPath)).resolves.toEqual({
            machineId: "phone-machine",
            serverUrl: "https://happy.example",
        });
        await expect(readJson(credentialsPath)).resolves.toEqual({
            secret: Buffer.alloc(32, 7).toString("base64"),
            token: "happy-token",
        });
        expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
        expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    });
});

async function readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
}
