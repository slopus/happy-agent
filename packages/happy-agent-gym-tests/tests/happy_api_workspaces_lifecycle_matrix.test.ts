import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";

type Workspace = Awaited<ReturnType<AgentGym["client"]["getWorkspace"]>>["workspace"];
type Scenario = {
    readonly id: string;
    readonly run: (gym: AgentGym) => Promise<void>;
};
type CapturedResult = { readonly workspace: Workspace } | { readonly status: number };

const timeout = 45_000;
const gyms = new Set<AgentGym>();

describe("public workspace lifecycle matrix", () => {
    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it.each<Scenario>([
        {
            id: "workspace-lifecycle-001-renames-with-the-current-version",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-rename");
                const response = await gym.client.renameWorkspace(
                    child.id,
                    { mutationId: "lifecycle-rename-current", name: "renamed-current" },
                    { ifMatch: child.version },
                );
                expect(response.workspace.name).toBe("renamed-current");
                expect(response.workspace.nameSource).toBe("user");
                expect(response.workspace.version).not.toBe(child.version);
            },
        },
        {
            id: "workspace-lifecycle-002-rename-version-is-readable-after-the-write",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-rename-read");
                const updated = (
                    await gym.client.renameWorkspace(
                        child.id,
                        { name: "read-after-rename", mutationId: "lifecycle-rename-read" },
                        { ifMatch: child.version },
                    )
                ).workspace;
                expect((await gym.client.getWorkspace(child.id)).workspace).toEqual(updated);
            },
        },
        {
            id: "workspace-lifecycle-003-rejects-a-rename-without-if-match",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-rename-missing");
                await expect(
                    gym.client.renameWorkspace(
                        child.id,
                        { name: "must-not-apply" },
                        { ifMatch: "" },
                    ),
                ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
                expect((await gym.client.getWorkspace(child.id)).workspace).toEqual(child);
            },
        },
        {
            id: "workspace-lifecycle-004-rejects-a-malformed-version",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-rename-malformed");
                await expect(
                    gym.client.renameWorkspace(
                        child.id,
                        { name: "must-not-apply" },
                        { ifMatch: "not-a-resource-version" },
                    ),
                ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
                expect((await gym.client.getWorkspace(child.id)).workspace.name).toBe(child.name);
            },
        },
        {
            id: "workspace-lifecycle-005-reports-the-current-resource-on-a-stale-rename",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-rename-stale");
                const current = (
                    await gym.client.renameWorkspace(
                        child.id,
                        { name: "first-writer" },
                        { ifMatch: child.version },
                    )
                ).workspace;
                await expect(
                    gym.client.renameWorkspace(
                        child.id,
                        { name: "stale-writer" },
                        { ifMatch: child.version },
                    ),
                ).rejects.toMatchObject({
                    status: 409,
                    code: "conflict",
                    body: expect.objectContaining({
                        currentVersion: current.version,
                        workspace: expect.objectContaining({ name: current.name }),
                    }),
                });
            },
        },
        {
            id: "workspace-lifecycle-006-concurrent-renames-have-one-versioned-winner",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-rename-race");
                const results = await Promise.all(
                    ["race-a", "race-b"].map(async (name) =>
                        capture(() =>
                            gym.client.renameWorkspace(
                                child.id,
                                { name },
                                { ifMatch: child.version },
                            ),
                        ),
                    ),
                );
                expect(results.filter((result) => "workspace" in result)).toHaveLength(1);
                expect(results.filter((result) => "status" in result)).toHaveLength(1);
                expect((await gym.client.getWorkspace(child.id)).workspace.version).not.toBe(
                    child.version,
                );
            },
        },
        {
            id: "workspace-lifecycle-007-reorders-a-sibling-after-its-neighbour",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const first = await createChild(gym, root.id, "lifecycle-order-first");
                const second = await createChild(gym, root.id, "lifecycle-order-second");
                const moved = (
                    await gym.client.reorderWorkspace(
                        first.id,
                        { afterId: second.id, mutationId: "lifecycle-order-after" },
                        { ifMatch: first.version },
                    )
                ).workspace;
                const siblings = await siblingsOf(gym, root.id);
                expect(siblings.map((workspace) => workspace.id).slice(-2)).toEqual([
                    second.id,
                    first.id,
                ]);
                expect(moved.orderKey).not.toBe(first.orderKey);
            },
        },
        {
            id: "workspace-lifecycle-008-moves-the-last-sibling-to-the-front",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                await createChild(gym, root.id, "lifecycle-front-first");
                await createChild(gym, root.id, "lifecycle-front-second");
                await createChild(gym, root.id, "lifecycle-front-third");
                const before = await siblingsOf(gym, root.id);
                const moving = before.at(-1);
                if (moving === undefined) throw new Error("No last sibling to move.");
                await gym.client.reorderWorkspace(
                    moving.id,
                    { afterId: null, mutationId: "lifecycle-order-front" },
                    { ifMatch: moving.version },
                );
                const siblings = await siblingsOf(gym, root.id);
                expect(siblings[0]?.id).toBe(moving.id);
                expect(new Set(siblings.map((item) => item.id))).toEqual(
                    new Set(before.map((item) => item.id)),
                );
            },
        },
        {
            id: "workspace-lifecycle-009-moves-the-front-sibling-to-the-end",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                await createChild(gym, root.id, "lifecycle-end-first");
                await createChild(gym, root.id, "lifecycle-end-second");
                await createChild(gym, root.id, "lifecycle-end-third");
                const before = await siblingsOf(gym, root.id);
                const moving = before[0];
                const after = before.at(-1);
                if (moving === undefined || after === undefined || moving.id === after.id) {
                    throw new Error("Not enough distinct siblings to reorder.");
                }
                await gym.client.reorderWorkspace(
                    moving.id,
                    { afterId: after.id, mutationId: "lifecycle-order-end" },
                    { ifMatch: moving.version },
                );
                const siblings = await siblingsOf(gym, root.id);
                expect(siblings.at(-1)?.id).toBe(moving.id);
                expect(new Set(siblings.map((item) => item.id))).toEqual(
                    new Set(before.map((item) => item.id)),
                );
            },
        },
        {
            id: "workspace-lifecycle-010-a-no-op-reorder-keeps-the-resource-version",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-order-noop");
                const before = (await gym.client.getWorkspace(child.id)).workspace;
                const response = (
                    await gym.client.reorderWorkspace(
                        child.id,
                        { afterId: null, mutationId: "lifecycle-order-noop" },
                        { ifMatch: before.version },
                    )
                ).workspace;
                expect(response.version).toBe(before.version);
                expect(response.orderKey).toBe(before.orderKey);
            },
        },
        {
            id: "workspace-lifecycle-011-rejects-a-cross-parent-neighbour",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const firstParent = await createChild(gym, root.id, "lifecycle-parent-one");
                const secondParent = await createChild(gym, root.id, "lifecycle-parent-two");
                const child = await createChild(gym, firstParent.id, "lifecycle-cross-child");
                await expect(
                    gym.client.reorderWorkspace(
                        child.id,
                        { afterId: secondParent.id },
                        { ifMatch: child.version },
                    ),
                ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
            },
        },
        {
            id: "workspace-lifecycle-012-rejects-renaming-the-root-workspace",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                await expect(
                    gym.client.renameWorkspace(
                        root.id,
                        { name: "cannot-rename-root" },
                        { ifMatch: root.version },
                    ),
                ).rejects.toMatchObject({ status: 409, code: "conflict" });
            },
        },
        {
            id: "workspace-lifecycle-013-rejects-reordering-the-root-workspace",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                await expect(
                    gym.client.reorderWorkspace(
                        root.id,
                        { afterId: null },
                        { ifMatch: root.version },
                    ),
                ).rejects.toMatchObject({ status: 409, code: "conflict" });
            },
        },
        {
            id: "workspace-lifecycle-014-rejects-archiving-the-root-workspace",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                await expect(
                    gym.client.archiveWorkspace(root.id, { ifMatch: root.version }),
                ).rejects.toMatchObject({ status: 409, code: "conflict" });
                expect((await gym.client.getWorkspace(root.id)).workspace.status).toBe("active");
            },
        },
        {
            id: "workspace-lifecycle-015-archives-a-ready-child",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-archive-ready");
                const response = (
                    await gym.client.archiveWorkspace(child.id, {
                        ifMatch: child.version,
                        mutationId: "lifecycle-archive-ready",
                    })
                ).workspace;
                expect(["archiving", "archived"]).toContain(response.status);
                const archived = await waitArchived(gym, child.id);
                expect(archived.archivedAt).not.toBeNull();
            },
        },
        {
            id: "workspace-lifecycle-016-rejects-archiving-with-a-stale-version",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-archive-stale");
                const current = (
                    await gym.client.renameWorkspace(
                        child.id,
                        { name: "archive-current" },
                        { ifMatch: child.version },
                    )
                ).workspace;
                await expect(
                    gym.client.archiveWorkspace(child.id, { ifMatch: child.version }),
                ).rejects.toMatchObject({
                    status: 409,
                    code: "conflict",
                    body: expect.objectContaining({ currentVersion: current.version }),
                });
                expect((await gym.client.getWorkspace(child.id)).workspace.status).toBe("active");
            },
        },
        {
            id: "workspace-lifecycle-017-archives-a-subtree-deepest-first",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const parent = await createChild(gym, root.id, "lifecycle-subtree-parent");
                const child = await createChild(gym, parent.id, "lifecycle-subtree-child");
                await gym.client.archiveWorkspace(parent.id, {
                    ifMatch: parent.version,
                    mutationId: "lifecycle-subtree-archive",
                });
                expect((await waitArchived(gym, parent.id)).status).toBe("archived");
                expect((await waitArchived(gym, child.id)).status).toBe("archived");
                expect((await gym.client.getWorkspace(root.id)).workspace.status).toBe("active");
            },
        },
        {
            id: "workspace-lifecycle-018-default-list-hides-an-archived-subtree",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const parent = await createChild(gym, root.id, "lifecycle-hidden-parent");
                const child = await createChild(gym, parent.id, "lifecycle-hidden-child");
                await gym.client.archiveWorkspace(parent.id, { ifMatch: parent.version });
                await waitArchived(gym, child.id);
                const active = (await gym.client.listWorkspaces({ projectId: root.id })).workspaces;
                expect(active.some((workspace) => workspace.id === parent.id)).toBe(false);
                expect(active.some((workspace) => workspace.id === child.id)).toBe(false);
            },
        },
        {
            id: "workspace-lifecycle-019-history-list-retains-archived-parentage",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const parent = await createChild(gym, root.id, "lifecycle-history-parent");
                const child = await createChild(gym, parent.id, "lifecycle-history-child");
                await gym.client.archiveWorkspace(parent.id, { ifMatch: parent.version });
                await waitArchived(gym, child.id);
                const history = (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId: root.id,
                    })
                ).workspaces;
                expect(history.find((workspace) => workspace.id === child.id)?.parentId).toBe(
                    parent.id,
                );
            },
        },
        {
            id: "workspace-lifecycle-020-archive-and-rename-state-survive-restart",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await createChild(gym, root.id, "lifecycle-restart-state");
                const renamed = (
                    await gym.client.renameWorkspace(
                        child.id,
                        { name: "restart-state-renamed" },
                        { ifMatch: child.version },
                    )
                ).workspace;
                await gym.client.archiveWorkspace(child.id, { ifMatch: renamed.version });
                await waitArchived(gym, child.id);
                await gym.restart();
                const persisted = await workspaceFromHistory(gym, child.id);
                expect(persisted.name).toBe("restart-state-renamed");
                expect(persisted.status).toBe("archived");
            },
        },
        {
            id: "workspace-lifecycle-021-client-id-creation-is-durable-through-restart",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const created = (
                    await gym.client.createWorkspace({
                        id: "lifecycledurableworkspace",
                        name: "durable-client-id",
                        parentId: root.id,
                    })
                ).workspace;
                const ready = await waitReady(gym, created.id);
                await gym.restart();
                const fetched = (await gym.client.getWorkspace(ready.id)).workspace;
                expect(fetched.id).toBe("lifecycledurableworkspace");
                expect(fetched.name).toBe("durable-client-id");
            },
        },
        {
            id: "workspace-lifecycle-022-concurrent-reorders-leave-one-valid-order",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const first = await createChild(gym, root.id, "lifecycle-race-first");
                const second = await createChild(gym, root.id, "lifecycle-race-second");
                const results = await Promise.all(
                    [null, second.id].map(async (afterId) =>
                        capture(() =>
                            gym.client.reorderWorkspace(
                                first.id,
                                { afterId },
                                { ifMatch: first.version },
                            ),
                        ),
                    ),
                );
                expect(results.filter((result) => "workspace" in result)).toHaveLength(1);
                expect(results.filter((result) => "status" in result)).toHaveLength(1);
                const siblings = await siblingsOf(gym, root.id);
                expect(new Set(siblings.map((workspace) => workspace.id))).toEqual(
                    new Set([first.id, second.id]),
                );
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

async function createChild(gym: AgentGym, parentId: string, name: string): Promise<Workspace> {
    const response = await gym.client.createWorkspace({
        mutationId: `lifecycle-create-${name}`,
        name,
        parentId,
    });
    return await waitReady(gym, response.workspace.id);
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

async function siblingsOf(gym: AgentGym, parentId: string): Promise<Workspace[]> {
    const parentProjectId = (await gym.client.getWorkspace(parentId)).workspace.projectId;
    if (parentProjectId === null) {
        throw new Error(`Workspace ${parentId} unexpectedly belongs to no project.`);
    }
    return (
        await gym.client.listWorkspaces({
            includeArchived: true,
            projectId: parentProjectId,
        })
    ).workspaces
        .filter((workspace) => workspace.parentId === parentId && workspace.status === "active")
        .sort((left, right) => left.orderKey.localeCompare(right.orderKey));
}

async function waitArchived(gym: AgentGym, workspaceId: string): Promise<Workspace> {
    return await gym.waitUntil(
        async () => {
            const workspace = (
                await gym.client.listWorkspaces({ includeArchived: true })
            ).workspaces.find((candidate) => candidate.id === workspaceId);
            return workspace?.status === "archived" ? workspace : undefined;
        },
        `workspace ${workspaceId} to be archived`,
        30_000,
    );
}

async function workspaceFromHistory(gym: AgentGym, workspaceId: string): Promise<Workspace> {
    const workspace = (await gym.client.listWorkspaces({ includeArchived: true })).workspaces.find(
        (candidate) => candidate.id === workspaceId,
    );
    if (workspace === undefined) throw new Error(`Workspace ${workspaceId} was not listed.`);
    return workspace;
}

async function capture(operation: () => Promise<unknown>): Promise<CapturedResult> {
    try {
        return (await operation()) as CapturedResult;
    } catch (error: unknown) {
        if (
            error instanceof Error &&
            typeof (error as { readonly status?: unknown }).status === "number"
        ) {
            return error as Error & { readonly status: number };
        }
        throw error;
    }
}

function isApiError(error: unknown): error is { readonly status: number } {
    return (
        error instanceof Error &&
        typeof (error as { readonly status?: unknown }).status === "number"
    );
}
