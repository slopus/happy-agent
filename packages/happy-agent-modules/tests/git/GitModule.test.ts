import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitModule } from "../../sources/git/GitModule.js";
import type { GitCommandRunner } from "../../sources/git/GitCommandRunner.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    git,
    gitRunner,
    setOriginMain,
} from "./helpers.js";

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

describe("GitModule snapshots", () => {
    it("uses its configured Git boundary for every snapshot command", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const calls: string[][] = [];
        const module = open({
            async run(cwd, args, options) {
                calls.push([...args]);
                return await gitRunner.run(cwd, args, options);
            },
        });

        await expect(module.snapshot(repository)).resolves.toMatchObject({
            comparison: "ready",
        });
        expect(calls.some((args) => args[0] === "status")).toBe(true);
        expect(calls.some((args) => args[0] === "diff")).toBe(true);
        expect(calls.some((args) => args[0] === "cat-file")).toBe(false);
    });

    it("cannot fall back to the raw scanner when its boundary fails", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open({
            async run() {
                return { code: 91, stderr: "configured runner refused", stdout: "" };
            },
        });

        await expect(module.snapshot(repository)).resolves.toMatchObject({
            comparison: "unavailable",
            error: "configured runner refused",
        });
    });

    it("prefers the configured unattended read boundary over foreground Git", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        let foregroundCalls = 0;
        const module = open({
            async run(cwd, args, options) {
                foregroundCalls += 1;
                return await gitRunner.run(cwd, args, options);
            },
            async scan() {
                throw new Error("read-only boundary refused");
            },
        });

        await expect(module.snapshot(repository)).resolves.toMatchObject({
            comparison: "unavailable",
            error: "read-only boundary refused",
        });
        expect(foregroundCalls).toBe(0);
    });

    it("serves a repeated snapshot from its cache until it is invalidated or disposed", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        let statusCalls = 0;
        const module = open({
            async run(cwd, args, options) {
                if (args[0] === "status") statusCalls += 1;
                return await gitRunner.run(cwd, args, options);
            },
        });

        await module.snapshot(repository, "one");
        const afterFirst = statusCalls;
        expect(afterFirst).toBeGreaterThan(0);

        await module.snapshot(repository, "one");
        expect(statusCalls).toBe(afterFirst);

        module.invalidate(repository);
        await module.snapshot(repository, "one");
        const afterInvalidate = statusCalls;
        expect(afterInvalidate).toBeGreaterThan(afterFirst);

        module.dispose();
        await module.snapshot(repository, "one");
        expect(statusCalls).toBeGreaterThan(afterInvalidate);
    });

    it("keeps a slow snapshot cached for its full lifetime after scanning completes", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        let now = 1_000;
        let statusCalls = 0;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        const module = open({
            async run(cwd, args, options) {
                if (args[0] === "status") {
                    statusCalls += 1;
                    // Native Windows scans can take longer than the two-second cache lifetime.
                    now += 7_000;
                }
                return await gitRunner.run(cwd, args, options);
            },
        });
        try {
            const first = await module.snapshot(repository, "slow");
            const afterFirst = statusCalls;
            expect(afterFirst).toBeGreaterThan(0);
            expect(await module.snapshot(repository, "slow")).toBe(first);
            now += 1_999;
            expect(await module.snapshot(repository, "slow")).toBe(first);
            expect(statusCalls).toBe(afterFirst);

            now += 2;
            expect(await module.snapshot(repository, "slow")).not.toBe(first);
            expect(statusCalls).toBeGreaterThan(afterFirst);
        } finally {
            clock.mockRestore();
        }
    });

    it("addresses a batch of catalog entities as live snapshots", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();

        const snapshots = await module.watch([
            { projectId: "project-1", root: repository },
            { projectId: "project-1", root: repository, workspaceId: "workspace-1" },
        ]);

        expect(snapshots.map((snapshot) => snapshot.type)).toEqual([
            "project_git_changed",
            "workspace_git_changed",
        ]);
        expect(snapshots[1]?.workspaceId).toBe("workspace-1");
        expect(snapshots[0]?.data.git.generation).toBe(module.generation());
    });
});

describe("GitModule repository reads", () => {
    it("answers what a folder is and where its repository lives", async () => {
        const repository = await createRepository();
        await commitFile(repository, "tracked.txt", "one\n");
        const module = open();

        await expect(module.probe(repository)).resolves.toMatchObject({
            presence: "present",
            worktreeSupport: "supported",
        });
        await expect(module.topLevel(repository)).resolves.toBe(
            module.normalizeProjectCwd(repository),
        );
        await expect(module.commonDir(repository)).resolves.toBe(
            module.normalizeProjectCwd(join(repository, ".git")),
        );
        await expect(module.defaultBranch(repository)).resolves.toBe("main");
        await expect(module.facts(repository)).resolves.toMatchObject({ branch: "main" });
    });

    it("refuses to call a folder that is not a repository root a worktree source", async () => {
        const plain = await createRoot();
        const module = open();

        await expect(module.probe(plain)).resolves.toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is not a Git repository.",
        });
        await expect(
            module.isWorktreeAt({ commonDir: join(plain, ".git"), path: plain }),
        ).resolves.toBe(false);
    });

    it("reads bytes at a revision and lists the working tree through its own boundary", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        await writeFile(join(repository, "untracked.txt"), "two\n");
        const module = open();

        await expect(
            module.readFileAtRevision({
                maximumBytes: 1024,
                path: repository,
                relativePath: "tracked.txt",
                revision: head,
            }),
        ).resolves.toEqual({ content: Buffer.from("one\n", "utf8"), found: true });
        await expect(module.listWorkingTreeFiles({ path: repository })).resolves.toEqual({
            paths: ["tracked.txt", "untracked.txt"],
            truncated: false,
        });
        await expect(
            module.countUntrackedFileLines(join(repository, "untracked.txt"), 1024),
        ).resolves.toEqual({ binary: false, inexact: false, insertions: 1 });
    });

    it("measures a branch from its merge base with origin/main", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        const branchHead = await commitFile(repository, "tracked.txt", "two\n");
        const module = open();

        await expect(
            module.resolveComparisonBase(repository, { head: branchHead }),
        ).resolves.toEqual({ base: head });
        await expect(module.resolveCommit(repository, "origin/main")).resolves.toBe(head);
    });
});

describe("GitModule worktrees", () => {
    it("cuts a worktree, renames its branch, and retires it again", async () => {
        const project = await createRepository();
        const head = await commitFile(project, "tracked.txt", "one\n");
        await setOriginMain(project, head);
        const module = open();
        const commonDir = await module.commonDir(project);
        const workspacePath = join(await createRoot(), "workspace");

        const base = await module.resolveWorkspaceBase({
            defaultBranch: "main",
            projectPath: project,
        });
        expect(base).toEqual({ commit: head, ref: "origin/main" });

        await module.createWorktree({
            branch: "001-workspace",
            commit: base.commit,
            expectedCommonDir: commonDir,
            projectPath: project,
            workspacePath,
        });
        await expect(module.isWorktreeAt({ commonDir, path: workspacePath })).resolves.toBe(true);
        await expect(readFile(join(workspacePath, "tracked.txt"), "utf8")).resolves.toBe("one\n");

        await module.renameBranch({
            expectedCommonDir: commonDir,
            from: "001-workspace",
            to: "001-renamed",
            workspacePath,
        });
        await expect(module.facts(workspacePath)).resolves.toMatchObject({
            branch: "001-renamed",
        });

        await module.removeWorktree({
            expectedCommonDir: commonDir,
            projectPath: project,
            removeDirectory: true,
            workspacePath,
        });
        await expect(module.isWorktreeAt({ commonDir, path: workspacePath })).resolves.toBe(false);
    });

    it("refuses to retire a worktree the named repository does not own", async () => {
        const project = await createRepository();
        await commitFile(project, "tracked.txt", "one\n");
        const other = await createRepository();
        const module = open();

        await expect(
            module.removeWorktree({
                expectedCommonDir: await module.commonDir(other),
                projectPath: project,
                removeDirectory: false,
                workspacePath: project,
            }),
        ).rejects.toThrow("The source repository no longer owns this workspace.");
    });
});
