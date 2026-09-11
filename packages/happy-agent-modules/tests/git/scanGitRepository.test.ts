import { execFile as execFileCallback } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { scanGitRepository } from "../../sources/git/scanGitRepository.js";
import { runScanGit } from "../../sources/git/runScanGit.js";
import { cleanupRoots, commitFile, createRepository, git, setOriginMain } from "./helpers.js";

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

    it("reports an unavailable comparison without origin/main", async () => {
        const repository = await createRepository();
        await commitFile(repository, "a.txt", "one\n");
        const snapshot = await scanGitRepository({ path: repository });
        expect(snapshot.comparison).toBe("unavailable");
        expect(snapshot.error).toContain("remote main branch is unavailable");
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
