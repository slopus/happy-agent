import { lstat } from "node:fs/promises";

import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeProjectCwd } from "./normalizeProjectCwd.js";
import { readGitCommonDir } from "./readGitCommonDir.js";
import { readGitTopLevel } from "./readGitTopLevel.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./worktreeCheckoutTimeout.js";

export async function removeGitWorktree(options: {
    expectedCommonDir: string;
    git: GitCommandRunner;
    /** Inspect a path on the machine the workspace lives on. Defaults to this one. */
    inspect?: (path: string) => Promise<{ isDirectory: boolean; isSymbolicLink: boolean }>;
    projectPath: string;
    removeDirectory: boolean;
    workspacePath: string;
}): Promise<void> {
    const commonDir = await readGitCommonDir(options.git, options.projectPath);
    if (commonDir !== normalizeProjectCwd(options.expectedCommonDir)) {
        throw new Error("The source repository no longer owns this workspace.");
    }
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
            normalizeProjectCwd(options.workspacePath)
        ) {
            throw new Error("The workspace is not the top level of its own worktree.");
        }
        if ((await readGitCommonDir(options.git, options.workspacePath)) !== commonDir) {
            throw new Error("The workspace belongs to an unexpected repository.");
        }
        await runGitCommandOrThrow(
            options.git,
            options.projectPath,
            ["worktree", "remove", "--force", "--force", options.workspacePath],
            { timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
        );
    }
    await runGitCommandOrThrow(options.git, options.projectPath, ["worktree", "prune"]);
}
