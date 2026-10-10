import { createAgentGym, type AgentGym, type GymAgentEvent } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("public agent owner edge contracts", () => {
    it("archives and restores a root agent with project and root-workspace owner versions", async () => {
        const gym = await startGym();
        const project = await rootProject(gym);
        const agent = (
            await gym.client.createAgent({
                id: "ownerarchiveprojectagent",
                mutationId: "owner-edge-root-create",
                workspaceId: project.id,
            })
        ).agent;

        const beforeProject = (await gym.client.getProject(project.id)).project;
        const beforeWorkspace = (await gym.client.getWorkspace(project.id)).workspace;
        const archiveCursor = await latestCursor(gym);
        const archived = await gym.client.archiveAgent(agent.id, {
            mutationId: "owner-edge-root-archive",
        });
        const archivedProjectEvent = await waitForOwnerEvent(
            gym,
            "project.updated",
            project.id,
            agent.id,
            false,
            archiveCursor,
        );
        const archivedWorkspaceEvent = await waitForOwnerEvent(
            gym,
            "workspace.updated",
            project.id,
            agent.id,
            false,
            archiveCursor,
        );

        expect(archived.agent.archivedAt).not.toBeNull();
        expect(archivedProjectEvent.payload.previousVersion).toBe(beforeProject.version);
        expect(archivedWorkspaceEvent.payload.previousVersion).toBe(beforeWorkspace.version);
        expect(archivedProjectEvent.payload.version).not.toBe(beforeProject.version);
        expect(archivedWorkspaceEvent.payload.version).not.toBe(beforeWorkspace.version);
        expect(ownerAgentIds(archivedProjectEvent.payload.changes.agents)).not.toContain(agent.id);
        expect(ownerAgentIds(archivedWorkspaceEvent.payload.changes.agents)).not.toContain(
            agent.id,
        );

        const afterArchiveProject = (await gym.client.getProject(project.id)).project;
        const afterArchiveWorkspace = (await gym.client.getWorkspace(project.id)).workspace;
        expect(afterArchiveProject.version).toBe(archivedProjectEvent.payload.version);
        expect(afterArchiveWorkspace.version).toBe(archivedWorkspaceEvent.payload.version);
        expect(afterArchiveProject.agents.map((candidate) => candidate.id)).not.toContain(agent.id);
        expect(afterArchiveWorkspace.agents.map((candidate) => candidate.id)).not.toContain(
            agent.id,
        );

        const unarchiveCursor = await latestCursor(gym);
        const restored = await gym.client.unarchiveAgent(agent.id, {
            mutationId: "owner-edge-root-unarchive",
        });
        const restoredProjectEvent = await waitForOwnerEvent(
            gym,
            "project.updated",
            project.id,
            agent.id,
            true,
            unarchiveCursor,
        );
        const restoredWorkspaceEvent = await waitForOwnerEvent(
            gym,
            "workspace.updated",
            project.id,
            agent.id,
            true,
            unarchiveCursor,
        );

        expect(restored.agent.archivedAt).toBeNull();
        expect(restoredProjectEvent.payload.previousVersion).toBe(afterArchiveProject.version);
        expect(restoredWorkspaceEvent.payload.previousVersion).toBe(afterArchiveWorkspace.version);
        expect(restoredProjectEvent.payload.version).not.toBe(afterArchiveProject.version);
        expect(restoredWorkspaceEvent.payload.version).not.toBe(afterArchiveWorkspace.version);
        expect(ownerAgentIds(restoredProjectEvent.payload.changes.agents)).toContain(agent.id);
        expect(ownerAgentIds(restoredWorkspaceEvent.payload.changes.agents)).toContain(agent.id);

        const afterRestoreProject = (await gym.client.getProject(project.id)).project;
        const afterRestoreWorkspace = (await gym.client.getWorkspace(project.id)).workspace;
        expect(afterRestoreProject.version).toBe(restoredProjectEvent.payload.version);
        expect(afterRestoreWorkspace.version).toBe(restoredWorkspaceEvent.payload.version);
        expect(afterRestoreProject.agents.map((candidate) => candidate.id)).toContain(agent.id);
        expect(afterRestoreWorkspace.agents.map((candidate) => candidate.id)).toContain(agent.id);
    }, 60_000);

    it("archives and restores a child-workspace agent through that workspace owner", async () => {
        const gym = await startGym();
        const project = await rootProject(gym);
        const child = await readyWorkspace(
            gym,
            (
                await gym.client.createWorkspace({
                    id: "owneredgechildworkspace",
                    mutationId: "owner-edge-child-create",
                    name: "owner-edge-child",
                    parentId: project.id,
                })
            ).workspace.id,
        );
        const agent = (
            await gym.client.createAgent({
                id: "ownerarchivechildagent",
                mutationId: "owner-edge-child-agent-create",
                workspaceId: child.id,
            })
        ).agent;
        const before = (await gym.client.getWorkspace(child.id)).workspace;

        const archiveCursor = await latestCursor(gym);
        const archived = await gym.client.archiveAgent(agent.id, {
            mutationId: "owner-edge-child-archive",
        });
        const archivedEvent = await waitForOwnerEvent(
            gym,
            "workspace.updated",
            child.id,
            agent.id,
            false,
            archiveCursor,
        );
        expect(archived.agent.archivedAt).not.toBeNull();
        expect(archivedEvent.payload.previousVersion).toBe(before.version);
        expect(archivedEvent.payload.version).not.toBe(before.version);
        expect(ownerAgentIds(archivedEvent.payload.changes.agents)).not.toContain(agent.id);
        expect((await gym.client.getWorkspace(child.id)).workspace.agents).not.toEqual([
            expect.objectContaining({ id: agent.id }),
        ]);

        const unarchiveCursor = await latestCursor(gym);
        const restored = await gym.client.unarchiveAgent(agent.id, {
            mutationId: "owner-edge-child-unarchive",
        });
        const restoredEvent = await waitForOwnerEvent(
            gym,
            "workspace.updated",
            child.id,
            agent.id,
            true,
            unarchiveCursor,
        );
        expect(restored.agent.archivedAt).toBeNull();
        expect(restoredEvent.payload.previousVersion).toBe(archivedEvent.payload.version);
        expect(restoredEvent.payload.version).not.toBe(archivedEvent.payload.version);
        expect(ownerAgentIds(restoredEvent.payload.changes.agents)).toContain(agent.id);
        expect((await gym.client.getWorkspace(child.id)).workspace.agents).toEqual([
            expect.objectContaining({ id: agent.id }),
        ]);
    }, 60_000);

    it("keeps repeated archive/unarchive and a no-op reorder fully idempotent", async () => {
        const gym = await startGym();
        const project = await rootProject(gym);
        const first = (
            await gym.client.createAgent({
                id: "owneredgefirstagent",
                workspaceId: project.id,
            })
        ).agent;
        const second = (
            await gym.client.createAgent({
                id: "owneredgesecondagent",
                workspaceId: project.id,
            })
        ).agent;

        const archiveCursor = await latestCursor(gym);
        await gym.client.archiveAgent(first.id, {
            mutationId: "owner-edge-idempotent-archive-first",
        });
        await waitForOwnerEvent(gym, "project.updated", project.id, first.id, false, archiveCursor);
        const firstArchiveState = (await gym.client.getAgent(first.id)).agent;
        const firstArchiveOwner = (await gym.client.getProject(project.id)).project;

        const secondArchive = await gym.client.archiveAgent(first.id, {
            mutationId: "owner-edge-idempotent-archive-second",
        });
        const afterSecondArchive = (await gym.client.getProject(project.id)).project;
        const secondArchiveEvents = await gym.events();
        expect(firstArchiveState).toEqual(secondArchive.agent);
        expect(afterSecondArchive.version).toBe(firstArchiveOwner.version);
        expect(
            secondArchiveEvents.some(
                (event) =>
                    event.type === "agent.updated" &&
                    event.payload.mutationId === "owner-edge-idempotent-archive-second",
            ),
        ).toBe(false);

        const unarchiveCursor = await latestCursor(gym);
        await gym.client.unarchiveAgent(first.id, {
            mutationId: "owner-edge-idempotent-unarchive-first",
        });
        await waitForOwnerEvent(
            gym,
            "project.updated",
            project.id,
            first.id,
            true,
            unarchiveCursor,
        );
        const firstRestoreState = (await gym.client.getAgent(first.id)).agent;
        const firstRestoreOwner = (await gym.client.getProject(project.id)).project;

        const secondRestore = await gym.client.unarchiveAgent(first.id, {
            mutationId: "owner-edge-idempotent-unarchive-second",
        });
        const afterSecondRestore = (await gym.client.getProject(project.id)).project;
        const secondRestoreEvents = await gym.events();
        expect(firstRestoreState).toEqual(secondRestore.agent);
        expect(afterSecondRestore.version).toBe(firstRestoreOwner.version);
        expect(
            secondRestoreEvents.some(
                (event) =>
                    event.type === "agent.updated" &&
                    event.payload.mutationId === "owner-edge-idempotent-unarchive-second",
            ),
        ).toBe(false);

        const beforeNoOpAgent = (await gym.client.getAgent(second.id)).agent;
        const beforeNoOpOwner = (await gym.client.getProject(project.id)).project;
        const noOp = await gym.client.reorderAgent(second.id, {
            afterId: first.id,
            mutationId: "owner-edge-no-op-reorder",
        });
        expect(noOp.agent).toEqual(beforeNoOpAgent);
        expect((await gym.client.getProject(project.id)).project).toEqual(beforeNoOpOwner);
        const noOpEvents = await gym.events();
        expect(
            noOpEvents.some(
                (event) =>
                    (event.type === "agent.updated" ||
                        event.type === "project.updated" ||
                        event.type === "workspace.updated") &&
                    event.payload.mutationId === "owner-edge-no-op-reorder",
            ),
        ).toBe(false);
    }, 60_000);
});

async function startGym(): Promise<AgentGym> {
    const gym = await createAgentGym();
    running.add(gym);
    return gym;
}

async function rootProject(gym: AgentGym) {
    return await gym.waitUntil(
        async () => {
            const projects = await gym.client.listProjects();
            const project = projects.projects.find((candidate) =>
                candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
            );
            if (project?.initialization.status !== "ready") return undefined;
            return project;
        },
        "the root project to be ready",
        30_000,
    );
}

async function readyWorkspace(gym: AgentGym, workspaceId: string) {
    return await gym.waitUntil(
        async () => {
            const workspace = (await gym.client.getWorkspace(workspaceId)).workspace;
            if (workspace.initialization.status === "failed") {
                throw new Error(
                    workspace.initialization.error ?? "workspace initialization failed",
                );
            }
            return workspace.initialization.status === "ready" ? workspace : undefined;
        },
        "the child workspace to be ready",
        30_000,
    );
}

async function waitForOwnerEvent(
    gym: AgentGym,
    type: "project.updated" | "workspace.updated",
    ownerId: string,
    agentId: string,
    active: boolean,
    afterCursor: string,
): Promise<Extract<GymAgentEvent, { type: "project.updated" | "workspace.updated" }>> {
    const event = await gym.waitForEvent(
        (candidate) => {
            if (candidate.cursor <= afterCursor) return false;
            if (type === "project.updated") {
                if (candidate.type !== "project.updated") return false;
                if (candidate.payload.projectId !== ownerId) return false;
                if (!("agents" in candidate.payload.changes)) return false;
                return ownerAgentIds(candidate.payload.changes.agents).includes(agentId) === active;
            }
            if (candidate.type !== "workspace.updated") return false;
            if (candidate.payload.workspaceId !== ownerId) return false;
            if (!("agents" in candidate.payload.changes)) return false;
            return ownerAgentIds(candidate.payload.changes.agents).includes(agentId) === active;
        },
        `${type} for owner ${ownerId} to ${active ? "include" : "exclude"} ${agentId}`,
        30_000,
    );
    return event as Extract<GymAgentEvent, { type: "project.updated" | "workspace.updated" }>;
}

async function latestCursor(gym: AgentGym): Promise<string> {
    return (await gym.client.getEvents({ limit: 1 })).latestCursor;
}

function ownerAgentIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((agent) =>
        typeof agent === "object" && agent !== null && "id" in agent && typeof agent.id === "string"
            ? [agent.id]
            : [],
    );
}
