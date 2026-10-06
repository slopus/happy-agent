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
