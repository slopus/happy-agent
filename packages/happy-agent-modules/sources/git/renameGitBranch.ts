import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeGitPath } from "./normalizeGitPath.js";
import { readGitWorktreeIdentity } from "./readGitWorktreeIdentity.js";

export async function renameGitBranch(options: {
    expectedCommonDir: string;
    from: string;
    git: GitCommandRunner;
    to: string;
    workspacePath: string;
}): Promise<void> {
    if (options.from === options.to) return;
    const identity = await readGitWorktreeIdentity(options.git, options.workspacePath);
    if (identity.topLevel !== normalizeGitPath(options.git, options.workspacePath)) {
        throw new Error("The workspace is not the top level of its own worktree.");
    }
    if (identity.commonDir !== normalizeGitPath(options.git, options.expectedCommonDir)) {
        throw new Error("The workspace belongs to an unexpected repository.");
    }
    const current = await runGitCommandOrThrow(options.git, options.workspacePath, [
        "branch",
        "--show-current",
    ]);
    if (current === options.to) return;
    if (current !== options.from) {
        throw new Error(
            current.length === 0
                ? `The workspace is on a detached HEAD rather than on '${options.from}'.`
                : `The workspace is on '${current}' rather than on '${options.from}'.`,
        );
    }
    await runGitCommandOrThrow(options.git, options.workspacePath, [
        "branch",
        "-m",
        options.from,
        options.to,
    ]);
}
