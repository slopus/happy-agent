import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    createHappySpawnSessionId,
    handleHappySpawnSession,
    HAPPY_SPAWN_RETRY_MS,
} from "../../sources/happy/index.js";
import type {
    HappyModel,
    HappySpawnOperations,
    HappySpawnRequest,
    HappySpawnResult,
} from "../../sources/happy/index.js";

const MODELS: readonly HappyModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerId: "codex",
        serviceTiers: [],
    },
];

const ctx = createRootContext();

let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "happy-spawn-"));
});

afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
});

function spawner(remoteSessionId: string | undefined) {
    const started: HappySpawnRequest[] = [];
    const served = new Map<string, HappySpawnResult>();
    const operations: HappySpawnOperations = {
        defaultSpawnPermissionMode: () => "auto",
        readSpawnResult: (clientRequestId) => served.get(clientRequestId),
        rememberSpawnResult: (clientRequestId, result) => {
            served.set(clientRequestId, result);
        },
        spawnSession: async (_ctx, request) => {
            started.push(request);
            return { agentId: "agent-1", type: "ready" };
        },
    };
    return {
        started,
        operations,
        remoteSessionId: async () => remoteSessionId,
    };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        agent: "rig",
        clientRequestId: "phone-1",
        directory,
        type: "spawn-in-directory",
        ...overrides,
    };
}

function agentRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        clientRequestId: "phone-1",
        target: { id: "project-1", kind: "project" },
        type: "happy-agent-spawn",
        ...overrides,
    };
}

describe("starting a session from somebody's phone", () => {
    it("starts it and answers with the session Happy can open", async () => {
        const spawn = spawner("remote-1");
        const result = await handleHappySpawnSession({
            ctx,
            operations: spawn.operations,
            machineId: "machine-1",
            models: MODELS,
            params: request(),
            remoteSessionId: spawn.remoteSessionId,
        });
        expect(result).toEqual({ sessionId: "remote-1", type: "success" });
        expect(spawn.started).toEqual([
            {
                cwd: directory,
                effort: "medium",
                modelId: "gpt-5.6-sol",
                permissionMode: "auto",
                providerId: "codex",
                sessionId: createHappySpawnSessionId("machine-1", "phone-1"),
            },
        ]);
    });

    it("reports a session Happy has not been told about yet as still owed", async () => {
        const spawn = spawner(undefined);
        expect(
            await handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: request(),
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).toEqual({
            clientRequestId: "phone-1",
            retryAfterMs: HAPPY_SPAWN_RETRY_MS,
            type: "pending",
        });
    });

    it("asks before creating a directory on somebody's computer", async () => {
        const spawn = spawner("remote-1");
        const missing = join(directory, "new-project");
        expect(
            await handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: request({ directory: missing }),
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).toEqual({ directory: missing, type: "requestToApproveDirectoryCreation" });
        expect(spawn.started).toEqual([]);
    });

    it("creates the directory once the person has said yes", async () => {
        const spawn = spawner("remote-1");
        const missing = join(directory, "new-project");
        const result = await handleHappySpawnSession({
            ctx,
            operations: spawn.operations,
            machineId: "machine-1",
            models: MODELS,
            params: request({ approvedNewDirectoryCreation: true, directory: missing }),
            remoteSessionId: spawn.remoteSessionId,
        });
        expect(result).toEqual({ sessionId: "remote-1", type: "success" });
        expect(spawn.started[0]).toMatchObject({ cwd: missing });
    });

    it("refuses a model this Happy Agent does not have rather than choosing another", async () => {
        const spawn = spawner("remote-1");
        expect(
            await handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: request({ modelId: "some-other-model" }),
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).toEqual({
            errorMessage: "That model is not available in this Happy Agent.",
            type: "error",
        });
        expect(spawn.started).toEqual([]);
    });

    it("refuses a reasoning level the model does not offer", async () => {
        const spawn = spawner("remote-1");
        expect(
            await handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: request({ effort: "ultra" }),
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).toEqual({
            errorMessage: "That reasoning level is not available for this model.",
            type: "error",
        });
    });

    it("refuses a permission mode Happy Agent does not have", async () => {
        const spawn = spawner("remote-1");
        expect(
            await handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: request({ permissionMode: "anything_goes" }),
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).toEqual({
            errorMessage: "That permission mode is not one Happy Agent has.",
            type: "error",
        });
    });

    it("refuses a relative directory", async () => {
        const spawn = spawner("remote-1");
        expect(
            await handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: request({ directory: "projects/thing" }),
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).toEqual({
            errorMessage: "A session directory must be an absolute path.",
            type: "error",
        });
    });

    it("refuses a request it does not understand", async () => {
        const spawn = spawner("remote-1");
        expect(
            await handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: { type: "something-else" },
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).toEqual({
            errorMessage: "Happy asked for a session Happy Agent does not know how to start.",
            type: "error",
        });
    });
});

describe("the session id one spawn request resolves to", () => {
    it("is the same every time the phone asks again", () => {
        expect(createHappySpawnSessionId("machine-1", "phone-1")).toBe(
            createHappySpawnSessionId("machine-1", "phone-1"),
        );
    });

    it("differs between two daemons on one computer", () => {
        expect(createHappySpawnSessionId("machine-1", "phone-1")).not.toBe(
            createHappySpawnSessionId("machine-2", "phone-1"),
        );
    });

    it("is an Agent Base identity", () => {
        expect(createHappySpawnSessionId("machine-1", "phone-1")).toMatch(/^[a-z][a-z0-9]{1,31}$/);
    });
});

describe("starting a catalog-owned Happy Agent session", () => {
    it.each([
        { id: "project-1", kind: "project" },
        { id: "workspace-1", kind: "workspace" },
        { kind: "newWorkspace", projectId: "project-1" },
        { kind: "projectFolder", projectPath: "/tmp/new-happy-project" },
    ] as const)("passes the $kind target to the daemon unchanged", async (target) => {
        const spawn = spawner("remote-1");

        await expect(
            handleHappySpawnSession({
                ctx,
                operations: spawn.operations,
                machineId: "machine-1",
                models: MODELS,
                params: agentRequest({ target }),
                remoteSessionId: spawn.remoteSessionId,
            }),
        ).resolves.toEqual({ sessionId: "remote-1", type: "success" });

        expect(spawn.started).toEqual([
            {
                effort: "medium",
                modelId: "gpt-5.6-sol",
                permissionMode: "auto",
                providerId: "codex",
                sessionId: createHappySpawnSessionId("machine-1", "phone-1"),
                target,
                workspaceId: createHappySpawnSessionId("machine-1", "phone-1:workspace"),
            },
        ]);
    });

    it("fills every omitted agent setting from daemon defaults", async () => {
        const spawn = spawner("remote-1");
        spawn.operations.defaultSpawnPermissionMode = () => "read_only";

        await handleHappySpawnSession({
            ctx,
            operations: spawn.operations,
            machineId: "machine-1",
            models: MODELS,
            params: agentRequest({ agentConfiguration: { type: "happy-agent" } }),
            remoteSessionId: spawn.remoteSessionId,
        });

        expect(spawn.started[0]).toMatchObject({
            effort: "medium",
            modelId: "gpt-5.6-sol",
            permissionMode: "read_only",
            providerId: "codex",
        });
    });

    it("rejects unknown request and agent-configuration fields", async () => {
        const outer = spawner("remote-1");
        await expect(
            handleHappySpawnSession({
                ctx,
                operations: outer.operations,
                machineId: "machine-1",
                models: MODELS,
                params: agentRequest({ worktree: "silently-dropped-before" }),
                remoteSessionId: outer.remoteSessionId,
            }),
        ).resolves.toEqual({
            message: "Happy asked for a session Happy Agent does not know how to start.",
            type: "error",
        });
        expect(outer.started).toEqual([]);

        const nested = spawner("remote-1");
        await expect(
            handleHappySpawnSession({
                ctx,
                operations: nested.operations,
                machineId: "machine-1",
                models: MODELS,
                params: agentRequest({
                    agentConfiguration: { type: "happy-agent", worktree: "also-invalid" },
                }),
                remoteSessionId: nested.remoteSessionId,
            }),
        ).resolves.toEqual({
            message: "Happy asked for a session Happy Agent does not know how to start.",
            type: "error",
        });
        expect(nested.started).toEqual([]);
    });

    it("serves a terminal retry from memory without starting anything twice", async () => {
        const spawn = spawner("remote-1");
        const options = {
            ctx,
            operations: spawn.operations,
            machineId: "machine-1",
            models: MODELS,
            params: agentRequest(),
            remoteSessionId: spawn.remoteSessionId,
        };

        const first = await handleHappySpawnSession(options);
        const replay = await handleHappySpawnSession(options);

        expect(replay).toEqual(first);
        expect(spawn.started).toHaveLength(1);
    });

    it("does not remember pending while a new workspace is being prepared", async () => {
        const spawn = spawner("remote-1");
        let attempts = 0;
        spawn.operations.spawnSession = async (_ctx: unknown, request: HappySpawnRequest) => {
            spawn.started.push(request);
            attempts += 1;
            return attempts === 1
                ? { type: "pending" as const }
                : { agentId: "agent-1", type: "ready" as const };
        };
        const options = {
            ctx,
            operations: spawn.operations,
            machineId: "machine-1",
            models: MODELS,
            params: agentRequest({ target: { kind: "newWorkspace", projectId: "project-1" } }),
            remoteSessionId: spawn.remoteSessionId,
        };

        await expect(handleHappySpawnSession(options)).resolves.toEqual({
            clientRequestId: "phone-1",
            retryAfterMs: HAPPY_SPAWN_RETRY_MS,
            type: "pending",
        });
        await expect(handleHappySpawnSession(options)).resolves.toEqual({
            sessionId: "remote-1",
            type: "success",
        });
        expect(spawn.started).toHaveLength(2);
        expect(spawn.started).toEqual([
            expect.objectContaining({ workspaceId: expect.any(String) }),
            expect.objectContaining({ workspaceId: expect.any(String) }),
        ]);
        expect(
            spawn.started.map((request) => ("workspaceId" in request ? request.workspaceId : null)),
        ).toEqual([
            createHappySpawnSessionId("machine-1", "phone-1:workspace"),
            createHappySpawnSessionId("machine-1", "phone-1:workspace"),
        ]);
    });
});
