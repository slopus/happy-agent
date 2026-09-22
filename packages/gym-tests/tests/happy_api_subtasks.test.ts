import { join } from "node:path";
import { readFile } from "node:fs/promises";

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
        files: { "marker.txt": "a workspace fixture\n", "second/marker.txt": "another project\n" },
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
            return { content: [{ type: "text", text: "Subtask work settled." }] };
        },
    });
    running.add(gym);
    const bot = (await gym.client.createBot({ name: "Task coordinator" })).bot;
    let callIndex = 0;
    async function call(
        agentId: string,
        name: string,
        args: Record<string, unknown>,
        fromAgentId?: string,
        permissionMode: "auto" | "full_access" = "auto",
    ) {
        const callId = `subtask_test_${++callIndex}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        if (fromAgentId === undefined) {
            await gym.send(`Please execute ${name}, request ${callId}.`, {
                sessionId: agentId,
                permissionMode,
            });
        } else {
            await call(fromAgentId, "send_agent_message", {
                toAgentId: agentId,
                text: `Please execute ${name}, request ${callId}.`,
            });
        }
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    async function create(
        parentId: string,
        title: string,
        workspace?: { projectId: string; name: string },
    ) {
        const result = await call(parentId, "create_subtask", {
            title,
            text: `Work on ${title}.`,
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
            ...(workspace === undefined ? {} : { workspace }),
        });
        expect(result.text).toContain("Created subtask");
        const agent = (await gym.client.getAgentActivity(parentId)).subagents.find(
            (child) => child.title === title,
        );
        expect(agent).toBeDefined();
        return agent!;
    }
    return { gym, bot, call, create, commands };
}

describe("user-interactive subtasks", () => {
    it("runs on the coordinator's selection and reports it as the subtask's mode", async () => {
        const { gym, bot, call } = await harness();
        const result = await call(bot.agent.id, "create_subtask", {
            title: "Second model",
            text: "Work on the second model.",
            model: "gym/model-2",
            effort: "high",
        });
        expect(result.text).toContain("Created subtask");
        const agentId = /Created subtask ([a-z0-9]+)/.exec(result.text)?.[1];
        expect(agentId).toBeDefined();
        const request = await gym.waitUntil(
            async () => gym.inference.requests.find((item) => item.sessionId === agentId),
            "the subtask's first inference",
        );
        expect({ model: request.model, effort: request.effort }).toEqual({
            model: "gym/model-2",
            effort: "high",
        });
        // A person opening the subtask composes on top of this mode. Before it was recorded,
        // clients fell back to the daemon defaults and silently moved the subtask off the
        // model its coordinator chose.
        const mode = {
            effort: "high",
            modelId: "gym/model-2",
            permissionMode: "auto",
            providerId: "gym",
            serviceTier: null,
        };
        expect((await gym.client.getAgentMode(agentId!)).mode).toEqual(mode);
        expect((await gym.client.getAgentBootstrap(agentId!)).mode).toEqual(mode);
        expect((await gym.client.getAgentMode(bot.agent.id)).mode).toMatchObject({
            modelId: gym.selection.modelId,
        });
    });

    it("lets a subtask archive its active direct child and stop that child's inference", async () => {
        const { gym, bot, create, call, commands } = await harness();
        const main = await create(bot.agent.id, "Active coordinator");
        const child = await create(main.id, "Active internal task");
        const marker = "Hold this child inference for archival";
        commands.set(child.id, {
            callId: marker,
            turn: { delayMs: 30_000, content: [{ type: "text", text: "Must not complete" }] },
        });
        const accepted = await gym.send(marker, { sessionId: child.id, wait: false });
        await gym.waitUntil(
            async () =>
                gym.inference.requests.some(
                    (request) =>
                        request.sessionId === child.id &&
                        JSON.stringify(request.messages).includes(marker),
                )
                    ? true
                    : undefined,
            "the child's in-flight inference",
        );
        expect(
            (
                await call(
                    main.id,
                    "archive_subtask",
                    { agentId: child.id },
                    undefined,
                    "full_access",
                )
            ).text,
        ).toContain("Archived subtask");
        expect(await gym.waitForRun(accepted.runId)).toMatchObject({
            type: "run.finished",
            payload: { run: { status: "aborted" } },
        });
        expect((await gym.client.getAgent(child.id)).agent).toMatchObject({
            archivedAt: expect.any(Number),
            status: "idle",
            canSendMessages: false,
        });
        expect((await gym.client.getAgent(main.id)).agent).toMatchObject({
            archivedAt: null,
            subtasks: [],
        });
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("includes the complete active subtask tree in bootstrap and every full agent read", async () => {
        const { gym, bot, create, call } = await harness();
        const project = (await gym.client.listProjects()).projects.find((item) =>
            item.agents.some((agent) => agent.id === gym.defaultSessionId),
        )!;
        const main = await create(bot.agent.id, "Main tree task");
        const internal = await create(main.id, "Workspace tree task", {
            projectId: project.id,
            name: "Tree workspace",
        });
        const sibling = await create(bot.agent.id, "Shared sibling");
        await call(bot.agent.id, "create_agent", {
            title: "Hidden researcher",
            text: "Research internally",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        });
        const bootstrap = await gym.client.getDesktopBootstrap();
        const root = bootstrap.bots!.find((item) => item.id === bot.id)!.agent;
        expect(root.subtasks?.map((item) => item.id)).toEqual([sibling.id, main.id]);
        expect(root.subtasks?.[1]?.subtasks).toEqual([
            expect.objectContaining({
                id: internal.id,
                parentAgentId: main.id,
                workspaceId: internal.workspaceId,
                subtasks: [],
            }),
        ]);
        expect(
            (await gym.client.getAgentBootstrap(bot.agent.id)).agent.subtasks?.map(
                (item) => item.id,
            ),
        ).toEqual([sibling.id, main.id]);
        expect(
            (await gym.client.getWorkspace(internal.workspaceId)).workspace.agents[0],
        ).toMatchObject({ id: internal.id, subtasks: [] });
        expect((await gym.client.getAgentActivity(bot.agent.id)).subagents).toContainEqual(
            expect.objectContaining({ title: "Hidden researcher", subtask: false, subtasks: [] }),
        );
        await gym.client.archiveAgent(main.id);
        expect(
            (await gym.client.getAgent(bot.agent.id)).agent.subtasks?.map((item) => item.id),
        ).toEqual([sibling.id]);
        expect((await gym.client.getAgent(internal.id)).agent.archivedAt).toBeNull();
        await gym.client.unarchiveAgent(main.id);
        await gym.restart();
        expect(
            (await gym.client.getDesktopBootstrap()).bots!.find((item) => item.id === bot.id)?.agent
                .subtasks?.[1]?.subtasks?.[0]?.id,
        ).toBe(internal.id);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("lets only the direct coordinator archive a subtask without deleting its workspace or descendants", async () => {
        const { gym, bot, create, call } = await harness();
        const project = (await gym.client.listProjects()).projects.find((item) =>
            item.agents.some((agent) => agent.id === gym.defaultSessionId),
        )!;
        const task = await create(bot.agent.id, "Archivable task", {
            projectId: project.id,
            name: "Keep task workspace",
        });
        await gym.waitUntil(
            async () =>
                (await gym.client.getWorkspace(task.workspaceId)).workspace.initialization
                    .status === "ready"
                    ? true
                    : undefined,
            "task workspace readiness",
        );
        const internal = await create(task.id, "Independent child");
        const other = (await gym.client.createBot({ name: "Other coordinator" })).bot;
        for (const actorId of [gym.defaultSessionId, other.agent.id, task.id]) {
            expect(
                (
                    await call(
                        actorId,
                        "archive_subtask",
                        { agentId: task.id },
                        undefined,
                        "full_access",
                    )
                ).text,
            ).not.toContain("Archived subtask");
            expect((await gym.client.getAgent(task.id)).agent.archivedAt).toBeNull();
        }
        expect(
            (
                await call(
                    bot.agent.id,
                    "archive_subtask",
                    { agentId: task.id },
                    undefined,
                    "full_access",
                )
            ).text,
        ).toContain("Archived subtask");
        const archived = (await gym.client.getAgent(task.id)).agent;
        expect(archived).toMatchObject({ canSendMessages: false, archivedAt: expect.any(Number) });
        expect((await gym.client.getAgent(bot.agent.id)).agent.subtasks).toEqual([]);
        expect((await gym.client.getAgent(internal.id)).agent.archivedAt).toBeNull();
        expect((await gym.client.getWorkspace(task.workspaceId)).workspace).toMatchObject({
            status: "active",
            subtaskAgentId: task.id,
            agents: [],
        });
        await expect(gym.send("Not while archived", { sessionId: task.id })).rejects.toMatchObject({
            status: 409,
        });
        expect(
            (
                await call(
                    bot.agent.id,
                    "archive_subtask",
                    { agentId: task.id },
                    undefined,
                    "full_access",
                )
            ).text,
        ).toContain("Archived subtask");
        expect((await gym.client.getAgent(task.id)).agent.archivedAt).toBe(archived.archivedAt);
        await gym.restart();
        expect((await gym.client.getAgent(task.id)).agent.archivedAt).toBe(archived.archivedAt);
        await gym.client.unarchiveAgent(task.id);
        await gym.send("Continue after restoration", { sessionId: task.id });
        expect((await gym.client.getAgent(bot.agent.id)).agent.subtasks?.[0]?.id).toBe(task.id);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("guides bots and subtasks to prefer interactive delegation and honor explicit requests", async () => {
        const { gym, bot, create } = await harness();
        const task = await create(bot.agent.id, "Prompt task");
        await gym.send("Review your delegation guidance", { sessionId: task.id });
        for (const id of [bot.agent.id, task.id]) {
            const instructions = gym.inference.requests.find(
                (request) => request.sessionId === id,
            )!.instructions;
            expect(instructions).toContain("Prefer create_subtask by default");
            expect(instructions).toContain(
                "If the user explicitly asks for a subtask, use create_subtask",
            );
            expect(instructions).toContain("internal research");
            expect(instructions).toContain("archive_subtask");
        }
    }, 60_000);

    it("runs file tools in the selected workspace and shares that filesystem with an internal subtask", async () => {
        const { gym, bot, create, call } = await harness();
        const project = (await gym.client.listProjects()).projects.find((item) =>
            item.agents.some((agent) => agent.id === gym.defaultSessionId),
        )!;
        const task = await create(bot.agent.id, "Workspace writer", {
            projectId: project.id,
            name: "Task files",
        });
        await gym.waitUntil(
            async () =>
                (await gym.client.getWorkspace(task.workspaceId)).workspace.initialization
                    .status === "ready"
                    ? true
                    : undefined,
            "workspace readiness",
        );
        const workspace = (await gym.client.getWorkspace(task.workspaceId)).workspace;
        if (workspace.compute.type !== "host") throw new Error("Expected a host workspace");
        expect(
            (
                await call(task.id, "exec_command", {
                    cmd: "printf 'workspace subtask\\n' > task-output.txt",
                })
            ).text,
        ).not.toContain("Error");
        expect(await readFile(join(workspace.compute.path, "task-output.txt"), "utf8")).toBe(
            "workspace subtask\n",
        );
        await expect(
            readFile(join(gym.workspacePath, "task-output.txt"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const internal = await create(task.id, "Internal reader");
        expect(
            (await call(internal.id, "exec_command", { cmd: "cat task-output.txt" })).text,
        ).toContain("workspace subtask");
        expect(
            (await gym.client.getWorkspace(task.workspaceId)).workspace.agents.map(
                (agent) => agent.id,
            ),
        ).toEqual([task.id]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("rejects unavailable models without leaving an agent or workspace behind", async () => {
        const { gym, bot, call } = await harness();
        const project = (await gym.client.listProjects()).projects.find((item) =>
            item.agents.some((agent) => agent.id === gym.defaultSessionId),
        )!;
        const before = (await gym.client.listWorkspaces({ includeArchived: true })).workspaces.map(
            (workspace) => workspace.id,
        );
        const result = await call(bot.agent.id, "create_subtask", {
            title: "Invalid model",
            text: "Never start",
            model: "unavailable-model",
            effort: "high",
            workspace: { projectId: project.id, name: "Must not exist" },
        });
        expect(result.text).toContain("not available");
        expect((await gym.client.getAgentActivity(bot.agent.id)).subagents).toEqual([]);
        expect(
            (await gym.client.listWorkspaces({ includeArchived: true })).workspaces.map(
                (workspace) => workspace.id,
            ),
        ).toEqual(before);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("shares the bot filesystem, accepts user interaction, and preserves archival across restart", async () => {
        const { gym, bot, create, call } = await harness();
        const task = await create(bot.agent.id, "Main task");
        expect(task).toMatchObject({
            subtask: true,
            parentAgentId: bot.agent.id,
            workspaceId: bot.workspaceId,
            userVisible: true,
            managedByAnotherAgent: true,
            canSendMessages: true,
            orderKey: null,
        });
        expect(
            (await gym.client.getWorkspace(bot.workspaceId)).workspace.agents.map(
                (agent) => agent.id,
            ),
        ).toEqual([bot.agent.id]);
        await gym.send("A human follow-up for the task.", { sessionId: task.id });
        expect(
            gym.inference.requests.some(
                (request) =>
                    request.sessionId === task.id &&
                    JSON.stringify(request.messages).includes("A human follow-up"),
            ),
        ).toBe(true);
        await expect(gym.client.markAgentRead(task.id)).resolves.toMatchObject({
            agent: { subtask: true, unread: null },
        });
        await expect(gym.client.reorderAgent(task.id, { afterId: null })).rejects.toMatchObject({
            status: 409,
        });
        await gym.client.saveAgentDraft(task.id, {
            draft: {
                text: "Continue here",
                providerId: gym.selection.providerId,
                modelId: gym.selection.modelId,
                effort: gym.selection.effort,
                serviceTier: null,
                permissionMode: "auto",
            },
        });
        const archived = (await gym.client.archiveAgent(task.id)).agent;
        expect(archived.archivedAt).not.toBeNull();
        expect(archived.canSendMessages).toBe(false);
        await expect(gym.send("Not while archived", { sessionId: task.id })).rejects.toMatchObject({
            status: 409,
        });
        expect(
            (
                await call(bot.agent.id, "send_agent_message", {
                    toAgentId: task.id,
                    text: "Not through the parent either",
                })
            ).text,
        ).toContain("archived");
        await gym.restart();
        expect((await gym.client.getAgent(task.id)).agent).toMatchObject({
            subtask: true,
            parentAgentId: bot.agent.id,
            archivedAt: archived.archivedAt,
            canSendMessages: false,
        });
        await expect(gym.client.getAgentDraft(task.id)).resolves.toMatchObject({
            draft: { value: { text: "Continue here" } },
        });
        expect((await gym.client.unarchiveAgent(task.id)).agent.canSendMessages).toBe(true);
        await gym.send("Resume with your history.", { sessionId: task.id });
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("limits depth to two while allowing three siblings and rejecting ordinary-agent creation", async () => {
        const { gym, bot, create, call } = await harness();
        const main = await create(bot.agent.id, "Main task");
        const children = [];
        for (const title of ["Build app", "Deploy server", "Deploy app"])
            children.push(await create(main.id, title));
        expect(children).toHaveLength(3);
        expect(
            children.every(
                (child) =>
                    child.parentAgentId === main.id &&
                    child.workspaceId === bot.workspaceId &&
                    child.subtask,
            ),
        ).toBe(true);
        const request = {
            title: "Not allowed",
            text: "No third level",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        };
        expect((await call(children[0]!.id, "create_subtask", request)).text).toContain(
            "two levels",
        );
        expect((await gym.client.getAgentActivity(children[0]!.id)).subagents).toEqual([]);
        expect((await call(gym.defaultSessionId, "create_subtask", request)).text).toContain(
            "Only a bot or another subtask",
        );
        expect((await gym.client.getAgentActivity(gym.defaultSessionId)).subagents).toEqual([]);
        const ordinary = await call(bot.agent.id, "create_agent", {
            ...request,
            title: "Ordinary collaborator",
        });
        expect(ordinary.text).toContain("Created collaborator");
        const hidden = (await gym.client.getAgentActivity(bot.agent.id)).subagents.find(
            (agent) => agent.title === "Ordinary collaborator",
        )!;
        expect(hidden).toMatchObject({
            subtask: false,
            userVisible: false,
            canSendMessages: false,
        });
        await expect(
            gym.send("Hidden stays hidden", { sessionId: hidden.id }),
        ).rejects.toMatchObject({ status: 409 });
        expect((await call(hidden.id, "create_subtask", request, bot.agent.id)).text).toContain(
            "Only a bot or another subtask",
        );
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("coordinates separate project workspaces and lets a workspace subtask share its filesystem", async () => {
        const { gym, bot, create } = await harness();
        const project = (await gym.client.listProjects()).projects.find((item) =>
            item.agents.some((agent) => agent.id === gym.defaultSessionId),
        )!;
        const second = (
            await gym.client.registerProject({ path: join(gym.workspacePath, "second") })
        ).project;
        const task = await create(bot.agent.id, "Build app", {
            projectId: project.id,
            name: "Build app task",
        });
        const peer = await create(bot.agent.id, "Deploy server", {
            projectId: second.id,
            name: "Deploy server task",
        });
        for (const [agent, projectId] of [
            [task, project.id],
            [peer, second.id],
        ] as const) {
            const workspace = await gym.waitUntil(async () => {
                const current = (await gym.client.getWorkspace(agent.workspaceId)).workspace;
                if (current.initialization.status === "failed")
                    throw new Error(current.initialization.error ?? "Workspace setup failed");
                return current.initialization.status === "ready" ? current : undefined;
            }, "the subtask workspace to be ready");
            expect(workspace).toMatchObject({
                projectId,
                parentId: projectId,
                subtaskAgentId: agent.id,
                creatorAgentId: bot.agent.id,
            });
            expect(workspace.agents).toHaveLength(1);
            expect(workspace.agents[0]).toMatchObject({
                id: agent.id,
                subtask: true,
                canSendMessages: true,
            });
            expect(workspace.compute.type).toBe("host");
            if (workspace.compute.type === "host")
                expect(await readFile(join(workspace.compute.path, "marker.txt"), "utf8")).toBe(
                    projectId === project.id ? "a workspace fixture\n" : "another project\n",
                );
        }
        expect(task.workspaceId).not.toBe(peer.workspaceId);
        const internal = await create(task.id, "Review app");
        expect(internal).toMatchObject({
            workspaceId: task.workspaceId,
            parentAgentId: task.id,
            subtask: true,
            orderKey: null,
        });
        expect((await gym.client.getWorkspace(task.workspaceId)).workspace.subtaskAgentId).toBe(
            task.id,
        );
        await gym.send("A human can guide the workspace task.", { sessionId: task.id });
        await gym.client.archiveAgent(task.id);
        const retained = (await gym.client.getWorkspace(task.workspaceId)).workspace;
        expect(retained.status).toBe("active");
        expect(retained.subtaskAgentId).toBe(task.id);
        expect(retained.agents).toEqual([]);
        await gym.restart();
        expect((await gym.client.getWorkspace(task.workspaceId)).workspace.subtaskAgentId).toBe(
            task.id,
        );
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
