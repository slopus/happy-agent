import type { ExplorationToolCallPresentation, SearchSource } from "./ToolCallPresentation.js";

export type FileDiffKind = "add" | "delete" | "update";

export type FileDiffLineKind = "add" | "context" | "delete";

export interface FileDiffLine {
    readonly kind: FileDiffLineKind;
    readonly text: string;
}

export interface FileDiffHunk {
    readonly oldStart: number;
    readonly newStart: number;
    readonly lines: readonly FileDiffLine[];
}

export interface FileDiff {
    readonly path: string;
    readonly kind: FileDiffKind;
    readonly hunks: readonly FileDiffHunk[];
    readonly language?: string;
    /** Exact totals are retained when presentation rows have been omitted. */
    readonly added?: number;
    readonly deleted?: number;
    readonly omittedLines?: number;
}

export interface FileDiffToolResultPresentation {
    readonly type: "file_diff";
    readonly files: readonly FileDiff[];
    readonly omittedFiles?: number;
}

export interface BackgroundTerminalInteractionPresentation {
    readonly command: string;
    readonly input: string;
    readonly sessionId: number;
    readonly type: "background_terminal_interaction";
}

export interface ExecCommandPresentation {
    readonly command: string;
    readonly output: string;
    readonly sessionId?: number;
    readonly type: "exec_command";
}

/**
 * A finished search, carrying what it consulted.
 *
 * The sources are the reason this exists: a reader judges a search by where it looked, and the
 * plain text a tool returns to the model is not something an interface can take that from.
 */
export interface SearchToolResultPresentation {
    readonly type: "search";
    readonly target: "web" | "x";
    readonly query: string;
    readonly sources: readonly SearchSource[];
}

/**
 * A finished tool keeps the shape its call announced.
 *
 * Exploration is a result presentation as well as a call presentation so a
 * command that was shown as exploration while it ran is still exploration when
 * it finishes, instead of turning into a second, unrelated row. A search is the
 * same, and gains the sources it consulted.
 */
export type ToolResultPresentation =
    | BackgroundTerminalInteractionPresentation
    | ExecCommandPresentation
    | ExplorationToolCallPresentation
    | FileDiffToolResultPresentation
    | SearchToolResultPresentation;
