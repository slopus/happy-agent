import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import {
    computePermissions,
    type Compute,
    type ComputeFileStat,
} from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import {
    GIT_CLONE_TIMEOUT_MS,
    remoteUrlForSource,
    remoteUrlsMatch,
    STRIPPED_GIT_ENVIRONMENT,
    validateDestination,
} from "../cloneRemoteRepository.js";
import type { GitAuthentication } from "../GitCredentialBroker.js";
import { redactGitAuthenticationText } from "../GitCredentialBroker.js";
import type { GitRemoteSource } from "../types.js";
import { runOnMachine } from "./runOnMachine.js";

const PRODUCT = computePermissions("full_access");
const GIT_CLONE_OUTPUT_LIMIT = 1024 * 1024;

/**
 * Clone a remote into a folder on a runner, with the same guarantees as a clone here: the clone
 * lands in a private staging directory beside the destination, its identity and origin are
 * proven, and only then is it moved into place, so a failed clone never leaves a partial project.
 */
export async function cloneOnRunner(
    ctx: Context,
    machine: Compute,
    options: {
        readonly destination: string;
        readonly source: GitRemoteSource;
        readonly gitAuthentication?: GitAuthentication;
        readonly gitIdentity?: { readonly email: string; readonly name: string };
    },
): Promise<void> {
    const fs = machine.fs;
    const destination = validateDestination(options.destination);
    const remote = remoteUrlForSource(options.source);
    const parent = dirname(destination);
    await fs.mkdir(PRODUCT, parent, { recursive: true });
    await proveRealDirectory(await fs.lstat(PRODUCT, parent), "The clone destination parent");
    if (await fs.exists(PRODUCT, destination)) {
        throw new Error("The clone destination already exists.");
    }
    const stagingRoot = join(parent, ".rig", "clones");
    await fs.mkdir(PRODUCT, stagingRoot, { recursive: true });
    await proveRealDirectory(
        await fs.lstat(PRODUCT, join(parent, ".rig")),
        "The managed .rig clone root",
    );
    await proveRealDirectory(
        await fs.lstat(PRODUCT, stagingRoot),
        "The managed clone staging root",
    );
    const stagingPath = join(
        stagingRoot,
        `${basename(destination)}-${randomBytes(6).toString("hex")}`,
    );
    const environment: Record<string, string | null> = {};
    for (const name of STRIPPED_GIT_ENVIRONMENT) environment[name] = null;
    Object.assign(environment, {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        ...options.gitAuthentication?.environment,
        ...(options.gitIdentity === undefined
            ? {}
            : {
                  GIT_AUTHOR_EMAIL: options.gitIdentity.email,
                  GIT_AUTHOR_NAME: options.gitIdentity.name,
                  GIT_COMMITTER_EMAIL: options.gitIdentity.email,
                  GIT_COMMITTER_NAME: options.gitIdentity.name,
              }),
        GIT_TERMINAL_PROMPT: "0",
    });
    const redact = (text: string) =>
        redactGitAuthenticationText(text, options.gitAuthentication?.environment ?? {});
    try {
        const cloned = await runOnMachine(ctx, machine, {
            command: "git",
            args: ["clone", "--", remote, stagingPath],
            environment,
            maximumBytes: GIT_CLONE_OUTPUT_LIMIT,
            timeoutMs: GIT_CLONE_TIMEOUT_MS,
        });
        if (cloned.code !== 0 || cloned.timedOut) {
            throw new Error(
                redact(cloned.stderr.trim()) ||
                    (cloned.timedOut ? "The clone did not finish in time." : "The clone failed."),
            );
        }
        const git = async (args: readonly string[]): Promise<string> => {
            const result = await runOnMachine(ctx, machine, {
                command: "git",
                args: ["-C", stagingPath, ...args],
                environment: { GIT_TERMINAL_PROMPT: "0" },
                maximumBytes: 64 * 1024,
                timeoutMs: 10_000,
            });
            if (result.code !== 0) throw new Error(redact(result.stderr.trim()) || "Git failed.");
            return result.stdout.toString("utf8").trim();
        };
        const topLevel = await git(["rev-parse", "--show-toplevel"]);
        if (topLevel !== (await fs.realpath(PRODUCT, stagingPath))) {
            throw new Error("The cloned folder is not a Git repository root.");
        }
        const origin = await git(["remote", "get-url", "origin"]);
        if (!remoteUrlsMatch(origin, remote, options.source.kind)) {
            throw new Error("The cloned folder has an unexpected origin repository.");
        }
        if (await fs.exists(PRODUCT, destination)) {
            throw new Error("The clone destination appeared while cloning.");
        }
        await fs.move(PRODUCT, stagingPath, destination);
    } finally {
        await fs.rm(PRODUCT, stagingPath, { force: true, recursive: true }).catch(() => undefined);
    }
}

async function proveRealDirectory(details: ComputeFileStat, label: string): Promise<void> {
    if (details.isSymbolicLink) throw new Error(`${label} must not be a symbolic link.`);
    if (!details.isDirectory) throw new Error(`${label} must be a directory.`);
}
