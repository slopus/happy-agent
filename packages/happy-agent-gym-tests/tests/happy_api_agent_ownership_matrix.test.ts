import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type Scenario = {
    readonly id: string;
    readonly run: (gym: AgentGym) => Promise<void>;
};

const gyms = new Set<AgentGym>();

describe("public top-level agent ownership matrix", () => {
    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it.each<Scenario>([
        {
            id: "AO-001-accepts-a-client-supplied-top-level-agent-id",
            run: async (gym) => {
                const project = await rootProject(gym);
                const response = await gym.client.createAgent({
                    id: "ownershipclientidone",
                    mutationId: "ao-001",
                    title: "Client identity",
                    workspaceId: project.id,
                });
                expect(response.agent).toMatchObject({
                    id: "ownershipclientidone",
                    parentAgentId: null,
                    title: "Client identity",
                    workspaceId: project.id,
                });
            },
        },
        {
            id: "AO-002-mints-a-top-level-agent-id-when-the-client-omits-one",
            run: async (gym) => {
                const project = await rootProject(gym);
                const response = await gym.client.createAgent({
                    mutationId: "ao-002",
                    workspaceId: project.id,
                });
                expect(response.agent.id).toMatch(/^[a-z][a-z0-9]+$/);
                expect(response.agent.parentAgentId).toBeNull();
            },
        },
        {
            id: "AO-003-mints-distinct-identities-for-two-created-agents",
            run: async (gym) => {
                const project = await rootProject(gym);
                const [first, second] = await Promise.all([
                    gym.client.createAgent({ workspaceId: project.id }),
                    gym.client.createAgent({ workspaceId: project.id }),
                ]);
                expect(first.agent.id).not.toBe(second.agent.id);
            },
        },
        {
            id: "AO-004-replays-a-client-id-without-creating-a-second-owner-row",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await gym.client.createAgent({
                    id: "ownershipreplayid",
                    mutationId: "ao-004-first",
                    title: "Original",
                    workspaceId: project.id,
                });
                const before = await gym.client.getProject(project.id);
                const replay = await gym.client.createAgent({
                    id: first.agent.id,
                    mutationId: "ao-004-replay",
                    title: "Ignored replay title",
                    workspaceId: project.id,
                });
                const after = await gym.client.getProject(project.id);
                expect(replay.agent).toEqual(first.agent);
                expect(
                    after.project.agents.filter((agent) => agent.id === first.agent.id),
                ).toHaveLength(1);
                expect(after.project.agents.length).toBe(before.project.agents.length);
            },
        },
        {
            id: "AO-005-preserves-the-first-title-during-an-identical-client-id-replay",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await gym.client.createAgent({
                    id: "ownershiptitleid",
                    title: "First title",
                    workspaceId: project.id,
                });
                const replay = await gym.client.createAgent({
                    id: first.agent.id,
                    title: "Second title",
                    workspaceId: project.id,
                });
                expect(replay.agent.title).toBe("First title");
            },
        },
        {
            id: "AO-006-uses-one-id-for-the-project-and-its-root-workspace",
            run: async (gym) => {
                const project = await rootProject(gym);
                const workspaces = await gym.client.listWorkspaces({
                    includeArchived: true,
                    projectId: project.id,
                });
                expect(workspaces.workspaces).toContainEqual(
                    expect.objectContaining({
                        id: project.id,
                        kind: "root",
                        parentId: null,
                        projectId: project.id,
                    }),
                );
            },
        },
        {
            id: "AO-007-lists-a-root-agent-through-the-project-owner",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershipprojectagent");
                const listed = (await gym.client.getProject(project.id)).project.agents;
                expect(listed.map((candidate) => candidate.id)).toContain(agent.id);
                expect(
                    listed.find((candidate) => candidate.id === agent.id)?.parentAgentId,
                ).toBeNull();
            },
        },
        {
            id: "AO-008-lists-a-child-workspace-agent-only-through-that-workspace",
            run: async (gym) => {
                const project = await rootProject(gym);
                const child = await createChildWorkspace(gym, project.id, "ownership-child");
                const agent = await createAgent(gym, child.id, "ownershipchildagent");
                const root = (await gym.client.getProject(project.id)).project;
                const childAgain = (await gym.client.getWorkspace(child.id)).workspace;
                expect(root.agents.map((candidate) => candidate.id)).not.toContain(agent.id);
                expect(childAgain.agents.map((candidate) => candidate.id)).toContain(agent.id);
            },
        },
        {
            id: "AO-009-appends-new-agents-within-one-owner-series",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await createAgent(gym, project.id, "ownershipappendone");
                const second = await createAgent(gym, project.id, "ownershipappendtwo");
                const ids = ownerAgents((await gym.client.getProject(project.id)).project.agents, [
                    first.id,
                    second.id,
                ]);
                expect(ids).toEqual([first.id, second.id]);
                expect(first.orderKey).not.toBe(second.orderKey);
            },
        },
        {
            id: "AO-010-moves-an-agent-to-the-front-of-its-owner-series",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await createAgent(gym, project.id, "ownershipfrontone");
                const second = await createAgent(gym, project.id, "ownershipfronttwo");
                const moved = await gym.client.reorderAgent(second.id, {
                    afterId: null,
                    mutationId: "ao-010",
                });
                const ids = ownerAgents((await gym.client.getProject(project.id)).project.agents, [
                    first.id,
                    second.id,
                ]);
                expect(ids).toEqual([second.id, first.id]);
                expect(moved.agent.orderKey).not.toBe(second.orderKey);
            },
        },
        {
            id: "AO-011-moves-an-agent-between-two-neighbours",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await createAgent(gym, project.id, "ownershipmiddleone");
                const second = await createAgent(gym, project.id, "ownershipmiddletwo");
                const third = await createAgent(gym, project.id, "ownershipmiddlethree");
                await gym.client.reorderAgent(third.id, {
                    afterId: first.id,
                    mutationId: "ao-011",
                });
                const ids = ownerAgents((await gym.client.getProject(project.id)).project.agents, [
                    first.id,
                    second.id,
                    third.id,
                ]);
                expect(ids).toEqual([first.id, third.id, second.id]);
            },
        },
        {
            id: "AO-012-moves-an-agent-to-the-end-of-its-owner-series",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await createAgent(gym, project.id, "ownershipendone");
                const second = await createAgent(gym, project.id, "ownershipendtwo");
                const third = await createAgent(gym, project.id, "ownershipendthree");
                await gym.client.reorderAgent(first.id, {
                    afterId: third.id,
                    mutationId: "ao-012",
                });
                const ids = ownerAgents((await gym.client.getProject(project.id)).project.agents, [
                    first.id,
                    second.id,
                    third.id,
                ]);
                expect(ids).toEqual([second.id, third.id, first.id]);
            },
        },
        {
            id: "AO-013-keeps-a-no-op-reorder-version-and-order-stable",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await createAgent(gym, project.id, "ownershipnoopone");
                const second = await createAgent(gym, project.id, "ownershipnooptwo");
                const before = (await gym.client.getAgent(second.id)).agent;
                const result = await gym.client.reorderAgent(second.id, {
                    afterId: first.id,
                    mutationId: "ao-013",
                });
                expect(result.agent.orderKey).toBe(before.orderKey);
                expect(result.agent.version).not.toBe("");
            },
        },
        {
            id: "AO-014-rejects-placing-an-agent-after-itself",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershipselforder");
                await expect(
                    gym.client.reorderAgent(agent.id, {
                        afterId: agent.id,
                        mutationId: "ao-014",
                    }),
                ).rejects.toMatchObject({ status: 500 });
                expect((await gym.client.getAgent(agent.id)).agent.orderKey).toBe(agent.orderKey);
            },
        },
        {
            id: "AO-015-chains-agent-version-through-a-real-reorder-event",
            run: async (gym) => {
                const project = await rootProject(gym);
                const first = await createAgent(gym, project.id, "ownershipeventone");
                const second = await createAgent(gym, project.id, "ownershipeventtwo");
                const before = (await gym.client.getAgent(second.id)).agent;
                const moved = await gym.client.reorderAgent(second.id, {
                    afterId: null,
                    mutationId: "ao-015",
                });
                const event = await gym.waitForEvent(
                    (candidate) =>
                        candidate.type === "agent.updated" &&
                        (candidate.payload as { agentId?: string }).agentId === second.id &&
                        (candidate.payload as { mutationId?: string }).mutationId === "ao-015",
                    "the reorder agent event",
                );
                expect(event.payload).toMatchObject({
                    mutationId: "ao-015",
                    previousVersion: before.version,
                    version: moved.agent.version,
                });
                expect(first.id).not.toBe(second.id);
            },
        },
        {
            id: "AO-016-removes-an-archived-agent-from-active-owner-lists",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershiparchiveactive");
                const archived = await gym.client.archiveAgent(agent.id, {
                    mutationId: "ao-016",
                });
                expect(archived.agent.archivedAt).not.toBeNull();
                expect(
                    (await gym.client.getProject(project.id)).project.agents.map(
                        (candidate) => candidate.id,
                    ),
                ).not.toContain(agent.id);
                expect(
                    (await gym.client.getWorkspace(project.id)).workspace.agents.map(
                        (candidate) => candidate.id,
                    ),
                ).not.toContain(agent.id);
            },
        },
        {
            id: "AO-017-makes-archival-idempotent",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershiparchiveidempotent");
                const first = await gym.client.archiveAgent(agent.id, {
                    mutationId: "ao-017-first",
                });
                const second = await gym.client.archiveAgent(agent.id, {
                    mutationId: "ao-017-second",
                });
                expect(second.agent.archivedAt).not.toBeNull();
                expect(second.agent.archivedAt).toBeGreaterThanOrEqual(first.agent.archivedAt ?? 0);
            },
        },
        {
            id: "AO-018-restores-an-archived-agent-to-the-same-owner",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershipunarchive");
                await gym.client.archiveAgent(agent.id);
                const restored = await gym.client.unarchiveAgent(agent.id, {
                    mutationId: "ao-018",
                });
                expect(restored.agent.archivedAt).toBeNull();
                expect(
                    (await gym.client.getProject(project.id)).project.agents.map(
                        (candidate) => candidate.id,
                    ),
                ).toContain(agent.id);
            },
        },
        {
            id: "AO-019-applies-the-newer-composer-draft",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershipdraftnew");
                const draft = draftFor("newer");
                const saved = await gym.client.saveAgentDraft(agent.id, {
                    draft,
                    mutationId: "ao-019",
                    updatedAt: 2_000,
                });
                expect(saved.draft).toEqual({ value: draft, updatedAt: 2_000 });
            },
        },
        {
            id: "AO-020-ignores-an-older-composer-draft",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershipdraftold");
                const newer = draftFor("newer");
                await gym.client.saveAgentDraft(agent.id, {
                    draft: newer,
                    updatedAt: 2_000,
                });
                const ignored = await gym.client.saveAgentDraft(agent.id, {
                    draft: draftFor("older"),
                    mutationId: "ao-020",
                    updatedAt: 1_000,
                });
                expect(ignored.draft).toEqual({ value: newer, updatedAt: 2_000 });
            },
        },
        {
            id: "AO-021-clears-a-composer-draft-explicitly",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershipdraftclear");
                await gym.client.saveAgentDraft(agent.id, {
                    draft: draftFor("to-clear"),
                    updatedAt: 2_000,
                });
                const cleared = await gym.client.saveAgentDraft(agent.id, {
                    draft: null,
                    mutationId: "ao-021",
                    updatedAt: 3_000,
                });
                expect(cleared.draft).toEqual({ value: null, updatedAt: 3_000 });
            },
        },
        {
            id: "AO-022-preserves-owner-state-through-unread-read-and-restart",
            run: async (gym) => {
                const project = await rootProject(gym);
                const agent = await createAgent(gym, project.id, "ownershiprestart");
                await gym.client.saveAgentDraft(agent.id, {
                    draft: draftFor("restart"),
                    updatedAt: 2_000,
                });
                await gym.client.markAgentRead(agent.id, { mutationId: "ao-022-read" });
                await gym.restart();
                const restarted = (await gym.client.getAgent(agent.id)).agent;
                expect(restarted).toMatchObject({
                    archivedAt: null,
                    id: agent.id,
                    unread: null,
                    workspaceId: project.id,
                });
                await expect(gym.client.getAgentDraft(agent.id)).resolves.toEqual({
                    draft: { value: draftFor("restart"), updatedAt: 2_000 },
                });
            },
        },
    ])(
        "$id",
        async ({ run }) => {
            const gym = await startGym();
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

async function createAgent(gym: AgentGym, workspaceId: string, id: string) {
    return (
        await gym.client.createAgent({
            id,
            mutationId: `create-${id}`,
            workspaceId,
        })
    ).agent;
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

function ownerAgents(agents: readonly { id: string }[], expected: readonly string[]): string[] {
    return agents.map((agent) => agent.id).filter((id) => expected.includes(id));
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

const draftFor = draft;
