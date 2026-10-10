import { execFile } from "node:child_process";
import type { ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
    clientFrameEvent,
    createAgentGym,
    type AgentGym,
    type HappyAgentEventStream,
} from "@slopus/happy-agent-gym";

const execFileAsync = promisify(execFile);
const activeGyms = new Set<AgentGym>();
const activeStreams = new Set<HappyAgentEventStream>();
type Project = Awaited<ReturnType<AgentGym["client"]["getProject"]>>["project"];
type HappyAgentEvent = Awaited<ReturnType<AgentGym["events"]>>[number];

afterEach(async () => {
    for (const stream of activeStreams) stream.close();
    activeStreams.clear();
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("projects at the public Happy Agent API", () => {
    it(
        "registers a plain folder, replays its client ID, and mirrors the root workspace",
        { timeout: 60_000 },
        async () => {
            const gym = await freshGym();
            const stream = openStream(gym);
            await stream.opened();
            const path = join(gym.workspacePath, "projects", "plain");
            await mkdir(path, { recursive: true });

            const projectId = "projectreplayid";
            const mutationId = "project-create-plain";
            const mark = stream.frames.length;
            const registered = await gym.client.registerProject({
                mutationId,
                path,
                projectId,
            });
            const projectCreated = await waitForProjectEvent(
                stream,
                mark,
                "project.created",
                projectId,
                mutationId,
            );
            const workspaceCreated = await waitForProjectEvent(
                stream,
                mark,
                "workspace.created",
                projectId,
                mutationId,
            );

            expect(registered.project.id).toBe(projectId);
            expect(resourceFromEvent(projectCreated, "project")["id"]).toBe(projectId);
            expect(payloadRecord(projectCreated).mutationId).toBe(mutationId);
            expect(resourceFromEvent(workspaceCreated, "workspace")).toMatchObject({
                id: projectId,
                kind: "root",
                parentId: null,
                projectId,
            });
            expect(payloadRecord(workspaceCreated).mutationId).toBe(mutationId);
            expect(resourceFromEvent(workspaceCreated, "workspace")["version"]).toBe(
                resourceFromEvent(projectCreated, "project")["version"],
            );

            const ready = await waitForReadyProject(gym, projectId);
            expect(ready.compute.type).toBe("host");
            if (ready.compute.type !== "host") throw new Error("Expected host project compute.");
            expect(ready.compute.path).toBe(path);
            expect(ready.git).toBeNull();
            expect(ready.worktreeSupport).toBe("unsupported");

            const detail = await gym.client.getProject(projectId);
            expect(detail.project).toMatchObject({
                id: projectId,
                nameSource: "folder",
                status: "active",
                initialization: { status: "ready" },
            });
            const root = (
                await gym.client.listWorkspaces({ includeArchived: true, projectId })
            ).workspaces.find((workspace) => workspace.id === projectId);
            expect(root).toMatchObject({
                id: projectId,
                kind: "root",
                parentId: null,
                projectId,
            });

            const replay = await gym.client.registerProject({
                mutationId: "project-create-replay",
                path,
                projectId,
            });
            expect(replay.project.id).toBe(projectId);
            expect(
                (await gym.client.listProjects()).projects.filter(
                    (project) => project.id === projectId,
                ),
            ).toHaveLength(1);

            const otherPath = join(gym.workspacePath, "projects", "other");
            await mkdir(otherPath, { recursive: true });
            await expect(
                gym.client.registerProject({
                    mutationId: "project-id-conflict",
                    path: otherPath,
                    projectId,
                }),
            ).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });
            expect(
                (await gym.client.listProjects()).projects.filter(
                    (project) => project.id === projectId,
                ),
            ).toHaveLength(1);
        },
    );

    it(
        "renames, changes settings, refreshes, and rejects stale project versions",
        { timeout: 60_000 },
        async () => {
            const gym = await freshGym();
            const stream = openStream(gym);
            await stream.opened();
            const project = await registerFolder(gym, "project-settings", "projectsettingsid");
            const ready = await waitForReadyProject(gym, project.id);

            const renameMark = stream.frames.length;
            const renamed = await gym.client.renameProject(
                project.id,
                { mutationId: "project-rename", name: "Renamed project" },
                { ifMatch: ready.version },
            );
            const renameEvent = await waitForProjectEvent(
                stream,
                renameMark,
                "project.updated",
                project.id,
                "project-rename",
            );
            const renameWorkspaceEvent = await waitForProjectEvent(
                stream,
                renameMark,
                "workspace.updated",
                project.id,
                "project-rename",
            );
            expect(renamed.project.name).toBe("Renamed project");
            expect(renamed.project.nameSource).toBe("user");
            expectVersionChain(renameEvent, renameWorkspaceEvent, ready, renamed.project);
            expect(changesFromEvent(renameEvent)).toMatchObject({
                name: "Renamed project",
                nameSource: "user",
            });
            await expect(
                gym.client.renameProject(
                    project.id,
                    { name: "stale name" },
                    { ifMatch: ready.version },
                ),
            ).rejects.toMatchObject({
                code: "conflict",
                status: 409,
            });

            const settingsBefore = (await gym.client.getProject(project.id)).project;
            const settingsMark = stream.frames.length;
            const settings = await gym.client.replaceProjectSettings(
                project.id,
                {
                    defaultWorkspaceCompute: {
                        image: "gym/project-settings:latest",
                        type: "docker",
                    },
                    mutationId: "project-settings-update",
                },
                { ifMatch: settingsBefore.version },
            );
            const settingsEvent = await waitForProjectEvent(
                stream,
                settingsMark,
                "project.updated",
                project.id,
                "project-settings-update",
            );
            const settingsWorkspaceEvent = await waitForProjectEvent(
                stream,
                settingsMark,
                "workspace.updated",
                project.id,
                "project-settings-update",
            );
            expect(settings.settings.defaultWorkspaceCompute).toEqual({
                image: "gym/project-settings:latest",
                type: "docker",
            });
            expectVersionChain(
                settingsEvent,
                settingsWorkspaceEvent,
                settingsBefore,
                settings.project,
            );

            const refreshBefore = (await gym.client.getProject(project.id)).project;
            const refreshMark = stream.frames.length;
            const refreshed = await gym.client.refreshProject(project.id);
            expect(refreshed.project.initialization.status).toBe("initializing");
            await waitForProjectEvent(stream, refreshMark, "project.updated", project.id);
            const readyAgain = await gym.waitUntil(async () => {
                const current = (await gym.client.getProject(project.id)).project;
                return current.initialization.status === "initializing" ? undefined : current;
            }, "refreshed project initialization to settle");
            expect(readyAgain.initialization.status).toBe("ready");
            expect(readyAgain.initialization.attempt).toBeGreaterThan(
                refreshBefore.initialization.attempt,
            );
            expect(readyAgain.initialization.error).toBeNull();
        },
    );

    it(
        "orders projects, archives and revives them, and preserves the result across restart",
        { timeout: 90_000 },
        async () => {
            const gym = await freshGym();
            const stream = openStream(gym);
            await stream.opened();
            const first = await registerFolder(gym, "project-order-first", "projectorderfirst");
            const second = await registerFolder(gym, "project-order-second", "projectordersecond");
            await waitForReadyProject(gym, first.id);
            await waitForReadyProject(gym, second.id);

            const before = await gym.client.getProject(second.id);
            const reorderMark = stream.frames.length;
            const reordered = await gym.client.reorderProject(
                second.id,
                { afterId: null, mutationId: "project-reorder-first" },
                { ifMatch: before.project.version },
            );
            const reorderEvent = await waitForProjectEvent(
                stream,
                reorderMark,
                "project.updated",
                second.id,
                "project-reorder-first",
            );
            const reorderWorkspaceEvent = await waitForProjectEvent(
                stream,
                reorderMark,
                "workspace.updated",
                second.id,
                "project-reorder-first",
            );
            expect(reordered.project.id).toBe(second.id);
            expectVersionChain(
                reorderEvent,
                reorderWorkspaceEvent,
                before.project,
                reordered.project,
            );
            const ordered = (await gym.client.listProjects()).projects;
            expect(ordered[0]?.id).toBe(second.id);
            expect(ordered.findIndex((project) => project.id === first.id)).toBeGreaterThan(0);
            await expect(
                gym.client.reorderProject(
                    second.id,
                    { afterId: first.id },
                    { ifMatch: before.project.version },
                ),
            ).rejects.toMatchObject({
                code: "conflict",
                status: 409,
            });

            const archiveBefore = (await gym.client.getProject(first.id)).project;
            const archiveMark = stream.frames.length;
            const archived = await gym.client.archiveProject(first.id, {
                ifMatch: archiveBefore.version,
                mutationId: "project-archive",
            });
            const archiveEvent = await waitForProjectEvent(
                stream,
                archiveMark,
                "project.updated",
                first.id,
                "project-archive",
            );
            const archiveWorkspaceEvent = await waitForProjectEvent(
                stream,
                archiveMark,
                "workspace.updated",
                first.id,
                "project-archive",
            );
            expect(archived.project.status).toBe("archived");
            expectVersionChain(
                archiveEvent,
                archiveWorkspaceEvent,
                archiveBefore,
                archived.project,
            );
            expect(
                (await gym.client.listProjects()).projects.find(
                    (candidate) => candidate.id === first.id,
                )?.status,
            ).toBe("archived");
            expect(
                (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId: first.id,
                    })
                ).workspaces.find((workspace) => workspace.id === first.id)?.status,
            ).toBe("archived");

            const reviveMark = stream.frames.length;
            const revived = await gym.client.registerProject({
                mutationId: "project-revive",
                path: join(gym.workspacePath, "projects", "project-order-first"),
                projectId: first.id,
            });
            const reviveEvent = await waitForProjectEvent(
                stream,
                reviveMark,
                "project.updated",
                first.id,
                "project-revive",
            );
            const reviveWorkspaceEvent = await waitForProjectEvent(
                stream,
                reviveMark,
                "workspace.updated",
                first.id,
                "project-revive",
            );
            expect(revived.project.id).toBe(first.id);
            expect(revived.project.status).toBe("active");
            expectVersionChain(
                reviveEvent,
                reviveWorkspaceEvent,
                archived.project,
                revived.project,
            );

            stream.close();
            activeStreams.delete(stream);
            await gym.restart();
            const afterRestart = await gym.client.getProject(first.id);
            expect(afterRestart.project.status).toBe("active");
            expect(afterRestart.project.orderKey).toBe(
                (await gym.client.listProjects()).projects.find(
                    (candidate) => candidate.id === first.id,
                )?.orderKey,
            );
        },
    );

    it(
        "stores project avatar media with ETags, version guards, and restart durability",
        { timeout: 60_000 },
        async () => {
            const gym = await freshGym();
            const stream = openStream(gym);
            await stream.opened();
            const project = await registerFolder(gym, "project-avatar", "projectavatarid");
            await waitForReadyProject(gym, project.id);
            const before = (await gym.client.getProject(project.id)).project;
            const png = new Uint8Array(
                Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    "base64",
                ),
            );

            const avatarMark = stream.frames.length;
            const withAvatar = await gym.client.setProjectAvatar(
                project.id,
                { contentType: "image/png", data: png.buffer as ArrayBuffer },
                { ifMatch: before.version },
            );
            const avatarEvent = await waitForProjectEvent(
                stream,
                avatarMark,
                "project.updated",
                project.id,
            );
            const avatarWorkspaceEvent = await waitForProjectEvent(
                stream,
                avatarMark,
                "workspace.updated",
                project.id,
            );
            expect(withAvatar.project.avatar).toMatchObject({
                kind: "image",
                source: "user",
            });
            expect(withAvatar.project.avatar?.kind).toBe("image");
            if (withAvatar.project.avatar?.kind !== "image") {
                throw new Error("The avatar response did not contain image metadata.");
            }
            expect(withAvatar.project.avatar.thumbhash.length).toBeGreaterThan(0);
            expectVersionChain(avatarEvent, avatarWorkspaceEvent, before, withAvatar.project);

            const image = await gym.client.getProjectAvatar(project.id);
            expect(image).not.toBeNull();
            expect(image?.contentType).toBe("image/webp");
            expect(image?.etag).toMatch(/^".+"$/);
            expect(image?.data.byteLength).toBeGreaterThan(0);
            const unchanged = await gym.client.getProjectAvatar(project.id, {
                ifNoneMatch: image?.etag ?? undefined,
            });
            expect(unchanged).toBeNull();

            await expect(
                gym.client.setProjectAvatar(
                    project.id,
                    { contentType: "image/png", data: png.buffer as ArrayBuffer },
                    { ifMatch: before.version },
                ),
            ).rejects.toMatchObject({
                code: "conflict",
                status: 409,
            });

            stream.close();
            activeStreams.delete(stream);
            await gym.restart();
            const persisted = await gym.client.getProject(project.id);
            expect(persisted.project.avatar).toEqual(withAvatar.project.avatar);
            const persistedImage = await gym.client.getProjectAvatar(project.id);
            expect(persistedImage?.etag).toBe(image?.etag);

            const deleteStream = openStream(gym);
            await deleteStream.opened();
            const deleteBefore = persisted.project;
            const deleteMark = deleteStream.frames.length;
            const deleted = await gym.client.deleteProjectAvatar(project.id, {
                ifMatch: deleteBefore.version,
            });
            const deleteEvent = await waitForProjectEvent(
                deleteStream,
                deleteMark,
                "project.updated",
                project.id,
            );
            const deleteWorkspaceEvent = await waitForProjectEvent(
                deleteStream,
                deleteMark,
                "workspace.updated",
                project.id,
            );
            expect(deleted.project.avatar).toBeNull();
            expectVersionChain(deleteEvent, deleteWorkspaceEvent, deleteBefore, deleted.project);
            await expect(gym.client.getProjectAvatar(project.id)).rejects.toMatchObject({
                code: "not_found",
                status: 404,
            });
        },
    );

    it(
        "reports invalid paths and initialization failures while accepting Git subdirectories",
        { timeout: 90_000 },
        async () => {
            const gym = await freshGym();
            const missing = join(gym.workspacePath, "projects", "does-not-exist");
            await expect(gym.client.registerProject({ path: missing })).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });

            const file = join(gym.workspacePath, "projects", "not-a-directory");
            await mkdir(join(gym.workspacePath, "projects"), { recursive: true });
            await writeFile(file, "a file, not a project folder", "utf8");
            await expect(gym.client.registerProject({ path: file })).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });

            const repository = join(gym.workspacePath, "projects", "repository");
            await mkdir(repository, { recursive: true });
            await execFileAsync("git", ["init", "--quiet", repository]);
            const nested = join(repository, "nested");
            await mkdir(nested, { recursive: true });
            const nestedProject = (await gym.client.registerProject({ path: nested })).project;
            expect(nestedProject.initialization.status).toBe("initializing");
            const nestedReady = await waitForReadyProject(gym, nestedProject.id);
            expect(nestedReady.compute).toEqual({ path: nested, type: "host" });
            expect(nestedReady.worktreeSupport).toBe("unsupported");

            const vanishingPath = join(gym.workspacePath, "projects", "vanishing");
            await mkdir(vanishingPath, { recursive: true });
            const vanishing = await registerFolder(gym, "vanishing", "projectvanishingid");
            await waitForReadyProject(gym, vanishing.id);
            await rm(vanishingPath, { force: true, recursive: true });
            const refreshed = await gym.client.refreshProject(vanishing.id);
            expect(refreshed.project.initialization.status).toBe("initializing");
            const failed = await gym.waitUntil(async () => {
                const current = (await gym.client.getProject(vanishing.id)).project;
                if (current.initialization.status === "failed") return current;
                return undefined;
            }, "project initialization to settle as failed");
            expect(failed.initialization.error).toEqual(expect.any(String));
        },
    );

    it(
        "clones a project through a hermetic loopback HTTPS Git fixture",
        { timeout: 60_000 },
        async () => {
            const gym = await freshGym();
            const fixture = await createHttpsGitFixture(gym);
            const previousGitSslNoVerify = process.env.GIT_SSL_NO_VERIFY;
            process.env.GIT_SSL_NO_VERIFY = "1";
            try {
                const cloned = await gym.client.cloneProject({
                    mutationId: "clone-loopback-project",
                    name: "loopback-clone",
                    projectId: "projectloopbackclone",
                    source: {
                        kind: "git",
                        url: `https://127.0.0.1:${String(fixture.port)}/repository.git`,
                    },
                });
                expect(cloned.project.initialization.status).toBe("initializing");

                const ready = await waitForReadyProject(gym, cloned.project.id);
                expect(ready.remoteSource).toEqual({
                    kind: "git",
                    url: `https://127.0.0.1:${String(fixture.port)}/repository.git`,
                });
                if (ready.compute.type !== "host") {
                    throw new Error("The cloned project did not expose its managed host folder.");
                }
                expect(await readFile(join(ready.compute.path, "fixture.txt"), "utf8")).toBe(
                    "hermetic clone\n",
                );

                await gym.restart();
                expect((await gym.client.getProject(ready.id)).project).toMatchObject({
                    id: ready.id,
                    compute: { path: ready.compute.path, type: "host" },
                    initialization: { status: "ready" },
                });
            } finally {
                if (previousGitSslNoVerify === undefined) {
                    delete process.env.GIT_SSL_NO_VERIFY;
                } else {
                    process.env.GIT_SSL_NO_VERIFY = previousGitSslNoVerify;
                }
                await closeHttpsServer(fixture.server);
            }
        },
    );
});

async function createHttpsGitFixture(
    gym: AgentGym,
): Promise<{ readonly port: number; readonly server: HttpsServer }> {
    const fixtureRoot = join(gym.workspacePath, ".git-https-fixture");
    const source = join(fixtureRoot, "source");
    const repository = join(fixtureRoot, "repository.git");
    const certificate = join(fixtureRoot, "certificate.pem");
    const privateKey = join(fixtureRoot, "private-key.pem");
    await mkdir(source, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "gym@example.invalid"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "API Gym"]);
    await writeFile(join(source, "fixture.txt"), "hermetic clone\n", "utf8");
    await execFileAsync("git", ["-C", source, "add", "fixture.txt"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
    await execFileAsync("git", ["clone", "--bare", source, repository]);
    await execFileAsync("git", ["--git-dir", repository, "update-server-info"]);
    await execFileAsync("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-keyout",
        privateKey,
        "-out",
        certificate,
    ]);

    const server = createServer(
        {
            cert: await readFile(certificate),
            key: await readFile(privateKey),
        },
        (request, response) => {
            void serveGitFixture(fixtureRoot, request.url ?? "/", response).catch(() => {
                if (!response.headersSent) response.writeHead(500);
                response.end();
            });
        },
    );
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolveListen();
        });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        await closeHttpsServer(server);
        throw new Error("The HTTPS Git fixture did not bind a TCP port.");
    }
    return { port: address.port, server };
}

async function serveGitFixture(
    root: string,
    requestUrl: string,
    response: ServerResponse,
): Promise<void> {
    const pathname = decodeURIComponent(new URL(requestUrl, "https://fixture.invalid").pathname);
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
        response.writeHead(403);
        response.end();
        return;
    }
    try {
        if (!(await stat(path)).isFile()) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/octet-stream",
        });
        response.end(await readFile(path));
    } catch {
        response.writeHead(404);
        response.end();
    }
}

async function closeHttpsServer(server: HttpsServer): Promise<void> {
    await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
    });
}

async function freshGym(): Promise<AgentGym> {
    const gym = await createAgentGym();
    activeGyms.add(gym);
    return gym;
}

function openStream(gym: AgentGym): HappyAgentEventStream {
    const stream = gym.stream();
    activeStreams.add(stream);
    return stream;
}

async function registerFolder(
    gym: AgentGym,
    name: string,
    projectId: string,
    mutationId = `register-${projectId}`,
): Promise<Project> {
    const path = join(gym.workspacePath, "projects", name);
    await mkdir(path, { recursive: true });
    return (
        await gym.client.registerProject({
            mutationId,
            path,
            projectId,
        })
    ).project;
}

async function waitForReadyProject(gym: AgentGym, projectId: string): Promise<Project> {
    return await gym.waitUntil(
        async () => {
            const project = (await gym.client.getProject(projectId)).project;
            if (project.initialization.status === "failed") {
                throw new Error(
                    project.initialization.error ??
                        "Project initialization failed without a reason.",
                );
            }
            return project.initialization.status === "ready" ? project : undefined;
        },
        `project ${projectId} to become ready`,
        30_000,
    );
}

async function waitForProjectEvent(
    stream: HappyAgentEventStream,
    mark: number,
    type: HappyAgentEvent["type"],
    resourceId: string,
    mutationId?: string,
): Promise<HappyAgentEvent & { readonly type: typeof type }> {
    const frame = await stream.waitFor(
        (candidate) => {
            const index = stream.frames.indexOf(candidate);
            if (index < mark) return false;
            const event = clientFrameEvent(candidate);
            if (event === undefined || event.type !== type) return false;
            if (eventResourceId(event) !== resourceId) return false;
            return mutationId === undefined || eventMutationId(event) === mutationId;
        },
        `${type} for project ${resourceId}`,
        30_000,
    );
    const event = clientFrameEvent(frame);
    if (event === undefined || event.type !== type) {
        throw new Error(`The event stream returned no ${type} event.`);
    }
    return event as HappyAgentEvent & { readonly type: typeof type };
}

function expectVersionChain(
    projectEvent: HappyAgentEvent,
    workspaceEvent: HappyAgentEvent,
    before: Project,
    after: Project,
): void {
    const projectPayload = projectEvent.payload as Record<string, unknown>;
    const workspacePayload = workspaceEvent.payload as Record<string, unknown>;
    expect(projectPayload.previousVersion).toBe(before.version);
    expect(projectPayload.version).toBe(after.version);
    expect(workspacePayload.previousVersion).toBe(before.version);
    expect(workspacePayload.version).toBe(after.version);
    expect(after.version).not.toBe(before.version);
}

function eventResourceId(event: HappyAgentEvent): string | undefined {
    const payload = event.payload as Record<string, unknown>;
    for (const key of ["projectId", "workspaceId"]) {
        if (typeof payload[key] === "string") return payload[key];
    }
    for (const key of ["project", "workspace"]) {
        const resource = payload[key];
        if (resource !== null && typeof resource === "object") {
            const id = (resource as Record<string, unknown>).id;
            if (typeof id === "string") return id;
        }
    }
    return undefined;
}

function eventMutationId(event: HappyAgentEvent): string | undefined {
    const value = (event.payload as Record<string, unknown>).mutationId;
    return typeof value === "string" ? value : undefined;
}

function payloadRecord(event: HappyAgentEvent): Record<string, unknown> {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") {
        throw new Error(`The ${event.type} event did not carry an object payload.`);
    }
    return payload as Record<string, unknown>;
}

function resourceFromEvent(event: HappyAgentEvent, key: string): Record<string, unknown> {
    const resource = payloadRecord(event)[key];
    if (resource === null || typeof resource !== "object") {
        throw new Error(`The ${event.type} event did not carry a ${key} resource.`);
    }
    return resource as Record<string, unknown>;
}

function changesFromEvent(event: HappyAgentEvent): Record<string, unknown> {
    const changes = payloadRecord(event)["changes"];
    if (changes === null || typeof changes !== "object") {
        throw new Error(`The ${event.type} event did not carry changes.`);
    }
    return changes as Record<string, unknown>;
}
