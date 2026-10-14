import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/GitModule.js";
import type { GitCommandRunner } from "../../sources/git/GitCommandRunner.js";
import { cleanupRoots, createRepository, createRoot, git, gitRunner } from "./helpers.js";

const execFile = promisify(execFileCallback);
const modules: GitModule[] = [];
afterEach(() => {
    for (const module of modules.splice(0)) module.dispose();
    return cleanupRoots();
});

function open(runner: GitCommandRunner = gitRunner): GitModule {
    const module = GitModule.withRunner(runner);
    modules.push(module);
    return module;
}

/** A commit on top of HEAD, committed at a fixed second, without moving any branch. */
async function commitAt(repository: string, seconds: number): Promise<string> {
    const date = `@${String(seconds)} +0000`;
    const result = await execFile(
        "git",
        [
            "-C",
            repository,
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            "-m",
            `at ${String(seconds)}`,
        ],
        {
            encoding: "utf8",
            env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        },
    );
    return result.stdout.trim();
}

async function repositoryWithBranches(): Promise<string> {
    const repository = await createRepository();
    const date = "@1000 +0000";
    await execFile("git", ["-C", repository, "commit", "--quiet", "--allow-empty", "-m", "first"], {
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    await git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const refs: [string, number][] = [
        ["refs/remotes/origin/FERN-1234-x", 4000],
        ["refs/heads/fix-fern", 3000],
        ["refs/heads/release", 2500],
        ["refs/remotes/origin/release", 2500],
        ["refs/heads/FERN-1-old", 2000],
        ["refs/remotes/upstream/feature/fern-y", 1500],
    ];
    const commits = new Map<number, string>();
    for (const [ref, seconds] of refs) {
        const commit = commits.get(seconds) ?? (await commitAt(repository, seconds));
        commits.set(seconds, commit);
        await git(repository, ["update-ref", ref, commit]);
    }
    return repository;
}

describe("GitModule branches", () => {
    it("lists every branch a comparison can use, newest first, the way a person writes it", async () => {
        const repository = await repositoryWithBranches();

        // The checked-out main is not offered; origin/HEAD only names another branch.
        expect(await open().branches(repository, { limit: 50, query: "" })).toEqual({
            branches: [
                { ref: "origin/FERN-1234-x", remote: true, committedAt: 4_000_000 },
                { ref: "fix-fern", remote: false, committedAt: 3_000_000 },
                { ref: "release", remote: false, committedAt: 2_500_000 },
                { ref: "origin/release", remote: true, committedAt: 2_500_000 },
                { ref: "FERN-1-old", remote: false, committedAt: 2_000_000 },
                { ref: "upstream/feature/fern-y", remote: true, committedAt: 1_500_000 },
                { ref: "origin/main", remote: true, committedAt: 1_000_000 },
            ],
            truncated: false,
        });
    });

    it("puts names that start with what was typed, with or without their remote, first, ignoring case", async () => {
        const repository = await repositoryWithBranches();
        const module = open();

        expect(
            (await module.branches(repository, { limit: 50, query: "fern" }))?.branches.map(
                (branch) => branch.ref,
            ),
        ).toEqual(["origin/FERN-1234-x", "FERN-1-old", "fix-fern", "upstream/feature/fern-y"]);
        expect(
            (await module.branches(repository, { limit: 50, query: "ORIGIN/fe" }))?.branches.map(
                (branch) => branch.ref,
            ),
        ).toEqual(["origin/FERN-1234-x"]);
        expect(await module.branches(repository, { limit: 2, query: "fern" })).toMatchObject({
            branches: [{ ref: "origin/FERN-1234-x" }, { ref: "FERN-1-old" }],
            truncated: true,
        });
        expect(await module.branches(repository, { limit: 50, query: "nothing" })).toEqual({
            branches: [],
            truncated: false,
        });
    });

    it("answers a burst of typing with one Git process", async () => {
        const repository = await repositoryWithBranches();
        let listings = 0;
        const module = open({
            async run(cwd, args, options) {
                if (args.includes("for-each-ref")) listings += 1;
                return await gitRunner.run(cwd, args, options);
            },
        });

        await Promise.all(
            ["", "f", "fe", "fer", "fern"].map(
                async (query) => await module.branches(repository, { limit: 50, query }),
            ),
        );
        expect(listings).toBe(1);
    });

    it("lists nothing for a repository without commits and nothing at all outside one", async () => {
        const module = open();

        expect(await module.branches(await createRepository(), { limit: 50, query: "" })).toEqual({
            branches: [],
            truncated: false,
        });
        expect(
            await module.branches(await createRoot("happy-git-not-a-repository-"), {
                limit: 50,
                query: "",
            }),
        ).toBeUndefined();
    });
});
