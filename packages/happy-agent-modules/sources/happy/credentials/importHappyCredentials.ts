import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
    HappyConnectionConfiguration,
    HappyCredentials,
    StoredHappyCredentials,
} from "../HappyCredentials.js";
import { createHappyCredentialFingerprint } from "./createHappyCredentialFingerprint.js";
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
    /** Whether a newer credential and settings from the external Happy CLI may be adopted. */
    adoptExternalCredentials?: boolean;
    /** Exact rejected credential identities that must not be loaded or adopted. */
    blockedCredentialFingerprints?: ReadonlySet<string>;
    /** The agent's own data directory; the Happy copy lives in `happy/` beneath it. */
    dataDirectory: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    /** Distinguishes this daemon's machine identity from others on the same computer. */
    machineScope?: string;
}): Promise<HappyConnectionConfiguration | undefined> {
    const environment = options.environment ?? process.env;
    const targetPaths = getHappyPaths(options.dataDirectory, options.machineScope);
    const adoptExternalCredentials = options.adoptExternalCredentials ?? true;
    const sourceHome =
        adoptExternalCredentials === true
            ? resolveHappyHome(environment, options.homeDirectory ?? homedir())
            : undefined;
    const sourceCredentialsPath =
        sourceHome === undefined ? undefined : join(sourceHome, "access.key");
    const sourceCredentials =
        sourceCredentialsPath === undefined
            ? undefined
            : await readCredential(sourceCredentialsPath);
    const sourceSettings =
        sourceHome === undefined ? undefined : await readJson(join(sourceHome, "settings.json"));
    const sourceCredentialAllowed =
        sourceCredentials === undefined ||
        !options.blockedCredentialFingerprints?.has(sourceCredentials.fingerprint);
    let imported = false;

    if (
        sourceCredentialsPath !== undefined &&
        sourceCredentials !== undefined &&
        sourceCredentialAllowed &&
        (await isNewerThanTarget(sourceCredentialsPath, targetPaths.credentialsPath))
    ) {
        try {
            await writeHappyJsonFile(targetPaths.credentialsPath, sourceCredentials.stored);
            imported = true;
        } catch {
            // An external Happy file that cannot be copied must not replace a valid local copy.
        }
    }
    if (
        sourceHome !== undefined &&
        sourceCredentialAllowed &&
        isRecord(sourceSettings) &&
        (await isNewerThanTarget(join(sourceHome, "settings.json"), targetPaths.settingsPath))
    ) {
        try {
            await writeHappyJsonFile(targetPaths.settingsPath, sourceSettings);
        } catch {
            // Optional external settings must not interrupt loading valid credentials.
        }
    }

    const targetCredentials = await readCredential(targetPaths.credentialsPath);
    if (
        targetCredentials === undefined ||
        options.blockedCredentialFingerprints?.has(targetCredentials.fingerprint)
    ) {
        return undefined;
    }
    const targetSettings = await readJson(targetPaths.settingsPath);
    const sourceServerUrl = sourceCredentialAllowed
        ? readString(sourceSettings, "serverUrl")
        : undefined;
    const targetServerUrl = readString(targetSettings, "serverUrl");
    const machineId = await loadOrCreateHappyMachineId(targetPaths.machinePath);
    return {
        credentialFingerprint: targetCredentials.fingerprint,
        credentials: targetCredentials.credentials,
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

/**
 * Reads only the daemon-owned Happy credential and settings.
 *
 * This deliberately does not inspect the external Happy home, copy anything,
 * or create a machine identity, so disabled integrations can be inspected
 * without adopting credentials or causing side effects.
 */
export async function inspectDaemonHappyCredentials(options: {
    blockedCredentialFingerprints?: ReadonlySet<string>;
    dataDirectory: string;
    environment?: NodeJS.ProcessEnv;
    machineScope?: string;
}): Promise<HappyConnectionConfiguration | undefined> {
    const environment = options.environment ?? process.env;
    const targetPaths = getHappyPaths(options.dataDirectory, options.machineScope);
    const targetCredentials = await readCredential(targetPaths.credentialsPath);
    if (
        targetCredentials === undefined ||
        options.blockedCredentialFingerprints?.has(targetCredentials.fingerprint)
    ) {
        return undefined;
    }
    const targetSettings = await readJson(targetPaths.settingsPath);
    const targetServerUrl = readString(targetSettings, "serverUrl");
    return {
        credentialFingerprint: targetCredentials.fingerprint,
        credentials: targetCredentials.credentials,
        credentialsPath: targetPaths.credentialsPath,
        happyHome: targetPaths.directory,
        imported: false,
        serverUrl: resolveHappyServerUrl({
            environment,
            ...(targetServerUrl === undefined ? {} : { targetServerUrl }),
        }),
    };
}

/** Reads only the external Happy credential's non-secret identity for rejection tombstoning. */
export async function readExternalHappyCredentialFingerprint(
    options: {
        environment?: NodeJS.ProcessEnv;
        homeDirectory?: string;
    } = {},
): Promise<string | undefined> {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const sourceHome = resolveHappyHome(environment, homeDirectory);
    return (await readCredential(join(sourceHome, "access.key")))?.fingerprint;
}

interface ReadHappyCredential {
    readonly credentials: HappyCredentials;
    readonly fingerprint: string;
    readonly stored: StoredHappyCredentials;
}

async function readCredential(path: string): Promise<ReadHappyCredential | undefined> {
    const value = await readJson(path);
    if (value === undefined) return undefined;
    try {
        const parsed = parseHappyCredentials(value);
        return {
            ...parsed,
            fingerprint: createHappyCredentialFingerprint(parsed.stored),
        };
    } catch {
        return undefined;
    }
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
