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
import type { HappyModel, HappySpawnRequest } from "../../sources/happy/index.js";

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
    return {
        started,
        operations: {
            spawnSession: async (_ctx: unknown, request: HappySpawnRequest) => {
                started.push(request);
                return { agentId: "agent-1" };
            },
        },
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
        expect(spawn.started[0]?.cwd).toBe(missing);
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
