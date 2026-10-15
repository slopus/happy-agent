import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    GitNotRepositoryError,
    GitRevisionNotCommitError,
    compareGitRevisions,
} from "../../sources/git/compareGitRevisions.js";
import { cleanupRoots, commitFile, createRepository, createRoot, git } from "./helpers.js";

afterEach(cleanupRoots);

describe("comparing two commits", () => {
    it("lists every path that differs, with a rename under its new path", async () => {
        const repository = await createRepository();
        await commitFile(repository, "kept.txt", "kept\n");
        await commitFile(repository, "edited.txt", "one\n");
        const base = await commitFile(
            repository,
            "moved.txt",
            "a file long enough that a rename is still recognised as one\n",
        );
        await commitFile(repository, "edited.txt", "two\n");
        await commitFile(repository, "added.txt", "new\n");
        await git(repository, ["mv", "moved.txt", "renamed.txt"]);
        await git(repository, ["commit", "--quiet", "--message", "rename"]);
        await rm(join(repository, "kept.txt"));
        await git(repository, ["commit", "--quiet", "--all", "--message", "delete"]);
        const head = await git(repository, ["rev-parse", "HEAD"]);

        const comparison = await compareGitRevisions({
            base,
            head,
            maximumFiles: 100,
            path: repository,
        });
        expect(comparison.filesTruncated).toBe(false);
        expect(
            [...comparison.files].sort((left, right) => left.path.localeCompare(right.path)),
        ).toEqual([
            { path: "added.txt", status: "added", insertions: 1, deletions: 0 },
            { path: "edited.txt", status: "modified", insertions: 1, deletions: 1 },
            { path: "kept.txt", status: "deleted", insertions: 0, deletions: 1 },
            { path: "renamed.txt", status: "renamed", insertions: 0, deletions: 0 },
        ]);
    });

    it("accepts any commit-ish and caps the list", async () => {
        const repository = await createRepository();
        await commitFile(repository, "first.txt", "1\n");
        await commitFile(repository, "second.txt", "2\n");
        await commitFile(repository, "third.txt", "3\n");
        await expect(
            compareGitRevisions({
                base: "HEAD~2",
                head: "HEAD",
                maximumFiles: 1,
                path: repository,
            }),
        ).resolves.toEqual({
            files: [{ path: "second.txt", status: "added", insertions: 1, deletions: 0 }],
            filesTruncated: true,
        });
        await expect(
            compareGitRevisions({ base: "HEAD", head: "HEAD", maximumFiles: 10, path: repository }),
        ).resolves.toEqual({ files: [], filesTruncated: false });
    });

    it("refuses a revision that is not a commit, including one shaped like an option", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "note.txt", "content\n");
        for (const base of ["f".repeat(40), "no-such-branch", "--output=/tmp/x", "HEAD:note.txt"]) {
            await expect(
                compareGitRevisions({ base, head, maximumFiles: 10, path: repository }),
            ).rejects.toBeInstanceOf(GitRevisionNotCommitError);
        }
    });

    it("says a plain folder is not a repository", async () => {
        const plain = join(await createRoot(), "plain");
        await mkdir(plain);
        await expect(
            compareGitRevisions({ base: "HEAD~1", head: "HEAD", maximumFiles: 10, path: plain }),
        ).rejects.toBeInstanceOf(GitNotRepositoryError);
    });
});
