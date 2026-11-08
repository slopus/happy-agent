import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A subtask placed in a copied folder, whose project Git cannot make a worktree of, is told there
 * is nothing to commit to: never `git init`, never commit, and never ask to leave the sandbox for
 * either, even when its brief says to commit. A subtask in a Git worktree hears nothing of it.
 */

const execFile = promisify(execFileCallback);
const running = new Set<AgentGym>();
const RULE = "Never run git init in it or commit, even when a brief asks you to commit";

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A coordinator that opens one workspace subtask in `project()` and briefs it to commit. */
async function subtaskIn(project: (gym: AgentGym) => Promise<string>) {
    let coordinatorId = "";
    let projectId = "";
    let requested = false;
    const gym = await createAgentGym({
        files: { "notes.txt": "A plain folder with no repository.\n" },
        inference: (request) => {
            if (request.sessionId === coordinatorId && !requested) {
                requested = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_subtask",
                            callId: "open-subtask",
                            arguments: {
                                title: "Build it",
                                text: "Build the tool, then commit the work on your workspace branch when done.",
                                model: "gym/model",
                                effort: "high",
                                provider: "gym",
                                workspace: { projectId, name: "Build it" },
                            },
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.add(gym);
    projectId = await project(gym);
    coordinatorId = (await gym.client.createBot({ name: "Coordinator" })).bot.agent.id;
    await gym.send("Open the subtask.", { sessionId: coordinatorId });
    const child = await gym.waitUntil(
        async () =>
            (await gym.client.getAgentActivity(coordinatorId)).subagents.find(
                (agent) => agent.title === "Build it",
            ),
        "the subtask",
    );
    const { workspace } = await gym.waitUntil(async () => {
        const found = await gym.client.getWorkspace(child.workspaceId!);
        return found.workspace.initialization.status === "ready" ? found : undefined;
    }, "the subtask's workspace to be ready");
    const request = await gym.waitUntil(
        () => gym.inference.requests.find((item) => item.sessionId === child.id),
        "the subtask to reach inference",
    );
    return { gym, workspace, request };
}

describe("A workspace subtask and commits", () => {
    it("in a copied folder is told never to git init or commit, nor to leave the sandbox for it", async () => {
        const { gym, workspace, request } = await subtaskIn(async (gym) => {
            const project = await gym.waitUntil(async () => {
                const { projects } = await gym.client.listProjects();
                return projects.find(
                    (candidate) =>
                        candidate.initialization.status === "ready" &&
                        candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
                );
            }, "the plain folder's project");
            return project.id;
        });
        expect(workspace.kind).toBe("copy");
        expect(request.instructions).toContain(RULE);
        expect(request.instructions).toContain(
            "never ask to leave the sandbox for either: leave the files where they are",
        );
        expect(gym.errors).toEqual([]);
    });

    it("in a Git worktree hears nothing of it", async () => {
        const { gym, workspace, request } = await subtaskIn(async (gym) => {
            const repository = join(dirname(gym.workspacePath), "repository");
            await mkdir(repository, { recursive: true });
            await writeFile(join(repository, "README.md"), "A repository.\n");
            for (const args of [
                ["init", "--initial-branch=main"],
                ["add", "README.md"],
                [
                    "-c",
                    "user.name=Gym",
                    "-c",
                    "user.email=gym@example.invalid",
                    "commit",
                    "-m",
                    "initial",
                ],
            ]) {
                await execFile("git", args, { cwd: repository });
            }
            const { project } = await gym.client.registerProject({ path: repository });
            await gym.waitUntil(async () => {
                const found = (await gym.client.getProject(project.id)).project;
                return found.initialization.status === "ready" ? found : undefined;
            }, "the repository's project");
            return project.id;
        });
        expect(workspace.kind).toBe("worktree");
        expect(request.instructions).not.toContain(RULE);
        expect(gym.errors).toEqual([]);
    });
});
