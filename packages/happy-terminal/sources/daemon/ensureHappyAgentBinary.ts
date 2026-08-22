import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    isExecutableFile,
    selectedHappyAgentBinary,
    SEMANTIC_VERSION_PATTERN,
    writeHappyAgentBinaryConfig,
} from "./happyAgentBinaryConfig.js";
import {
    getHappyDaemonPaths,
    happyAgentBinaryPath,
    type HappyDaemonPaths,
} from "./getHappyDaemonPaths.js";
import { isNewerSemanticVersion } from "./isNewerSemanticVersion.js";

const HAPPY_AGENT_LATEST_RELEASE_URL =
    "https://api.github.com/repos/slopus/happy-agent/releases/latest";
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const INSTALL_LOCK_TIMEOUT_MS = 15 * 60_000;
const RELEASE_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const RELEASE_LOOKUP_TIMEOUT_MS = 30_000;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;
const LOCK_POLL_MS = 100;

const releaseAssetSchema = Type.Object(
    {
        browser_download_url: Type.String({ maxLength: 2_048, minLength: 1 }),
        digest: Type.Union([Type.String({ pattern: "^sha256:[0-9a-fA-F]{64}$" }), Type.Null()]),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        size: Type.Integer({ minimum: 1, maximum: MAXIMUM_ARCHIVE_BYTES }),
    },
    { additionalProperties: true },
);
const releaseSchema = Type.Object(
    {
        assets: Type.Array(releaseAssetSchema, { maxItems: 100 }),
        draft: Type.Boolean(),
        prerelease: Type.Boolean(),
        tag_name: Type.String({ minLength: 2, maxLength: 129 }),
    },
    { additionalProperties: true },
);
type Release = Static<typeof releaseSchema>;
type ReleaseAsset = Static<typeof releaseAssetSchema>;

const installLockSchema = Type.Object(
    {
        pid: Type.Integer({ minimum: 1 }),
        token: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);
type InstallLockRecord = Static<typeof installLockSchema>;

export interface HappyAgentBinary {
    readonly path: string;
    readonly version: string;
}

export interface EnsureHappyAgentBinaryOptions {
    arch?: NodeJS.Architecture;
    extractArchive?: (
        archivePath: string,
        destination: string,
        archivedBinaryName: string,
    ) => Promise<void>;
    fetch?: typeof globalThis.fetch;
    onStatus?: (message: string) => void;
    paths?: HappyDaemonPaths;
    platform?: NodeJS.Platform;
}

export interface UpgradeHappyAgentBinaryOptions extends EnsureHappyAgentBinaryOptions {
    signal?: AbortSignal;
}

/** Returns the selected installed release, downloading one only for an empty installation. */
export async function ensureHappyAgentBinary(
    options: EnsureHappyAgentBinaryOptions = {},
): Promise<HappyAgentBinary> {
    const paths = options.paths ?? getHappyDaemonPaths();
    const selected = await selectedHappyAgentBinary(paths);
    if (selected !== undefined) return selected;

    return await installLatestHappyAgentBinary(options, true);
}

/** Downloads and selects the newest published Happy Agent release. */
export async function upgradeHappyAgentBinary(
    options: UpgradeHappyAgentBinaryOptions = {},
): Promise<HappyAgentBinary> {
    return await installLatestHappyAgentBinary(options, false);
}

async function installLatestHappyAgentBinary(
    options: UpgradeHappyAgentBinaryOptions,
    useSelectionInstalledWhileWaiting: boolean,
): Promise<HappyAgentBinary> {
    const paths = options.paths ?? getHappyDaemonPaths();

    await mkdir(paths.distDirectory, { mode: 0o700, recursive: true });
    await mkdir(paths.versionsDirectory, { mode: 0o700, recursive: true });
    await chmod(paths.distDirectory, 0o700);
    await chmod(paths.versionsDirectory, 0o700);
    const lock = await acquireInstallLock(paths.installLockPath, options.onStatus);
    try {
        const selectedBeforeLookup = await selectedHappyAgentBinary(paths);
        if (useSelectionInstalledWhileWaiting) {
            if (selectedBeforeLookup !== undefined) return selectedBeforeLookup;
        }
        const target = releaseTarget(
            options.platform ?? process.platform,
            options.arch ?? process.arch,
        );
        options.onStatus?.("Checking for the latest Happy Agent release.");
        const release = await fetchLatestRelease(options.fetch ?? globalThis.fetch, options.signal);
        const version = releaseVersion(release);
        if (
            selectedBeforeLookup !== undefined &&
            !isNewerSemanticVersion(version, selectedBeforeLookup.version)
        ) {
            return selectedBeforeLookup;
        }
        const assetName = `happy-agent-${version}-${target}.tar.gz`;
        const asset = release.assets.find((candidate) => candidate.name === assetName);
        if (asset === undefined) {
            throw new Error(`Happy Agent ${version} has no release for ${target}.`);
        }
        if (asset.digest === null) {
            throw new Error(`Happy Agent ${version} does not publish a checksum for ${target}.`);
        }

        const finalPath = happyAgentBinaryPath(paths, version);
        if (!(await isExecutableFile(finalPath))) {
            options.onStatus?.(`Downloading Happy Agent ${version}.`);
            await rm(join(paths.versionsDirectory, version), { force: true, recursive: true });
            await installRelease({
                asset,
                archivedBinaryName: `happy-agent-${target}`,
                extractArchive: options.extractArchive ?? extractArchive,
                fetch: options.fetch ?? globalThis.fetch,
                paths,
                version,
            });
        }
        await writeHappyAgentBinaryConfig(paths, version);
        return { path: finalPath, version };
    } finally {
        await lock.release();
    }
}

/** Reads the latest published version without downloading its release asset. */
export async function latestHappyAgentReleaseVersion(
    options: Pick<UpgradeHappyAgentBinaryOptions, "fetch" | "signal"> = {},
): Promise<string> {
    return releaseVersion(
        await fetchLatestRelease(options.fetch ?? globalThis.fetch, options.signal),
    );
}

function releaseTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
    if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
        throw new Error(`Happy Agent does not publish a binary for ${platform}-${arch}.`);
    }
    return `${platform}-${arch}`;
}

async function fetchLatestRelease(
    fetch_: typeof globalThis.fetch,
    signal: AbortSignal | undefined,
): Promise<Release> {
    const response = await fetch_(HAPPY_AGENT_LATEST_RELEASE_URL, {
        headers: {
            accept: "application/vnd.github+json",
            "user-agent": "Happy Terminal Happy Agent downloader",
            "x-github-api-version": "2022-11-28",
        },
        signal:
            signal === undefined
                ? AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS)
                : AbortSignal.any([signal, AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS)]),
    });
    if (!response.ok) {
        throw new Error(
            `GitHub returned HTTP ${String(response.status)} while checking for Happy Agent.`,
        );
    }
    const value: unknown = await response.json();
    if (!Value.Check(releaseSchema, value) || value.draft) {
        throw new Error("GitHub returned an invalid Happy Agent release.");
    }
    for (const asset of value.assets) {
        let url: URL;
        try {
            url = new URL(asset.browser_download_url);
        } catch {
            throw new Error("GitHub returned an invalid Happy Agent release URL.");
        }
        if (url.protocol !== "https:") {
            throw new Error("GitHub returned an insecure Happy Agent release URL.");
        }
    }
    return value;
}

function releaseVersion(release: Release): string {
    const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
    if (!new RegExp(SEMANTIC_VERSION_PATTERN, "u").test(version)) {
        throw new Error(`The latest Happy Agent release tag is invalid: ${release.tag_name}`);
    }
    return version;
}

async function installRelease(options: {
    asset: ReleaseAsset;
    archivedBinaryName: string;
    extractArchive: NonNullable<EnsureHappyAgentBinaryOptions["extractArchive"]>;
    fetch: typeof globalThis.fetch;
    paths: HappyDaemonPaths;
    version: string;
}): Promise<void> {
    const staging = await mkdtemp(join(options.paths.versionsDirectory, ".install-"));
    const archivePath = join(staging, "happy-agent.tar.gz");
    const stagedBinaryPath = join(staging, options.archivedBinaryName);
    const normalizedBinaryPath = join(staging, "happy-agent");
    const finalDirectory = join(options.paths.versionsDirectory, options.version);
    try {
        await downloadArchive(options.fetch, options.asset, archivePath);
        await options.extractArchive(archivePath, staging, options.archivedBinaryName);
        await rm(archivePath, { force: true });
        const extracted = await stat(stagedBinaryPath);
        if (!extracted.isFile())
            throw new Error("The Happy Agent release did not contain a binary.");
        await chmod(stagedBinaryPath, 0o700);
        await rename(stagedBinaryPath, normalizedBinaryPath);
        const binary = await open(normalizedBinaryPath, "r");
        try {
            await binary.sync();
        } finally {
            await binary.close();
        }

        if (await isExecutableFile(happyAgentBinaryPath(options.paths, options.version))) return;
        try {
            await rename(staging, finalDirectory);
        } catch (error) {
            if (
                !isDestinationExists(error) ||
                !(await isExecutableFile(happyAgentBinaryPath(options.paths, options.version)))
            ) {
                throw error;
            }
        }
    } finally {
        await rm(staging, { force: true, recursive: true });
    }
}

async function downloadArchive(
    fetch_: typeof globalThis.fetch,
    asset: ReleaseAsset,
    destination: string,
): Promise<void> {
    const response = await fetch_(asset.browser_download_url, {
        headers: {
            accept: "application/octet-stream",
            "user-agent": "Happy Terminal Happy Agent downloader",
        },
        signal: AbortSignal.timeout(RELEASE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) {
        throw new Error(
            `GitHub returned HTTP ${String(response.status)} while downloading Happy Agent.`,
        );
    }
    const expectedDigest = asset.digest?.slice("sha256:".length).toLowerCase();
    if (expectedDigest === undefined) throw new Error("The Happy Agent checksum is missing.");
    const hash = createHash("sha256");
    let bytes = 0;
    const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAXIMUM_ARCHIVE_BYTES || bytes > asset.size) {
                callback(new Error("The Happy Agent release archive is larger than declared."));
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        verify,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    if (bytes !== asset.size) {
        throw new Error("The Happy Agent release archive size does not match its manifest.");
    }
    if (hash.digest("hex") !== expectedDigest) {
        throw new Error("The Happy Agent release archive checksum does not match.");
    }
}

async function extractArchive(
    archivePath: string,
    destination: string,
    archivedBinaryName: string,
): Promise<void> {
    const listing = await runFile("tar", ["-tzf", archivePath]);
    const entries = listing.trim().split("\n");
    if (entries.length !== 1 || entries[0] !== archivedBinaryName) {
        throw new Error("The Happy Agent release archive has unexpected contents.");
    }
    await runFile("tar", ["-xzf", archivePath, "-C", destination, archivedBinaryName]);
}

function runFile(executable: string, arguments_: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            arguments_,
            { encoding: "utf8", maxBuffer: 64 * 1024 },
            (error, stdout) => {
                if (error === null) resolve(stdout);
                else reject(error);
            },
        );
    });
}

async function acquireInstallLock(
    path: string,
    onStatus: ((message: string) => void) | undefined,
): Promise<{ release(): Promise<void> }> {
    const record: InstallLockRecord = { pid: process.pid, token: randomUUID() };
    const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;
    let announcedWait = false;
    for (;;) {
        try {
            const handle = await open(path, "wx", 0o600);
            try {
                await handle.writeFile(JSON.stringify(record), "utf8");
                await handle.sync();
                await handle.chmod(0o600);
            } catch (error) {
                await handle.close();
                await unlink(path).catch(() => undefined);
                throw error;
            }
            return {
                async release() {
                    try {
                        const current = await readInstallLock(path);
                        if (current?.token === record.token)
                            await unlink(path).catch(() => undefined);
                    } finally {
                        await handle.close();
                    }
                },
            };
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
        }

        if (!announcedWait) {
            announcedWait = true;
            onStatus?.(
                "Waiting for another Happy Terminal process to finish downloading Happy Agent.",
            );
        }
        const owner = await readInstallLock(path);
        const age = await lockAge(path);
        if (
            (owner !== undefined && !processExists(owner.pid)) ||
            (owner === undefined && age !== undefined && age >= INCOMPLETE_LOCK_GRACE_MS)
        ) {
            await unlink(path).catch((error: unknown) => {
                if (!isMissing(error)) throw error;
            });
            continue;
        }
        if (Date.now() >= deadline) {
            throw new Error(
                "Timed out waiting for another Happy Terminal process to install Happy Agent.",
            );
        }
        await delay(LOCK_POLL_MS);
    }
}

async function readInstallLock(path: string): Promise<InstallLockRecord | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return Value.Check(installLockSchema, parsed) ? parsed : undefined;
    } catch (error) {
        if (isMissing(error) || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

async function lockAge(path: string): Promise<number | undefined> {
    try {
        return Date.now() - (await stat(path)).mtimeMs;
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isDestinationExists(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
    );
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
