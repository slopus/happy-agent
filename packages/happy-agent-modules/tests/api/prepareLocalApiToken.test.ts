import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareLocalApiToken } from "../../sources/api/prepareLocalApiToken.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("prepareLocalApiToken", () => {
    it("creates the local API credential in standalone mode", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-agent-local-token-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "token");

        const token = await prepareLocalApiToken(path, false);

        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        await expect(readFile(path, "utf8")).resolves.toBe(`${token}\n`);
    });

    it("removes an existing local API credential in team mode", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-agent-team-token-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "token");
        await writeFile(path, `${"a".repeat(43)}\n`);

        await expect(prepareLocalApiToken(path, true)).resolves.toBeUndefined();
        await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
});
