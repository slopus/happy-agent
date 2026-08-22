import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { latestHappyAgentReleaseVersion } from "./ensureHappyAgentBinary.js";
import { getHappyDaemonPaths, type HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { selectedHappyAgentBinary, SEMANTIC_VERSION_PATTERN } from "./happyAgentBinaryConfig.js";
import { isNewerSemanticVersion } from "./isNewerSemanticVersion.js";

const UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 60_000;
const updateCacheSchema = Type.Object(
    {
        checkedAt: Type.Integer({ minimum: 0 }),
        latestVersion: Type.String({ maxLength: 128, pattern: SEMANTIC_VERSION_PATTERN }),
    },
    { additionalProperties: false },
);
type UpdateCache = Static<typeof updateCacheSchema>;

export interface HappyAgentUpdate {
    readonly currentVersion: string;
    readonly latestVersion: string;
}

export interface DetectHappyAgentUpdateOptions {
    readonly currentVersion: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: number;
    readonly paths?: HappyDaemonPaths;
    readonly signal?: AbortSignal;
}

/** Returns a newer managed release, refreshing the bounded on-disk lookup cache when needed. */
export async function detectHappyAgentUpdate(
    options: DetectHappyAgentUpdateOptions,
): Promise<HappyAgentUpdate | undefined> {
    const paths = options.paths ?? getHappyDaemonPaths();
    const selected = await selectedHappyAgentBinary(paths);
    if (selected === undefined || selected.version !== options.currentVersion) return undefined;

    const now = options.now ?? Date.now();
    const cached = await readUpdateCache(paths.updateCachePath);
    let latestVersion = cached?.latestVersion;
    const cacheIsFresh =
        cached !== undefined &&
        cached.checkedAt <= now &&
        cached.checkedAt > now - UPDATE_CHECK_INTERVAL_MS;
    if (!cacheIsFresh) {
        try {
            latestVersion = await latestHappyAgentReleaseVersion({
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            await writeUpdateCache(paths, { checkedAt: now, latestVersion });
        } catch (error) {
            if (options.signal?.aborted === true) throw error;
        }
    }

    if (
        latestVersion === undefined ||
        !isNewerSemanticVersion(latestVersion, options.currentVersion)
    ) {
        return undefined;
    }
    return { currentVersion: options.currentVersion, latestVersion };
}

async function readUpdateCache(path: string): Promise<UpdateCache | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return Value.Check(updateCacheSchema, parsed) ? parsed : undefined;
    } catch (error) {
        if (isMissing(error) || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

async function writeUpdateCache(paths: HappyDaemonPaths, cache: UpdateCache): Promise<void> {
    await mkdir(paths.distDirectory, { mode: 0o700, recursive: true });
    await chmod(paths.distDirectory, 0o700);
    const temporaryPath = `${paths.updateCachePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(cache, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
    } catch (error) {
        await handle.close();
        await rm(temporaryPath, { force: true });
        throw error;
    }
    await handle.close();
    try {
        await rename(temporaryPath, paths.updateCachePath);
        await chmod(paths.updateCachePath, 0o600);
    } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
    }
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
