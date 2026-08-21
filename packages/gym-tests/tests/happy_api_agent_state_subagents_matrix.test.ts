import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type Scenario = {
    readonly id: string;
    readonly options?: Parameters<typeof createAgentGym>[0];
    readonly run: (gym: AgentGym) => Promise<void>;
};

const gyms = new Set<AgentGym>();

describe("public agent state and subagent matrix", () => {
    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it.each<Scenario>([
        {
            id: "AS-001-direct-agent-creation-is-top-level",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createTopLevel(gym, project.id, "statedirecttoplevel");
                expect(agent.parentAgentId).toBeNull();
                expect(agent.workspaceId).toBe(project.id);
            },
        },
        {
            id: "AS-002-a-child-workspace-has-an-independent-top-level-series",
            run: async (gym) => {
                const project = await rootProject(gym);
                const child = await createChildWorkspace(gym, project.id, "state-child-series");
                const agent = await createTopLevel(gym, child.id, "statechildtoplevel");
                expect(
                    (await gym.client.getProject(project.id)).project.agents.map(
                        (candidate) => candidate.id,
                    ),
                ).not.toContain(agent.id);
                expect(
                    (await gym.client.getWorkspace(child.id)).workspace.agents.map(
                        (candidate) => candidate.id,
                    ),
                ).toContain(agent.id);
            },
        },
        {
            id: "AS-003-exposes-a-subagent-with-its-parent-agent-id",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                expect(subagent.parentAgentId).toBe(gym.defaultSessionId);
                expect(subagent.id).not.toBe(gym.defaultSessionId);
            },
        },
        {
            id: "AS-004-excludes-a-subagent-from-the-project-agent-series",
            options: subagentOptions(),
            run: async (gym) => {
                const project = await rootProject(gym);
                const subagent = await spawnSubagent(gym);
                expect(
                    (await gym.client.getProject(project.id)).project.agents.map(
                        (candidate) => candidate.id,
                    ),
                ).not.toContain(subagent.id);
            },
        },
        {
            id: "AS-005-excludes-a-subagent-from-the-workspace-agent-series",
            options: subagentOptions(),
            run: async (gym) => {
                const workspace = (await gym.client.getWorkspace((await rootProject(gym)).id))
                    .workspace;
                const subagent = await spawnSubagent(gym);
                expect(workspace.agents.map((candidate) => candidate.id)).not.toContain(
                    subagent.id,
                );
            },
        },
        {
            id: "AS-006-keeps-a-subagent-readable-by-its-resource-id",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await expect(gym.client.getAgent(subagent.id)).resolves.toMatchObject({
                    agent: {
                        id: subagent.id,
                        parentAgentId: gym.defaultSessionId,
                    },
                });
            },
        },
        {
            id: "AS-007-rejects-marking-a-subagent-read",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await expect(gym.client.markAgentRead(subagent.id)).rejects.toMatchObject({
                    code: "conflict",
                    status: 409,
                });
            },
        },
        {
            id: "AS-008-rejects-reordering-a-subagent",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await expect(
                    gym.client.reorderAgent(subagent.id, {
                        afterId: null,
                        mutationId: "as-008",
                    }),
                ).rejects.toMatchObject({ code: "conflict", status: 409 });
            },
        },
        {
            id: "AS-009-rejects-saving-a-subagent-draft",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await expect(
                    gym.client.saveAgentDraft(subagent.id, {
                        draft: draft("forbidden"),
                        mutationId: "as-009",
                    }),
                ).rejects.toMatchObject({ code: "conflict", status: 409 });
            },
        },
        {
            id: "AS-010-rejects-archiving-a-subagent",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await expect(
                    gym.client.archiveAgent(subagent.id, { mutationId: "as-010" }),
                ).rejects.toMatchObject({ code: "conflict", status: 409 });
            },
        },
        {
            id: "AS-011-rejects-unarchiving-a-subagent",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await expect(
                    gym.client.unarchiveAgent(subagent.id, { mutationId: "as-011" }),
                ).rejects.toMatchObject({ code: "conflict", status: 409 });
            },
        },
        {
            id: "AS-012-rejects-sending-to-a-subagent-through-the-catalog-api",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await expect(
                    gym.client.sendMessage(subagent.id, {
                        mode: modeFor(gym),
                        text: "forbidden",
                    }),
                ).rejects.toMatchObject({ code: "conflict", status: 409 });
            },
        },
        {
            id: "AS-013-reports-the-subagent-in-parent-activity",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
                expect(activity.subagents).toContainEqual(
                    expect.objectContaining({ id: subagent.id }),
                );
            },
        },
        {
            id: "AS-014-updates-parent-subagent-counters-after-completion",
            options: subagentOptions(),
            run: async (gym) => {
                await spawnSubagent(gym);
                const parent = await gym.waitUntil(async () => {
                    const current = (await gym.client.getAgent(gym.defaultSessionId)).agent;
                    return current.subagents.total >= 1 && current.subagents.running === 0
                        ? current
                        : undefined;
                }, "the completed subagent counters to settle");
                expect(parent.subagents.total).toBeGreaterThanOrEqual(1);
                expect(parent.subagents.running).toBe(0);
            },
        },
        {
            id: "AS-015-includes-subagent-work-in-parent-usage",
            options: subagentOptions(),
            run: async (gym) => {
                await spawnSubagent(gym);
                const usage = await gym.client.getAgentUsage(gym.defaultSessionId);
                expect(usage.usage).toBeDefined();
                expect(JSON.stringify(usage.usage)).toContain("gym");
            },
        },
        {
            id: "AS-016-assigns-two-subagents-distinct-identities",
            options: subagentOptionsForTwoChildren(),
            run: async (gym) => {
                await gym.send("create two collaborators");
                const activity = await gym.waitUntil(async () => {
                    const current = await gym.client.getAgentActivity(gym.defaultSessionId);
                    return current.subagents.length >= 2 ? current : undefined;
                }, "two subagents");
                expect(new Set(activity.subagents.map((agent) => agent.id)).size).toBe(2);
                expect(
                    activity.subagents.every(
                        (agent) => agent.parentAgentId === gym.defaultSessionId,
                    ),
                ).toBe(true);
            },
        },
        {
            id: "AS-017-keeps-top-level-and-subagent-ancestry-separate",
            options: subagentOptions(),
            run: async (gym) => {
                const project = await rootProject(gym);
                const topLevel = await createTopLevel(gym, project.id, "stateseparatetoplevel");
                const subagent = await spawnSubagent(gym);
                expect(topLevel.parentAgentId).toBeNull();
                expect(topLevel.orderKey).toEqual(expect.any(String));
                expect(subagent.parentAgentId).toBe(gym.defaultSessionId);
                expect(subagent.orderKey).toBeNull();
                expect(subagent.workspaceId).toBe(topLevel.workspaceId);
            },
        },
        {
            id: "AS-018-preserves-subagent-resource-and-activity-after-restart",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                await gym.restart();
                await expect(gym.client.getAgent(subagent.id)).resolves.toMatchObject({
                    agent: {
                        id: subagent.id,
                        parentAgentId: gym.defaultSessionId,
                    },
                });
                await expect(
                    gym.client.getAgentActivity(gym.defaultSessionId),
                ).resolves.toMatchObject({
                    subagents: [expect.objectContaining({ id: subagent.id })],
                });
            },
        },
        {
            id: "AS-019-keeps-subagent-history-readable-after-parent-work-completes",
            options: subagentOptions(),
            run: async (gym) => {
                const subagent = await spawnSubagent(gym);
                const history = await gym.client.getMessages(subagent.id);
                expect(history.runs.length).toBeGreaterThanOrEqual(1);
                expect(history.runs.every((run) => run.id.length > 0)).toBe(true);
            },
        },
        {
            id: "AS-020-reports-no-subagent-as-a-top-level-owner-after-direct-creation",
            options: subagentOptions(),
            run: async (gym) => {
                const project = await rootProject(gym);
                const direct = await createTopLevel(gym, project.id, "statedirectowner");
                const subagent = await spawnSubagent(gym);
                const ids = (await gym.client.getProject(project.id)).project.agents.map(
                    (agent) => agent.id,
                );
                expect(ids).toContain(direct.id);
                expect(ids).not.toContain(subagent.id);
                expect(ids.every((id) => id !== subagent.id)).toBe(true);
            },
        },
    ])(
        "$id",
        async ({ options, run }) => {
            const gym = await startGym(options);
            const stream = gym.stream();
            await stream.opened();
            await run(gym);
        },
        90_000,
    );
});

async function startGym(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym(options);
    gyms.add(gym);
    return gym;
}

async function rootProject(gym: AgentGym) {
    return await gym.waitUntil(
        async () => {
            const projects = await gym.client.listProjects();
            const project = projects.projects.find((candidate) =>
                candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
            );
            return project?.initialization.status === "ready" ? project : undefined;
        },
        "the root project to be ready",
        30_000,
    );
}

async function createChildWorkspace(gym: AgentGym, parentId: string, name: string) {
    const created = await gym.client.createWorkspace({
        mutationId: `create-${name}`,
        name,
        parentId,
    });
    return await gym.waitUntil(
        async () => {
            const workspace = (await gym.client.getWorkspace(created.workspace.id)).workspace;
            if (workspace.initialization.status === "failed") {
                throw new Error(
                    workspace.initialization.error ?? "workspace initialization failed",
                );
            }
            return workspace.initialization.status === "ready" ? workspace : undefined;
        },
        `${name} workspace to be ready`,
        30_000,
    );
}

async function createTopLevel(gym: AgentGym, workspaceId: string, id: string) {
    return (
        await gym.client.createAgent({
            id,
            mutationId: `create-${id}`,
            workspaceId,
        })
    ).agent;
}

async function spawnSubagent(gym: AgentGym) {
    await gym.send("create a collaborator");
    return await gym.waitUntil(
        async () => {
            const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
            return activity.subagents[0];
        },
        "the spawned subagent",
        30_000,
    );
}

function subagentOptions(): Parameters<typeof createAgentGym>[0] {
    return {
        inference: (request) =>
            request.callIndex === 1
                ? {
                      content: [
                          {
                              arguments: {
                                  effort: "medium",
                                  model: "gym/model",
                                  text: "Complete one small collaborator task.",
                                  title: "Matrix collaborator",
                              },
                              name: "create_agent",
                              type: "tool_call",
                          },
                          { text: "The collaborator completed its task.", type: "text" },
                      ],
                  }
                : { content: [{ text: "Collaborator complete.", type: "text" }] },
    };
}

function subagentOptionsForTwoChildren(): Parameters<typeof createAgentGym>[0] {
    return {
        inference: (request) =>
            request.callIndex === 1
                ? {
                      content: [
                          {
                              arguments: {
                                  effort: "medium",
                                  model: "gym/model",
                                  text: "Complete child one.",
                                  title: "First matrix collaborator",
                              },
                              name: "create_agent",
                              type: "tool_call",
                          },
                          {
                              arguments: {
                                  effort: "medium",
                                  model: "gym/model",
                                  text: "Complete child two.",
                                  title: "Second matrix collaborator",
                              },
                              name: "create_agent",
                              type: "tool_call",
                          },
                          { text: "Both collaborators completed.", type: "text" },
                      ],
                  }
                : { content: [{ text: "Collaborator complete.", type: "text" }] },
    };
}

function draft(text: string) {
    return {
        effort: "medium" as const,
        modelId: "gym/model",
        permissionMode: "auto" as const,
        providerId: "gym",
        serviceTier: null,
        text,
    };
}

function modeFor(gym: AgentGym) {
    return {
        ...gym.selection,
        permissionMode: "auto" as const,
    };
}
