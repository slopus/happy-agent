import { afterEach, describe, expect, it } from "vitest";

import { resolveGitComparisonBase } from "../../sources/git/resolveGitComparisonBase.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    git,
    setOriginMain,
} from "./helpers.js";

afterEach(cleanupRoots);

function resolve(repository: string, head?: string) {
    return resolveGitComparisonBase({
        ...(head === undefined ? {} : { head }),
        run: async (args) => await git(repository, args),
    });
}

describe("resolveGitComparisonBase", () => {
    it("measures a branch from its merge base with origin/main", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "base.txt", "base\n");
        await setOriginMain(repository, base);
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        const head = await commitFile(repository, "feature.txt", "feature\n");
        // A moved local main must not replace the remote base.
        await git(repository, ["branch", "--force", "main", head]);

        await expect(resolve(repository, head)).resolves.toEqual({
            base,
            baseRef: "refs/remotes/origin/main",
            baseSource: "default",
        });
    });

    it("follows origin's default branch when it is not main", async () => {
        const repository = await createRepository();
        await git(repository, ["branch", "--move", "main", "trunk"]);
        const base = await commitFile(repository, "base.txt", "base\n");
        await git(repository, ["update-ref", "refs/remotes/origin/trunk", base]);
        await git(repository, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/trunk",
        ]);
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        const head = await commitFile(repository, "feature.txt", "feature\n");

        await expect(resolve(repository, head)).resolves.toEqual({
            base,
            baseRef: "refs/remotes/origin/trunk",
            baseSource: "default",
        });
    });

    it("uses the local default branch when there is no remote", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "base.txt", "base\n");
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        const head = await commitFile(repository, "feature.txt", "feature\n");

        await expect(resolve(repository, head)).resolves.toEqual({
            base,
            baseRef: "refs/heads/main",
            baseSource: "default",
        });
    });

    it("uses a local master default branch", async () => {
        const repository = await createRepository();
        await git(repository, ["branch", "--move", "main", "master"]);
        const base = await commitFile(repository, "base.txt", "base\n");
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        const head = await commitFile(repository, "feature.txt", "feature\n");

        await expect(resolve(repository, head)).resolves.toEqual({
            base,
            baseRef: "refs/heads/master",
            baseSource: "default",
        });
    });

    it("falls back to HEAD when the branch shares no history with the default branch", async () => {
        const repository = await createRepository();
        const remote = await commitFile(repository, "base.txt", "base\n");
        await setOriginMain(repository, remote);
        await git(repository, ["checkout", "--quiet", "--orphan", "unrelated"]);
        await git(repository, ["rm", "--quiet", "-r", "--cached", "."]);
        const head = await commitFile(repository, "other.txt", "other\n");

        await expect(resolve(repository, head)).resolves.toEqual({ base: head });
    });

    describe("the comparison branch of a worktree that targets another branch", () => {
        /** main on origin, and a release branch that has moved on from it. */
        async function releaseRepository() {
            const repository = await createRepository();
            const main = await commitFile(repository, "base.txt", "base\n");
            await setOriginMain(repository, main);
            await git(repository, ["checkout", "--quiet", "-b", "release-v8.8"]);
            const release = await commitFile(repository, "release.txt", "release\n");
            await git(repository, ["update-ref", "refs/remotes/origin/release-v8.8", release]);
            await git(repository, ["checkout", "--quiet", "--detach", main]);
            await git(repository, ["branch", "--delete", "--force", "release-v8.8"]);
            return { main, release, repository };
        }

        function resolveOn(
            repository: string,
            head: string,
            extra: Omit<Parameters<typeof resolveGitComparisonBase>[0], "head" | "run"> = {},
        ) {
            return resolveGitComparisonBase({
                head,
                now: () => 1_000,
                run: async (args) => await git(repository, args),
                ...extra,
            });
        }

        it("infers the branch a worktree branch was created from", async () => {
            const { release, repository } = await releaseRepository();
            await git(repository, ["checkout", "--quiet", "-b", "fix", "origin/release-v8.8"]);
            const head = await commitFile(repository, "fix.txt", "fix\n");

            await expect(resolveOn(repository, head, { branch: "fix" })).resolves.toEqual({
                base: release,
                baseCheckedAt: 1_000,
                baseRef: "refs/remotes/origin/release-v8.8",
                baseSource: "inferred",
            });
        });

        it("infers a pull request base or a differently named upstream", async () => {
            const { release, repository } = await releaseRepository();
            await git(repository, ["checkout", "--quiet", "-b", "fix"]);
            await git(repository, ["reset", "--quiet", "--hard", release]);
            const head = await commitFile(repository, "fix.txt", "fix\n");

            await expect(
                resolveOn(repository, head, { branch: "fix", upstream: "origin/release-v8.8" }),
            ).resolves.toMatchObject({ base: release, baseSource: "inferred" });
            // An upstream of the same name is only where the branch is pushed.
            await expect(
                resolveOn(repository, head, { branch: "fix", upstream: "origin/fix" }),
            ).resolves.toMatchObject({ baseSource: "default" });

            await git(repository, ["config", "branch.fix.gh-merge-base", "release-v8.8"]);
            await expect(resolveOn(repository, head, { branch: "fix" })).resolves.toMatchObject({
                base: release,
                baseRef: "refs/remotes/origin/release-v8.8",
                baseSource: "inferred",
            });
        });

        it("prefers the chosen branch, then the recorded one unless it is the default", async () => {
            const { main, release, repository } = await releaseRepository();
            await git(repository, ["checkout", "--quiet", "-b", "fix", "origin/release-v8.8"]);
            const head = await commitFile(repository, "fix.txt", "fix\n");

            await expect(
                resolveOn(repository, head, {
                    branch: "fix",
                    preferences: { recordedBaseRef: "origin/release-v8.8" },
                }),
            ).resolves.toMatchObject({ base: release, baseSource: "workspace" });
            // A workspace recorded against the default branch still finds its real target.
            await expect(
                resolveOn(repository, head, {
                    branch: "fix",
                    preferences: { recordedBaseRef: "main" },
                }),
            ).resolves.toMatchObject({ base: release, baseSource: "inferred" });
            await expect(
                resolveOn(repository, head, {
                    branch: "fix",
                    preferences: { comparisonBase: "main", recordedBaseRef: "release-v8.8" },
                }),
            ).resolves.toEqual({
                base: main,
                baseRef: "refs/remotes/origin/main",
                baseSource: "explicit",
            });
        });

        it("keeps the recorded branch only while HEAD holds the commit it was created at", async () => {
            const { main, release, repository } = await releaseRepository();
            // Workspaces are created at a commit, so the reflog names no branch to infer.
            await git(repository, ["checkout", "--quiet", "-b", "fix", release]);
            const created = await commitFile(repository, "fix.txt", "fix\n");
            const recorded = {
                recordedBaseCommit: release,
                recordedBaseRef: "origin/release-v8.8",
            } as const;

            await expect(
                resolveOn(repository, created, { branch: "fix", preferences: recorded }),
            ).resolves.toMatchObject({ base: release, baseSource: "workspace" });

            // Rebased onto a newer tip of the same branch: still holds the commit it was cut at.
            await git(repository, ["checkout", "--quiet", "--detach", release]);
            const newerRelease = await commitFile(repository, "release-2.txt", "release 2\n");
            await git(repository, ["update-ref", "refs/remotes/origin/release-v8.8", newerRelease]);
            await git(repository, ["checkout", "--quiet", "fix"]);
            await git(repository, ["rebase", "--quiet", "origin/release-v8.8"]);
            const rebased = await git(repository, ["rev-parse", "HEAD"]);
            await expect(
                resolveOn(repository, rebased, { branch: "fix", preferences: recorded }),
            ).resolves.toMatchObject({ base: newerRelease, baseSource: "workspace" });

            // Reset onto work based on main: the record no longer says what it is compared with.
            await git(repository, ["checkout", "--quiet", "--detach", main]);
            const newerMain = await commitFile(repository, "main-2.txt", "main 2\n");
            await setOriginMain(repository, newerMain);
            await git(repository, ["checkout", "--quiet", "fix"]);
            await git(repository, ["reset", "--quiet", "--hard", newerMain]);
            const moved = await commitFile(repository, "fix.txt", "fix on main\n");
            await expect(
                resolveOn(repository, moved, { branch: "fix", preferences: recorded }),
            ).resolves.toEqual({
                base: newerMain,
                baseCheckedAt: 1_000,
                baseRef: "refs/remotes/origin/main",
                baseSource: "default",
            });

            // Without a recorded commit there is nothing to check the record against, so the
            // nearer fork point decides: main forks from HEAD at a newer commit than the release.
            await expect(
                resolveOn(repository, moved, {
                    branch: "fix",
                    preferences: { recordedBaseRef: "origin/release-v8.8" },
                }),
            ).resolves.toMatchObject({ base: newerMain, baseSource: "default" });
        }, 20_000); // Many Git commands run in sequence, and Git is slow on Windows.

        it("drops the recorded branch once a rebase onto main that merged it makes main the nearer fork", async () => {
            const { main, release, repository } = await releaseRepository();
            await git(repository, ["checkout", "--quiet", "-b", "fix", release]);
            const created = await commitFile(repository, "fix.txt", "fix\n");
            const recorded = {
                recordedBaseCommit: release,
                recordedBaseRef: "origin/release-v8.8",
            } as const;
            // Main merges the release, then moves on.
            await git(repository, ["checkout", "--quiet", "--detach", main]);
            await git(repository, [
                "merge",
                "--quiet",
                "--no-ff",
                "--no-edit",
                "-m",
                "Merge release",
                release,
            ]);
            const newestMain = await commitFile(repository, "main-2.txt", "main 2\n");
            await setOriginMain(repository, newestMain);
            await git(repository, ["checkout", "--quiet", "fix"]);
            // Both the workspace and main hold the commit the workspace was cut at.
            await git(repository, ["merge-base", "--is-ancestor", release, "HEAD"]);
            await git(repository, ["merge-base", "--is-ancestor", release, "origin/main"]);

            // Not rebased yet: both fork points are the release commit, so the record stays.
            await expect(
                resolveOn(repository, created, { branch: "fix", preferences: recorded }),
            ).resolves.toEqual({
                base: release,
                baseRef: "refs/remotes/origin/release-v8.8",
                baseSource: "workspace",
            });
            expect(await git(repository, ["merge-base", "origin/main", created])).toBe(release);

            await git(repository, ["rebase", "--quiet", "origin/main"]);
            const rebased = await git(repository, ["rev-parse", "HEAD"]);
            // The rebase keeps the commit the workspace was cut at in its history.
            await git(repository, ["merge-base", "--is-ancestor", release, rebased]);
            await expect(
                resolveOn(repository, rebased, { branch: "fix", preferences: recorded }),
            ).resolves.toEqual({
                base: newestMain,
                baseCheckedAt: 1_000,
                baseRef: "refs/remotes/origin/main",
                baseSource: "default",
            });
        });

        it("says so when a chosen branch is gone, instead of silently changing the numbers", async () => {
            const { release, repository } = await releaseRepository();
            await git(repository, ["checkout", "--quiet", "-b", "fix", "origin/release-v8.8"]);
            const head = await commitFile(repository, "fix.txt", "fix\n");

            const result = await resolveOn(repository, head, {
                branch: "fix",
                preferences: { comparisonBase: "release-v9.0" },
            });
            expect(result).toMatchObject({ base: release, baseSource: "inferred" });
            expect(result.baseNotice).toBe(
                'The chosen comparison branch "release-v9.0" was not found. Changes are compared with origin/release-v8.8.',
            );
        });

        it("reuses an inferred branch without reading the repository for it again", async () => {
            const { release, repository } = await releaseRepository();
            await git(repository, ["checkout", "--quiet", "-b", "fix", "origin/release-v8.8"]);
            const head = await commitFile(repository, "fix.txt", "fix\n");
            const first = await resolveOn(repository, head, { branch: "fix" });
            const commands: string[] = [];
            const second = await resolveGitComparisonBase({
                branch: "fix",
                head,
                now: () => 2_000,
                previous: { ...first, branch: "fix" },
                run: async (args) => {
                    commands.push(args[0]!);
                    return await git(repository, args);
                },
            });
            expect(second).toEqual(first);
            expect(commands).not.toContain("log");
            expect(commands).not.toContain("config");
            expect(second.base).toBe(release);
        });

        it("finds the default branch on a remote that is not called origin", async () => {
            const repository = await createRepository();
            const base = await commitFile(repository, "base.txt", "base\n");
            await git(repository, [
                "remote",
                "add",
                "upstream",
                "https://example.invalid/repo.git",
            ]);
            await git(repository, ["update-ref", "refs/remotes/upstream/trunk", base]);
            await git(repository, [
                "symbolic-ref",
                "refs/remotes/upstream/HEAD",
                "refs/remotes/upstream/trunk",
            ]);
            await git(repository, ["branch", "--move", "main", "local-only"]);
            await git(repository, ["checkout", "--quiet", "-b", "feature"]);
            const head = await commitFile(repository, "feature.txt", "feature\n");

            await expect(resolve(repository, head)).resolves.toEqual({
                base,
                baseRef: "refs/remotes/upstream/trunk",
                baseSource: "default",
            });
        });
    });

    it("compares a repository without commits against the empty tree", async () => {
        const repository = await createRepository();
        await expect(resolve(repository)).resolves.toEqual({
            base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        });
    });

    it("uses the sha256 empty tree in a sha256 repository", async () => {
        const repository = await createRoot();
        try {
            await git(repository, ["init", "--quiet", "--object-format=sha256"]);
        } catch {
            return; // This Git was built without sha256 support.
        }
        await expect(resolve(repository)).resolves.toEqual({
            base: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
        });
    });
});
