import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listGitWorkingTreeFiles } from "../../sources/git/listGitWorkingTreeFiles.js";
import { readGitFileAtRevision } from "../../sources/git/readGitFileAtRevision.js";
import { cleanupRoots, commitFile, createRepository, createRoot } from "./helpers.js";

afterEach(cleanupRoots);

describe("Git file reads", () => {
    it("lists tracked and untracked files while honoring ignores", async () => {
        const repository = await createRepository();
        await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
        await commitFile(repository, "tracked.txt", "tracked\n");
        await writeFile(join(repository, "untracked.txt"), "loose\n");
        await writeFile(join(repository, "ignored.txt"), "ignored\n");
        await expect(listGitWorkingTreeFiles({ path: repository })).resolves.toEqual({
            paths: [".gitignore", "tracked.txt", "untracked.txt"],
            truncated: false,
        });
    });

    it("reads exact bytes at a revision and distinguishes an absent path", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "binary.bin", Buffer.from([0, 1, 2, 3]));
        const found = await readGitFileAtRevision({
            maximumBytes: 100,
            path: repository,
            relativePath: "binary.bin",
            revision: head,
        });
        expect(found.found && Buffer.from(found.content)).toEqual(Buffer.from([0, 1, 2, 3]));
        await expect(
            readGitFileAtRevision({
                maximumBytes: 100,
                path: repository,
                relativePath: "absent.txt",
                revision: head,
            }),
        ).resolves.toEqual({ found: false });
    });

    it("answers an ordinary non-repository with an empty file list", async () => {
        const plain = join(await createRoot(), "plain");
        await mkdir(plain);
        await expect(listGitWorkingTreeFiles({ path: plain })).resolves.toEqual({
            paths: [],
            truncated: false,
        });
    });

    it("does not report a missing revision as an absent file", async () => {
        const repository = await createRepository();
        await commitFile(repository, "note.txt", "content");
        await expect(
            readGitFileAtRevision({
                maximumBytes: 100,
                path: repository,
                relativePath: "note.txt",
                revision: "f".repeat(40),
            }),
        ).rejects.toThrow();
    });
});
