import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
    loadOrCreateHappyMachineId,
    replaceHappyMachineId,
} from "../../sources/happy/credentials/loadOrCreateHappyMachineId.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

it("keeps one persistent machine identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "happy-machine-"));
    directories.push(directory);
    const path = join(directory, "happy", "machine.json");

    expect(await loadOrCreateHappyMachineId(path, () => "machine-1")).toBe("machine-1");
    expect(await loadOrCreateHappyMachineId(path, () => "machine-2")).toBe("machine-1");
});

it("replaces only the identity Happy refused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "happy-machine-replace-"));
    directories.push(directory);
    const path = join(directory, "happy", "machine.json");
    await loadOrCreateHappyMachineId(path, () => "machine-1");

    expect(await replaceHappyMachineId(path, "machine-1", () => "machine-2")).toBe("machine-2");
    // Another daemon already replaced it; a late refusal of the old identity keeps the new one.
    expect(await replaceHappyMachineId(path, "machine-1", () => "machine-3")).toBe("machine-2");
    expect(await loadOrCreateHappyMachineId(path, () => "machine-4")).toBe("machine-2");
});

it("returns the persisted winner when daemons create the identity concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "happy-machine-race-"));
    directories.push(directory);
    const path = join(directory, "happy", "machine.json");

    const identities = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
            loadOrCreateHappyMachineId(path, () => `machine-${String(index)}`),
        ),
    );

    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toMatch(/^machine-/u);
});
