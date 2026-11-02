import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectFilesModule, type ProjectFilesEvent } from "../../sources/files/index.js";
import {
    GitModule,
    type GitChangeSnapshot,
    type GitTrackedEntity,
} from "../../sources/git/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";
import { connectedRunner } from "../support/connectedRunner.js";

const run = promisify(execFile);
const IDENTITY = [
    "-c",
    "user.email=runner@example.com",
    "-c",
    "user.name=Runner",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "init.defaultBranch=main",
];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
    return (await run("git", [...IDENTITY, ...args], { cwd })).stdout.trim();
}

/** A Git module whose repositories live on a connected runner, with a repository there. */
async function runnerRepository() {
    const runner = await connectedRunner(cleanups);
    const gitModule = new GitModule(undefined, runner.runners);
    gitModule.beforeStart(createRootContext());
    cleanups.push(() => gitModule.dispose());
    const remote = join(runner.home, "remote.git");
    await run("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
    const repository = join(runner.home, "project");
    await mkdir(repository);
    await git(repository, "init", "-q");
    await writeFile(join(repository, "README.md"), "one\n");
    await writeFile(join(repository, ".gitignore"), "dist/\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-q", "-m", "first");
    await git(repository, "remote", "add", "origin", remote);
    await git(repository, "push", "-q", "-u", "origin", "main");
    const snapshots: { entity: GitTrackedEntity; snapshot: GitChangeSnapshot }[] = [];
    gitModule.onSnapshot((_ctx, entity, snapshot) => {
        snapshots.push({ entity, snapshot });
    });
    const entity: GitTrackedEntity = {
        path: repository,
        projectId: "project",
        runnerId: runner.runnerId,
    };
    const latest = () =>
        snapshots.filter((entry) => entry.entity.projectId === entity.projectId).at(-1)?.snapshot;
    return { ...runner, git: gitModule, remote, repository, entity, snapshots, latest };
}

describe("Git on a runner", () => {
    it("scans a repository on the runner with untracked counts and binary bytes", async () => {
        const { git: module, repository, runnerId } = await runnerRepository();
        await writeFile(join(repository, "README.md"), "one\ntwo\n");
        await writeFile(join(repository, "notes.txt"), "a\nb\nc");
        await writeFile(join(repository, "image.bin"), Buffer.from([0, 1, 2, 3]));
        await git(repository, "add", "README.md");

        const snapshot = await module.snapshot(repository, repository, { runnerId });

        expect(snapshot).toMatchObject({
            comparison: "ready",
            changedFiles: 3,
            countsExact: true,
            facts: { branch: "main", upstream: "origin/main" },
        });
        const files = Object.fromEntries(snapshot.files.map((file) => [file.path, file]));
        expect(files["README.md"]).toMatchObject({
            status: "modified",
            staged: true,
            insertions: 1,
        });
        expect(files["notes.txt"]).toMatchObject({ status: "untracked", insertions: 3 });
        expect(files["image.bin"]).toMatchObject({ status: "untracked", binary: true });
        expect(Buffer.from(files["image.bin"]?.newBytes ?? [])).toEqual(Buffer.from([0, 1, 2, 3]));
    });

    it("rescans live after edits, commits, checkouts, and fetches on the runner", async () => {
        const { git: module, repository, remote, entity, latest, home } = await runnerRepository();
        module.track(entity);
        await vi.waitFor(() => expect(latest()?.comparison).toBe("ready"), { timeout: 10_000 });
        expect(latest()?.changedFiles).toBe(0);

        // A working-tree edit.
        await writeFile(join(repository, "README.md"), "one\ntwo\n");
        await vi.waitFor(() => expect(latest()?.changedFiles).toBe(1), { timeout: 10_000 });

        // A commit moves HEAD and the branch ref; nothing in the working tree changes after it.
        await git(repository, "commit", "-q", "-am", "second");
        await vi.waitFor(
            () => {
                expect(latest()?.changedFiles).toBe(1);
                expect(latest()?.facts.ahead).toBe(1);
            },
            { timeout: 10_000 },
        );
        const committed = latest()?.facts.head;

        // A checkout of a new branch changes HEAD.
        await git(repository, "checkout", "-q", "-b", "feature");
        await vi.waitFor(() => expect(latest()?.facts.branch).toBe("feature"), {
            timeout: 10_000,
        });
        await git(repository, "checkout", "-q", "main");
        await vi.waitFor(() => expect(latest()?.facts.branch).toBe("main"), { timeout: 10_000 });

        // Someone else pushes; a fetch on the runner moves origin/main only.
        const other = join(home, "other");
        await run("git", ["clone", "-q", remote, other]);
        await writeFile(join(other, "theirs.txt"), "theirs\n");
        await git(other, "add", ".");
        await git(other, "commit", "-q", "-m", "theirs");
        await git(other, "push", "-q", "origin", "main");
        await git(repository, "fetch", "-q", "origin");
        await vi.waitFor(() => expect(latest()?.facts.behind).toBe(1), { timeout: 10_000 });
        expect(latest()?.facts.head).toBe(committed);
    }, 30_000);

    it("tracks a linked worktree through its own control files in the shared Git directory", async () => {
        const {
            git: module,
            repository,
            home,
            runnerId,
            latest,
            watches,
        } = await runnerRepository();
        const worktree = join(home, "workspace");
        await git(repository, "worktree", "add", "-q", "-b", "001-workspace", worktree);
        module.track({ path: worktree, projectId: "project", workspaceId: "w1", runnerId });
        module.track({ path: repository, projectId: "project", runnerId });
        await vi.waitFor(() => expect(latest()?.comparison).toBe("ready"), { timeout: 10_000 });
        await vi.waitFor(() => expect(watches.filter((watch) => !watch.closed).length).toBe(3), {
            timeout: 10_000,
        });
        // One working-tree watch per checkout, and one Git directory watch both share.
        const gitDirectory = await git(repository, "rev-parse", "--absolute-git-dir");
        expect(watches.filter((watch) => watch.options.path === gitDirectory)).toHaveLength(1);

        const seen: GitChangeSnapshot[] = [];
        module.onSnapshot((_ctx, entity, snapshot) => {
            if (entity.workspaceId === "w1") seen.push(snapshot);
        });
        const before = await git(worktree, "rev-parse", "HEAD");
        await writeFile(join(worktree, "work.txt"), "work\n");
        await git(worktree, "add", "work.txt");
        await git(worktree, "commit", "-q", "-m", "work");
        // The commit leaves the working tree clean; only the worktree's HEAD and ref moved.
        await vi.waitFor(
            () => {
                expect(seen.at(-1)?.facts.head).not.toBe(before);
                expect(seen.at(-1)?.changedFiles).toBe(1);
            },
            { timeout: 10_000 },
        );
    }, 30_000);

    it("shares one runner watch between file events and live Git, and drops ignored paths", async () => {
        const {
            git: module,
            repository,
            entity,
            runners,
            watches,
            latest,
        } = await runnerRepository();
        const files = new ProjectFilesModule(
            {} as ProjectsModule,
            {} as WorkspacesModule,
            module,
            runners,
        );
        cleanups.push(async () => await files.close());
        const events: ProjectFilesEvent[] = [];
        files.onEvent((_ctx, event) => {
            events.push(event);
        });
        const root = { projectId: "project", root: repository, runnerId: "build-box" };
        module.track(entity);
        await files.tree(root, {});
        await vi.waitFor(() => expect(latest()?.comparison).toBe("ready"), { timeout: 10_000 });
        const trees = () =>
            watches.filter((watch) => !watch.closed && watch.options.path === repository);
        await vi.waitFor(() => expect(trees()).toHaveLength(1), { timeout: 10_000 });

        // A new folder appears in the tree, then Git's ignore rules take it out of the watch.
        await mkdir(join(repository, "dist"), { recursive: true });
        await writeFile(join(repository, "dist", "bundle.js"), "ignored");
        await vi.waitFor(
            () => expect(events.some((event) => event.paths?.includes("dist"))).toBe(true),
            { timeout: 10_000 },
        );
        // The ignore list is re-derived within the recheck interval; from then on a change inside
        // the ignored folder is dropped while one beside it is still reported.
        let attempt = 0;
        await vi.waitFor(
            async () => {
                attempt += 1;
                await writeFile(join(repository, "dist", `later-${String(attempt)}.js`), "x");
                await writeFile(join(repository, "visible.txt"), String(attempt));
                await new Promise((resolve) => setTimeout(resolve, 500));
                const reported = events.flatMap((event) => event.paths ?? []);
                expect(reported).toContain("visible.txt");
                expect(reported).not.toContain(`dist/later-${String(attempt)}.js`);
            },
            { interval: 500, timeout: 20_000 },
        );
        await vi.waitFor(() => expect(latest()?.changedFiles).toBe(1), { timeout: 10_000 });
        expect(trees()).toHaveLength(1);
    }, 40_000);

    it("polls while the runner is away and reconciles once its watch is armed again", async () => {
        const runnerSide = await runnerRepository();
        const { git: module, repository, entity, latest, watches } = runnerSide;
        module.track(entity);
        await vi.waitFor(() => expect(latest()?.comparison).toBe("ready"), { timeout: 10_000 });
        await vi.waitFor(() => expect(watches.filter((watch) => !watch.closed)).toHaveLength(2), {
            timeout: 10_000,
        });

        // A restarted runner holds none of the old watches.
        await runnerSide.restart();
        await vi.waitFor(() => expect(watches.filter((watch) => !watch.closed)).toHaveLength(0), {
            timeout: 10_000,
        });
        await writeFile(join(repository, "README.md"), "changed while away\n");
        await runnerSide.connect();
        // Nothing watched the change; the re-armed watch reports that it may have missed some.
        await vi.waitFor(() => expect(latest()?.changedFiles).toBe(1), { timeout: 20_000 });
        await vi.waitFor(() => expect(watches.filter((watch) => !watch.closed)).toHaveLength(2), {
            timeout: 20_000,
        });
    }, 40_000);
});
