/**
 * Slices: the files an agent picked out for one question, under a title.
 *
 * A slice names paths, never content. A client reads the files and their
 * diffs through the file and git routes, so a slice is a live view over the
 * working tree rather than a snapshot of it.
 */

import type { Cuid2, ResourceVersion, Timestamp } from "./common.js";

/** A one-based, inclusive range of lines of interest in a slice file. */
export interface SliceLineRange {
    start: number;
    end: number;
}

/** One file in a slice. The path may name a file the working tree has since lost. */
export interface SliceFile {
    /** Workspace-relative, forward-slash separated. */
    path: string;
    /** Why this file is in the slice, or `null` when the agent gave no reason. */
    reason: string | null;
    /** Ranges of interest; empty when the whole file is meant. */
    lines: SliceLineRange[];
}

/** The slice object. Immutable once created. */
export interface Slice {
    id: Cuid2;
    /** The workspace the slice belongs to; a project's root workspace ID is the project ID. */
    workspaceId: Cuid2;
    /** The agent that created it. */
    agentId: Cuid2;
    title: string;
    /** A sentence about why these files, or `null`. */
    note: string | null;
    /** In the order the agent listed them. */
    files: SliceFile[];
    /** Minted once; a slice never changes. */
    version: ResourceVersion;
    createdAt: Timestamp;
}

/** `GET /v0/workspaces/:workspaceId/slices` — newest first. */
export interface SlicesResponse {
    slices: Slice[];
}

/** `GET /v0/workspaces/:workspaceId/slices/:sliceId` */
export interface SliceResponse {
    slice: Slice;
}
