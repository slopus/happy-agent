import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./worktreeCheckoutTimeout.js";

const ARCHIVED_REF = /^refs\/happy\/archived\/[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const INDEX_NAME = "happy-preserve-index";

/** Where work a removed worktree still held was saved, and how much of it there was. */
export interface GitWorktreePreservation {
    /** The commit holding the saved tree. Its parent is the worktree's HEAD when it had one. */
    readonly commit: string;
    /**
     * Uncommitted paths saved now, untracked ones included. Absent when the ref already existed
     * from an earlier attempt and was kept as it was.
     */
    readonly changedPaths?: number;
    readonly ref: string;
}

/**
 * Saves what removing a worktree would destroy, without touching its branch, index, or stashes.
 *
 * Uncommitted and untracked files, ignored ones excepted, are written into a temporary index read
 * from HEAD and committed on top of HEAD; a detached HEAD no branch, remote, or tag contains is
 * saved even when the tree is clean. The commit goes to `ref`, which is created only when it does
 * not exist yet: a retry after a removal that failed halfway must never replace the first,
 * complete save with what was left. Nothing is saved when the branch already holds everything,
 * because removing the worktree keeps its branch.
 */
export async function preserveGitWorktreeChanges(options: {
    git: GitCommandRunner;
    message: string;
    ref: string;
    workspacePath: string;
}): Promise<GitWorktreePreservation | undefined> {
    const { git, message, ref, workspacePath } = options;
    if (!ARCHIVED_REF.test(ref)) throw new Error("The preservation ref name is invalid.");
    const existing = await git.run(workspacePath, ["rev-parse", "--verify", "--quiet", ref]);
    if (existing.code === 0) return { commit: existing.stdout.trim(), ref };

    const status = await runGitCommandOrThrow(
        git,
        workspacePath,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
        { timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
    );
    const changedPaths = status.split("\0").filter((entry) => entry.length > 0).length;
    const headResult = await git.run(workspacePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD^{commit}",
    ]);
    const head = headResult.code === 0 ? headResult.stdout.trim() : undefined;

    if (changedPaths === 0) {
        if (head === undefined || !(await isUnreferencedDetachedHead(git, workspacePath, head))) {
            return undefined;
        }
        await createRef(git, workspacePath, ref, head, message);
        return { changedPaths: 0, commit: head, ref };
    }

    // The temporary index lives in the worktree's own administrative folder, which removing the
    // worktree deletes, so nothing else has to clean it up.
    const index = await runGitCommandOrThrow(git, workspacePath, [
        "rev-parse",
        "--git-path",
        INDEX_NAME,
    ]);
    const temporary = { environment: { GIT_INDEX_FILE: index } };
    await runGitCommandOrThrow(
        git,
        workspacePath,
        head === undefined ? ["read-tree", "--empty"] : ["read-tree", head],
        temporary,
    );
    await runGitCommandOrThrow(git, workspacePath, ["add", "--all", "--", "."], {
        ...temporary,
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    });
    const tree = await runGitCommandOrThrow(git, workspacePath, ["write-tree"], temporary);
    const commit = await runGitCommandOrThrow(git, workspacePath, [
        // The save is not anyone's authored commit, and a machine without an identity must still
        // be able to make it.
        "-c",
        "user.name=Happy",
        "-c",
        "user.email=happy@localhost",
        "commit-tree",
        "--no-gpg-sign",
        ...(head === undefined ? [] : ["-p", head]),
        "-m",
        message,
        tree,
    ]);
    await createRef(git, workspacePath, ref, commit, message);
    return { changedPaths, commit, ref };
}

async function isUnreferencedDetachedHead(
    git: GitCommandRunner,
    workspacePath: string,
    head: string,
): Promise<boolean> {
    const symbolic = await git.run(workspacePath, ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolic.code === 0) return false;
    const containing = await runGitCommandOrThrow(
        git,
        workspacePath,
        [
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            `--contains=${head}`,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        { timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
    );
    return containing.length === 0;
}

async function createRef(
    git: GitCommandRunner,
    workspacePath: string,
    ref: string,
    commit: string,
    message: string,
): Promise<void> {
    // An empty old value makes Git refuse when the ref already exists.
    await runGitCommandOrThrow(git, workspacePath, [
        "update-ref",
        "-m",
        message.split("\n", 1)[0] ?? message,
        ref,
        commit,
        "",
    ]);
}
