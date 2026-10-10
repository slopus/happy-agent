import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type Project = Awaited<ReturnType<AgentGym["client"]["getProject"]>>["project"];
type Scenario = {
    readonly id: string;
    readonly run: (gym: AgentGym) => Promise<void>;
};

const gyms = new Set<AgentGym>();
const timeout = 45_000;

describe("public project lifecycle matrix", () => {
    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it.each<Scenario>([
        {
            id: "project-lifecycle-001-root-project-is-the-root-workspace",
            run: async (gym) => {
                const project = await rootProject(gym);
                const workspaces = await gym.client.listWorkspaces({
                    includeArchived: true,
                    projectId: project.id,
                });
                expect(project.id).toBe(workspaces.workspaces[0]?.id);
                expect(project.id).toBe(project.id);
                expect(workspaces.workspaces[0]).toMatchObject({
                    id: project.id,
                    kind: "root",
                    parentId: null,
                    projectId: project.id,
                });
            },
        },
        {
            id: "project-lifecycle-002-registers-a-client-named-plain-folder",
            run: async (gym) => {
                const project = await register(gym, "client-named", "clientnamedproject");
                expect(project.id).toBe("clientnamedproject");
                expect(project.initialization.status).toBe("ready");
                expect(project.remoteSource).toBeNull();
                expect(project.git).toBeNull();
            },
        },
        {
            id: "project-lifecycle-003-replays-an-identical-client-project-id",
            run: async (gym) => {
                const path = await projectPath(gym, "replay");
                const first = (
                    await gym.client.registerProject({
                        path,
                        projectId: "replayproject",
                        mutationId: "replay-first",
                    })
                ).project;
                const second = (
                    await gym.client.registerProject({
                        path,
                        projectId: "replayproject",
                        mutationId: "replay-second",
                    })
                ).project;
                expect(second.id).toBe(first.id);
                expect(
                    (await gym.client.listProjects()).projects.filter(
                        (candidate) => candidate.id === first.id,
                    ),
                ).toHaveLength(1);
            },
        },
        {
            id: "project-lifecycle-004-rejects-reusing-a-project-id-for-another-folder",
            run: async (gym) => {
                const first = await register(gym, "first-id-folder", "sharedprojectid");
                const other = await projectPath(gym, "other-id-folder");
                await expect(
                    gym.client.registerProject({
                        path: other,
                        projectId: first.id,
                    }),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
                expect((await gym.client.getProject(first.id)).project.name).toBe(first.name);
            },
        },
        {
            id: "project-lifecycle-005-reuses-an-already-registered-folder",
            run: async (gym) => {
                const path = await projectPath(gym, "same-folder");
                const first = (await gym.client.registerProject({ path })).project;
                const second = (await gym.client.registerProject({ path })).project;
                expect(second.id).toBe(first.id);
                expect(
                    (await gym.client.listProjects()).projects.filter(
                        (candidate) => candidate.id === first.id,
                    ),
                ).toHaveLength(1);
            },
        },
        {
            id: "project-lifecycle-006-rejects-a-missing-registration-path",
            run: async (gym) => {
                await expect(
                    gym.client.registerProject({
                        path: join(gym.workspacePath, "projects", "missing"),
                    }),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
            },
        },
        {
            id: "project-lifecycle-007-rejects-a-file-as-a-registration-path",
            run: async (gym) => {
                const path = join(gym.workspacePath, "projects", "not-a-directory");
                await mkdir(join(gym.workspacePath, "projects"), { recursive: true });
                await writeFile(path, "not a directory", "utf8");
                await expect(gym.client.registerProject({ path })).rejects.toMatchObject({
                    code: "invalid_request",
                    status: 400,
                });
            },
        },
        {
            id: "project-lifecycle-008-renames-a-project-with-the-current-version",
            run: async (gym) => {
                const project = await register(gym, "rename-current", "renamecurrentproject");
                const renamed = await gym.client.renameProject(
                    project.id,
                    { name: "A user project", mutationId: "rename-current" },
                    { ifMatch: project.version },
                );
                expect(renamed.project).toMatchObject({
                    id: project.id,
                    name: "A user project",
                    nameSource: "user",
                    status: "active",
                });
                expect(renamed.project.version).not.toBe(project.version);
            },
        },
        {
            id: "project-lifecycle-009-rejects-a-rename-without-if-match",
            run: async (gym) => {
                const project = await register(gym, "rename-missing-guard", "renamemissingguard");
                await expect(
                    gym.client.renameProject(
                        project.id,
                        { name: "must not apply" },
                        { ifMatch: "" },
                    ),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
                expect((await gym.client.getProject(project.id)).project).toEqual(project);
            },
        },
        {
            id: "project-lifecycle-010-rejects-a-malformed-project-version",
            run: async (gym) => {
                const project = await register(gym, "rename-malformed", "renamemalformedproject");
                await expect(
                    gym.client.renameProject(
                        project.id,
                        { name: "must not apply" },
                        { ifMatch: "not-a-resource-version" },
                    ),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
                expect((await gym.client.getProject(project.id)).project).toEqual(project);
            },
        },
        {
            id: "project-lifecycle-011-rejects-a-stale-project-version-authoritatively",
            run: async (gym) => {
                const project = await register(gym, "rename-stale", "renamestaleproject");
                const current = (
                    await gym.client.renameProject(
                        project.id,
                        { name: "first writer" },
                        { ifMatch: project.version },
                    )
                ).project;
                await expect(
                    gym.client.renameProject(
                        project.id,
                        { name: "stale writer" },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({
                    body: expect.objectContaining({
                        currentVersion: current.version,
                    }),
                    code: "conflict",
                    status: 409,
                });
                expect((await gym.client.getProject(project.id)).project).toEqual(current);
            },
        },
        {
            id: "project-lifecycle-012-replaces-settings-with-host-compute",
            run: async (gym) => {
                const project = await register(gym, "settings-host", "settingshostproject");
                const response = await gym.client.replaceProjectSettings(
                    project.id,
                    {
                        defaultWorkspaceCompute: { type: "host" },
                        mutationId: "settings-host",
                    },
                    { ifMatch: project.version },
                );
                expect(response.settings.defaultWorkspaceCompute).toEqual({ type: "host" });
                expect(response.project.version).not.toBe(project.version);
            },
        },
        {
            id: "project-lifecycle-013-replaces-settings-with-docker-selection",
            run: async (gym) => {
                const project = await register(gym, "settings-docker", "settingsdockerproject");
                const response = await gym.client.replaceProjectSettings(
                    project.id,
                    {
                        defaultWorkspaceCompute: {
                            image: "gym/matrix:latest",
                            type: "docker",
                        },
                        mutationId: "settings-docker",
                    },
                    { ifMatch: project.version },
                );
                expect(response.settings.defaultWorkspaceCompute).toEqual({
                    image: "gym/matrix:latest",
                    type: "docker",
                });
                expect(response.project.settings).toEqual(response.settings);
            },
        },
        {
            id: "project-lifecycle-014-refreshes-a-ready-project-and-increments-attempt",
            run: async (gym) => {
                const project = await register(gym, "refresh-ready", "refreshreadyproject");
                const response = await gym.client.refreshProject(project.id);
                expect(response.project.initialization.status).toBe("initializing");
                const refreshed = await waitForProject(gym, project.id);
                expect(refreshed.initialization.status).toBe("ready");
                expect(refreshed.initialization.attempt).toBeGreaterThan(
                    project.initialization.attempt,
                );
            },
        },
        {
            id: "project-lifecycle-015-settles-refresh-of-a-removed-folder-as-failed",
            run: async (gym) => {
                const path = await projectPath(gym, "removed-before-refresh");
                const project = (await gym.client.registerProject({ path })).project;
                await waitForProject(gym, project.id);
                await rm(path, { recursive: true, force: true });
                await gym.client.refreshProject(project.id);
                const failed = await gym.waitUntil(async () => {
                    const current = (await gym.client.getProject(project.id)).project;
                    return current.initialization.status === "failed" ? current : undefined;
                }, "removed project refresh failure");
                expect(failed.initialization.error).toEqual(expect.any(String));
                expect(failed.status).toBe("active");
            },
        },
        {
            id: "project-lifecycle-016-orders-three-projects-by-moving-the-last-first",
            run: async (gym) => {
                const one = await register(gym, "order-one", "orderoneproject");
                const two = await register(gym, "order-two", "ordertwoproject");
                const three = await register(gym, "order-three", "orderthreeproject");
                const moved = (
                    await gym.client.reorderProject(
                        three.id,
                        { afterId: null, mutationId: "order-last-first" },
                        { ifMatch: three.version },
                    )
                ).project;
                const ids = (await gym.client.listProjects()).projects.map(
                    (candidate) => candidate.id,
                );
                expect(ids.indexOf(moved.id)).toBe(0);
                expect(ids).toContain(one.id);
                expect(ids).toContain(two.id);
            },
        },
        {
            id: "project-lifecycle-017-reorders-a-project-after-a-specific-neighbour",
            run: async (gym) => {
                const first = await register(gym, "after-one", "afteroneproject");
                const second = await register(gym, "after-two", "aftertwoproject");
                const third = await register(gym, "after-three", "afterthreeproject");
                const current = (await gym.client.getProject(first.id)).project;
                await gym.client.reorderProject(
                    first.id,
                    { afterId: third.id, mutationId: "order-after-neighbour" },
                    { ifMatch: current.version },
                );
                const ids = (await gym.client.listProjects()).projects.map(
                    (candidate) => candidate.id,
                );
                expect(ids.indexOf(first.id)).toBeGreaterThan(ids.indexOf(third.id));
                expect(ids).toContain(second.id);
            },
        },
        {
            id: "project-lifecycle-018-rejects-a-reorder-with-a-missing-neighbour",
            run: async (gym) => {
                const project = await register(gym, "order-missing", "ordermissingproject");
                await expect(
                    gym.client.reorderProject(
                        project.id,
                        { afterId: "neighbour-does-not-exist" },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({ status: expect.any(Number) });
                expect((await gym.client.getProject(project.id)).project).toEqual(project);
            },
        },
        {
            id: "project-lifecycle-019-archives-a-project-and-exposes-it-when-requested",
            run: async (gym) => {
                const project = await register(gym, "archive-project", "archiveproject");
                const archived = (
                    await gym.client.archiveProject(project.id, {
                        ifMatch: project.version,
                        mutationId: "archive-project",
                    })
                ).project;
                expect(archived.status).toBe("archived");
                expect(archived.archivedAt).toEqual(expect.any(Number));
                const listed = await gym.client.listProjects();
                expect(
                    listed.projects.find((candidate) => candidate.id === project.id)?.status,
                ).toBe("archived");
            },
        },
        {
            id: "project-lifecycle-020-revives-an-archived-project-by-registering-its-folder",
            run: async (gym) => {
                const path = await projectPath(gym, "revive-project");
                const project = await waitForProject(
                    gym,
                    (await gym.client.registerProject({ path })).project.id,
                );
                const archived = (
                    await gym.client.archiveProject(project.id, {
                        ifMatch: project.version,
                        mutationId: "archive-before-revive",
                    })
                ).project;
                const revived = (
                    await gym.client.registerProject({
                        path,
                        projectId: project.id,
                        mutationId: "revive-project",
                    })
                ).project;
                expect(archived.status).toBe("archived");
                expect(revived.status).toBe("active");
                expect(revived.version).not.toBe(archived.version);
            },
        },
        {
            id: "project-lifecycle-021-preserves-project-order-and-state-across-restart",
            run: async (gym) => {
                const first = await register(gym, "restart-first", "restartfirstproject");
                const second = await register(gym, "restart-second", "restartsecondproject");
                const moved = (
                    await gym.client.reorderProject(
                        second.id,
                        { afterId: null, mutationId: "restart-order" },
                        { ifMatch: second.version },
                    )
                ).project;
                const archived = (
                    await gym.client.archiveProject(first.id, {
                        ifMatch: first.version,
                        mutationId: "restart-archive",
                    })
                ).project;
                await gym.restart();
                const projects = (await gym.client.listProjects()).projects;
                expect(projects.find((candidate) => candidate.id === moved.id)?.orderKey).toBe(
                    moved.orderKey,
                );
                expect(projects.find((candidate) => candidate.id === archived.id)?.status).toBe(
                    "archived",
                );
            },
        },
        {
            id: "project-lifecycle-022-keeps-a-project-usable-after-an-invalid-mutation",
            run: async (gym) => {
                const project = await register(gym, "failure-recovery", "failurerecoveryproject");
                await expect(
                    gym.client.renameProject(
                        project.id,
                        { name: "" },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({ status: expect.any(Number) });
                const current = (await gym.client.getProject(project.id)).project;
                expect(current.id).toBe(project.id);
                expect(current.version).toBe(project.version);
                const valid = await gym.client.renameProject(
                    project.id,
                    { name: "Recovered project" },
                    { ifMatch: current.version },
                );
                expect(valid.project.name).toBe("Recovered project");
            },
        },
    ])(
        "$id",
        async ({ run }) => {
            const gym = await createAgentGym({ timeoutMs: 15_000 });
            gyms.add(gym);
            await run(gym);
        },
        timeout,
    );
});

async function projectPath(gym: AgentGym, name: string): Promise<string> {
    const path = join(gym.workspacePath, "projects", name);
    await mkdir(path, { recursive: true });
    return path;
}

async function register(gym: AgentGym, name: string, id: string): Promise<Project> {
    const path = await projectPath(gym, name);
    return await waitForProject(
        gym,
        (await gym.client.registerProject({ path, projectId: id })).project.id,
    );
}

async function rootProject(gym: AgentGym): Promise<Project> {
    const projects = await gym.client.listProjects();
    const project = projects.projects[0];
    if (project === undefined) throw new Error("The gym did not expose its root project.");
    return await waitForProject(gym, project.id);
}

async function waitForProject(gym: AgentGym, projectId: string): Promise<Project> {
    return await gym.waitUntil(
        async () => {
            const project = (await gym.client.getProject(projectId)).project;
            if (project.initialization.status === "failed") {
                throw new Error(project.initialization.error ?? "Project initialization failed.");
            }
            return project.initialization.status === "ready" ? project : undefined;
        },
        `project ${projectId} to be ready`,
        30_000,
    );
}
