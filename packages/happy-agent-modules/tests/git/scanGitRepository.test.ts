import { execFile as execFileCallback } from "node:child_process";
import { rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
    readGitWorktreeFingerprint,
    scanGitRepository,
    scanGitRepositoryWithFingerprint,
} from "../../sources/git/scanGitRepository.js";
import { runScanGit, scanGitRunnerFromCommandRunner } from "../../sources/git/runScanGit.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    git,
    gitRunner,
    setOriginMain,
} from "./helpers.js";

afterEach(cleanupRoots);
const execFile = promisify(execFileCallback);

describe("scanGitRepository", () => {
    it("uses the origin/main merge base and combines every working state", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "base.txt", "base\n");
        await setOriginMain(repository, base);
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        await commitFile(repository, "committed.txt", "c1\nc2\n");
        await writeFile(join(repository, "staged.txt"), "s1\n");
        await git(repository, ["add", "staged.txt"]);
        await writeFile(join(repository, "untracked.txt"), "u1\nu2\n");

        const snapshot = await scanGitRepository({ path: repository });
        expect(snapshot.base).toBe(base);
        expect(snapshot.changedFiles).toBe(3);
        expect(snapshot.insertions).toBe(5);
        expect(snapshot.countsExact).toBe(true);
        expect(snapshot.files.find((file) => file.path === "committed.txt")).toMatchObject({
            staged: false,
            unstaged: false,
        });
    });

    it("retains both binary sides and omits large files from the display list", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "image.bin", Buffer.from([0, 1, 2, 3]));
        await setOriginMain(repository, base);
        await writeFile(join(repository, "image.bin"), Buffer.from([0, 7, 8, 9, 10]));
        await writeFile(join(repository, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));

        const snapshot = await scanGitRepository({ path: repository });
        const image = snapshot.files.find((file) => file.path === "image.bin");
        expect(image?.binary).toBe(true);
        expect(Buffer.from(image?.oldBytes ?? [])).toEqual(Buffer.from([0, 1, 2, 3]));
        expect(Buffer.from(image?.newBytes ?? [])).toEqual(Buffer.from([0, 7, 8, 9, 10]));
        expect(snapshot.changedFiles).toBe(2);
        expect(snapshot.files.some((file) => file.path === "large.txt")).toBe(false);
        expect(snapshot.filesTruncated).toBe(true);
    });

    it("compares a repository without a remote against its local default branch", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "a.txt", "one\n");
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        await commitFile(repository, "b.txt", "two\n");
        await writeFile(join(repository, "a.txt"), "one\nmore\n");

        const snapshot = await scanGitRepository({ path: repository });
        expect(snapshot).toMatchObject({
            base,
            baseRef: "refs/heads/main",
            changedFiles: 2,
            comparison: "ready",
            insertions: 2,
        });
    });

    it("shows uncommitted work on the default branch without a remote", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "a.txt", "one\n");
        await writeFile(join(repository, "a.txt"), "one\ntwo\n");

        const snapshot = await scanGitRepository({ path: repository });
        expect(snapshot).toMatchObject({ base: head, changedFiles: 1, comparison: "ready" });
        expect(snapshot.files.map((file) => file.status)).toEqual(["modified"]);
    });

    it("shows every file in a repository without commits as new", async () => {
        const repository = await createRepository();
        await writeFile(join(repository, "staged.txt"), "s1\ns2\n");
        await git(repository, ["add", "staged.txt"]);
        await writeFile(join(repository, "untracked.txt"), "u1\n");
        // Binary files read their old side at the base, which must work for the empty tree.
        await writeFile(join(repository, "image.bin"), Buffer.from([0, 1, 2]));
        await git(repository, ["add", "image.bin"]);

        const snapshot = await scanGitRepository({ path: repository });
        expect(snapshot).toMatchObject({
            base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            changedFiles: 3,
            comparison: "ready",
            insertions: 3,
        });
        expect(snapshot.baseRef).toBeUndefined();
        expect(snapshot.files.map((file) => [file.path, file.status, file.staged])).toEqual([
            ["image.bin", "added", true],
            ["staged.txt", "added", true],
            ["untracked.txt", "untracked", false],
        ]);
        const image = snapshot.files.find((file) => file.path === "image.bin");
        expect(image?.oldBytes).toBeUndefined();
        expect(Buffer.from(image?.newBytes ?? [])).toEqual(Buffer.from([0, 1, 2]));
    });

    it.runIf(process.platform !== "win32")(
        "pins and bounds binary bytes before a working-tree replacement race",
        async () => {
            const repository = await createRepository();
            const base = await commitFile(repository, "image.bin", Buffer.from([0, 1, 2, 3]));
            await setOriginMain(repository, base);
            const imagePath = join(repository, "image.bin");
            await writeFile(imagePath, Buffer.from([0, 4, 5, 6]));
            let replacementAt = 0;
            let writer: Promise<void> | undefined;
            const runGit: typeof runScanGit = async (options) => {
                const result = await runScanGit(options);
                if (options.args[0] === "cat-file" && replacementAt === 0) {
                    await rm(imagePath);
                    await execFile("mkfifo", [imagePath]);
                    replacementAt = Date.now();
                    writer = new Promise<void>((resolve, reject) => {
                        setTimeout(() => {
                            void writeFile(imagePath, Buffer.from([0, 9]))
                                .then(() => resolve())
                                .catch(reject);
                        }, 300);
                    });
                }
                return result;
            };

            const snapshot = await scanGitRepository({ path: repository, runGit });
            const delayAfterReplacement = Date.now() - replacementAt;
            if (delayAfterReplacement < 200) {
                await Promise.all([writer, readFifo(imagePath)]);
            } else {
                await writer;
            }

            expect(delayAfterReplacement).toBeLessThan(200);
            expect(Buffer.from(snapshot.files[0]?.newBytes ?? [])).toEqual(
                Buffer.from([0, 4, 5, 6]),
            );
        },
    );
});

describe("scanGitRepository fingerprints and reuse", () => {
    // Git runs directly here so these run inside an already sandboxed test process too.
    const runGit = scanGitRunnerFromCommandRunner({
        run: async (cwd, args, options) =>
            await gitRunner.run(cwd, ["--no-optional-locks", ...args], options),
    });

    it("proves an unchanged tree and notices content and staging changes", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "a.txt", "one\n");
        await setOriginMain(repository, base);
        await writeFile(join(repository, "a.txt"), "one\ntwo\n");
        await writeFile(join(repository, "untracked.txt"), "u\n");
        const gitDirectory = join(repository, ".git");
        const read = async () =>
            await readGitWorktreeFingerprint({ gitDirectory, path: repository, runGit });

        const scanned = await scanGitRepositoryWithFingerprint({
            gitDirectory,
            path: repository,
            runGit,
        });
        expect(scanned.fingerprint).toBeDefined();
        expect(await read()).toBe(scanned.fingerprint);

        // Still " M" to status: only the file's own stat can tell this apart.
        await writeFile(join(repository, "a.txt"), "one\nthree\n");
        await utimes(
            join(repository, "a.txt"),
            new Date(2_000_000_000_000),
            new Date(2_000_000_000_000),
        );
        const edited = await read();
        expect(edited).not.toBe(scanned.fingerprint);

        await git(repository, ["add", "a.txt"]);
        expect(await read()).not.toBe(edited);
    });

    it("carries untracked line counts forward only for unchanged files", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "a.txt", "one\n");
        await setOriginMain(repository, base);
        const path = join(repository, "untracked.txt");
        await writeFile(path, "a\nb\n");
        const first = await scanGitRepository({ path: repository, runGit });
        expect(first.files.find((file) => file.path === "untracked.txt")?.insertions).toBe(2);

        // A marked count proves the second scan reused it instead of reading the file.
        const previous = {
            ...first,
            files: first.files.map((file) =>
                file.path === "untracked.txt" ? { ...file, insertions: 99 } : file,
            ),
        };
        const reused = await scanGitRepository({ path: repository, previous, runGit });
        expect(reused.files.find((file) => file.path === "untracked.txt")?.insertions).toBe(99);

        await writeFile(path, "a\n");
        await utimes(path, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
        const recounted = await scanGitRepository({ path: repository, previous, runGit });
        expect(recounted.files.find((file) => file.path === "untracked.txt")?.insertions).toBe(1);
    });
});

async function readFifo(path: string): Promise<void> {
    await execFile("dd", [`if=${path}`, "of=/dev/null", "bs=2", "count=1"]);
}

it.each(["", "? lol.txt\0"])(
    "does not infer an unborn repository from incomplete status %j",
    async (stdout) => {
        const seen: string[][] = [];
        const result = await scanGitRepository({
            path: process.cwd(),
            runGit: async ({ args }) => {
                seen.push([...args]);
                const output = args[0] === "status" ? stdout : "";
                return { stdout: output, stdoutBytes: Buffer.from(output), truncated: false };
            },
        });
        expect(result.comparison).toBe("unavailable");
        expect(result.error).toContain("branch identity");
        expect(seen.some((args) => args[0] === "hash-object" || args[0] === "diff")).toBe(false);
    },
);
