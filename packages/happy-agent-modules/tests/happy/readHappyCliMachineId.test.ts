import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { readHappyCliMachineId } from "../../sources/happy/credentials/readHappyCliMachineId.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function happyHome(settings?: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-cli-"));
    directories.push(directory);
    if (settings !== undefined) await writeFile(join(directory, "settings.json"), settings);
    return directory;
}

it("names the machine Happy CLI registered from the same home", async () => {
    const home = await happyHome(JSON.stringify({ machineId: "cli-1", schemaVersion: 2 }));
    expect(await readHappyCliMachineId(home)).toBe("cli-1");
});

it("says nothing when no Happy CLI is installed beside this daemon", async () => {
    expect(await readHappyCliMachineId(await happyHome())).toBeUndefined();
});

it("says nothing rather than guessing at settings it cannot read", async () => {
    expect(await readHappyCliMachineId(await happyHome("{ not json"))).toBeUndefined();
    expect(await readHappyCliMachineId(await happyHome("[]"))).toBeUndefined();
    expect(await readHappyCliMachineId(await happyHome('{"machineId":""}'))).toBeUndefined();
    expect(await readHappyCliMachineId(await happyHome('{"machineId":7}'))).toBeUndefined();
});
