import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { compareSemanticVersions } from "./compareSemanticVersions.js";
import { happyAgentBinaryPath, type HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { SEMANTIC_VERSION_PATTERN } from "./semanticVersionPattern.js";

const MAXIMUM_RECORDED_VERSIONS = 100;
const versionSchema = Type.String({ maxLength: 128, pattern: SEMANTIC_VERSION_PATTERN });
export const happyAgentBinaryConfigSchema = Type.Object(
    {
        downloadedVersions: Type.Array(versionSchema, {
            maxItems: MAXIMUM_RECORDED_VERSIONS,
            uniqueItems: true,
        }),
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

/**
 * Selects an installed version and removes superseded downloads. Callers hold the install lock.
 * Removal is best effort: a version that cannot be removed now is retried on the next write.
 */
export async function writeHappyAgentBinaryConfig(
    paths: HappyDaemonPaths,
    selectedVersion: string,
    onStatus?: (message: string) => void,
): Promise<HappyAgentBinaryConfig> {
    await mkdir(paths.distDirectory, { mode: 0o700, recursive: true });
    await chmod(paths.distDirectory, 0o700);
    const installedVersions = await listDownloadedHappyAgentVersions(paths);
    if (!installedVersions.includes(selectedVersion)) {
        throw new Error(`Happy Agent ${selectedVersion} is not completely installed.`);
    }
    // Launchers that read the previous config may still be starting its selection.
    const previousVersion = await readHappyAgentBinaryConfig(paths).then(
        (config) => config?.selectedVersion,
        () => undefined,
    );
    await removeSupersededHappyAgentVersions(
        paths,
        installedVersions.filter(
            (version) =>
                version !== selectedVersion &&
                version !== previousVersion &&
                !isLocalHappyAgentVersion(version),
        ),
        onStatus,
    );
    const remainingVersions = await listDownloadedHappyAgentVersions(paths);
    if (!remainingVersions.includes(selectedVersion)) {
        throw new Error(`Happy Agent ${selectedVersion} is not completely installed.`);
    }
    const config: HappyAgentBinaryConfig = {
        downloadedVersions: newestRecordedVersions(remainingVersions, selectedVersion),
        selectedVersion,
    };
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
    return versions.sort(compareSemanticVersions);
}

async function removeSupersededHappyAgentVersions(
    paths: HappyDaemonPaths,
    versions: readonly string[],
    onStatus: ((message: string) => void) | undefined,
): Promise<void> {
    for (const version of versions) {
        try {
            // A symlinked or junctioned entry is never listed, and rm removes nested links
            // themselves rather than their targets.
            await rm(join(paths.versionsDirectory, version), {
                force: true,
                maxRetries: 5,
                recursive: true,
            });
        } catch (error) {
            // Windows refuses to delete a binary that is still running; the next write retries.
            if (isBusy(error)) continue;
            onStatus?.(
                `Happy Agent ${version} could not be removed yet. It will be removed after a later update.`,
            );
        }
    }
}

/** Keeps the config within its bound when old versions could not be removed. */
function newestRecordedVersions(versions: readonly string[], selectedVersion: string): string[] {
    if (versions.length <= MAXIMUM_RECORDED_VERSIONS) return [...versions];
    const newest = versions
        .filter((version) => version !== selectedVersion)
        .slice(-(MAXIMUM_RECORDED_VERSIONS - 1));
    return [...newest, selectedVersion].sort(compareSemanticVersions);
}

/** Developer builds are installed by hand and are never removed automatically. */
function isLocalHappyAgentVersion(version: string): boolean {
    const [release = "", build] = version.split("+", 2);
    return release.split("-", 1)[0] === "0.0.0" || build?.split(".", 1)[0] === "local";
}

function isBusy(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EBUSY" || error.code === "EPERM")
    );
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
