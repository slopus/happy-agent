import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
    clientFrameEvent,
    createAgentGym,
    type AgentGym,
    type HappyAgentEventStream,
} from "@slopus/happy-agent-gym";
import type { GitState } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const TOKEN = "r".repeat(43);
const running = new Set<AgentGym>();
const streams = new Set<HappyAgentEventStream>();

afterEach(async () => {
    for (const stream of streams) stream.close();
    streams.clear();
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * A folder on a runner answers the Git and files API exactly as a folder on the daemon's machine
 * does: the snapshot is scanned on the runner, and the runner's own watch drives `git.updated` and
 * `files.updated` after edits, commits, checkouts and fetches made there.
 */
describe("a folder on a runner", { timeout: 90_000 }, () => {
    it("reports Git and file changes made on the runner as they happen", async () => {
        const { gym, repository, origin, workspaceId } = await runnerRepository();
        const stream = gym.stream();
        streams.add(stream);
        await stream.opened();

        const initial = (await gym.client.getWorkspaceGit(workspaceId)).git;
        expect(initial.facts).toMatchObject({ branch: "main", detached: false });
        expect(initial.changedFiles).toBe(0);

        await gym.client.watchGit({ workspaceIds: [workspaceId] });
        // Listing the folder is what asks for its file changes, as a client showing it would.
        await gym.client.getFileTree(workspaceId);

        // An edit on the runner reaches both the files and the Git subscribers.
        await writeFile(join(repository, "notes.txt"), "one\ntwo\n", "utf8");
        const untracked = await gitUpdate(stream, workspaceId, (git) =>
            git.files.some((file) => file.path === "notes.txt"),
        );
        expect(untracked.files.find((file) => file.path === "notes.txt")).toMatchObject({
            status: "untracked",
            insertions: 2,
        });
        await stream.waitFor((frame) => {
            const event = clientFrameEvent(frame);
            return (
                event?.type === "files.updated" &&
                event.payload.workspaceId === workspaceId &&
                (event.payload.paths === null || event.payload.paths.includes("notes.txt"))
            );
        }, "files.updated for notes.txt");

        // A commit moves HEAD; the file stays a change against the upstream it is ahead of.
        await git(repository, ["add", "notes.txt"]);
        await git(repository, ["commit", "--quiet", "-m", "notes"]);
        const committed = await gitUpdate(
            stream,
            workspaceId,
            (git) => git.facts.head !== initial.facts.head,
        );
        expect(committed.facts.ahead).toBe(1);
        expect(committed.files.find((file) => file.path === "notes.txt")).toMatchObject({
            staged: false,
            unstaged: false,
        });

        // A checkout of another branch is seen through HEAD alone.
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        await gitUpdate(stream, workspaceId, (git) => git.facts.branch === "feature");

        // A fetch that brings in a new remote commit moves only refs.
        await git(repository, ["checkout", "--quiet", "main"]);
        await gitUpdate(stream, workspaceId, (git) => git.facts.branch === "main");
        const other = join(dirname(repository), "other");
        await git(dirname(repository), ["clone", "--quiet", origin, other]);
        await writeFile(join(other, "remote.txt"), "from elsewhere\n", "utf8");
        await git(other, ["add", "remote.txt"]);
        await git(other, ["commit", "-m", "remote"]);
        await git(other, ["push", "--quiet", "origin", "main"]);
        await git(repository, ["fetch", "--quiet", "origin"]);
        const fetched = await gitUpdate(stream, workspaceId, (git) => git.facts.behind === 1);
        expect(fetched.facts).toMatchObject({ ahead: 1, behind: 1, upstream: "origin/main" });

        // Diffs and revisions read the runner's repository.
        const revision = await gym.client.readFileRevision(workspaceId, {
            path: "notes.txt",
            revision: "HEAD",
        });
        expect(Buffer.from(revision.content, "base64").toString("utf8")).toBe("one\ntwo\n");
        expect(gym.errors).toEqual([]);
    });
});

/** A gym with one runner connected, holding a Git repository with an upstream on the runner. */
async function runnerRepository() {
    const gym = await createAgentGym({
        config: `[runners]\ndefault = "local"\n\n[runners.box]\nname = "Box"\ntoken = "${TOKEN}"\n`,
        timeoutMs: 30_000,
    });
    running.add(gym);
    const home = join(dirname(gym.workspacePath), "runner-home");
    await gym.startRunner({ home, token: TOKEN });
    await gym.waitUntil(
        async () =>
            (await gym.client.listRunners()).runners.find(
                (runner) => runner.id === "box" && runner.status === "connected",
            ),
        "the runner to connect",
    );

    const origin = join(home, "origin.git");
    const repository = join(home, "repository");
    await mkdir(repository, { recursive: true });
    await git(home, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    await writeFile(join(repository, "tracked.txt"), "tracked\n", "utf8");
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await git(repository, ["remote", "add", "origin", origin]);
    await git(repository, ["push", "--quiet", "-u", "origin", "main"]);

    const project = (await gym.client.registerProject({ path: repository, runnerId: "box" }))
        .project;
    await gym.waitUntil(async () => {
        const current = (await gym.client.getProject(project.id)).project;
        if (current.initialization.status === "failed")
            throw new Error(current.initialization.error ?? "The project could not be set up.");
        return current.initialization.status === "ready" ? true : undefined;
    }, "the runner project to become ready");
    return { gym, home, origin, repository, workspaceId: project.id };
}

async function gitUpdate(
    stream: HappyAgentEventStream,
    workspaceId: string,
    predicate: (git: GitState) => boolean,
): Promise<GitState> {
    const frame = await stream.waitFor(
        (candidate) => {
            const event = clientFrameEvent(candidate);
            return (
                event?.type === "git.updated" &&
                event.payload.workspaceId === workspaceId &&
                event.payload.git !== null &&
                predicate(event.payload.git)
            );
        },
        `git.updated for ${workspaceId}`,
        30_000,
    );
    const event = clientFrameEvent(frame);
    if (event?.type !== "git.updated" || event.payload.git === null)
        throw new Error("Expected a Git snapshot.");
    return event.payload.git;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile(
        "git",
        ["-c", "user.email=gym@example.invalid", "-c", "user.name=Runner Gym", ...args],
        { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
}
