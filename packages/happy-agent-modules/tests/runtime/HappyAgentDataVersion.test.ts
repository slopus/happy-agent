import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    compareHappyAgentVersions,
    describeHappyAgentNewerData,
    happyAgentDataVersionPath,
    readHappyAgentDataVersion,
    stampHappyAgentDataVersion,
} from "../../sources/runtime/HappyAgentDataVersion.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function stampPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-data-version-"));
    directories.push(directory);
    return happyAgentDataVersionPath(directory);
}

describe("compareHappyAgentVersions", () => {
    it("orders releases and previews as semantic versions", () => {
        const ordered = [
            "0.4.9",
            "0.4.104",
            "0.4.105-preview.1",
            "0.4.105-preview.2",
            "0.4.105-preview.10",
            "0.4.105",
            "1.0.0",
            "2026.11.1-preview.1",
            "2026.11.1-preview.2",
            "2026.11.1",
            "2026.11.2-preview.1",
            "2026.11.2",
            "2026.11.10",
            "2026.12.1-preview.1",
            "2027.1.1",
        ];
        for (let index = 1; index < ordered.length; index += 1) {
            expect(compareHappyAgentVersions(ordered[index - 1]!, ordered[index]!)).toBe(-1);
            expect(compareHappyAgentVersions(ordered[index]!, ordered[index - 1]!)).toBe(1);
        }
        expect(compareHappyAgentVersions("0.4.105", "v0.4.105+build.7")).toBe(0);
    });

    it("never takes an unparseable version for an older release", () => {
        expect(compareHappyAgentVersions("development", "9.9.9")).toBe(1);
        expect(compareHappyAgentVersions("9.9.9", "development")).toBe(-1);
    });
});

describe("stampHappyAgentDataVersion", () => {
    it("raises the minimum only before a migration, and never lowers it", async () => {
        const path = await stampPath();
        await expect(
            stampHappyAgentDataVersion(path, "0.4.105", { raiseMinimum: false }),
        ).resolves.toMatchObject({ writtenBy: "0.4.105", minimumVersion: "0.4.105" });
        await expect(
            stampHappyAgentDataVersion(path, "0.4.107", { raiseMinimum: false }),
        ).resolves.toMatchObject({ writtenBy: "0.4.107", minimumVersion: "0.4.105" });
        await expect(
            stampHappyAgentDataVersion(path, "0.4.107", { raiseMinimum: true }),
        ).resolves.toMatchObject({ writtenBy: "0.4.107", minimumVersion: "0.4.107" });
        await expect(
            stampHappyAgentDataVersion(path, "0.4.106", { raiseMinimum: true }),
        ).resolves.toMatchObject({ writtenBy: "0.4.106", minimumVersion: "0.4.107" });

        expect(await readHappyAgentDataVersion(path)).toMatchObject({
            version: 1,
            writtenBy: "0.4.106",
            minimumVersion: "0.4.107",
        });
        if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it("keeps a calendar release's minimum above every legacy release", async () => {
        const path = await stampPath();
        await stampHappyAgentDataVersion(path, "0.4.114", { raiseMinimum: true });
        await expect(
            stampHappyAgentDataVersion(path, "2026.11.1-preview.1", { raiseMinimum: true }),
        ).resolves.toMatchObject({ minimumVersion: "2026.11.1-preview.1" });
        await expect(
            stampHappyAgentDataVersion(path, "0.4.115-preview.1", { raiseMinimum: true }),
        ).resolves.toMatchObject({ minimumVersion: "2026.11.1-preview.1" });
    });

    it("lets a development build record itself without ever raising the minimum", async () => {
        const path = await stampPath();
        await expect(
            stampHappyAgentDataVersion(path, "development", { raiseMinimum: true }),
        ).resolves.toMatchObject({ writtenBy: "development", minimumVersion: "0.0.0" });
        await stampHappyAgentDataVersion(path, "0.4.105", { raiseMinimum: true });
        await expect(
            stampHappyAgentDataVersion(path, "development", { raiseMinimum: true }),
        ).resolves.toMatchObject({ minimumVersion: "0.4.105" });
    });

    it("treats an unreadable stamp as absent and replaces it", async () => {
        const path = await stampPath();
        await writeFile(path, "{not json", { mode: 0o600 });
        await expect(readHappyAgentDataVersion(path)).resolves.toBeUndefined();
        await stampHappyAgentDataVersion(path, "0.4.105", { raiseMinimum: false });
        expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
            minimumVersion: "0.4.105",
        });
    });
});

describe("describeHappyAgentNewerData", () => {
    it("names the release that wrote the data, and a lower minimum when there is one", () => {
        const stamp = { version: 1 as const, updatedAt: "2026-10-23T00:00:00.000Z" };
        expect(
            describeHappyAgentNewerData({
                ...stamp,
                writtenBy: "0.4.107",
                minimumVersion: "0.4.107",
            }),
        ).toBe(
            "This data was written by a newer Happy Agent (version 0.4.107); update to continue.",
        );
        expect(
            describeHappyAgentNewerData({
                ...stamp,
                writtenBy: "0.4.108",
                minimumVersion: "0.4.106",
            }),
        ).toBe(
            "This data was written by a newer Happy Agent (version 0.4.108); update to version 0.4.106 or newer to continue.",
        );
        expect(describeHappyAgentNewerData(undefined)).toBe(
            "This data was written by a newer Happy Agent; update to continue.",
        );
    });
});
