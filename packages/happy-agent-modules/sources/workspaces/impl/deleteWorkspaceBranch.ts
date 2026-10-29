import type { GitModule } from "../../git/index.js";

/**
 * Deletes the branch a worktree workspace was cut as, once its worktree is gone.
 *
 * A worktree is always cut as a new branch, so the branch is the workspace's own. Git still refuses
 * to delete a branch another worktree has checked out, and that refusal stands. A branch Git no
 * longer has is already deleted.
 */
export async function deleteWorkspaceBranch(options: {
    readonly branch: string;
    readonly git: GitModule;
    readonly projectPath: string;
    readonly runnerId?: string;
}): Promise<void> {
    const placement = options.runnerId === undefined ? {} : { runnerId: options.runnerId };
    const exists = await options.git.run(
        options.projectPath,
        ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`],
        placement,
    );
    if (exists.code !== 0) return;
    const deleted = await options.git.run(
        options.projectPath,
        ["branch", "-D", options.branch],
        placement,
    );
    if (deleted.code !== 0) {
        throw new Error(
            `Git could not delete the branch "${options.branch}": ${deleted.stderr.trim()}`,
        );
    }
}
