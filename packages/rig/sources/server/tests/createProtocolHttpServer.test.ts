import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import { describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import sharp from "sharp";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import {
    createEventIdFactory,
    type SessionEvent,
    type SessionStateResponse,
    type SessionStreamHello,
    type SessionSummary,
} from "../../protocol/index.js";
import { modelOpenaiGpt55, modelOpenaiGpt56Sol } from "@slopus/rig-execution";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import type { PersistedSessionState } from "../../session/InMemorySession.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import type { SessionStore } from "../../session/SessionStore.js";
import { WorkspaceTransferTargetRestoreError } from "../../git/prepareWorkspaceTransfer.js";
import {
    createProtocolHttpServer,
    type ProtocolHttpServerOptions,
} from "../createProtocolHttpServer.js";
import type { FileSearchServiceContract } from "../../file-search/FileSearchService.js";
import type { DockerExecutionConfig } from "../../execution/index.js";
import { CONTAINER_DOCS_PATH, getBundledDocsRoot } from "../../execution/getBundledDocsRoot.js";
import { CONTAINER_GENERATED_PATH } from "../../execution/getGeneratedMount.js";
import { getGeneratedDirectory } from "../../generated-media/index.js";
import type { GlobalEventQueue } from "../../global-event/GlobalEventQueue.js";
import type { OnboardingServiceContract } from "../../onboarding/OnboardingService.js";
import { ProjectRegistrationError } from "../../project/ProjectRepository.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { TrackedTaskDrain } from "../../utils/TrackedTaskDrain.js";
import type { ProviderQuota } from "@slopus/happy-providers";
import { CURRENT_SESSION_DATABASE_VERSION } from "../../persistence/database/migrateSessionDatabase.js";
import { RigProfileStore } from "../../profiles/index.js";

const execFile = promisify(execFileCallback);
const ctx = createTestRootContext();

// Git keeps writing inside `.git` for a moment after a command returns, so a
// fixture repository has to be removed with a few retries.
const removeFixtureOptions = {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 50,
} as const;

describe("createProtocolHttpServer", () => {
    it("keeps busy transfers as conflicts and reports target restore failures as server errors", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-transfer-http-"));
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: directory });
        const transfer = vi.spyOn(store, "transferSession");
        const { close, socketPath } = await startServer({ store });
        try {
            transfer.mockRejectedValueOnce(
                new Error(
                    "Wait for the active response to finish before transferring this session.",
                ),
            );
            await expect(
                requestRawJson(socketPath, `/sessions/${session.id}/transfer`, {
                    body: JSON.stringify({ targetWorkspaceId: "workspace-2" }),
                    method: "POST",
                }),
            ).resolves.toMatchObject({ statusCode: 409 });

            transfer.mockRejectedValueOnce(
                new WorkspaceTransferTargetRestoreError(
                    new Error("Transfer failed."),
                    new Error("Restore failed."),
                ),
            );
            await expect(
                requestRawJson(socketPath, `/sessions/${session.id}/transfer`, {
                    body: JSON.stringify({ targetWorkspaceId: "workspace-2" }),
                    method: "POST",
                }),
            ).resolves.toMatchObject({ statusCode: 500 });
        } finally {
            await close();
            await store.close(ctx);
            await rm(directory, removeFixtureOptions);
        }
    });

    it("downloads committed attachments only from their host-visible generated snapshot", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "rig-attachment-workspace-"));
        const outside = await mkdtemp(join(tmpdir(), "rig-attachment-outside-"));
        const stateDirectory = await mkdtemp(join(tmpdir(), "rig-attachment-state-"));
        const databasePath = join(stateDirectory, "sessions.sqlite");
        const generated = join(workspace, "generated");
        const originalGenerated = process.env.HAPPY_GENERATED_DIRECTORY;
        process.env.HAPPY_GENERATED_DIRECTORY = generated;
        await mkdir(generated);
        await writeFile(join(generated, "result.txt"), "docker result\n");
        await writeFile(join(generated, "preview.png"), "preview image\n");
        await writeFile(join(outside, "secret.txt"), "outside\n");
        await symlink(join(outside, "secret.txt"), join(generated, "link.txt"));
        const attachments = [
            {
                bytes: 14,
                downloadUrl: "/sessions/goal-session/attachments/attachment-1/download",
                id: "attachment-1",
                kind: "file" as const,
                mediaType: "text/plain",
                name: "result.txt",
                source: "generated/result.txt",
            },
            {
                bytes: 8,
                downloadUrl: "/sessions/goal-session/attachments/attachment-link/download",
                id: "attachment-link",
                kind: "file" as const,
                mediaType: "text/plain",
                name: "link.txt",
                source: "generated/link.txt",
            },
            {
                bytes: 14,
                downloadUrl: "/sessions/goal-session/attachments/attachment-video/download",
                duration: 1,
                height: 720,
                id: "attachment-video",
                kind: "video" as const,
                mediaType: "video/mp4",
                name: "result.mp4",
                preview: {
                    downloadUrl: "/sessions/goal-session/attachments/attachment-video/preview",
                    height: 360,
                    mediaType: "image/png" as const,
                    path: "generated/preview.png",
                    thumbhash: "AQID",
                    width: 640,
                },
                source: "generated/result.txt",
                width: 1280,
            },
        ];
        const initialStore = await PersistentSessionStore.open(ctx, {
            databasePath,
        });
        await initialStore.saveSession(ctx, {
            ...pausedGoalState(),
            cwd: workspace,
            docker: { image: "example.test/rig", workingDirectory: "/workspace" },
            messages: [],
        });
        await initialStore.upsertMessage(ctx, "goal-session", {
            isPartial: false,
            message: {
                blocks: [{ text: "Show the result.", type: "text" }],
                id: "user-message",
                role: "user",
            },
            position: 0,
            runId: "run-1",
        });
        await initialStore.upsertMessage(ctx, "goal-session", {
            isPartial: false,
            message: {
                attachments,
                blocks: [{ text: "Done.", type: "text" }],
                id: "agent-message",
                role: "agent",
            },
            position: 1,
            runId: "run-1",
        });
        for (let turn = 2; turn <= 82; turn += 1) {
            const runId = `run-${String(turn)}`;
            await initialStore.upsertMessage(ctx, "goal-session", {
                isPartial: false,
                message: {
                    blocks: [{ text: `Question ${String(turn)}`, type: "text" }],
                    id: `user-message-${String(turn)}`,
                    role: "user",
                },
                position: turn * 2 - 2,
                runId,
            });
            await initialStore.upsertMessage(ctx, "goal-session", {
                isPartial: false,
                message: {
                    blocks: [{ text: `Answer ${String(turn)}`, type: "text" }],
                    id: `agent-message-${String(turn)}`,
                    role: "agent",
                },
                position: turn * 2 - 1,
                runId,
            });
        }
        await initialStore.upsertMessage(ctx, "goal-session", {
            isPartial: false,
            message: {
                attachments: [{ ...attachments[0]!, id: "internal-attachment" }],
                blocks: [{ text: "Private context.", type: "text" }],
                id: "internal-agent-message",
                internal: true,
                role: "agent",
            },
            position: 164,
            runId: "run-83",
        });
        await initialStore.close(ctx);
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
        });
        expect((await store.get(ctx, "goal-session"))?.attachment("attachment-1")).toBeUndefined();
        expect(await store.attachment(ctx, "goal-session", "attachment-1")).toMatchObject({
            source: "generated/result.txt",
        });
        const { close, socketPath } = await startServer({ store });
        try {
            const response = await requestRawJson(
                socketPath,
                "/sessions/goal-session/attachments/attachment-1/download",
                { body: "", method: "GET" },
            );
            expect(response).toMatchObject({
                body: "docker result\n",
                headers: {
                    "cache-control": "private, no-store",
                    "content-disposition": 'attachment; filename="result.txt"',
                    "content-type": "text/plain",
                    "x-content-type-options": "nosniff",
                },
                statusCode: 200,
            });
            await expect(
                requestRawJson(
                    socketPath,
                    "/sessions/goal-session/attachments/attachment-video/preview",
                    { body: "", method: "GET" },
                ),
            ).resolves.toMatchObject({
                body: "preview image\n",
                headers: {
                    "content-disposition": "inline",
                    "content-type": "image/png",
                },
                statusCode: 200,
            });
            await expect(
                requestRawJson(
                    socketPath,
                    "/sessions/goal-session/attachments/attachment-link/download",
                    { body: "", method: "GET" },
                ),
            ).resolves.toMatchObject({ statusCode: 404 });
            await expect(
                requestRawJson(
                    socketPath,
                    "/sessions/goal-session/attachments/not-committed/download",
                    { body: "", method: "GET" },
                ),
            ).resolves.toMatchObject({ statusCode: 404 });
            await expect(
                requestRawJson(
                    socketPath,
                    "/sessions/goal-session/attachments/internal-attachment/download",
                    { body: "", method: "GET" },
                ),
            ).resolves.toMatchObject({ statusCode: 404 });
        } finally {
            await close();
            await store.close(ctx);
            await rm(workspace, removeFixtureOptions);
            await rm(outside, removeFixtureOptions);
            await rm(stateDirectory, removeFixtureOptions);
            if (originalGenerated === undefined) delete process.env.HAPPY_GENERATED_DIRECTORY;
            else process.env.HAPPY_GENERATED_DIRECTORY = originalGenerated;
        }
    });

    it("keeps private model context out of a bounded session state response", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const privateMarker = "private-model-context:";
        await store.saveSession(ctx, {
            ...pausedGoalState(),
            contextMessages: [
                {
                    blocks: [
                        {
                            text: `${privateMarker}${"x".repeat(512 * 1_024)}`,
                            type: "text",
                        },
                    ],
                    id: "private-context-message",
                    role: "user",
                },
            ],
        });
        const session = await store.get(ctx, "goal-session");
        if (session === undefined) throw new Error("Expected the restored session.");
        const fullSnapshot = vi.spyOn(session, "snapshot").mockImplementation(() => {
            throw new Error("Session state must not build the full historical snapshot.");
        });
        const createEventId = createEventIdFactory();
        await session.events.append(ctx, {
            createdAt: 1,
            data: {
                command: "finished command",
                commandId: "finished-command",
                exitCode: 0,
                output: `private-shell-output:${"y".repeat(512 * 1_024)}`,
                timedOut: false,
            },
            id: createEventId(),
            sessionId: session.id,
            type: "shell_command_finished",
        });
        await session.events.append(ctx, {
            createdAt: 2,
            data: {
                command: "running command",
                commandId: "running-command",
                sessionId: 42,
            },
            id: createEventId(),
            sessionId: session.id,
            type: "shell_command_started",
        });
        const { close, socketPath } = await startServer({ store });
        try {
            const response = await requestRawJson(socketPath, "/sessions/goal-session/state", {
                body: "",
                method: "GET",
            });
            const state = JSON.parse(response.body) as SessionStateResponse;

            expect(response.statusCode).toBe(200);
            expect(fullSnapshot).not.toHaveBeenCalled();
            expect(state.usage).toEqual({
                currentProviderId: "codex",
                groups: [],
                quotas: [],
                sessionTokenCount: { lastContextTokens: 0, totalTokens: 0 },
            });
            expect(response.body).not.toContain(privateMarker);
            expect(response.body).not.toContain("private-shell-output:");
            expect(response.body.length).toBeLessThan(32 * 1_024);
            expect(state.session?.snapshot.contextMessages).toBeUndefined();
            expect(state.session?.snapshot.messages).toEqual([]);
            expect(state.session?.shellCommands).toEqual([
                {
                    command: "running command",
                    commandId: "running-command",
                    sessionId: 42,
                    status: "running",
                },
            ]);
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("accepts identities a client chose and refuses the ones it may not choose", async () => {
        const projectDirectory = await mkdtemp(join(tmpdir(), "rig-client-identity-"));
        await execFile("git", ["-C", projectDirectory, "init"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.email", "rig@example.test"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.name", "Rig Test"]);
        await writeFile(join(projectDirectory, "README.md"), "fixture\n");
        await execFile("git", ["-C", projectDirectory, "add", "README.md"]);
        await execFile("git", ["-C", projectDirectory, "commit", "-m", "Initial"]);
        const { client, close, socketPath } = await startServer();
        const sessionId = createId();
        const projectId = createId();
        const workspaceId = createId();
        const workspacesPath = `/projects/${encodeURIComponent(projectId)}/workspaces`;
        try {
            const created = await client.createSession({
                cwd: projectDirectory,
                id: sessionId,
                projectId,
            });
            expect(created.session.id).toBe(sessionId);
            expect(created.session.projectId!).toBe(projectId);

            const workspace = await client.createProjectWorkspace(projectId, {
                baseRef: "HEAD",
                id: workspaceId,
                name: "Named By The Client",
            });
            expect(workspace.workspace.id).toBe(workspaceId);

            // Repeating a create is answered with the entity it already made.
            await expect(
                client.createProjectWorkspace(projectId, {
                    baseRef: "HEAD",
                    id: workspaceId,
                    name: "Named By The Client",
                }),
            ).resolves.toMatchObject({ workspace: { id: workspaceId } });

            await expect(
                requestRawJson(socketPath, "/sessions", {
                    body: JSON.stringify({ cwd: projectDirectory, id: "Not A Cuid2" }),
                    method: "POST",
                }),
            ).resolves.toMatchObject({ statusCode: 400 });
            await expect(
                requestRawJson(socketPath, workspacesPath, {
                    body: JSON.stringify({ baseRef: "HEAD", id: "Not A Cuid2", name: "Invalid" }),
                    method: "POST",
                }),
            ).resolves.toMatchObject({ statusCode: 400 });
            // The identity already names a workspace built on another base, so
            // this create describes something else and is a conflict.
            await expect(
                requestRawJson(socketPath, workspacesPath, {
                    body: JSON.stringify({
                        baseRef: "HEAD~0",
                        id: workspaceId,
                        name: "Conflicting",
                    }),
                    method: "POST",
                }),
            ).resolves.toMatchObject({ statusCode: 409 });
        } finally {
            await close();
            await rm(projectDirectory, removeFixtureOptions);
        }
    });

    it("requires an entity version for workspace mutations", async () => {
        const projectDirectory = await mkdtemp(join(tmpdir(), "rig-workspace-version-"));
        await execFile("git", ["-C", projectDirectory, "init"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.email", "rig@example.test"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.name", "Rig Test"]);
        await writeFile(join(projectDirectory, "README.md"), "fixture\n");
        await execFile("git", ["-C", projectDirectory, "add", "README.md"]);
        await execFile("git", ["-C", projectDirectory, "commit", "-m", "Initial"]);
        const { client, close, socketPath } = await startServer();
        try {
            const created = await client.createSession({ cwd: projectDirectory });
            const response = await client.createProjectWorkspace(created.session.projectId!, {
                baseRef: "HEAD",
                name: "Versioned workspace",
            });
            const workspacePath = `/projects/${encodeURIComponent(
                created.session.projectId!,
            )}/workspaces/${encodeURIComponent(response.workspace.id)}`;

            await expect(
                requestRawJson(socketPath, workspacePath, {
                    body: '{"name":"Missing version"}',
                    method: "PATCH",
                }),
            ).resolves.toMatchObject({ statusCode: 400 });
            await expect(
                requestRawJson(socketPath, `${workspacePath}/archive`, {
                    body: "{}",
                    method: "POST",
                }),
            ).resolves.toMatchObject({ statusCode: 400 });
            await expect(
                requestRawJson(socketPath, `${workspacePath}/reorder`, {
                    body: '{"afterId":null}',
                    method: "POST",
                }),
            ).resolves.toMatchObject({ statusCode: 400 });

            let workspace = response.workspace;
            await vi.waitFor(
                async () => {
                    const candidate = (
                        await client.listProjectWorkspaces(created.session.projectId!)
                    ).workspaces.find((item) => item.id === response.workspace.id);
                    if (candidate === undefined) throw new Error("Expected the workspace.");
                    workspace = candidate;
                    expect(workspace.status).toBe("ready");
                },
                { interval: 20, timeout: 5_000 },
            );
            const attached = await client.createSession({
                cwd: workspace.path,
                workspaceId: workspace.id,
            });
            await expect(
                client.reorderProjectWorkspace(
                    created.session.projectId!,
                    workspace.id,
                    { afterId: null },
                    workspace.version,
                ),
            ).resolves.toMatchObject({
                workspace: { id: workspace.id, orderKey: expect.any(String) },
            });
            await client.archiveProjectWorkspace(
                created.session.projectId!,
                workspace.id,
                workspace.version,
            );

            await expect(client.unarchiveSession(attached.session.id)).rejects.toThrow(
                "cannot be restored",
            );
            await expect(client.listSessions()).resolves.toMatchObject({
                sessions: expect.not.arrayContaining([
                    expect.objectContaining({ id: attached.session.id }),
                ]),
            });
            await expect(client.listSessions({ archived: true })).resolves.toMatchObject({
                sessions: expect.arrayContaining([
                    expect.objectContaining({
                        archived: true,
                        id: attached.session.id,
                        status: "archived",
                    }),
                ]),
            });
        } finally {
            await close();
            await rm(projectDirectory, removeFixtureOptions);
        }
    });

    it("accepts sessions and durable messages while a managed workspace initializes", async () => {
        const projectDirectory = await mkdtemp(join(tmpdir(), "rig-workspace-queued-session-"));
        const stateDirectory = await mkdtemp(join(tmpdir(), "rig-workspace-queued-state-"));
        const workspacesDirectory = join(stateDirectory, "workspaces");
        await execFile("git", ["-C", projectDirectory, "init"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.email", "rig@example.test"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.name", "Rig Test"]);
        await writeFile(join(projectDirectory, "README.md"), "fixture\n");
        await execFile("git", ["-C", projectDirectory, "add", "README.md"]);
        await execFile("git", ["-C", projectDirectory, "commit", "-m", "Initial"]);
        const worktreeAddStarted = deferred<void>();
        const releaseWorktreeAdd = deferred<void>();
        const createRuntime = vi.fn();
        const search = vi.fn(async () => []);
        const store = await PersistentSessionStore.open(ctx, {
            createRuntime,
            databasePath: join(stateDirectory, "sessions.sqlite"),
            projectGit: async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    worktreeAddStarted.resolve();
                    await releaseWorktreeAdd.promise;
                }
                const result = await execFile("git", args, { cwd });
                return result.stdout.trim();
            },
            stateDirectory,
            workspacesDirectory,
        });
        const { client, close } = await startServer({
            fileSearchService: { close: vi.fn(), search },
            store,
        });
        try {
            const source = await client.createSession({ cwd: projectDirectory });
            const sourceProjectId = source.session.projectId!;
            const workspace = (
                await client.createProjectWorkspace(sourceProjectId, {
                    baseRef: "HEAD",
                    id: createId(),
                    name: "Queued session",
                })
            ).workspace;
            expect(workspace.status).toBe("initializing");
            await worktreeAddStarted.promise;

            const sessionId = createId();
            const request = {
                cwd: workspace.path,
                id: sessionId,
                projectId: sourceProjectId,
                workspaceId: workspace.id,
            };
            const created = await client.createSession(request);
            await expect(client.createSession(request)).resolves.toMatchObject({
                session: { id: sessionId, workspaceId: workspace.id },
            });

            const submission = {
                clientSubmissionId: createId(),
                text: "Wait until the checkout is ready.",
            };
            const first = await client.submitMessage(created.session.id, submission);
            await expect(client.submitMessage(created.session.id, submission)).resolves.toEqual(
                first,
            );
            expect((await store.get(ctx, created.session.id))?.snapshot()).toMatchObject({
                status: "queued",
                workspaceId: workspace.id,
            });
            expect(createRuntime).not.toHaveBeenCalled();

            await expect(
                client.searchFiles(
                    { projectId: sourceProjectId, workspaceId: workspace.id },
                    "README",
                ),
            ).rejects.toThrow();
            expect(search).not.toHaveBeenCalled();

            const events = (await client.getGlobalEvents()).events.map((entry) => entry.event);
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "workspace_created",
                        workspaceId: workspace.id,
                    }),
                    expect.objectContaining({
                        sessionId: created.session.id,
                        type: "session_created",
                    }),
                    expect.objectContaining({
                        sessionId: created.session.id,
                        type: "message_submitted",
                    }),
                ]),
            );
        } finally {
            releaseWorktreeAdd.resolve();
            await close();
            await store.close(ctx);
            await rm(projectDirectory, removeFixtureOptions);
            await rm(stateDirectory, removeFixtureOptions);
        }
    });

    it("creates a workspace without a client-chosen ID and resolves sessions from its cwd", async () => {
        const projectDirectory = await mkdtemp(join(tmpdir(), "rig-workspace-without-id-"));
        await execFile("git", ["-C", projectDirectory, "init"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.email", "rig@example.test"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.name", "Rig Test"]);
        await writeFile(join(projectDirectory, "README.md"), "fixture\n");
        await execFile("git", ["-C", projectDirectory, "add", "README.md"]);
        await execFile("git", ["-C", projectDirectory, "commit", "-m", "Initial"]);
        const { client, close, socketPath, store } = await startServer();
        try {
            const source = await client.createSession({ cwd: projectDirectory });
            const sourceProjectId = source.session.projectId!;
            const created = await requestRawJson(
                socketPath,
                `/projects/${sourceProjectId}/workspaces`,
                {
                    body: JSON.stringify({ baseRef: "HEAD", name: "Without client ID" }),
                    method: "POST",
                },
            );
            expect(created.statusCode).toBe(202);
            const createdBody = JSON.parse(created.body) as {
                workspace: { id: string; path: string; status: string };
            };
            let workspace = createdBody.workspace;
            await vi.waitFor(
                async () => {
                    const candidate = (
                        await client.listProjectWorkspaces(sourceProjectId)
                    ).workspaces.find((item) => item.id === workspace.id);
                    if (candidate === undefined) throw new Error("Expected the workspace.");
                    workspace = candidate;
                    expect(workspace.status).toBe("ready");
                },
                { interval: 20, timeout: 5_000 },
            );

            const project = (await client.getProject(sourceProjectId)).project;
            await client.updateProjectSettings(
                project.id,
                {
                    defaultWorkspaceCompute: {
                        image: "workspace-dev:latest",
                        type: "docker",
                    },
                    mutationId: "workspace-compute-1",
                },
                project.version,
            );
            const attached = await client.createSession({ cwd: workspace.path });

            expect(attached.session).toMatchObject({
                projectId: sourceProjectId,
                workspaceId: workspace.id,
            });
            expect(
                (await store.get(ctx, attached.session.id))?.requestForSubagent().docker?.name,
            ).toBe(`rig-workspace-${workspace.id}-1`);
        } finally {
            await close();
            await rm(projectDirectory, removeFixtureOptions);
        }
    });

    it("saves project settings when initialization alone advances the project version", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-project-settings-initialization-"));
        const projectDirectory = join(root, "project");
        const stateDirectory = join(root, "state");
        await Promise.all([mkdir(projectDirectory), mkdir(stateDirectory)]);
        const firstProbeStarted = deferred<void>();
        const releaseFirstProbe = deferred<void>();
        const initializationContinued = deferred<void>();
        const releaseInitialization = deferred<void>();
        let topLevelReads = 0;
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: join(stateDirectory, "sessions.sqlite"),
            homeDirectory: root,
            projectGit: async (cwd, args) => {
                if (args.join(" ") === "rev-parse --show-toplevel") {
                    topLevelReads += 1;
                    if (topLevelReads === 1) {
                        firstProbeStarted.resolve();
                        await releaseFirstProbe.promise;
                    } else if (topLevelReads === 2) {
                        initializationContinued.resolve();
                        await releaseInitialization.promise;
                    }
                    return cwd;
                }
                if (args.join(" ") === "rev-parse --verify HEAD") return "commit-1";
                if (args.join(" ") === "symbolic-ref --quiet --short HEAD") return "main";
                throw new Error("Git fact unavailable.");
            },
            stateDirectory,
        });
        const { client, close } = await startServer({ store });
        try {
            const session = await client.createSession({ cwd: projectDirectory });
            const projectId = session.session.projectId!;
            await firstProbeStarted.promise;
            const project = (await client.getProject(projectId)).project;

            releaseFirstProbe.resolve();
            await initializationContinued.promise;
            expect(await store.getProject(ctx, project.id)).toMatchObject({
                initializationStatus: "initializing",
                version: project.version + 1,
            });

            await expect(
                client.updateProjectSettings(
                    project.id,
                    {
                        defaultWorkspaceCompute: {
                            image: "workspace-dev:latest",
                            type: "docker",
                        },
                        mutationId: "settings-during-initialization",
                    },
                    project.version,
                ),
            ).resolves.toMatchObject({
                project: {
                    settings: {
                        defaultWorkspaceCompute: {
                            generation: 1,
                            image: "workspace-dev:latest",
                            type: "docker",
                        },
                    },
                },
            });
        } finally {
            releaseFirstProbe.resolve();
            releaseInitialization.resolve();
            await close();
            await store.close(ctx);
            await rm(root, removeFixtureOptions);
        }
    });

    it("archives a project with its chats and restores it when the folder is used again", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const { client, close } = await startServer({ store });
        try {
            const first = await client.createSession({ cwd: "/tmp/rig-archive-api/project" });
            const second = await client.createSession({ cwd: "/tmp/rig-archive-api/project" });
            const project = (await client.getProject(first.session.projectId!)).project;

            await expect(client.archiveProject(project.id, project.version + 1)).rejects.toThrow(
                "changed before it could be archived",
            );

            const archived = await client.archiveProject(project.id, project.version);
            expect(archived.project.archivedAt).toBeGreaterThan(0);
            await expect(client.listSessions()).resolves.toMatchObject({
                sessions: expect.not.arrayContaining([
                    expect.objectContaining({ id: first.session.id }),
                    expect.objectContaining({ id: second.session.id }),
                ]),
            });

            await client.unarchiveSession(second.session.id);
            expect((await client.getProject(project.id)).project.archivedAt).toBeUndefined();

            await client.archiveProject(
                project.id,
                (await client.getProject(project.id)).project.version,
            );
            const resumed = await client.createSession({ cwd: "/tmp/rig-archive-api/project" });
            expect(resumed.session.projectId).toBe(project.id);
            expect((await client.getProject(project.id)).project.archivedAt).toBeUndefined();
        } finally {
            await close();
        }
    });

    it("registers projects without sessions and returns strict typed path failures", async () => {
        const repository = await mkdtemp(join(tmpdir(), "rig-project-registration-http-"));
        await execFile("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repository });
        const store = await InMemorySessionStore.open(ctx);
        const { client, close, socketPath } = await startServer({ store });
        try {
            const projectId = createId();
            const first = await client.registerProject({ path: repository, projectId });
            const repeated = await client.registerProject({ path: repository, projectId });

            expect(repeated).toEqual(first);
            expect(first.project).toMatchObject({ id: projectId });
            expect(first.project.path).toBe(await realpath(repository));
            expect(await store.list(ctx)).toEqual([]);
            expect(await store.listWorkspaces(ctx)).toEqual([]);

            const invalid = await requestRawJson(socketPath, "/projects", {
                body: JSON.stringify({ extra: true, path: repository }),
                method: "POST",
            });
            expect(invalid.statusCode).toBe(400);
            expect(JSON.parse(invalid.body)).toEqual({
                error: {
                    code: "invalid_request",
                    message: "A project path and optional project ID are required.",
                },
            });

            const invalidProjectId = await requestRawJson(socketPath, "/projects", {
                body: JSON.stringify({ path: repository, projectId: "not-a-cuid2" }),
                method: "POST",
            });
            expect(invalidProjectId.statusCode).toBe(400);
            expect(JSON.parse(invalidProjectId.body)).toEqual({
                error: {
                    code: "invalid_request",
                    message: "The project ID must be a cuid2 identity.",
                },
            });

            const missing = await requestRawJson(socketPath, "/projects", {
                body: JSON.stringify({ path: join(repository, "missing") }),
                method: "POST",
            });
            expect(missing.statusCode).toBe(404);
            expect(JSON.parse(missing.body)).toEqual({
                error: {
                    code: "path_missing",
                    message: "The project folder does not exist.",
                },
            });

            vi.spyOn(store, "registerProject").mockRejectedValueOnce(
                new ProjectRegistrationError(
                    "managed_workspace_unavailable",
                    "The managed workspace is not ready.",
                ),
            );
            const unavailableWorkspace = await requestRawJson(socketPath, "/projects", {
                body: JSON.stringify({ path: repository }),
                method: "POST",
            });
            expect(unavailableWorkspace.statusCode).toBe(409);
            expect(JSON.parse(unavailableWorkspace.body)).toEqual({
                error: {
                    code: "managed_workspace_unavailable",
                    message: "The managed workspace is not ready.",
                },
            });
        } finally {
            await close();
            await store.close(ctx);
            await rm(repository, removeFixtureOptions);
        }
    });

    it("starts managed project clones through the API without exposing GitHub credentials", async () => {
        const localInstanceId = "alocalcloneapi00000000001";
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            localInstanceId,
        });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId,
            publish: () => undefined,
        });
        const profile = await profiles.create(ctx, {
            email: "steve@example.test",
            name: "Steve Korshakov",
        });
        const session = await store.create(ctx, { cwd: "/tmp/rig-managed-project-api" });
        const project = (await store.getProject(ctx, session.snapshot().projectId!))!;
        await store.registerSpecialSecret(ctx, { kind: "github", token: "api-token" });
        const create = vi.spyOn(store, "createRemoteProject").mockResolvedValue(project);
        const { close, socketPath } = await startServer({ profiles, store });
        const request = {
            identity: profile.id,
            name: "Managed API",
            projectId: createId(),
            secret: { kind: "github" as const },
            source: { kind: "github" as const, repository: "slopus/rig" },
        };
        try {
            const response = await requestRawJson(socketPath, "/projects/clone", {
                body: JSON.stringify(request),
                headers: { "x-rig-mutation-id": "clone-mutation" },
                method: "POST",
            });

            expect(response.statusCode).toBe(202);
            expect(JSON.parse(response.body)).toEqual({ project });
            expect(response.body).not.toContain("api-token");
            expect(create).toHaveBeenCalledWith(expect.anything(), request, {
                createdBy: { instanceId: localInstanceId, profileId: profile.id },
                githubToken: "api-token",
                mutationId: "clone-mutation",
            });

            const injected = await requestRawJson(socketPath, "/projects/clone", {
                body: JSON.stringify({
                    ...request,
                    temporaryGitSecret: { kind: "github", token: "injected-token" },
                }),
                method: "POST",
            });
            expect(injected.statusCode).toBe(400);
            expect(injected.body).not.toContain("injected-token");
            expect(create).toHaveBeenCalledTimes(1);
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("lists, renames, snapshots, and updates project avatars", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const { client, close } = await startServer({ store });
        try {
            const first = await client.createSession({ cwd: "/tmp/rig-project-api/one/project" });
            const second = await client.createSession({ cwd: "/tmp/rig-project-api/two/project" });
            const firstProjectId = first.session.projectId!;
            const secondProjectId = second.session.projectId!;
            const firstProject = await client.renameProject(
                firstProjectId,
                { name: "Shared" },
                (await store.getProject(ctx, firstProjectId))?.version ?? 1,
            );
            const secondProject = await client.renameProject(
                secondProjectId,
                { name: "Shared" },
                (await store.getProject(ctx, secondProjectId))?.version ?? 1,
            );
            expect(firstProject.project.name).toBe("Shared");
            expect(secondProject.project.name).toBe("Shared (2)");
            expect((await client.listProjects()).projects.map((project) => project.id)).toEqual([
                secondProjectId,
                firstProjectId,
            ]);
            const configuredProject = await client.updateProjectSettings(
                firstProjectId,
                {
                    defaultWorkspaceCompute: {
                        image: "rig-dev:latest",
                        type: "docker",
                    },
                    mutationId: "project-settings-1",
                },
                firstProject.project.version,
            );
            expect(configuredProject.project.settings).toEqual({
                defaultWorkspaceCompute: {
                    generation: 1,
                    image: "rig-dev:latest",
                    type: "docker",
                },
            });
            await expect(
                client.updateProjectSettings(
                    firstProjectId,
                    {
                        defaultWorkspaceCompute: {
                            image: "rig-dev:latest",
                            type: "docker",
                        },
                        mutationId: "project-settings-1",
                    },
                    firstProject.project.version,
                ),
            ).resolves.toEqual(configuredProject);
            const reorderedProject = await client.reorderProject(
                firstProjectId,
                { afterId: null },
                configuredProject.project.version,
            );
            expect((await client.listProjects()).projects.map((project) => project.id)).toEqual([
                firstProjectId,
                secondProjectId,
            ]);

            const laterChat = await client.createSession({
                cwd: "/tmp/rig-project-api/one/project",
            });
            expect(laterChat.session.environment).toMatchObject({
                reference: "rig-dev:latest",
                type: "docker",
            });
            expect(
                (await client.listSessions({ archived: "all" })).sessions
                    .filter((session) => session.projectId === first.session.projectId)
                    .map((session) => session.id),
            ).toEqual([first.session.id, laterChat.session.id]);
            const reorderedChat = await client.reorderSession(laterChat.session.id, {
                afterId: null,
            });
            expect(reorderedChat.session.orderKey).toBeDefined();
            expect(first.session.orderKey).toBeDefined();
            expect(reorderedChat.session.orderKey! < first.session.orderKey!).toBe(true);
            expect(
                (await client.listSessions({ archived: "all" })).sessions
                    .filter((session) => session.projectId === first.session.projectId)
                    .map((session) => session.id),
            ).toEqual([laterChat.session.id, first.session.id]);

            await expect(client.catalog()).resolves.toMatchObject({
                cursor: expect.any(String),
                projects: expect.arrayContaining([
                    expect.objectContaining({ id: first.session.projectId }),
                    expect.objectContaining({ id: second.session.projectId }),
                ]),
                sessions: expect.arrayContaining([
                    expect.objectContaining({
                        id: first.session.id,
                        projectId: first.session.projectId,
                    }),
                ]),
                sessionsComplete: true,
            });

            const png = await sharp({
                create: {
                    background: { alpha: 1, b: 40, g: 80, r: 120 },
                    channels: 4,
                    height: 32,
                    width: 32,
                },
            })
                .png()
                .toBuffer();
            const withAvatar = await client.uploadProjectAvatar(
                firstProjectId,
                png,
                "image/png",
                reorderedProject.project.version,
            );
            expect(withAvatar.project.avatar).toMatchObject({
                hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                mediaType: "image/webp",
                source: "user",
            });
            await expect(
                client.uploadProjectAvatar(
                    firstProjectId,
                    png,
                    "image/png",
                    reorderedProject.project.version,
                ),
            ).rejects.toThrow("changed");
            expect(
                (await client.clearProjectAvatar(firstProjectId)).project.avatar,
            ).toBeUndefined();
        } finally {
            await close();
        }
    });

    it("shares versioned project compute by default while preserving session overrides", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const { client, close } = await startServer({ store });
        const cwd = "/tmp/rig-project-compute/project";
        try {
            const seed = await client.createSession({ cwd });
            const project = (await store.getProject(ctx, seed.session.projectId!))!;
            const dockerProject = await client.updateProjectSettings(
                project.id,
                {
                    defaultWorkspaceCompute: {
                        image: "rig-dev:latest",
                        type: "docker",
                    },
                    mutationId: "compute-docker-1",
                },
                project.version,
            );

            const firstDocker = await client.createSession({ cwd });
            const secondDocker = await client.createSession({ cwd });
            const sharedName = (await store.get(ctx, firstDocker.session.id))?.requestForSubagent()
                .docker?.name;
            expect(sharedName).toBe(`rig-project-${project.id}-1`);
            expect(
                (await store.get(ctx, secondDocker.session.id))?.requestForSubagent().docker?.name,
            ).toBe(sharedName);

            const explicitLocal = await client.createSession({ cwd, local: true });
            expect(explicitLocal.session.environment).toEqual({ type: "local" });
            const explicitDocker = await client.createSession({
                cwd,
                docker: {
                    image: "session-only:latest",
                    workingDirectory: "/workspace",
                },
            });
            expect(
                (await store.get(ctx, explicitDocker.session.id))?.requestForSubagent().docker
                    ?.name,
            ).toBe(`rig-${explicitDocker.session.id}`);

            const localProject = await client.updateProjectSettings(
                project.id,
                {
                    defaultWorkspaceCompute: { type: "local" },
                    mutationId: "compute-local-2",
                },
                dockerProject.project.version,
            );
            const defaultLocal = await client.createSession({ cwd });
            expect(defaultLocal.session.environment).toEqual({ type: "local" });
            expect(
                (await store.get(ctx, firstDocker.session.id))?.requestForSubagent().docker?.name,
            ).toBe(sharedName);

            await client.updateProjectSettings(
                project.id,
                {
                    defaultWorkspaceCompute: {
                        image: "rig-dev:latest",
                        type: "docker",
                    },
                    mutationId: "compute-docker-3",
                },
                localProject.project.version,
            );
            const nextDocker = await client.createSession({ cwd });
            expect(
                (await store.get(ctx, nextDocker.session.id))?.requestForSubagent().docker?.name,
            ).toBe(`rig-project-${project.id}-3`);
        } finally {
            await close();
        }
    });

    it("broadcasts one fully configured message to every primary session", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const first = await store.create(ctx, { cwd: "/tmp/broadcast-first" });
        const second = await store.create(ctx, { cwd: "/tmp/broadcast-second" });
        const firstSubmit = vi.spyOn(first, "submit");
        const secondSubmit = vi.spyOn(second, "submit");
        const { client, close } = await startServer({ store });
        try {
            const request = {
                all: true,
                externalTools: [
                    {
                        description: "Look up a ticket.",
                        name: "lookup_ticket",
                        parameters: { type: "object" },
                    },
                ],
                skills: [
                    {
                        description: "Check a release outside Rig.",
                        location: "durable",
                        name: "release-check",
                    },
                ],
                systemPrompt: "Exact broadcast prompt.",
                text: "Check the queue.",
            } as const;
            const response = await client.broadcastMessage(request);

            expect(response.submissions.map((submission) => submission.sessionId).sort()).toEqual(
                [first.id, second.id].sort(),
            );
            const { all: _all, ...message } = request;
            expect(firstSubmit).toHaveBeenCalledWith(expect.anything(), message);
            expect(secondSubmit).toHaveBeenCalledWith(expect.anything(), message);
            await expect(
                client.broadcastMessage({
                    sessionIds: [first.id, first.id],
                    text: "Do not submit this twice.",
                }),
            ).rejects.toThrow("unique");
            expect(firstSubmit).toHaveBeenCalledTimes(1);
        } finally {
            await first.abort(ctx);
            await second.abort(ctx);
            await close();
        }
    });

    it("lists and idempotently resolves external function calls through the integration API", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const state = pausedGoalState();
        await store.saveSession(ctx, state);
        await store.upsertExternalToolCall(ctx, {
            arguments: { ticket: 42 },
            batchId: "batch-1",
            consumed: false,
            createdAt: 100,
            definition: {
                description: "Look up a ticket.",
                name: "lookup_ticket",
                parameters: { type: "object" },
            },
            id: "external-call-1",
            runId: "run-1",
            sessionId: state.id,
            status: "pending",
            toolCallId: "provider-call-1",
            toolCallIndex: 0,
        });
        const { client, close } = await startServer({ store });
        try {
            await expect(client.listPendingExternalToolCalls()).resolves.toMatchObject({
                calls: [{ id: "external-call-1", sessionId: state.id }],
            });
            await expect(client.listExternalToolCalls(state.id)).resolves.toMatchObject({
                calls: [{ id: "external-call-1", status: "pending" }],
            });
            await expect(
                client.resolveExternalToolCall(state.id, "external-call-1", {
                    output: "x".repeat(1_048_576),
                    status: "completed",
                }),
            ).rejects.toThrow("allowed limit");
            await expect(
                client.resolveExternalToolCall(state.id, "external-call-1", {
                    output: { state: "resolved" },
                    status: "completed",
                }),
            ).resolves.toMatchObject({ accepted: true, call: { status: "completed" } });
            await expect(
                client.resolveExternalToolCall(state.id, "external-call-1", {
                    output: { state: "resolved" },
                    status: "completed",
                }),
            ).resolves.toMatchObject({ accepted: false });
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("serves current quota from the daemon-owned quota service", async () => {
        const sessionQuota = {
            capturedAt: 10,
            source: "codex" as const,
            windows: {
                fiveHour: {
                    capturedAt: 10,
                    resetsAt: 20,
                    status: "available" as const,
                    usedPercent: 32,
                },
                weekly: { status: "unavailable" as const },
            },
        };
        const getProviderQuota = vi.fn(async () => sessionQuota);
        const { client, close } = await startServer({ getProviderQuota });
        try {
            const created = await client.createSession({ cwd: "/tmp/current-provider-quota" });

            await expect(client.getCurrentProviderQuota(created.session.id)).resolves.toEqual({
                currentProviderId: "codex",
                quota: sessionQuota,
            });
            expect(getProviderQuota).toHaveBeenCalledWith("codex", created.session.ownerInstanceId);
        } finally {
            await close();
        }
    });

    it("routes current quota through the selected credential binding", async () => {
        const localInstanceId = createId();
        const credentialOwnerInstanceId = createId();
        const providerId = `codex@${credentialOwnerInstanceId}`;
        const credential = {
            bindingId: `${credentialOwnerInstanceId}:codex`,
            ownerInstanceId: credentialOwnerInstanceId,
            ownerName: "Shared Rig",
            relation: "extra" as const,
            sourceProviderId: "codex",
            visibility: "shared" as const,
        };
        const modelCatalog = {
            defaultModelId: modelOpenaiGpt55.id,
            defaultProviderId: providerId,
            models: [modelOpenaiGpt55],
            providers: [
                {
                    credential,
                    models: [modelOpenaiGpt55],
                    providerId,
                    providerType: "codex" as const,
                },
            ],
        };
        const store = await InMemorySessionStore.open(ctx, {
            localInstanceId,
            modelCatalog,
        });
        const getProviderQuota = vi.fn(async () => undefined);
        const { client, close } = await startServer({ getProviderQuota, store });
        try {
            const created = await client.createSession({ cwd: "/tmp/binding-provider-quota" });

            await client.getCurrentProviderQuota(created.session.id);

            expect(getProviderQuota).toHaveBeenCalledWith(providerId, localInstanceId, credential);

            getProviderQuota.mockClear();
            await client.getSessionUsage(created.session.id);
            expect(getProviderQuota).toHaveBeenCalledWith(providerId, localInstanceId, credential);
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("unions session and project attachment sources and detaches them independently", async () => {
        const store = await InMemorySessionStore.open(ctx);
        await store.registerSecret(ctx, {
            description: "Service API credentials",
            environment: { SERVICE_TOKEN: "secret-value" },
            id: "service",
        });
        await store.registerSpecialSecret(ctx, { kind: "github", token: "native-token" });
        const { client, close } = await startServer({ store });
        try {
            const created = await client.createSession({ cwd: "/tmp/secret-project" });
            expect(created.session.secretIds).toEqual([]);

            await expect(client.attachSecret(created.session.id, "missing")).rejects.toThrow(
                "not registered",
            );
            await expect(client.attachSecret(created.session.id, "github")).rejects.toThrow(
                "managed by Rig and cannot be attached to agent commands",
            );
            const sessionAttached = await client.attachSecret(created.session.id, "service");
            expect(sessionAttached.session).toMatchObject({
                projectSecretIds: [],
                secretIds: ["service"],
                sessionSecretIds: ["service"],
            });

            const projectAttached = await client.attachSecret(
                created.session.id,
                "service",
                "project",
            );
            expect(projectAttached.session).toMatchObject({
                projectSecretIds: ["service"],
                secretIds: ["service"],
                sessionSecretIds: ["service"],
            });

            const sessionDetached = await client.detachSecret(created.session.id, "service");
            expect(sessionDetached.session).toMatchObject({
                projectSecretIds: ["service"],
                secretIds: ["service"],
                sessionSecretIds: [],
            });

            const projectDetached = await client.detachSecret(
                created.session.id,
                "service",
                "project",
            );
            expect(projectDetached.session).toMatchObject({
                projectSecretIds: [],
                secretIds: [],
                sessionSecretIds: [],
            });
            expect(
                (await store.get(ctx, created.session.id))?.events
                    .since(undefined)
                    ?.filter((event) => event.type === "secrets_changed")
                    .at(-1),
            ).toMatchObject({
                data: { projectSecretIds: [], secretIds: [], sessionSecretIds: [] },
            });
        } finally {
            await close();
        }
    });

    it("serves durable attributed usage and current-provider quota", async () => {
        const getProviderQuota = vi.fn(async (providerId: string) =>
            providerId === "codex"
                ? ({
                      capturedAt: 10,
                      source: "codex" as const,
                      windows: {
                          fiveHour: {
                              capturedAt: 10,
                              resetsAt: 20,
                              status: "available" as const,
                              usedPercent: 32,
                          },
                          weekly: { status: "unavailable" as const },
                      },
                  } as const)
                : undefined,
        );
        const { client, close, store } = await startServer({ getProviderQuota });
        try {
            const created = await client.createSession({ cwd: "/tmp/usage-project" });
            const session = await store.get(ctx, created.session.id);
            if (session === undefined) throw new Error("Expected the created session.");
            await session.events.append(ctx, {
                createdAt: 2,
                data: {
                    message: {
                        blocks: [{ text: "done", type: "text" }],
                        contextTokens: 19,
                        id: "assistant-1",
                        providerId: "codex",
                        requestedModelId: created.session.modelId,
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
                    runId: "run-1",
                },
                id: createEventIdFactory()(),
                sessionId: created.session.id,
                type: "agent_message",
            });

            await expect(client.getSessionUsage(created.session.id)).resolves.toMatchObject({
                context: { approximate: false, totalTokens: 19 },
                currentProviderId: "codex",
                groups: [
                    {
                        kind: "attributed",
                        modelId: created.session.modelId,
                        providerId: "codex",
                        usage: { input: 10, output: 2, totalTokens: 19 },
                    },
                ],
                quotas: [
                    {
                        providerId: "codex",
                        quota: {
                            windows: {
                                fiveHour: { status: "available", usedPercent: 32 },
                            },
                        },
                    },
                ],
            });
            expect(getProviderQuota).toHaveBeenCalledWith("codex", created.session.ownerInstanceId);
        } finally {
            await close();
        }
    });

    it("applies project attachments to existing and future sessions in the same cwd only", async () => {
        const store = await InMemorySessionStore.open(ctx);
        await store.registerSecret(ctx, {
            description: "Shared project credentials",
            environment: { PROJECT_TOKEN: "project-value" },
            id: "project-service",
        });
        const { client, close } = await startServer({ store });
        try {
            const first = await client.createSession({ cwd: "/tmp/shared-secret-project" });
            const existing = await client.createSession({ cwd: "/tmp/shared-secret-project/." });
            const isolated = await client.createSession({ cwd: "/tmp/isolated-secret-project" });

            await client.attachSecret(first.session.id, "project-service", "project");

            expect((await store.get(ctx, first.session.id))?.snapshot().projectSecretIds).toEqual([
                "project-service",
            ]);
            expect(
                (await store.get(ctx, existing.session.id))?.snapshot().projectSecretIds,
            ).toEqual(["project-service"]);
            expect((await store.get(ctx, isolated.session.id))?.snapshot().secretIds).toEqual([]);

            const future = await client.createSession({ cwd: "/tmp/shared-secret-project" });
            const isolatedFuture = await client.createSession({
                cwd: "/tmp/isolated-secret-project",
            });
            expect(future.session).toMatchObject({
                projectSecretIds: ["project-service"],
                secretIds: ["project-service"],
                sessionSecretIds: [],
            });
            expect(isolatedFuture.session.secretIds).toEqual([]);

            await client.detachSecret(existing.session.id, "project-service", "project");
            expect((await store.get(ctx, first.session.id))?.snapshot().secretIds).toEqual([]);
            expect((await store.get(ctx, existing.session.id))?.snapshot().secretIds).toEqual([]);
            expect((await store.get(ctx, future.session.id))?.snapshot().secretIds).toEqual([]);
        } finally {
            await close();
        }
    });

    it("registers and lists bundle metadata without returning secret values", async () => {
        const { client, close } = await startServer();
        try {
            const registered = await client.registerSecret({
                description: "Service API credentials",
                environment: {
                    SERVICE_REGION: "never-return-region",
                    SERVICE_TOKEN: "never-return-token",
                },
                id: "service",
            });
            expect(registered.secret).toEqual({
                description: "Service API credentials",
                environmentVariables: ["SERVICE_REGION", "SERVICE_TOKEN"],
                id: "service",
            });

            const listed = await client.listSecrets();
            expect(listed.secrets).toEqual([registered.secret]);
            expect(JSON.stringify({ listed, registered })).not.toContain("never-return-region");
            expect(JSON.stringify({ listed, registered })).not.toContain("never-return-token");
        } finally {
            await close();
        }
    });

    it("changes, adds, and removes selected secret fields without replacing the bundle", async () => {
        const { client, close } = await startServer();
        try {
            await client.registerSecret({
                description: "Service API credentials",
                environment: {
                    KEEP: "unchanged",
                    REMOVE: "remove-me",
                    ROTATE: "old-value",
                },
                id: "service",
            });

            await expect(
                client.updateSecret("service", {
                    description: "Updated API credentials",
                    environment: {
                        ADDED: "new-value",
                        REMOVE: null,
                        ROTATE: "new-value",
                    },
                }),
            ).resolves.toEqual({
                secret: {
                    description: "Updated API credentials",
                    environmentVariables: ["ADDED", "KEEP", "ROTATE"],
                    id: "service",
                },
            });
            expect(await client.listSecrets()).toEqual({
                secrets: [
                    {
                        description: "Updated API credentials",
                        environmentVariables: ["ADDED", "KEEP", "ROTATE"],
                        id: "service",
                    },
                ],
            });
            await expect(
                client.updateSecret("missing", { description: "Missing" }),
            ).rejects.toMatchObject({ statusCode: 404 });
            await expect(client.updateSecret("service", {})).rejects.toMatchObject({
                statusCode: 400,
            });
        } finally {
            await close();
        }
    });

    it("does not reflect malformed secret registration values in JSON errors", async () => {
        const { close, socketPath } = await startServer();
        const secretValue = "malformed-value-must-not-return";
        try {
            const response = await requestRawJson(socketPath, "/secrets", {
                body: `{"id":"service","environment":{"TOKEN":"${secretValue}"}`,
                method: "POST",
            });

            expect(response.statusCode).toBe(400);
            expect(response.body).toContain("Request body must be valid JSON.");
            expect(response.body).not.toContain(secretValue);
        } finally {
            await close();
        }
    });

    it("removes a registration and clears both attachment sources", async () => {
        const { client, close, store } = await startServer();
        try {
            await client.registerSecret({
                description: "Disposable credentials",
                environment: { DISPOSABLE_TOKEN: "never-return-this" },
                id: "disposable",
            });
            const created = await client.createSession({ cwd: "/tmp/removable-secret-project" });
            await client.attachSecret(created.session.id, "disposable", "session");
            await client.attachSecret(created.session.id, "disposable", "project");

            await expect(client.unregisterSecret("disposable")).resolves.toEqual({
                removed: true,
            });
            expect(await client.listSecrets()).toEqual({ secrets: [] });
            expect((await store.get(ctx, created.session.id))?.snapshot()).toMatchObject({
                projectSecretIds: [],
                secretIds: [],
                sessionSecretIds: [],
            });
            await expect(client.unregisterSecret("disposable")).resolves.toEqual({
                removed: false,
            });
            await expect(client.attachSecret(created.session.id, "disposable")).rejects.toThrow(
                "not registered",
            );
        } finally {
            await close();
        }
    });

    it("returns independent current quotas for every used provider", async () => {
        const quotaFor = (providerId: string): ProviderQuota => ({
            capturedAt: 10,
            source: providerId === "codex" ? "codex" : "claude",
            windows: {
                fiveHour: {
                    capturedAt: 10,
                    resetsAt: 100,
                    status: "available",
                    usedPercent: providerId === "codex" ? 30 : 40,
                },
                weekly: {
                    capturedAt: 10,
                    resetsAt: 200,
                    status: "available",
                    usedPercent: providerId === "codex" ? 10 : 20,
                },
            },
        });
        const getProviderQuota = vi.fn(
            async (providerId: string): Promise<ProviderQuota> => quotaFor(providerId),
        );
        const { client, close, store } = await startServer({ getProviderQuota });
        try {
            const created = await client.createSession({ cwd: "/tmp/multi-provider-usage" });
            const session = await store.get(ctx, created.session.id);
            if (session === undefined) throw new Error("Expected the created session.");
            await session.events.append(ctx, {
                createdAt: 2,
                data: {
                    message: {
                        blocks: [{ text: "Claude turn", type: "text" }],
                        id: "claude-message",
                        providerId: "claude",
                        requestedModelId: "anthropic/sonnet-4-6",
                        role: "agent",
                        usage: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            cost: {
                                cacheRead: 0,
                                cacheWrite: 0,
                                input: 0,
                                output: 0,
                                total: 0,
                            },
                            input: 5,
                            output: 2,
                            totalTokens: 7,
                        },
                    },
                    runId: "claude-run",
                },
                id: createEventIdFactory()(),
                sessionId: created.session.id,
                type: "agent_message",
            });

            const response = await client.getSessionUsage(created.session.id);

            expect(response.quotas).toEqual([
                expect.objectContaining({ providerId: "claude" }),
                expect.objectContaining({ providerId: "codex" }),
            ]);
            expect(getProviderQuota).toHaveBeenCalledWith(
                "claude",
                created.session.ownerInstanceId,
            );
            expect(getProviderQuota).toHaveBeenCalledWith("codex", created.session.ownerInstanceId);
        } finally {
            await close();
        }
    });

    it("records raw user activity without appending a session event", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/activity-project" });
            const session = await store.get(ctx, created.session.id);
            if (session === undefined) throw new Error("Expected the created session.");
            const recordUserActivity = vi.spyOn(session, "recordUserActivity");
            const eventCount = session.events.since(undefined)?.length;

            await expect(client.recordSessionActivity(created.session.id)).resolves.toEqual({
                recorded: true,
            });

            expect(recordUserActivity).toHaveBeenCalledOnce();
            expect(session.events.since(undefined)).toHaveLength(eventCount ?? 0);
        } finally {
            await close();
        }
    });

    it("accepts registered initial attachments and rejects malformed secret ID lists", async () => {
        const store = await InMemorySessionStore.open(ctx);
        await store.registerSecret(ctx, {
            description: "Service API credentials",
            environment: { SERVICE_TOKEN: "secret-value" },
            id: "service",
        });
        const { client, close } = await startServer({ store });
        try {
            const created = await client.createSession({
                cwd: "/tmp/secret-project",
                secretIds: ["service"],
            });
            expect(created.session.secretIds).toEqual(["service"]);

            await expect(
                client.createSession({
                    cwd: "/tmp/malformed-secret-project",
                    secretIds: "service" as unknown as readonly string[],
                }),
            ).rejects.toThrow("Secret IDs must be provided as a list of text IDs.");
            await expect(
                client.createSession({
                    cwd: "/tmp/unknown-secret-project",
                    secretIds: ["missing"],
                }),
            ).rejects.toThrow("not registered");
            expect(await store.list(ctx)).toHaveLength(1);
        } finally {
            await close();
        }
    });

    it("uses Docker defaults unless the new session chooses another environment", async () => {
        const defaultDocker: DockerExecutionConfig = {
            image: "default:local",
            mounts: [{ source: ".", target: "/workspace" }],
            workingDirectory: "/workspace",
        };
        const { client, close, store } = await startServer({ defaultDocker });
        try {
            const configured = await client.createSession({ cwd: "/tmp/default-project" });
            const explicit = await client.createSession({
                cwd: "/tmp/explicit-project",
                docker: { container: "already-running", workingDirectory: "/repo" },
            });
            const local = await client.createSession({
                cwd: "/tmp/local-project",
                local: true,
            });

            expect(
                (await store.get(ctx, configured.session.id))?.requestForSubagent().docker,
            ).toEqual({
                image: "default:local",
                mounts: [
                    { source: "/tmp/default-project", target: "/workspace" },
                    { readOnly: true, source: getBundledDocsRoot(), target: CONTAINER_DOCS_PATH },
                    {
                        readOnly: true,
                        source: getGeneratedDirectory(),
                        target: CONTAINER_GENERATED_PATH,
                    },
                ],
                name: `rig-${configured.session.id}`,
                workingDirectory: "/workspace",
            });
            expect(
                (await store.get(ctx, explicit.session.id))?.requestForSubagent().docker,
            ).toEqual({
                container: "already-running",
                workingDirectory: "/repo",
            });
            expect(
                (await store.get(ctx, local.session.id))?.requestForSubagent().docker,
            ).toBeUndefined();
        } finally {
            await close();
        }
    });

    it("rejects malformed Docker session settings before creating a session", async () => {
        const { client, close, socketPath } = await startServer();
        try {
            await expect(
                client.createSession({
                    cwd: "/tmp/invalid-docker-project",
                    docker: {
                        image: "project:local",
                        workingDirectory: "relative/path",
                    },
                }),
            ).rejects.toThrow("absolute container path");
            const malformed = await requestRawJson(socketPath, "/sessions", {
                body: JSON.stringify({
                    cwd: "/tmp/invalid-docker-project",
                    docker: { image: "project:local", workingDirectory: "relative/path" },
                }),
                method: "POST",
            });
            const conflicting = await requestRawJson(socketPath, "/sessions", {
                body: JSON.stringify({
                    cwd: "/tmp/invalid-docker-project",
                    docker: { image: "project:local", workingDirectory: "/workspace" },
                    local: true,
                }),
                method: "POST",
            });
            expect(malformed.statusCode).toBe(400);
            expect(conflicting.statusCode).toBe(400);
        } finally {
            await close();
        }
    });

    it("exposes the in-memory global event queue when durable retention is disabled", async () => {
        const { client, close } = await startServer();
        try {
            await expect(client.getDaemonConfig()).resolves.toEqual({
                config: {
                    p2p: {
                        name: "Rig",
                        role: "primary",
                    },
                    settings: {
                        inferenceMaxRetries: 10,
                        inferenceFatalRetries: 0,
                        durableGlobalEventQueue: false,
                    },
                },
            });
            await expect(client.getGlobalEvents()).resolves.toEqual({ events: [] });
            await expect(client.health()).resolves.toMatchObject({
                durableGlobalEventQueue: false,
            });
        } finally {
            await close();
        }
    });

    it("starts the daemon inspector through the authenticated local protocol", async () => {
        const onStartInspector = vi.fn(async () => ({
            inspectorUrl: "ws://127.0.0.1:42002/daemon",
        }));
        const { client, close } = await startServer({ onStartInspector });
        try {
            await expect(client.startInspector()).resolves.toEqual({
                inspectorUrl: "ws://127.0.0.1:42002/daemon",
            });
            expect(onStartInspector).toHaveBeenCalledOnce();
        } finally {
            await close();
        }
    });

    it("hot-reloads Happy credentials through the authenticated local protocol", async () => {
        const onReloadHappy = vi.fn(async () => true);
        const { client, close } = await startServer({ onReloadHappy });
        try {
            await expect(client.reloadHappy()).resolves.toEqual({ enabled: true });
            expect(onReloadHappy).toHaveBeenCalledOnce();
        } finally {
            await close();
        }
    });

    it("enables and disables the durable queue through daemon configuration", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const { client, close } = await startServer({
            onDaemonSettingsChange: async (settings) => ({
                inferenceMaxRetries: settings.inferenceMaxRetries,
                inferenceFatalRetries: settings.inferenceFatalRetries,
                globalEventQueue: await store.setDurableGlobalEventQueue(
                    ctx,
                    settings.durableGlobalEventQueue,
                ),
            }),
            store,
        });
        try {
            for (const inferenceMaxRetries of [-1, 1.5, 101]) {
                await expect(
                    client.updateDaemonConfig({
                        settings: {
                            inferenceMaxRetries,
                            inferenceFatalRetries: 0,
                            durableGlobalEventQueue: false,
                        },
                    }),
                ).rejects.toThrow("Daemon settings must use valid values.");
            }
            for (const inferenceFatalRetries of [-1, 1.5, 101]) {
                await expect(
                    client.updateDaemonConfig({
                        settings: {
                            inferenceMaxRetries: 7,
                            inferenceFatalRetries,
                            durableGlobalEventQueue: false,
                        },
                    }),
                ).rejects.toThrow("Daemon settings must use valid values.");
            }
            await expect(
                client.updateDaemonConfig({
                    settings: {
                        inferenceMaxRetries: 7,
                        inferenceFatalRetries: 2,
                        durableGlobalEventQueue: true,
                    },
                }),
            ).resolves.toEqual({
                config: {
                    p2p: {
                        name: "Rig",
                        role: "primary",
                    },
                    settings: {
                        inferenceMaxRetries: 7,
                        inferenceFatalRetries: 2,
                        durableGlobalEventQueue: true,
                    },
                },
            });
            const created = await client.createSession({ cwd: "/tmp/rig-socket-config" });
            // Project initialization lands its events in the background, so the
            // durable log is read until it reflects the finished creation.
            await vi.waitFor(async () => {
                const queued = await client.getGlobalEvents();
                expect(queued.events).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            event: expect.objectContaining({
                                projectId: created.session.projectId!,
                                type: "project_created",
                            }),
                        }),
                        expect.objectContaining({
                            event: expect.objectContaining({
                                sessionId: created.session.id,
                                type: "session_created",
                            }),
                        }),
                    ]),
                );
            });

            await client.updateDaemonConfig({
                settings: {
                    inferenceMaxRetries: 7,
                    inferenceFatalRetries: 2,
                    durableGlobalEventQueue: false,
                },
            });
            await expect(client.getGlobalEvents()).resolves.toEqual({ events: [] });
            await expect(client.getDaemonConfig()).resolves.toEqual({
                config: {
                    p2p: {
                        name: "Rig",
                        role: "primary",
                    },
                    settings: {
                        inferenceMaxRetries: 7,
                        inferenceFatalRetries: 2,
                        durableGlobalEventQueue: false,
                    },
                },
            });

            await client.updateDaemonConfig({
                settings: {
                    inferenceMaxRetries: 7,
                    inferenceFatalRetries: 2,
                    durableGlobalEventQueue: true,
                },
            });
            await expect(client.getGlobalEvents()).resolves.toEqual({ events: [] });
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("accepts UUIDv7 cursors emitted by the default in-memory queue", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const { client, close } = await startServer({
            globalEventQueue: store.globalEventQueue,
            store,
        });
        try {
            await client.createSession({ cwd: "/tmp/rig-default-global-events" });
            const queued = await client.getGlobalEvents();
            const cursor = queued.events[0]?.cursor;
            if (cursor === undefined) throw new Error("Expected a global event cursor.");

            await expect(client.getGlobalEvents(cursor)).resolves.toEqual({
                events: queued.events.slice(1),
            });
            await expect(client.trimGlobalEvents(cursor)).resolves.toEqual({
                through: cursor,
                trimmed: 1,
            });
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("streams and trims durable events across every session", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            durableGlobalEventQueue: true,
        });
        const globalEventQueue = store.globalEventQueue;
        if (globalEventQueue === undefined) throw new Error("Expected the global event queue.");
        const { client, close, socketPath } = await startServer({
            globalEventQueue,
            store,
        });
        try {
            const first = await client.createSession({ cwd: "/tmp/rig-global-events-a" });
            const second = await client.createSession({ cwd: "/tmp/rig-global-events-b" });
            const queued = await client.getGlobalEvents();
            const sessionEntries = queued.events.filter(
                (entry): entry is typeof entry & { event: SessionEvent } =>
                    "sessionId" in entry.event,
            );
            expect(sessionEntries.map((entry) => entry.event.sessionId)).toEqual([
                first.session.id,
                second.session.id,
            ]);
            const firstCursor = sessionEntries[0]?.cursor;
            const secondCursor = sessionEntries[1]?.cursor;
            if (firstCursor === undefined || secondCursor === undefined) {
                throw new Error("Expected global event cursors.");
            }

            const stream = openDurableEventStream(
                socketPath,
                `/events/stream?after=${encodeURIComponent(secondCursor)}`,
            );
            await client.changeEffort(first.session.id, { effort: "high" });
            const streamed = await stream.waitForEvent(
                (event) => "sessionId" in event && event.type === "session_configuration_changed",
            );
            stream.close();
            expect(streamed).toMatchObject({
                sessionId: first.session.id,
                type: "session_configuration_changed",
            });

            await expect(client.trimGlobalEvents(firstCursor)).resolves.toEqual({
                trimmed: queued.events.filter((entry) => entry.cursor <= firstCursor).length,
                through: firstCursor,
            });
            await expect(client.getGlobalEvents("missing.0")).rejects.toThrow(
                "The event cursor must be a UUIDv7 value.",
            );
            const remaining = await client.getGlobalEvents(firstCursor);
            expect(
                remaining.events.find((entry) => "sessionId" in entry.event)?.event,
            ).toMatchObject({ sessionId: second.session.id });
            await expect(client.getEvents(first.session.id)).resolves.toMatchObject({
                events: expect.arrayContaining([
                    expect.objectContaining({ type: "session_created" }),
                ]),
            });
            await expect(client.health()).resolves.toMatchObject({
                durableGlobalEventQueue: true,
            });
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("rejects a transcript limit while catching up from an event cursor", async () => {
        const { client, close, socketPath } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-limited-event-catchup" });
            const response = await requestRawJson(
                socketPath,
                `/sessions/${encodeURIComponent(created.session.id)}/events?after=event-1&message_limit=30`,
                { body: "", method: "GET" },
            );

            expect(response.statusCode).toBe(400);
            expect(response.body).toContain("only supported while loading initial history");
        } finally {
            await close();
        }
    });

    it("requires bearer auth", async () => {
        const { close, socketPath } = await startServer();
        try {
            const client = new ProtocolHttpClient({ socketPath, token: "wrong" });
            await expect(client.health()).rejects.toThrow("Unauthorized");
        } finally {
            await close();
        }
    });

    it("reads and hash-guards project files without inheriting a session permission mode", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-file-"));
        const { client, close, socketPath } = await startServer();
        try {
            const created = await client.createSession({
                cwd: directory,
                permissionMode: "read_only",
            });
            const scope = { projectId: created.session.projectId! };
            const first = await client.writeFile(scope, {
                content: Buffer.from("first").toString("base64"),
                expectedHash: null,
                path: "note.txt",
            });
            await expect(client.readFile(scope, "note.txt")).resolves.toEqual({
                content: Buffer.from("first").toString("base64"),
                hash: first.hash,
            });
            await writeFile(join(directory, "note.txt"), "changed elsewhere");
            await expect(
                client.writeFile(scope, {
                    content: Buffer.from("second").toString("base64"),
                    expectedHash: first.hash,
                    path: "note.txt",
                }),
            ).rejects.toThrow("changed before");

            const current = await client.readFile(scope, "note.txt");
            await expect(
                client.writeFile(scope, {
                    content: Buffer.from("second").toString("base64"),
                    expectedHash: current.hash,
                    path: "note.txt",
                }),
            ).resolves.toMatchObject({ hash: expect.any(String) });
            await expect(
                requestRawJson(
                    socketPath,
                    `/sessions/${encodeURIComponent(created.session.id)}/file?path=note.txt`,
                    { body: "", method: "GET" },
                ),
            ).resolves.toMatchObject({ statusCode: 404 });
        } finally {
            await close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("confines project files to their folder and enforces the file size limit", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-file-boundary-"));
        const outsideDirectory = await mkdtemp(join(tmpdir(), "rig-project-file-outside-"));
        const outsidePath = join(outsideDirectory, "private.txt");
        await writeFile(outsidePath, "private");
        await symlink(outsidePath, join(directory, "outside-link.txt"));
        const oversizedPath = join(directory, "oversized.bin");
        await writeFile(oversizedPath, "");
        await truncate(oversizedPath, 32 * 1024 * 1024 + 1);
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: directory });
            const scope = { projectId: created.session.projectId! };

            await expect(client.readFile(scope, outsidePath)).rejects.toThrow(
                "outside the selected folder",
            );
            await expect(client.readFile(scope, "outside-link.txt")).rejects.toThrow(
                "outside the selected folder",
            );
            await expect(
                client.writeFile(scope, {
                    content: Buffer.from("replacement").toString("base64"),
                    expectedHash: "0".repeat(64),
                    path: "oversized.bin",
                }),
            ).rejects.toThrow("larger than the 32 MB limit");
            await expect(
                client.writeFile(scope, {
                    content: Buffer.from("blocked").toString("base64"),
                    expectedHash: null,
                    path: ".git/config",
                }),
            ).rejects.toThrow("Git control files");
        } finally {
            await close();
            await Promise.all([
                rm(directory, { force: true, recursive: true }),
                rm(outsideDirectory, { force: true, recursive: true }),
            ]);
        }
    });

    it("accesses a workspace before any session is created in it", async () => {
        const projectDirectory = await mkdtemp(join(tmpdir(), "rig-workspace-files-project-"));
        const workspacesDirectory = await mkdtemp(join(tmpdir(), "rig-workspace-files-root-"));
        await execFile("git", ["-C", projectDirectory, "init"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.email", "rig@example.test"]);
        await execFile("git", ["-C", projectDirectory, "config", "user.name", "Rig Test"]);
        await writeFile(join(projectDirectory, "README.md"), "fixture\n");
        await execFile("git", ["-C", projectDirectory, "add", "README.md"]);
        await execFile("git", ["-C", projectDirectory, "commit", "-m", "Initial"]);
        const search = vi.fn(async () => [{ fileName: "note.txt", path: "note.txt" }]);
        const store = await InMemorySessionStore.open(ctx, {
            workspacesDirectory,
        });
        const { client, close } = await startServer({
            fileSearchService: { close: vi.fn(), search },
            store,
        });
        try {
            const rootSession = await client.createSession({ cwd: projectDirectory });
            const rootProjectId = rootSession.session.projectId!;
            const created = await client.createProjectWorkspace(rootProjectId, {
                baseRef: "HEAD",
                name: "No chat yet",
            });
            let workspace = created.workspace;
            await vi.waitFor(
                async () => {
                    const current = (
                        await client.listProjectWorkspaces(rootProjectId)
                    ).workspaces.find((candidate) => candidate.id === created.workspace.id);
                    if (current === undefined) throw new Error("Expected the workspace.");
                    workspace = current;
                    expect(current.status).toBe("ready");
                },
                { interval: 20, timeout: 5_000 },
            );
            expect(
                (await store.list(ctx)).some((session) => session.workspaceId === workspace.id),
            ).toBe(false);

            const scope = {
                projectId: rootProjectId,
                workspaceId: workspace.id,
            };
            const written = await client.writeFile(scope, {
                content: Buffer.from("workspace file").toString("base64"),
                expectedHash: null,
                path: "note.txt",
            });
            await expect(client.readFile(scope, "note.txt")).resolves.toEqual({
                content: Buffer.from("workspace file").toString("base64"),
                hash: written.hash,
            });
            await expect(client.searchFiles(scope, "note")).resolves.toEqual({
                files: [{ fileName: "note.txt", path: "note.txt" }],
            });
            expect(search).toHaveBeenCalledWith(workspace.path, "note", 20);
        } finally {
            await close();
            await store.close(ctx);
            await rm(projectDirectory, removeFixtureOptions);
            await rm(workspacesDirectory, removeFixtureOptions);
        }
    });

    it("serves daemon readiness and model catalog", async () => {
        const { client, close } = await startServer();
        try {
            const health = await client.health();
            const models = await client.models();

            expect(health).toMatchObject({
                healthy: true,
                identity: { version: expect.any(String) },
                ready: true,
                status: "ready",
            });
            if (health.status !== "ready") throw new Error("Expected the daemon to be ready.");
            expect(health.catalog.models.map((model) => model.id)).toContain(
                modelOpenaiGpt56Sol.id,
            );
            expect(models.catalog.models.map((model) => model.id)).toContain(
                modelOpenaiGpt56Sol.id,
            );
        } finally {
            await close();
        }
    });

    it("serves authenticated installation identity without opening a stream", async () => {
        const { close, socketPath, store } = await startServer();
        try {
            expect(store.dataSchemaVersion).toBe(CURRENT_SESSION_DATABASE_VERSION);
            const response = await requestRawJson(socketPath, "/installation", {
                body: "",
                method: "GET",
            });
            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body)).toEqual({
                daemonProtocolVersion: expect.any(Number),
                daemonVersion: expect.any(String),
                data: {
                    epoch: store.dataEpoch,
                    schemaCompatibility: "current",
                    schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
                    status: "initialized",
                },
                formatVersion: 1,
                source: "daemon",
            });

            const unauthorized = await requestRawJson(socketPath, "/installation", {
                body: "",
                headers: { authorization: "Bearer wrong" },
                method: "GET",
            });
            expect(unauthorized.statusCode).toBe(401);
        } finally {
            await close();
        }
    });

    it("changes session effort through a dedicated endpoint", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({
                cwd: "/tmp/rig-protocol-test",
                modelId: modelOpenaiGpt56Sol.id,
            });

            const changed = await client.changeEffort(created.session.id, { effort: "high" });
            const events = await client.getEvents(created.session.id, created.session.lastEventId);

            expect(changed.session.effort).toBe("high");
            expect(events.events.at(-1)).toMatchObject({
                data: {
                    changed: ["effort"],
                    effort: "high",
                    modelId: modelOpenaiGpt56Sol.id,
                },
                type: "session_configuration_changed",
            });
        } finally {
            await close();
        }
    });

    it("creates, updates, and clears an appended system prompt", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({
                appendSystemPrompt: "Created API instructions.",
                cwd: "/tmp/rig-protocol-test",
            });

            expect(created.session.appendSystemPrompt).toBe("Created API instructions.");
            expect(created.session.snapshot.appendSystemPrompt).toBe("Created API instructions.");

            await expect(
                client.createSession({
                    appendSystemPrompt: 42 as unknown as string,
                    cwd: "/tmp/rig-invalid-prompt-test",
                }),
            ).rejects.toThrow("The appended system prompt must be text.");

            const updated = await client.updateSession(created.session.id, {
                appendSystemPrompt: "Updated API instructions.",
            });
            const events = await client.getEvents(created.session.id, created.session.lastEventId);

            expect(updated.session.appendSystemPrompt).toBe("Updated API instructions.");
            expect(updated.session.snapshot.appendSystemPrompt).toBe("Updated API instructions.");
            expect(events.events.at(-1)).toMatchObject({
                data: {
                    session: { appendSystemPrompt: "Updated API instructions." },
                },
                type: "session_updated",
            });

            const cleared = await client.updateSession(created.session.id, {
                appendSystemPrompt: null,
            });
            expect(cleared.session.appendSystemPrompt).toBeUndefined();
            expect(cleared.session.snapshot.appendSystemPrompt).toBeUndefined();

            await expect(
                client.updateSession(created.session.id, {
                    appendSystemPrompt: 42 as unknown as string,
                }),
            ).rejects.toThrow("The appended system prompt must be text or null.");
        } finally {
            await close();
        }
    });

    it("archives sessions as an idempotent listing state and unarchives on user activity", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            durableGlobalEventQueue: true,
        });
        const globalEventQueue = store.globalEventQueue;
        if (globalEventQueue === undefined) throw new Error("Expected the global event queue.");
        const { client, close } = await startServer({
            globalEventQueue,
            store,
        });
        try {
            const kept = await client.createSession({ cwd: "/tmp/rig-kept-session" });
            const hidden = await client.createSession({ cwd: "/tmp/rig-hidden-session" });

            const archived = await client.archiveSession(hidden.session.id);
            const archivedAgain = await client.archiveSession(hidden.session.id);

            expect(archived.session).toMatchObject({
                archived: true,
                id: hidden.session.id,
                status: "idle",
            });
            expect(archivedAgain).toEqual(archived);
            expect((await client.listSessions()).sessions.map((session) => session.id)).toEqual([
                kept.session.id,
            ]);
            expect(
                (await client.listSessions({ archived: "all" })).sessions.map(
                    (session) => session.id,
                ),
            ).toEqual([hidden.session.id, kept.session.id]);
            expect(await client.getSession(hidden.session.id)).toMatchObject({
                session: { archived: true, id: hidden.session.id },
            });
            expect(
                (await store.globalEventQueue?.list(ctx))?.filter(
                    (entry) => entry.event.type === "session_archived",
                ),
            ).toHaveLength(1);

            const unarchived = await client.unarchiveSession(hidden.session.id);
            expect(unarchived.session.archived).toBe(false);
            expect((await client.listSessions()).sessions.map((session) => session.id)).toEqual([
                hidden.session.id,
                kept.session.id,
            ]);

            await client.archiveSession(hidden.session.id);
            await client.submitMessage(hidden.session.id, {
                clientSubmissionId: "resume-hidden-session",
                text: "Resume this session.",
            });
            expect((await client.getSession(hidden.session.id)).session.archived).toBe(false);

            await client.archiveSession(hidden.session.id);
            await client.submitMessage(hidden.session.id, {
                clientSubmissionId: "resume-hidden-session",
                text: "Resume this session.",
            });
            expect((await client.getSession(hidden.session.id)).session.archived).toBe(true);
        } finally {
            await close();
            await store.prepareForShutdown(ctx, "shutdown");
            await store.close(ctx);
        }
    });

    it("changes the service tier through a dedicated endpoint", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({
                cwd: "/tmp/rig-protocol-test",
                modelId: modelOpenaiGpt55.id,
            });

            const changed = await client.changeServiceTier(created.session.id, {
                serviceTier: "fast",
            });
            const events = await client.getEvents(created.session.id, created.session.lastEventId);

            expect(changed.session.serviceTier).toBe("fast");
            expect(changed.session.snapshot.serviceTier).toBe("fast");
            expect(events.events.at(-1)).toMatchObject({
                data: { changed: ["serviceTier"], serviceTier: "fast" },
                type: "session_configuration_changed",
            });
        } finally {
            await close();
        }
    });

    it("reports where the user is and lets a client switch it", async () => {
        const { client, close } = await startServer();
        try {
            const initial = await client.getPresence();

            expect(initial.presence.presence.id).toBe("online");
            expect(initial.presence.presences.map((presence) => presence.id)).toEqual([
                "online",
                "away",
            ]);
            expect((await client.catalog()).presence.presence.id).toBe("online");

            const changed = await client.setPresence({ presenceId: "away" });

            expect(changed.presence.presence.title).toBe("Away");
            expect((await client.catalog()).presence.presence.id).toBe("away");
            await expect(client.setPresence({ presenceId: "sleeping" })).rejects.toThrow(
                /There is no presence called/u,
            );
        } finally {
            await close();
        }
    });

    it("changes session permissions through a dedicated endpoint", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });

            const changed = await client.changePermissionMode(created.session.id, {
                permissionMode: "auto",
            });
            const events = await client.getEvents(created.session.id, created.session.lastEventId);

            expect(changed.session.permissionMode).toBe("auto");
            expect(events.events).toContainEqual(
                expect.objectContaining({
                    data: { permissionMode: "auto" },
                    type: "permission_mode_changed",
                }),
            );
        } finally {
            await close();
        }
    });

    it("stops a running workflow through the protocol", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            expect(session).toBeDefined();
            const run = session?.launchWorkflow(ctx, {
                code: "42",
                description: "Wait until stopped",
                execute: ({ signal }) =>
                    new Promise<never>((_resolve, reject) => {
                        signal.addEventListener(
                            "abort",
                            () => reject(new Error("Cancelled by the monitor.")),
                            { once: true },
                        );
                    }),
                name: "monitor-stop",
            });
            expect(run).toBeDefined();
            if (run === undefined) throw new Error("Expected a workflow run.");

            await expect(client.stopWorkflow(created.session.id, run.runId)).resolves.toEqual({
                workflow: expect.objectContaining({
                    error: "The workflow was stopped.",
                    runId: run.runId,
                    status: "stopped",
                }),
            });
            await session?.abort(ctx);
        } finally {
            await close();
        }
    });

    it("stops background terminals through a dedicated endpoint", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            expect(session).toBeDefined();
            const stopBackgroundProcesses = vi
                .spyOn(session!, "stopBackgroundProcesses")
                .mockResolvedValueOnce(2);

            await expect(client.stopBackgroundProcesses(created.session.id)).resolves.toEqual({
                stoppedProcesses: 2,
            });
            expect(stopBackgroundProcesses).toHaveBeenCalledOnce();
            await expect(client.health()).resolves.toMatchObject({ healthy: true });
        } finally {
            await close();
        }
    });

    it("validates and idempotently stores context without a run lifecycle", async () => {
        const { client, close, socketPath, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-context-route" });
            const first = await client.submitContextMessage(created.session.id, {
                clientSubmissionId: "context-route-note",
                text: "Use the blue database.",
            });
            const repeated = await client.submitContextMessage(created.session.id, {
                clientSubmissionId: "context-route-note",
                text: "Use the blue database.",
            });

            expect(repeated).toEqual(first);
            expect(first).toMatchObject({
                delivery: "context",
                messageId: "context-route-note",
            });
            expect(
                (await store.get(ctx, created.session.id))?.events
                    .since(undefined)
                    ?.filter((event) => event.type === "run_started"),
            ).toEqual([]);
            const rejected = await requestRawJson(
                socketPath,
                `/sessions/${created.session.id}/context`,
                {
                    body: JSON.stringify({
                        modelId: "openai/another-model",
                        text: "Do not apply settings.",
                    }),
                    method: "POST",
                },
            );
            expect(rejected.statusCode).toBe(400);
            expect(rejected.body).toContain("run settings are not allowed");
        } finally {
            await close();
        }
    });

    it("queues steering as a new run when the session has no active run", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });

            const accepted = await client.steerMessage(created.session.id, {
                clientSubmissionId: "queued-after-finish",
                expectedRunId: "finished-run",
                text: "Continue in a new turn.",
            });

            expect(accepted).toMatchObject({ delivery: "run" });
            expect(
                (await store.get(ctx, created.session.id))?.events
                    .since(undefined)
                    ?.find((event) => event.id === accepted.eventId),
            ).toMatchObject({
                data: {
                    delivery: "run",
                    message: { id: "queued-after-finish" },
                    runId: accepted.runId,
                },
                type: "message_submitted",
            });
        } finally {
            await close();
        }
    });

    it("rejects message and steering requests without text", async () => {
        const { client, close, socketPath, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            if (session === undefined) throw new Error("Expected the created session.");
            const submit = vi.spyOn(session, "submit");
            const steer = vi.spyOn(session, "steer");

            for (const route of ["messages", "steer"]) {
                const response = await requestRawJson(
                    socketPath,
                    `/sessions/${created.session.id}/${route}`,
                    { body: "{}", method: "POST" },
                );

                expect(response.statusCode).toBe(400);
                expect(response.body).toContain("Message text must be text.");
            }
            expect(submit).not.toHaveBeenCalled();
            expect(steer).not.toHaveBeenCalled();
        } finally {
            await close();
        }
    });

    it("rejects non-object shell command requests", async () => {
        const { client, close, socketPath } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const response = await requestRawJson(
                socketPath,
                `/sessions/${created.session.id}/shell`,
                { body: "null", method: "POST" },
            );

            expect(response.statusCode).toBe(400);
            expect(response.body).toContain("Enter a shell command after !.");
        } finally {
            await close();
        }
    });

    it("reads and stops one direct shell process through its stable session id", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({
                cwd: "/tmp/rig-protocol-test",
                permissionMode: "full_access",
            });
            const started = await client.runShellCommand(created.session.id, {
                command: "sleep 60",
                commandId: "shell-command-1",
            });

            expect(started).toMatchObject({
                command: "sleep 60",
                commandId: "shell-command-1",
                status: "running",
            });
            if (started.status !== "running") throw new Error("Expected a running command.");

            await expect(
                client.readBackgroundProcess(created.session.id, started.sessionId),
            ).resolves.toMatchObject({
                command: "sleep 60",
                sessionId: started.sessionId,
            });
            await expect(
                client.readBackgroundProcess(created.session.id, 999_999),
            ).resolves.toBeUndefined();
            await expect(
                client.stopBackgroundProcess(created.session.id, started.sessionId),
            ).resolves.toMatchObject({
                process: { sessionId: started.sessionId },
                stopped: true,
            });
            await expect(
                client.readBackgroundProcess(created.session.id, started.sessionId),
            ).resolves.toMatchObject({ sessionId: started.sessionId });
        } finally {
            await close();
        }
    });

    it("reports abort failures without dropping the protocol connection", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            expect(session).toBeDefined();
            vi.spyOn(session!, "abort").mockRejectedValueOnce(
                new Error("The background process could not be stopped."),
            );

            await expect(client.abort(created.session.id)).rejects.toThrow(
                "The background process could not be stopped.",
            );
            await expect(client.health()).resolves.toMatchObject({ healthy: true });
        } finally {
            await close();
        }
    });

    it("preserves steering continuation in an idempotent abort response", async () => {
        const { client, close, socketPath, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            if (session === undefined) throw new Error("Expected the created session.");
            const event = await session.events.append(ctx, {
                createdAt: 1,
                data: {
                    continuePendingSteering: true,
                    mutationId: "soft-abort-mutation",
                    runId: "run-1",
                },
                id: createEventIdFactory()(),
                sessionId: session.id,
                type: "abort_requested",
            });
            const abort = vi.spyOn(session, "abort");

            const response = await requestRawJson(
                socketPath,
                `/sessions/${encodeURIComponent(session.id)}/abort`,
                {
                    body: "",
                    headers: { "x-rig-mutation-id": "soft-abort-mutation" },
                    method: "POST",
                },
            );

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body)).toEqual({
                aborted: true,
                continued: true,
                eventId: event.id,
            });
            expect(abort).not.toHaveBeenCalled();
        } finally {
            await close();
        }
    });

    it("updates and clears a persisted goal through dedicated endpoints", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        await store.saveSession(ctx, pausedGoalState());
        const { client, close } = await startServer({ store });
        try {
            const changed = await client.changeGoalStatus("goal-session", { status: "blocked" });
            expect(changed.session.goal).toMatchObject({
                objective: "Finish the protocol",
                status: "blocked",
            });

            const cleared = await client.clearGoal("goal-session");
            expect(cleared.session.goal).toBeUndefined();
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("answers a pending structured question through the protocol", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            expect(session).toBeDefined();
            const pending = session?.requestUserInput(ctx, {
                requestId: "question/1",
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

            await expect(
                client.answerUserInput(created.session.id, "question/1", {
                    answers: {},
                }),
            ).rejects.toThrow("Answer the Database question");

            const answered = await client.answerUserInput(created.session.id, "question/1", {
                answers: { database: ["SQLite"] },
            });

            await expect(pending).resolves.toEqual({
                status: "answered",
                answers: { database: ["SQLite"] },
            });
            expect(answered.session.pendingUserInputs).toEqual([]);
            await expect(
                client.answerUserInput(created.session.id, "question/1", {
                    answers: { database: ["PostgreSQL"] },
                }),
            ).rejects.toThrow("no longer waiting");

            const optional = session?.requestUserInput(ctx, {
                requestId: "question/optional",
                questions: [
                    {
                        header: "Nickname",
                        id: "nickname",
                        multiSelect: false,
                        options: [],
                        question: "Choose an optional nickname.",
                        required: false,
                    },
                ],
            });
            await client.answerUserInput(created.session.id, "question/optional", { answers: {} });
            await expect(optional).resolves.toEqual({ status: "answered", answers: {} });
        } finally {
            await close();
        }
    });

    it("rejects unknown permission modes", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });

            await expect(
                client.changePermissionMode(created.session.id, {
                    permissionMode: "unrestricted" as "full_access",
                }),
            ).rejects.toThrow(
                "Permission mode must be one of: auto, workspace_write, read_only, or full_access.",
            );
        } finally {
            await close();
        }
    });

    it("compacts sessions through a dedicated endpoint", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });

            const compacted = await client.compact(created.session.id);

            expect(compacted.result.compacted).toBe(false);
            expect(compacted.session.id).toBe(created.session.id);
            expect(compacted.session.snapshot.messages).toEqual([]);
        } finally {
            await close();
        }
    });

    it("lets a user cancel a scheduled message and reconnect to its durable update", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-scheduling" });
            const session = await store.get(ctx, created.session.id);
            if (session === undefined) throw new Error("Expected the scheduled session.");
            const scheduled = await session.scheduleMessage(ctx, {
                dueAt: Date.now() + 60_000,
                message: "Check the build later.",
                targetAgentId: created.session.agentId,
            });

            await expect(
                client.cancelScheduledMessage(created.session.id, scheduled.id, "cancel-1"),
            ).resolves.toMatchObject({
                cancelled: true,
                message: { id: scheduled.id, status: "cancelled" },
            });
            await expect(client.getSession(created.session.id)).resolves.toMatchObject({
                session: {
                    scheduledMessages: [
                        expect.objectContaining({ id: scheduled.id, status: "cancelled" }),
                    ],
                },
            });
            await expect(client.getEvents(created.session.id)).resolves.toMatchObject({
                events: expect.arrayContaining([
                    expect.objectContaining({
                        data: expect.objectContaining({ mutationId: "cancel-1" }),
                        type: "scheduled_message_changed",
                    }),
                ]),
            });
        } finally {
            await close();
        }
    });

    it("serves catch-up events since a cursor", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            expect(session).toBeDefined();
            const createEventId = createEventIdFactory({ now: () => 1_700_000_000_000 });
            const first = sessionResetEvent(created.session.id, createEventId());
            const second = sessionResetEvent(created.session.id, createEventId());
            await session?.events.append(ctx, first);
            await session?.events.append(ctx, second);

            const received = await client.getEvents(created.session.id, first.id);

            expect(received.events.map((event) => event.id)).toEqual([second.id]);
        } finally {
            await close();
        }
    });

    it("rejects REST and SSE cursors owned by another session", async () => {
        const { client, close } = await startServer();
        try {
            const first = await client.createSession({ cwd: "/tmp/rig-protocol-first" });
            const second = await client.createSession({ cwd: "/tmp/rig-protocol-second" });
            const otherSessionCursor = second.session.lastEventId;
            if (otherSessionCursor === undefined) throw new Error("Expected a session cursor.");

            await expect(client.getEvents(first.session.id, otherSessionCursor)).rejects.toThrow(
                "Event cursor not found",
            );
            await expect(
                client.watchSessionEvents({
                    after: otherSessionCursor,
                    sessionId: first.session.id,
                    onEvent() {},
                }),
            ).rejects.toThrow("409");
        } finally {
            await close();
        }
    });

    it("omits transient agent deltas from initial history but preserves cursor catch-up", async () => {
        const { client, close, store } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const session = await store.get(ctx, created.session.id);
            expect(session).toBeDefined();
            const createEventId = createEventIdFactory({ now: () => 1_700_000_000_000 });
            const cursor = sessionResetEvent(created.session.id, createEventId());
            const transient: SessionEvent = {
                createdAt: 1_700_000_000_001,
                data: {
                    event: {
                        contentIndex: 0,
                        delta: "live",
                        partial: {},
                        type: "text_delta",
                    },
                    runId: "run-1",
                },
                id: createEventId(),
                sessionId: created.session.id,
                type: "agent_event",
            } as SessionEvent;
            const compaction: SessionEvent = {
                createdAt: 1_700_000_000_002,
                data: {
                    event: {
                        compactionId: "compaction-1",
                        compactedMessageCount: 8,
                        elapsedMs: 25,
                        estimatedTokensAfter: 600,
                        estimatedTokensBefore: 4_200,
                        reason: "threshold",
                        type: "context_compacted",
                    },
                    runId: "run-1",
                },
                id: createEventId(),
                sessionId: created.session.id,
                type: "agent_event",
            };
            const backgroundProcesses: SessionEvent = {
                createdAt: 1_700_000_000_003,
                data: {
                    event: { running: 1, type: "background_processes_changed" },
                    runId: "run-1",
                },
                id: createEventId(),
                sessionId: created.session.id,
                type: "agent_event",
            };
            const durable = sessionResetEvent(created.session.id, createEventId());
            await session?.events.append(ctx, cursor);
            await session?.events.append(ctx, transient);
            await session?.events.append(ctx, compaction);
            await session?.events.append(ctx, backgroundProcesses);
            await session?.events.append(ctx, durable);

            const initial = await client.getEvents(created.session.id);
            const catchup = await client.getEvents(created.session.id, cursor.id);

            expect(initial.events.map((event) => event.id)).not.toContain(transient.id);
            expect(initial.events.map((event) => event.id)).toContain(compaction.id);
            expect(initial.events.map((event) => event.id)).toContain(backgroundProcesses.id);
            expect(initial.events.map((event) => event.id)).toContain(durable.id);
            expect(catchup.events.map((event) => event.id)).toEqual([
                compaction.id,
                backgroundProcesses.id,
                durable.id,
            ]);
        } finally {
            await close();
        }
    });

    it("opens a session stream with the session, so no follow-up request is needed", async () => {
        const { client, close, socketPath } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const hello = await readStreamHello(socketPath, created.session.id);

            expect(hello.resumed).toBe(false);
            expect(hello.session?.id).toBe(created.session.id);
            expect(hello.activity).toEqual({ kind: "idle", label: "Idle", since: 0 });
        } finally {
            await close();
        }
    });

    it("omits the transcript but restores current non-replayable state when a client resumes", async () => {
        const { client, close, socketPath } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const cursor = created.session.lastEventId;
            expect(cursor).toBeDefined();
            await client.setSessionDraft(created.session.id, {
                draft: "Changed while disconnected",
                origin: "test",
            });
            const hello = await readStreamHello(socketPath, created.session.id, cursor);

            expect(hello.resumed).toBe(true);
            expect(hello.session).toBeUndefined();
            expect(hello.lastEventId).toBeDefined();
            expect(hello.current?.draft).toBe("Changed while disconnected");
            expect(hello.current).toMatchObject({
                mcpServers: [],
                projectSecretIds: [],
                secretIds: [],
                sessionSecretIds: [],
                titleStatus: "idle",
                workflows: [],
                workflowsEnabled: true,
            });
        } finally {
            await close();
        }
    });

    it("streams a composer draft to the other clients watching the session", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const controller = new AbortController();
            const streamed: SessionEvent[] = [];
            const watching = client.watchSessionEvents({
                ...(created.session.lastEventId === undefined
                    ? {}
                    : { after: created.session.lastEventId }),
                sessionId: created.session.id,
                signal: controller.signal,
                onEvent(event) {
                    if (event.type !== "session_draft_changed") return;
                    streamed.push(event);
                    if (streamed.length === 2) controller.abort();
                },
            });

            const written = await client.setSessionDraft(created.session.id, {
                draft: "Ship the draft feature",
                origin: "terminal-a",
            });
            expect(written.session.draft).toBe("Ship the draft feature");

            await client.setSessionDraft(created.session.id, { draft: null });
            await watching;

            expect(streamed.map((event) => event.data)).toEqual([
                {
                    draft: "Ship the draft feature",
                    origin: "terminal-a",
                    updatedAt: expect.any(Number),
                },
                { updatedAt: expect.any(Number) },
            ]);
            const reloaded = await client.getSession(created.session.id);
            expect(reloaded.session.draft).toBeUndefined();
        } finally {
            await close();
        }
    });

    it("discards a draft that was typed before the one it already holds", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const now = Date.now();

            await client.setSessionDraft(created.session.id, {
                draft: "typed second",
                updatedAt: now - 1_000,
            });
            const stale = await client.setSessionDraft(created.session.id, {
                draft: "typed first",
                updatedAt: now - 30_000,
            });

            expect(stale.session.draft).toBe("typed second");
            expect(stale.session.draftUpdatedAt).toBe(now - 1_000);
        } finally {
            await close();
        }
    });

    it("refuses a draft that is not text or is too long to sync", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });

            await expect(
                client.setSessionDraft(created.session.id, {
                    draft: 42 as unknown as string,
                }),
            ).rejects.toThrow("A draft must be text.");
            await expect(
                client.setSessionDraft(created.session.id, { draft: "x".repeat(100_001) }),
            ).rejects.toThrow("too long to sync");

            const reloaded = await client.getSession(created.session.id);
            expect(reloaded.session.draft).toBeUndefined();
        } finally {
            await close();
        }
    });

    it("restores a composer draft after the daemon restarts", async () => {
        const databaseDirectory = await mkdtemp(join(tmpdir(), "rig-protocol-draft-test-"));
        const databasePath = join(databaseDirectory, "sessions.sqlite");
        let originalStore: PersistentSessionStore | undefined;
        let restoredStore: PersistentSessionStore | undefined;
        let server: Awaited<ReturnType<typeof startServer>> | undefined;
        try {
            originalStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            server = await startServer({ store: originalStore });
            const created = await server.client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const written = await server.client.setSessionDraft(created.session.id, {
                draft: "Unsent when the terminal closed",
            });
            await server.close();
            server = undefined;
            await originalStore.close(ctx);
            originalStore = undefined;

            restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            server = await startServer({ store: restoredStore });

            const restored = await server.client.getSession(created.session.id);
            expect(restored.session.draft).toBe("Unsent when the terminal closed");
            expect(restored.session.draftUpdatedAt).toBe(written.session.draftUpdatedAt);
            const listed = await server.client.listSessions(10);
            expect(listed.sessions[0]?.draft).toBe("Unsent when the terminal closed");
        } finally {
            await server?.close();
            await restoredStore?.close(ctx);
            await originalStore?.close(ctx);
            await rm(databaseDirectory, { recursive: true, force: true });
        }
    });

    it("recovers REST and SSE catch-up from a live-only cursor after restart", async () => {
        const databaseDirectory = await mkdtemp(join(tmpdir(), "rig-protocol-cursor-test-"));
        const databasePath = join(databaseDirectory, "sessions.sqlite");
        let originalStore: PersistentSessionStore | undefined;
        let restoredStore: PersistentSessionStore | undefined;
        let server: Awaited<ReturnType<typeof startServer>> | undefined;
        try {
            originalStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const session = await originalStore.create(ctx, { cwd: "/tmp/rig-protocol-test" });
            const createFutureEventId = createEventIdFactory({ now: () => Date.now() + 60_000 });
            const transient: SessionEvent = {
                createdAt: Date.now(),
                data: {
                    event: { contentIndex: 0, delta: "live", partial: {}, type: "text_delta" },
                    runId: "run-1",
                },
                id: createFutureEventId(),
                sessionId: session.id,
                type: "agent_event",
            } as SessionEvent;
            await session.events.append(ctx, transient);
            await originalStore.close(ctx);
            originalStore = undefined;

            restoredStore = await PersistentSessionStore.open(ctx, {
                databasePath,
            });
            const restored = await restoredStore.get(ctx, session.id);
            await restored?.changePermissionMode(ctx, { permissionMode: "read_only" });
            const durable = restored?.events.since(transient.id) ?? [];
            expect(durable.map((event) => event.type)).toContain("permission_mode_changed");
            expect(durable.every((event) => event.id > transient.id)).toBe(true);

            server = await startServer({ store: restoredStore });
            await expect(server.client.getEvents(session.id, transient.id)).resolves.toEqual({
                events: durable,
            });

            const controller = new AbortController();
            const streamed: SessionEvent[] = [];
            await server.client.watchSessionEvents({
                after: transient.id,
                sessionId: session.id,
                signal: controller.signal,
                onEvent(event) {
                    streamed.push(event);
                    if (streamed.length === durable.length) controller.abort();
                },
            });
            expect(streamed).toEqual(durable);
        } finally {
            await server?.close();
            await restoredStore?.close(ctx);
            await originalStore?.close(ctx);
            await rm(databaseDirectory, { recursive: true, force: true });
        }
    });

    it("serves session summaries", async () => {
        const { client, close } = await startServer();
        try {
            await client.createSession({ cwd: "/tmp/rig-protocol-test-a" });
            await client.createSession({ cwd: "/tmp/rig-protocol-test-b" });

            const response = await client.listSessions(1);

            expect(response.sessions).toHaveLength(1);
            expect(response.sessions[0]).toMatchObject({
                status: "idle",
                titleStatus: "idle",
            });
        } finally {
            await close();
        }
    });

    it("reports disconnected settled sessions as idle and restores live status", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        await store.saveSession(ctx, completedPrimaryState("idle-session"));
        const { client, close } = await startServer({ store });
        let idleTerminal:
            | Awaited<ReturnType<ProtocolHttpClient["connectSessionTerminal"]>>
            | undefined;
        try {
            expect(await listedSession(client, "idle-session")).toMatchObject({
                archived: false,
                status: "idle",
            });

            idleTerminal = await client.connectSessionTerminal("idle-session");
            expect(await listedSession(client, "idle-session")).toMatchObject({
                archived: false,
                status: "completed",
            });

            await idleTerminal.close();
            idleTerminal = undefined;
            expect(await listedSession(client, "idle-session")).toMatchObject({
                archived: false,
                status: "idle",
            });
        } finally {
            await idleTerminal?.close();
            await close();
            await store.close(ctx);
        }
    });

    it("keeps settled sessions in the default listing so resume can find them", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        await store.saveSession(ctx, completedPrimaryState("settled-session"));
        await store.saveSession(ctx, {
            ...completedPrimaryState("shelved-session"),
            archived: true,
        });
        const { client, close } = await startServer({ store });
        try {
            const listed = await client.listSessions();
            expect(listed.sessions.map((session) => session.id)).toEqual(["settled-session"]);
            expect(listed.sessions[0]).toMatchObject({ archived: false, status: "idle" });
            expect(
                (await client.listSessions({ archived: true })).sessions.map(
                    (session) => session.id,
                ),
            ).toEqual(["shelved-session"]);
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("keeps unread state for background clients and clears it when any client is focused", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        await store.saveSession(ctx, {
            ...completedPrimaryState("unread-session"),
            trackUnread: true,
            unread: { reason: "attention_needed", since: 123 },
        });
        const { client, close } = await startServer({ store });
        let background:
            | Awaited<ReturnType<ProtocolHttpClient["connectSessionTerminal"]>>
            | undefined;
        let foreground:
            | Awaited<ReturnType<ProtocolHttpClient["connectSessionTerminal"]>>
            | undefined;
        try {
            background = await client.connectSessionTerminal("unread-session", {
                focused: false,
            });
            expect(await listedSession(client, "unread-session")).toMatchObject({
                unread: { reason: "attention_needed", since: 123 },
            });

            foreground = await client.connectSessionTerminal("unread-session", {
                focused: true,
            });
            expect((await listedSession(client, "unread-session"))?.unread).toBeUndefined();
            expect((await store.get(ctx, "unread-session"))?.snapshot().unread).toBeUndefined();

            const session = await store.get(ctx, "unread-session");
            const pending = session?.requestUserInput(ctx, {
                requestId: "focused-question",
                questions: [],
            });
            await vi.waitFor(
                () => expect(session?.snapshot().unread?.reason).toBe("attention_needed"),
                { interval: 10, timeout: 1_000 },
            );
            await foreground.close();
            foreground = undefined;
            expect(session?.snapshot().unread).toBeUndefined();
            await session?.answerUserInput(ctx, "focused-question", { answers: {} });
            await pending;
        } finally {
            await background?.close();
            await foreground?.close();
            await close();
            await store.close(ctx);
        }
    });

    it("lets a client without a terminal mark a chat read", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        await store.saveSession(ctx, {
            ...completedPrimaryState("read-session"),
            trackUnread: true,
            unread: { reason: "attention_needed", since: 123 },
        });
        const { client, close } = await startServer({ store });
        try {
            expect(await listedSession(client, "read-session")).toMatchObject({
                unread: { reason: "attention_needed", since: 123 },
            });

            const read = await client.markSessionRead("read-session");
            expect(read.session.unread).toBeUndefined();
            expect((await listedSession(client, "read-session"))?.unread).toBeUndefined();

            // Repeating it settles on the same state rather than failing, so a
            // retry after a lost answer is harmless.
            const again = await client.markSessionRead("read-session");
            expect(again.session.unread).toBeUndefined();
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("forks a completed session into a new resumable session", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });
            const forked = await client.forkSession(created.session.id);

            expect(forked.session.id).not.toBe(created.session.id);
            expect(forked.session.agent).toMatchObject({
                depth: 0,
                rootSessionId: forked.session.id,
                type: "primary",
            });
            expect(forked.session.cwd).toBe(created.session.cwd);
            expect(forked.session.modelLocked).toBe(false);
        } finally {
            await close();
        }
    });

    it("searches files through the project scope instead of the session", async () => {
        const search = vi.fn(async () => [
            { fileName: "CodingAssistantApp.ts", path: "sources/app/CodingAssistantApp.ts" },
        ]);
        const fileSearchService: FileSearchServiceContract = {
            close: vi.fn(),
            search,
        };
        const { client, close } = await startServer({ fileSearchService });
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });

            const response = await client.searchFiles(
                { projectId: created.session.projectId! },
                "coding app",
                7,
            );

            expect(search).toHaveBeenCalledWith("/tmp/rig-protocol-test", "coding app", 7);
            expect(response.files).toEqual([
                {
                    fileName: "CodingAssistantApp.ts",
                    path: "sources/app/CodingAssistantApp.ts",
                },
            ]);
        } finally {
            await close();
        }
    });

    it("accepts image content blocks on submitted messages", async () => {
        const { client, close } = await startServer();
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-protocol-test" });

            await client.submitMessage(created.session.id, {
                content: [
                    { type: "text", text: "inspect this " },
                    { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
                ],
                displayText: "inspect this [Image #1 PNG]",
                text: "inspect this [Image #1 PNG]",
            });
            const events = await client.getEvents(created.session.id, created.session.lastEventId);
            const submitted = events.events.find((event) => event.type === "message_submitted");

            expect(submitted).toMatchObject({
                data: {
                    displayText: "inspect this [Image #1 PNG]",
                    message: {
                        blocks: [
                            { type: "text", text: "inspect this " },
                            { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
                        ],
                        role: "user",
                    },
                },
                type: "message_submitted",
            });
        } finally {
            await close();
        }
    });

    it("accepts shutdown requests", async () => {
        let shutdownRequested = false;
        const { client, close } = await startServer({
            onShutdown: () => {
                shutdownRequested = true;
            },
        });
        try {
            await expect(client.shutdown()).resolves.toEqual({
                pid: process.pid,
                shuttingDown: true,
            });
            await new Promise((resolve) => setImmediate(resolve));

            expect(shutdownRequested).toBe(true);
        } finally {
            await close();
        }
    });

    it("rejects new mutations as soon as shutdown begins", async () => {
        const taskDrain = new TrackedTaskDrain();
        const onboarding: OnboardingServiceContract = {
            onboardMurmur: vi.fn<OnboardingServiceContract["onboardMurmur"]>(async () => ({
                enabled: false,
            })),
            status: vi.fn<OnboardingServiceContract["status"]>(async () => ({
                onboardingVersion: 2,
                state: "complete",
            })),
        };
        const { client, close, socketPath } = await startServer({ onboarding, taskDrain });
        try {
            const created = await client.createSession({ cwd: "/tmp/rig-closing-test" });

            await expect(client.shutdown()).resolves.toEqual({
                pid: process.pid,
                shuttingDown: true,
            });
            await expect(
                client.submitMessage(created.session.id, { text: "Too late" }),
            ).rejects.toThrow("local daemon is shutting down");
            await expect(
                client.registerProject({ path: "/tmp/rig-closing-project" }),
            ).rejects.toThrow("local daemon is shutting down");
            await expect(
                requestRawJson(socketPath, "/onboarding", { body: "", method: "GET" }),
            ).resolves.toMatchObject({ statusCode: 503 });
            expect(onboarding.status).not.toHaveBeenCalled();
            await expect(client.getSession(created.session.id)).resolves.toMatchObject({
                session: { id: created.session.id },
            });
        } finally {
            await close();
        }
    });

    it("rewinds a session to a selected user message", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const state = pausedGoalState();
        const first = {
            blocks: [{ text: "Keep this", type: "text" as const }],
            id: "message-1",
            role: "user" as const,
        };
        const second = {
            blocks: [{ text: "Try this again", type: "text" as const }],
            id: "message-2",
            role: "user" as const,
        };
        await store.saveSession(ctx, { ...state, contextMessages: [first, second] });
        await store.upsertMessage(ctx, state.id, {
            isPartial: false,
            message: first,
            position: 0,
            runId: "run-1",
        });
        await store.upsertMessage(ctx, state.id, {
            isPartial: false,
            message: second,
            position: 1,
            runId: "run-2",
        });
        const { client, close } = await startServer({ store });
        try {
            const response = await client.rewind(state.id, second.id);

            expect(response.message).toEqual(second);
            expect(response.session.snapshot.messages).toEqual([first]);
        } finally {
            await close();
            await store.close(ctx);
        }
    });

    it("serves subagent history but rejects attempts to resume it", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        await store.saveSession(ctx, readOnlySubagentState());
        const { client, close } = await startServer({ store });
        try {
            const loaded = await client.getSession("subagent-1");

            expect(loaded.session.agent).toMatchObject({
                parentSessionId: "session-1",
                type: "subagent",
            });
            // Readable, but not a chat in the sidebar, and never given a
            // stand-in position that would collide with the chats that are.
            expect(loaded.session.orderKey).toBeUndefined();
            expect(
                (await client.listSessions({ archived: "all" })).sessions.map(
                    (session) => session.id,
                ),
            ).not.toContain("subagent-1");
            await expect(
                client.submitMessage("subagent-1", { text: "Continue working." }),
            ).rejects.toThrow("read-only");
            await expect(client.reset("subagent-1")).rejects.toThrow("read-only");
            await expect(client.rewind("subagent-1", "message-1")).rejects.toThrow("read-only");
            await expect(client.compact("subagent-1")).rejects.toThrow("read-only");
            await expect(client.archiveSession("subagent-1")).rejects.toThrow("read-only");
            await expect(client.unarchiveSession("subagent-1")).rejects.toThrow("read-only");
            await expect(
                client.broadcastMessage({
                    sessionIds: ["subagent-1"],
                    text: "Continue working.",
                }),
            ).rejects.toThrow("cannot receive broadcasts");
        } finally {
            await close();
            await store.close(ctx);
        }
    });
});

async function startServer(
    options: {
        defaultDocker?: DockerExecutionConfig;
        fileSearchService?: FileSearchServiceContract;
        globalEventQueue?: GlobalEventQueue;
        getProviderQuota?: ProtocolHttpServerOptions["getProviderQuota"];
        onDaemonSettingsChange?: (settings: {
            inferenceMaxRetries: number;
            inferenceFatalRetries: number;
            durableGlobalEventQueue: boolean;
        }) =>
            | {
                  inferenceMaxRetries: number;
                  inferenceFatalRetries: number;
                  globalEventQueue: GlobalEventQueue;
              }
            | undefined
            | Promise<
                  | {
                        inferenceMaxRetries: number;
                        inferenceFatalRetries: number;
                        globalEventQueue: GlobalEventQueue;
                    }
                  | undefined
              >;
        onShutdown?: () => void;
        onReloadHappy?: () => boolean | Promise<boolean>;
        onStartInspector?: () => Promise<{ inspectorUrl: string }>;
        onboarding?: OnboardingServiceContract;
        profiles?: RigProfileStore;
        store?: SessionStore;
        taskDrain?: TrackedTaskDrain;
    } = {},
): Promise<{
    client: ProtocolHttpClient;
    close: () => Promise<void>;
    socketPath: string;
    store: SessionStore;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = join(directory, "server.sock");
    const store =
        options.store ??
        (await InMemorySessionStore.open(ctx, {
            ...(options.defaultDocker === undefined
                ? {}
                : { defaultDocker: options.defaultDocker }),
        }));
    const server = await createProtocolHttpServer(createTestRootContext(), {
        ...(options.defaultDocker === undefined ? {} : { defaultDocker: options.defaultDocker }),
        ...(options.fileSearchService !== undefined
            ? { fileSearchService: options.fileSearchService }
            : {}),
        ...(options.globalEventQueue === undefined
            ? {}
            : { globalEventQueue: options.globalEventQueue }),
        ...(options.getProviderQuota === undefined
            ? {}
            : { getProviderQuota: options.getProviderQuota }),
        ...(options.onShutdown !== undefined ? { onShutdown: options.onShutdown } : {}),
        ...(options.onReloadHappy !== undefined ? { onReloadHappy: options.onReloadHappy } : {}),
        ...(options.onStartInspector !== undefined
            ? { onStartInspector: options.onStartInspector }
            : {}),
        ...(options.onboarding === undefined ? {} : { onboarding: options.onboarding }),
        ...(options.onDaemonSettingsChange === undefined
            ? {}
            : {
                  onDaemonConfigChange: (_requestCtx, config) =>
                      options.onDaemonSettingsChange!(config.settings),
              }),
        store,
        ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
        ...(options.taskDrain === undefined ? {} : { taskDrain: options.taskDrain }),
        token: "secret",
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });

    return {
        client: new ProtocolHttpClient({ socketPath, token: "secret" }),
        socketPath,
        store,
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        },
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

/** Reads the first frame of a session event stream and stops there. */
async function readStreamHello(
    socketPath: string,
    sessionId: string,
    after?: string,
): Promise<SessionStreamHello> {
    const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers: { accept: "text/event-stream", authorization: "Bearer secret" },
                method: "GET",
                path: `/sessions/${encodeURIComponent(sessionId)}/stream${query}`,
                socketPath,
            },
            (response) => {
                let buffer = "";
                response.setEncoding("utf8");
                if (response.statusCode !== 200) {
                    request.destroy();
                    reject(new Error(`The stream was refused with ${response.statusCode}.`));
                    return;
                }
                response.on("data", (chunk: string) => {
                    buffer += chunk;
                    // The trailing segment is whatever has not been terminated
                    // yet, so only the segments before it are complete frames.
                    const frames = buffer.split("\n\n").slice(0, -1);
                    const hello = frames.find((frame) => frame.startsWith("event: hello\n"));
                    if (hello === undefined) return;
                    request.destroy();
                    resolve(JSON.parse(hello.slice(hello.indexOf("data: ") + "data: ".length)));
                });
                response.on("end", () => reject(new Error("The stream ended without a hello.")));
            },
        );
        request.on("error", (error) => {
            if (!request.destroyed) reject(error);
        });
        request.end();
    });
}

/**
 * Reads the durable event log the way the external mirror does: server-sent
 * events over the daemon socket, resumed from a cursor.
 */
function openDurableEventStream(
    socketPath: string,
    path: string,
): {
    close: () => void;
    waitForEvent: (predicate: (event: SessionEvent) => boolean) => Promise<SessionEvent>;
} {
    const events: SessionEvent[] = [];
    const call = httpRequest({
        headers: { accept: "text/event-stream", authorization: "Bearer secret" },
        path,
        socketPath,
    });
    let buffer = "";
    call.on("response", (response) => {
        response.on("data", (chunk: Buffer) => {
            buffer += String(chunk);
            for (;;) {
                const boundary = buffer.indexOf("\n\n");
                if (boundary < 0) break;
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const data = frame.split("\n").find((line) => line.startsWith("data:"));
                if (data === undefined) continue;
                events.push(JSON.parse(data.slice("data:".length)) as SessionEvent);
            }
        });
    });
    call.end();

    return {
        close: () => call.destroy(),
        waitForEvent: async (predicate) => {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                const found = events.find((event) => predicate(event));
                if (found !== undefined) return found;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("Timed out waiting for a durable event.");
        },
    };
}

async function requestRawJson(
    socketPath: string,
    path: string,
    options: { body: string; headers?: Record<string, string>; method: string },
): Promise<{ body: string; headers: IncomingHttpHeaders; statusCode: number | undefined }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers: {
                    authorization: "Bearer secret",
                    "content-type": "application/json",
                    ...options.headers,
                },
                method: options.method,
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => {
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        statusCode: response.statusCode,
                    });
                });
            },
        );
        request.once("error", reject);
        request.end(options.body);
    });
}

function readOnlySubagentState(): PersistedSessionState {
    return {
        agent: {
            depth: 1,
            description: "Inspect the protocol",
            parentSessionId: "session-1",
            rootSessionId: "session-1",
            type: "subagent",
        },
        agentId: "agent-2",
        ownerInstanceId: "alocalinstance00000000001",
        cwd: "/tmp/rig-protocol-test",
        id: "subagent-1",
        messages: [],
        modelId: modelOpenaiGpt55.id,
        models: [],
        // A subagent has no place in an ordered list, so it holds no position.
        orderKey: "",
        providerId: "codex",
        permissionMode: "workspace_write",
        queuedRuns: [],
        scope: { kind: "unsorted" },
        nextTaskId: 1,
        status: "completed",
        tasks: [],
        title: "Inspect the protocol",
        titleStatus: "ready",
        tools: [],
        unsortedSince: Date.now(),
    };
}

function completedPrimaryState(id: string): PersistedSessionState {
    return {
        agent: { depth: 0, rootSessionId: id, type: "primary" },
        agentId: `${id}-agent`,
        ownerInstanceId: "alocalinstance00000000001",
        cwd: "/tmp/rig-protocol-test",
        id,
        messages: [],
        modelId: modelOpenaiGpt55.id,
        models: [],
        orderKey: "a0",
        nextTaskId: 1,
        permissionMode: "workspace_write",
        providerId: "codex",
        queuedRuns: [],
        scope: { kind: "unsorted" },
        status: "completed",
        tasks: [],
        titleStatus: "ready",
        tools: [],
        unsortedSince: Date.now(),
    };
}

async function listedSession(
    client: ProtocolHttpClient,
    sessionId: string,
): Promise<SessionSummary | undefined> {
    return (await client.listSessions({ archived: "all" })).sessions.find(
        (session) => session.id === sessionId,
    );
}

function pausedGoalState(): PersistedSessionState {
    return {
        agent: { depth: 0, rootSessionId: "goal-session", type: "primary" },
        agentId: "goal-agent",
        ownerInstanceId: "alocalinstance00000000001",
        cwd: "/tmp/rig-protocol-test",
        goal: {
            createdAt: 1,
            objective: "Finish the protocol",
            status: "paused",
            updatedAt: 1,
        },
        id: "goal-session",
        messages: [],
        modelId: modelOpenaiGpt55.id,
        models: [],
        orderKey: "a0",
        nextTaskId: 1,
        permissionMode: "workspace_write",
        providerId: "codex",
        queuedRuns: [],
        scope: { kind: "unsorted" },
        status: "idle",
        tasks: [],
        titleStatus: "idle",
        tools: [],
        unsortedSince: Date.now(),
    };
}

function sessionResetEvent(sessionId: string, id: string): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data: {
            snapshot: {
                id: "agent-1",
                messages: [],
                modelId: "openai/gpt-5.5",
                providerId: "codex",
                queue: [],
                status: "idle",
                tools: [],
            },
            // These exercise event delivery, not transcript rebuilding.
            transcript: { complete: true, messages: [], turns: [] },
        },
        id,
        sessionId,
        type: "session_reset",
    };
}
