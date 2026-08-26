import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";

type Workspace = Awaited<ReturnType<AgentGym["client"]["getWorkspace"]>>["workspace"];
type Scenario = {
    readonly id: string;
    readonly run: (gym: AgentGym) => Promise<void>;
};

const timeout = 45_000;
const gyms = new Set<AgentGym>();

describe("public workspace tree matrix", () => {
    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it.each<Scenario>([
        {
            id: "workspace-tree-001-project-id-is-the-root-workspace-id",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                expect(root.id).toBe(root.projectId);
                expect(root.parentId).toBeNull();
                expect(root.kind).toBe("root");
            },
        },
        {
            id: "workspace-tree-002-project-filter-returns-only-one-file-tree",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const all = (await gym.client.listWorkspaces({ includeArchived: true })).workspaces;
                const filtered = (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId: root.id,
                    })
                ).workspaces;
                expect(filtered.length).toBeGreaterThan(0);
                expect(filtered.every((workspace) => workspace.projectId === root.projectId)).toBe(
                    true,
                );
                expect(filtered.length).toBeLessThanOrEqual(all.length);
            },
        },
        {
            id: "workspace-tree-003-creates-a-ready-copy-under-the-root",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-ready-copy");
                expect(child.initialization.status).toBe("ready");
                expect(child.kind).toBe("copy");
                expect(child.parentId).toBe(root.id);
                expect(child.projectId).toBe(root.projectId);
            },
        },
        {
            id: "workspace-tree-004-nests-a-copy-under-a-copy",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const parent = await createChild(gym, root.id, "tree-parent");
                const child = await createChild(gym, parent.id, "tree-grandchild");
                expect(child.parentId).toBe(parent.id);
                expect(parent.parentId).toBe(root.id);
                expect(child.projectId).toBe(root.projectId);
            },
        },
        {
            id: "workspace-tree-005-copies-the-source-file-into-a-child",
            run: async (gym) => {
                const marker = "tree-copy-marker.txt";
                const gymWithMarker = await createAgentGym({
                    files: { [marker]: "copied through the public workspace operation\n" },
                });
                gyms.add(gymWithMarker);
                const root = await rootWorkspace(gymWithMarker);
                const child = await createChild(gymWithMarker, root.id, "tree-file-copy");
                if (child.compute.type !== "host") throw new Error("Expected a host copy.");
                await expect(readFile(join(child.compute.path, marker), "utf8")).resolves.toBe(
                    "copied through the public workspace operation\n",
                );
            },
        },
        {
            id: "workspace-tree-006-records-the-creating-agent-on-a-child",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-creator", {
                    agentId: gym.defaultSessionId,
                });
                expect(child.creatorAgentId).toBe(gym.defaultSessionId);
            },
        },
        {
            id: "workspace-tree-007-keeps-child-workspace-agent-order-separate",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-agent-owner");
                const agent = (
                    await gym.client.createAgent({
                        title: "child workspace owner",
                        workspaceId: child.id,
                        mutationId: "tree-agent-owner-create",
                    })
                ).agent;
                expect((await gym.client.getWorkspace(child.id)).workspace.agents).toHaveLength(1);
                expect(
                    (await gym.client.getWorkspace(root.id)).workspace.agents.some(
                        (candidate) => candidate.id === agent.id,
                    ),
                ).toBe(false);
                expect(agent.parentAgentId).toBeNull();
            },
        },
        {
            id: "workspace-tree-008-replays-an-identical-client-workspace-id",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const request = {
                    id: "treereplayworkspace",
                    mutationId: "tree-replay-first",
                    name: "tree-replayed",
                    parentId: root.id,
                } as const;
                const first = (await gym.client.createWorkspace(request)).workspace;
                const second = (
                    await gym.client.createWorkspace({
                        ...request,
                        mutationId: "tree-replay-second",
                    })
                ).workspace;
                expect(second.id).toBe(first.id);
                expect(
                    (await gym.client.listWorkspaces({ includeArchived: true })).workspaces.filter(
                        (candidate) => candidate.id === first.id,
                    ),
                ).toHaveLength(1);
            },
        },
        {
            id: "workspace-tree-009-preserves-a-user-supplied-name",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-user-name");
                expect(child.name).toBe("tree-user-name");
                expect(child.nameSource).toBe("user");
            },
        },
        {
            id: "workspace-tree-010-rejects-an-omitted-name-without-a-side-effect",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const before = (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId: root.id,
                    })
                ).workspaces;
                // The typed request requires a name, so the omission travels through a cast.
                const withoutName = {
                    mutationId: "tree-omitted-name",
                    parentId: root.id,
                } as Parameters<AgentGym["client"]["createWorkspace"]>[0];
                await expect(gym.client.createWorkspace(withoutName)).rejects.toMatchObject({
                    status: 400,
                    code: "invalid_request",
                });
                const after = (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId: root.id,
                    })
                ).workspaces;
                expect(after.map((workspace) => workspace.id)).toEqual(
                    before.map((workspace) => workspace.id),
                );
            },
        },
        {
            id: "workspace-tree-011-inherits-the-parent-branch-reference",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const parent = await createChild(gym, root.id, "tree-reference-parent");
                const child = await createChild(gym, parent.id, "tree-reference-child");
                expect(child.base?.ref).toBe(`worktree/${parent.name}`);
            },
        },
        {
            id: "workspace-tree-012-registers-a-second-project-with-an-independent-root",
            run: async (gym) => {
                const path = join(gym.workspacePath, "tree-second-project");
                await mkdir(path, { recursive: true });
                const project = (
                    await gym.client.registerProject({
                        path,
                        projectId: "treesecondproject",
                        mutationId: "tree-second-project",
                    })
                ).project;
                const secondRoot = await waitReady(gym, project.id);
                expect(secondRoot.id).toBe(project.id);
                expect(secondRoot.parentId).toBeNull();
                expect(secondRoot.projectId).toBe(project.id);
                expect(secondRoot.id).not.toBe((await rootWorkspace(gym)).id);
            },
        },
        {
            id: "workspace-tree-013-rejects-a-missing-parent",
            run: async (gym) => {
                await expect(
                    gym.client.createWorkspace({
                        name: "missing-parent",
                        parentId: "treemissingparent",
                    }),
                ).rejects.toMatchObject({ status: 404, code: "not_found" });
            },
        },
        {
            id: "workspace-tree-014-rejects-an-empty-base-reference",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                await expect(
                    gym.client.createWorkspace({
                        baseRef: "",
                        name: "empty-base",
                        parentId: root.id,
                    }),
                ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
                expect((await gym.client.getWorkspace(root.id)).workspace.status).toBe("active");
            },
        },
        {
            id: "workspace-tree-015-replaying-a-client-id-does-not-add-a-second-sibling",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const first = (
                    await gym.client.createWorkspace({
                        id: "treeonceworkspace",
                        name: "one-sibling",
                        parentId: root.id,
                    })
                ).workspace;
                await waitReady(gym, first.id);
                const second = (
                    await gym.client.createWorkspace({
                        id: "treeonceworkspace",
                        name: "one-sibling",
                        parentId: root.id,
                    })
                ).workspace;
                const siblings = (
                    await gym.client.listWorkspaces({ projectId: root.id })
                ).workspaces.filter((workspace) => workspace.parentId === root.id);
                expect(second.id).toBe(first.id);
                expect(siblings.filter((workspace) => workspace.id === first.id)).toHaveLength(1);
            },
        },
        {
            id: "workspace-tree-016-archived-children-disappear-from-the-default-list",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-default-archive");
                await archiveAndWait(gym, child);
                const active = (await gym.client.listWorkspaces({ projectId: root.id })).workspaces;
                expect(active.some((workspace) => workspace.id === child.id)).toBe(false);
            },
        },
        {
            id: "workspace-tree-017-include-archived-returns-the-archived-child",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-history-archive");
                await archiveAndWait(gym, child);
                const history = (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId: root.id,
                    })
                ).workspaces;
                expect(history.find((workspace) => workspace.id === child.id)?.status).toBe(
                    "archived",
                );
            },
        },
        {
            id: "workspace-tree-018-archives-a-parent-and-its-descendant",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const parent = await createChild(gym, root.id, "tree-archive-parent");
                const descendant = await createChild(gym, parent.id, "tree-archive-descendant");
                await archiveAndWait(gym, parent);
                expect((await getWithHistory(gym, parent.id)).status).toBe("archived");
                expect((await getWithHistory(gym, descendant.id)).status).toBe("archived");
            },
        },
        {
            id: "workspace-tree-019-archiving-a-child-leaves-the-root-active",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-root-survives");
                await archiveAndWait(gym, child);
                expect((await gym.client.getWorkspace(root.id)).workspace.status).toBe("active");
            },
        },
        {
            id: "workspace-tree-020-preserves-the-tree-across-a-daemon-restart",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const parent = await createChild(gym, root.id, "tree-restart-parent");
                const child = await createChild(gym, parent.id, "tree-restart-child");
                await gym.restart();
                const restarted = await getWithHistory(gym, child.id);
                expect(restarted.parentId).toBe(parent.id);
                expect(restarted.projectId).toBe(root.projectId);
                expect((await gym.client.getWorkspace(parent.id)).workspace.status).toBe("active");
            },
        },
        {
            id: "workspace-tree-021-keeps-parentage-acyclic-and-project-local",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const first = await createChild(gym, root.id, "tree-acyclic-first");
                const second = await createChild(gym, first.id, "tree-acyclic-second");
                const all = (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId: root.id,
                    })
                ).workspaces;
                const byId = new Map(all.map((workspace) => [workspace.id, workspace]));
                let current: Workspace | undefined = second;
                const seen = new Set<string>();
                while (current !== undefined && current.parentId !== null) {
                    expect(seen.has(current.id)).toBe(false);
                    seen.add(current.id);
                    current = byId.get(current.parentId);
                }
                expect(current?.id).toBe(root.id);
            },
        },
        {
            id: "workspace-tree-022-child-creation-is-visible-through-a-fresh-read",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "tree-fresh-read");
                const fetched = (await gym.client.getWorkspace(child.id)).workspace;
                expect(fetched).toEqual(child);
                expect(
                    (await gym.client.listWorkspaces({ projectId: root.id })).workspaces.some(
                        (candidate) => candidate.id === child.id,
                    ),
                ).toBe(true);
            },
        },
    ])(
        "$id",
        async ({ run }) => {
            const gym = await createAgentGym();
            gyms.add(gym);
            await run(gym);
        },
        timeout,
    );
});

async function rootWorkspace(gym: AgentGym): Promise<Workspace> {
    const projects = await gym.client.listProjects();
    const project = projects.projects.find((candidate) =>
        candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
    );
    if (project === undefined) throw new Error("No project owns the default gym agent.");
    return await waitReady(gym, project.id);
}

async function createChild(
    gym: AgentGym,
    parentId: string,
    name: string,
    options: { readonly agentId?: string } = {},
): Promise<Workspace> {
    const created = await gym.client.createWorkspace({
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        mutationId: `tree-create-${name}`,
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
                        workspace.initialization.error ?? "workspace initialization failed",
                    );
                }
                return workspace.initialization.status === "ready" ? workspace : undefined;
            } catch (error: unknown) {
                if (isApiError(error) && error.status === 409) return undefined;
                throw error;
            }
        },
        `workspace ${workspaceId} to become ready`,
        30_000,
    );
}

async function archiveAndWait(gym: AgentGym, workspace: Workspace): Promise<Workspace> {
    const response = await gym.client.archiveWorkspace(workspace.id, {
        ifMatch: workspace.version,
        mutationId: `tree-archive-${workspace.id}`,
    });
    expect(["archiving", "archived"]).toContain(response.workspace.status);
    const workspaceProjectId = workspace.projectId;
    if (workspaceProjectId === null) {
        throw new Error(`Workspace ${workspace.id} unexpectedly belongs to no project.`);
    }
    return await gym.waitUntil(
        async () => {
            const candidate = (
                await gym.client.listWorkspaces({
                    includeArchived: true,
                    projectId: workspaceProjectId,
                })
            ).workspaces.find((item) => item.id === workspace.id);
            return candidate?.status === "archived" ? candidate : undefined;
        },
        `workspace ${workspace.id} to archive`,
        30_000,
    );
}

async function getWithHistory(gym: AgentGym, workspaceId: string): Promise<Workspace> {
    const workspace = (await gym.client.listWorkspaces({ includeArchived: true })).workspaces.find(
        (candidate) => candidate.id === workspaceId,
    );
    if (workspace === undefined) throw new Error(`Workspace ${workspaceId} was not listed.`);
    return workspace;
}

function isApiError(error: unknown): error is { readonly status: number } {
    return (
        error instanceof Error &&
        typeof (error as { readonly status?: unknown }).status === "number"
    );
}
