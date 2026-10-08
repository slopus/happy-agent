import { basename, dirname, join } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { RunnerRunOptions, RunnerRunResult } from "../../runners/index.js";

const PRODUCT = computePermissions("full_access");
/** Folders whose contents a fresh copy would only have to build again. */
const SKIPPED_ENTRIES = new Set([".git", "node_modules"]);
const COPY_TIMEOUT_MS = 30 * 60 * 1_000;
const COPY_OUTPUT_LIMIT = 64 * 1024;

/**
 * Makes a workspace out of a project that Git cannot cut a worktree from.
 *
 * A project without Git still deserves a workspace, so the folder itself is copied, on the machine
 * it is on, by that machine's own copy program. Build output and dependency trees are left behind:
 * they belong to the machine rather than to the work, and the workspace's setup commands are what
 * puts them back. Symbolic links are copied as links.
 *
 * The copy lands under a temporary name and is moved into place only once it is complete, so an
 * interrupted copy never looks like a finished workspace.
 */
export async function copyProjectFolder(options: {
    machine: Compute;
    platform: NodeJS.Platform;
    run: (options: RunnerRunOptions) => Promise<RunnerRunResult>;
    projectPath: string;
    workspacePath: string;
}): Promise<void> {
    const { machine } = options;
    await machine.fs.mkdir(PRODUCT, dirname(options.workspacePath), { recursive: true });
    const staging = `${options.workspacePath}.partial`;
    await machine.fs.rm(PRODUCT, staging, { force: true, recursive: true });
    await machine.fs.mkdir(PRODUCT, staging, { recursive: true });
    try {
        const entries = (await machine.fs.readdir(PRODUCT, options.projectPath)).filter(
            (entry) => !SKIPPED_ENTRIES.has(entry),
        );
        if (entries.length > 0) {
            const result = await options.run(
                options.platform === "win32"
                    ? {
                          command: "robocopy",
                          args: [
                              options.projectPath,
                              staging,
                              "/E",
                              "/SL",
                              "/XD",
                              ...[...SKIPPED_ENTRIES].map((entry) =>
                                  join(options.projectPath, entry),
                              ),
                              "/NFL",
                              "/NDL",
                              "/NJH",
                              "/NJS",
                              "/NP",
                          ],
                          maximumBytes: COPY_OUTPUT_LIMIT,
                          timeoutMs: COPY_TIMEOUT_MS,
                      }
                    : {
                          command: "cp",
                          args: [
                              "-R",
                              "-P",
                              "--",
                              ...entries.map((entry) => join(options.projectPath, entry)),
                              staging,
                          ],
                          maximumBytes: COPY_OUTPUT_LIMIT,
                          timeoutMs: COPY_TIMEOUT_MS,
                      },
            );
            // Robocopy reports success with any status below 8.
            const copied = options.platform === "win32" ? result.code < 8 : result.code === 0;
            if (!copied || result.timedOut) {
                throw new Error(
                    `The project folder could not be copied into "${basename(options.workspacePath)}". ${result.stderr.trim()}`.trim(),
                );
            }
        }
        await machine.fs.rm(PRODUCT, options.workspacePath, { force: true, recursive: true });
        await machine.fs.move(PRODUCT, staging, options.workspacePath);
    } catch (error) {
        await machine.fs.rm(PRODUCT, staging, { force: true, recursive: true });
        throw error;
    }
}
