import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCuid } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "../../protocol/index.js";
import { createHappySpawnWorkspaceId } from "../createHappySpawnSessionId.js";
import { handleHappySpawnSession } from "../handleHappySpawnSession.js";

const directories: string[] = [];
const catalog: ModelCatalog = {
    defaultModelId: "gpt-test",
    defaultProviderId: "codex",
    models: [],
    providers: [
        {
            models: [
                {
                    defaultThinkingLevel: "medium",
                    id: "gpt-test",
                    name: "GPT Test",
                    thinkingLevels: ["low", "medium", "high"],
                },
            ],
            providerId: "codex",
        },
    ],
};

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("handleHappySpawnSession", () => {
    it("creates one idempotent session with Rig's auto default and returns its Happy ID", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-"));
        directories.push(directory);
        const createSession = vi.fn();
        const options = {
            createSession,
            machineId: "rig-machine",
            modelCatalog: catalog,
            params: {
                agent: "rig",
                clientRequestId: "mobile-request-1",
                directory,
                type: "spawn-in-directory",
            },
            waitForRemoteSession: vi.fn(async () => "happy-session-1"),
        } as const;

        await expect(handleHappySpawnSession(options)).resolves.toEqual({
            sessionId: "happy-session-1",
            type: "success",
        });
        await handleHappySpawnSession(options);

        expect(createSession.mock.calls[0]?.[0]).toMatch(/^happy-rig-/u);
        expect(createSession.mock.calls[1]?.[0]).toBe(createSession.mock.calls[0]?.[0]);
        expect(createSession.mock.calls[0]?.[1]).toMatchObject({
            cwd: directory,
            effort: "medium",
            modelId: "gpt-test",
            permissionMode: "auto",
            providerId: "codex",
        });
    });

    it("requires confirmation before creating a missing directory", async () => {
        const parent = await mkdtemp(join(tmpdir(), "rig-happy-spawn-missing-"));
        directories.push(parent);
        const directory = join(parent, "new-project");
        const createSession = vi.fn();

        await expect(
            handleHappySpawnSession({
                createSession,
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-2",
                    directory,
                    type: "spawn-in-directory",
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).resolves.toEqual({ directory, type: "requestToApproveDirectoryCreation" });
        expect(createSession).not.toHaveBeenCalled();
    });

    it("returns a retryable pending result after committing a session that is still syncing", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-pending-"));
        directories.push(directory);

        await expect(
            handleHappySpawnSession({
                createSession: vi.fn(),
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-pending",
                    directory,
                    type: "spawn-in-directory",
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).resolves.toEqual({
            clientRequestId: "mobile-request-pending",
            retryAfterMs: 2_000,
            type: "pending",
        });
    });

    it("starts the session inside a workspace it creates for the request", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-worktree-"));
        directories.push(directory);
        const createSession = vi.fn();
        const createWorkspace = vi.fn(async () => ({
            id: "workspace-1",
            path: join(directory, ".rig", "workspaces", "clever-ocean"),
        }));

        await expect(
            handleHappySpawnSession({
                createSession,
                createWorkspace,
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-worktree",
                    directory,
                    type: "spawn-in-directory",
                    worktree: { name: "clever-ocean", type: "new" },
                },
                waitForRemoteSession: async () => "happy-session-worktree",
            }),
        ).resolves.toEqual({ sessionId: "happy-session-worktree", type: "success" });

        const workspaceRequestId = createHappySpawnWorkspaceId(
            "rig-machine",
            "mobile-request-worktree",
        );
        expect(isCuid(workspaceRequestId)).toBe(true);
        expect(createWorkspace).toHaveBeenCalledWith({
            directory,
            id: workspaceRequestId,
            name: "clever-ocean",
        });
        expect(createSession.mock.calls[0]?.[1]).toMatchObject({
            cwd: join(directory, ".rig", "workspaces", "clever-ocean"),
            workspaceId: "workspace-1",
        });
    });

    it("reuses one workspace when Happy retries the same spawn request", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-worktree-retry-"));
        directories.push(directory);
        const workspace = {
            id: "workspace-retried",
            path: join(directory, ".rig", "workspaces", "steady-river"),
        };
        const sessions = new Map<string, { snapshot(): { cwd: string; workspaceId?: string } }>();
        const createWorkspace = vi.fn(async () => workspace);
        const createSession = vi.fn(
            (id: string, request: { cwd: string; workspaceId?: string }) => {
                sessions.set(id, {
                    snapshot: () => ({
                        cwd: request.cwd,
                        ...(request.workspaceId === undefined
                            ? {}
                            : { workspaceId: request.workspaceId }),
                    }),
                });
            },
        );
        const options = {
            createSession,
            createWorkspace,
            loadSession: (id: string) => sessions.get(id),
            machineId: "rig-machine",
            modelCatalog: catalog,
            params: {
                agent: "rig",
                clientRequestId: "mobile-request-worktree-retry",
                directory,
                type: "spawn-in-directory",
                worktree: { name: "steady-river", type: "new" },
            },
            waitForRemoteSession: async () => undefined,
        } as const;

        await handleHappySpawnSession(options);
        await handleHappySpawnSession(options);

        expect(createWorkspace).toHaveBeenCalledOnce();
        expect(createSession).toHaveBeenCalledTimes(2);
        expect(createSession.mock.calls[0]?.[1]).toMatchObject({
            cwd: workspace.path,
            workspaceId: workspace.id,
        });
        expect(createSession.mock.calls[1]?.[1]).toEqual(createSession.mock.calls[0]?.[1]);
    });

    it("does not add a workspace to a request already committed without one", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-worktree-conflict-"));
        directories.push(directory);
        const createWorkspace = vi.fn();

        await expect(
            handleHappySpawnSession({
                createSession: vi.fn(),
                createWorkspace,
                loadSession: () => ({ snapshot: () => ({ cwd: directory }) }),
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-worktree-conflict",
                    directory,
                    type: "spawn-in-directory",
                    worktree: { name: "steady-river", type: "new" },
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).resolves.toEqual({
            errorMessage: "This session request was already used without a workspace.",
            type: "error",
        });
        expect(createWorkspace).not.toHaveBeenCalled();
    });

    it("refuses a worktree request on a machine that cannot create one", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-worktree-unsupported-"));
        directories.push(directory);
        const createSession = vi.fn();

        await expect(
            handleHappySpawnSession({
                createSession,
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-worktree-unsupported",
                    directory,
                    type: "spawn-in-directory",
                    worktree: { name: "clever-ocean", type: "new" },
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).resolves.toEqual({
            errorMessage: "This machine cannot create workspaces.",
            type: "error",
        });
        expect(createSession).not.toHaveBeenCalled();
    });

    it("explains that a folder has to be a project before it can hold a workspace", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-worktree-unknown-"));
        directories.push(directory);
        const createSession = vi.fn();

        await expect(
            handleHappySpawnSession({
                createSession,
                createWorkspace: async () => undefined,
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-worktree-unknown",
                    directory,
                    type: "spawn-in-directory",
                    worktree: { name: "clever-ocean", type: "new" },
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).resolves.toEqual({
            errorMessage: "Open this folder in Rig once before creating a workspace in it.",
            type: "error",
        });
        expect(createSession).not.toHaveBeenCalled();
    });

    it("rejects a worktree request that carries no name", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-worktree-invalid-"));
        directories.push(directory);

        await expect(
            handleHappySpawnSession({
                createSession: vi.fn(),
                createWorkspace: vi.fn(),
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-worktree-invalid",
                    directory,
                    type: "spawn-in-directory",
                    worktree: { type: "new" },
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).resolves.toEqual({
            errorMessage: "Happy sent an invalid worktree request.",
            type: "error",
        });
    });

    it("rejects shell syntax in a worktree name before creating anything", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-worktree-unsafe-"));
        directories.push(directory);
        const createWorkspace = vi.fn();

        await expect(
            handleHappySpawnSession({
                createSession: vi.fn(),
                createWorkspace,
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-worktree-unsafe",
                    directory,
                    type: "spawn-in-directory",
                    worktree: { name: "safe; touch /tmp/pwned #", type: "new" },
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).resolves.toEqual({
            errorMessage: "Happy sent an invalid worktree request.",
            type: "error",
        });
        expect(createWorkspace).not.toHaveBeenCalled();
    });

    it("does not downgrade a database failure to a Happy RPC error", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-spawn-database-failure-"));
        directories.push(directory);
        const failure = Object.assign(new Error("database write failed"), {
            code: "SQLITE_IOERR",
        });

        await expect(
            handleHappySpawnSession({
                createSession: () => {
                    throw failure;
                },
                machineId: "rig-machine",
                modelCatalog: catalog,
                params: {
                    agent: "rig",
                    clientRequestId: "mobile-request-database-failure",
                    directory,
                    type: "spawn-in-directory",
                },
                waitForRemoteSession: async () => undefined,
            }),
        ).rejects.toBe(failure);
    });
});
