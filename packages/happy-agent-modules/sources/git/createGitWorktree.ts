import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeGitPath } from "./normalizeGitPath.js";
import { readGitWorktreeIdentity } from "./readGitWorktreeIdentity.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./worktreeCheckoutTimeout.js";

export async function createGitWorktree(options: {
    branch: string;
    commit: string;
    expectedCommonDir: string;
    git: GitCommandRunner;
    /** Create the workspace's parent folder on the machine it lives on. Defaults to this one. */
    makeParent?: (path: string) => Promise<void>;
    projectPath: string;
    workspacePath: string;
}): Promise<void> {
    const parent =
        options.git.paths === undefined
            ? dirname(options.workspacePath)
            : options.git.paths.dirname(options.workspacePath);
    if (options.makeParent === undefined) await mkdir(parent, { recursive: true, mode: 0o700 });
    else await options.makeParent(parent);
    await runGitCommandOrThrow(
        options.git,
        options.projectPath,
        ["worktree", "add", "-b", options.branch, "--", options.workspacePath, options.commit],
        { timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
    );
    const identity = await readGitWorktreeIdentity(options.git, options.workspacePath);
    if (identity.topLevel !== normalizeGitPath(options.git, options.workspacePath)) {
        throw new Error("Git created the worktree at an unexpected path.");
    }
    if (identity.commonDir !== normalizeGitPath(options.git, options.expectedCommonDir)) {
        throw new Error("Git created the worktree from an unexpected repository.");
    }
}
