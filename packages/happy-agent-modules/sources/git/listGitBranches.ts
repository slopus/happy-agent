import { Type, type Static } from "@sinclair/typebox";

import type { ScanGitRunner } from "./runScanGit.js";
import { shortRef } from "./resolveGitComparisonBase.js";

/** Enough for about twenty thousand branches; Git sorts before printing, so a cut keeps the newest. */
const BRANCH_OUTPUT_LIMIT = 2 * 1024 * 1024;
/** The longest name a person can choose as a comparison branch. */
const MAX_BRANCH_NAME = 200;

export const gitBranchSchema = Type.Object(
    {
        /** Written the way a person writes it, and accepted unchanged as a comparison branch. */
        ref: Type.String(),
        remote: Type.Boolean(),
        /** The tip commit's time in milliseconds, when Git could read it. */
        committedAt: Type.Union([Type.Number(), Type.Null()]),
    },
    { additionalProperties: false },
);
export type GitBranch = Static<typeof gitBranchSchema>;

export const gitBranchListSchema = Type.Object(
    {
        /** Newest commit first. */
        branches: Type.Array(gitBranchSchema),
        /** Whether Git's listing was cut off before every branch was read. */
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type GitBranchList = Static<typeof gitBranchListSchema>;

/**
 * Every local and remote-tracking branch a repository already knows, in one bounded read-only Git
 * process and without fetching. Symbolic refs such as `origin/HEAD`, the checked-out branch (a
 * branch compared with itself measures nothing), and names too long to choose are left out.
 * `undefined` when the folder is not a repository.
 */
export async function listGitBranches(options: {
    path: string;
    runGit: ScanGitRunner;
    signal?: AbortSignal;
}): Promise<GitBranchList | undefined> {
    let result;
    try {
        result = await options.runGit({
            args: [
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(HEAD)%00%(refname)%00%(symref)%00%(committerdate:unix)",
                "refs/heads",
                "refs/remotes",
            ],
            cwd: options.path,
            maximumBytes: BRANCH_OUTPUT_LIMIT,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    } catch (error) {
        if (isMissingRepository(error)) return undefined;
        throw error;
    }
    const output = result.truncated
        ? result.stdout.slice(0, result.stdout.lastIndexOf("\n") + 1)
        : result.stdout;
    const branches: GitBranch[] = [];
    for (const line of output.split("\n")) {
        const [head, refname, symref, committed] = line.replace(/\r$/u, "").split("\0");
        if (refname === undefined || symref === undefined || committed === undefined) continue;
        if (symref.length > 0) continue;
        const remote = refname.startsWith("refs/remotes/");
        if (!remote && (!refname.startsWith("refs/heads/") || head === "*")) continue;
        const ref = shortRef(refname);
        if (ref.length === 0 || ref.length > MAX_BRANCH_NAME || ref.startsWith("-")) continue;
        const seconds = /^[0-9]+$/u.test(committed) ? Number(committed) : undefined;
        branches.push({
            ref,
            remote,
            committedAt: seconds === undefined ? null : seconds * 1000,
        });
    }
    return { branches, truncated: result.truncated };
}

function isMissingRepository(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const message = error instanceof Error ? error.message : "";
    return `${message}\n${stderr}`.includes("not a git repository");
}
