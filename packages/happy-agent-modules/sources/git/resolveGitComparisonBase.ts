import { Type, type Static } from "@sinclair/typebox";

import type { GitCommandRunner } from "./GitCommandRunner.js";
import { detectGitDefaultBranch } from "./detectGitDefaultBranch.js";

export const gitComparisonBaseSchema = Type.Object(
    {
        base: Type.Optional(Type.String()),
        /** The full branch ref the base was measured from, when it came from one. */
        baseRef: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export type GitComparisonBase = Static<typeof gitComparisonBaseSchema>;
export type GitBaseRunner = (args: readonly string[]) => Promise<string>;

/**
 * What a branch's changes are measured against, in order of preference: the merge base with
 * `origin/<default branch>`, the merge base with the local default branch when the remote has
 * none, HEAD itself (uncommitted work only), and the empty tree for a repository without commits.
 */
export async function resolveGitComparisonBase(options: {
    head?: string;
    run: GitBaseRunner;
}): Promise<GitComparisonBase> {
    if (options.head === undefined) {
        // `hash-object` only computes the name, so sha256 repositories get their own empty tree.
        const emptyTree = await tryRun(options.run, ["hash-object", "-t", "tree", "/dev/null"]);
        return emptyTree === undefined || emptyTree.length === 0
            ? { error: "The empty comparison tree is unavailable." }
            : { base: emptyTree };
    }
    const branch = await detectGitDefaultBranch(commandRunner(options.run), ".");
    if (branch !== undefined) {
        for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
            const commit = await tryRun(options.run, [
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                `${ref}^{commit}`,
            ]);
            if (commit === undefined || commit.length === 0) continue;
            const mergeBase = await tryRun(options.run, [
                "merge-base",
                "--end-of-options",
                commit,
                options.head,
            ]);
            if (mergeBase !== undefined && mergeBase.length > 0) {
                return { base: mergeBase, baseRef: ref };
            }
        }
    }
    return { base: options.head };
}

/** Adapts the scan's read-only runner to the shared default-branch detection. */
function commandRunner(run: GitBaseRunner): GitCommandRunner {
    return {
        async run(_cwd, args) {
            try {
                return { code: 0, stderr: "", stdout: await run(args) };
            } catch (error) {
                return {
                    code: 1,
                    stderr: error instanceof Error ? error.message : String(error),
                    stdout: "",
                };
            }
        },
    };
}

async function tryRun(run: GitBaseRunner, args: readonly string[]): Promise<string | undefined> {
    try {
        return (await run(args)).trim();
    } catch {
        return undefined;
    }
}
