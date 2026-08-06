export type ExplorationOperation =
    | { readonly kind: "list"; readonly target: string }
    | { readonly kind: "read"; readonly name: string }
    | {
          readonly command: string;
          readonly kind: "search";
          readonly path?: string;
          readonly query?: string;
      };

export interface ExplorationToolCallPresentation {
    readonly type: "exploration";
    readonly operations: readonly ExplorationOperation[];
}

export interface ExecCommandToolCallPresentation {
    readonly command: string;
    readonly type: "exec_command";
}

/** One page a search consulted. */
export interface SearchSource {
    readonly url: string;
    readonly title?: string;
}

/**
 * A search of the world outside the workspace, whoever ran it.
 *
 * The same shape whether Rig executed the search itself through a tool or the provider ran it on
 * its own backend. Those two are not the same kind of work — one has a result Rig produced and the
 * other has none — but they are the same thing to a reader, and this is what a reader is shown.
 */
export interface SearchToolCallPresentation {
    readonly type: "search";
    readonly target: "web" | "x";
    readonly query: string;
}

export type ToolCallPresentation =
    | ExecCommandToolCallPresentation
    | ExplorationToolCallPresentation
    | SearchToolCallPresentation;
