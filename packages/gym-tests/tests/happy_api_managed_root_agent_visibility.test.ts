import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("managed root agent visibility", () => {
    it("lists only a different-workspace managed root while keeping user messaging disabled", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const project = await rootProject(gym);
        const workspace = await createChildWorkspace(gym, project.id);
        const managed = (
            await gym.client.createAgent({
                id: "managedworkspaceagent",
                mutationId: "managed-root-create",
                parentAgentId: gym.defaultSessionId,
                title: "Managed workspace agent",
                workspaceId: workspace.id,
            })
        ).agent;

        expect(managed).toMatchObject({
            canSendMessages: false,
            managedByAnotherAgent: true,
            parentAgentId: gym.defaultSessionId,
            userVisible: true,
            workspaceId: workspace.id,
        });
        expect(managed.orderKey).toEqual(expect.any(String));

        const root = (await gym.client.getProject(project.id)).project;
        const destination = (await gym.client.getWorkspace(workspace.id)).workspace;
        expect(root.agents.map((agent) => agent.id)).not.toContain(managed.id);
        expect(destination.agents).toContainEqual(
            expect.objectContaining({
                canSendMessages: false,
                id: managed.id,
                managedByAnotherAgent: true,
                userVisible: true,
            }),
        );
        expect((await gym.client.getAgentActivity(gym.defaultSessionId)).subagents).toContainEqual(
            expect.objectContaining({ id: managed.id }),
        );

        await expect(
            gym.client.sendMessage(managed.id, {
                mode: { ...gym.selection, permissionMode: "auto" },
                text: "The user must not take over this managed agent.",
            }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });

        await expect(
            gym.client.createAgent({
                id: "sameworkspacemanaged",
                parentAgentId: gym.defaultSessionId,
                workspaceId: project.id,
            }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });
        await expect(gym.client.getAgent("sameworkspacemanaged")).rejects.toMatchObject({
            code: "not_found",
            status: 404,
        });
    }, 60_000);
});

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

async function createChildWorkspace(gym: AgentGym, parentId: string) {
    const created = await gym.client.createWorkspace({
        id: "managedrootworkspace",
        mutationId: "managed-root-workspace-create",
        name: "managed-root-workspace",
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
        "the managed-root workspace to be ready",
        30_000,
    );
}
