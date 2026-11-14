import { lstat } from "node:fs/promises";

import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { localGitWorkingFiles, type GitWorkingFiles } from "./gitWorkingFiles.js";
import { normalizeGitPath } from "./normalizeGitPath.js";
import {
    expireArchivedGitWork,
    preserveGitWorktreeChanges,
    type GitWorktreePreservation,
    type GitWorktreePreservationRequest,
} from "./preserveGitWorktreeChanges.js";
import { readGitCommonDir } from "./readGitCommonDir.js";
import { readGitTopLevel } from "./readGitTopLevel.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./worktreeCheckoutTimeout.js";

/**
 * Retires a worktree. With `preserveChanges`, the work its branch does not hold is saved first;
 * work too large to save keeps the folder where it is, and old saves are expired afterwards.
 */
export async function removeGitWorktree(options: {
    expectedCommonDir: string;
    /** Measure files on the machine the workspace lives on. Defaults to this one. */
    files?: Pick<GitWorkingFiles, "lstatMany" | "paths">;
    git: GitCommandRunner;
    /** Inspect a path on the machine the workspace lives on. Defaults to this one. */
    inspect?: (path: string) => Promise<{ isDirectory: boolean; isSymbolicLink: boolean }>;
    /** Save uncommitted work before the folder is deleted. */
    preserveChanges?: GitWorktreePreservationRequest;
    projectPath: string;
    removeDirectory: boolean;
    workspacePath: string;
}): Promise<GitWorktreePreservation | undefined> {
    const commonDir = await readGitCommonDir(options.git, options.projectPath);
    if (commonDir !== normalizeGitPath(options.git, options.expectedCommonDir)) {
        throw new Error("The source repository no longer owns this workspace.");
    }
    let preserved: GitWorktreePreservation | undefined;
    if (options.removeDirectory) {
        const details =
            options.inspect === undefined
                ? await lstat(options.workspacePath).then((stats) => ({
                      isDirectory: stats.isDirectory(),
                      isSymbolicLink: stats.isSymbolicLink(),
                  }))
                : await options.inspect(options.workspacePath);
        if (details.isSymbolicLink || !details.isDirectory) {
            throw new Error("The workspace path is not a real directory.");
        }
        if (
            (await readGitTopLevel(options.git, options.workspacePath)) !==
            normalizeGitPath(options.git, options.workspacePath)
        ) {
            throw new Error("The workspace is not the top level of its own worktree.");
        }
        if ((await readGitCommonDir(options.git, options.workspacePath)) !== commonDir) {
            throw new Error("The workspace belongs to an unexpected repository.");
        }
        preserved =
            options.preserveChanges === undefined
                ? undefined
                : await preserveGitWorktreeChanges({
                      files: options.files ?? localGitWorkingFiles,
                      git: options.git,
                      request: options.preserveChanges,
                      workspacePath: options.workspacePath,
                  });
        if (preserved?.outcome !== "too_large") {
            await runGitCommandOrThrow(
                options.git,
                options.projectPath,
                ["worktree", "remove", "--force", "--force", options.workspacePath],
                { timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
            );
        }
    }
    await runGitCommandOrThrow(options.git, options.projectPath, ["worktree", "prune"]);
    if (options.preserveChanges !== undefined) {
        await expireArchivedGitWork({
            git: options.git,
            now: Date.now(),
            projectPath: options.projectPath,
            retentionMs: options.preserveChanges.retentionMs,
        });
    }
    return preserved;
}
