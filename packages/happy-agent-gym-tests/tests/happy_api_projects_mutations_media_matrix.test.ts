import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type Project = Awaited<ReturnType<AgentGym["client"]["getProject"]>>["project"];
type Scenario = {
    readonly id: string;
    readonly run: (gym: AgentGym) => Promise<void>;
};

const PNG_1X1 = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);
const PNG_2 = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAARklEQVRIDe3SsQkAMAwDQQVcZP9ZMmDwBF+pe+NS2HDoJO8mvZ293RwfoK5EEqEABmyRRCiAAVskEQpgwBZJhAIYsEVI9AH7IAMiyextiAAAAABJRU5ErkJggg==",
        "base64",
    ),
);
const gyms = new Set<AgentGym>();
const timeout = 45_000;

describe("public project mutation and media matrix", () => {
    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it.each<Scenario>([
        {
            id: "project-media-001-uploads-png-and-publishes-image-metadata",
            run: async (gym) => {
                const project = await register(gym, "avatar-png", "avatarpngproject");
                const response = await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: project.version },
                );
                expect(response.project.avatar).toMatchObject({
                    kind: "image",
                    source: "user",
                });
                expect(response.project.avatar?.kind).toBe("image");
                if (response.project.avatar?.kind !== "image") throw new Error("Missing avatar.");
                expect(response.project.avatar.thumbhash.length).toBeGreaterThan(0);
            },
        },
        {
            id: "project-media-002-serves-canonical-webp-bytes-and-an-etag",
            run: async (gym) => {
                const project = await register(gym, "avatar-webp", "avatarwebpproject");
                await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: project.version },
                );
                const image = await gym.client.getProjectAvatar(project.id);
                expect(image).toMatchObject({
                    contentType: "image/webp",
                    etag: expect.stringMatching(/^".+"$/),
                });
                expect(image?.data.byteLength).toBeGreaterThan(0);
            },
        },
        {
            id: "project-media-003-returns-not-modified-for-a-matching-etag",
            run: async (gym) => {
                const project = await register(gym, "avatar-conditional", "avatarconditional");
                await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: project.version },
                );
                const image = await gym.client.getProjectAvatar(project.id);
                await expect(
                    gym.client.getProjectAvatar(project.id, {
                        ifNoneMatch: image?.etag ?? undefined,
                    }),
                ).resolves.toBeNull();
            },
        },
        {
            id: "project-media-004-changes-the-etag-when-an-avatar-is-replaced",
            run: async (gym) => {
                const project = await register(gym, "avatar-replace", "avatarreplaceproject");
                const first = await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: project.version },
                );
                const firstImage = await gym.client.getProjectAvatar(project.id);
                const second = await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_2 },
                    { ifMatch: first.project.version },
                );
                const secondImage = await gym.client.getProjectAvatar(project.id);
                expect(second.project.version).not.toBe(first.project.version);
                expect(secondImage?.etag).not.toBe(firstImage?.etag);
            },
        },
        {
            id: "project-media-005-deletes-an-avatar-with-the-current-version",
            run: async (gym) => {
                const project = await register(gym, "avatar-delete", "avatardeleteproject");
                const withAvatar = await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: project.version },
                );
                const deleted = await gym.client.deleteProjectAvatar(project.id, {
                    ifMatch: withAvatar.project.version,
                });
                expect(deleted.project.avatar).toBeNull();
                await expect(gym.client.getProjectAvatar(project.id)).rejects.toMatchObject({
                    code: "not_found",
                    status: 404,
                });
            },
        },
        {
            id: "project-media-006-rejects-stale-avatar-updates-with-current-resource",
            run: async (gym) => {
                const project = await register(gym, "avatar-stale", "avatarstaleproject");
                const current = await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: project.version },
                );
                await expect(
                    gym.client.setProjectAvatar(
                        project.id,
                        { contentType: "image/png", data: PNG_1X1 },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({
                    body: expect.objectContaining({
                        currentVersion: current.project.version,
                        project: current.project,
                    }),
                    code: "conflict",
                    status: 409,
                });
            },
        },
        {
            id: "project-media-007-rejects-an-empty-avatar-if-match",
            run: async (gym) => {
                const project = await register(gym, "avatar-empty-guard", "avatarguardproject");
                await expect(
                    gym.client.setProjectAvatar(
                        project.id,
                        { contentType: "image/png", data: PNG_1X1 },
                        { ifMatch: "" },
                    ),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
                expect((await gym.client.getProject(project.id)).project).toEqual(project);
            },
        },
        {
            id: "project-media-008-rejects-an-invalid-avatar-content-type",
            run: async (gym) => {
                const project = await register(gym, "avatar-invalid-type", "avatarinvalidtype");
                await expect(
                    gym.client.setProjectAvatar(
                        project.id,
                        { contentType: "text/plain", data: PNG_1X1 } as never,
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
            },
        },
        {
            id: "project-media-009-rejects-invalid-avatar-bytes-without-changing-project",
            run: async (gym) => {
                const project = await register(gym, "avatar-invalid-bytes", "avatarinvalidbytes");
                await expect(
                    gym.client.setProjectAvatar(
                        project.id,
                        { contentType: "image/png", data: new Uint8Array([1, 2, 3]) },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
                expect((await gym.client.getProject(project.id)).project).toEqual(project);
            },
        },
        {
            id: "project-media-010-rejects-an-avatar-over-the-eight-megabyte-limit",
            run: async (gym) => {
                const project = await register(gym, "avatar-too-large", "avatartoolargeproject");
                const bytes = new Uint8Array(8 * 1024 * 1024 + 1);
                await expect(
                    gym.client.setProjectAvatar(
                        project.id,
                        { contentType: "image/png", data: bytes },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({ code: "too_large", status: 413 });
            },
        },
        {
            id: "project-media-011-persists-avatar-bytes-and-metadata-after-restart",
            run: async (gym) => {
                const project = await register(gym, "avatar-restart", "avatarrestartproject");
                const updated = await gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: project.version },
                );
                const before = await gym.client.getProjectAvatar(project.id);
                await gym.restart();
                const after = await gym.client.getProjectAvatar(project.id);
                expect((await gym.client.getProject(project.id)).project.avatar).toEqual(
                    updated.project.avatar,
                );
                expect(after?.etag).toBe(before?.etag);
                expect(new Uint8Array(after?.data ?? new ArrayBuffer(0))).toEqual(
                    new Uint8Array(before?.data ?? new ArrayBuffer(0)),
                );
            },
        },
        {
            id: "project-media-012-rename-chains-the-project-version",
            run: async (gym) => {
                const project = await register(gym, "mutation-rename", "mutationrenameproject");
                const updated = await gym.client.renameProject(
                    project.id,
                    { name: "Mutation renamed", mutationId: "mutation-rename" },
                    { ifMatch: project.version },
                );
                expect(updated.project.version).not.toBe(project.version);
                expect(updated.project.updatedAt).toBeGreaterThanOrEqual(project.updatedAt);
            },
        },
        {
            id: "project-media-013-settings-update-returns-the-project-and-settings-together",
            run: async (gym) => {
                const project = await register(gym, "mutation-settings", "mutationsettingsproject");
                const updated = await gym.client.replaceProjectSettings(
                    project.id,
                    { defaultWorkspaceCompute: { type: "host" } },
                    { ifMatch: project.version },
                );
                expect(updated.project.settings).toEqual(updated.settings);
                expect(updated.project.id).toBe(project.id);
            },
        },
        {
            id: "project-media-014-settings-conflict-preserves-the-winning-settings",
            run: async (gym) => {
                const project = await register(
                    gym,
                    "mutation-settings-conflict",
                    "mutationsettingsconflict",
                );
                const winner = await gym.client.replaceProjectSettings(
                    project.id,
                    {
                        defaultWorkspaceCompute: {
                            image: "gym/winner:latest",
                            type: "docker",
                        },
                    },
                    { ifMatch: project.version },
                );
                await expect(
                    gym.client.replaceProjectSettings(
                        project.id,
                        { defaultWorkspaceCompute: { type: "host" } },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({ code: "conflict", status: 409 });
                expect((await gym.client.getProject(project.id)).project).toEqual(winner.project);
            },
        },
        {
            id: "project-media-015-archive-requires-a-current-project-version",
            run: async (gym) => {
                const project = await register(
                    gym,
                    "mutation-archive-guard",
                    "mutationarchiveguard",
                );
                await expect(
                    gym.client.archiveProject(project.id, {
                        ifMatch: "",
                        mutationId: "archive-missing-guard",
                    }),
                ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
                expect((await gym.client.getProject(project.id)).project).toEqual(project);
            },
        },
        {
            id: "project-media-016-archive-conflict-returns-the-current-project",
            run: async (gym) => {
                const project = await register(
                    gym,
                    "mutation-archive-conflict",
                    "mutationarchiveconflict",
                );
                const winner = await gym.client.renameProject(
                    project.id,
                    { name: "winner" },
                    { ifMatch: project.version },
                );
                await expect(
                    gym.client.archiveProject(project.id, {
                        ifMatch: project.version,
                        mutationId: "archive-stale",
                    }),
                ).rejects.toMatchObject({
                    body: expect.objectContaining({ project: winner.project }),
                    code: "conflict",
                    status: 409,
                });
            },
        },
        {
            id: "project-media-017-refresh-preserves-the-project-identity",
            run: async (gym) => {
                const project = await register(gym, "mutation-refresh", "mutationrefreshproject");
                await gym.client.refreshProject(project.id);
                const refreshed = await waitForProject(gym, project.id);
                expect(refreshed.id).toBe(project.id);
                expect(refreshed.compute).toEqual(project.compute);
            },
        },
        {
            id: "project-media-018-project-detail-and-list-agree-after-a-rename",
            run: async (gym) => {
                const project = await register(gym, "mutation-list-detail", "mutationlistdetail");
                const updated = await gym.client.renameProject(
                    project.id,
                    { name: "List/detail agreement" },
                    { ifMatch: project.version },
                );
                const listed = (await gym.client.listProjects()).projects.find(
                    (candidate) => candidate.id === project.id,
                );
                expect(listed).toEqual(updated.project);
                expect((await gym.client.getProject(project.id)).project).toEqual(updated.project);
            },
        },
        {
            id: "project-media-019-project-mutation-echo-is-visible-in-the-event-journal",
            run: async (gym) => {
                const project = await register(gym, "mutation-event", "mutationeventproject");
                const mutationId = "project-event-mutation";
                await gym.client.renameProject(
                    project.id,
                    { name: "Event journal", mutationId },
                    { ifMatch: project.version },
                );
                const event = await gym.waitUntil(async () => {
                    const events = await gym.events();
                    return events.find(
                        (candidate) =>
                            candidate.type === "project.updated" &&
                            (candidate.payload as unknown as Record<string, unknown>).mutationId ===
                                mutationId,
                    );
                }, "project.updated mutation echo");
                expect(event.type).toBe("project.updated");
                expect((event.payload as unknown as Record<string, unknown>).projectId).toBe(
                    project.id,
                );
            },
        },
        {
            id: "project-media-020-project-remains-usable-after-a-failed-media-mutation",
            run: async (gym) => {
                const project = await register(gym, "mutation-recovery", "mutationrecoveryproject");
                await expect(
                    gym.client.setProjectAvatar(
                        project.id,
                        { contentType: "image/png", data: new Uint8Array([9, 9, 9]) },
                        { ifMatch: project.version },
                    ),
                ).rejects.toMatchObject({ status: 400 });
                const current = (await gym.client.getProject(project.id)).project;
                const valid = await gym.client.renameProject(
                    project.id,
                    { name: "Recovered after media failure" },
                    { ifMatch: current.version },
                );
                expect(valid.project.name).toBe("Recovered after media failure");
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

async function register(gym: AgentGym, name: string, id: string): Promise<Project> {
    const path = join(gym.workspacePath, "projects", name);
    await mkdir(path, { recursive: true });
    const project = (await gym.client.registerProject({ path, projectId: id })).project;
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
        `project ${projectId} to become ready`,
        30_000,
    );
}
