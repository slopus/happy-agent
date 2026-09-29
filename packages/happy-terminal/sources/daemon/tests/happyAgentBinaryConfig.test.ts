import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareSemanticVersions } from "../compareSemanticVersions.js";
import {
    getHappyDaemonPaths,
    happyAgentBinaryPath,
    type HappyDaemonPaths,
} from "../getHappyDaemonPaths.js";
import { writeHappyAgentBinaryConfig } from "../happyAgentBinaryConfig.js";

const roots: string[] = [];
const canDenyRemoval = process.platform !== "win32" && process.getuid?.() !== 0;

afterEach(async () => {
    for (const root of roots.splice(0)) {
        const versionsDirectory = join(root, "dist", "version");
        const entries = await readdir(versionsDirectory).catch(() => []);
        for (const entry of entries) await chmod(join(versionsDirectory, entry), 0o700);
        await rm(root, { force: true, recursive: true });
    }
});

describe("writeHappyAgentBinaryConfig", () => {
    it("removes superseded versions while keeping the selection, previous selection, and local builds", async () => {
        const paths = await temporaryPaths();
        await installVersions(paths, ["0.0.0", "0.4.1", "0.4.2", "0.4.3", "0.5.0+local.7"]);
        await writeHappyAgentBinaryConfig(paths, "0.4.2");
        await installVersions(paths, ["0.4.4"]);

        const config = await writeHappyAgentBinaryConfig(paths, "0.4.4");

        expect(config).toEqual({
            downloadedVersions: ["0.0.0", "0.4.2", "0.4.4", "0.5.0+local.7"],
            selectedVersion: "0.4.4",
        });
        expect(JSON.parse(await readFile(paths.binaryConfigPath, "utf8"))).toEqual(config);
        expect((await readdir(paths.versionsDirectory)).sort()).toEqual([
            "0.0.0",
            "0.4.2",
            "0.4.4",
            "0.5.0+local.7",
        ]);
    });

    it("keeps release downloads that a local build replaces as the previous selection", async () => {
        const paths = await temporaryPaths();
        await installVersions(paths, ["0.0.0", "0.4.1", "0.4.2"]);
        await writeHappyAgentBinaryConfig(paths, "0.4.2");

        await expect(writeHappyAgentBinaryConfig(paths, "0.0.0")).resolves.toEqual({
            downloadedVersions: ["0.0.0", "0.4.2"],
            selectedVersion: "0.0.0",
        });
    });

    it("leaves unrecognized entries in the versions directory alone", async () => {
        const paths = await temporaryPaths();
        await installVersions(paths, ["0.4.1", "0.4.2"]);
        await mkdir(join(paths.versionsDirectory, ".install-abc"));
        await mkdir(join(paths.versionsDirectory, "development"));
        await mkdir(join(paths.versionsDirectory, "0.3.0"));

        await writeHappyAgentBinaryConfig(paths, "0.4.2");

        expect((await readdir(paths.versionsDirectory)).sort()).toEqual([
            ".install-abc",
            "0.3.0",
            "0.4.2",
            "development",
        ]);
    });

    it("recovers an installation that has more versions than the config can record", async () => {
        const paths = await temporaryPaths();
        const versions = Array.from({ length: 101 }, (_, index) => `0.4.${String(index)}`);
        await installVersions(paths, versions);
        await writeFile(
            paths.binaryConfigPath,
            JSON.stringify({
                downloadedVersions: versions.slice(0, 100),
                selectedVersion: "0.4.8",
            }),
        );

        await expect(writeHappyAgentBinaryConfig(paths, "0.4.100")).resolves.toEqual({
            downloadedVersions: ["0.4.8", "0.4.100"],
            selectedVersion: "0.4.100",
        });
        expect((await readdir(paths.versionsDirectory)).sort()).toEqual(["0.4.100", "0.4.8"]);
    });

    it.skipIf(!canDenyRemoval)(
        "records the newest versions and the selection when old versions cannot be removed",
        async () => {
            const paths = await temporaryPaths();
            const versions = Array.from({ length: 102 }, (_, index) => `0.4.${String(index)}`);
            await installVersions(paths, versions);
            for (const version of versions) {
                await chmod(join(paths.versionsDirectory, version), 0o500);
            }
            const statuses: string[] = [];

            const config = await writeHappyAgentBinaryConfig(paths, "0.4.1", (status) =>
                statuses.push(status),
            );

            expect(config.selectedVersion).toBe("0.4.1");
            expect(config.downloadedVersions).toEqual([
                "0.4.1",
                ...versions.slice(-99).sort(compareSemanticVersions),
            ]);
            expect(JSON.parse(await readFile(paths.binaryConfigPath, "utf8"))).toEqual(config);
            expect(statuses).toContain(
                "Happy Agent 0.4.0 could not be removed yet. It will be removed after a later update.",
            );
            expect(await readdir(paths.versionsDirectory)).toHaveLength(102);
        },
    );
});

describe("compareSemanticVersions", () => {
    it("orders versions by precedence rather than text", () => {
        expect(
            ["0.4.78", "0.4.9", "0.4.8", "0.4.9-preview.1", "0.4.10", "0.4.9-preview.10"].sort(
                compareSemanticVersions,
            ),
        ).toEqual(["0.4.8", "0.4.9-preview.1", "0.4.9-preview.10", "0.4.9", "0.4.10", "0.4.78"]);
    });
});

async function temporaryPaths(): Promise<HappyDaemonPaths> {
    const root = await mkdtemp(join(tmpdir(), "happy-terminal-binary-config-"));
    roots.push(root);
    const paths = getHappyDaemonPaths({ HAPPY_HOME_DIR: root }, root);
    await mkdir(paths.versionsDirectory, { recursive: true });
    return paths;
}

async function installVersions(paths: HappyDaemonPaths, versions: readonly string[]) {
    for (const version of versions) {
        const path = happyAgentBinaryPath(paths, version);
        await mkdir(join(paths.versionsDirectory, version), { recursive: true });
        await writeFile(path, "#!/bin/sh\n", "utf8");
        await chmod(path, 0o700);
    }
}
