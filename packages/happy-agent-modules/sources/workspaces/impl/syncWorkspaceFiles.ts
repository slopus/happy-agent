import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { RunnerRunOptions, RunnerRunResult } from "../../runners/index.js";

const PRODUCT = computePermissions("full_access");
const SYNC_TIMEOUT_MS = 5 * 60 * 1_000;
const SYNC_OUTPUT_LIMIT = 64 * 1024;

/**
 * Copies configured project files into a workspace, the root copy winning.
 *
 * Sync shares files the checkout cannot provide, such as gitignored `.env` files, by replicating
 * the project root's copy into every workspace — first when the workspace is created, then again
 * whenever the root copy changes. Replication is one-way and best-effort: the root always wins,
 * a path that cannot be read or written right now is simply skipped until the next pass, and
 * nothing is ever deleted in a workspace because it disappeared from the root. The copying runs on
 * the machine the folders are on, with that machine's own copy program, following links in the
 * source.
 *
 * The workspace is another party's writable space, so the destination is re-resolved before every
 * copy: a workspace that replaced a destination ancestor with a symlink pointing elsewhere gets
 * that path skipped rather than making the agent write outside the workspace. A workspace whose
 * folder no longer exists — archived while a sync was in flight — is left alone, never recreated.
 */
export async function syncWorkspaceFiles(options: {
    machine: Compute;
    platform: NodeJS.Platform;
    run: (options: RunnerRunOptions) => Promise<RunnerRunResult>;
    /** Project-relative paths to replicate, already validated to stay inside the project. */
    paths: readonly string[];
    projectPath: string;
    workspacePath: string;
}): Promise<void> {
    const { machine } = options;
    let workspaceRoot: string;
    try {
        workspaceRoot = await machine.fs.realpath(PRODUCT, options.workspacePath);
    } catch {
        return;
    }
    for (const path of new Set(options.paths)) {
        const source = resolve(options.projectPath, path);
        const destination = resolve(options.workspacePath, path);
        if (
            !isPathLexicallyWithin(options.projectPath, source) ||
            !isPathLexicallyWithin(options.workspacePath, destination)
        ) {
            throw new Error(`Workspace sync path "${path}" must stay inside the project.`);
        }
        try {
            const canonicalDestination = await resolvePotentialPath(machine, destination);
            if (!isPathLexicallyWithin(workspaceRoot, canonicalDestination)) continue;
            let sourceMetadata;
            try {
                sourceMetadata = await machine.fs.stat(PRODUCT, source);
            } catch {
                continue;
            }
            await machine.fs.mkdir(PRODUCT, dirname(canonicalDestination), { recursive: true });
            // Removing first replaces the destination even when its kind changed, such as a file
            // where the root now has a directory, instead of merging or failing on the mismatch.
            await machine.fs.rm(PRODUCT, canonicalDestination, { force: true, recursive: true });
            await copyFollowingLinks(
                options,
                source,
                canonicalDestination,
                sourceMetadata.isDirectory,
            );
        } catch {
            // Best-effort per path: this one converges on a later pass, the rest still copy.
        }
    }
}

async function copyFollowingLinks(
    options: {
        readonly platform: NodeJS.Platform;
        readonly run: (options: RunnerRunOptions) => Promise<RunnerRunResult>;
    },
    source: string,
    destination: string,
    directory: boolean,
): Promise<void> {
    const windows = options.platform === "win32";
    const result = await options.run(
        windows
            ? {
                  command: "robocopy",
                  args: directory
                      ? [source, destination, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"]
                      : [
                            dirname(source),
                            dirname(destination),
                            basename(source),
                            "/NFL",
                            "/NDL",
                            "/NJH",
                            "/NJS",
                            "/NP",
                        ],
                  maximumBytes: SYNC_OUTPUT_LIMIT,
                  timeoutMs: SYNC_TIMEOUT_MS,
              }
            : {
                  command: "cp",
                  args: ["-R", "-L", "--", source, destination],
                  maximumBytes: SYNC_OUTPUT_LIMIT,
                  timeoutMs: SYNC_TIMEOUT_MS,
              },
    );
    if ((windows ? result.code >= 8 : result.code !== 0) || result.timedOut) {
        throw new Error(result.stderr.trim() || "The sync copy failed.");
    }
}

export function isPathLexicallyWithin(parent: string, target: string): boolean {
    const fromParent = relative(parent, target);
    return (
        fromParent !== "" &&
        fromParent !== ".." &&
        !fromParent.startsWith(`..${sep}`) &&
        !isAbsolute(fromParent)
    );
}

/**
 * Canonicalizes as much of a path as exists, following symlinks, and keeps the rest verbatim. A
 * destination is usually still missing when sync decides where it may write.
 */
async function resolvePotentialPath(machine: Compute, target: string): Promise<string> {
    const missing: string[] = [];
    let existing = normalize(target);
    for (;;) {
        try {
            return join(await machine.fs.realpath(PRODUCT, existing), ...missing);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        }
        const parent = dirname(existing);
        if (parent === existing) return join(existing, ...missing);
        missing.unshift(basename(existing));
        existing = parent;
    }
}
