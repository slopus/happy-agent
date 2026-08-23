import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getHappyPaths } from "./getHappyPaths.js";
import { resolveHappyHome } from "./resolveHappyHome.js";
import { resolveHappyServerUrl } from "./resolveHappyServerUrl.js";

export interface HappyConnectionTarget {
    readonly credentialsPath: string;
    readonly serverUrl: string;
    readonly settingsPath: string;
}

/** Resolves where a new pairing is stored and which Happy server authorizes it. */
export async function resolveHappyConnectionTarget(options: {
    dataDirectory: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
}): Promise<HappyConnectionTarget> {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const targetPaths = getHappyPaths(options.dataDirectory);
    const sourceHome = resolveHappyHome(environment, homeDirectory);
    const [sourceSettings, targetSettings] = await Promise.all([
        readJson(join(sourceHome, "settings.json")),
        readJson(targetPaths.settingsPath),
    ]);
    const sourceServerUrl = readString(sourceSettings, "serverUrl");
    const targetServerUrl = readString(targetSettings, "serverUrl");
    return {
        credentialsPath: targetPaths.credentialsPath,
        serverUrl: resolveHappyServerUrl({
            environment,
            ...(sourceServerUrl === undefined ? {} : { sourceServerUrl }),
            ...(targetServerUrl === undefined ? {} : { targetServerUrl }),
        }),
        settingsPath: targetPaths.settingsPath,
    };
}

async function readJson(path: string): Promise<unknown | undefined> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
        return undefined;
    }
}

function readString(value: unknown, key: string): string | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" && candidate.trim().length > 0
        ? candidate.trim()
        : undefined;
}
