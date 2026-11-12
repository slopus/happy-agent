import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const MISSING_BASE = "no-such-branch";

async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        files: { "marker.txt": "a workspace fixture\n" },
        timeoutMs: 20_000,
        inference: (request) => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `workspace_failure_call_${++callIndex}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "auto",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            `the ${name} result`,
        );
    }
    const bot = (await gym.client.createBot({ name: "Coordinator" })).bot;
    // Only a Git project resolves a base, so a base that names nothing fails in the background.
    const repository = join(dirname(gym.workspacePath), "repository");
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "fixture.txt"), "a Git fixture\n");
    for (const args of [
        ["init", "--initial-branch=main"],
        ["config", "user.email", "gym@example.invalid"],
        ["config", "user.name", "Workspace Gym"],
        ["add", "."],
        ["commit", "-m", "fixture"],
    ]) {
        await execFile("git", args, { cwd: repository });
    }
    const { project: registered } = await gym.client.registerProject({ path: repository });
    const project = await gym.waitUntil(async () => {
        const { project: current } = await gym.client.getProject(registered.id);
        if (current.initialization.status === "failed") {
            throw new Error(current.initialization.error ?? "The Git project failed to set up.");
        }
        return current.initialization.status === "ready" ? current : undefined;
    }, "the Git project to be ready");
    /** The first request in which the agent's model is shown text containing `needle`. */
    const notice = async (agentId: string, needle: string) =>
        await gym.waitUntil(
            async () =>
                gym.inference.requests.find(
                    (request) =>
                        request.sessionId === agentId &&
                        JSON.stringify(request.messages).includes(needle),
                ),
            `a notice for ${agentId} mentioning ${needle}`,
        );
    const failedWorkspace = async (name: string) =>
        await gym.waitUntil(async () => {
            const { workspaces } = await gym.client.listWorkspaces({ projectId: project.id });
            const workspace = workspaces.find((candidate) => candidate.name === name);
            return workspace?.initialization.status === "failed" ? workspace : undefined;
        }, `the workspace ${name} to fail`);
    return { gym, call, bot, project, notice, failedWorkspace };
}

describe("agents learn when a workspace they created fails", () => {
    it("tells a coordinator its subtask's workspace failed and the subtask will not start", async () => {
        const { gym, call, bot, project, notice, failedWorkspace } = await harness();

        const created = await call(bot.agent.id, "create_subtask", {
            title: "Broken base",
            text: "Work from a base that does not exist.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
            workspace: { projectId: project.id, name: "Broken base", baseRef: MISSING_BASE },
        });
        expect(created.text).toContain("Created subtask");
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created.text)![1]!;

        const workspace = await failedWorkspace("Broken base");
        expect(workspace.subtaskAgentId).toBe(subtaskId);
        const told = await notice(bot.agent.id, `could not be created`);
        const text = JSON.stringify(told.messages);
        expect(text).toContain(workspace.id);
        expect(text).toContain(MISSING_BASE);
        expect(text).toContain(subtaskId);
        expect(gym.inference.requests.some((request) => request.sessionId === subtaskId)).toBe(
            false,
        );
        expect(gym.errors).toEqual([]);
    }, 120_000);

    it("tells an agent the workspace it created directly failed", async () => {
        const { gym, call, bot, project, notice, failedWorkspace } = await harness();

        const created = await call(bot.agent.id, "create_workspace", {
            projectRef: project.id,
            name: "Direct broken base",
            baseRef: MISSING_BASE,
        });
        expect(created.text).toContain("Workspace created");

        const workspace = await failedWorkspace("Direct broken base");
        const told = await notice(bot.agent.id, `could not be created`);
        const text = JSON.stringify(told.messages);
        expect(text).toContain(workspace.id);
        expect(text).toContain(MISSING_BASE);
        expect(gym.errors).toEqual([]);
    }, 120_000);

    it("answers a subtask request for a missing project with a tool error and creates nothing", async () => {
        const { gym, call, bot } = await harness();

        const created = await call(bot.agent.id, "create_subtask", {
            title: "Nowhere",
            text: "Work in a project that does not exist.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
            workspace: { projectId: "nosuchproject0000000000000", name: "Nowhere" },
        });
        expect(created.text).not.toContain("Created subtask");
        expect(created.text).toContain("project was not found");
        expect(
            (await gym.client.getAgentActivity(bot.agent.id)).subagents.some(
                (child) => child.title === "Nowhere",
            ),
        ).toBe(false);
    }, 120_000);
});
