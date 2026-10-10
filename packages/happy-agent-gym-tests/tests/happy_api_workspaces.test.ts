import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();
type Workspace = Awaited<ReturnType<AgentGym["client"]["getWorkspace"]>>["workspace"];
type HappyAgentEvent = Awaited<ReturnType<AgentGym["client"]["getEvents"]>>["events"][number];
interface ApiErrorLike extends Error {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
}

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("the public workspace API", () => {
    it("makes the project its root workspace and copies nested plain-directory trees", async () => {
        const gym = await createAgentGym({
            files: {
                "workspace-marker.txt": "root marker\n",
            },
        });
        running.add(gym);

        const project = (await gym.client.listProjects()).projects.find(
            (candidate) => candidate.id === gym.defaultSessionId || candidate.agents.length > 0,
        );
        expect(project).toBeDefined();
        if (project === undefined) throw new Error("The gym did not register a root project.");

        const root = await waitReady(gym, project.id);
        expect(root.id).toBe(project.id);
        expect(root.projectId).toBe(project.id);
        expect(root.parentId).toBeNull();
        expect(root.kind).toBe("root");
        expect(root.compute).toMatchObject({ type: "host", path: gym.workspacePath });
        expect(root.agents.map((agent) => agent.id)).toContain(gym.defaultSessionId);

        const childResponse = await gym.client.createWorkspace({
            agentId: gym.defaultSessionId,
            mutationId: "workspace-create-child",
            name: "child-copy",
            parentId: root.id,
        });
        const child = await waitReady(gym, childResponse.workspace.id);
        expect(child.kind).toBe("copy");
        expect(child.projectId).toBe(root.id);
        expect(child.parentId).toBe(root.id);
        expect(child.creatorAgentId).toBe(gym.defaultSessionId);
        expect(child.agents).toEqual([]);
        expect(child.compute.type).toBe("host");
        if (child.compute.type !== "host") throw new Error("The copy has no host path.");
        await expect(
            readFile(join(child.compute.path, "workspace-marker.txt"), "utf8"),
        ).resolves.toBe("root marker\n");

        const childAgent = (
            await gym.client.createAgent({
                mutationId: "workspace-child-agent",
                title: "Child workspace agent",
                workspaceId: child.id,
            })
        ).agent;
        const childWithAgent = (await gym.client.getWorkspace(child.id)).workspace;
        const rootWithAgent = (await gym.client.getWorkspace(root.id)).workspace;
        expect(childWithAgent.agents.map((agent) => agent.id)).toEqual([childAgent.id]);
        expect(rootWithAgent.agents.map((agent) => agent.id)).not.toContain(childAgent.id);
        expect(childAgent.parentAgentId).toBeNull();

        const nestedResponse = await gym.client.createWorkspace({
            mutationId: "workspace-create-nested",
            name: "nested-copy",
            parentId: child.id,
        });
        const nested = await waitReady(gym, nestedResponse.workspace.id);
        expect(nested.kind).toBe("copy");
        expect(nested.projectId).toBe(root.id);
        expect(nested.parentId).toBe(child.id);
        expect(nested.agents).toEqual([]);
        expect(nested.base).toEqual({
            commit: null,
            ref: "worktree/child-copy",
        });
        expect(nested.compute.type).toBe("host");
        if (nested.compute.type !== "host") throw new Error("The nested copy has no host path.");
        await expect(
            readFile(join(nested.compute.path, "workspace-marker.txt"), "utf8"),
        ).resolves.toBe("root marker\n");
    }, 30_000);

    it("renames and reorders siblings with chained versions and mutation echoes", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const root = await rootWorkspace(gym);
        const first = await readyCreatedWorkspace(gym, root.id, "first-sibling");
        const second = await readyCreatedWorkspace(gym, root.id, "second-sibling");
        const beforeRename = (await gym.client.getWorkspace(first.id)).workspace;
        const renameMutationId = "workspace-rename-child";

        const renamed = (
            await gym.client.renameWorkspace(
                first.id,
                { mutationId: renameMutationId, name: "renamed-sibling" },
                { ifMatch: beforeRename.version },
            )
        ).workspace;
        expect(renamed.name).toBe("renamed-sibling");
        expect(renamed.nameSource).toBe("user");
        expect(renamed.version).not.toBe(beforeRename.version);
        expect(renamed.updatedAt).toBeGreaterThanOrEqual(beforeRename.updatedAt);

        const renameEvent = await waitForWorkspaceEvent(
            gym,
            first.id,
            (event) =>
                event.type === "workspace.updated" &&
                event.payload.mutationId === renameMutationId &&
                event.payload.changes.name === "renamed-sibling",
            "the workspace rename event",
        );
        expect(renameEvent.type).toBe("workspace.updated");
        if (renameEvent.type !== "workspace.updated") throw new Error("Not a workspace update.");
        expect(renameEvent.payload.previousVersion).toBe(beforeRename.version);
        expect(renameEvent.payload.version).toBe(renamed.version);
        expect(renameEvent.payload.mutationId).toBe(renameMutationId);

        const staleRename = await captureApiError(
            () =>
                gym.client.renameWorkspace(
                    first.id,
                    { name: "stale-name" },
                    { ifMatch: beforeRename.version },
                ),
            409,
        );
        expect(staleRename.code).toBe("conflict");
        expect(staleRename.body).toMatchObject({
            currentVersion: renamed.version,
            workspace: { id: first.id, name: renamed.name },
        });
        expect((await gym.client.getWorkspace(first.id)).workspace.name).toBe("renamed-sibling");

        const beforeReorder = (await gym.client.getWorkspace(first.id)).workspace;
        const reorderMutationId = "workspace-reorder-child";
        const reordered = (
            await gym.client.reorderWorkspace(
                first.id,
                { afterId: null, mutationId: reorderMutationId },
                { ifMatch: beforeReorder.version },
            )
        ).workspace;
        expect(reordered.version).not.toBe(beforeReorder.version);
        const siblingIds = (await gym.client.listWorkspaces({ projectId: root.id })).workspaces
            .filter((workspace) => workspace.parentId === root.id && workspace.status === "active")
            .map((workspace) => workspace.id);
        expect(siblingIds.slice(0, 2)).toEqual([first.id, second.id]);

        const reorderEvent = await waitForWorkspaceEvent(
            gym,
            first.id,
            (event) =>
                event.type === "workspace.updated" &&
                event.payload.mutationId === reorderMutationId &&
                event.payload.changes.orderKey === reordered.orderKey,
            "the workspace reorder event",
        );
        expect(reorderEvent.type).toBe("workspace.updated");
        if (reorderEvent.type !== "workspace.updated") throw new Error("Not a workspace update.");
        expect(reorderEvent.payload.previousVersion).toBe(beforeReorder.version);
        expect(reorderEvent.payload.version).toBe(reordered.version);
        expect(reorderEvent.payload.mutationId).toBe(reorderMutationId);
    }, 30_000);

    it("rejects root and impossible parent operations without changing the catalog", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const root = await rootWorkspace(gym);
        const child = await readyCreatedWorkspace(gym, root.id, "invalid-operation-child");
        const before = await gym.client.listWorkspaces({
            includeArchived: true,
            projectId: root.id,
        });

        const missingParent = await captureApiError(
            () =>
                gym.client.createWorkspace({
                    name: "missing-parent",
                    parentId: "missingworkspace",
                }),
            404,
        );
        expect(missingParent.code).toBe("not_found");

        const invalidBase = await captureApiError(
            () =>
                gym.client.createWorkspace({
                    baseRef: "",
                    name: "invalid-base",
                    parentId: root.id,
                }),
            400,
        );
        expect(invalidBase.code).toBe("invalid_request");

        const rootRename = await captureApiError(
            () =>
                gym.client.renameWorkspace(
                    root.id,
                    { name: "cannot-rename-root" },
                    { ifMatch: root.version },
                ),
            409,
        );
        expect(rootRename.code).toBe("conflict");

        const rootReorder = await captureApiError(
            () =>
                gym.client.reorderWorkspace(root.id, { afterId: null }, { ifMatch: root.version }),
            409,
        );
        expect(rootReorder.code).toBe("conflict");

        const rootArchive = await captureApiError(
            () => gym.client.archiveWorkspace(root.id, { ifMatch: root.version }),
            409,
        );
        expect(rootArchive.code).toBe("conflict");

        const crossParentAfter = await captureApiError(
            () =>
                gym.client.reorderWorkspace(
                    child.id,
                    { afterId: root.id },
                    { ifMatch: child.version },
                ),
            400,
        );
        expect(crossParentAfter.code).toBe("invalid_request");

        const after = await gym.client.listWorkspaces({
            includeArchived: true,
            projectId: root.id,
        });
        expect(after.workspaces.map((workspace) => workspace.id)).toEqual(
            before.workspaces.map((workspace) => workspace.id),
        );
        expect((await gym.client.getWorkspace(child.id)).workspace.name).toBe(child.name);
    }, 30_000);

    it("archives a workspace subtree, keeps the root alive, and survives a restart", async () => {
        const gym = await createAgentGym({
            files: {
                "archive-marker.txt": "keep the root\n",
            },
        });
        running.add(gym);

        const root = await rootWorkspace(gym);
        const parent = await readyCreatedWorkspace(gym, root.id, "archive-parent");
        const descendant = await readyCreatedWorkspace(gym, parent.id, "archive-descendant");
        const beforeArchive = (await gym.client.getWorkspace(parent.id)).workspace;

        const archived = (
            await gym.client.archiveWorkspace(parent.id, {
                ifMatch: beforeArchive.version,
                mutationId: "workspace-archive-subtree",
            })
        ).workspace;
        expect(["archiving", "archived"]).toContain(archived.status);
        expect(archived.archivedAt).not.toBeNull();

        const archivedParent = await waitUntilArchived(gym, parent.id);
        const archivedDescendant = await waitUntilArchived(gym, descendant.id);
        expect(archivedParent.status).toBe("archived");
        expect(archivedDescendant.status).toBe("archived");
        expect((await gym.client.getWorkspace(root.id)).workspace.status).toBe("active");

        const active = await gym.client.listWorkspaces({ projectId: root.id });
        expect(active.workspaces.map((workspace) => workspace.id)).not.toContain(parent.id);
        expect(active.workspaces.map((workspace) => workspace.id)).not.toContain(descendant.id);
        const all = await gym.client.listWorkspaces({
            includeArchived: true,
            projectId: root.id,
        });
        expect(all.workspaces.find((workspace) => workspace.id === parent.id)?.status).toBe(
            "archived",
        );
        expect(all.workspaces.find((workspace) => workspace.id === descendant.id)?.status).toBe(
            "archived",
        );

        await gym.restart();
        const restartedRoot = (await gym.client.getWorkspace(root.id)).workspace;
        expect(restartedRoot.status).toBe("active");
        const restartedAll = await gym.client.listWorkspaces({
            includeArchived: true,
            projectId: root.id,
        });
        expect(
            restartedAll.workspaces.find((workspace) => workspace.id === parent.id)?.status,
        ).toBe("archived");
        expect(
            restartedAll.workspaces.find((workspace) => workspace.id === descendant.id)?.parentId,
        ).toBe(parent.id);
        expect(restartedAll.workspaces.find((workspace) => workspace.id === root.id)?.kind).toBe(
            "root",
        );
    }, 30_000);
});

async function rootWorkspace(gym: AgentGym): Promise<Workspace> {
    const projects = await gym.client.listProjects();
    const project = projects.projects.find((candidate) =>
        candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
    );
    if (project === undefined) throw new Error("No project owns the gym's default agent.");
    return await waitReady(gym, project.id);
}

async function readyCreatedWorkspace(
    gym: AgentGym,
    parentId: string,
    name: string,
): Promise<Workspace> {
    const created = await gym.client.createWorkspace({
        mutationId: `workspace-create-${name}`,
        name,
        parentId,
    });
    return await waitReady(gym, created.workspace.id);
}

async function waitReady(gym: AgentGym, workspaceId: string): Promise<Workspace> {
    return await gym.waitUntil(
        async () => {
            try {
                const workspace = (await gym.client.getWorkspace(workspaceId)).workspace;
                if (workspace.initialization.status === "failed") {
                    throw new Error(
                        `Workspace ${workspaceId} initialization failed: ${
                            workspace.initialization.error ?? "unknown error"
                        }`,
                    );
                }
                return workspace.initialization.status === "ready" ? workspace : undefined;
            } catch (error: unknown) {
                if (isApiError(error) && error.status === 409) return undefined;
                throw error;
            }
        },
        `workspace ${workspaceId} to become ready`,
        20_000,
    );
}

async function waitUntilArchived(gym: AgentGym, workspaceId: string): Promise<Workspace> {
    return await gym.waitUntil(
        async () => {
            const workspace = (
                await gym.client.listWorkspaces({
                    includeArchived: true,
                })
            ).workspaces.find((candidate) => candidate.id === workspaceId);
            return workspace?.status === "archived" ? workspace : undefined;
        },
        `workspace ${workspaceId} to be archived`,
        20_000,
    );
}

async function waitForWorkspaceEvent(
    gym: AgentGym,
    workspaceId: string,
    predicate: (event: HappyAgentEvent) => boolean,
    description: string,
): Promise<HappyAgentEvent> {
    return await gym.waitForEvent(
        (event) => {
            if (event.type === "workspace.created") {
                return event.payload.workspace.id === workspaceId && predicate(event);
            }
            if (event.type !== "workspace.updated") return false;
            return event.payload.workspaceId === workspaceId && predicate(event);
        },
        description,
        20_000,
    );
}

async function captureApiError(
    operation: () => Promise<unknown>,
    status: number,
): Promise<ApiErrorLike> {
    try {
        await operation();
    } catch (error: unknown) {
        expect(isApiError(error)).toBe(true);
        if (!isApiError(error)) throw error;
        expect(error.status).toBe(status);
        return error;
    }
    throw new Error(`Expected the API to reject with HTTP ${String(status)}.`);
}

function isApiError(error: unknown): error is ApiErrorLike {
    return (
        error instanceof Error &&
        typeof (error as Partial<ApiErrorLike>).status === "number" &&
        (typeof (error as Partial<ApiErrorLike>).code === "string" ||
            (error as Partial<ApiErrorLike>).code === null) &&
        "body" in error
    );
}
