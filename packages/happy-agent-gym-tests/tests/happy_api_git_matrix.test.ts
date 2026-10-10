import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, writeFile as writeFs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
    clientFrameEvent,
    createAgentGym,
    type AgentGym,
    type HappyAgentEventStream,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const activeGyms = new Set<AgentGym>();
const activeStreams = new Set<HappyAgentEventStream>();

afterEach(async () => {
    for (const stream of activeStreams) stream.close();
    activeStreams.clear();
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("Git API matrix: repository facts and revisions", { timeout: 30_000 }, () => {
    it("[G001] reports a clean repository snapshot with a stable head", async () => {
        const context = await freshGitGym();
        const state = (await context.gym.client.getWorkspaceGit(context.workspaceId)).git;
        expect(state.facts.head).toBeTruthy();
        expect(state.facts.detached).toBe(false);
        expect(state.changedFiles).toBe(0);
        expect(state.conflicted).toBe(false);
    });

    it("[G002] reports the current branch and an available comparison when one exists", async () => {
        const context = await freshGitGym();
        const state = (await context.gym.client.getWorkspaceGit(context.workspaceId)).git;
        expect(state.facts.branch).toBe("main");
        expect(["ready", "unavailable"]).toContain(state.comparison);
        if (state.comparison === "ready") expect(state.base).toEqual(expect.any(String));
    });

    it("[G003] reads a tracked file at HEAD through the public revision route", async () => {
        const context = await freshGitGym();
        const response = await context.gym.client.readFileRevision(context.workspaceId, {
            path: "tracked.txt",
            revision: "HEAD",
        });
        expect(Buffer.from(response.content, "base64").toString("utf8")).toBe("version one\n");
    });

    it("[G004] reads the previous committed revision without exposing the working tree", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "tracked.txt"), "version two\n", "utf8");
        await git(context.repositoryPath, ["add", "tracked.txt"]);
        await git(context.repositoryPath, ["commit", "-m", "second"]);
        const response = await context.gym.client.readFileRevision(context.workspaceId, {
            path: "tracked.txt",
            revision: "HEAD~1",
        });
        expect(Buffer.from(response.content, "base64").toString("utf8")).toBe("version one\n");
    });

    it("[G005] reads a file below a committed directory at an explicit revision", async () => {
        const context = await freshGitGym();
        const response = await context.gym.client.readFileRevision(context.workspaceId, {
            path: "nested/deep.txt",
            revision: "HEAD",
        });
        expect(Buffer.from(response.content, "base64").toString("utf8")).toBe("deep content\n");
    });

    it("[G006] returns not_found for a revision path that was never committed", async () => {
        const context = await freshGitGym();
        await expectApiError(
            () =>
                context.gym.client.readFileRevision(context.workspaceId, {
                    path: "missing.txt",
                    revision: "HEAD",
                }),
            { code: "not_found", status: 404 },
        );
    });

    it("[G007] rejects traversal in a revision path", async () => {
        const context = await freshGitGym();
        await expectApiError(
            () =>
                context.gym.client.readFileRevision(context.workspaceId, {
                    path: "../tracked.txt",
                    revision: "HEAD",
                }),
            { code: "invalid_request", status: 400 },
        );
    });

    it("[G008] returns not_found for an unknown Git revision", async () => {
        const context = await freshGitGym();
        await expectApiError(
            () =>
                context.gym.client.readFileRevision(context.workspaceId, {
                    path: "tracked.txt",
                    revision: "does-not-exist",
                }),
            { code: "not_found", status: 404 },
        );
    });

    it("[G009] exposes an untracked file with an untracked status", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "untracked.txt"), "new file\n", "utf8");
        const state = await waitForState(context, (candidate) =>
            candidate.files.some(
                (file) => file.path === "untracked.txt" && file.status === "untracked",
            ),
        );
        expect(state.files.find((file) => file.path === "untracked.txt")).toMatchObject({
            staged: false,
            unstaged: true,
        });
    });

    it("[G010] reports a newly staged file as added and staged", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "staged.txt"), "staged\n", "utf8");
        await git(context.repositoryPath, ["add", "staged.txt"]);
        const state = await waitForState(context, (candidate) =>
            candidate.files.some((file) => file.path === "staged.txt" && file.status === "added"),
        );
        expect(state.files.find((file) => file.path === "staged.txt")).toMatchObject({
            staged: true,
            unstaged: false,
        });
    });

    it("[G011] reports an unstaged modification with both changed-file and line counts", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "tracked.txt"), "version two\n", "utf8");
        const state = await waitForState(context, (candidate) =>
            candidate.files.some(
                (file) => file.path === "tracked.txt" && file.status === "modified",
            ),
        );
        const file = state.files.find((candidate) => candidate.path === "tracked.txt");
        expect(file).toMatchObject({ staged: false, unstaged: true });
        expect(state.changedFiles).toBeGreaterThanOrEqual(1);
        expect(state.insertions + state.deletions).toBeGreaterThan(0);
    });

    it("[G012] reports a staged modification separately from an unstaged modification", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "tracked.txt"), "staged version\n", "utf8");
        await git(context.repositoryPath, ["add", "tracked.txt"]);
        await writeFs(join(context.repositoryPath, "tracked.txt"), "working version\n", "utf8");
        const state = await waitForState(context, (candidate) =>
            candidate.files.some(
                (file) => file.path === "tracked.txt" && file.status === "modified",
            ),
        );
        expect(state.files.find((file) => file.path === "tracked.txt")).toMatchObject({
            staged: true,
            unstaged: true,
        });
    });

    it("[G013] reports a deleted tracked file with deleted status", async () => {
        const context = await freshGitGym();
        await rm(join(context.repositoryPath, "tracked.txt"));
        const state = await waitForState(context, (candidate) =>
            candidate.files.some(
                (file) => file.path === "tracked.txt" && file.status === "deleted",
            ),
        );
        expect(state.files.find((file) => file.path === "tracked.txt")).toMatchObject({
            staged: false,
            unstaged: true,
        });
    });

    it("[G014] preserves binary metadata for a changed binary file", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "binary.dat"), Buffer.from([0, 1, 2, 3, 255]));
        await git(context.repositoryPath, ["add", "binary.dat"]);
        await git(context.repositoryPath, ["commit", "-m", "binary"]);
        await git(context.repositoryPath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        await writeFs(
            join(context.repositoryPath, "binary.dat"),
            Buffer.from([0, 9, 8, 7, 6, 255]),
        );
        const state = await waitForState(context, (candidate) =>
            candidate.files.some((file) => file.path === "binary.dat" && file.binary),
        );
        expect(state.files.find((file) => file.path === "binary.dat")).toMatchObject({
            binary: true,
            unstaged: true,
        });
    });

    it("[G015] detects an unstaged rename and retains the previous path", async () => {
        const context = await freshGitGym();
        await git(context.repositoryPath, ["mv", "tracked.txt", "renamed.txt"]);
        const state = await waitForState(context, (candidate) =>
            candidate.files.some(
                (file) => file.path === "renamed.txt" && file.status === "renamed",
            ),
        );
        expect(state.files.find((file) => file.path === "renamed.txt")).toMatchObject({
            previousPath: "tracked.txt",
        });
    });

    it("[G016] marks an unmerged file as conflicted after a failed merge", async () => {
        const context = await freshGitGym();
        await git(context.repositoryPath, ["checkout", "-b", "conflict-branch"]);
        await writeFs(join(context.repositoryPath, "tracked.txt"), "branch side\n", "utf8");
        await git(context.repositoryPath, ["add", "tracked.txt"]);
        await git(context.repositoryPath, ["commit", "-m", "branch change"]);
        await git(context.repositoryPath, ["checkout", "main"]);
        await writeFs(join(context.repositoryPath, "tracked.txt"), "main side\n", "utf8");
        await git(context.repositoryPath, ["add", "tracked.txt"]);
        await git(context.repositoryPath, ["commit", "-m", "main change"]);
        await gitExpectFailure(context.repositoryPath, ["merge", "conflict-branch"]);
        const state = await waitForState(context, (candidate) => candidate.conflicted);
        expect(state.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: "tracked.txt",
                    status: "conflicted",
                }),
            ]),
        );
    });
});

describe("Git API matrix: watches, limits, and lifecycle", { timeout: 30_000 }, () => {
    it("[G017] returns a watched repository snapshot keyed by workspace ID", async () => {
        const context = await freshGitGym();
        const stream = openStream(context.gym);
        await stream.opened();
        const response = await context.gym.client.watchGit({
            workspaceIds: [context.workspaceId],
        });
        const snapshot =
            response.snapshots[context.workspaceId] ??
            (await waitForGitEvent(context, stream, () => true));
        expect(snapshot).toBeDefined();
    });

    it("[G018] publishes a git.updated event for an untracked file", async () => {
        const context = await freshGitGym();
        const stream = openStream(context.gym);
        await stream.opened();
        await context.gym.client.watchGit({ workspaceIds: [context.workspaceId] });
        await writeFs(join(context.repositoryPath, "watch-untracked.txt"), "watch\n", "utf8");
        const event = await waitForGitEvent(context, stream, (state) =>
            state.files.some((file) => file.path === "watch-untracked.txt"),
        );
        expect(event.files.find((file) => file.path === "watch-untracked.txt")).toMatchObject({
            status: "untracked",
        });
    });

    it("[G019] publishes staged state through the same watched event family", async () => {
        const context = await freshGitGym();
        const stream = openStream(context.gym);
        await stream.opened();
        await context.gym.client.watchGit({ workspaceIds: [context.workspaceId] });
        await writeFs(join(context.repositoryPath, "watch-staged.txt"), "staged\n", "utf8");
        await git(context.repositoryPath, ["add", "watch-staged.txt"]);
        const event = await waitForGitEvent(context, stream, (state) =>
            state.files.some((file) => file.path === "watch-staged.txt" && file.status === "added"),
        );
        expect(event.files.find((file) => file.path === "watch-staged.txt")).toMatchObject({
            staged: true,
        });
    });

    it("[G020] replacing the watch set with an empty set returns no snapshots", async () => {
        const context = await freshGitGym();
        await context.gym.client.watchGit({ workspaceIds: [context.workspaceId] });
        const replacement = await context.gym.client.watchGit({ workspaceIds: [] });
        expect(replacement.snapshots).toEqual({});
    });

    it("[G021] makes a repeated identical watch registration idempotent", async () => {
        const context = await freshGitGym();
        const stream = openStream(context.gym);
        await stream.opened();
        const first = await context.gym.client.watchGit({
            workspaceIds: [context.workspaceId],
        });
        if (first.snapshots[context.workspaceId] === undefined) {
            await waitForGitEvent(context, stream, () => true);
        }
        const second = await context.gym.client.watchGit({
            workspaceIds: [context.workspaceId],
        });
        expect(Object.keys(second.snapshots)).toEqual([context.workspaceId]);
    });

    it("[G022] watches a non-Git workspace without inventing a repository snapshot", async () => {
        const context = await freshGitGym();
        const rootProjects = (await context.gym.client.listProjects()).projects;
        const root = rootProjects.find(
            (project) =>
                project.compute.type === "host" &&
                project.compute.path === context.gym.workspacePath,
        );
        if (root === undefined) throw new Error("The gym root project was not found.");
        const response = await context.gym.client.watchGit({
            workspaceIds: [root.id],
        });
        expect(response.snapshots[root.id]).toBeUndefined();
    });

    it("[G023] returns the current snapshot for every valid watched repository", async () => {
        const first = await freshGitGym();
        const secondPath = join(dirname(first.gym.workspacePath), "second-repository");
        await mkdir(secondPath, { recursive: true });
        await writeFs(join(secondPath, "other.txt"), "other\n", "utf8");
        await git(secondPath, ["init", "--initial-branch=main"]);
        await git(secondPath, ["config", "user.email", "gym@example.invalid"]);
        await git(secondPath, ["config", "user.name", "API Gym"]);
        await git(secondPath, ["add", "."]);
        await git(secondPath, ["commit", "-m", "second initial"]);
        await git(secondPath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        const secondProject = (
            await first.gym.client.registerProject({
                path: secondPath,
                projectId: "gitmatrixsecond",
            })
        ).project;
        await waitReady(first.gym, secondProject.id);
        const stream = openStream(first.gym);
        await stream.opened();
        const initial = await first.gym.client.watchGit({
            workspaceIds: [first.workspaceId, secondProject.id],
        });
        if (initial.snapshots[first.workspaceId] === undefined) {
            await waitForGitEvent(first, stream, () => true);
        }
        const secondContext = {
            gym: first.gym,
            repositoryPath: secondPath,
            workspaceId: secondProject.id,
        };
        if (initial.snapshots[secondProject.id] === undefined) {
            await waitForGitEvent(secondContext, stream, () => true);
        }
        const response = await first.gym.client.watchGit({
            workspaceIds: [first.workspaceId, secondProject.id],
        });
        expect(Object.keys(response.snapshots)).toEqual(
            expect.arrayContaining([first.workspaceId, secondProject.id]),
        );
    });

    it("[G024] retains repository facts and revisions across a daemon restart", async () => {
        const context = await freshGitGym();
        const before = await context.gym.client.getWorkspaceGit(context.workspaceId);
        await context.gym.restart();
        const after = await context.gym.client.getWorkspaceGit(context.workspaceId);
        expect(after.git.facts.head).toBe(before.git.facts.head);
        await expect(
            context.gym.client.readFileRevision(context.workspaceId, {
                path: "tracked.txt",
                revision: "HEAD",
            }),
        ).resolves.toMatchObject({ content: expect.any(String) });
    });

    it("[G025] reports an ordinary non-Git workspace as unavailable rather than Git", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        activeGyms.add(gym);
        const projects = (await gym.client.listProjects()).projects;
        const root = projects.find(
            (project) =>
                project.compute.type === "host" && project.compute.path === gym.workspacePath,
        );
        if (root === undefined) throw new Error("The gym root project was not found.");
        const state = (await gym.client.getWorkspaceGit(root.id)).git;
        expect(state.comparison).toBe("unavailable");
        expect(state.files).toEqual([]);
    });

    it("[G026] computes insertions for an untracked text file", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "lines.txt"), "one\ntwo\nthree\n", "utf8");
        const state = await waitForState(context, (candidate) =>
            candidate.files.some((file) => file.path === "lines.txt"),
        );
        const file = state.files.find((candidate) => candidate.path === "lines.txt");
        expect(file?.insertions).toBe(3);
        expect(file?.deletions).toBe(0);
    });

    it("[G027] omits files ignored by the repository's .gitignore", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, ".gitignore"), "ignored.log\n", "utf8");
        await git(context.repositoryPath, ["add", ".gitignore"]);
        await git(context.repositoryPath, ["commit", "-m", "ignore logs"]);
        await git(context.repositoryPath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        await writeFs(join(context.repositoryPath, "ignored.log"), "ignored\n", "utf8");
        const state = await waitForState(context, (candidate) => candidate.changedFiles === 0);
        expect(state.files.some((file) => file.path === "ignored.log")).toBe(false);
    });

    it("[G028] keeps changedFiles aligned with the displayed changed paths", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "one.txt"), "one\n", "utf8");
        await writeFs(join(context.repositoryPath, "two.txt"), "two\n", "utf8");
        const state = await waitForState(context, (candidate) => candidate.changedFiles >= 2);
        expect(state.changedFiles).toBeGreaterThanOrEqual(2);
        expect(state.files.map((file) => file.path)).toEqual(
            [...state.files.map((file) => file.path)].sort(),
        );
    });

    it("[G029] reports binary untracked files without treating bytes as text", async () => {
        const context = await freshGitGym();
        await writeFs(join(context.repositoryPath, "untracked.bin"), Buffer.from([0, 255, 1, 0]));
        const state = await waitForState(context, (candidate) =>
            candidate.files.some((file) => file.path === "untracked.bin"),
        );
        expect(state.files.find((file) => file.path === "untracked.bin")?.binary).toBe(true);
    });

    it("[G030] drops a retired workspace from the watch set while retaining the other", async () => {
        const context = await freshGitGym();
        const stream = openStream(context.gym);
        await stream.opened();
        const rootProjects = (await context.gym.client.listProjects()).projects;
        const root = rootProjects.find(
            (project) =>
                project.compute.type === "host" &&
                project.compute.path === context.gym.workspacePath,
        );
        if (root === undefined) throw new Error("The gym root project was not found.");
        const response = await context.gym.client.watchGit({
            workspaceIds: [context.workspaceId, root.id],
        });
        if (response.snapshots[context.workspaceId] === undefined) {
            await waitForGitEvent(context, stream, () => true);
        }
        expect(response.snapshots[root.id]).toBeUndefined();
        const replacement = await context.gym.client.watchGit({
            workspaceIds: [root.id],
        });
        expect(replacement.snapshots[context.workspaceId]).toBeUndefined();
    });
});

interface GitContext {
    readonly gym: AgentGym;
    readonly repositoryPath: string;
    readonly workspaceId: string;
}

interface GitFileLike {
    readonly binary?: boolean;
    readonly deletions?: number;
    readonly insertions?: number;
    readonly path: string;
    readonly previousPath?: string;
    readonly staged: boolean;
    readonly status: string;
    readonly unstaged: boolean;
}

interface GitStateLike {
    readonly changedFiles: number;
    readonly comparison: "ready" | "unavailable";
    readonly conflicted: boolean;
    readonly deletions: number;
    readonly files: readonly GitFileLike[];
    readonly insertions: number;
}

async function freshGitGym(): Promise<GitContext> {
    const gym = await createAgentGym({ timeoutMs: 30_000 });
    activeGyms.add(gym);
    const repositoryPath = join(dirname(gym.workspacePath), "git-repository");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(join(repositoryPath, "nested"), { recursive: true });
    await writeFs(join(repositoryPath, "tracked.txt"), "version one\n", "utf8");
    await writeFs(join(repositoryPath, "nested/deep.txt"), "deep content\n", "utf8");
    await git(repositoryPath, ["init", "--initial-branch=main"]);
    await git(repositoryPath, ["config", "user.email", "gym@example.invalid"]);
    await git(repositoryPath, ["config", "user.name", "API Gym"]);
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "initial"]);
    await git(repositoryPath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const project = (
        await gym.client.registerProject({
            path: repositoryPath,
            projectId: "gitmatrixproject",
        })
    ).project;
    await waitReady(gym, project.id);
    return { gym, repositoryPath, workspaceId: project.id };
}

async function waitReady(gym: AgentGym, projectId: string): Promise<void> {
    await gym.waitUntil(
        async () => {
            const project = (await gym.client.getProject(projectId)).project;
            if (project.initialization.status === "failed") {
                throw new Error(project.initialization.error ?? "Git setup failed.");
            }
            return project.initialization.status === "ready" ? true : undefined;
        },
        `Git project ${projectId} to become ready`,
        30_000,
    );
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", [...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
}

async function gitExpectFailure(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", [...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).then(
        () => {
            throw new Error(`Expected git ${args.join(" ")} to fail.`);
        },
        () => undefined,
    );
}

function openStream(gym: AgentGym): HappyAgentEventStream {
    const stream = gym.stream();
    activeStreams.add(stream);
    return stream;
}

async function waitForState(
    context: GitContext,
    predicate: (state: GitStateLike) => boolean,
): Promise<GitStateLike> {
    return await context.gym.waitUntil(
        async () => {
            const state = (await context.gym.client.getWorkspaceGit(context.workspaceId)).git;
            return predicate(state) ? state : undefined;
        },
        `Git state for ${context.workspaceId}`,
        30_000,
    );
}

async function waitForGitEvent(
    context: GitContext,
    stream: HappyAgentEventStream,
    predicate: (state: GitStateLike) => boolean,
): Promise<GitStateLike> {
    const frame = await stream.waitFor(
        (candidate) => {
            const event = clientFrameEvent(candidate);
            if (event?.type !== "git.updated") return false;
            const payload = event.payload as {
                readonly git?: unknown;
                readonly workspaceId?: unknown;
            };
            return (
                payload.workspaceId === context.workspaceId &&
                payload.git !== null &&
                typeof payload.git === "object" &&
                predicate(payload.git as GitStateLike)
            );
        },
        `git.updated for ${context.workspaceId}`,
        30_000,
    );
    const event = clientFrameEvent(frame);
    if (event?.type !== "git.updated") throw new Error("Expected git.updated.");
    return (event.payload as { readonly git: GitStateLike }).git;
}

async function expectApiError(
    action: () => Promise<unknown>,
    expected: { readonly code: string; readonly status: number },
): Promise<{ readonly body?: unknown; readonly code?: unknown; readonly status?: unknown }> {
    try {
        await action();
    } catch (error: unknown) {
        const apiError = error as {
            readonly body?: unknown;
            readonly code?: unknown;
            readonly status?: unknown;
        };
        expect(apiError.code).toBe(expected.code);
        expect(apiError.status).toBe(expected.status);
        return apiError;
    }
    throw new Error(`Expected ${expected.code} (${String(expected.status)}).`);
}
