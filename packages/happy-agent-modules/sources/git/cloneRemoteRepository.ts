import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { GitAuthentication } from "./GitCredentialBroker.js";
import { redactGitAuthenticationText } from "./GitCredentialBroker.js";
import { directGitCommandRunner } from "./runGitCommand.js";
import { readGitTopLevel } from "./readGitTopLevel.js";
import { runGitCommandOrThrow } from "./GitCommandRunner.js";
import type { GitRemoteSource } from "./types.js";
import { normalizeProjectCwd } from "./normalizeProjectCwd.js";

const execFile = promisify(execFileCallback);
const GIT_CLONE_OUTPUT_LIMIT = 1024 * 1024;
const GIT_CLONE_TIMEOUT_MS = 60 * 60 * 1_000;
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const STRIPPED_GIT_ENVIRONMENT = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ASKPASS",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PROXY_COMMAND",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_TEMPLATE_DIR",
    "GIT_WORK_TREE",
];

export interface GitCloneExecFileOptions {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
}

export type GitCloneExecFile = (
    file: string,
    args: readonly string[],
    options: GitCloneExecFileOptions,
) => Promise<{ stderr: string; stdout: string }>;

export interface CloneRemoteRepositoryOptions {
    destination: string;
    execFile?: GitCloneExecFile;
    gitAuthentication?: GitAuthentication;
    gitIdentity?: { email: string; name: string };
    source: GitRemoteSource;
}

/**
 * Clones through a private staging directory, proves repository identity, then atomically renames
 * the completed checkout into place. A failed or interrupted clone never exposes a partial project.
 */
export async function cloneRemoteRepository(options: CloneRemoteRepositoryOptions): Promise<void> {
    const destination = validateDestination(options.destination);
    const remote = remoteUrlForSource(options.source);
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentIdentity = await proveRealDirectory(parent, "The clone destination parent");
    if (await exists(destination)) {
        throw new Error("The clone destination already exists.");
    }
    const rigRoot = join(parent, ".rig");
    const rigIdentity = await ensureManagedDirectory(rigRoot, "The managed .rig clone root");
    const stagingRoot = join(rigRoot, "clones");
    const stagingIdentity = await ensureManagedDirectory(
        stagingRoot,
        "The managed clone staging root",
    );
    const stagingPath = await mkdtemp(join(stagingRoot, `${basename(destination)}-`));
    // `git clone` requires the destination itself not to exist.
    await rm(stagingPath, { recursive: true });
    const environment = {
        ...cloneEnvironment(options.gitAuthentication),
        ...(options.gitIdentity === undefined
            ? {}
            : {
                  GIT_AUTHOR_EMAIL: options.gitIdentity.email,
                  GIT_AUTHOR_NAME: options.gitIdentity.name,
                  GIT_COMMITTER_EMAIL: options.gitIdentity.email,
                  GIT_COMMITTER_NAME: options.gitIdentity.name,
              }),
    };
    try {
        await (options.execFile ?? runExecFile)("git", ["clone", "--", remote, stagingPath], {
            encoding: "utf8",
            windowsHide: true,
            env: environment,
            maxBuffer: GIT_CLONE_OUTPUT_LIMIT,
            timeout: GIT_CLONE_TIMEOUT_MS,
        });
        if (
            (await readGitTopLevel(directGitCommandRunner, stagingPath)) !==
            normalizeProjectCwd(stagingPath)
        ) {
            throw new Error("The cloned folder is not a Git repository root.");
        }
        const origin = await runGitCommandOrThrow(directGitCommandRunner, stagingPath, [
            "remote",
            "get-url",
            "origin",
        ]);
        if (!remoteUrlsMatch(origin, remote, options.source.kind)) {
            throw new Error("The cloned folder has an unexpected origin repository.");
        }
        if (await exists(destination)) {
            throw new Error("The clone destination appeared while cloning.");
        }
        await Promise.all([
            assertSameDirectory(parent, parentIdentity, "The clone destination parent"),
            assertSameDirectory(rigRoot, rigIdentity, "The managed .rig clone root"),
            assertSameDirectory(stagingRoot, stagingIdentity, "The managed clone staging root"),
        ]);
        await rename(stagingPath, destination);
    } catch (error) {
        throwRedactedGitError(error, options.gitAuthentication?.environment);
    } finally {
        await rm(stagingPath, { force: true, recursive: true }).catch(() => undefined);
    }
}

interface DirectoryIdentity {
    readonly device: number;
    readonly inode: number;
}

async function ensureManagedDirectory(path: string, label: string): Promise<DirectoryIdentity> {
    try {
        await mkdir(path, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await proveRealDirectory(path, label);
}

async function proveRealDirectory(path: string, label: string): Promise<DirectoryIdentity> {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link.`);
    }
    if (!details.isDirectory()) {
        throw new Error(`${label} must be a directory.`);
    }
    return { device: details.dev, inode: details.ino };
}

async function assertSameDirectory(
    path: string,
    expected: DirectoryIdentity,
    label: string,
): Promise<void> {
    const actual = await proveRealDirectory(path, label);
    if (actual.device !== expected.device || actual.inode !== expected.inode) {
        throw new Error(`${label} changed while the repository was cloning.`);
    }
}

export function remoteUrlForSource(source: GitRemoteSource): string {
    return source.kind === "github"
        ? `https://github.com/${validateGitHubRepository(source.repository)}.git`
        : validateGitRemoteUrl(source.url);
}

function cloneEnvironment(authentication: GitAuthentication | undefined): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of STRIPPED_GIT_ENVIRONMENT) delete environment[name];
    for (const name of Object.keys(environment)) {
        if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) delete environment[name];
    }
    environment.GIT_CONFIG_GLOBAL = "/dev/null";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "credential.helper";
    environment.GIT_CONFIG_VALUE_0 = "";
    if (authentication !== undefined) Object.assign(environment, authentication.environment);
    environment.GIT_TERMINAL_PROMPT = "0";
    return environment;
}

function validateDestination(destination: string): string {
    if (
        destination.length === 0 ||
        destination.includes("\0") ||
        !isAbsolute(destination) ||
        resolve(destination) !== destination
    ) {
        throw new Error("The clone destination must be an absolute, normalized path.");
    }
    return destination;
}

function validateGitHubRepository(repository: string): string {
    const parts = repository.split("/");
    if (
        parts.length !== 2 ||
        parts.some((part) => !GITHUB_REPOSITORY_SEGMENT.test(part) || part === "." || part === "..")
    ) {
        throw new Error("The GitHub repository must use the form owner/repository.");
    }
    return repository;
}

function validateGitRemoteUrl(remote: string): string {
    if (remote.length === 0 || remote.includes("\0") || remote !== remote.trim()) {
        throw new Error("The Git remote URL is invalid.");
    }
    let url: URL;
    try {
        url = new URL(remote);
    } catch {
        throw new Error("The Git remote URL is invalid.");
    }
    if (
        url.protocol !== "https:" ||
        url.hostname.length === 0 ||
        url.username.length > 0 ||
        url.password.length > 0
    ) {
        throw new Error("The Git remote URL must be an HTTPS URL without credentials.");
    }
    return url.toString();
}

function remoteUrlsMatch(
    actual: string,
    expected: string,
    sourceKind: GitRemoteSource["kind"],
): boolean {
    try {
        const normalizedActual = new URL(actual).toString();
        const normalizedExpected = new URL(expected).toString();
        return sourceKind === "github"
            ? normalizedActual.toLowerCase() === normalizedExpected.toLowerCase()
            : normalizedActual === normalizedExpected;
    } catch {
        return false;
    }
}

async function exists(path: string): Promise<boolean> {
    return await lstat(path)
        .then(() => true)
        .catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        });
}

function throwRedactedGitError(
    error: unknown,
    environment: Readonly<Record<string, string>> | undefined,
): never {
    if (environment === undefined || !(error instanceof Error)) throw error;
    const message = redactGitAuthenticationText(error.message, environment);
    if (message === error.message) throw error;
    throw new Error(message, { cause: error });
}

async function runExecFile(
    file: string,
    args: readonly string[],
    options: GitCloneExecFileOptions,
): Promise<{ stderr: string; stdout: string }> {
    return await execFile(file, args, options);
}
