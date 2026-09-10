import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { expect, it, vi } from "vitest";

const exec = promisify(execFile);

it("creates GitHub child workspaces using the clone's credential owner, including after restart", async () => {
    const gym = await createAgentGym({
        environment: { GITHUB_TOKEN: "github-child-workspace-fixture-token" },
    });
    try {
        const source = join(gym.workspacePath, "source");
        await mkdir(source);
        await exec("git", ["init", "--initial-branch=main", source]);
        await exec("git", ["-C", source, "config", "user.name", "Workspace Gym"]);
        await exec("git", ["-C", source, "config", "user.email", "gym@example.invalid"]);
        await writeFile(join(source, "fixture.txt"), "GitHub workspace fixture\n");
        await exec("git", ["-C", source, "add", "fixture.txt"]);
        await exec("git", ["-C", source, "commit", "-m", "fixture"]);

        // Register the GitHub project and its real credential, but prohibit network Git.
        // Recover its checkout from a local fixture through the ordinary refresh API.
        // No GitHub request or real credential is needed to exercise child creation.
        vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");

        const { project } = await gym.client.cloneProject({
            name: "github-fixture",
            source: { kind: "github", repository: "workspace-gym/fixture" },
            secret: { kind: "github" },
        });
        await gym.waitUntil(async () => {
            const current = (await gym.client.getProject(project.id)).project;
            return current.initialization.status === "failed" ? current : undefined;
        }, "network-disabled clone to settle");
        if (project.compute.type !== "host") throw new Error("Expected a host project.");
        await exec("git", ["clone", source, project.compute.path]);
        await exec("git", [
            "-C",
            project.compute.path,
            "remote",
            "set-url",
            "origin",
            "https://github.com/workspace-gym/fixture",
        ]);
        await gym.client.refreshProject(project.id);
        const ready = await gym.waitUntil(async () => {
            const current = (await gym.client.getProject(project.id)).project;
            if (current.initialization.status === "failed") {
                throw new Error(current.initialization.error ?? "Clone failed.");
            }
            return current.initialization.status === "ready" ? current : undefined;
        }, "GitHub project clone to finish");
        expect(ready.remoteSource).toEqual({ kind: "github", repository: "workspace-gym/fixture" });
        expect(ready.worktreeSupport).toBe("supported");

        const child = await createChild(gym, project.id, "first-child");
        const nested = await createChild(gym, child.id, "nested-child");
        expect(nested.base?.ref).toBe(child.git?.branch);
        await gym.restart();
        expect((await gym.client.getWorkspace(child.id)).workspace.parentId).toBe(project.id);
        expect((await gym.client.getWorkspace(nested.id)).workspace.parentId).toBe(child.id);
        await createChild(gym, nested.id, "after-restart");
        expect(
            (await gym.client.listWorkspaces({ projectId: project.id })).workspaces,
        ).toHaveLength(4);
        expect(JSON.stringify(await gym.events())).not.toContain(
            "github-child-workspace-fixture-token",
        );
        expect(gym.errors).toEqual([]);
    } finally {
        try {
            await gym.dispose();
        } finally {
            vi.unstubAllEnvs();
        }
    }
}, 90_000);

async function createChild(gym: AgentGym, parentId: string, name: string) {
    const mutationId = `create-${name}`;
    const { workspace } = await gym.client.createWorkspace({ parentId, name, mutationId });
    expect(workspace).toMatchObject({ parentId, initialization: { status: "initializing" } });
    const ready = await gym.waitUntil(async () => {
        const current = (await gym.client.getWorkspace(workspace.id)).workspace;
        if (current.initialization.status === "failed") {
            throw new Error(current.initialization.error ?? "Workspace initialization failed.");
        }
        return current.initialization.status === "ready" ? current : undefined;
    }, `${name} checkout to finish`);
    expect(ready.kind).toBe("worktree");
    if (ready.compute.type !== "host") throw new Error("Expected a host checkout.");
    expect(await readFile(join(ready.compute.path, "fixture.txt"), "utf8")).toBe(
        "GitHub workspace fixture\n",
    );
    expect(await gym.events()).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                type: "workspace.created",
                payload: expect.objectContaining({
                    mutationId,
                    workspace: expect.objectContaining({ id: ready.id, parentId }),
                }),
            }),
        ]),
    );
    return ready;
}
