import { Type, type Static } from "@sinclair/typebox";

import { gitDiffChangeKindSchema, parseGitRawNumstat } from "./parseGitRawNumstat.js";
import { runScanGit, type ScanGitRunner } from "./runScanGit.js";

export const gitRevisionComparisonSchema = Type.Object(
    {
        files: Type.Array(
            Type.Object(
                {
                    path: Type.String({ minLength: 1 }),
                    status: gitDiffChangeKindSchema,
                    insertions: Type.Optional(Type.Integer({ minimum: 0 })),
                    deletions: Type.Optional(Type.Integer({ minimum: 0 })),
                },
                { additionalProperties: false },
            ),
        ),
        filesTruncated: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type GitRevisionComparison = Static<typeof gitRevisionComparisonSchema>;

/** The folder is not inside a Git repository, so there are no commits to compare. */
export class GitNotRepositoryError extends Error {
    constructor() {
        super("This workspace is not a Git repository.");
        this.name = "GitNotRepositoryError";
    }
}

/** A revision a caller named does not resolve to a commit in this repository. */
export class GitRevisionNotCommitError extends Error {
    constructor(revision: string) {
        super(`"${revision}" does not name a commit in this repository.`);
        this.name = "GitRevisionNotCommitError";
    }
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Every path that differs from one commit to another, in Git's order, with its line counts
 * unless it is binary or a submodule. A rename lists its new path. The list stops at
 * `maximumFiles`, and at a whole record when Git's output is cut short; either way
 * `filesTruncated` says so.
 */
export async function compareGitRevisions(options: {
    base: string;
    head: string;
    maximumFiles: number;
    path: string;
    runGit?: ScanGitRunner;
    signal?: AbortSignal;
}): Promise<GitRevisionComparison> {
    const runGit = options.runGit ?? runScanGit;
    const run = async (args: readonly string[], maximumBytes?: number) =>
        await runGit({
            args,
            cwd: options.path,
            ...(maximumBytes === undefined ? {} : { maximumBytes }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    try {
        await run(["rev-parse", "--git-dir"], 4_096);
    } catch {
        throw new GitNotRepositoryError();
    }
    // Both sides are resolved to commit names first, so nothing a caller wrote reaches the diff
    // as an option or a path.
    const commit = async (revision: string): Promise<string> => {
        if (revision.length === 0 || revision.startsWith("-"))
            throw new GitRevisionNotCommitError(revision);
        let name: string;
        try {
            name = (
                await run(
                    [
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        "--end-of-options",
                        `${revision}^{commit}`,
                    ],
                    256,
                )
            ).stdout.trim();
        } catch {
            throw new GitRevisionNotCommitError(revision);
        }
        if (!COMMIT.test(name)) throw new GitRevisionNotCommitError(revision);
        return name;
    };
    const base = await commit(options.base);
    const head = await commit(options.head);
    const result = await run(["diff", "-z", "--raw", "--numstat", "--find-renames", base, head]);
    const changes = parseGitRawNumstat(
        result.truncated
            ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
            : result.stdout,
    ).filter((change) => change.path.length > 0);
    const files = changes.slice(0, options.maximumFiles).map((change) => ({
        path: change.path,
        status: change.kind,
        ...(change.insertions === undefined ? {} : { insertions: change.insertions }),
        ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
    }));
    return {
        files,
        filesTruncated: result.truncated || changes.length > files.length,
    };
}
