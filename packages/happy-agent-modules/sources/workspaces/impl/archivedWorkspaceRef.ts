import { createHash } from "node:crypto";

const REF_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** How long saved work outlives its archived workspace before a later archive deletes it. */
export const ARCHIVED_WORK_RETENTION_DAYS = 30;
export const ARCHIVED_WORK_RETENTION_MS = ARCHIVED_WORK_RETENTION_DAYS * DAY_MS;

/**
 * Uncommitted work larger than this is not saved; the folder is kept instead.
 *
 * Every save lives in the project's object store for the whole retention, and `git add` of a huge
 * tree would hold the archive up for minutes. Source edits, even sweeping ones, are a few
 * megabytes; past 100 MB the folder is almost certainly holding datasets, binaries, or an
 * unignored dependency directory, which a commit is the wrong place for. It is also the size
 * GitHub refuses a single file at, so a save above it could never be pushed anyway.
 */
export const ARCHIVED_WORK_MAXIMUM_BYTES = 100 * 1024 * 1024;
const ARCHIVED_WORK_MAXIMUM_MB = ARCHIVED_WORK_MAXIMUM_BYTES / (1024 * 1024);

/**
 * The ref in the project's repository that keeps what an archived worktree still held.
 *
 * Generated workspace IDs are already valid ref names and are used as they are, so a person can
 * find the save from the ID they see. An ID Git would refuse in a ref name is hashed instead.
 */
export function archivedWorkspaceRef(workspaceId: string): string {
    const name = REF_SAFE_ID.test(workspaceId)
        ? workspaceId
        : createHash("sha256").update(workspaceId).digest("hex");
    return `refs/happy/archived/${name}`;
}

/** What archiving does with a worktree's uncommitted work, for tool text and review. */
export function describeArchivedWork(workspaceId?: string): string {
    const ref =
        workspaceId === undefined
            ? "refs/happy/archived/<workspace ID>"
            : archivedWorkspaceRef(workspaceId);
    return `A worktree's branch is kept. Before its folder is removed, any uncommitted or untracked work in it (ignored files excepted) is saved as a commit at ${ref} in the project's repository and kept for ${String(ARCHIVED_WORK_RETENTION_DAYS)} days; recover it with \`git switch -c <new-branch> ${ref}\`. When that work is larger than ${String(ARCHIVED_WORK_MAXIMUM_MB)} MB, nothing is saved and the folder is kept on disk instead.`;
}
