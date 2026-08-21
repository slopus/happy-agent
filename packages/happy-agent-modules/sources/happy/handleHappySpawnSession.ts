import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isAgentPermissionMode, type AgentPermissionMode } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { createHappySpawnSessionId } from "./createHappySpawnSessionId.js";
import type { HappyModel, HappySpawnRequest } from "./HappySession.js";

/** How long the phone should wait before asking again about a session it is still owed. */
export const HAPPY_SPAWN_RETRY_MS = 2_000;

/**
 * What starting a session from a phone asks of the module it belongs to.
 *
 * The directory has already been checked and created here, and the model, reasoning level and
 * permission mode have already been settled against what this daemon actually offers. What is left
 * is opening the session, which is the daemon's own business; failing at that is a real failure,
 * so it throws.
 */
export interface HappySpawnOperations {
    spawnSession: (ctx: Context, request: HappySpawnRequest) => Promise<{ agentId: string }>;
}

/** How starting a session from the phone turned out. */
export type HappySpawnResult =
    | { readonly type: "success"; readonly sessionId: string }
    | {
          readonly type: "pending";
          readonly clientRequestId: string;
          readonly retryAfterMs: number;
      }
    | { readonly type: "requestToApproveDirectoryCreation"; readonly directory: string }
    | { readonly type: "error"; readonly errorMessage: string };

const spawnRequestSchema = Type.Object(
    {
        agent: Type.Literal("rig"),
        approvedNewDirectoryCreation: Type.Optional(Type.Boolean()),
        clientRequestId: Type.String({ maxLength: 256, minLength: 1 }),
        directory: Type.String({ maxLength: 32_768, minLength: 1 }),
        effort: Type.Optional(Type.String({ maxLength: 256 })),
        modelId: Type.Optional(Type.String({ maxLength: 256 })),
        permissionMode: Type.Optional(Type.String({ maxLength: 256 })),
        providerId: Type.Optional(Type.String({ maxLength: 256 })),
        type: Type.Literal("spawn-in-directory"),
    },
    { additionalProperties: true },
);

/**
 * Starts a session because somebody asked for one from their phone.
 *
 * Creating a directory on somebody's computer is not something to do quietly,
 * so a directory that does not exist is reported back and only created once the
 * person has said yes. Everything else that can be wrong — a model this daemon
 * does not have, a reasoning level that model does not offer — is answered as a
 * plain refusal rather than a silent substitution, because a session running on
 * something other than what was asked for is worse than no session.
 */
export async function handleHappySpawnSession(options: {
    ctx: Context;
    operations: HappySpawnOperations;
    machineId: string;
    models: readonly HappyModel[];
    params: unknown;
    remoteSessionId: (agentId: string) => Promise<string | undefined>;
    signal?: AbortSignal;
}): Promise<HappySpawnResult> {
    try {
        if (!Value.Check(spawnRequestSchema, options.params)) {
            throw new Error("Happy asked for a session Happy Agent does not know how to start.");
        }
        const request = options.params;
        options.signal?.throwIfAborted();
        const directory = resolveDirectory(request.directory);
        const found = await inspectDirectory(directory);
        options.signal?.throwIfAborted();
        if (found === "not-directory") throw new Error("That path is not a directory.");
        if (found === "missing" && request.approvedNewDirectoryCreation !== true) {
            return { directory, type: "requestToApproveDirectoryCreation" };
        }
        if (found === "missing") await mkdir(directory, { recursive: true });
        options.signal?.throwIfAborted();

        const model = chooseModel(options.models, request.modelId, request.providerId);
        const effort = request.effort ?? model.defaultEffort;
        if (!model.effortLevels.includes(effort)) {
            throw new Error("That reasoning level is not available for this model.");
        }
        const permissionMode = request.permissionMode ?? "auto";
        if (!isAgentPermissionMode(permissionMode)) {
            throw new Error("That permission mode is not one Happy Agent has.");
        }
        const sessionId = createHappySpawnSessionId(options.machineId, request.clientRequestId);
        options.signal?.throwIfAborted();
        const started = await options.operations.spawnSession(options.ctx, {
            cwd: directory,
            effort,
            modelId: model.id,
            permissionMode: permissionMode as AgentPermissionMode,
            providerId: model.providerId,
            sessionId,
        });
        // Happy cannot open a session it has not been told about yet, so a session
        // whose remote identity is still being created is reported as owed.
        const remoteSessionId = await options.remoteSessionId(started.agentId);
        if (remoteSessionId === undefined) {
            return {
                clientRequestId: request.clientRequestId,
                retryAfterMs: HAPPY_SPAWN_RETRY_MS,
                type: "pending",
            };
        }
        return { sessionId: remoteSessionId, type: "success" };
    } catch (error) {
        return {
            errorMessage:
                error instanceof Error
                    ? error.message
                    : "Happy Agent could not start that session.",
            type: "error",
        };
    }
}

function chooseModel(
    models: readonly HappyModel[],
    modelId: string | undefined,
    providerId: string | undefined,
): HappyModel {
    const wanted = models.find(
        (model) =>
            (modelId === undefined || model.id === modelId) &&
            (providerId === undefined || model.providerId === providerId),
    );
    if (wanted === undefined) throw new Error("That model is not available in this Happy Agent.");
    return wanted;
}

function resolveDirectory(value: string): string {
    const expanded =
        value === "~"
            ? homedir()
            : value.startsWith("~/")
              ? resolve(homedir(), value.slice(2))
              : value;
    if (!expanded.startsWith("/")) throw new Error("A session directory must be an absolute path.");
    return resolve(expanded);
}

async function inspectDirectory(path: string): Promise<"directory" | "missing" | "not-directory"> {
    try {
        return (await stat(path)).isDirectory() ? "directory" : "not-directory";
    } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            return "missing";
        }
        throw error;
    }
}
