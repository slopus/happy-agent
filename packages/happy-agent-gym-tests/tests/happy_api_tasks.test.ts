import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
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
            return { content: [{ type: "text", text: "Task work settled." }] };
        },
    });
    running.add(gym);
    const bot = (await gym.client.createBot({ name: "Task coordinator" })).bot;
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `task_test_${++callIndex}`;
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
            "the tool result",
        );
    }
    return { gym, bot, call };
}

describe("tasks over the API", () => {
    it("shows a bot's new task in the lists and bootstrap, and opens its conversation", async () => {
        const { gym, bot, call } = await harness();
        const before = (await gym.client.getEvents()).latestCursor;
        const result = await call(bot.agent.id, "create_task", {
            name: "Fix login redirect",
            text: "The login page loops back to itself.",
        });
        expect(result.text).toContain("Task created: Fix login redirect");

        const { tasks, memberships } = await gym.client.listTasks();
        expect(tasks).toHaveLength(1);
        const task = tasks[0]!;
        expect(task).toMatchObject({
            name: "Fix login redirect",
            folderName: "fix_login_redirect",
            creatorAgentId: bot.agent.id,
            ownerUserId: null,
            status: "active",
            canArchive: true,
            agent: { userVisible: true, managedByAnotherAgent: false, orderKey: null },
        });
        // The installation's one person joins the task when it is created.
        expect(memberships).toEqual([
            {
                taskId: task.id,
                userId: null,
                orderKey: expect.any(String),
                joinedAt: expect.any(Number),
            },
        ]);
        expect(
            (await gym.client.listTasks({ scope: "joined" })).tasks.map((item) => item.id),
        ).toEqual([task.id]);
        const bootstrap = await gym.client.getDesktopBootstrap();
        expect(bootstrap.tasks?.map((item) => item.id)).toEqual([task.id]);
        expect(bootstrap.taskMemberships).toEqual(memberships);

        // The opening message starts the task's own conversation.
        await gym.waitUntil(
            async () =>
                gym.inference.requests.find((request) => request.sessionId === task.agent.id),
            "the task's first inference",
        );
        const { agent } = await gym.client.getAgent(task.agent.id);
        expect(agent.workspaceId).toBe(task.workspaceId);
        expect(agent.canSendMessages).toBe(true);
        expect((await gym.client.getAgentBootstrap(task.agent.id)).agent.id).toBe(task.agent.id);

        const types = (await gym.client.getEvents({ after: before })).events
            .map((event) => event.type)
            .filter((type) => type.startsWith("task."));
        expect(types).toEqual(["task.created", "task.joined"]);
    });

    it("roots subtasks at the task and keeps leave separate from archive", async () => {
        const { gym, bot, call } = await harness();
        await call(bot.agent.id, "create_task", { name: "Ship release" });
        const task = (await gym.client.listTasks()).tasks[0]!;

        const created = await call(task.agent.id, "create_subtask", {
            title: "Release notes",
            text: "Draft the release notes.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        });
        expect(created.text).toContain("Created subtask");
        const root = (await gym.client.getAgent(task.agent.id)).agent;
        expect(root.subtasks?.map((subtask) => subtask.title)).toEqual(["Release notes"]);
        expect(root.subtasks?.[0]?.workspaceId).toBe(task.workspaceId);

        // Leaving takes the task out of the list without archiving it.
        const left = await gym.client.leaveTask(task.id);
        expect(left).toMatchObject({ membership: null, task: { status: "active" } });
        expect((await gym.client.listTasks({ scope: "joined" })).tasks).toEqual([]);
        await gym.client.joinTask(task.id);

        // The agent's own lifecycle belongs to the task.
        await expect(gym.client.archiveAgent(task.agent.id, {})).rejects.toMatchObject({
            status: 409,
        });
        const archived = await gym.client.archiveTask(task.id, { ifMatch: task.version });
        expect(archived.task.status).toBe("archived");
        expect(archived.task.agent.canSendMessages).toBe(false);
        expect(archived.membership?.taskId).toBe(task.id);
        const restored = await gym.client.unarchiveTask(task.id, {
            ifMatch: archived.task.version,
        });
        expect(restored.task.status).toBe("active");
        expect(restored.task.agent.canSendMessages).toBe(true);
    });
});
