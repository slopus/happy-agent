import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runScanGit } from "../../sources/git/runScanGit.js";
import { cleanupRoots, createRepository, git } from "./helpers.js";

afterEach(cleanupRoots);

describe("runScanGit", () => {
    it.each([4096, 18577, 262145])(
        "reads %i binary Git blob bytes exactly inside the read-only sandbox",
        async (length) => {
            const repository = await createRepository();
            const bytes = Buffer.from(Array.from({ length }, (_unused, index) => index % 256));
            await writeFile(join(repository, "binary data.bin"), bytes);
            await git(repository, ["add", "--all"]);
            await git(repository, ["commit", "--quiet", "--message", "binary fixture"]);
            const result = await runScanGit({
                args: ["show", "HEAD:binary data.bin"],
                cwd: repository,
            });
            expect(result.stdoutBytes).toEqual(bytes);
            expect(result.truncated).toBe(false);
        },
    );
    it("reads a repository through the read-only execution boundary", async () => {
        const repository = await createRepository();
        const evidence = join(repository, "alias-executed.txt");
        const payload = join(repository, "payload.sh");
        await writeFile(payload, `#!/bin/sh\necho ran > ${JSON.stringify(evidence)}\n`);
        await chmod(payload, 0o755);
        await git(repository, ["config", "alias.hostile", `!${payload}`]);

        await expect(
            runScanGit({
                args: ["hostile"],
                cwd: repository,
            }),
        ).rejects.toThrow();
        await expect(access(evidence)).rejects.toThrow();
    });

    it("does not run repository-configured fsmonitor helpers", async () => {
        const repository = await createRepository();
        await writeFile(join(repository, "tracked.txt"), "one\n");
        await git(repository, ["add", "--all"]);
        await git(repository, ["commit", "--quiet", "--message", "initial"]);
        const evidence = join(repository, "fsmonitor-executed.txt");
        const payload = join(repository, "payload.sh");
        await writeFile(payload, `#!/bin/sh\necho ran > ${JSON.stringify(evidence)}\n`);
        await chmod(payload, 0o755);
        await git(repository, ["config", "core.fsmonitor", payload]);

        await runScanGit({
            args: ["status", "--porcelain=v2", "-z", "--branch"],
            cwd: repository,
        });
        await expect(access(evidence)).rejects.toThrow();
    });

    it("does not run repository-configured text conversion or external diff helpers", async () => {
        const repository = await createRepository();
        await writeFile(join(repository, "tracked.txt"), "one\n");
        await writeFile(join(repository, ".gitattributes"), "tracked.txt diff=custom\n");
        await git(repository, ["add", "--all"]);
        await git(repository, ["commit", "--quiet", "--message", "initial"]);
        await writeFile(join(repository, "tracked.txt"), "two\n");
        const evidence = join(repository, "diff-executed.txt");
        const payload = join(repository, "payload.sh");
        await writeFile(payload, `#!/bin/sh\necho ran >> ${JSON.stringify(evidence)}\n`);
        await chmod(payload, 0o755);
        await git(repository, ["config", "diff.custom.textconv", payload]);
        await git(repository, ["config", "diff.external", payload]);

        await runScanGit({
            args: ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "tracked.txt"],
            cwd: repository,
        });
        await expect(access(evidence)).rejects.toThrow();
    });

    it("bounds output and reports truncation", async () => {
        const repository = await createRepository();
        await mkdir(join(repository, "many"));
        await Promise.all(
            Array.from({ length: 100 }, (_unused, index) =>
                writeFile(join(repository, "many", `${String(index)}.txt`), "x\n"),
            ),
        );
        const result = await runScanGit({
            args: ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
            cwd: repository,
            maximumBytes: 1,
        });
        expect(result.truncated).toBe(true);
    });

    it("honors an already-aborted signal", async () => {
        const repository = await createRepository();
        const controller = new AbortController();
        controller.abort();
        await expect(
            runScanGit({
                args: ["status", "--porcelain=v2"],
                cwd: repository,
                signal: controller.signal,
            }),
        ).rejects.toThrow();
    });
});
