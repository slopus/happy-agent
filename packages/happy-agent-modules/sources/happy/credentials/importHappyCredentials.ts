import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HappyConnectionConfiguration } from "../HappyCredentials.js";
import { getHappyPaths } from "./getHappyPaths.js";
import { loadOrCreateHappyMachineId } from "./loadOrCreateHappyMachineId.js";
import { parseHappyCredentials } from "./parseHappyCredentials.js";
import { resolveHappyHome } from "./resolveHappyHome.js";
import { resolveHappyServerUrl } from "./resolveHappyServerUrl.js";
import { writeHappyJsonFile } from "./writeHappyJsonFile.js";

/**
 * Adopts the credentials of a Happy CLI installation and returns what the Happy
 * clients need to connect.
 *
 * A newer `access.key` in the Happy CLI home replaces this agent's copy, so
 * signing in with Happy anywhere on the machine signs Happy Agent in too. Returns
 * `undefined` when no usable credentials exist, which simply means Happy is not
 * connected.
 */
export async function importHappyCredentials(options: {
    /** The agent's own data directory; the Happy copy lives in `happy/` beneath it. */
    dataDirectory: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    /** Distinguishes this daemon's machine identity from others on the same computer. */
    machineScope?: string;
}): Promise<HappyConnectionConfiguration | undefined> {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const targetPaths = getHappyPaths(options.dataDirectory, options.machineScope);
    const sourceHome = resolveHappyHome(environment, homeDirectory);
    const sourceCredentials = await readJson(join(sourceHome, "access.key"));
    const sourceSettings = await readJson(join(sourceHome, "settings.json"));
    let imported = false;

    if (
        sourceCredentials !== undefined &&
        (await isNewerThanTarget(join(sourceHome, "access.key"), targetPaths.credentialsPath))
    ) {
        try {
            const parsed = parseHappyCredentials(sourceCredentials);
            await writeHappyJsonFile(targetPaths.credentialsPath, parsed.stored);
            imported = true;
        } catch {
            // A malformed external Happy file must not replace a valid local copy.
        }
    }
    if (
        isRecord(sourceSettings) &&
        (await isNewerThanTarget(join(sourceHome, "settings.json"), targetPaths.settingsPath))
    ) {
        try {
            await writeHappyJsonFile(targetPaths.settingsPath, sourceSettings);
        } catch {
            // Optional external settings must not interrupt loading valid credentials.
        }
    }

    const targetCredentials = await readJson(targetPaths.credentialsPath);
    if (targetCredentials === undefined) return undefined;
    let parsed;
    try {
        parsed = parseHappyCredentials(targetCredentials);
    } catch {
        return undefined;
    }
    const targetSettings = await readJson(targetPaths.settingsPath);
    const sourceServerUrl = readString(sourceSettings, "serverUrl");
    const targetServerUrl = readString(targetSettings, "serverUrl");
    const machineId = await loadOrCreateHappyMachineId(targetPaths.machinePath);
    return {
        credentials: parsed.credentials,
        credentialsPath: targetPaths.credentialsPath,
        happyHome: targetPaths.directory,
        imported,
        ...(machineId === undefined ? {} : { machineId }),
        serverUrl: resolveHappyServerUrl({
            environment,
            ...(sourceServerUrl === undefined ? {} : { sourceServerUrl }),
            ...(targetServerUrl === undefined ? {} : { targetServerUrl }),
        }),
    };
}

async function readJson(path: string): Promise<unknown | undefined> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
        return undefined;
    }
}

async function isNewerThanTarget(sourcePath: string, targetPath: string): Promise<boolean> {
    try {
        const [source, target] = await Promise.all([stat(sourcePath), stat(targetPath)]);
        return source.mtimeMs > target.mtimeMs;
    } catch {
        return true;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
    if (!isRecord(value)) return undefined;
    const candidate = value[key];
    return typeof candidate === "string" && candidate.trim().length > 0
        ? candidate.trim()
        : undefined;
}
