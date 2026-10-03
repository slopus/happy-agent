/**
 * Files: read-mostly access to a workspace's folder.
 *
 * Every path is relative to the workspace root; absolute paths, `..`, and
 * symlinks escaping the root are rejected by the daemon.
 */

/** One result from ranked fuzzy workspace-file search. */
export interface FileMatch {
    path: string;
    fileName: string;
}

/** `GET /v0/workspaces/:workspaceId/files` query parameters. */
export interface FileSearchQuery {
    /** A fuzzy relative-path query. May be empty to list initial picker suggestions. */
    query: string;
    /** Maximum results, from 1 through 50. The daemon defaults to 50. */
    limit?: number;
}

/** `GET /v0/workspaces/:workspaceId/files` */
export interface FileSearchResponse {
    /** Best fuzzy match first. */
    files: FileMatch[];
}

/** One entry of a directory listing. */
export interface FileTreeEntry {
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "other";
    size: number;
    modified: number;
}

/** `GET /v0/workspaces/:workspaceId/file-tree` query parameters. */
export interface FileTreeQuery {
    /** Defaults to the workspace root. */
    path?: string;
    cursor?: string;
    limit?: number;
}

/** `GET /v0/workspaces/:workspaceId/file-tree` */
export interface FileTreeResponse {
    entries: FileTreeEntry[];
    nextCursor: string | null;
}

/** `GET /v0/workspaces/:workspaceId/file` */
export interface FileContentResponse {
    /** Base64, because files are bytes and not necessarily text. */
    content: string;
    /** The sha256 hex digest, which is the write guard. */
    hash: string;
}

/** `PUT /v0/workspaces/:workspaceId/file` */
export interface WriteFileRequest {
    path: string;
    /** Base64 file content. */
    content: string;
    /**
     * The compare-and-swap: the sha256 the client read, or `null` to require
     * that the file not exist yet.
     */
    expectedHash: string | null;
}

/** `PUT /v0/workspaces/:workspaceId/file` */
export interface WriteFileResponse {
    hash: string;
}

/** `GET /v0/workspaces/:workspaceId/file-revision` query parameters. */
export interface FileRevisionQuery {
    path: string;
    /** A commit-ish. */
    revision: string;
}

/** `GET /v0/workspaces/:workspaceId/file-revision` */
export interface FileRevisionResponse {
    /** Base64 file content as of the revision. */
    content: string;
}

/** Which files a mask is laid over: the working tree's changes, or every file it holds. */
export type FileMatchSource = "changes" | "all";

/** A one-based, inclusive run of lines of interest in a pinned file. */
export interface FileMatchLineRange {
    start: number;
    end: number;
}

/** One path an agent pinned into a slice by name, with why and where. */
export interface FileMatchPinnedPath {
    /** Workspace-relative, forward-slash separated. */
    path: string;
    reason?: string;
    /** Ranges of interest; absent or empty when the whole file is meant. */
    lines?: FileMatchLineRange[];
}

/**
 * `POST /v0/workspaces/:workspaceId/files/match` — a gitignore-style mask to
 * evaluate against the workspace. Nothing is stored; the answer is what the
 * mask holds right now.
 */
export interface FileMatchRequest {
    source: FileMatchSource;
    /** Rules a file must match; an empty or absent list includes every file. */
    include?: string[];
    /** Rules that take a file back out, applied after `include`. */
    exclude?: string[];
    /** Paths named outright; in the slice whenever the source holds them. */
    paths?: FileMatchPinnedPath[];
    /** Maximum paths returned, from 1 through 2000. The daemon defaults to 500. */
    limit?: number;
}

/** `POST /v0/workspaces/:workspaceId/files/match` */
export interface FileMatchResponse {
    /** The matched paths, sorted, up to `limit`. */
    files: string[];
    /** How many paths the mask holds in all. */
    total: number;
    /** Whether `files` is shorter than `total`, or the source itself was cut short. */
    truncated: boolean;
    /** Include and exclude rules, and pinned paths, that matched nothing, as written. */
    unmatchedRules: string[];
}
