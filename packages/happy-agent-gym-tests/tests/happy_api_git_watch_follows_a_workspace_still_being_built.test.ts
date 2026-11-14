import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("Git watch of a workspace still being built", () => {
    it("watches the whole set and reports the new workspace's edits before it is ready", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const repositoryPath = join(dirname(gym.workspacePath), "git-repository");
        await mkdir(repositoryPath, { recursive: true });
        await writeFile(join(repositoryPath, "tracked.txt"), "version one\n", "utf8");
        await writeFile(join(repositoryPath, ".gitignore"), "release-setup\n", "utf8");
        // Setup runs after the checkout and before the workspace is ready, so holding it keeps
        // the workspace initializing with its folder in place.
        await writeFile(
            join(repositoryPath, "happy.toml"),
            '[workspace]\nsetup_commands = ["while [ ! -e release-setup ]; do sleep 0.1; done"]\n',
            "utf8",
        );
        await git(repositoryPath, ["init", "--initial-branch=main"]);
        await git(repositoryPath, ["config", "user.email", "gym@example.invalid"]);
        await git(repositoryPath, ["config", "user.name", "API Gym"]);
        await git(repositoryPath, ["add", "--all"]);
        await git(repositoryPath, ["commit", "-m", "initial"]);
        await git(repositoryPath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

        const registered = (await gym.client.registerProject({ path: repositoryPath })).project;
        await gym.waitUntil(async () => {
            const project = (await gym.client.getProject(registered.id)).project;
            return project.initialization.status === "ready" ? project : undefined;
        }, "the Git project to initialize");

        const created = (
            await gym.client.createWorkspace({ name: "Being built", parentId: registered.id })
        ).workspace;
        if (created.compute.type !== "host") throw new Error("Expected a host workspace.");
        const folder = created.compute.path;
        await gym.waitUntil(
            async () => existsSync(join(folder, "tracked.txt")) || undefined,
            "the new workspace's checkout",
        );
        expect((await gym.client.getWorkspace(created.id)).workspace.initialization.status).toBe(
            "initializing",
        );

        const stream = gym.stream();
        await stream.opened();
        const watched = await gym.client.watchGit({
            workspaceIds: [registered.id, created.id],
        });
        expect(watched.snapshots).toEqual(expect.any(Object));

        await writeFile(join(folder, "tracked.txt"), "edited while building\n", "utf8");
        await waitForGitEvent(stream, created.id, (state) =>
            state.files.some((file) => file.path === "tracked.txt" && file.status === "modified"),
        );
        await writeFile(join(repositoryPath, "root.txt"), "root\n", "utf8");
        await waitForGitEvent(stream, registered.id, (state) =>
            state.files.some((file) => file.path === "root.txt" && file.status === "untracked"),
        );

        await writeFile(join(folder, "release-setup"), "", "utf8");
        await gym.waitUntil(async () => {
            const workspace = (await gym.client.getWorkspace(created.id)).workspace;
            return workspace.initialization.status === "ready" ? workspace : undefined;
        }, "the new workspace to become ready");
        stream.close();
    }, 60_000);
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", [...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
}

interface GitStateLike {
    readonly files: readonly { readonly path: string; readonly status: string }[];
}

async function waitForGitEvent(
    stream: ReturnType<AgentGym["stream"]>,
    workspaceId: string,
    predicate: (git: GitStateLike) => boolean,
): Promise<void> {
    await stream.waitFor((candidate) => {
        if (candidate.event !== "git.updated") return false;
        const data = candidate.data;
        if (data === null || typeof data !== "object") return false;
        const payload = (data as { readonly payload?: unknown }).payload;
        if (payload === null || typeof payload !== "object") return false;
        if ((payload as { readonly workspaceId?: unknown }).workspaceId !== workspaceId) {
            return false;
        }
        const git = (payload as { readonly git?: unknown }).git;
        return git !== null && typeof git === "object" && predicate(git as GitStateLike);
    }, `a Git snapshot for ${workspaceId}`);
}
