import type { GitModule } from "../../git/index.js";

/**
 * Deletes the branch a worktree workspace was cut as, once its worktree is gone, together with the
 * ref archival saved its uncommitted work to.
 *
 * A worktree is always cut as a new branch, so the branch is the workspace's own. Git still refuses
 * to delete a branch another worktree has checked out, and that refusal stands. A branch or ref Git
 * no longer has is already deleted.
 */
export async function deleteWorkspaceBranch(options: {
    readonly archivedRef: string;
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
    if (exists.code === 0) {
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
    const saved = await options.git.run(
        options.projectPath,
        ["show-ref", "--verify", "--quiet", options.archivedRef],
        placement,
    );
    if (saved.code !== 0) return;
    const removed = await options.git.run(
        options.projectPath,
        ["update-ref", "-d", options.archivedRef],
        placement,
    );
    if (removed.code !== 0) {
        throw new Error(
            `Git could not delete the archived work at "${options.archivedRef}": ${removed.stderr.trim()}`,
        );
    }
}
