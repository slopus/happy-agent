import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient, type Client, type InArgs } from "@libsql/client";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { AgentMessage, CompactionMessage, UserMessage } from "../../agent/types.js";
import {
    createEventIdFactory,
    type ModelCatalog,
    type SessionEvent,
} from "../../protocol/index.js";
import type { GymInferenceRequest } from "../../agent/gym-types.js";
import { defineModel } from "@slopus/rig-execution";
import type {
    InMemorySession,
    PersistedQueuedRun,
    PersistedSessionState,
} from "../InMemorySession.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";
import { TrackedTaskDrain } from "../../utils/TrackedTaskDrain.js";
import type { GitCommandRunner } from "../../git/types.js";
import { GitCredentialBroker } from "../../git/GitCredentialBroker.js";
import { RigProfileStore } from "../../profiles/index.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { querySessionRestore } from "../../persistence/session/querySessionRestore.js";
import { inTx } from "../../persistence/inTx.js";

const execFile = promisify(execFileCallback);
const ctx = createTestRootContext();

describe("PersistentSessionStore", () => {
    it("starts stale tool-result retention after opening without delaying the open", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        let store: PersistentSessionStore | undefined;
        try {
            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                now: () => 1,
            });
            const state = sessionState({ unsortedSince: 1 });
            const message: AgentMessage = {
                blocks: [
                    {
                        display: "Read a large file.",
                        rendered: [{ text: "large-output", type: "text" }],
                        toolCallId: "call-1",
                        toolName: "Read",
                        type: "tool_result",
                    },
                ],
                id: "result-1",
                role: "agent",
            };
            await store.saveSession(ctx, state);
            await store.upsertMessage(ctx, state.id, {
                isPartial: false,
                message,
                position: 0,
                runId: "run-1",
            });
            await store.close(ctx);

            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                now: () => 1_000,
                toolResultRetentionMs: 100,
            });

            await vi.waitFor(async () => {
                const page = await store?.loadTranscriptPage(ctx, state.id, 1);
                expect(page?.messages).toEqual([
                    {
                        ...message,
                        blocks: [{ ...message.blocks[0], rendered: [] }],
                    },
                ]);
            });
        } finally {
            await store?.close(ctx);
            await cleanup();
        }
    });

    it("does not reschedule an in-flight tool-result sweep after shutdown stops maintenance", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        let store: PersistentSessionStore | undefined;
        const entered = deferred<void>();
        const release = deferred<void>();
        const prune = vi
            .spyOn(PersistentSessionStore.prototype, "pruneStaleToolResults")
            .mockImplementation(async () => {
                entered.resolve();
                await release.promise;
                return true;
            });
        try {
            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                now: () => 1_000,
                toolResultRetentionMs: 100,
            });
            await entered.promise;

            const stopping = store.prepareForShutdown(ctx, "shutdown");
            release.resolve();
            await stopping;
            await new Promise<void>((resolve) => setTimeout(resolve, 100));

            expect(prune).toHaveBeenCalledOnce();
        } finally {
            prune.mockRestore();
            release.resolve();
            await store?.close(ctx);
            await cleanup();
        }
    });

    it("persists a remote human profile on sessions and injects its Git identity into every runtime", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const localInstanceId = "alocalprofiletest000000001";
        const remoteInstanceId = "aremoteprofiletest00000001";
        let capturedEnvironment: Readonly<Record<string, string>> | undefined;
        let store: PersistentSessionStore | undefined;
        try {
            store = await PersistentSessionStore.open(ctx, {
                createRuntime: (options) => {
                    capturedEnvironment = options.shellEnvironment;
                    throw new Error("Captured profile environment.");
                },
                databasePath,
                localInstanceId,
                resolveModelCatalog: () => testModelCatalog(),
            });
            const profiles = new RigProfileStore({
                database: store,
                localInstanceId,
                publish: () => undefined,
            });
            const profile = {
                createdAt: 1,
                email: "steve@example.test",
                id: "asteveprofile0000000000001",
                name: "Steve Korshakov",
                parentInstanceId: remoteInstanceId,
                updatedAt: 1,
                version: 1,
            } as const;
            await profiles.replicate(ctx, profile, remoteInstanceId);
            const session = await store.create(
                ctx,
                {
                    cwd: "/tmp/rig-profile-session",
                    identity: profile.id,
                },
                { ownerInstanceId: remoteInstanceId, profileId: profile.id },
            );
            const fork = await store.fork(ctx, session.id);

            expect(session.snapshot().profileId).toBe(profile.id);
            expect(fork?.snapshot().profileId).toBe(profile.id);
            await expect(session.compact(ctx)).rejects.toThrow("Captured profile environment.");
            expect(capturedEnvironment).toEqual({
                GIT_AUTHOR_EMAIL: profile.email,
                GIT_AUTHOR_NAME: profile.name,
                GIT_COMMITTER_EMAIL: profile.email,
                GIT_COMMITTER_NAME: profile.name,
            });

            const sessionId = session.id;
            await store?.close(ctx);
            store = await PersistentSessionStore.open(ctx, {
                createRuntime: (options) => {
                    capturedEnvironment = options.shellEnvironment;
                    throw new Error("Captured restored profile environment.");
                },
                databasePath,
                localInstanceId,
                resolveModelCatalog: () => testModelCatalog(),
            });
            const restored = await store.get(ctx, sessionId);
            expect(restored?.snapshot().profileId).toBe(profile.id);
            await expect(restored?.compact(ctx)).rejects.toThrow(
                "Captured restored profile environment.",
            );
            expect(capturedEnvironment).toEqual({
                GIT_AUTHOR_EMAIL: profile.email,
                GIT_AUTHOR_NAME: profile.name,
                GIT_COMMITTER_EMAIL: profile.email,
                GIT_COMMITTER_NAME: profile.name,
            });
        } finally {
            await store?.close(ctx);
            await cleanup();
        }
    });

    it("uses only the session creator's Git credential in a shared remote project", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const home = await mkdtemp(join(tmpdir(), "rig-remote-session-home-"));
        const localInstanceId = "alocalgitbroker0000000001";
        const remoteInstanceId = "aremotegitbroker000000001";
        const workspaceGitTokens: string[] = [];
        const gitCredentialBroker = new GitCredentialBroker({
            forward: async (request) => {
                workspaceGitTokens.push(request.token);
                request.response.writeHead(401);
                request.response.end();
            },
        });
        let captured:
            | {
                  shellEnvironment?: Readonly<Record<string, string>>;
                  projectGitEnvironment?: NodeJS.ProcessEnv;
                  projectGitLoopbackPorts?: readonly number[];
                  secretIds?: readonly string[];
                  secretReferences?: readonly {
                      description: string;
                      environmentVariables: readonly string[];
                      id: string;
                  }[];
              }
            | undefined;
        let store: PersistentSessionStore | undefined;
        try {
            store = await PersistentSessionStore.open(ctx, {
                createRuntime: (options) => {
                    let projectGit = {
                        environment: {},
                        release: () => {},
                    };
                    try {
                        projectGit = options.secrets?.activate(["project-git"]) ?? projectGit;
                    } catch {
                        // A shared project credential is deliberately unavailable until this
                        // session's own creator supplies one.
                    }
                    captured = {
                        ...(options.shellEnvironment === undefined
                            ? {}
                            : { shellEnvironment: options.shellEnvironment }),
                        ...(options.secrets === undefined
                            ? {}
                            : {
                                  projectGitEnvironment: projectGit.environment,
                                  projectGitLoopbackPorts: options.secrets.trustedLoopbackPorts([
                                      "project-git",
                                  ]),
                                  secretIds: options.secrets.ids(),
                                  secretReferences: options.secrets.references(),
                              }),
                    };
                    projectGit.release();
                    throw new Error("Captured brokered Git environment.");
                },
                databasePath,
                gitCredentialBroker,
                homeDirectory: home,
                localInstanceId,
                projectClone: async ({ destination }) => {
                    await createGitRepository(destination);
                    await execFile("git", [
                        "-C",
                        destination,
                        "remote",
                        "add",
                        "origin",
                        "https://github.com/slopus/rig.git",
                    ]);
                },
                resolveModelCatalog: () => testModelCatalog(),
            });
            const profiles = new RigProfileStore({
                database: store,
                localInstanceId,
                publish: () => undefined,
            });
            const projectProfile = {
                createdAt: 1,
                email: "project@example.test",
                id: "agitbrokerprofile0000000001",
                name: "Project creator",
                parentInstanceId: remoteInstanceId,
                updatedAt: 1,
                version: 1,
            } as const;
            const sessionInstanceId = "asessiongitbroker000000001";
            const workspaceInstanceId = "aworkspacegitbroker0000001";
            const workspaceProfile = {
                createdAt: 2,
                email: "workspace@example.test",
                id: "aworkspacegitprofile0000001",
                name: "Workspace creator",
                parentInstanceId: workspaceInstanceId,
                updatedAt: 2,
                version: 1,
            } as const;
            const sessionProfile = {
                createdAt: 3,
                email: "session@example.test",
                id: "asessiongitprofile000000001",
                name: "Session creator",
                parentInstanceId: sessionInstanceId,
                updatedAt: 3,
                version: 1,
            } as const;
            await profiles.replicate(ctx, projectProfile, remoteInstanceId);
            await profiles.replicate(ctx, workspaceProfile, workspaceInstanceId);
            await profiles.replicate(ctx, sessionProfile, sessionInstanceId);
            const project = await store.createRemoteProject(
                ctx,
                {
                    identity: projectProfile.id,
                    name: "Brokered project",
                    secret: { kind: "github" },
                    source: { kind: "github", repository: "slopus/rig" },
                },
                {
                    createdBy: {
                        instanceId: remoteInstanceId,
                        profileId: projectProfile.id,
                    },
                    githubToken: "initial-github-token",
                },
            );
            await expect
                .poll(
                    async () => (await store?.getProject(ctx, project.id))?.initializationStatus,
                    {
                        timeout: 30_000,
                    },
                )
                .toBe("ready");
            const workspace = await store.createWorkspace(
                ctx,
                project.id,
                {
                    identity: workspaceProfile.id,
                    name: "Shared workspace",
                    secret: { kind: "github" },
                },
                {
                    createdBy: {
                        instanceId: workspaceInstanceId,
                        profileId: workspaceProfile.id,
                    },
                    githubToken: "workspace-creator-token",
                },
            );
            await expect
                .poll(
                    async () => (await store?.getWorkspace(ctx, project.id, workspace!.id))?.status,
                    {
                        timeout: 30_000,
                    },
                )
                .toBe("ready");
            expect(workspaceGitTokens.length).toBeGreaterThan(0);
            expect(new Set(workspaceGitTokens)).toEqual(new Set(["workspace-creator-token"]));
            const session = await store.create(
                ctx,
                {
                    cwd: workspace!.path,
                    identity: sessionProfile.id,
                    projectId: project.id,
                    workspaceId: workspace!.id,
                },
                { ownerInstanceId: sessionInstanceId, profileId: sessionProfile.id },
            );
            expect(
                await store.refreshSessionGitCredential(
                    ctx,
                    session.id,
                    { instanceId: remoteInstanceId, profileId: projectProfile.id },
                    "project-creator-session-token",
                ),
            ).toBe(false);
            expect(
                await store.refreshSessionGitCredential(
                    ctx,
                    session.id,
                    {
                        instanceId: workspaceInstanceId,
                        profileId: workspaceProfile.id,
                    },
                    "workspace-creator-session-token",
                ),
            ).toBe(false);
            await expect(session.compact(ctx)).rejects.toThrow(
                "Secret 'project-git' is not attached to this session or project.",
            );
            expect(captured).toBeUndefined();

            expect(
                await store.refreshSessionGitCredential(
                    ctx,
                    session.id,
                    { instanceId: sessionInstanceId, profileId: sessionProfile.id },
                    "session-creator-token",
                ),
            ).toBe(true);

            await expect(session.compact(ctx)).rejects.toThrow(
                "Captured brokered Git environment.",
            );
            expect(JSON.stringify(captured)).not.toContain("initial-github-token");
            expect(JSON.stringify(captured)).not.toContain("project-creator-session-token");
            expect(JSON.stringify(captured)).not.toContain("workspace-creator-session-token");
            expect(JSON.stringify(captured)).not.toContain("workspace-creator-token");
            expect(JSON.stringify(captured)).not.toContain("session-creator-token");
            expect(captured?.shellEnvironment).toMatchObject({
                GIT_AUTHOR_EMAIL: sessionProfile.email,
                GIT_AUTHOR_NAME: sessionProfile.name,
            });
            expect(captured?.shellEnvironment).not.toHaveProperty("GIT_CONFIG_KEY_1");
            expect(captured?.projectGitEnvironment).toMatchObject({
                GIT_CONFIG_VALUE_1: "https://github.com/slopus/rig.git",
            });
            expect(captured?.projectGitEnvironment?.GIT_CONFIG_KEY_1).toMatch(
                /^url\.http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/github\.com\/slopus\/rig\.git\.insteadOf$/u,
            );
            expect(captured?.projectGitLoopbackPorts).toEqual([expect.any(Number)]);
            expect(captured?.secretIds).toEqual([]);
            expect(captured?.secretReferences).toEqual([
                {
                    description: expect.stringContaining("credential proxy"),
                    environmentVariables: [
                        "GCM_INTERACTIVE",
                        "GIT_CONFIG_COUNT",
                        "GIT_CONFIG_KEY_0",
                        "GIT_CONFIG_KEY_1",
                        "GIT_CONFIG_VALUE_0",
                        "GIT_CONFIG_VALUE_1",
                        "GIT_TERMINAL_PROMPT",
                    ],
                    id: "project-git",
                },
            ]);
        } finally {
            await store?.close(ctx);
            await Promise.all([
                cleanup(),
                rm(home, {
                    force: true,
                    recursive: true,
                }),
            ]);
        }
    }, 90_000);

    it("persists an explicit session owner and keeps it when a session is forked or restored", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const localInstanceId = "alocalinstance00000000001";
        const remoteInstanceId = "aremoteinstance0000000001";
        const resolvedOwners: string[] = [];
        const resolveModelCatalog = (ownerInstanceId: string) => {
            resolvedOwners.push(ownerInstanceId);
            return testModelCatalog();
        };
        let store: PersistentSessionStore | undefined;
        try {
            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                localInstanceId,
                resolveModelCatalog,
            });
            const session = await store.create(
                ctx,
                { cwd: "/tmp/rig-session-owner" },
                { ownerInstanceId: remoteInstanceId },
            );
            const fork = await store.fork(ctx, session.id);

            expect(session.snapshot().ownerInstanceId).toBe(remoteInstanceId);
            expect(fork?.snapshot().ownerInstanceId).toBe(remoteInstanceId);
            expect(session.state().credentialBindingId).toBe(`${remoteInstanceId}:codex`);
            expect(resolvedOwners).toEqual([localInstanceId, remoteInstanceId, remoteInstanceId]);

            const sessionId = session.id;
            await store.saveSession(ctx, { ...session.state(), ownerInstanceId: localInstanceId });
            await store?.close(ctx);
            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                localInstanceId,
                resolveModelCatalog,
            });

            expect((await store.get(ctx, sessionId))?.state().ownerInstanceId).toBe(
                remoteInstanceId,
            );
            expect((await store.get(ctx, sessionId))?.state().credentialBindingId).toBe(
                `${remoteInstanceId}:codex`,
            );
            expect((await store.list(ctx))[0]?.ownerInstanceId).toBe(remoteInstanceId);
        } finally {
            await store?.close(ctx);
            await cleanup();
        }
    });

    it("reserves sessions and durable runs on an initializing workspace without creating runtimes", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const root = await mkdtemp(join(tmpdir(), "rig-initializing-workspace-"));
        const repository = join(root, "project");
        const materialize = deferred<void>();
        let runtimes = 0;
        let store: PersistentSessionStore | undefined;
        try {
            await createGitRepository(repository);
            const projectGit: GitCommandRunner = async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    await materialize.promise;
                }
                const result = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
                return result.stdout.trim();
            };
            store = await PersistentSessionStore.open(ctx, {
                createRuntime: () => {
                    runtimes += 1;
                    throw new Error("An initializing workspace must not create a runtime.");
                },
                databasePath,
                projectGit,
                stateDirectory: join(root, "state"),
                workspacesDirectory: join(root, "workspaces"),
            });
            const owner = await store.create(ctx, { cwd: repository });
            const workspace = await store.createWorkspace(ctx, owner.snapshot().projectId!, {
                baseRef: "HEAD",
                id: "w6q0tc4rmq9f4a6adczq9eis",
                name: "Waiting",
            });
            if (workspace === undefined) throw new Error("Expected a workspace reservation.");

            expect(workspace.status).toBe("initializing");
            const first = await store.createWithId(ctx, "d044lyyqklbc850un07gpm9v", {
                cwd: workspace.path,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
            });
            const second = await store.createWithId(ctx, "l4c1r61a2hedg6f2zrzfwz4w", {
                cwd: workspace.path,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
            });
            const firstRun = await first.submit(ctx, {
                clientSubmissionId: "m7ymgv1cqfbjd0pxukc8403w",
                text: "First queued message.",
            });
            const repeatedRun = await first.submit(ctx, {
                clientSubmissionId: "m7ymgv1cqfbjd0pxukc8403w",
                text: "First queued message.",
            });
            const secondRun = await second.submit(ctx, {
                clientSubmissionId: "n3tfnng0rkcw4mxc3nfq4ntc",
                debug: true,
                text: "Second queued message.",
            });

            expect(
                await store.createWithId(ctx, first.id, {
                    cwd: workspace.path,
                    projectId: workspace.projectId,
                    workspaceId: workspace.id,
                }),
            ).toBe(first);
            expect(repeatedRun).toEqual(firstRun);
            expect(first.snapshot()).toMatchObject({
                status: "queued",
            });
            expect(second.snapshot()).toMatchObject({
                status: "queued",
            });
            expect(first.state().queuedRuns.map((run) => run.runId)).toEqual([firstRun.runId]);
            expect(second.state().queuedRuns.map((run) => run.runId)).toEqual([secondRun.runId]);
            await new Promise<void>((resolve) => setImmediate(resolve));
            await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
            expect(runtimes).toBe(0);
        } finally {
            materialize.resolve();
            await store?.close(ctx);
            await Promise.all([cleanup(), rm(root, { force: true, recursive: true })]);
        }
    });

    it("gives an unnamed workspace the title of its first session", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const root = await mkdtemp(join(tmpdir(), "rig-workspace-session-title-"));
        const repository = join(root, "project");
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ models: [model], providerId: "gym" }],
        };
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let store: PersistentSessionStore | undefined;
        try {
            await createGitRepository(repository);
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") {
                    throw new Error("Expected a serialized gym inference request.");
                }
                const request = JSON.parse(init.body) as GymInferenceRequest;
                return (
                    sessionMetadataResponse(request) ??
                    new Response(
                        JSON.stringify({
                            content: [{ text: "Done.", type: "text" }],
                            stopReason: "stop",
                        }),
                        { headers: { "content-type": "application/json" }, status: 200 },
                    )
                );
            };
            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
                stateDirectory: join(root, "state"),
                workspacesDirectory: join(root, "workspaces"),
            });
            const owner = await store.create(ctx, { cwd: repository });
            const projectId = owner.snapshot().projectId;
            if (projectId === undefined) throw new Error("Expected a registered project.");
            const workspace = await store.createWorkspace(ctx, projectId, {
                baseRef: "main",
                name: "Workspace 90",
            });
            if (workspace === undefined) throw new Error("Expected a workspace.");
            await expect
                .poll(async () => (await store?.getWorkspace(ctx, projectId, workspace.id))?.status)
                .toBe("ready");
            const session = await store.create(ctx, {
                cwd: workspace.path,
                modelId: model.id,
                projectId,
                providerId: "gym",
                workspaceId: workspace.id,
            });

            const submitted = await session.submit(ctx, { text: "Name this workspace." });
            await expect(session.waitForRun(ctx, submitted.runId)).resolves.toEqual({
                status: "completed",
            });

            await expect
                .poll(async () => (await store?.getWorkspace(ctx, projectId, workspace.id))?.name)
                .toBe("Generated Session Title");
        } finally {
            await store?.close(ctx);
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) {
                delete process.env.RIG_GYM_INFERENCE_URL;
            } else {
                process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            }
            await Promise.all([cleanup(), rm(root, { force: true, recursive: true })]);
        }
    });

    it("rolls back every session when one workspace archive write fails", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const root = await mkdtemp(join(tmpdir(), "rig-workspace-archive-rollback-"));
        const repository = join(root, "project");
        let store: PersistentSessionStore | undefined;
        try {
            await createGitRepository(repository);
            const projectGit: GitCommandRunner = async (cwd, args) => {
                const result = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
                return result.stdout.trim();
            };
            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                projectGit,
                stateDirectory: join(root, "state"),
                workspacesDirectory: join(root, "workspaces"),
            });
            const owner = await store.create(ctx, { cwd: repository });
            const projectId = owner.snapshot().projectId;
            if (projectId === undefined) throw new Error("Expected a registered project.");
            const workspace = await store.createWorkspace(ctx, projectId, {
                baseRef: "HEAD",
                name: "Rollback",
            });
            if (workspace === undefined) throw new Error("Expected a workspace.");
            await expect
                .poll(async () => (await store?.getWorkspace(ctx, projectId, workspace.id))?.status)
                .toBe("ready");
            const first = await store.create(ctx, {
                cwd: workspace.path,
                projectId,
                workspaceId: workspace.id,
            });
            const second = await store.create(ctx, {
                cwd: workspace.path,
                projectId,
                workspaceId: workspace.id,
            });
            const originalSaveSession = store.saveSession.bind(store);
            const failure = Object.assign(new Error("second session archive failed"), {
                code: "SQLITE_IOERR",
            });
            const saveSession = vi
                .spyOn(store, "saveSession")
                .mockImplementation(async (saveCtx, state) => {
                    if (state.id === second.id && state.archived) throw failure;
                    await originalSaveSession(saveCtx, state);
                });

            await expect(store.archiveWorkspace(ctx, projectId, workspace.id)).rejects.toBe(
                failure,
            );

            expect(first.snapshot()).toMatchObject({ archived: false, status: "idle" });
            expect(second.snapshot()).toMatchObject({ archived: false, status: "idle" });
            expect(
                first.events
                    .since(undefined)
                    ?.some((event) => event.type === "session_workspace_archived"),
            ).toBe(false);
            saveSession.mockRestore();
        } finally {
            await store?.close(ctx);
            await Promise.all([cleanup(), rm(root, { force: true, recursive: true })]);
        }
    });

    it("restores pending context and rewinds or resets it atomically", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            let store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-pending-context-restore" });
            const sessionId = session.id;
            await session.submitContext(ctx, { clientSubmissionId: "note-1", text: "First note." });
            await session.submitContext(ctx, {
                clientSubmissionId: "note-2",
                text: "Second note.",
            });
            await session.rewind(ctx, "note-2");
            await store?.close(ctx);

            store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const restored = await store.get(ctx, sessionId);
            expect(restored?.state().pendingContextMessages).toMatchObject([
                { message: { id: "note-1" } },
            ]);
            expect(restored?.state().contextMessages).toEqual([]);
            await restored?.reset(ctx);
            await store?.close(ctx);

            store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            expect((await store.get(ctx, sessionId))?.state().pendingContextMessages).toEqual([]);
            expect((await store.get(ctx, sessionId))?.state().messages).toEqual([]);
            await store?.close(ctx);
        } finally {
            await cleanup();
        }
    });

    it("does not swallow database failures from post-commit observers", async () => {
        const failure = Object.assign(new Error("observer database failed"), {
            code: "SQLITE_IOERR",
        });
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            onSessionEvent: () => {
                throw failure;
            },
        });
        try {
            await expect(
                store.create(ctx, { cwd: "/tmp/rig-observer-database-failure" }),
            ).rejects.toMatchObject({
                cause: failure,
                name: "SessionTransactionPostCommitError",
            });
        } finally {
            await store?.close(ctx);
        }
    });

    it("replays durable usage written after the persisted summary cursor", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-usage-crash-boundary" });
            const sessionId = session.id;
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            const previous = (await queryTestRow<{ last_event_id: string }>(
                database,
                "SELECT last_event_id FROM sessions WHERE id = ?",
                [sessionId],
            ))!;
            const eventId = createEventIdFactory({ after: previous.last_event_id })();
            await insertSessionEvent(database, sessionId, eventId, "agent_message", {
                message: {
                    blocks: [{ text: "Recovered usage", type: "text" }],
                    id: "agent-after-summary",
                    providerId: "codex",
                    requestedModelId: session.snapshot().modelId,
                    role: "agent",
                    usage: {
                        cacheRead: 3,
                        cacheWrite: 4,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 10,
                        output: 2,
                        totalTokens: 19,
                    },
                },
                runId: "run-after-summary",
            });
            await database.execute({
                args: [eventId, sessionId],
                sql: "UPDATE sessions SET last_event_id = ? WHERE id = ?",
            });
            await database.close();

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.get(ctx, sessionId))?.usage().groups).toEqual([
                    expect.objectContaining({
                        usage: expect.objectContaining({ totalTokens: 19 }),
                    }),
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("rolls back a message when its turn projection cannot be written", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const initial = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState();
            await initial.saveSession(ctx, state);
            await initial.close(ctx);
            const database = openTestDatabase(databasePath);
            await database.execute(`
                CREATE TRIGGER reject_turn_projection
                BEFORE INSERT ON session_turns
                BEGIN
                    SELECT RAISE(ABORT, 'projection failed');
                END
            `);
            await database.close();

            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await expectErrorChainToContain(
                store.upsertMessage(ctx, state.id, {
                    isPartial: false,
                    message: textUserMessage("message-1", "Do it"),
                    position: 0,
                    runId: "run-1",
                }),
                "projection failed",
            );
            await store?.close(ctx);

            const check = openTestDatabase(databasePath);
            expect(
                await queryTestRow(check, "SELECT 1 FROM session_messages WHERE session_id = ?", [
                    state.id,
                ]),
            ).toBeUndefined();
            await check.close();
        } finally {
            await cleanup();
        }
    });

    it("restores only a bounded resume tail for an old session", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-bounded-events-"));
        const databasePath = join(directory, "sessions.sqlite");
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-bounded-events" });
            const sessionId = session.id;
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            const previous = (await queryTestRow<{ last_event_id: string }>(
                database,
                "SELECT last_event_id FROM sessions WHERE id = ?",
                [sessionId],
            ))!;
            const createId = createEventIdFactory({ after: previous.last_event_id });
            const oldMessage = textUserMessage("old-message", "Old history");
            const oldSteering = textUserMessage("old-steering", "Steer old history");
            await database.execute({
                args: [sessionId, oldMessage.id, JSON.stringify(oldMessage), 1_700_000_000_000],
                sql: "INSERT INTO session_messages (session_id, position, message_id, role, is_partial, run_id, message_json, updated_at_ms) VALUES (?, 0, ?, 'user', 0, 'run-old', ?, ?)",
            });
            await database.execute({
                args: [sessionId, oldSteering.id, JSON.stringify(oldSteering), 1_700_000_000_000],
                sql: "INSERT INTO session_messages (session_id, position, message_id, role, is_partial, run_id, message_json, updated_at_ms) VALUES (?, 1, ?, 'user', 0, 'run-old', ?, ?)",
            });
            await database.execute({
                args: [sessionId],
                sql: "INSERT INTO session_turns (session_id, run_id, first_position) VALUES (?, 'run-old', 0)",
            });
            await insertSessionEvent(database, sessionId, createId(), "message_submitted", {
                delivery: "run",
                displayText: "Old history",
                message: oldMessage,
                runId: "run-old",
            });
            await insertSessionEvent(database, sessionId, createId(), "message_submitted", {
                delivery: "steer",
                displayText: "Steer old history",
                message: oldSteering,
                runId: "run-old",
            });
            await insertSessionEvent(database, sessionId, createId(), "steering_applied", {
                messageIds: [oldSteering.id],
                runId: "run-old",
            });
            await insertSessionEvent(database, sessionId, createId(), "run_finished", {
                modelLocked: false,
                runId: "run-old",
                stopReason: "stop",
            });
            const transaction = await database.transaction("write");
            let lastEventId = previous.last_event_id;
            try {
                for (let index = 0; index < 5_000; index += 1) {
                    lastEventId = createId();
                    await transaction.execute({
                        args: [
                            sessionId,
                            lastEventId,
                            1_700_000_000_000 + index,
                            index === 4_500
                                ? JSON.stringify({
                                      legacySnapshot: "x".repeat(5 * 1_024 * 1_024),
                                  })
                                : "{}",
                        ],
                        sql: "INSERT INTO session_events (session_id, event_id, type, created_at_ms, data_json) VALUES (?, ?, 'session_updated', ?, ?)",
                    });
                }
                await transaction.execute({
                    args: [lastEventId, sessionId],
                    sql: "UPDATE sessions SET last_event_id = ? WHERE id = ?",
                });
                await transaction.commit();
            } catch (error) {
                await transaction.rollback();
                throw error;
            } finally {
                await transaction.close();
            }
            await database.close();

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, sessionId);
                expect(restored?.events.all()).toHaveLength(499);
                expect(JSON.stringify(restored?.events.all())).not.toContain("legacySnapshot");
                expect(restored?.events.lastEventId()).toBe(lastEventId);
                expect((await restored?.transcriptWindow(ctx))?.turns).toEqual([
                    expect.objectContaining({
                        outcome: "success",
                        runId: "run-old",
                        startedAt: 1_700_000_000_000,
                    }),
                ]);
                expect((await restored?.transcriptWindow(ctx))?.messageSteeredAt).toEqual({
                    [oldSteering.id]: 1_700_000_000_000,
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("restores legacy state events without materializing their embedded conversation", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const marker = "legacy-conversation-payload-".repeat(200_000);
        try {
            const store = await PersistentSessionStore.open(ctx, { databasePath });
            const session = await store.create(ctx, { cwd: "/tmp/rig-legacy-state-event" });
            const sessionId = session.id;
            const snapshot = session.snapshot();
            await store.close(ctx);

            const database = openTestDatabase(databasePath);
            const previous = (await queryTestRow<{ last_event_id: string }>(
                database,
                "SELECT last_event_id FROM sessions WHERE id = ?",
                [sessionId],
            ))!;
            const eventId = createEventIdFactory({ after: previous.last_event_id })();
            const embedded = textUserMessage("legacy-embedded-message", marker);
            await insertSessionEvent(database, sessionId, eventId, "session_updated", {
                session: {
                    ...snapshot,
                    snapshot: {
                        ...snapshot.snapshot,
                        contextMessages: [embedded],
                        messages: [embedded],
                    },
                },
            });
            await database.execute({
                args: [eventId, sessionId],
                sql: "UPDATE sessions SET last_event_id = ? WHERE id = ?",
            });
            expect(
                await queryTestRow<{ bytes: number }>(
                    database,
                    "SELECT length(data_json) AS bytes FROM session_events WHERE event_id = ?",
                    [eventId],
                ),
            ).toMatchObject({ bytes: expect.any(Number) });
            await database.close();

            const restoredStore = await PersistentSessionStore.open(ctx, { databasePath });
            try {
                const restored = await restoredStore.get(ctx, sessionId);
                const event = restored?.events.all().find((candidate) => candidate.id === eventId);
                expect(event).toBeUndefined();
                expect(restored?.events.lastEventId()).toBe(eventId);
            } finally {
                await restoredStore.close(ctx);
            }

            const unchanged = openTestDatabase(databasePath);
            try {
                expect(
                    await queryTestRow<{ present: number }>(
                        unchanged,
                        "SELECT instr(data_json, 'legacy-conversation-payload') > 0 AS present FROM session_events WHERE event_id = ?",
                        [eventId],
                    ),
                ).toEqual({ present: 1 });
            } finally {
                await unchanged.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("reads a session restore while another WAL connection holds the writer reservation", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        let opened: Awaited<ReturnType<typeof openSessionDatabase>> | undefined;
        let blocker: Client | undefined;
        let writer: Awaited<ReturnType<Client["transaction"]>> | undefined;
        try {
            const store = await PersistentSessionStore.open(ctx, { databasePath });
            const session = await store.create(ctx, { cwd: "/tmp/rig-concurrent-reader" });
            const sessionId = session.id;
            await store.close(ctx);

            opened = await openSessionDatabase(ctx, databasePath);
            blocker = openTestDatabase(databasePath);
            writer = await blocker.transaction("write");
            await writer.execute("UPDATE projects SET updated_at_ms = updated_at_ms + 1");

            await expect(querySessionRestore(opened.ctx, sessionId)).resolves.toMatchObject({
                restore: { id: sessionId },
            });
            await opened.client.execute("PRAGMA busy_timeout = 10");
            await expect(
                inTx(opened.ctx, "rig.sql.test.writer_reservation", async (ctx) => {
                    await ctx.tx.run(sql`UPDATE projects SET updated_at_ms = updated_at_ms + 1`);
                }),
            ).rejects.toThrow(/BEGIN IMMEDIATE/);
        } finally {
            await writer?.rollback();
            await writer?.close();
            await blocker?.close();
            await opened?.database.close(opened.ctx);
            await cleanup();
        }
    });

    it("lists every active session without materializing archived history", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            const archived = await store.transaction(ctx, async (transactionCtx) => {
                for (let index = 0; index < 501; index += 1) {
                    await store.createWithId(transactionCtx, `session-${String(index)}`, {
                        cwd: "/tmp/rig-complete-session-list",
                    });
                }
                const session = await store.createWithId(transactionCtx, "archived-session", {
                    cwd: "/tmp/rig-complete-session-list",
                });
                await session.setArchived(transactionCtx, true);
                return session;
            });

            expect(await store.listActive(ctx)).toHaveLength(501);
            expect(await store.list(ctx, { limit: 500 })).toHaveLength(500);
            expect((await store.listActive(ctx)).map((session) => session.id)).not.toContain(
                archived.id,
            );
        } finally {
            await store?.close(ctx);
        }
    }, 30_000);

    it("creates an idempotent persistent session with an integrating client ID", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            const first = await store.createWithId(ctx, "happy-rig-request-1", {
                cwd: "/tmp/rig-happy",
            });
            const second = await store.createWithId(ctx, "happy-rig-request-1", {
                cwd: "/tmp/rig-happy",
            });

            expect(first.id).toBe("happy-rig-request-1");
            expect(second).toBe(first);
            expect(second.snapshot().cwd).toBe("/tmp/rig-happy");
            // The same identity describing a different session is a mistake, not
            // a retry, so it is refused rather than quietly answered.
            await expect(
                store.createWithId(ctx, "happy-rig-request-1", { cwd: "/tmp/rig-elsewhere" }),
            ).rejects.toThrow("another directory");
        } finally {
            await store?.close(ctx);
        }
    });

    it.skip("resumes a structured user question after daemon restart without replaying its call", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ models: [model], providerId: "gym" }],
        };
        const requests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let store: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                return new Response(
                    JSON.stringify(
                        requests.length === 1
                            ? {
                                  content: [
                                      {
                                          arguments: {
                                              questions: [
                                                  {
                                                      header: "Database",
                                                      id: "database",
                                                      options: [
                                                          {
                                                              description: "Use PostgreSQL.",
                                                              label: "PostgreSQL",
                                                          },
                                                          {
                                                              description: "Use SQLite.",
                                                              label: "SQLite",
                                                          },
                                                      ],
                                                      question: "Which database should be used?",
                                                  },
                                              ],
                                          },
                                          id: "durable-question-one",
                                          name: "request_user_input",
                                          type: "toolCall",
                                      },
                                      {
                                          arguments: {
                                              questions: [
                                                  {
                                                      header: "Cache",
                                                      id: "cache",
                                                      options: [
                                                          {
                                                              description: "Use Redis.",
                                                              label: "Redis",
                                                          },
                                                          {
                                                              description: "Do not use a cache.",
                                                              label: "None",
                                                          },
                                                      ],
                                                      question: "Which cache should be used?",
                                                  },
                                              ],
                                          },
                                          id: "durable-question-two",
                                          name: "request_user_input",
                                          type: "toolCall",
                                      },
                                  ],
                              }
                            : { content: [{ text: "Question resolved.", type: "text" }] },
                    ),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            const session = await store.create(ctx, {
                cwd: "/tmp/rig-durable-user-input",
                modelId: model.id,
                permissionMode: "full_access",
                providerId: "gym",
            });
            const submitted = await session.submit(ctx, { text: "Choose a database." });
            await waitForPendingUserInputs(session, 2);

            await store.prepareForShutdown(ctx, "shutdown");
            await store?.close(ctx);
            store = undefined;

            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            const restored = await store.get(ctx, session.id);
            if (restored === undefined) throw new Error("Expected restored session.");
            const pendingUserInputs = restored.snapshot().pendingUserInputs;
            const databaseRequestId = pendingUserInputs[0]?.requestId;
            const cacheRequestId = pendingUserInputs[1]?.requestId;
            if (databaseRequestId === undefined || cacheRequestId === undefined) {
                throw new Error("Expected both restored user questions.");
            }
            expect(databaseRequestId).not.toBe(cacheRequestId);
            expect(restored.snapshot()).toMatchObject({
                pendingUserInputs: [
                    { requestId: databaseRequestId },
                    { requestId: cacheRequestId },
                ],
                status: "running",
            });

            const databaseAnswer = { answers: { database: ["PostgreSQL"] } };
            const cacheAnswer = { answers: { cache: ["Redis"] } };
            await expect(
                restored.answerUserInput(ctx, cacheRequestId, cacheAnswer),
            ).resolves.toBeDefined();
            await expect(
                restored.answerUserInput(ctx, databaseRequestId, databaseAnswer),
            ).resolves.toBeDefined();
            await expect(restored.waitForRun(ctx, submitted.runId)).resolves.toEqual({
                status: "completed",
            });
            expect(requests).toHaveLength(2);
            expect(requests[1]?.context.messages.slice(-2)).toMatchObject([
                {
                    content: [
                        {
                            text: '{"answers":{"database":{"answers":["PostgreSQL"]}}}',
                            type: "text",
                        },
                    ],
                    role: "toolResult",
                    providerToolCallId: "durable-question-one",
                    toolCallId: databaseRequestId,
                },
                {
                    content: [
                        {
                            text: '{"answers":{"cache":{"answers":["Redis"]}}}',
                            type: "text",
                        },
                    ],
                    role: "toolResult",
                    providerToolCallId: "durable-question-two",
                    toolCallId: cacheRequestId,
                },
            ]);
            await expect(
                restored.answerUserInput(ctx, databaseRequestId, databaseAnswer),
            ).resolves.toBeDefined();
            await expect(
                restored.answerUserInput(ctx, databaseRequestId, {
                    answers: { database: ["SQLite"] },
                }),
            ).rejects.toThrow("already has a different answer");
        } finally {
            await store?.close(ctx);
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            await cleanup();
        }
    });

    it("restores appended system prompts after reopening SQLite", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, {
                appendSystemPrompt: "Persisted API instructions.",
                cwd: "/tmp/rig-persistent-prompt-test",
            });
            await session.update(ctx, { appendSystemPrompt: "Updated persisted instructions." });
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, session.id);
                expect(restored?.snapshot().appendSystemPrompt).toBe(
                    "Updated persisted instructions.",
                );
                expect(restored?.requestForSubagent().appendSystemPrompt).toBe(
                    "Updated persisted instructions.",
                );
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("delivers transient inference events live without writing session event rows", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-persistent-session-test" });
            const transient = sessionEvent(session.id, "transient-text", "agent_event", {
                event: { contentIndex: 0, delta: "token", partial: {}, type: "text_delta" },
                runId: "run-1",
            });
            const processChanged = sessionEvent(session.id, "process-changed", "agent_event", {
                event: { running: 1, type: "background_processes_changed" },
                runId: "run-1",
            });
            const compacted = sessionEvent(session.id, "context-compacted", "agent_event", {
                event: {
                    compactionId: "compaction-1",
                    compactedMessageCount: 4,
                    elapsedMs: 25,
                    estimatedTokensAfter: 600,
                    estimatedTokensBefore: 4_200,
                    reason: "threshold",
                    type: "context_compacted",
                },
                runId: "run-1",
            });
            const delivered: SessionEvent[] = [];
            session.events.subscribe((event) => {
                delivered.push(event);
            });

            await session.events.append(ctx, transient);
            await session.events.append(ctx, processChanged);
            await session.events.append(ctx, compacted);

            expect(session.events.since(undefined)?.map((event) => event.id)).toEqual([
                expect.any(String),
                processChanged.id,
                compacted.id,
            ]);
            expect(delivered.map((event) => event.id)).toEqual([
                transient.id,
                processChanged.id,
                compacted.id,
            ]);
            const database = openTestDatabase(databasePath);
            try {
                const rows = await queryTestRows<{ event_id: string }>(
                    database,
                    "SELECT event_id FROM session_events WHERE session_id = ? ORDER BY seq",
                    [session.id],
                );
                expect(rows.map((row) => row.event_id)).toEqual([
                    expect.any(String),
                    processChanged.id,
                    compacted.id,
                ]);
            } finally {
                await database.close();
            }
            await store?.close(ctx);
        } finally {
            await cleanup();
        }
    });

    it("restores secret registrations and source-scoped attachments after reopening SQLite", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.registerSecret(ctx, {
                description: "Service API credentials",
                environment: {
                    SERVICE_REGION: "persisted-region",
                    SERVICE_TOKEN: "persisted-token",
                },
                id: "service",
            });
            await store.registerSecret(ctx, {
                description: "Project service credentials",
                environment: { PROJECT_TOKEN: "persisted-project-token" },
                id: "project-service",
            });
            const session = await store.create(ctx, {
                cwd: "/tmp/rig-secret-session",
                secretIds: ["service"],
            });
            await store.attachSecret(ctx, session.id, "project-service", "project");
            expect(session.snapshot()).toMatchObject({
                projectSecretIds: ["project-service"],
                secretIds: ["project-service", "service"],
                sessionSecretIds: ["service"],
            });
            expect(session.requestForSubagent()).not.toHaveProperty("secretIds");
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            const sessionRow = (await queryTestRow<{ secret_ids_json: string }>(
                database,
                "SELECT secret_ids_json FROM sessions WHERE id = ?",
                [session.id],
            ))!;
            const registrationRow = (await queryTestRow<{
                description: string;
                environment_json: string;
            }>(
                database,
                "SELECT description, environment_json FROM secret_registrations WHERE id = ?",
                ["service"],
            ))!;
            expect(sessionRow.secret_ids_json).toBe('["service"]');
            expect(registrationRow.description).toBe("Service API credentials");
            expect(JSON.parse(registrationRow.environment_json)).toEqual({
                SERVICE_REGION: "persisted-region",
                SERVICE_TOKEN: "persisted-token",
            });
            await database.close();

            let restoredEnvironment: NodeJS.ProcessEnv | undefined;
            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                createRuntime: (options) => {
                    restoredEnvironment = options.secrets?.resolve(["project-service", "service"]);
                    throw new Error("Captured restored secret environment.");
                },
            });
            try {
                expect(await restoredStore.listSecrets(ctx)).toEqual([
                    {
                        description: "Project service credentials",
                        environmentVariables: ["PROJECT_TOKEN"],
                        id: "project-service",
                    },
                    {
                        description: "Service API credentials",
                        environmentVariables: ["SERVICE_REGION", "SERVICE_TOKEN"],
                        id: "service",
                    },
                ]);
                const restoredSession = await restoredStore.get(ctx, session.id);
                if (restoredSession === undefined) throw new Error("Expected restored session.");
                await expect(restoredSession.compact(ctx)).rejects.toThrow(
                    "Captured restored secret environment.",
                );
                expect(restoredEnvironment).toEqual({
                    PROJECT_TOKEN: "persisted-project-token",
                    SERVICE_REGION: "persisted-region",
                    SERVICE_TOKEN: "persisted-token",
                });
                expect(restoredSession.snapshot()).toMatchObject({
                    projectSecretIds: ["project-service"],
                    secretIds: ["project-service", "service"],
                    sessionSecretIds: ["service"],
                });

                const fork = await restoredStore.fork(ctx, session.id);
                expect(fork?.snapshot()).toMatchObject({
                    projectSecretIds: ["project-service"],
                    secretIds: ["project-service"],
                    sessionSecretIds: [],
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps system-managed GitHub credentials out of durable secret registrations and attachments", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.registerSpecialSecret(ctx, { kind: "github", token: "runtime-only-token" });
            await expect(
                store.create(ctx, {
                    cwd: "/tmp/rig-github-secret-rejected-session",
                    secretIds: ["github"],
                }),
            ).rejects.toThrow("managed by Rig and cannot be attached to agent commands");
            const session = await store.create(ctx, { cwd: "/tmp/rig-github-secret-session" });
            await expect(store.attachSecret(ctx, session.id, "github", "session")).rejects.toThrow(
                "managed by Rig and cannot be attached to agent commands",
            );
            expect(await store.listSecrets(ctx)).toEqual([
                {
                    availableToModel: false,
                    description: "GitHub CLI credentials",
                    environmentVariables: ["GH_TOKEN"],
                    id: "github",
                    kind: "github",
                },
            ]);
            expect(session.snapshot()).toMatchObject({
                projectSecretIds: [],
                secretIds: [],
                sessionSecretIds: [],
            });
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            try {
                expect(
                    await queryTestRow(
                        database,
                        "SELECT COUNT(*) AS count FROM secret_registrations",
                    ),
                ).toEqual({ count: 0 });
                expect(
                    await queryTestRow(
                        database,
                        "SELECT secret_ids_json FROM sessions WHERE id = ?",
                        [session.id],
                    ),
                ).toEqual({ secret_ids_json: "[]" });
            } finally {
                await database.close();
            }

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect(await restoredStore.listSecrets(ctx)).toEqual([]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists targeted secret field updates without replacing omitted values", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.registerSecret(ctx, {
                description: "Original credentials",
                environment: { KEEP: "unchanged", REMOVE: "old", ROTATE: "old" },
                id: "service",
            });
            expect(
                await store.updateSecret(ctx, "service", {
                    description: "Updated credentials",
                    environment: { ADDED: "new", REMOVE: null, ROTATE: "rotated" },
                }),
            ).toEqual({
                description: "Updated credentials",
                environmentVariables: ["ADDED", "KEEP", "ROTATE"],
                id: "service",
            });
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            try {
                const row = (await queryTestRow<{
                    description: string;
                    environment_json: string;
                }>(
                    database,
                    "SELECT description, environment_json FROM secret_registrations WHERE id = ?",
                    ["service"],
                ))!;
                expect(row.description).toBe("Updated credentials");
                expect(JSON.parse(row.environment_json)).toEqual({
                    ADDED: "new",
                    KEEP: "unchanged",
                    ROTATE: "rotated",
                });
            } finally {
                await database.close();
            }

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect(await restoredStore.listSecrets(ctx)).toEqual([
                    {
                        description: "Updated credentials",
                        environmentVariables: ["ADDED", "KEEP", "ROTATE"],
                        id: "service",
                    },
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("conservatively restores null, missing, and unknown agent event subtypes", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const sessionId = (await store.create(ctx, { cwd: "/tmp/rig-persistent-session-test" }))
                .id;
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            await insertSessionEvent(database, sessionId, "null-subtype", "agent_event", {
                event: { type: null },
                runId: "run-1",
            });
            await insertSessionEvent(database, sessionId, "missing-subtype", "agent_event", {
                event: {},
                runId: "run-1",
            });
            await insertSessionEvent(database, sessionId, "unknown-subtype", "agent_event", {
                event: { type: "future_provider_event" },
                runId: "run-1",
            });
            await database.close();

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect(
                    (await restoredStore.get(ctx, sessionId))?.events
                        .since(undefined)
                        ?.map((event) => event.id),
                ).toEqual([
                    expect.any(String),
                    "null-subtype",
                    "missing-subtype",
                    "unknown-subtype",
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("restores historical masking destinations after rotating a registration", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.registerSecret(ctx, {
                description: "Initial service credentials",
                environment: { OLD_SERVICE_TOKEN: "old" },
                id: "service",
            });
            const session = await store.create(ctx, {
                cwd: "/tmp/rotated-secret-session",
                secretIds: ["service"],
            });
            await store.registerSecret(ctx, {
                description: "Rotated service credentials",
                environment: { NEW_SERVICE_TOKEN: "new" },
                id: "service",
            });
            await store?.close(ctx);

            let restoredDestinations: readonly string[] | undefined;
            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                createRuntime: (options) => {
                    restoredDestinations = options.secrets?.environmentVariables();
                    throw new Error("Captured restored masking destinations.");
                },
            });
            try {
                const restoredSession = await restoredStore.get(ctx, session.id);
                if (restoredSession === undefined) throw new Error("Expected restored session.");
                await expect(restoredSession.compact(ctx)).rejects.toThrow(
                    "Captured restored masking destinations.",
                );
                expect(restoredDestinations).toHaveLength(2);
                expect(restoredDestinations).toEqual(
                    expect.arrayContaining(["OLD_SERVICE_TOKEN", "NEW_SERVICE_TOKEN"]),
                );
                expect(await restoredStore.listSecrets(ctx)).toEqual([
                    {
                        description: "Rotated service credentials",
                        environmentVariables: ["NEW_SERVICE_TOKEN"],
                        id: "service",
                    },
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("recovers a transient event cursor across restart without replaying durable history", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-persistent-session-test" });
            const otherSession = await store.create(ctx, { cwd: "/tmp/rig-other-session-test" });
            const otherSessionCursor = otherSession.snapshot().lastEventId;
            if (otherSessionCursor === undefined) throw new Error("Expected another cursor.");
            const currentCursor = session.snapshot().lastEventId;
            if (currentCursor === undefined) throw new Error("Expected a session cursor.");
            const createFutureEventId = createEventIdFactory({
                after: currentCursor,
                now: () => Date.now() + 60_000,
            });
            const transient = sessionEvent(session.id, createFutureEventId(), "agent_event", {
                event: { contentIndex: 0, delta: "live", partial: {}, type: "text_delta" },
                runId: "run-1",
            });
            await session.events.append(ctx, transient);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, session.id);
                expect(restored?.snapshot().lastEventId).toBe(transient.id);
                expect(restored?.events.since(transient.id)).toEqual([]);
                expect(restored?.events.since(otherSessionCursor)).toBeUndefined();

                await restored?.changePermissionMode(ctx, { permissionMode: "read_only" });
                const catchup = restored?.events.since(transient.id);
                expect(catchup?.map((event) => event.type)).toContain("permission_mode_changed");
                expect(catchup?.every((event) => event.id > transient.id)).toBe(true);
                expect(new Set(catchup?.map((event) => event.id)).size).toBe(catchup?.length);
                expect(restored?.events.since(transient.id)).toEqual(catchup);
                expect(restored?.events.since(otherSessionCursor)).toBeUndefined();
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists registration removal and clears session and project attachments", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.registerSecret(ctx, {
                description: "Disposable credentials",
                environment: { DISPOSABLE_TOKEN: "removed-value" },
                id: "disposable",
            });
            const session = await store.create(ctx, {
                cwd: "/tmp/removed-secret-project",
                secretIds: ["disposable"],
            });
            await store.attachSecret(ctx, session.id, "disposable", "project");
            await expect(store.unregisterSecret(ctx, "disposable")).resolves.toBe(true);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect(await restoredStore.listSecrets(ctx)).toEqual([]);
                expect((await restoredStore.get(ctx, session.id))?.snapshot()).toMatchObject({
                    projectSecretIds: [],
                    secretIds: [],
                    sessionSecretIds: [],
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps Docker execution settings across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, {
                cwd: "/host/project",
                docker: {
                    environment: { PROJECT_MODE: "test" },
                    image: "local/image:tag",
                    mounts: [{ source: "/host/project", target: "/workspace" }],
                    workingDirectory: "/workspace",
                },
            });
            expect((await store.fork(ctx, session.id))?.requestForSubagent().docker?.name).toBe(
                `rig-${session.id}`,
            );
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect(
                    (await restoredStore.get(ctx, session.id))?.requestForSubagent().docker,
                ).toEqual({
                    environment: { PROJECT_MODE: "test" },
                    image: "local/image:tag",
                    mounts: [{ source: "/host/project", target: "/workspace" }],
                    name: `rig-${session.id}`,
                    workingDirectory: "/workspace",
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("uses in-memory global events unless durable retention is explicitly enabled", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.create(ctx, { cwd: "/tmp/rig-persistent-session-test" });
            expect(store.globalEventQueue.durable).toBe(false);
            expect(await store.globalEventQueue.list(ctx)).toHaveLength(3);
            await store?.close(ctx);

            const enabledStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                durableGlobalEventQueue: true,
            });
            expect(await enabledStore.globalEventQueue.list(ctx)).toEqual([]);
            const queuedSession = await enabledStore.create(ctx, {
                cwd: "/tmp/rig-persistent-session-test-enabled",
            });
            await enabledStore.close(ctx);

            const disabledStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await disabledStore.create(ctx, { cwd: "/tmp/rig-persistent-session-test-disabled" });
            await disabledStore.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                durableGlobalEventQueue: true,
            });
            try {
                expect(await restoredStore.globalEventQueue.list(ctx)).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            event: expect.objectContaining({ sessionId: queuedSession.id }),
                        }),
                    ]),
                );
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists and trims global events independently from session history", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                durableGlobalEventQueue: true,
            });
            const firstSession = await store.create(ctx, {
                cwd: "/tmp/rig-persistent-session-test-a",
            });
            const secondSession = await store.create(ctx, {
                cwd: "/tmp/rig-persistent-session-test-b",
            });
            const initial = (await store.globalEventQueue.list(ctx)) ?? [];
            const sessionEntries = initial.filter(
                (entry): entry is typeof entry & { event: SessionEvent } =>
                    "sessionId" in entry.event,
            );
            expect(sessionEntries.map((entry) => entry.event.sessionId)).toEqual([
                firstSession.id,
                secondSession.id,
            ]);
            const firstCursor = sessionEntries[0]?.cursor;
            const secondCursor = sessionEntries[1]?.cursor;
            const staleCursor = initial[0]?.cursor;
            expect(firstCursor).toBeDefined();
            expect(secondCursor).toBeDefined();
            expect(staleCursor).toBeDefined();
            if (
                firstCursor === undefined ||
                secondCursor === undefined ||
                staleCursor === undefined
            ) {
                throw new Error("Expected two global event cursors.");
            }
            expect(await store.globalEventQueue.trim(ctx, firstCursor)).toEqual({
                trimmed: initial.filter((entry) => entry.cursor <= firstCursor).length,
                through: firstCursor,
            });
            expect(await store.globalEventQueue.trim(ctx, firstCursor)).toEqual({
                trimmed: 0,
                through: firstCursor,
            });
            expect(await store.globalEventQueue.list(ctx, { after: staleCursor })).toBeUndefined();
            expect(await store.globalEventQueue.list(ctx, { after: "missing.0" })).toBeUndefined();
            expect(firstSession.events.since(undefined)).toHaveLength(1);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                durableGlobalEventQueue: true,
            });
            try {
                expect(
                    await restoredStore.globalEventQueue.list(ctx, { after: staleCursor }),
                ).toBeUndefined();
                expect(await restoredStore.globalEventQueue.list(ctx)).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            cursor: secondCursor,
                            event: expect.objectContaining({ sessionId: secondSession.id }),
                        }),
                    ]),
                );
                const thirdSession = await restoredStore.create(ctx, {
                    cwd: "/tmp/rig-persistent-session-test-c",
                });
                const appended = await restoredStore.globalEventQueue.list(ctx, {
                    after: secondCursor,
                });
                expect(appended).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            event: expect.objectContaining({ sessionId: thirdSession.id }),
                        }),
                    ]),
                );
                expect(appended?.[0]?.cursor).not.toBe(secondCursor);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("rolls back a new project and session when its durable global event cannot commit", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
            durableGlobalEventQueue: true,
        });
        const breaker = openTestDatabase(databasePath);
        try {
            await breaker.execute(`
                CREATE TRIGGER reject_project_global_event
                BEFORE INSERT ON durable_global_events
                WHEN NEW.aggregate_kind = 'project'
                BEGIN
                    SELECT RAISE(ABORT, 'rejected project event');
                END;
            `);

            await expectErrorChainToContain(
                store.create(ctx, { cwd: "/tmp/rig-atomic-project-session" }),
                "rejected project event",
            );
            expect(await store.listProjects(ctx)).toEqual([]);
            expect(await store.list(ctx)).toEqual([]);
            expect(await store.globalEventQueue.list(ctx)).toEqual([]);
        } finally {
            await breaker.close();
            await store?.close(ctx);
            await cleanup();
        }
    });

    it("does not publish in-memory global events from a rolled-back transaction", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
        });
        const breaker = openTestDatabase(databasePath);
        try {
            await breaker.execute(`
                CREATE TRIGGER reject_session_insert
                BEFORE INSERT ON sessions
                BEGIN
                    SELECT RAISE(ABORT, 'rejected session insert');
                END;
            `);

            await expectErrorChainToContain(
                store.create(ctx, { cwd: "/tmp/rig-atomic-in-memory-project-session" }),
                "rejected session insert",
            );
            expect(await store.listProjects(ctx)).toEqual([]);
            expect(await store.list(ctx)).toEqual([]);
            expect(await store.globalEventQueue.list(ctx)).toEqual([]);
        } finally {
            await breaker.close();
            await store?.close(ctx);
            await cleanup();
        }
    });

    it("rolls back an appended event when its session snapshot cannot be saved", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
        });
        const session = await store.create(ctx, { cwd: "/tmp/rig-atomic-event-snapshot" });
        const breaker = openTestDatabase(databasePath);
        try {
            const before = (await queryTestRow<{ count: number }>(
                breaker,
                "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?",
                [session.id],
            ))!;
            await breaker.execute(`
                CREATE TRIGGER reject_session_snapshot
                BEFORE UPDATE ON sessions
                WHEN NEW.append_system_prompt = 'reject snapshot'
                BEGIN
                    SELECT RAISE(ABORT, 'rejected session snapshot');
                END;
            `);

            await expectErrorChainToContain(
                session.update(ctx, { appendSystemPrompt: "reject snapshot" }),
                "rejected session snapshot",
            );
            const after = (await queryTestRow<{ count: number }>(
                breaker,
                "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?",
                [session.id],
            ))!;
            const row = (await queryTestRow<{ append_system_prompt: string | null }>(
                breaker,
                "SELECT append_system_prompt FROM sessions WHERE id = ?",
                [session.id],
            ))!;
            expect(after.count).toBe(before.count);
            expect(row.append_system_prompt).toBeNull();
        } finally {
            await breaker.close();
            await store?.close(ctx);
            await cleanup();
        }
    });

    it("restores persisted session state and messages without creating a runtime", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({
                status: "completed",
            });
            const userMessage: UserMessage = {
                ...textUserMessage("message-1", "persist me"),
                agentSource: {
                    agentId: "sender-agent-id",
                    sessionId: "sender-session-id",
                    title: "Source chat",
                },
                provenance: "agent",
            };
            const toolCallMessage: AgentMessage = {
                role: "agent",
                id: "message-2",
                blocks: [
                    {
                        type: "tool_call",
                        id: "call-1",
                        name: "read",
                        arguments: { path: "src/index.ts" },
                        presentation: {
                            type: "exploration",
                            operations: [{ kind: "read", name: "index.ts" }],
                        },
                    },
                ],
            };
            await store.saveSession(ctx, state);
            await store.upsertMessage(ctx, state.id, {
                isPartial: false,
                message: userMessage,
                position: 0,
                runId: "run-1",
            });
            await store.upsertMessage(ctx, state.id, {
                isPartial: false,
                message: toolCallMessage,
                position: 1,
                runId: "run-1",
            });
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, state.id);

                expect(restored?.snapshot().status).toBe("completed");
                expect(restored?.snapshot().snapshot.messages).toEqual([
                    userMessage,
                    toolCallMessage,
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("does not parse persisted event payloads while opening the database", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-startup-event-scan-test" });
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            await database.execute({
                args: [session.id, "unreadable-event", "run_started", 1, "{"],
                sql: `
                    INSERT INTO session_events (
                        session_id, event_id, type, created_at_ms, data_json
                    ) VALUES (?, ?, ?, ?, ?)
                    `,
            });
            await database.close();

            const reopened = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await reopened.list(ctx)).map((entry) => entry.id)).toContain(session.id);
            } finally {
                await reopened.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("reconciles a durable terminal event without appending a startup error", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const state = sessionState({
                activeRunId: "completed-before-crash",
                status: "running",
            });
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(ctx, state);
            await store?.close(ctx);
            const database = openTestDatabase(databasePath);
            await insertEvent(database, state.id, "durable-finish", "run_finished", 10, {
                agentRunId: "agent-run",
                modelLocked: false,
                runId: "completed-before-crash",
                stopReason: "stop",
            });
            await database.close();

            const reopened = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await reopened.close(ctx);

            const verify = openTestDatabase(databasePath);
            try {
                expect(
                    await queryTestRow(
                        verify,
                        "SELECT status, active_run_id FROM sessions WHERE id = ?",
                        [state.id],
                    ),
                ).toEqual({ active_run_id: null, status: "completed" });
                expect(
                    await queryTestRow(
                        verify,
                        "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'run_error'",
                        [state.id],
                    ),
                ).toEqual({ count: 0 });
            } finally {
                await verify.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("does not promote active steering after restart interruption, including on reopen", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const active = textUserMessage("active-orphan", "still active at restart");
            const state = sessionState({
                activeRunId: "active-run",
                modelId: "openai/test",
                models: testModelCatalog().models,
                providerId: "codex",
                status: "running",
            });
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: testModelCatalog(),
            });
            await store.saveSession(ctx, state);
            await store?.close(ctx);
            const database = openTestDatabase(databasePath);
            await insertEvent(database, state.id, "active-start", "run_started", 1, {
                runId: "active-run",
            });
            await insertEvent(database, state.id, "active-submit", "message_submitted", 2, {
                delivery: "steer",
                displayText: "still active at restart",
                message: active,
                runId: "active-run",
            });
            await database.close();

            for (let open = 0; open < 2; open += 1) {
                const restored = await PersistentSessionStore.open(ctx, {
                    databasePath,
                    modelCatalog: testModelCatalog(),
                    now: () => 100 + open,
                });
                await restored.close(ctx);
                const verify = openTestDatabase(databasePath);
                try {
                    expect(
                        await queryTestRow(
                            verify,
                            "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND message_id = ?",
                            [state.id, active.id],
                        ),
                    ).toEqual({ count: 0 });
                    expect(
                        await queryTestRow(
                            verify,
                            "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'steering_applied'",
                            [state.id],
                        ),
                    ).toEqual({ count: 0 });
                    const restartErrors = await queryTestRows<{ data_json: string }>(
                        verify,
                        "SELECT data_json FROM session_events WHERE session_id = ? AND type = 'run_error'",
                        [state.id],
                    );
                    expect(restartErrors.map((row) => JSON.parse(row.data_json))).toEqual([
                        expect.objectContaining({
                            runId: "active-run",
                            startupInterruption: true,
                        }),
                    ]);
                } finally {
                    await verify.close();
                }
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps restart-interrupted steering excluded after a later run clears interruption state", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const active = textUserMessage("restart-orphan", "never reached inference");
            const later = textUserMessage("later-run-message", "completed after restart");
            const state = sessionState({
                activeRunId: "crashed-run",
                modelId: "openai/test",
                models: testModelCatalog().models,
                providerId: "codex",
                status: "running",
            });
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: testModelCatalog(),
            });
            await store.saveSession(ctx, state);
            await store?.close(ctx);
            const database = openTestDatabase(databasePath);
            await insertEvent(database, state.id, "crashed-start", "run_started", 1, {
                runId: "crashed-run",
            });
            await insertEvent(database, state.id, "crashed-steer", "message_submitted", 2, {
                delivery: "steer",
                displayText: "never reached inference",
                message: active,
                runId: "crashed-run",
            });
            await database.close();

            const firstReopen = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: testModelCatalog(),
                now: () => 100,
            });
            await firstReopen.close(ctx);

            const laterDatabase = openTestDatabase(databasePath);
            await insertEvent(laterDatabase, state.id, "later-start", "run_started", 4, {
                runId: "later-run",
            });
            await insertEvent(laterDatabase, state.id, "later-submit", "message_submitted", 5, {
                delivery: "run",
                displayText: "completed after restart",
                message: later,
                runId: "later-run",
            });
            await insertEvent(laterDatabase, state.id, "later-finished", "run_finished", 6, {
                agentRunId: "later-agent-run",
                modelLocked: true,
                runId: "later-run",
                stopReason: "stop",
            });
            await laterDatabase.execute({
                args: [state.id],
                sql: "UPDATE sessions SET status = 'completed', active_run_id = NULL, interrupted = 0, interruption_json = NULL WHERE id = ?",
            });
            await laterDatabase.close();

            const secondReopen = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: testModelCatalog(),
                now: () => 200,
            });
            await secondReopen.close(ctx);

            const verify = openTestDatabase(databasePath);
            try {
                expect(
                    await queryTestRow(
                        verify,
                        "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND message_id = ?",
                        [state.id, active.id],
                    ),
                ).toEqual({ count: 0 });
                expect(
                    await queryTestRow(
                        verify,
                        "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'steering_applied'",
                        [state.id],
                    ),
                ).toEqual({ count: 0 });
                const crashError = (await queryTestRow<{ data_json: string }>(
                    verify,
                    "SELECT data_json FROM session_events WHERE session_id = ? AND type = 'run_error'",
                    [state.id],
                ))!;
                expect(JSON.parse(crashError.data_json)).toEqual(
                    expect.objectContaining({
                        runId: "crashed-run",
                        startupInterruption: true,
                    }),
                );
            } finally {
                await verify.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("does not promote suspended subagent steering on the second restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const active = textUserMessage("suspended-orphan", "not applied before suspension");
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: testModelCatalog(),
            });
            await store.saveSession(ctx, sessionState());
            const state = sessionState({
                activeRunId: "suspended-run",
                agent: {
                    depth: 1,
                    description: "Wait for more work",
                    parentSessionId: "session-1",
                    rootSessionId: "session-1",
                    type: "subagent",
                },
                agentId: "subagent-agent",
                id: "subagent-1",
                status: "suspended",
            });
            await store.saveSession(ctx, state);
            await store?.close(ctx);
            const database = openTestDatabase(databasePath);
            await insertEvent(database, state.id, "suspended-start", "run_started", 1, {
                runId: "suspended-run",
            });
            await insertEvent(database, state.id, "suspended-submit", "message_submitted", 2, {
                delivery: "steer",
                displayText: "not applied before suspension",
                message: active,
                runId: "suspended-run",
            });
            await database.close();

            let restartNotification: string | undefined;
            for (let open = 0; open < 2; open += 1) {
                const restored = await PersistentSessionStore.open(ctx, {
                    databasePath,
                    modelCatalog: testModelCatalog(),
                });
                restartNotification ??= (await restored.get(ctx, "session-1"))
                    ?.snapshot()
                    .snapshot.messages.flatMap((message) =>
                        message.blocks.flatMap((block) =>
                            block.type === "text" ? [block.text] : [],
                        ),
                    )
                    .find((text) => text.includes("<subagent-notification>"));
                await restored.close(ctx);
            }
            expect(restartNotification).toContain("Agent ID: subagent-agent");
            expect(restartNotification).toContain("Path: /root/subagent-agent");
            expect(restartNotification).not.toContain("Task:");
            expect(restartNotification).not.toContain("subagent-1");

            const verify = openTestDatabase(databasePath);
            try {
                expect(
                    await queryTestRow(
                        verify,
                        "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND message_id = ?",
                        [state.id, active.id],
                    ),
                ).toEqual({ count: 0 });
                expect(
                    await queryTestRow(
                        verify,
                        "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'steering_applied'",
                        [state.id],
                    ),
                ).toEqual({ count: 0 });
                const restartError = (await queryTestRow<{ data_json: string }>(
                    verify,
                    "SELECT data_json FROM session_events WHERE session_id = ? AND type = 'run_error'",
                    [state.id],
                ))!;
                expect(JSON.parse(restartError.data_json)).toEqual(
                    expect.objectContaining({
                        runId: "suspended-run",
                        startupInterruption: true,
                    }),
                );
            } finally {
                await verify.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps workflows disabled across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const sessionId = (
                await store.create(ctx, {
                    cwd: "/tmp/rig-persistent-session-test",
                    workflowsEnabled: false,
                })
            ).id;
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, sessionId);
                expect(restored?.snapshot().workflowsEnabled).toBe(false);
                expect(() =>
                    restored?.launchWorkflow(ctx, {
                        code: "42",
                        description: "Must stay disabled",
                        execute: async () => ({ agentCalls: [], output: 42 }),
                        name: "disabled-workflow",
                    }),
                ).toThrow("Workflows are disabled for this session.");
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a Monty checkpoint and completed workflow calls across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({
                workflows: [
                    {
                        agentCalls: [{ output: "cached", signature: "cached-signature" }],
                        checkpoint: {
                            nextAgentCallIndex: 1,
                            phase: "Verify",
                            snapshotBase64: Buffer.from([1, 2, 3]).toString("base64"),
                        },
                        state: {
                            agentCount: 1,
                            code: 'agent("check")',
                            description: "Persist checkpoint",
                            logs: [],
                            name: "persist-checkpoint",
                            runId: "workflow-before-restart",
                            startedAt: 1,
                            status: "running",
                            taskId: "workflow:workflow-before-restart",
                        },
                    },
                ],
            });
            await store.saveSession(ctx, state);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, state.id);
                expect(restored?.getWorkflow("workflow-before-restart")).toMatchObject({
                    error: "The workflow was interrupted when the local server stopped.",
                    status: "stopped",
                });
                let receivedCheckpoint: unknown;
                let receivedAgentCalls: readonly unknown[] = [];
                restored?.launchWorkflow(ctx, {
                    code: 'agent("check")',
                    description: "Resume checkpoint",
                    execute: async (options) => {
                        receivedCheckpoint = options.resumeCheckpoint;
                        receivedAgentCalls = options.resumeAgentCalls;
                        return { agentCalls: options.resumeAgentCalls, output: "resumed" };
                    },
                    name: "persist-checkpoint",
                    resumeFromRunId: "workflow-before-restart",
                });
                await new Promise((resolve) => setImmediate(resolve));

                expect(receivedCheckpoint).toMatchObject({
                    nextAgentCallIndex: 1,
                    phase: "Verify",
                    snapshot: new Uint8Array([1, 2, 3]),
                });
                expect(receivedAgentCalls).toEqual([
                    { output: "cached", signature: "cached-signature" },
                ]);
                const notificationRun = restored?.events
                    .since(undefined)
                    ?.findLast((event) => event.type === "run_started");
                if (notificationRun?.type !== "run_started") {
                    throw new Error("Expected the completed workflow notification to start a run.");
                }
                await restored?.abort(ctx);
                await restored?.waitForRun(ctx, notificationRun.data.runId);
                await new Promise((resolve) => setImmediate(resolve));
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a rewound transcript across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const messages = [
                textUserMessage("message-1", "Keep this"),
                textUserMessage("message-2", "Rewind this"),
                textUserMessage("message-3", "Remove this too"),
            ];
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ contextMessages: messages, status: "completed" });
            await store.saveSession(ctx, state);
            await Promise.all(
                messages.map(async (message, position) => {
                    await store.upsertMessage(ctx, state.id, {
                        isPartial: false,
                        message,
                        position,
                        runId: `run-${position + 1}`,
                    });
                }),
            );
            await store?.close(ctx);

            const rewindStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await (await rewindStore.get(ctx, state.id))?.rewind(ctx, "message-2");
            await rewindStore.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = (await restoredStore.get(ctx, state.id))?.snapshot().snapshot;
                expect(restored?.messages).toEqual([messages[0]]);
                expect(restored?.contextMessages).toBeUndefined();
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("resumes from compacted model context instead of the visible transcript", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const summaryMessage: CompactionMessage = {
            blocks: [],
            id: "summary-1",
            providerId: "claude",
            replacementMessages: [{ role: "user", content: "Earlier work.", timestamp: 1 }],
            replacedMessageIds: ["visible-1"],
            role: "compaction",
            statistics: {
                after: { exact: false, tokens: 20 },
                before: { exact: true, tokens: 100 },
            },
        };
        const visibleMessage = textUserMessage("visible-1", "The original full transcript.");
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ contextMessages: [summaryMessage] });
            await store.saveSession(ctx, state);
            await store.upsertMessage(ctx, state.id, {
                isPartial: false,
                message: visibleMessage,
                position: 0,
                runId: "run-1",
            });
            await store.upsertMessage(ctx, state.id, {
                isPartial: false,
                message: summaryMessage,
                position: 1,
                runId: "run-1",
            });
            await store?.close(ctx);

            let restoredRuntimeOptions:
                | {
                      contextMessages: readonly unknown[] | undefined;
                      messages: readonly unknown[] | undefined;
                  }
                | undefined;
            const restoredStore = await PersistentSessionStore.open(ctx, {
                createRuntime: (options) => {
                    restoredRuntimeOptions = {
                        contextMessages: structuredClone(options.contextMessages),
                        messages: structuredClone(options.messages),
                    };
                    throw new Error("Captured resumed runtime options.");
                },
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, state.id);

                expect(restored?.snapshot().snapshot.messages).toEqual([
                    visibleMessage,
                    summaryMessage,
                ]);
                expect(restored?.snapshot().snapshot.contextMessages).toEqual([summaryMessage]);
                await expect(restored?.compact(ctx)).rejects.toThrow(
                    "Captured resumed runtime options.",
                );
                expect(restoredRuntimeOptions).toMatchObject({
                    contextMessages: [summaryMessage],
                    messages: [summaryMessage],
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("stores the complete active inference context in its own ordered table", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const first = textUserMessage("context-1", "First inference message.");
        const second = textUserMessage("context-2", "Second inference message.");
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ contextMessages: [first, second] });
            await store.saveSession(ctx, state);
            await store.saveSession(ctx, { ...state, contextMessages: [second] });
            await store?.close(ctx);

            const database = openTestDatabase(databasePath);
            try {
                expect(
                    (
                        await queryTestRows<{ name: string }>(
                            database,
                            "PRAGMA table_info(sessions)",
                        )
                    ).map((column) => String(column.name)),
                ).not.toContain("context_messages_json");
                expect(
                    await queryTestRows(
                        database,
                        `
                            SELECT position, message_id, role, message_json
                            FROM session_context_messages
                            WHERE session_id = ?
                            ORDER BY position
                            `,
                        [state.id],
                    ),
                ).toEqual([
                    {
                        message_id: second.id,
                        message_json: JSON.stringify(second),
                        position: 0,
                        role: "user",
                    },
                ]);
            } finally {
                await database.close();
            }

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.get(ctx, state.id))?.state().contextMessages).toEqual([
                    second,
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists internal context messages without exposing them in the session snapshot", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const internalContinuation: UserMessage = {
            blocks: [{ text: "Continue after the inference crash.", type: "text" }],
            id: "internal-crash-continuation",
            internal: true,
            role: "user",
        };
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ contextMessages: [internalContinuation] });
            await store.saveSession(ctx, state);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, state.id);

                expect(restored?.state().contextMessages).toEqual([internalContinuation]);
                expect(restored?.snapshot().snapshot.messages).toEqual([]);
                expect(restored?.snapshot().snapshot.contextMessages).toEqual([]);
                expect(JSON.stringify(restored?.events.since(undefined))).not.toContain(
                    "Continue after the inference crash.",
                );
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a partial provider failure without replaying it", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/sonnet-5",
            name: "Claude Test",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "claude",
            models: [model],
            providers: [{ models: [model], providerId: "claude" }],
        };
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        const originalOverrides = process.env.RIG_GYM_PROVIDER_OVERRIDES;
        const requests: GymInferenceRequest[] = [];
        let store: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            process.env.RIG_GYM_PROVIDER_OVERRIDES = "claude";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                if (requests.length === 1) {
                    return new Response(
                        JSON.stringify({
                            content: [{ text: "DURABLE_PARTIAL_UNSENT", type: "text" }],
                            errorAfterTextDeltas: 1,
                            errorMessage: "WebSocket error",
                            stopReason: "error",
                            textDeltaChunkSize: 15,
                        }),
                        { headers: { "content-type": "application/json" }, status: 200 },
                    );
                }
                return new Response(
                    JSON.stringify({ content: [{ text: "Recovered session", type: "text" }] }),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            const session = await store.create(ctx, {
                cwd: "/tmp/rig-internal-crash-continuation",
                modelId: model.id,
                permissionMode: "full_access",
                providerId: "claude",
            });
            const submitted = await session.submit(ctx, { text: "Recover this response." });
            await expect(session.waitForRun(ctx, submitted.runId)).resolves.toEqual({
                errorMessage: "WebSocket error",
                status: "error",
            });

            expect(requests).toHaveLength(1);
            expect(
                session.state().contextMessages?.findLast((message) => message.role === "agent"),
            ).toMatchObject({
                role: "agent",
                blocks: [{ type: "text", text: "DURABLE_PARTIAL" }],
            });
            expect(session.state().contextMessages?.at(-1)).toMatchObject({
                blocks: [{ type: "text", text: "WebSocket error" }],
                outcome: "failed",
                role: "error",
            });
            expect(JSON.stringify(session.snapshot().snapshot)).not.toContain(
                "Continue after the inference crash.",
            );

            await store?.close(ctx);
            store = undefined;

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            try {
                const restored = await restoredStore.get(ctx, session.id);
                expect(restored).toBeDefined();
                await expect(restored?.waitForRun(ctx, submitted.runId)).resolves.toEqual({
                    errorMessage: "WebSocket error",
                    status: "error",
                });
                expect(restored?.state().contextMessages?.at(-1)).toMatchObject({
                    blocks: [{ type: "text", text: "WebSocket error" }],
                    outcome: "failed",
                    role: "error",
                });
                expect(
                    restored
                        ?.state()
                        .contextMessages?.findLast((message) => message.role === "agent"),
                ).toMatchObject({
                    blocks: [{ type: "text", text: "DURABLE_PARTIAL" }],
                    role: "agent",
                });
                expect(restored?.state().contextMessages).not.toContainEqual(
                    expect.objectContaining({ internal: true }),
                );
                expect(JSON.stringify(restored?.snapshot().snapshot)).not.toContain(
                    "Continue after the inference crash.",
                );
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await store?.close(ctx);
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            if (originalOverrides === undefined) delete process.env.RIG_GYM_PROVIDER_OVERRIDES;
            else process.env.RIG_GYM_PROVIDER_OVERRIDES = originalOverrides;
            await cleanup();
        }
    });

    it("persists the permission mode in session details and summaries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ permissionMode: "read_only" });
            await store.saveSession(ctx, state);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.get(ctx, state.id))?.snapshot().permissionMode).toBe(
                    "read_only",
                );
                expect((await restoredStore.list(ctx)).at(0)?.permissionMode).toBe("read_only");
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("reports the stored context size in session summaries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({
                sessionTokenCount: { lastContextTokens: 34_500, totalTokens: 120_000 },
            });
            await store.saveSession(ctx, state);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.list(ctx)).at(0)?.sessionTokenCount).toEqual({
                    lastContextTokens: 34_500,
                    totalTokens: 120_000,
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists the selected service tier in session details and summaries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ serviceTier: "fast" });
            await store.saveSession(ctx, state);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.get(ctx, state.id))?.snapshot()).toMatchObject({
                    serviceTier: "fast",
                    snapshot: { serviceTier: "fast" },
                });
                expect((await restoredStore.list(ctx)).at(0)?.serviceTier).toBe("fast");
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("restores fast inference into the runtime and persists disabling it", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ providerId: "gym", models: [model], serviceTiers: ["fast"] }],
        };
        const inferenceRequests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let openStore: PersistentSessionStore | undefined;
        try {
            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") {
                    throw new Error("Expected a serialized gym inference request.");
                }
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                inferenceRequests.push(request);
                return new Response(
                    JSON.stringify({
                        content: [{ text: "Done.", type: "text" }],
                        stopReason: "stop",
                    }),
                    { headers: { "content-type": "application/json" }, status: 200 },
                );
            };

            openStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            const created = await openStore.create(ctx, {
                cwd: "/tmp/rig-fast-persistence-test",
                modelId: model.id,
                providerId: "gym",
                serviceTier: "fast",
            });
            await openStore.saveSession(ctx, {
                ...created.state(),
                title: "Fast persistence",
                titleStatus: "ready",
            });
            const sessionId = created.id;
            await openStore?.close(ctx);
            openStore = undefined;

            openStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            const fastSession = await openStore.get(ctx, sessionId);
            expect(fastSession?.snapshot()).toMatchObject({
                serviceTier: "fast",
                snapshot: { serviceTier: "fast" },
            });
            const fastRun =
                fastSession === undefined
                    ? undefined
                    : await fastSession.submit(ctx, { text: "Use fast inference." });
            expect(fastRun).toBeDefined();
            if (fastRun === undefined || fastSession === undefined) {
                throw new Error("Expected the restored fast session.");
            }
            await expect(fastSession.waitForRun(ctx, fastRun.runId)).resolves.toEqual({
                status: "completed",
            });
            await new Promise((resolve) => setImmediate(resolve));
            expect(inferenceRequests).toHaveLength(1);
            expect(inferenceRequests[0]?.options.serviceTier).toBe("fast");

            await fastSession.changeServiceTier(ctx, {});
            expect(fastSession.snapshot().serviceTier).toBeUndefined();
            await openStore?.close(ctx);
            openStore = undefined;

            const disabledDatabase = openTestDatabase(databasePath);
            try {
                expect(
                    await queryTestRow(
                        disabledDatabase,
                        "SELECT service_tier FROM sessions WHERE id = ?",
                        [sessionId],
                    ),
                ).toEqual({ service_tier: null });
            } finally {
                await disabledDatabase.close();
            }

            openStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            const normalSession = await openStore.get(ctx, sessionId);
            expect(normalSession?.snapshot().serviceTier).toBeUndefined();
            const normalRun =
                normalSession === undefined
                    ? undefined
                    : await normalSession.submit(ctx, { text: "Use normal inference." });
            expect(normalRun).toBeDefined();
            if (normalRun === undefined || normalSession === undefined) {
                throw new Error("Expected the restored normal session.");
            }
            await expect(normalSession.waitForRun(ctx, normalRun.runId)).resolves.toEqual({
                status: "completed",
            });
            await new Promise((resolve) => setImmediate(resolve));
            expect(inferenceRequests).toHaveLength(2);
            expect(inferenceRequests[1]?.options.serviceTier).toBeUndefined();
        } finally {
            await openStore?.close(ctx);
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) {
                delete process.env.RIG_GYM_INFERENCE_URL;
            } else {
                process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            }
            await cleanup();
        }
    });

    it("persists goal state across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({
                goal: {
                    createdAt: 1_700_000_000_000,
                    objective: "Finish the release",
                    status: "paused",
                    updatedAt: 1_700_000_001_000,
                },
            });
            await store.saveSession(ctx, state);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.get(ctx, state.id))?.snapshot().goal).toEqual(
                    state.goal,
                );
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists lifecycle and unread session behavior across daemon restarts", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({
                archived: true,
                trackUnread: true,
                unread: { reason: "turn_finished", since: 1_700_000_000_000 },
            });
            await store.saveSession(ctx, state);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.get(ctx, state.id))?.snapshot()).toMatchObject({
                    archived: true,
                    trackUnread: true,
                    unread: state.unread,
                });
                expect(await restoredStore.list(ctx)).toMatchObject([
                    {
                        archived: true,
                        id: state.id,
                        trackUnread: true,
                        unread: state.unread,
                    },
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists completed structured question events without reviving the prompt", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-persistent-session-test" });
            const pending = session.requestUserInput(ctx, {
                requestId: "question-1",
                questions: [
                    {
                        header: "Database",
                        id: "database",
                        multiSelect: false,
                        options: [
                            { label: "PostgreSQL", description: "Use a server database." },
                            { label: "SQLite", description: "Use a local database." },
                        ],
                        question: "Which database should be used?",
                    },
                ],
            });
            await vi.waitFor(() =>
                expect(session.snapshot().pendingUserInputs).toEqual([
                    expect.objectContaining({ requestId: "question-1" }),
                ]),
            );
            await session.answerUserInput(ctx, "question-1", { answers: { database: ["SQLite"] } });
            await pending;
            const sessionId = session.id;
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, sessionId);
                expect(restored?.snapshot().pendingUserInputs).toEqual([]);
                expect(restored?.events.since(undefined)?.map((event) => event.type)).toEqual([
                    "session_created",
                    "user_input_requested",
                    "user_input_resolved",
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists task state and does not reuse deleted task identifiers", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await store.create(ctx, { cwd: "/tmp/rig-persistent-session-test" });
            session.createTask(ctx, { subject: "First", description: "Do the first task." });
            session.createTask(ctx, { subject: "Second", description: "Do the second task." });
            session.updateTask(ctx, "2", { status: "deleted" });
            const sessionId = session.id;
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, sessionId);
                expect(restored?.listTasks()).toEqual([
                    expect.objectContaining({ id: "1", subject: "First" }),
                ]);
                expect(
                    restored?.createTask(ctx, {
                        subject: "Third",
                        description: "Do the third task.",
                    }).id,
                ).toBe("3");
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a fallback when a restored model is no longer available", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const availableModel = defineModel({
            id: "openai/available",
            name: "Available model",
            thinkingLevels: ["off", "medium"],
            defaultThinkingLevel: "medium",
        });
        const removedModel = defineModel({
            id: "removed/model",
            name: "Removed model",
            thinkingLevels: ["off", "high", "max"],
            defaultThinkingLevel: "max",
        });
        const availableCatalog: ModelCatalog = {
            defaultModelId: availableModel.id,
            defaultProviderId: "codex",
            models: [availableModel],
            providers: [{ providerId: "codex", models: [availableModel] }],
        };
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: {
                    defaultModelId: availableModel.id,
                    defaultProviderId: "codex",
                    models: [availableModel, removedModel],
                    providers: [
                        { providerId: "codex", models: [availableModel] },
                        { providerId: "bedrock", models: [removedModel] },
                    ],
                },
            });
            const sessionId = (
                await store.create(ctx, {
                    cwd: "/tmp/rig-persistent-session-test",
                    effort: "max",
                    modelId: removedModel.id,
                    providerId: "bedrock",
                })
            ).id;
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: availableCatalog,
            });
            try {
                expect((await restoredStore.get(ctx, sessionId))?.snapshot()).toMatchObject({
                    effort: "medium",
                    modelId: availableModel.id,
                    providerId: "codex",
                });
                expect(
                    (await restoredStore.list(ctx)).find((session) => session.id === sessionId),
                ).toMatchObject({
                    effort: "medium",
                    modelId: availableModel.id,
                    providerId: "codex",
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("marks running sessions as interrupted after a restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                now: () => 1_700_000_000_000,
            });
            const queuedRun: PersistedQueuedRun = {
                displayText: "queued prompt",
                kind: "user",
                runId: "run-2",
                text: "queued prompt",
                userMessage: textUserMessage("message-2", "queued prompt"),
            };
            await store.saveSession(
                ctx,
                sessionState({
                    activeRunId: "run-1",
                    queuedRuns: [queuedRun],
                    status: "running",
                }),
            );
            await store.insertQueuedRun(ctx, "session-1", queuedRun);
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                now: () => 1_700_000_000_100,
            });
            try {
                const restored = await restoredStore.get(ctx, "session-1");
                const events = restored?.events.since(undefined) ?? [];

                expect(restored?.snapshot().status).toBe("error");
                expect(restored?.snapshot().interruption).toMatchObject({
                    reason: "crash",
                    runId: "run-1",
                });
                expect(events.filter((event) => event.type === "run_error")).toHaveLength(2);
                // The interrupted run moves the session to the error status, and
                // that transition is announced so an attached client learns the
                // crash without re-reading the session.
                expect(events.map((event) => event.type)).toEqual([
                    "run_error",
                    "session_status_changed",
                    "run_error",
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("publishes a repaired child status to its parent after a restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(ctx, sessionState());
            await store.saveSession(
                ctx,
                sessionState({
                    activeRunId: "child-run-1",
                    agent: {
                        depth: 1,
                        description: "Inspect the crash path",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    status: "running",
                }),
            );
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const parent = await restoredStore.get(ctx, "session-1");
                await vi.waitFor(() => {
                    const changed = parent?.events
                        .since(undefined)
                        ?.find((event) => event.type === "subagent_changed");
                    expect(changed).toMatchObject({
                        data: {
                            subagent: {
                                id: "subagent-1",
                                status: "error",
                            },
                        },
                        type: "subagent_changed",
                    });
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("restores a parent metadata boundary with a persisted child without recursion", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(ctx, sessionState());
            await store.saveSession(
                ctx,
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect the resume boundary",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    status: "completed",
                }),
            );
            await (
                await store.get(ctx, "session-1")
            )?.markInterrupted(ctx, {
                interruptedAt: 1_700_000_000_000,
                message: "The parent was interrupted before restart.",
                reason: "shutdown",
                runId: "parent-run-1",
            });
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.get(ctx, "session-1"))?.snapshot()).toMatchObject({
                    id: "session-1",
                    interruption: { runId: "parent-run-1" },
                });
                expect((await restoredStore.get(ctx, "subagent-1"))?.agentMetadata()).toMatchObject(
                    {
                        parentSessionId: "session-1",
                    },
                );
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it.skip("reuses a stopped subagent session for model-directed follow-up after restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gym",
            name: "Gym",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "gym",
            models: [model],
            providers: [{ models: [model], providerId: "gym" }],
        };
        const requests: GymInferenceRequest[] = [];
        const originalFetch = globalThis.fetch;
        const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
        let restoredStore: PersistentSessionStore | undefined;
        try {
            const oldTask = textUserMessage("old-task", "Remember the original delegated context.");
            const oldResponse = {
                blocks: [{ text: "Original work stopped.", type: "text" }],
                id: "old-response",
                role: "agent",
            } as const;
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            await store.saveSession(
                ctx,
                sessionState({
                    modelId: model.id,
                    models: [model],
                    providerId: "gym",
                    title: "Parent",
                    titleStatus: "ready",
                }),
            );
            await store.saveSession(
                ctx,
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect persisted work",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        taskName: "persisted_worker",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    contextMessages: [oldTask, oldResponse],
                    modelId: model.id,
                    models: [model],
                    providerId: "gym",
                    status: "aborted",
                    title: "Persisted worker",
                    titleStatus: "ready",
                }),
            );
            await store.upsertMessage(ctx, "subagent-1", {
                isPartial: false,
                message: oldTask,
                position: 0,
                runId: "old-run",
            });
            await store.upsertMessage(ctx, "subagent-1", {
                isPartial: false,
                message: oldResponse,
                position: 1,
                runId: "old-run",
            });
            await store?.close(ctx);

            process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
            globalThis.fetch = async (_input, init) => {
                if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
                const request = JSON.parse(init.body) as GymInferenceRequest;
                const metadataResponse = sessionMetadataResponse(request);
                if (metadataResponse !== undefined) return metadataResponse;
                requests.push(request);
                const userTexts = request.context.messages.flatMap((message) =>
                    message.role === "user" ? [providerMessageText(message.content)] : [],
                );
                const lastMessage = request.context.messages.at(-1);
                const lastUserText = userTexts.at(-1) ?? "";
                const response = lastUserText.includes("<subagent-notification>")
                    ? { content: [{ text: "PERSISTED_CHILD_REPORTED", type: "text" }] }
                    : userTexts.includes("Continue the persisted investigation.")
                      ? { content: [{ text: "PERSISTED_CHILD_REUSED", type: "text" }] }
                      : lastMessage?.role === "toolResult" &&
                          lastMessage.toolName === "followup_task"
                        ? { content: [{ text: "FOLLOWUP_ACCEPTED", type: "text" }] }
                        : {
                              content: [
                                  {
                                      arguments: {
                                          message: "Continue the persisted investigation.",
                                          target: "/root/persisted_worker",
                                      },
                                      id: "follow-up-persisted-worker",
                                      name: "followup_task",
                                      namespace: "collaboration",
                                      type: "toolCall",
                                  },
                              ],
                          };
                return new Response(JSON.stringify(response), {
                    headers: { "content-type": "application/json" },
                    status: 200,
                });
            };

            const taskDrain = new TrackedTaskDrain();
            restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
                taskDrain,
            });
            const parent = await restoredStore.get(ctx, "session-1");
            if (parent === undefined) throw new Error("Expected the restored parent session.");
            const submitted = await parent.submit(ctx, { text: "Ask the old worker to continue." });
            await expect(parent.waitForRun(ctx, submitted.runId)).resolves.toEqual({
                status: "completed",
            });

            const child = await restoredStore.get(ctx, "subagent-1");
            if (child === undefined) throw new Error("Expected the restored child session.");
            let followUpEvent: Extract<SessionEvent, { type: "message_submitted" }> | undefined;
            await vi.waitFor(() => {
                followUpEvent = child.events
                    .since(undefined)
                    ?.find(
                        (event): event is Extract<SessionEvent, { type: "message_submitted" }> =>
                            event.type === "message_submitted" &&
                            event.data.displayText === "Continue the persisted investigation.",
                    );
                expect(followUpEvent).toBeDefined();
            });
            const followUpRunId = followUpEvent?.data.runId;
            if (followUpRunId === undefined) throw new Error("Expected the child follow-up run.");
            await expect(child.waitForRun(ctx, followUpRunId)).resolves.toEqual({
                status: "completed",
            });
            expect(
                requests.some((request) => {
                    const texts = request.context.messages.flatMap((message) =>
                        message.role === "user" ? [providerMessageText(message.content)] : [],
                    );
                    return (
                        texts.includes("Remember the original delegated context.") &&
                        texts.includes("Continue the persisted investigation.")
                    );
                }),
            ).toBe(true);
            await vi.waitFor(() =>
                expect(
                    parent.events
                        .since(undefined)
                        ?.filter((event) => event.type === "run_finished"),
                ).toHaveLength(2),
            );
            await restoredStore.prepareForShutdown(ctx, "shutdown");
            await restoredStore?.close(ctx);
            restoredStore = undefined;
        } finally {
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
            await restoredStore?.close(ctx);
            await cleanup();
        }
    });

    it("updates partial messages in place while streaming", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ status: "running" });
            await store.saveSession(ctx, state);
            await store.upsertMessage(ctx, state.id, {
                isPartial: true,
                message: {
                    blocks: [{ text: "hel", type: "text" }],
                    id: "assistant-1",
                    role: "agent",
                },
                position: 0,
                runId: "run-1",
            });
            await store.upsertMessage(ctx, state.id, {
                isPartial: true,
                message: {
                    blocks: [{ text: "hello", type: "text" }],
                    id: "assistant-1",
                    role: "agent",
                },
                position: 0,
                runId: "run-1",
            });
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, state.id);

                expect(restored?.state().messages).toEqual([
                    {
                        isPartial: true,
                        message: {
                            blocks: [{ text: "hello", type: "text" }],
                            id: "assistant-1",
                            role: "agent",
                        },
                        position: 0,
                        runId: "run-1",
                    },
                ]);
                expect(restored?.snapshot().snapshot.messages).toEqual([]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("keeps older transcript paging reachable when a partial message is restored", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const state = sessionState({ status: "running" });
            await store.saveSession(ctx, state);
            for (let position = 0; position < 81; position += 1) {
                await store.upsertMessage(ctx, state.id, {
                    isPartial: false,
                    message: textUserMessage(`message-${String(position)}`, String(position)),
                    position,
                    runId: `run-${String(position)}`,
                });
            }
            await store.upsertMessage(ctx, state.id, {
                isPartial: true,
                message: {
                    blocks: [{ text: "Still writing", type: "text" }],
                    id: "partial-1",
                    role: "agent",
                },
                position: 81,
                runId: "run-80",
            });
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, state.id);
                expect((await restored?.transcriptWindow(ctx))?.complete).toBe(false);
                expect(
                    new Set(restored?.state().messages.map((entry) => entry.position)).size,
                ).toBe(restored?.state().messages.length);
                expect((await restored?.transcriptPage(ctx, 10, "run-1"))?.turns[0]?.runId).toBe(
                    "run-0",
                );
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("pages forward from a persisted message event without skipping turns", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const session = await store.create(ctx, { cwd: "/tmp/rig-persisted-forward" });
                for (const text of ["One.", "Two.", "Three."]) {
                    await session.submitContext(ctx, { text });
                }
                const anchors = (session.events.since(undefined) ?? [])
                    .filter((event) => event.type === "message_submitted")
                    .map((event) => event.id);

                const first = await store.loadTranscriptSince(ctx, session.id, 2, anchors[0]!);
                expect(JSON.stringify(first?.messages)).toContain("One.");
                expect(JSON.stringify(first?.messages)).toContain("Two.");
                expect(JSON.stringify(first?.messages)).not.toContain("Three.");
                expect(first?.complete).toBe(false);

                const second = await store.loadTranscriptSince(ctx, session.id, 2, anchors[1]!);
                expect(JSON.stringify(second?.messages)).toContain("Two.");
                expect(JSON.stringify(second?.messages)).toContain("Three.");
                expect(second?.complete).toBe(true);
            } finally {
                await store?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("stores the model, provider, and fast mode a queued run carries", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const queuedRun: PersistedQueuedRun = {
                displayText: "queued prompt",
                effort: "high",
                kind: "user",
                modelId: "openai/queued",
                providerId: "codex",
                runId: "run-1",
                serviceTier: "fast",
                text: "queued prompt",
                userMessage: textUserMessage("message-1", "queued prompt"),
            };
            await store.saveSession(
                ctx,
                sessionState({ queuedRuns: [queuedRun], status: "queued" }),
            );
            await store.insertQueuedRun(ctx, "session-1", queuedRun);

            // Reading the session back parses the stored row. Dropping any of these would run the
            // message on a different model than the one it asked for, wherever a stored queue is
            // resumed rather than discarded.
            expect((await store.get(ctx, "session-1"))?.state().queuedRuns[0]).toMatchObject({
                effort: "high",
                modelId: "openai/queued",
                providerId: "codex",
                serviceTier: "fast",
            });
            await store?.close(ctx);
        } finally {
            await cleanup();
        }
    });

    it("emits terminal events for accepted queued runs that are aborted before start", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const queuedRun: PersistedQueuedRun = {
                displayText: "queued prompt",
                kind: "user",
                runId: "run-1",
                text: "queued prompt",
                userMessage: textUserMessage("message-1", "queued prompt"),
            };
            await store.saveSession(
                ctx,
                sessionState({
                    queuedRuns: [queuedRun],
                    status: "queued",
                }),
            );
            await store.insertQueuedRun(ctx, "session-1", queuedRun);

            const session = await store.get(ctx, "session-1");
            const response = await session?.abort(ctx);
            const events = session?.events.since(undefined) ?? [];

            expect(response?.aborted).toBe(true);
            expect(events.map((event) => event.type)).toEqual(["abort_requested", "run_error"]);
            expect(events.at(-1)).toMatchObject({
                data: { runId: "run-1" },
                type: "run_error",
            });
            await store?.close(ctx);
        } finally {
            await cleanup();
        }
    });

    it("lists sessions by most recent submitted message", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(
                ctx,
                sessionState({
                    id: "older-session",
                    lastMessageAt: 1_700_000_000_000,
                    title: "Older Work",
                    titleStatus: "ready",
                }),
            );
            await store.saveSession(
                ctx,
                sessionState({
                    id: "newer-session",
                    lastMessageAt: 1_700_000_001_000,
                    title: "Newer Work",
                    titleStatus: "ready",
                }),
            );

            const sessions = await store.list(ctx, { limit: 1 });

            expect(sessions).toEqual([
                expect.objectContaining({
                    id: "newer-session",
                    title: "Newer Work",
                }),
            ]);
            await store?.close(ctx);
        } finally {
            await cleanup();
        }
    });

    it("persists settled session metadata", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(
                ctx,
                sessionState({
                    title: "Persisted Title",
                    titleStatus: "ready",
                    recap: "The persisted recap remains available after restart.",
                    metadataRunId: "run-1",
                    metadataUpdatedAt: 1_700_000_002_000,
                }),
            );
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const restored = await restoredStore.get(ctx, "session-1");
                const summary = (await restoredStore.list(ctx, { limit: 1 })).at(0);

                expect(restored?.snapshot()).toMatchObject({
                    title: "Persisted Title",
                    titleStatus: "ready",
                    recap: "The persisted recap remains available after restart.",
                    metadataRunId: "run-1",
                    metadataUpdatedAt: 1_700_000_002_000,
                });
                expect(summary).toMatchObject({
                    title: "Persisted Title",
                    titleStatus: "ready",
                    recap: "The persisted recap remains available after restart.",
                    metadataRunId: "run-1",
                    metadataUpdatedAt: 1_700_000_002_000,
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("changes models after restoring an existing conversation", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        const catalog = testModelCatalog();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            const userMessage = textUserMessage("message-1", "started");
            const state = sessionState({
                effort: "low",
                messages: [
                    {
                        isPartial: false,
                        message: userMessage,
                        position: 0,
                        runId: "run-1",
                    },
                ],
                modelId: "openai/test",
                models: catalog.models,
            });
            await store.saveSession(ctx, state);
            const entry = state.messages[0];
            expect(entry).toBeDefined();
            if (entry !== undefined) {
                await store.upsertMessage(ctx, state.id, entry);
            }
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog,
            });
            try {
                const restored = await restoredStore.get(ctx, state.id);

                expect(restored?.snapshot().modelLocked).toBe(false);
                await restored?.changeModel(ctx, { effort: "high", modelId: "anthropic/test" });

                const snapshot = restored?.snapshot();
                const events = restored?.events.since(undefined) ?? [];
                expect(snapshot).toMatchObject({
                    effort: "high",
                    modelId: "anthropic/test",
                    modelLocked: false,
                    providerId: "claude",
                });
                expect(events.at(-1)).toMatchObject({
                    data: {
                        effort: "high",
                        modelId: "anthropic/test",
                    },
                    type: "session_configuration_changed",
                });
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists a forked conversation under a new session", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const source = await store.create(ctx, { cwd: "/tmp/rig-persistent-session-test" });
            const state = source.state();
            const message = textUserMessage("message-1", "Preserve this conversation.");
            await store.upsertMessage(ctx, source.id, {
                isPartial: false,
                message,
                position: 0,
                runId: "run-1",
            });
            await store?.close(ctx);

            const forkStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const forked = await forkStore.fork(ctx, state.id);
            expect(forked?.id).not.toBe(state.id);
            expect(forked?.snapshot().snapshot.messages).toEqual([message]);
            const forkedId = forked?.id;
            await forkStore.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect(forkedId).toBeDefined();
                expect(
                    (await restoredStore.get(ctx, forkedId ?? ""))?.snapshot().snapshot.messages,
                ).toEqual([message]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("repairs interrupted title generation on restart", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(
                ctx,
                sessionState({
                    titleStatus: "generating",
                }),
            );
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const summary = (await restoredStore.list(ctx, { limit: 1 })).at(0);

                expect(summary).toMatchObject({
                    titleStatus: "error",
                });
                expect(summary?.titleError).toContain("interrupted");
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("persists subagent lineage while keeping child histories out of the main list", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(ctx, sessionState());
            await store.saveSession(
                ctx,
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect the persistence layer",
                        parentSessionId: "session-1",
                        parentToolCallId: "tool-1",
                        rootSessionId: "session-1",
                        taskName: "inspect_persistence",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    activeSince: 1_500,
                    elapsedMs: 2_500,
                    id: "subagent-1",
                    status: "completed",
                    title: "Inspect the persistence layer",
                    titleStatus: "ready",
                    totalTokens: 12_345,
                    sessionTokenCount: {
                        lastContextTokens: 12_345,
                        totalTokens: 18_000,
                    },
                    usage: {
                        cacheRead: 9_000,
                        cacheWrite: 1_000,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 4_000,
                        output: 1_000,
                        totalTokens: 15_000,
                    },
                }),
            );
            await store.saveSession(
                ctx,
                sessionState({
                    agent: {
                        depth: 2,
                        description: "Inspect the nested query",
                        parentSessionId: "subagent-1",
                        rootSessionId: "session-1",
                        taskName: "inspect_nested_query",
                        type: "subagent",
                    },
                    agentId: "agent-3",
                    elapsedMs: 900,
                    id: "subagent-2",
                    status: "error",
                    totalTokens: 600,
                }),
            );
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                expect((await restoredStore.list(ctx)).map((session) => session.id)).toEqual([
                    "session-1",
                ]);
                expect(await restoredStore.listSubagents(ctx, "session-1")).toEqual([
                    expect.objectContaining({
                        activeSince: 1_500,
                        depth: 1,
                        description: "Inspect the persistence layer",
                        elapsedMs: 2_500,
                        id: "subagent-1",
                        parentToolCallId: "tool-1",
                        status: "completed",
                        taskName: "inspect_persistence",
                        totalTokens: 12_345,
                        sessionTokenCount: {
                            lastContextTokens: 12_345,
                            totalTokens: 18_000,
                        },
                        usage: expect.objectContaining({
                            cacheRead: 9_000,
                            cacheWrite: 1_000,
                            input: 4_000,
                            output: 1_000,
                            totalTokens: 15_000,
                        }),
                    }),
                    expect.objectContaining({
                        depth: 2,
                        elapsedMs: 900,
                        id: "subagent-2",
                        parentSessionId: "subagent-1",
                        status: "error",
                        totalTokens: 600,
                    }),
                ]);
                expect(await restoredStore.listSubagents(ctx, "subagent-1")).toEqual([
                    expect.objectContaining({ id: "subagent-2" }),
                ]);
                expect((await restoredStore.get(ctx, "subagent-1"))?.snapshot().agent).toEqual({
                    depth: 1,
                    description: "Inspect the persistence layer",
                    parentSessionId: "session-1",
                    parentToolCallId: "tool-1",
                    rootSessionId: "session-1",
                    taskName: "inspect_persistence",
                    type: "subagent",
                });
                await expect(
                    (await restoredStore.get(ctx, "subagent-1"))?.requestUserInput(ctx, {
                        requestId: "question-1",
                        questions: [],
                    }),
                ).rejects.toThrow("Only the primary session");
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });

    it("drops a stored position from a subagent instead of listing it as a chat", async () => {
        const { cleanup, databasePath } = await createDatabasePath();
        try {
            const store = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            await store.saveSession(ctx, sessionState());
            // A position written by an older build, when a subagent was given a
            // key of its own. It is still not a chat in any list.
            await store.saveSession(
                ctx,
                sessionState({
                    agent: {
                        depth: 1,
                        description: "Inspect the ordering",
                        parentSessionId: "session-1",
                        rootSessionId: "session-1",
                        type: "subagent",
                    },
                    agentId: "agent-2",
                    id: "subagent-1",
                    orderKey: "a1",
                    status: "completed",
                }),
            );
            await store?.close(ctx);

            const restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            try {
                const subagent = await restoredStore.get(ctx, "subagent-1");

                expect(subagent?.snapshot().orderKey).toBeUndefined();
                expect(subagent?.summary().orderKey).toBeUndefined();
                expect((await restoredStore.list(ctx)).map((session) => session.id)).toEqual([
                    "session-1",
                ]);
            } finally {
                await restoredStore?.close(ctx);
            }
        } finally {
            await cleanup();
        }
    });
});

async function waitForPendingUserInputs(session: InMemorySession, count: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const requests = session.snapshot().pendingUserInputs;
        if (requests.length === count) return requests;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for the durable user question.");
}

function sessionMetadataResponse(request: GymInferenceRequest): Response | undefined {
    if (!request.options.sessionId?.endsWith(":title")) return undefined;
    return new Response(
        JSON.stringify({
            content: [
                {
                    text: [
                        "<title>Generated Session Title</title>",
                        "<recap>The session metadata reflects the visible conversation.</recap>",
                    ].join("\n"),
                    type: "text",
                },
            ],
            stopReason: "stop",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
    );
}

async function createDatabasePath(): Promise<{
    cleanup: () => Promise<void>;
    databasePath: string;
}> {
    const directory = await mkdtemp(join(tmpdir(), "rig-sessions-test-"));
    return {
        cleanup: () => rm(directory, { force: true, recursive: true }),
        databasePath: join(directory, "sessions.sqlite"),
    };
}

async function createGitRepository(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await execFile("git", ["-C", path, "init", "--initial-branch=main"]);
    await execFile("git", ["-C", path, "config", "user.email", "rig@example.test"]);
    await execFile("git", ["-C", path, "config", "user.name", "Rig Test"]);
    await writeFile(join(path, "README.md"), "fixture\n");
    await execFile("git", ["-C", path, "add", "README.md"]);
    await execFile("git", ["-C", path, "commit", "-m", "Initial"]);
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function testModelCatalog(): ModelCatalog {
    const openai = defineModel({
        id: "openai/test",
        name: "OpenAI Test",
        thinkingLevels: ["low", "high"],
        defaultThinkingLevel: "low",
    });
    const anthropic = defineModel({
        id: "anthropic/test",
        name: "Anthropic Test",
        thinkingLevels: ["low", "high"],
        defaultThinkingLevel: "low",
    });
    return {
        defaultModelId: openai.id,
        defaultProviderId: "codex",
        models: [openai, anthropic],
        providers: [
            { providerId: "codex", models: [openai] },
            { providerId: "claude", models: [anthropic] },
        ],
    };
}

function sessionState(overrides: Partial<PersistedSessionState> = {}): PersistedSessionState {
    return {
        agent: {
            depth: 0,
            rootSessionId: "session-1",
            type: "primary",
        },
        agentId: "agent-1",
        ownerInstanceId: "alocalinstance00000000001",
        cwd: "/tmp/rig-persistent-session-test",
        id: "session-1",
        messages: [],
        modelId: "openai/gpt-5.5",
        models: [],
        orderKey: "a0",
        providerId: "codex",
        permissionMode: "workspace_write",
        queuedRuns: [],
        scope: { kind: "unsorted" },
        nextTaskId: 1,
        status: "idle",
        tasks: [],
        titleStatus: "idle",
        tools: [],
        unsortedSince: Date.now(),
        ...overrides,
    };
}

function textUserMessage(id: string, text: string): UserMessage {
    return {
        blocks: [{ text, type: "text" }],
        id,
        role: "user",
    };
}

function providerMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .flatMap((block) =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string"
                ? [block.text]
                : [],
        )
        .join("\n");
}

function sessionEvent(
    sessionId: string,
    id: string,
    type: SessionEvent["type"],
    data: unknown,
): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data,
        id,
        sessionId,
        type,
    } as SessionEvent;
}

async function insertSessionEvent(
    database: Client,
    sessionId: string,
    id: string,
    type: SessionEvent["type"],
    data: unknown,
): Promise<void> {
    const record = data as Record<string, unknown>;
    const message = record.message as { id?: unknown } | undefined;
    const inner = record.event as { toolCallId?: unknown } | undefined;
    await database.execute({
        args: [
            sessionId,
            id,
            type,
            1_700_000_000_000,
            JSON.stringify(data),
            typeof record.runId === "string" ? record.runId : null,
            typeof message?.id === "string" ? message.id : null,
            typeof inner?.toolCallId === "string" ? inner.toolCallId : null,
        ],
        sql: `
            INSERT INTO session_events (
                session_id, event_id, type, created_at_ms, data_json,
                run_id, message_id, tool_call_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
    });
}

async function insertEvent<TType extends import("../../protocol/index.js").SessionEvent["type"]>(
    database: Client,
    sessionId: string,
    eventId: string,
    type: TType,
    createdAt: number,
    data: Extract<import("../../protocol/index.js").SessionEvent, { type: TType }>["data"],
): Promise<void> {
    await database.execute({
        args: [sessionId, eventId, type, createdAt, JSON.stringify(data)],
        sql: "INSERT INTO session_events (session_id, event_id, type, created_at_ms, data_json) VALUES (?, ?, ?, ?, ?)",
    });
}

function openTestDatabase(databasePath: string): Client {
    return createClient({ url: pathToFileURL(databasePath).href });
}

async function expectErrorChainToContain(
    operation: Promise<unknown>,
    expectedMessage: string,
): Promise<void> {
    let rejection: unknown;
    try {
        await operation;
    } catch (error) {
        rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current = rejection;
    while (current instanceof Error && !seen.has(current)) {
        seen.add(current);
        messages.push(current.message);
        current = current.cause;
    }
    expect(messages.join("\n")).toContain(expectedMessage);
}

async function queryTestRow<T>(
    database: Client,
    statement: string,
    args: InArgs = [],
): Promise<T | undefined> {
    const result = await database.execute({ args, sql: statement });
    return result.rows[0] as unknown as T | undefined;
}

async function queryTestRows<T>(
    database: Client,
    statement: string,
    args: InArgs = [],
): Promise<T[]> {
    const result = await database.execute({ args, sql: statement });
    return result.rows as unknown as T[];
}
