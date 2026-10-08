import { statSync } from "node:fs";

import { Type, type Static } from "@sinclair/typebox";

import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeProjectCwd } from "./normalizeProjectCwd.js";
import { gitRepositoryFactsSchema, type GitRepositoryFacts } from "./types.js";

export const gitRepositoryProbeSchema = Type.Object(
    {
        facts: Type.Optional(gitRepositoryFactsSchema),
        presence: Type.Union([Type.Literal("present"), Type.Literal("missing")]),
        worktreeSupport: Type.Union([Type.Literal("supported"), Type.Literal("unsupported")]),
        worktreeSupportReason: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export type GitRepositoryProbe = Static<typeof gitRepositoryProbeSchema>;

export async function probeGitRepository(options: {
    git: GitCommandRunner;
    isHome?: boolean;
    /** Whether a path is a directory on the machine the folder lives on. Defaults to this one. */
    isDirectory?: (path: string) => Promise<boolean>;
    path: string;
    signal?: AbortSignal;
}): Promise<GitRepositoryProbe> {
    if (!(await (options.isDirectory ?? isDirectory)(options.path))) {
        return {
            presence: "missing",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder no longer exists.",
        };
    }
    if (options.isHome === true) {
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "Worktrees cannot be created from your home folder.",
        };
    }
    const run = async (args: readonly string[]): Promise<string | undefined> => {
        try {
            return await runGitCommandOrThrow(
                options.git,
                options.path,
                args,
                options.signal === undefined ? undefined : { signal: options.signal },
            );
        } catch {
            return undefined;
        }
    };
    const topLevel = await run(["rev-parse", "--show-toplevel"]);
    if (topLevel === undefined) {
        const bare = (await run(["rev-parse", "--is-bare-repository"])) === "true";
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: bare
                ? "This is a bare Git repository."
                : "This folder is not a Git repository.",
        };
    }
    if (normalizeProjectCwd(topLevel) !== normalizeProjectCwd(options.path)) {
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is inside a Git repository but is not its root.",
        };
    }
    const facts = await readFacts(run);
    const unsupportedReason =
        facts.head === undefined ? "This repository has no commits yet." : undefined;
    return {
        facts,
        presence: "present",
        worktreeSupport: unsupportedReason === undefined ? "supported" : "unsupported",
        ...(unsupportedReason === undefined ? {} : { worktreeSupportReason: unsupportedReason }),
    };
}

async function readFacts(
    run: (args: readonly string[]) => Promise<string | undefined>,
): Promise<GitRepositoryFacts> {
    const head = await run(["rev-parse", "--verify", "HEAD"]);
    const branch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const upstream =
        branch === undefined
            ? undefined
            : await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const divergence =
        upstream === undefined
            ? undefined
            : await run(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behind = 0, ahead = 0] = (divergence ?? "")
        .split(/\s+/u)
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .map((value) => (Number.isFinite(value) ? value : 0));
    return {
        ahead,
        behind,
        ...(branch === undefined ? {} : { branch }),
        detached: head !== undefined && branch === undefined,
        ...(head === undefined ? {} : { head }),
        ...(upstream === undefined ? {} : { upstream }),
    };
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}
