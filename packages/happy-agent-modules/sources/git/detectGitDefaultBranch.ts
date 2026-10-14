import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";

/** The branch a repository treats as its default, preferring what the given remote says. */
export async function detectGitDefaultBranch(
    git: GitCommandRunner,
    path: string,
    remote = "origin",
): Promise<string | undefined> {
    const run = async (args: readonly string[]): Promise<string | undefined> => {
        try {
            const output = (await runGitCommandOrThrow(git, path, args)).trim();
            return output.length === 0 ? undefined : output;
        } catch {
            return undefined;
        }
    };
    const remoteHead = await run([
        "symbolic-ref",
        "--quiet",
        "--short",
        `refs/remotes/${remote}/HEAD`,
    ]);
    if (remoteHead !== undefined && remoteHead.startsWith(`${remote}/`)) {
        return remoteHead.slice(remote.length + 1);
    }
    for (const candidate of ["main", "master"]) {
        const known =
            (await run(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) ??
            (await run([
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/remotes/${remote}/${candidate}`,
            ]));
        if (known !== undefined) return candidate;
    }
    return await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
}
