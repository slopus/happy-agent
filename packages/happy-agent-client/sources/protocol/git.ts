/** Git state: branch and sync facts plus the working tree's changes. */

import type { Cuid2, GitSummary, Timestamp } from "./common.js";

/** What happened to a single changed file. */
export type GitFileStatus =
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "untracked"
    | "conflicted"
    | "type_changed"
    | "submodule";

/**
 * Which rule chose the comparison branch: a person's choice for the workspace, the branch the
 * workspace was created from, one the repository records for the current branch, or the default
 * branch.
 */
export type GitBaseSource = "explicit" | "workspace" | "inferred" | "default";

/** One changed file against the comparison base. */
export interface GitFileChange {
    path: string;
    status: GitFileStatus;
    staged: boolean;
    unstaged: boolean;
    binary: boolean;
    insertions: number;
    deletions: number;
}

/**
 * The git state object.
 *
 * Git state is computed rather than mutated, so it carries no version chain:
 * the newest snapshot simply replaces what a client held.
 */
export interface GitState {
    facts: GitSummary;
    /** `"unavailable"` when no sensible base exists yet; then only `facts` mean anything. */
    comparison: "ready" | "unavailable";
    /** The commit the changes are measured against. */
    base: string | null;
    /**
     * The branch the changes are compared with, as a person writes it (`"origin/release-v8.8"`),
     * or `null` when `base` is HEAD or the empty tree. Absent on older daemons.
     */
    baseRef?: string | null;
    /** Where `baseRef` came from; `null` when there is none. Absent on older daemons. */
    baseSource?: GitBaseSource | null;
    /** A sentence saying a chosen or recorded branch was not found. Absent on older daemons. */
    baseNotice?: string | null;
    changedFiles: number;
    insertions: number;
    deletions: number;
    /** `false` when a large tree made the daemon estimate. */
    countsExact: boolean;
    conflicted: boolean;
    files: GitFileChange[];
    /** `true` when the file list was capped. */
    filesTruncated: boolean;
    scannedAt: Timestamp;
}

/** `GET /v0/workspaces/:workspaceId/git` */
export interface GitStateResponse {
    git: GitState;
}

/** `GET /v0/workspaces/:workspaceId/git/branches` query. */
export interface ListWorkspaceBranchesQuery {
    /** A case-insensitive substring of at most 200 characters. */
    query?: string;
    /** 1 to 200; the daemon defaults to 50. */
    limit?: number;
}

/** One branch a workspace's changes can be compared with. */
export interface GitBranch {
    /** Written like `GitState.baseRef`, and accepted unchanged as `comparisonBase`. */
    ref: string;
    /** Whether `ref` is a remote-tracking branch. */
    remote: boolean;
    /** The tip commit's time, or `null` when it cannot be read. */
    committedAt: Timestamp | null;
}

/** `GET /v0/workspaces/:workspaceId/git/branches` */
export interface ListWorkspaceBranchesResponse {
    branches: GitBranch[];
    /** `true` when more branches matched than were returned. */
    truncated: boolean;
}

/** `POST /v0/git/watch` */
export interface WatchGitRequest {
    workspaceIds: Cuid2[];
}

/**
 * `POST /v0/git/watch`
 *
 * Whatever the watcher already knows for the requested workspaces. A repository
 * it has not scanned yet is simply absent, and its first `git.updated` event
 * follows shortly.
 */
export interface WatchGitResponse {
    snapshots: Record<string, GitState>;
}
