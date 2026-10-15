/** Git state: branch and sync facts plus the working tree's changes. */

import { Type, type Static } from "@sinclair/typebox";

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
    /** What the changes are measured against. */
    base: string | null;
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

/** `GET /v0/workspaces/:workspaceId/git/compare` — the two commits, each a commit-ish. */
export const gitCompareQuerySchema = Type.Object({
    base: Type.String({ minLength: 1 }),
    head: Type.String({ minLength: 1 }),
});
export type GitCompareQuery = Static<typeof gitCompareQuerySchema>;

/** What happened to one file between two commits; a rename lists its new path. */
export const gitCompareFileStatusSchema = Type.Union([
    Type.Literal("added"),
    Type.Literal("modified"),
    Type.Literal("deleted"),
    Type.Literal("renamed"),
    Type.Literal("copied"),
    Type.Literal("type_changed"),
    Type.Literal("submodule"),
]);
export type GitCompareFileStatus = Static<typeof gitCompareFileStatusSchema>;

/** `insertions` and `deletions` count changed lines; absent for a binary file or a submodule. */
export const gitCompareFileSchema = Type.Object({
    path: Type.String({ minLength: 1 }),
    status: gitCompareFileStatusSchema,
    insertions: Type.Optional(Type.Integer({ minimum: 0 })),
    deletions: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type GitCompareFile = Static<typeof gitCompareFileSchema>;

/**
 * `GET /v0/workspaces/:workspaceId/git/compare`
 *
 * Every path that differs from `base` to `head`, in Git's order.
 * `filesTruncated` is `true` when the list was capped.
 */
export const gitCompareResponseSchema = Type.Object({
    files: Type.Array(gitCompareFileSchema),
    filesTruncated: Type.Boolean(),
});
export type GitCompareResponse = Static<typeof gitCompareResponseSchema>;

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
