import { homedir } from "node:os";
import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import {
    happyListWorkspacesRequestSchema,
    type HappyListWorkspacesRequest,
    type HappyListWorkspacesResult,
    type HappyWorkspaceSummary,
} from "./types.js";

/**
 * Answers Happy's worktree picker for a Rig machine.
 *
 * On a Happy CLI machine the picker discovers worktrees by running git through
 * the `bash` RPC. Rig exposes no machine-level shell, so it reports the managed
 * workspaces it already tracks instead — and reports them by project, since a
 * workspace only means anything inside one.
 */
export async function handleHappyListWorkspaces(options: {
    listWorkspaces: (
        directory: string,
    ) =>
        | readonly HappyWorkspaceSummary[]
        | Promise<readonly HappyWorkspaceSummary[] | undefined>
        | undefined;
    params: unknown;
}): Promise<HappyListWorkspacesResult> {
    try {
        const directory = readDirectory(options.params);
        const workspaces = await options.listWorkspaces(directory);
        // A directory Rig has never opened is not a project yet, and therefore
        // holds no workspaces — an empty list, not a failure.
        return { type: "success", workspaces: workspaces ?? [] };
    } catch (error) {
        if (isDatabaseFailure(error)) throw error;
        return {
            errorMessage: error instanceof Error ? error.message : "Rig could not list workspaces.",
            type: "error",
        };
    }
}

function readDirectory(value: unknown): string {
    if (!Value.Check(happyListWorkspacesRequestSchema, value)) {
        throw new Error("Happy must provide a directory.");
    }
    const directory = (value as HappyListWorkspacesRequest).directory.trim();
    const expanded =
        directory === "~"
            ? homedir()
            : directory.startsWith("~/")
              ? resolve(homedir(), directory.slice(2))
              : directory;
    if (!expanded.startsWith("/")) throw new Error("The directory must be absolute.");
    return resolve(expanded);
}
