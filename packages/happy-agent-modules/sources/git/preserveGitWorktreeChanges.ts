import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import type { GitWorkingFiles } from "./gitWorkingFiles.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./worktreeCheckoutTimeout.js";

const ARCHIVED_NAMESPACE = "refs/happy/archived/";
const ARCHIVED_REF = /^refs\/happy\/archived\/[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const INDEX_NAME = "happy-preserve-index";
/** Enough status output for hundreds of thousands of changed paths. */
const STATUS_OUTPUT_LIMIT = 32 * 1024 * 1024;
const STAT_PAGE = 1_024;

/** What to do with work a worktree still holds before its folder is deleted. */
export interface GitWorktreePreservationRequest {
    /** Work larger than this is not saved, and the folder is kept instead. */
    readonly maximumBytes: number;
    readonly message: string;
    readonly ref: string;
    /** Saves under `refs/happy/archived/` older than this are deleted afterwards. */
    readonly retentionMs: number;
}

/** What happened to the work a worktree still held. */
export type GitWorktreePreservation =
    | {
          readonly outcome: "saved";
          /** The save commit. Its parent is the worktree's HEAD when it had one. */
          readonly commit: string;
          /**
           * Uncommitted paths saved now, untracked ones included. Absent when the ref already
           * existed from an earlier attempt and was kept as it was.
           */
          readonly changedPaths?: number;
          readonly ref: string;
      }
    | {
          /** Nothing was saved and the folder must be kept. */
          readonly outcome: "too_large";
          readonly bytes: number;
          readonly changedPaths: number;
      };

/**
 * Saves what removing a worktree would destroy, without touching its branch, index, or stashes.
 *
 * Uncommitted and untracked files, ignored ones excepted, are written into a temporary index read
 * from HEAD and committed on top of HEAD; a detached HEAD no branch, remote, or tag contains is
 * saved the same way even when the tree is clean. The commit goes to `ref`, which is created only
 * when it does not exist yet: a retry after a removal that failed halfway must never replace the
 * first, complete save with what was left. Nothing is saved when the branch already holds
 * everything, because removing the worktree keeps its branch. Work larger than `maximumBytes` is
 * measured before anything is written and reported as too large instead.
 */
export async function preserveGitWorktreeChanges(options: {
    files: Pick<GitWorkingFiles, "lstatMany" | "paths">;
    git: GitCommandRunner;
    request: GitWorktreePreservationRequest;
    workspacePath: string;
}): Promise<GitWorktreePreservation | undefined> {
    const { files, git, workspacePath } = options;
    const { maximumBytes, message, ref } = options.request;
    if (!ARCHIVED_REF.test(ref)) throw new Error("The preservation ref name is invalid.");
    const existing = await git.run(workspacePath, ["rev-parse", "--verify", "--quiet", ref]);
    if (existing.code === 0) return { outcome: "saved", commit: existing.stdout.trim(), ref };

    const status = await runGitCommandOrThrow(
        git,
        workspacePath,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
        { maxOutputBytes: STATUS_OUTPUT_LIMIT, timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
    );
    // Each entry is two status letters, a space, and the path relative to the worktree.
    const changed = status
        .split("\0")
        .filter((entry) => entry.length > 3)
        .map((entry) => files.paths.join(workspacePath, entry.slice(3)));
    const headResult = await git.run(workspacePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD^{commit}",
    ]);
    const head = headResult.code === 0 ? headResult.stdout.trim() : undefined;

    if (changed.length === 0) {
        if (head === undefined || !(await isUnreferencedDetachedHead(git, workspacePath, head))) {
            return undefined;
        }
    } else {
        const bytes = await measure(files, changed, maximumBytes);
        if (bytes > maximumBytes) {
            return { outcome: "too_large", bytes, changedPaths: changed.length };
        }
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
    if (changed.length > 0) {
        await runGitCommandOrThrow(git, workspacePath, ["add", "--all", "--", "."], {
            ...temporary,
            timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
        });
    }
    const tree = await runGitCommandOrThrow(git, workspacePath, ["write-tree"], temporary);
    // A save is always a new commit, even of a clean detached HEAD, so its committer date says
    // when it was saved and expiry counts from then.
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
    // An empty old value makes Git refuse when the ref already exists.
    await runGitCommandOrThrow(git, workspacePath, [
        "update-ref",
        "-m",
        message.split("\n", 1)[0] ?? message,
        ref,
        commit,
        "",
    ]);
    return { outcome: "saved", changedPaths: changed.length, commit, ref };
}

/**
 * Deletes saves under `refs/happy/archived/` whose commit is older than the retention.
 *
 * Housekeeping only: a ref that cannot be read or deleted is left for a later archive, and a ref
 * that moved since it was listed is not deleted.
 */
export async function expireArchivedGitWork(options: {
    git: GitCommandRunner;
    now: number;
    projectPath: string;
    retentionMs: number;
}): Promise<void> {
    const { git, projectPath } = options;
    const listed = await git.run(projectPath, [
        "for-each-ref",
        "--format=%(refname) %(objectname) %(committerdate:unix)",
        ARCHIVED_NAMESPACE,
    ]);
    if (listed.code !== 0) return;
    const cutoff = Math.floor((options.now - options.retentionMs) / 1_000);
    for (const line of listed.stdout.split("\n")) {
        const [ref, object, savedAt] = line.trim().split(" ");
        if (ref === undefined || object === undefined || savedAt === undefined) continue;
        const seconds = Number(savedAt);
        if (savedAt.length === 0 || !Number.isFinite(seconds) || seconds >= cutoff) continue;
        await git.run(projectPath, ["update-ref", "-d", ref, object]);
    }
}

/** The bytes the changed paths hold, stopping once they pass the limit. Missing paths are 0. */
async function measure(
    files: Pick<GitWorkingFiles, "lstatMany">,
    paths: readonly string[],
    maximumBytes: number,
): Promise<number> {
    let bytes = 0;
    for (let offset = 0; offset < paths.length && bytes <= maximumBytes; offset += STAT_PAGE) {
        for (const stat of await files.lstatMany(paths.slice(offset, offset + STAT_PAGE))) {
            bytes += stat?.size ?? 0;
        }
    }
    return bytes;
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
