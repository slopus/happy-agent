import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { happyAgentBinaryPath, type HappyDaemonPaths } from "./getHappyDaemonPaths.js";

export const SEMANTIC_VERSION_PATTERN =
    "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$";
const versionSchema = Type.String({ maxLength: 128, pattern: SEMANTIC_VERSION_PATTERN });
export const happyAgentBinaryConfigSchema = Type.Object(
    {
        downloadedVersions: Type.Array(versionSchema, { maxItems: 100, uniqueItems: true }),
        selectedVersion: versionSchema,
    },
    { additionalProperties: false },
);
export type HappyAgentBinaryConfig = Static<typeof happyAgentBinaryConfigSchema>;

export async function readHappyAgentBinaryConfig(
    paths: HappyDaemonPaths,
): Promise<HappyAgentBinaryConfig | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(paths.binaryConfigPath, "utf8"));
        return Value.Check(happyAgentBinaryConfigSchema, parsed) ? parsed : undefined;
    } catch (error) {
        if (isMissing(error) || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

export async function selectedHappyAgentBinary(
    paths: HappyDaemonPaths,
): Promise<{ path: string; version: string } | undefined> {
    const config = await readHappyAgentBinaryConfig(paths);
    if (config === undefined || !config.downloadedVersions.includes(config.selectedVersion)) {
        return undefined;
    }
    const path = happyAgentBinaryPath(paths, config.selectedVersion);
    return (await isExecutableFile(path)) ? { path, version: config.selectedVersion } : undefined;
}

export async function writeHappyAgentBinaryConfig(
    paths: HappyDaemonPaths,
    selectedVersion: string,
): Promise<HappyAgentBinaryConfig> {
    await mkdir(paths.distDirectory, { mode: 0o700, recursive: true });
    await chmod(paths.distDirectory, 0o700);
    const downloadedVersions = await listDownloadedHappyAgentVersions(paths);
    if (!downloadedVersions.includes(selectedVersion)) {
        throw new Error(`Happy Agent ${selectedVersion} is not completely installed.`);
    }
    const config: HappyAgentBinaryConfig = { downloadedVersions, selectedVersion };
    if (!Value.Check(happyAgentBinaryConfigSchema, config)) {
        throw new Error("The downloaded Happy Agent versions could not be recorded.");
    }
    const temporaryPath = `${paths.binaryConfigPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
    } catch (error) {
        await handle.close();
        await rm(temporaryPath, { force: true });
        throw error;
    }
    await handle.close();
    try {
        await rename(temporaryPath, paths.binaryConfigPath);
        await chmod(paths.binaryConfigPath, 0o600);
    } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
    }
    return config;
}

export async function isExecutableFile(path: string): Promise<boolean> {
    try {
        const information = await lstat(path);
        if (!information.isFile()) return false;
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function listDownloadedHappyAgentVersions(paths: HappyDaemonPaths): Promise<string[]> {
    let entries: Dirent<string>[];
    try {
        entries = await readdir(paths.versionsDirectory, { withFileTypes: true });
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
    const versions: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !new RegExp(SEMANTIC_VERSION_PATTERN, "u").test(entry.name)) {
            continue;
        }
        if (await isExecutableFile(happyAgentBinaryPath(paths, entry.name))) {
            versions.push(entry.name);
        }
    }
    return versions.sort((left, right) => left.localeCompare(right, "en"));
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
