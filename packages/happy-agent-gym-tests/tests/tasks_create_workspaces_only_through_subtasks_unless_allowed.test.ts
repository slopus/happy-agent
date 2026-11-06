import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const ONLY_THROUGH_SUBTASKS =
    "create_subtask with workspace: { projectId, name } is the only way this task gets a project workspace";
const PREFER_SUBTASKS = "Strongly prefer doing repository work in workspace-bound subtasks";

async function harness(config?: string) {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        files: { "marker.txt": "a workspace fixture\n" },
        timeoutMs: 20_000,
        ...(config === undefined ? {} : { config }),
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
        const callId = `task_workspace_call_${++callIndex}`;
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
    const lastRequest = (agentId: string) =>
        gym.inference.requests.filter((request) => request.sessionId === agentId).at(-1);
    const offered = (agentId: string): readonly string[] =>
        lastRequest(agentId)?.tools.map((tool) => tool.name) ?? [];
    const bot = (await gym.client.createBot({ name: "Coordinator" })).bot;
    const project = await gym.waitUntil(async () => {
        const { projects } = await gym.client.listProjects();
        const root = projects.find((candidate) =>
            candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
        );
        return root?.initialization.status === "ready" ? root : undefined;
    }, "the root project to be ready");
    await call(bot.agent.id, "create_task", { name: "Ship release" });
    const task = (await gym.client.listTasks()).tasks[0]!;
    const names = async () =>
        (await gym.client.listWorkspaces({ projectId: project.id })).workspaces.map(
            (workspace) => workspace.name,
        );
    return { gym, call, lastRequest, offered, bot, project, task, names };
}

describe("tasks create project workspaces through subtasks unless the installation allows more", () => {
    it("hides and refuses create_workspace for a task and its subtasks by default, but not for a bot", async () => {
        const { gym, call, lastRequest, offered, bot, project, task, names } = await harness();

        // The task is not offered the tool, and a call made anyway creates nothing.
        const direct = await call(task.agent.id, "create_workspace", {
            projectRef: project.id,
            name: "Escape hatch",
        });
        expect(direct.text).toBe('Tool "create_workspace" is not available.');
        expect(offered(task.agent.id)).not.toContain("create_workspace");
        expect(offered(task.agent.id)).toContain("create_subtask");
        expect(lastRequest(task.agent.id)?.instructions).toContain(ONLY_THROUGH_SUBTASKS);
        expect(await names()).not.toContain("Escape hatch");

        // A workspace-bound subtask is the way in, and the subtask cannot open another one.
        const created = await call(task.agent.id, "create_subtask", {
            title: "Release notes",
            text: "Draft the release notes.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
            workspace: { projectId: project.id, name: "Release notes" },
        });
        expect(created.text).toContain("Created subtask");
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created.text)![1]!;
        const subtask = (await gym.client.getAgent(subtaskId)).agent;
        expect(subtask.workspaceId).not.toBe(task.workspaceId);
        expect((await gym.client.getWorkspace(subtask.workspaceId!)).workspace).toMatchObject({
            projectId: project.id,
            subtaskAgentId: subtaskId,
        });
        const fromSubtask = await call(subtaskId, "create_workspace", {
            projectRef: project.id,
            name: "Subtask escape",
        });
        expect(fromSubtask.text).toBe('Tool "create_workspace" is not available.');
        expect(offered(subtaskId)).not.toContain("create_workspace");
        expect(await names()).not.toContain("Subtask escape");

        // A bot and a person's own project conversation keep creating workspaces directly.
        const fromBot = await call(bot.agent.id, "create_workspace", {
            projectRef: project.id,
            name: "Bot workspace",
        });
        expect(offered(bot.agent.id)).toContain("create_workspace");
        expect(fromBot.text).toContain("Workspace created");
        const fromProject = await call(gym.defaultSessionId, "create_workspace", {
            projectRef: project.id,
            name: "Project workspace",
        });
        expect(fromProject.text).toContain("Workspace created");

        expect(gym.errors).toEqual([]);
    }, 120_000);

    it("lets a task create workspaces directly when the installation allows it", async () => {
        const { gym, call, lastRequest, offered, bot, project, task, names } = await harness(
            "[settings]\ntasks_create_workspaces = true\n",
        );

        const direct = await call(task.agent.id, "create_workspace", {
            projectRef: project.id,
            name: "Task workspace",
        });
        expect(direct.text).toContain("Workspace created");
        expect(offered(task.agent.id)).toContain("create_workspace");
        expect(lastRequest(task.agent.id)?.instructions).toContain(PREFER_SUBTASKS);
        expect(lastRequest(task.agent.id)?.instructions).not.toContain(ONLY_THROUGH_SUBTASKS);
        expect(await names()).toContain("Task workspace");

        const fromBot = await call(bot.agent.id, "create_workspace", {
            projectRef: project.id,
            name: "Bot workspace",
        });
        expect(offered(bot.agent.id)).toContain("create_workspace");
        expect(fromBot.text).toContain("Workspace created");

        expect(gym.errors).toEqual([]);
    }, 120_000);
});
