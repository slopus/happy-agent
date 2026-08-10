import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { isPermissionMode } from "../permissions/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import {
    HAPPY_SPAWN_PENDING_RETRY_AFTER_MS,
    type HappyWorkspaceCreationResult,
} from "../happySpawnTiming.js";
import type { CreateSessionRequest, ModelCatalog } from "../protocol/index.js";
import {
    createHappySpawnSessionId,
    createHappySpawnWorkspaceId,
} from "./createHappySpawnSessionId.js";
import {
    happySpawnSessionRequestSchema,
    type HappySpawnSessionRequest,
    type HappySpawnSessionResult,
} from "./types.js";

export async function handleHappySpawnSession(options: {
    createSession: (id: string, request: CreateSessionRequest) => void | Promise<void>;
    /** Creates the deterministic managed workspace owned by this spawn request. */
    createWorkspace?: (input: {
        directory: string;
        id: string;
        name: string;
        signal?: AbortSignal;
    }) => Promise<HappyWorkspaceCreationResult | undefined>;
    /** Loads an earlier attempt so a retry reuses its committed workspace. */
    loadSession?: (
        id: string,
    ) =>
        | { snapshot(): { cwd: string; workspaceId?: string } }
        | Promise<{ snapshot(): { cwd: string; workspaceId?: string } } | undefined>
        | undefined;
    machineId: string;
    modelCatalog: ModelCatalog;
    params: unknown;
    signal?: AbortSignal;
    waitForRemoteSession: (localSessionId: string) => Promise<string | undefined>;
}): Promise<HappySpawnSessionResult> {
    try {
        const request = readRequest(options.params);
        options.signal?.throwIfAborted();
        const directory = resolveDirectory(request.directory);
        const directoryStatus = await inspectDirectory(directory);
        options.signal?.throwIfAborted();
        if (directoryStatus === "missing" && request.approvedNewDirectoryCreation !== true) {
            return { directory, type: "requestToApproveDirectoryCreation" };
        }
        if (directoryStatus === "missing") await mkdir(directory, { recursive: true });
        options.signal?.throwIfAborted();
        if (directoryStatus === "not-directory") {
            throw new Error("The selected path is not a directory.");
        }

        const providerId = request.providerId ?? options.modelCatalog.defaultProviderId;
        const modelId = request.modelId ?? options.modelCatalog.defaultModelId;
        const provider = options.modelCatalog.providers.find(
            (candidate) => candidate.providerId === providerId,
        );
        const model = provider?.models.find((candidate) => candidate.id === modelId);
        if (provider === undefined || model === undefined) {
            throw new Error("The selected Rig model is unavailable.");
        }
        const effort = request.effort ?? model.defaultThinkingLevel;
        if (!model.thinkingLevels.includes(effort)) {
            throw new Error("The selected reasoning level is unavailable for this model.");
        }
        const permissionMode = request.permissionMode ?? "auto";
        if (!isPermissionMode(permissionMode)) {
            throw new Error("The selected Rig permission mode is unavailable.");
        }
        const localSessionId = createHappySpawnSessionId(
            options.machineId,
            request.clientRequestId,
        );
        const existingSession = (await options.loadSession?.(localSessionId))?.snapshot();
        // Bind the session to its workspace from birth. Both identities derive
        // from the RPC idempotency key, while an already-committed session lets
        // an ordinary pending retry avoid even repeating workspace creation.
        const workspace =
            request.worktree === undefined
                ? undefined
                : existingSession === undefined
                  ? await createRequestedWorkspace(
                        directory,
                        createHappySpawnWorkspaceId(options.machineId, request.clientRequestId),
                        request.worktree.name,
                        options.createWorkspace,
                        options.signal,
                    )
                  : reuseRequestedWorkspace(existingSession);
        options.signal?.throwIfAborted();
        if (workspace?.type === "pending") {
            return {
                clientRequestId: request.clientRequestId,
                retryAfterMs: workspace.retryAfterMs,
                type: "pending",
            };
        }
        await options.createSession(localSessionId, {
            cwd: workspace?.path ?? directory,
            ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
            effort,
            modelId,
            permissionMode,
            providerId,
        });
        const remoteSessionId = await options.waitForRemoteSession(localSessionId);
        if (remoteSessionId === undefined) {
            return {
                clientRequestId: request.clientRequestId,
                retryAfterMs: HAPPY_SPAWN_PENDING_RETRY_AFTER_MS,
                type: "pending",
            };
        }
        return { sessionId: remoteSessionId, type: "success" };
    } catch (error) {
        if (isDatabaseFailure(error)) throw error;
        return {
            errorMessage: error instanceof Error ? error.message : "Rig could not start a session.",
            type: "error",
        };
    }
}

async function createRequestedWorkspace(
    directory: string,
    id: string,
    name: string,
    createWorkspace: Parameters<typeof handleHappySpawnSession>[0]["createWorkspace"],
    signal?: AbortSignal,
): Promise<HappyWorkspaceCreationResult> {
    if (createWorkspace === undefined) {
        throw new Error("This machine cannot create workspaces.");
    }
    const workspace = await createWorkspace({
        directory,
        id,
        name,
        ...(signal === undefined ? {} : { signal }),
    });
    if (workspace === undefined) {
        throw new Error("Open this folder in Rig once before creating a workspace in it.");
    }
    return workspace;
}

function readRequest(value: unknown): HappySpawnSessionRequest {
    if (!Value.Check(happySpawnSessionRequestSchema, value)) {
        if (
            [...Value.Errors(happySpawnSessionRequestSchema, value)].some((error) =>
                error.path.startsWith("/worktree"),
            )
        ) {
            throw new Error("Happy sent an invalid worktree request.");
        }
        throw new Error("Happy sent an unsupported Rig session request.");
    }
    return value;
}

function reuseRequestedWorkspace(existing: { cwd: string; workspaceId?: string }): {
    id: string;
    path: string;
    type: "ready";
} {
    if (existing.workspaceId === undefined) {
        throw new Error("This session request was already used without a workspace.");
    }
    return { id: existing.workspaceId, path: existing.cwd, type: "ready" };
}

function resolveDirectory(value: string): string {
    const expanded =
        value === "~"
            ? homedir()
            : value.startsWith("~/")
              ? resolve(homedir(), value.slice(2))
              : value;
    if (!expanded.startsWith("/")) throw new Error("The session directory must be absolute.");
    return resolve(expanded);
}

async function inspectDirectory(path: string): Promise<"directory" | "missing" | "not-directory"> {
    try {
        return (await stat(path)).isDirectory() ? "directory" : "not-directory";
    } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return "missing";
        throw error;
    }
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
