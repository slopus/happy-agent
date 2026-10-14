import { Type, type Static } from "@sinclair/typebox";

import type { GitCommandRunner } from "./GitCommandRunner.js";
import { detectGitDefaultBranch } from "./detectGitDefaultBranch.js";

/** Where the branch a snapshot is compared with came from, most deliberate first. */
export const gitComparisonBaseSourceSchema = Type.Union([
    /** Chosen for this workspace by a person. */
    Type.Literal("explicit"),
    /** The branch the workspace was created from. */
    Type.Literal("workspace"),
    /** Read from the repository: the branch's creation, its pull request base, or its upstream. */
    Type.Literal("inferred"),
    /** The repository's default branch. */
    Type.Literal("default"),
]);
export type GitComparisonBaseSource = Static<typeof gitComparisonBaseSourceSchema>;

export const gitComparisonBaseSchema = Type.Object(
    {
        base: Type.Optional(Type.String()),
        /** When the repository was last read for an inferred branch, so the answer can be reused. */
        baseCheckedAt: Type.Optional(Type.Number()),
        /** Why the preferred branch is not the one compared with, in words a person can read. */
        baseNotice: Type.Optional(Type.String()),
        /** The full branch ref the base was measured from, when it came from one. */
        baseRef: Type.Optional(Type.String()),
        baseSource: Type.Optional(gitComparisonBaseSourceSchema),
        error: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export type GitComparisonBase = Static<typeof gitComparisonBaseSchema>;
export type GitBaseRunner = (args: readonly string[]) => Promise<string>;

/** What a workspace says about its comparison branch, before the repository is asked. */
export interface GitComparisonPreferences {
    /** The branch a person chose for the workspace. */
    readonly comparisonBase?: string;
    /** The branch the workspace was created from. */
    readonly recordedBaseRef?: string;
    /** The commit the workspace was created at, on `recordedBaseRef`. */
    readonly recordedBaseCommit?: string;
}

/** The previous answer for this repository, so an inference is not read again on every scan. */
export interface GitComparisonPrevious extends GitComparisonBase {
    readonly branch?: string;
    readonly upstream?: string;
}

/** How long an inferred branch is trusted before the repository is read for it again. */
const INFERENCE_REUSE_MS = 30 * 60 * 1000;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;

/**
 * What a branch's changes are measured against.
 *
 * The comparison branch is, in order: the one a person chose for the workspace, the one the
 * workspace was created from unless that is just the default branch, HEAD no longer holds the
 * commit the workspace was created at, or the default branch forks from HEAD at a newer commit,
 * one the repository records for the branch itself (the ref it was created from, its pull
 * request base, or an upstream with a different name), and finally the default branch. The base
 * is that branch's merge base with HEAD; HEAD itself (uncommitted work only) when no branch
 * shares history; and the empty tree for a repository without commits.
 *
 * Remote branches are found on the remote the current branch tracks, else `origin`, else the only
 * remote. A chosen or recorded branch that no longer exists falls through to the next with a
 * notice, so the numbers never silently change meaning.
 */
export async function resolveGitComparisonBase(options: {
    branch?: string;
    head?: string;
    now?: () => number;
    preferences?: GitComparisonPreferences;
    previous?: GitComparisonPrevious;
    run: GitBaseRunner;
    upstream?: string;
}): Promise<GitComparisonBase> {
    if (options.head === undefined) {
        // `hash-object` only computes the name, so sha256 repositories get their own empty tree.
        const emptyTree = await tryRun(options.run, ["hash-object", "-t", "tree", "/dev/null"]);
        return emptyTree === undefined || emptyTree.length === 0
            ? { error: "The empty comparison tree is unavailable." }
            : { base: emptyTree };
    }
    const head = options.head;
    const now = options.now ?? Date.now;
    const remotes = ((await tryRun(options.run, ["remote"])) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const remote = primaryRemote(remotes, options.upstream);
    const defaultBranch = await detectGitDefaultBranch(commandRunner(options.run), ".", remote);
    const notices: string[] = [];

    const measure = async (
        name: string,
        order: "local" | "remote",
    ): Promise<{ base: string; baseRef: string } | undefined> => {
        // Whoever names the default branch means the shared one, never a stale local copy.
        const tried = isDefault(name) ? "remote" : order;
        for (const ref of candidateRefs(name, remote, remotes, tried)) {
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
                head,
            ]);
            return mergeBase !== undefined && mergeBase.length > 0
                ? { base: mergeBase, baseRef: ref }
                : undefined;
        }
        return undefined;
    };
    const finish = (
        found: { base: string; baseRef: string },
        baseSource: GitComparisonBaseSource,
        baseCheckedAt?: number,
    ): GitComparisonBase => ({
        ...found,
        ...(baseCheckedAt === undefined ? {} : { baseCheckedAt }),
        ...(notices.length === 0
            ? {}
            : {
                  baseNotice: `${notices.join(" ")} Changes are compared with ${shortRef(found.baseRef)}.`,
              }),
        baseSource,
    });
    const isDefault = (name: string) =>
        defaultBranch !== undefined && branchName(name, remotes) === defaultBranch;

    const chosen = options.preferences?.comparisonBase;
    if (chosen !== undefined) {
        const found = await measure(chosen, "local");
        if (found !== undefined) return finish(found, "explicit");
        notices.push(`The chosen comparison branch "${chosen}" was not found.`);
    }
    const recorded = options.preferences?.recordedBaseRef;
    const createdAt = options.preferences?.recordedBaseCommit;
    // A workspace records where it was cut, not where its branch lives now. The record applies
    // only while two things hold. First, HEAD still holds the commit the workspace was created at.
    // Second, the default branch does not fork from HEAD at a newer commit than the recorded
    // branch does. A workspace rebased or reset onto another branch fails the first test. A
    // workspace rebased onto a default branch that merged the recorded branch keeps the cut
    // commit but fails the second test. In both cases the repository is asked instead, without a
    // notice.
    let measuredDefault: { base: string; baseRef: string } | undefined;
    if (
        recorded !== undefined &&
        !isDefault(recorded) &&
        (createdAt === undefined || (await isAncestor(options.run, createdAt, head)))
    ) {
        const found = await measure(recorded, "local");
        if (found !== undefined) {
            measuredDefault =
                defaultBranch === undefined ? undefined : await measure(defaultBranch, "remote");
            if (
                measuredDefault === undefined ||
                measuredDefault.base === found.base ||
                !(await isAncestor(options.run, found.base, measuredDefault.base))
            ) {
                return finish(found, "workspace");
            }
        } else {
            notices.push(
                `"${recorded}", the branch this workspace was created from, was not found.`,
            );
        }
    }

    const previous = options.previous;
    const reusable =
        previous?.baseCheckedAt !== undefined &&
        now() - previous.baseCheckedAt < INFERENCE_REUSE_MS &&
        previous.branch === options.branch &&
        previous.upstream === options.upstream &&
        (previous.baseSource === "inferred" || previous.baseSource === "default");
    let inferred: string | undefined;
    let checkedAt: number | undefined;
    if (reusable) {
        checkedAt = previous.baseCheckedAt;
        inferred = previous.baseSource === "inferred" ? previous.baseRef : undefined;
    } else if (options.branch !== undefined) {
        checkedAt = now();
        inferred = await inferBranchBase(options.run, options.branch, options.upstream, remotes);
    }
    if (inferred !== undefined && !isDefault(inferred)) {
        const found = await measure(inferred, "local");
        if (found !== undefined) return finish(found, "inferred", checkedAt);
    }

    if (defaultBranch !== undefined) {
        const found = measuredDefault ?? (await measure(defaultBranch, "remote"));
        if (found !== undefined) return finish(found, "default", checkedAt);
    }
    return {
        base: head,
        ...(notices.length === 0
            ? {}
            : { baseNotice: `${notices.join(" ")} Only uncommitted work is shown.` }),
    };
}

/**
 * The branch the repository itself says this branch was cut from or targets, if any: the ref
 * named when the branch was created, the pull request base the GitHub CLI records, or an upstream
 * whose name differs from the branch's own.
 */
async function inferBranchBase(
    run: GitBaseRunner,
    branch: string,
    upstream: string | undefined,
    remotes: readonly string[],
): Promise<string | undefined> {
    const created = (
        await tryRun(run, [
            "log",
            "--walk-reflogs",
            "--format=%gs",
            "--grep-reflog=^branch: Created from ",
            "--end-of-options",
            `refs/heads/${branch}`,
        ])
    )
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1)
        ?.slice("branch: Created from ".length)
        .trim();
    if (created !== undefined && namesBranch(created, branch)) return created;
    const pullRequestBase = await tryRun(run, [
        "config",
        "--get",
        `branch.${branch}.gh-merge-base`,
    ]);
    if (pullRequestBase !== undefined && namesBranch(pullRequestBase, branch))
        return pullRequestBase;
    if (upstream !== undefined && branchName(upstream, remotes) !== branch) return upstream;
    return undefined;
}

/** Whether a recorded name is a branch other than this one, rather than HEAD or a commit. */
function namesBranch(name: string, branch: string): boolean {
    return (
        name.length > 0 &&
        name !== "HEAD" &&
        name !== branch &&
        name !== `refs/heads/${branch}` &&
        !COMMIT_PATTERN.test(name) &&
        !/[~^@:\s]/u.test(name)
    );
}

/** The remote whose branches are compared with: the tracked one, else origin, else the only one. */
function primaryRemote(remotes: readonly string[], upstream: string | undefined): string {
    if (upstream !== undefined) {
        const tracked = [...remotes]
            .sort((left, right) => right.length - left.length)
            .find((name) => upstream.startsWith(`${name}/`));
        if (tracked !== undefined) return tracked;
    }
    if (remotes.includes("origin") || remotes.length !== 1) return "origin";
    return remotes[0]!;
}

/** A branch name without its remote, so `origin/main` and `main` both name main. */
function branchName(name: string, remotes: readonly string[]): string {
    const short = name.replace(/^refs\/(heads|remotes)\//u, "");
    if (name.startsWith("refs/heads/")) return short;
    const remote = [...remotes, "origin"]
        .sort((left, right) => right.length - left.length)
        .find((candidate) => short.startsWith(`${candidate}/`));
    return remote === undefined ? short : short.slice(remote.length + 1);
}

/**
 * The refs a branch name may mean, in the order they are tried. A full ref means only itself and
 * a name with a remote prefix means that remote's branch. A bare name means the local branch
 * first for a branch someone named, since that is the newest work, and the remote one first for
 * the default branch, since a stale local default must not move the base.
 */
function candidateRefs(
    name: string,
    remote: string,
    remotes: readonly string[],
    order: "local" | "remote",
): string[] {
    if (name.startsWith("refs/")) return [name];
    if ([...remotes, remote].some((candidate) => name.startsWith(`${candidate}/`))) {
        return [`refs/remotes/${name}`, `refs/heads/${name}`];
    }
    const local = `refs/heads/${name}`;
    const tracked = `refs/remotes/${remote}/${name}`;
    return order === "local" ? [local, tracked] : [tracked, local];
}

/** A ref as a person writes it: `origin/main` or `main`. */
export function shortRef(ref: string): string {
    return ref.replace(/^refs\/(heads|remotes)\//u, "");
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

/** Whether `ancestor` is the same commit as `commit` or one of its parents, grandparents and so on. */
async function isAncestor(run: GitBaseRunner, ancestor: string, commit: string): Promise<boolean> {
    return (
        (await tryRun(run, [
            "merge-base",
            "--is-ancestor",
            "--end-of-options",
            ancestor,
            commit,
        ])) !== undefined
    );
}

async function tryRun(run: GitBaseRunner, args: readonly string[]): Promise<string | undefined> {
    try {
        return (await run(args)).trim();
    } catch {
        return undefined;
    }
}
