import { request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { RigProfileStore } from "../../profiles/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const PRIMARY_ID = "aprimaryinstance000000001";
const SECONDARY_ID = "asecondaryinstance0000001";
const OTHER_ID = "aotherpeerinstance00000001";
const UNTRUSTED_ID = "auntrustedinstance00000001";
const PROFILE_ID = "aprofile000000000000000004";
const OTHER_PROFILE_ID = "aotherprofile0000000000001";

describe("P2P human profiles", () => {
    const close: (() => Promise<void>)[] = [];

    afterEach(async () => {
        for (const stop of close.splice(0).reverse()) await stop();
    });

    it("lets trusted peers own remote work without giving them configuration authority", async () => {
        const ctx = createTestRootContext();
        const homeDirectory = await mkdtemp(join(tmpdir(), "rig-p2p-profile-"));
        close.push(() => rm(homeDirectory, { force: true, recursive: true }));
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            homeDirectory,
            projectClone: async () => undefined,
        });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: SECONDARY_ID,
            publish: () => undefined,
        });
        const localProfile = await profiles.create(ctx, {
            email: "secondary@example.test",
            name: "Secondary operator",
        });
        const started = await startServer(
            await createProtocolHttpServer(createTestRootContext(), {
                canP2pPeerConfigure: (peerId) => peerId === PRIMARY_ID,
                canP2pPeerProvision: (peerId) => peerId === PRIMARY_ID || peerId === OTHER_ID,
                canP2pPeerUseRemoteWork: (peerId) => peerId === PRIMARY_ID || peerId === OTHER_ID,
                p2pNode: () => ({
                    name: "Secondary",
                    primaryId: PRIMARY_ID,
                    role: "secondary",
                }),
                profiles,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            await store.close(ctx);
        });
        const profile = {
            createdAt: 1_000,
            email: "steve@example.test",
            id: PROFILE_ID,
            name: "Steve",
            parentInstanceId: PRIMARY_ID,
            updatedAt: 1_000,
            version: 1,
        };
        const replicaBody = JSON.stringify({ profile });

        expect(
            await send(started.socketPath, "PUT", `/profiles/${PROFILE_ID}`, replicaBody, OTHER_ID),
        ).toMatchObject({ status: 409 });
        expect(
            await send(
                started.socketPath,
                "PUT",
                `/profiles/${PROFILE_ID}`,
                replicaBody,
                PRIMARY_ID,
            ),
        ).toMatchObject({
            body: { profile },
            status: 200,
        });
        expect(
            await send(started.socketPath, "GET", `/profiles/${PROFILE_ID}`, undefined, PRIMARY_ID),
        ).toMatchObject({ body: { profile }, status: 200 });
        expect(
            await send(started.socketPath, "GET", "/profiles", undefined, PRIMARY_ID),
        ).toMatchObject({
            body: { profiles: expect.arrayContaining([profile, localProfile]) },
            status: 200,
        });
        const otherProfile = {
            createdAt: 2_000,
            email: "other@example.test",
            id: OTHER_PROFILE_ID,
            name: "Other peer operator",
            parentInstanceId: OTHER_ID,
            updatedAt: 2_000,
            version: 1,
        };
        expect(
            await send(
                started.socketPath,
                "PUT",
                `/profiles/${OTHER_PROFILE_ID}`,
                JSON.stringify({ profile: otherProfile }),
                OTHER_ID,
            ),
        ).toMatchObject({
            body: { profile: otherProfile },
            status: 200,
        });
        expect(
            await send(started.socketPath, "GET", "/profiles", undefined, OTHER_ID),
        ).toMatchObject({
            body: { profiles: expect.arrayContaining([profile, otherProfile, localProfile]) },
            status: 200,
        });
        const remoteProjectRequest = {
            identity: PROFILE_ID,
            name: "Remote project",
            secret: { kind: "github" as const },
            source: { kind: "github" as const, repository: "slopus/rig" },
        };
        const managedProject = await store.createRemoteProject(ctx, remoteProjectRequest, {
            createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
            githubToken: "initial-project-token",
        });
        const session = await store.create(
            ctx,
            {
                cwd: managedProject.path,
                identity: PROFILE_ID,
                projectId: managedProject.id,
            },
            { ownerInstanceId: PRIMARY_ID, profileId: PROFILE_ID },
        );
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sessions",
                JSON.stringify({ cwd: "/tmp/p2p-profile-created-session" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_required" }, status: 400 });
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sessions",
                JSON.stringify({
                    cwd: managedProject.path,
                    gitSecret: { kind: "github" },
                    identity: OTHER_PROFILE_ID,
                    projectId: managedProject.id,
                    temporaryGitSecret: {
                        kind: "github",
                        token: "other-session-token",
                    },
                }),
                OTHER_ID,
            ),
        ).toMatchObject({
            body: {
                session: {
                    ownerInstanceId: OTHER_ID,
                    profileId: OTHER_PROFILE_ID,
                    projectId: managedProject.id,
                },
            },
            status: 201,
        });
        expect(
            await send(
                started.socketPath,
                "GET",
                `/sessions/${session.id}/state`,
                undefined,
                OTHER_ID,
            ),
        ).toMatchObject({ body: { session: { id: session.id } }, status: 200 });
        const crossWriterCredentialRefresh = vi.spyOn(store, "refreshSessionGitCredential");
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({
                    gitSecret: { kind: "github" },
                    identity: OTHER_PROFILE_ID,
                    temporaryGitSecret: {
                        kind: "github",
                        token: "other-writer-token",
                    },
                    text: "Continue this shared session",
                }),
                OTHER_ID,
            ),
        ).toMatchObject({ status: 202 });
        expect(crossWriterCredentialRefresh).toHaveBeenLastCalledWith(
            expect.anything(),
            session.id,
            { instanceId: OTHER_ID, profileId: OTHER_PROFILE_ID },
            "other-writer-token",
        );
        await expect(crossWriterCredentialRefresh.mock.results.at(-1)?.value).resolves.toBe(false);
        crossWriterCredentialRefresh.mockRestore();
        expect(
            session.events
                .since(undefined)
                ?.findLast((event) => event.type === "message_submitted"),
        ).toMatchObject({
            data: { message: { identity: OTHER_PROFILE_ID } },
        });
        const localSession = await store.create(ctx, { cwd: "/tmp/unowned-remote-session" });
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sessions",
                JSON.stringify({
                    cwd: "/tmp/unowned-remote-session",
                    identity: PROFILE_ID,
                    projectId: localSession.snapshot().projectId,
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({
            body: {
                session: {
                    ownerInstanceId: PRIMARY_ID,
                    profileId: PROFILE_ID,
                    projectId: localSession.snapshot().projectId,
                },
            },
            status: 201,
        });
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sessions",
                JSON.stringify({
                    cwd: managedProject.path,
                    identity: PROFILE_ID,
                    projectId: managedProject.id,
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({
            body: {
                session: {
                    ownerInstanceId: PRIMARY_ID,
                    profileId: PROFILE_ID,
                },
            },
            status: 201,
        });
        const createRemoteProject = vi.spyOn(store, "createRemoteProject");
        const remoteProject = await send(
            started.socketPath,
            "POST",
            "/projects/clone",
            JSON.stringify({
                ...remoteProjectRequest,
                projectId: managedProject.id,
                temporaryGitSecret: { kind: "github", token: "single-use-token" },
            }),
            PRIMARY_ID,
        );
        expect(remoteProject.status).toBe(202);
        expect(JSON.stringify(remoteProject.body)).not.toContain("single-use-token");
        expect(createRemoteProject).toHaveBeenCalledWith(
            expect.anything(),
            { ...remoteProjectRequest, projectId: managedProject.id },
            {
                createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
                githubToken: "single-use-token",
            },
        );
        expect(
            await send(
                started.socketPath,
                "POST",
                "/projects/clone",
                JSON.stringify({
                    ...remoteProjectRequest,
                    identity: "aunknownprofile000000000001",
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({
            body: { code: "profile_not_owned" },
            status: 403,
        });
        const otherRemoteProject = await send(
            started.socketPath,
            "POST",
            "/projects/clone",
            JSON.stringify({
                ...remoteProjectRequest,
                identity: OTHER_PROFILE_ID,
                name: "Other peer project",
                temporaryGitSecret: { kind: "github", token: "other-peer-token" },
            }),
            OTHER_ID,
        );
        expect(otherRemoteProject).toMatchObject({
            body: {
                project: {
                    createdBy: {
                        instanceId: OTHER_ID,
                        profileId: OTHER_PROFILE_ID,
                    },
                },
            },
            status: 202,
        });
        expect(
            await send(
                started.socketPath,
                "POST",
                "/projects/clone",
                JSON.stringify(remoteProjectRequest),
                UNTRUSTED_ID,
            ),
        ).toMatchObject({
            body: {
                code: "remote_work_not_allowed",
                error: "This Rig accepts remote work only from trusted peer Rigs.",
            },
            status: 403,
        });
        expect(createRemoteProject).toHaveBeenCalledTimes(2);
        const projectId = managedProject.id;
        const workspace = {
            branch: "001-remote-workspace",
            createdAt: 2_000,
            createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
            gitCommonDir: "/tmp/p2p-profile-secondary/.git",
            id: "aworkspace0000000000000001",
            kind: "git_worktree" as const,
            name: "Remote workspace",
            orderKey: "a0",
            path: "/tmp/p2p-profile-secondary-workspace",
            presence: "missing" as const,
            projectId,
            status: "initializing" as const,
            storageKey: "remote-workspace",
            updatedAt: 2_000,
            version: 1,
        };
        const createRemoteWorkspace = vi
            .spyOn(store, "createWorkspace")
            .mockResolvedValue(workspace);
        const remoteWorkspace = await send(
            started.socketPath,
            "POST",
            `/projects/${projectId}/workspaces`,
            JSON.stringify({
                identity: PROFILE_ID,
                name: "Remote workspace",
                secret: { kind: "github" },
                temporaryGitSecret: { kind: "github", token: "workspace-token" },
            }),
            PRIMARY_ID,
        );
        expect(remoteWorkspace).toMatchObject({
            body: { workspace: { createdBy: workspace.createdBy, id: workspace.id } },
            status: 202,
        });
        expect(JSON.stringify(remoteWorkspace.body)).not.toContain("workspace-token");
        expect(createRemoteWorkspace).toHaveBeenCalledWith(
            expect.anything(),
            projectId,
            {
                identity: PROFILE_ID,
                name: "Remote workspace",
                secret: { kind: "github" },
            },
            {
                createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
                githubToken: "workspace-token",
            },
        );
        vi.spyOn(store, "listWorkspaces").mockResolvedValue([workspace]);
        expect(
            await send(started.socketPath, "GET", "/catalog", undefined, OTHER_ID),
        ).toMatchObject({
            body: {
                projects: expect.arrayContaining([
                    expect.objectContaining({
                        createdBy: {
                            instanceId: PRIMARY_ID,
                            profileId: PROFILE_ID,
                        },
                        id: managedProject.id,
                    }),
                ]),
                sessions: expect.arrayContaining([
                    expect.objectContaining({
                        id: session.id,
                        ownerInstanceId: PRIMARY_ID,
                        profileId: PROFILE_ID,
                    }),
                ]),
                workspaces: [
                    expect.objectContaining({
                        createdBy: {
                            instanceId: PRIMARY_ID,
                            profileId: PROFILE_ID,
                        },
                        id: workspace.id,
                    }),
                ],
            },
            status: 200,
        });
        expect(
            await send(
                started.socketPath,
                "GET",
                `/profiles/${localProfile.id}`,
                undefined,
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { profile: localProfile }, status: 200 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ text: "Missing profile" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_required" }, status: 400 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({
                    identity: "aunknownprofile000000000001",
                    text: "Wrong profile",
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_not_owned" }, status: 403 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ identity: PROFILE_ID, text: "Attributed message" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ status: 202 });
        const refreshGitCredential = vi
            .spyOn(store, "refreshSessionGitCredential")
            .mockResolvedValue(true);
        const credentialedMessage = await send(
            started.socketPath,
            "POST",
            `/sessions/${session.id}/messages`,
            JSON.stringify({
                clientSubmissionId: "credentialed-message-retry",
                gitSecret: { kind: "github" },
                identity: PROFILE_ID,
                temporaryGitSecret: { kind: "github", token: "message-token" },
                text: "Refresh Git before this run",
            }),
            PRIMARY_ID,
        );
        expect(credentialedMessage.status).toBe(202);
        expect(JSON.stringify(credentialedMessage.body)).not.toContain("message-token");
        expect(refreshGitCredential).toHaveBeenCalledWith(
            expect.anything(),
            session.id,
            { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
            "message-token",
        );
        const credentialedRetry = await send(
            started.socketPath,
            "POST",
            `/sessions/${session.id}/messages`,
            JSON.stringify({
                clientSubmissionId: "credentialed-message-retry",
                gitSecret: { kind: "github" },
                identity: PROFILE_ID,
                text: "Refresh Git before this run",
            }),
            PRIMARY_ID,
        );
        expect(credentialedRetry).toEqual(credentialedMessage);
        expect(refreshGitCredential).toHaveBeenCalledTimes(1);
        expect(
            session.events
                .since(undefined)
                ?.findLast((event) => event.type === "message_submitted"),
        ).toMatchObject({ data: { message: { identity: PROFILE_ID } } });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ identity: PROFILE_ID, text: "Local impersonation" }),
            ),
        ).toMatchObject({ body: { code: "profile_not_owned" }, status: 403 });
    });

    it("creates named profiles only on a local primary", async () => {
        const ctx = createTestRootContext();
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: PRIMARY_ID,
            publish: () => undefined,
        });
        const started = await startServer(
            await createProtocolHttpServer(createTestRootContext(), {
                p2pNode: () => ({ name: "Primary", role: "primary" }),
                profiles,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            await store.close(ctx);
        });

        expect(
            await send(
                started.socketPath,
                "POST",
                "/profiles",
                JSON.stringify({ name: "Missing email" }),
            ),
        ).toMatchObject({ status: 400 });
        const created = await send(
            started.socketPath,
            "POST",
            "/profiles",
            JSON.stringify({
                email: "steve@example.test",
                name: "Steve Korshakov 🧑‍💻",
            }),
        );
        expect(created).toMatchObject({
            body: {
                profile: {
                    email: "steve@example.test",
                    id: expect.any(String),
                    name: "Steve Korshakov 🧑‍💻",
                    parentInstanceId: PRIMARY_ID,
                    version: 1,
                },
            },
            status: 201,
        });
    });
});

async function send(
    socketPath: string,
    method: string,
    path: string,
    body?: string,
    peerId?: string,
): Promise<{ body: unknown; status: number }> {
    return await new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body),
                              "content-type": "application/json",
                          }),
                    ...(peerId === undefined ? {} : { "x-rig-p2p-peer": peerId }),
                },
                method,
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) =>
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
                );
                response.once("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        body: text.length === 0 ? undefined : JSON.parse(text),
                        status: response.statusCode ?? 0,
                    });
                });
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

async function startServer(server: Server): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        close: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}
