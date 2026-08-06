import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createHappyPluginClient } from "./createHappyPluginClient.js";
import { happyComputeErrorStatus, normalizeHappyComputeError } from "./computeErrorSemantics.js";
import {
    HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
    HAPPY_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS,
    HAPPY_COMPUTE_MAX_PROVISIONING_TIMEOUT_MS,
    HAPPY_COMPUTE_PROVISIONING_ACK_TIMEOUT_MS,
    createHappyComputeBodySchema,
    execHappyComputeBodySchema,
    happyComputeCallCompletionSchema,
    happyComputeProvisioningProgressSchema,
    readHappyComputeBodySchema,
    registerHappyComputeProviderInputSchema,
    writeHappyComputeBodySchema,
    type HappyComputeCallCompletion,
    type HappyComputeError,
    type HappyComputeEvent,
    type HappyComputeInstanceState,
    type HappyComputePreparationEvent,
    type HappyComputePreparationPhase,
    type HappyComputeProvisioningProgress,
    type HappyComputeWorkspaceSource,
} from "./computeTypes.js";
import { normalizeHappyMcpName } from "./createHappyMcpToolName.js";
import { createPluginWorkspaceCommandExecutor } from "./createPluginWorkspaceCommandExecutor.js";
import { happyMcpCompletionToResult } from "./happyMcpCompletionToResult.js";
import {
    classifyPluginApiRequestError,
    PluginApiRequestError,
    PluginApiRequestTooLargeError,
} from "./pluginApiRequestErrors.js";
import {
    assertHappyPluginStorageKey,
    assertHappyPluginStorageQuota,
    decodeHappyPluginStorageValue,
    encodeHappyPluginStorageValue,
} from "./pluginAppStorage.js";
import { readPluginWorkspaceFile } from "./readPluginWorkspaceFile.js";
import type {
    HappyMcpServerRegistration,
    HappyMcpToolResult,
    HappyNetworkRequest,
    HappyNetworkRequestCompletion,
    HappyNetworkRequestResult,
    HappyNetworkTunnel,
    HappyPlugin,
    HappyPluginClient,
    HappyPluginTestRequest,
    HappyPluginTestSeed,
    HappyProject,
    HappySession,
    HappySystemPromptHookInput,
    HappySystemPromptHookResult,
    HappyTracingEvent,
    HappyWorkspace,
    HappyWorkspaceEvent,
} from "./types.js";
import {
    HAPPY_PLUGIN_MAX_STORAGE_KEYS,
    HAPPY_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS,
    archiveWorkspaceBodySchema,
    createSessionInputSchema,
    createWorkspaceBodySchema,
    executeWorkspaceCommandBodySchema,
    happyMcpCallCompletionSchema,
    happyMcpServerRegistrationSchema,
    happyNetworkRequestCompletionSchema,
    happyPluginReadyBodySchema,
    happySystemPromptHookCompletionSchema,
    updateHappyPluginStatusBodySchema,
    happyPluginTestSeedSchema,
    listWorkspacesInputSchema,
    readWorkspaceFileBodySchema,
    renameWorkspaceBodySchema,
    sendAgentMessageBodySchema,
    writeWorkspaceFileBodySchema,
} from "./types.js";
import { writePluginWorkspaceFile } from "./writePluginWorkspaceFile.js";

const CALL_TIMEOUT_MS = 10_000;
const MAXIMUM_COMPUTE_COMPLETION_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BODY_BYTES = 1024 * 1024;

export interface HappyPluginTestHost {
    readonly apps: {
        callTool(
            server: string,
            tool: string,
            argumentsValue?: unknown,
            options?: { signal?: AbortSignal; timeoutMs?: number },
        ): Promise<HappyMcpToolResult>;
        readonly storage: {
            delete(key: string): Promise<void>;
            get(key: string): Promise<unknown | undefined>;
            list(): Promise<readonly string[]>;
            set(key: string, value: unknown): Promise<void>;
        };
    };
    readonly client: HappyPluginClient;
    readonly compute: {
        /** Simulates the owning provider process or stream ending. */
        disconnectProvider(mode?: "close" | "end" | "error"): void;
        waitForProvider(timeoutMs?: number): Promise<void>;
    };
    readonly environment: Readonly<{
        HAPPY_PLUGIN_DIRECTORY: string;
        HAPPY_PLUGIN_SOCKET_PATH: string;
        HAPPY_PLUGIN_TOKEN: string;
    }>;
    readonly mcp: {
        callTool(
            server: string,
            tool: string,
            argumentsValue?: unknown,
            options?: { signal?: AbortSignal; timeoutMs?: number },
        ): Promise<HappyMcpToolResult>;
        /** Simulates an unexpected daemon stream end for recovery tests. */
        disconnectServers(mode?: "close" | "end" | "error"): void;
        listTools(): readonly {
            description: string;
            inputSchema: unknown;
            server: string;
            tool: string;
        }[];
        waitForTools(count?: number, timeoutMs?: number): Promise<void>;
    };
    readonly network: {
        request(
            request: Omit<HappyNetworkRequest, "mode">,
            options?: { timeoutMs?: number },
        ): Promise<HappyNetworkRequestResult>;
        tunnel(tunnel: HappyNetworkTunnel): void;
    };
    readonly hooks: {
        applySystemPrompt(
            input: HappySystemPromptHookInput,
            timeoutMs?: number,
        ): Promise<HappySystemPromptHookResult>;
        /** Simulates an unexpected daemon stream end for recovery tests. */
        disconnect(mode?: "close" | "end" | "error"): void;
    };
    readonly requests: readonly HappyPluginTestRequest[];
    readonly rootDirectory: string;
    readonly tracing: {
        /** Simulates an unexpected daemon stream end for recovery tests. */
        disconnect(mode?: "close" | "end" | "error"): void;
        emit(event: HappyTracingEvent): void;
    };
    close(): Promise<void>;
}

export interface CreateHappyPluginTestHostOptions {
    /** Receives each validated SDK request as it reaches the fake host. */
    onRequest?: (request: HappyPluginTestRequest) => void;
    /** Parent for the short-lived host root. Defaults to the operating-system temp directory. */
    temporaryDirectory?: string;
}

interface TestRegistration {
    id: string;
    response?: ServerResponse;
    server: HappyMcpServerRegistration;
}

interface TestEventRegistration {
    id: string;
    response?: ServerResponse;
}

interface TestCall<T> {
    cleanup(): void;
    reject(error: Error): void;
    resolve(result: T): void;
}

interface TestNetworkRegistration {
    id: string;
    response?: ServerResponse;
    type: "request" | "tunnel";
}

interface TestComputeRegistration {
    id: string;
    provisioningTimeoutMs: number;
    response?: ServerResponse;
}

interface TestComputeCall extends TestCall<HappyComputeCallCompletion> {
    acknowledgment:
        | { status: "acknowledged" }
        | { status: "awaiting_acknowledgment" }
        | { status: "not_required" };
    acknowledge(): void;
    operation: Extract<HappyComputeEvent, { type: "call" }>["operation"];
    progress?: (progress: HappyComputeProvisioningProgress) => void;
}

type TestComputeInstanceBase = {
    createdAt: number;
    id: string;
    provider: string;
    workspaceSource: HappyComputeWorkspaceSource;
};

type TestComputeInstance =
    | (TestComputeInstanceBase & { reason?: string; state: "unprovisioned" })
    | (TestComputeInstanceBase & {
          lastProgressAt: number;
          message: string;
          percent?: number;
          phase: HappyComputePreparationPhase;
          providerInstanceId?: string;
          registrationId?: string;
          startedAt: number;
          state: "provisioning";
      })
    | (TestComputeInstanceBase & {
          providerInstanceId: string;
          registrationId: string;
          state: "ready";
      })
    | (TestComputeInstanceBase & {
          diedAt: number;
          reason: string;
          state: "failed";
      })
    | (TestComputeInstanceBase & {
          diedAt: number;
          reason: string;
          state: "stopped";
      });

/** Starts an in-memory, Unix-socket Happy host for plugin tests and local authoring. */
export async function createHappyPluginTestHost(
    seed: HappyPluginTestSeed = {},
    options: CreateHappyPluginTestHostOptions = {},
): Promise<HappyPluginTestHost> {
    Value.Assert(happyPluginTestSeedSchema, seed);
    // macOS caps Unix socket paths near 104 bytes. The OS temp root plus this deliberately short
    // generated name keeps the authenticated socket well below that limit without touching the
    // plugin's authored source folder.
    const root = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "hp-"));
    const socketPath = join(root, "h.sock");
    const pluginDirectory = join(root, "data");
    await mkdir(pluginDirectory, { mode: 0o700, recursive: true });
    const token = randomBytes(24).toString("base64url");
    const projects: HappyProject[] = structuredClone(seed.projects ?? []);
    const workspaces: HappyWorkspace[] = structuredClone(seed.workspaces ?? []);
    const sessions: HappySession[] = structuredClone(seed.sessions ?? []);
    const providerUsage = structuredClone(seed.providerUsage ?? []);
    const plugins: HappyPlugin[] = structuredClone(seed.plugins ?? []);
    const declaredCompute = structuredClone(seed.computeProvider);
    const requests: HappyPluginTestRequest[] = [];
    const registrations = new Map<string, TestRegistration>();
    let ready = false;
    let pluginStatus: string | undefined;
    let systemPromptHook: TestEventRegistration | undefined;
    let tracingSubscription: TestEventRegistration | undefined;
    const systemPromptCalls = new Map<string, TestCall<HappySystemPromptHookResult>>();
    const calls = new Map<string, TestCall<HappyMcpToolResult>>();
    const computeCalls = new Map<string, TestComputeCall>();
    const computeEventResponses = new Set<ServerResponse>();
    const workspaceEventResponses = new Set<ServerResponse>();
    const workspaceCompletions = new Set<Promise<void>>();
    const computeInstances = new Map<string, TestComputeInstance>();
    let computeRegistration: TestComputeRegistration | undefined;
    const computeWaiters = new Set<() => void>();
    const networkCalls = new Map<string, TestCall<HappyNetworkRequestCompletion>>();
    const networkRegistrations = new Map<string, TestNetworkRegistration>();
    const appStorage = new Map<string, string>();
    const executeWorkspaceCommand = createPluginWorkspaceCommandExecutor();
    let nextId = 1;
    const nextComputeCallId = () => `test-compute-call-${String(nextId++)}`;
    let closed = false;
    const toolWaiters = new Set<() => void>();
    const activeToolCount = () =>
        [...registrations.values()]
            .filter((registration) => registration.response !== undefined)
            .reduce((count, registration) => count + registration.server.tools.length, 0);

    const publishWorkspaceEvent = (
        type: HappyWorkspaceEvent["type"],
        workspace: HappyWorkspace,
    ) => {
        const event: HappyWorkspaceEvent = { type, workspace };
        for (const response of workspaceEventResponses) {
            if (!response.destroyed && !response.writableEnded) {
                response.write(`${JSON.stringify(event)}\n`);
            }
        }
    };

    const publishComputeEvent = (
        instance: TestComputeInstance,
        phase: HappyComputePreparationPhase,
        message: string,
        state: HappyComputePreparationEvent["state"],
        error?: HappyComputeError,
    ): void => {
        const event: HappyComputePreparationEvent = {
            createdAt: Date.now(),
            ...(instance.state === "provisioning"
                ? {
                      elapsedMs: Math.max(0, Date.now() - instance.startedAt),
                      lastProgressAt: instance.lastProgressAt,
                      ...(instance.percent === undefined ? {} : { percent: instance.percent }),
                      startedAt: instance.startedAt,
                  }
                : {}),
            ...(error === undefined ? {} : { error }),
            instanceId: instance.id,
            message,
            phase,
            provider: instance.provider,
            state,
            type: "compute_preparation",
        };
        for (const response of computeEventResponses) {
            if (!response.destroyed && !response.writableEnded) {
                response.write(`${JSON.stringify(event)}\n`);
            }
        }
    };

    const provisionTestCompute = async (instanceId: string): Promise<void> => {
        let instance = computeInstances.get(instanceId);
        if (instance?.state !== "provisioning") return;
        const registration = computeRegistration;
        if (registration?.response === undefined || declaredCompute?.name !== instance.provider) {
            const failed: TestComputeInstance = {
                createdAt: instance.createdAt,
                id: instance.id,
                provider: instance.provider,
                reason: `No running compute provider is named "${instance.provider}".`,
                state: "unprovisioned",
                workspaceSource: instance.workspaceSource,
            };
            computeInstances.set(instance.id, failed);
            publishComputeEvent(instance, "failed", failed.reason!, "unprovisioned", {
                code: "preparing_compute",
                message: failed.reason!,
                retryable: true,
                state: "unprovisioned",
            });
            return;
        }
        instance = { ...instance, registrationId: registration.id };
        computeInstances.set(instance.id, instance);
        const deadlineAt = Date.now() + registration.provisioningTimeoutMs;
        try {
            const completion = await invokeTestCompute(
                registration,
                computeCalls,
                nextComputeCallId,
                {
                    operation: "start",
                    workspaceSource: instance.workspaceSource,
                },
                remainingTestComputeDeadline(deadlineAt),
                (progress) => {
                    const current = computeInstances.get(instanceId);
                    if (current?.state !== "provisioning") return;
                    const { percent: _previousPercent, ...withoutPercent } = current;
                    const next: TestComputeInstance = {
                        ...withoutPercent,
                        lastProgressAt: Date.now(),
                        message: progress.message,
                        ...(progress.percent === undefined ? {} : { percent: progress.percent }),
                        phase: progress.phase,
                    };
                    computeInstances.set(current.id, next);
                    publishComputeEvent(next, progress.phase, progress.message, "provisioning");
                },
                HAPPY_COMPUTE_PROVISIONING_ACK_TIMEOUT_MS,
            );
            if ("error" in completion) throw new Error(completion.error.message);
            if (completion.operation !== "start") {
                throw new Error("The test compute provider returned the wrong operation result.");
            }
            const current = computeInstances.get(instance.id);
            if (current?.state !== "provisioning") return;
            const verificationMessage = "Verifying that the compute is ready.";
            instance = {
                ...current,
                lastProgressAt: Date.now(),
                message: verificationMessage,
                phase: "verifying_compute",
                providerInstanceId: completion.result.instanceId,
                registrationId: registration.id,
            };
            computeInstances.set(instance.id, instance);
            publishComputeEvent(instance, "verifying_compute", verificationMessage, "provisioning");
            const probe = await invokeTestCompute(
                registration,
                computeCalls,
                nextComputeCallId,
                {
                    command: "true",
                    instanceId: completion.result.instanceId,
                    operation: "exec",
                    timeoutMs: Math.min(5_000, remainingTestComputeDeadline(deadlineAt)),
                },
                remainingTestComputeDeadline(deadlineAt),
            );
            if ("error" in probe) throw new Error(probe.error.message);
            if (probe.operation !== "exec") {
                throw new Error(
                    "The test compute provider returned the wrong readiness probe result.",
                );
            }
            if (probe.result.exitCode !== 0 || probe.result.timedOut) {
                throw new Error("The test compute instance readiness probe did not succeed.");
            }
            const verified = computeInstances.get(instance.id);
            if (verified?.state !== "provisioning") return;
            const readyInstance: TestComputeInstance = {
                createdAt: verified.createdAt,
                id: verified.id,
                provider: verified.provider,
                providerInstanceId: completion.result.instanceId,
                registrationId: registration.id,
                state: "ready",
                workspaceSource: verified.workspaceSource,
            };
            computeInstances.set(instance.id, readyInstance);
            publishComputeEvent(readyInstance, "ready", "Compute is ready.", "ready");
        } catch (error) {
            const current = computeInstances.get(instance.id);
            if (current?.state !== "provisioning") return;
            const failed: TestComputeInstance = {
                createdAt: current.createdAt,
                id: current.id,
                provider: current.provider,
                reason: `Compute provisioning failed. ${error instanceof Error ? error.message : String(error)}`,
                state: "unprovisioned",
                workspaceSource: current.workspaceSource,
            };
            computeInstances.set(current.id, failed);
            publishComputeEvent(current, "failed", failed.reason!, "unprovisioned", {
                code: "preparing_compute",
                message: failed.reason!,
                retryable: true,
                state: "unprovisioned",
            });
        }
    };

    const server = createServer((request, response) => {
        void (async () => {
            if (request.headers.authorization !== `Bearer ${token}`) {
                send(response, 401, { error: "This plugin connection is not authorized." });
                return;
            }
            const url = new URL(request.url ?? "/", "http://happy-plugin.test");
            const requestHasNoBody =
                request.method === "GET" ||
                request.method === "DELETE" ||
                (request.method === "POST" &&
                    (url.pathname.endsWith("/stop") ||
                        url.pathname.endsWith("/acknowledge") ||
                        url.pathname === "/hooks/system-prompt" ||
                        url.pathname === "/tracing/subscriptions"));
            const body = requestHasNoBody
                ? undefined
                : await readBody(
                      request,
                      url.pathname.startsWith("/compute/providers/") &&
                          url.pathname.includes("/calls/")
                          ? MAXIMUM_COMPUTE_COMPLETION_BYTES
                          : url.pathname.endsWith("/files/write")
                            ? 2 * MAXIMUM_BODY_BYTES
                            : MAXIMUM_BODY_BYTES,
                  );
            const observedRequest = {
                ...(body === undefined ? {} : { body: structuredClone(body) }),
                method: request.method ?? "GET",
                path: `${url.pathname}${url.search}`,
            };
            requests.push(observedRequest);
            options.onRequest?.(structuredClone(observedRequest));
            const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

            if (request.method === "POST" && url.pathname === "/ready") {
                const readiness = decodeRequest(
                    happyPluginReadyBodySchema,
                    body,
                    "Plugin readiness",
                );
                if (ready)
                    throw new Error("The fake Happy host already received plugin readiness.");
                if (declaredCompute !== undefined && computeRegistration?.response === undefined) {
                    throw new Error(
                        "The manifest-declared compute provider must register and attach before the plugin reports ready.",
                    );
                }
                pluginStatus = readiness.status;
                ready = true;
                send(response, 200, {});
                return;
            }
            if (request.method === "POST" && url.pathname === "/status") {
                pluginStatus = decodeRequest(
                    updateHappyPluginStatusBodySchema,
                    body,
                    "Plugin status",
                ).status;
                send(response, 200, {});
                return;
            }
            if (request.method === "GET" && url.pathname === "/projects") {
                send(response, 200, { projects });
                return;
            }
            if (request.method === "GET" && url.pathname === "/workspaces") {
                const input = decodeRequest(
                    listWorkspacesInputSchema,
                    url.searchParams.has("projectId")
                        ? { projectId: url.searchParams.get("projectId") }
                        : {},
                    "Workspace list settings",
                );
                send(response, 200, {
                    workspaces:
                        input.projectId === undefined
                            ? workspaces
                            : workspaces.filter(
                                  (workspace) => workspace.projectId === input.projectId,
                              ),
                });
                return;
            }
            if (request.method === "GET" && url.pathname === "/workspaces/events") {
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                workspaceEventResponses.add(response);
                response.once("close", () => workspaceEventResponses.delete(response));
                return;
            }
            if (request.method === "GET" && url.pathname === "/sessions") {
                send(response, 200, { sessions });
                return;
            }
            if (request.method === "GET" && url.pathname === "/provider-usage") {
                send(response, 200, { providers: providerUsage });
                return;
            }
            if (request.method === "GET" && url.pathname === "/plugins") {
                send(response, 200, {
                    plugins: plugins.map((plugin) =>
                        plugin.isSelf && pluginStatus !== undefined
                            ? { ...plugin, status: pluginStatus }
                            : plugin,
                    ),
                });
                return;
            }
            if (request.method === "GET" && url.pathname === "/compute/providers") {
                send(response, 200, {
                    providers:
                        computeRegistration?.response === undefined || declaredCompute === undefined
                            ? []
                            : [
                                  {
                                      health: "healthy",
                                      name: declaredCompute.name,
                                      pluginFolder: "test-plugin",
                                      pluginName: "Test Plugin",
                                      provisioningTimeoutMs:
                                          computeRegistration.provisioningTimeoutMs,
                                  },
                              ],
                });
                return;
            }
            if (request.method === "GET" && url.pathname === "/compute/events") {
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                computeEventResponses.add(response);
                response.once("close", () => computeEventResponses.delete(response));
                return;
            }
            if (request.method === "GET" && url.pathname === "/compute/instances") {
                send(response, 200, {
                    instances: [...computeInstances.values()].map((instance) => {
                        const base = {
                            createdAt: instance.createdAt,
                            instanceId: instance.id,
                            provider: instance.provider,
                        };
                        switch (instance.state) {
                            case "unprovisioned":
                                return {
                                    ...base,
                                    ...(instance.reason === undefined
                                        ? {}
                                        : { reason: instance.reason }),
                                    state: instance.state,
                                };
                            case "provisioning":
                            case "ready":
                                return { ...base, state: instance.state };
                            case "failed":
                            case "stopped":
                                return {
                                    ...base,
                                    diedAt: instance.diedAt,
                                    reason: instance.reason,
                                    state: instance.state,
                                };
                        }
                    }),
                });
                return;
            }
            if (request.method === "POST" && url.pathname === "/compute/providers") {
                if (ready) {
                    throw new Error(
                        "Compute provider registration must be declared before the plugin reports ready.",
                    );
                }
                if (declaredCompute === undefined) {
                    send(response, 400, {
                        code: "invalid_request",
                        message: "The test host has no manifest-declared compute provider.",
                        retryable: false,
                    });
                    return;
                }
                if (computeRegistration !== undefined) {
                    send(response, 400, {
                        code: "invalid_request",
                        message: "The test compute provider is already registered.",
                        retryable: false,
                    });
                    return;
                }
                const registrationInput = decodeRequest(
                    registerHappyComputeProviderInputSchema,
                    body,
                    "Compute provider registration",
                );
                computeRegistration = {
                    id: `test-compute-${String(nextId++)}`,
                    provisioningTimeoutMs: Math.min(
                        registrationInput.provisioningTimeoutMs ??
                            HAPPY_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS,
                        HAPPY_COMPUTE_MAX_PROVISIONING_TIMEOUT_MS,
                    ),
                };
                send(response, 201, { registrationId: computeRegistration.id });
                return;
            }
            if (
                request.method === "GET" &&
                parts.length === 4 &&
                parts[0] === "compute" &&
                parts[1] === "providers" &&
                computeRegistration !== undefined &&
                parts[2] === computeRegistration?.id &&
                parts[3] === "events"
            ) {
                if (ready) {
                    throw new Error(
                        "Compute provider stream attachment must be declared before the plugin reports ready.",
                    );
                }
                const registration = computeRegistration;
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                registration.response = response;
                response.once("close", () => {
                    if (computeRegistration !== registration) return;
                    computeRegistration = undefined;
                    failTestComputeGeneration(
                        registration.id,
                        "The test compute provider generation ended.",
                        computeInstances,
                        computeCalls,
                        publishComputeEvent,
                    );
                });
                for (const notify of computeWaiters) notify();
                computeWaiters.clear();
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 6 &&
                parts[0] === "compute" &&
                parts[1] === "providers" &&
                parts[2] === computeRegistration?.id &&
                parts[3] === "calls" &&
                parts[4] !== undefined &&
                parts[5] === "acknowledge"
            ) {
                const call = computeCalls.get(parts[4]);
                if (call?.operation !== "start") {
                    send(response, 400, {
                        code: "invalid_request",
                        message:
                            "That compute provisioning call is no longer awaiting acknowledgment.",
                        retryable: false,
                    });
                    return;
                }
                call.acknowledge();
                send(response, 200, {});
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 6 &&
                parts[0] === "compute" &&
                parts[1] === "providers" &&
                parts[2] === computeRegistration?.id &&
                parts[3] === "calls" &&
                parts[4] !== undefined &&
                parts[5] === "progress"
            ) {
                const call = computeCalls.get(parts[4]);
                if (call?.operation !== "start" || call.progress === undefined) {
                    send(response, 400, {
                        code: "invalid_request",
                        message: "That compute provisioning call is no longer active.",
                        retryable: false,
                    });
                    return;
                }
                call.acknowledge();
                call.progress(
                    decodeRequest(
                        happyComputeProvisioningProgressSchema,
                        body,
                        "Compute provisioning progress",
                    ),
                );
                send(response, 200, {});
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 5 &&
                parts[0] === "compute" &&
                parts[1] === "providers" &&
                parts[2] === computeRegistration?.id &&
                parts[3] === "calls" &&
                parts[4] !== undefined
            ) {
                const call = computeCalls.get(parts[4]);
                if (call === undefined) {
                    send(response, 400, {
                        code: "invalid_request",
                        message: "That compute call is no longer active.",
                        retryable: false,
                    });
                    return;
                }
                call.acknowledge();
                const completion = decodeRequest(
                    happyComputeCallCompletionSchema,
                    body,
                    "Compute provider result",
                );
                if ("operation" in completion && completion.operation !== call.operation) {
                    send(response, 502, {
                        code: "invalid_response",
                        message: `The provider completed a ${call.operation} compute call with a ${completion.operation} result.`,
                        retryable: false,
                    });
                    return;
                }
                computeCalls.delete(parts[4]);
                call.resolve(completion);
                send(response, 200, {});
                return;
            }
            if (
                request.method === "DELETE" &&
                parts.length === 3 &&
                parts[0] === "compute" &&
                parts[1] === "providers" &&
                computeRegistration !== undefined &&
                parts[2] === computeRegistration?.id
            ) {
                const registration = computeRegistration;
                computeRegistration = undefined;
                registration.response?.end();
                failTestComputeGeneration(
                    registration.id,
                    "The test compute provider generation ended.",
                    computeInstances,
                    computeCalls,
                    publishComputeEvent,
                );
                send(response, 200, {});
                return;
            }
            if (request.method === "POST" && url.pathname === "/compute/instances") {
                const input = decodeRequest(
                    createHappyComputeBodySchema,
                    body,
                    "Compute instance settings",
                );
                const instanceId = `test-compute-instance-${String(nextId++)}`;
                computeInstances.set(instanceId, {
                    createdAt: Date.now(),
                    id: instanceId,
                    provider: input.provider,
                    state: "unprovisioned",
                    workspaceSource: input.workspaceSource,
                });
                send(response, 201, {
                    createdAt: computeInstances.get(instanceId)!.createdAt,
                    instanceId,
                    provider: input.provider,
                    state: "unprovisioned",
                });
                return;
            }
            if (
                request.method === "POST" &&
                parts.length >= 4 &&
                parts[0] === "compute" &&
                parts[1] === "instances" &&
                parts[2] !== undefined
            ) {
                const instance = computeInstances.get(parts[2]);
                if (instance === undefined) {
                    send(response, 404, {
                        code: "instance_not_found",
                        message: "That compute instance was not found.",
                        retryable: false,
                    });
                    return;
                }
                const registration = computeRegistration;
                if (parts.length === 4 && parts[3] === "stop") {
                    if (instance.state === "failed" || instance.state === "stopped") {
                        send(response, 409, {
                            code: "instance_failed",
                            message: instance.reason,
                            retryable: false,
                            state: instance.state,
                        });
                        return;
                    }
                    const reason = "The test compute instance was stopped by its consumer.";
                    const stopped: TestComputeInstance = {
                        ...instance,
                        diedAt: Date.now(),
                        reason,
                        state: "stopped",
                    };
                    computeInstances.set(instance.id, stopped);
                    if (instance.state === "unprovisioned" || instance.state === "provisioning") {
                        publishComputeEvent(
                            instance,
                            "stopped",
                            `Compute preparation stopped. ${reason}`,
                            "stopped",
                        );
                    }
                    if (
                        instance.state !== "unprovisioned" &&
                        instance.providerInstanceId !== undefined &&
                        registration?.response !== undefined &&
                        registration.id === instance.registrationId
                    ) {
                        await invokeTestCompute(registration, computeCalls, nextComputeCallId, {
                            instanceId: instance.providerInstanceId,
                            operation: "stop",
                        }).catch(() => undefined);
                        // Provider notification is best-effort. Registry release is unconditional.
                    }
                    send(response, 200, {});
                    return;
                }
                if (instance.state === "unprovisioned") {
                    const preparationMessage =
                        instance.reason === undefined
                            ? "Preparing compute for its first use."
                            : `Preparing compute again. The previous attempt failed: ${instance.reason}`;
                    const startedAt = Date.now();
                    const provisioning: TestComputeInstance = {
                        createdAt: instance.createdAt,
                        id: instance.id,
                        lastProgressAt: startedAt,
                        message: preparationMessage,
                        phase: "preparing_compute",
                        provider: instance.provider,
                        state: "provisioning",
                        startedAt,
                        workspaceSource: instance.workspaceSource,
                    };
                    computeInstances.set(instance.id, provisioning);
                    publishComputeEvent(
                        provisioning,
                        "preparing_compute",
                        preparationMessage,
                        "provisioning",
                    );
                    queueMicrotask(() => {
                        void provisionTestCompute(instance.id);
                    });
                    send(response, 409, {
                        code: "preparing_compute",
                        elapsedMs: 0,
                        lastProgressAt: provisioning.lastProgressAt,
                        message: preparationMessage,
                        phase: provisioning.phase,
                        retryable: true,
                        startedAt: provisioning.startedAt,
                        state: "provisioning",
                    });
                    return;
                }
                if (instance.state === "provisioning") {
                    send(response, 409, {
                        code: "preparing_compute",
                        elapsedMs: Math.max(0, Date.now() - instance.startedAt),
                        lastProgressAt: instance.lastProgressAt,
                        message: instance.message,
                        ...(instance.percent === undefined ? {} : { percent: instance.percent }),
                        phase: instance.phase,
                        retryable: true,
                        startedAt: instance.startedAt,
                        state: "provisioning",
                    });
                    return;
                }
                if (instance.state === "failed" || instance.state === "stopped") {
                    send(response, 409, {
                        code: "instance_failed",
                        message: instance.reason,
                        retryable: false,
                        state: instance.state,
                    });
                    return;
                }
                if (
                    registration?.response === undefined ||
                    registration.id !== instance.registrationId
                ) {
                    computeInstances.set(instance.id, {
                        ...instance,
                        diedAt: Date.now(),
                        reason: "That compute instance belongs to a stale generation.",
                        state: "failed",
                    });
                    send(response, 409, {
                        code: "instance_failed",
                        message: "That compute instance belongs to a stale generation.",
                        retryable: false,
                        state: "failed",
                    });
                    return;
                }
                if (parts.length === 5 && parts[3] === "files" && parts[4] === "read") {
                    const input = decodeRequest(
                        readHappyComputeBodySchema,
                        body,
                        "Compute file read settings",
                    );
                    const completion = await invokeTestCompute(
                        registration,
                        computeCalls,
                        nextComputeCallId,
                        {
                            instanceId: instance.providerInstanceId,
                            operation: "read",
                            path: input.path,
                        },
                    );
                    if ("error" in completion) {
                        sendTestComputeError(response, completion.error, "ready");
                        return;
                    }
                    send(response, 200, completion.result);
                    return;
                }
                if (parts.length === 5 && parts[3] === "files" && parts[4] === "write") {
                    const input = decodeRequest(
                        writeHappyComputeBodySchema,
                        body,
                        "Compute file write settings",
                    );
                    const completion = await invokeTestCompute(
                        registration,
                        computeCalls,
                        nextComputeCallId,
                        {
                            contentBase64: input.contentBase64,
                            instanceId: instance.providerInstanceId,
                            operation: "write",
                            path: input.path,
                        },
                    );
                    if ("error" in completion) {
                        sendTestComputeError(response, completion.error, "ready");
                        return;
                    }
                    send(response, 200, {});
                    return;
                }
                if (parts.length === 4 && parts[3] === "exec") {
                    const input = decodeRequest(
                        execHappyComputeBodySchema,
                        body,
                        "Compute command settings",
                    );
                    const completion = await invokeTestCompute(
                        registration,
                        computeCalls,
                        nextComputeCallId,
                        {
                            command: input.command,
                            instanceId: instance.providerInstanceId,
                            operation: "exec",
                            timeoutMs: input.timeoutMs ?? HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
                        },
                        (input.timeoutMs ?? HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS) + 2_000,
                    );
                    if ("error" in completion) {
                        sendTestComputeError(response, completion.error, "ready");
                        return;
                    }
                    send(response, 200, completion.result);
                    return;
                }
            }
            if (
                request.method === "POST" &&
                parts.length >= 3 &&
                parts[0] === "workspaces" &&
                parts[1] !== undefined
            ) {
                const workspace = workspaces.find((candidate) => candidate.id === parts[1]);
                if (workspace === undefined) {
                    send(response, 404, { error: "Workspace not found." });
                    return;
                }
                if (workspace.status !== "ready") {
                    send(response, 409, {
                        error: "The workspace is still initializing or its directory is unavailable.",
                    });
                    return;
                }
                if (parts.length === 3 && parts[2] === "exec") {
                    const input = decodeRequest(
                        executeWorkspaceCommandBodySchema,
                        body,
                        "Workspace command settings",
                    );
                    send(
                        response,
                        200,
                        await executeWorkspaceCommand(
                            workspace.path,
                            input.command,
                            input.timeoutMs ?? HAPPY_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS,
                        ),
                    );
                    return;
                }
                if (parts.length === 4 && parts[2] === "files" && parts[3] === "read") {
                    const input = decodeRequest(
                        readWorkspaceFileBodySchema,
                        body,
                        "Workspace file read settings",
                    );
                    send(response, 200, await readPluginWorkspaceFile(workspace.path, input.path));
                    return;
                }
                if (parts.length === 4 && parts[2] === "files" && parts[3] === "write") {
                    const input = decodeRequest(
                        writeWorkspaceFileBodySchema,
                        body,
                        "Workspace file write settings",
                    );
                    send(
                        response,
                        200,
                        await writePluginWorkspaceFile(
                            workspace.path,
                            input.path,
                            Buffer.from(input.contentBase64, "base64"),
                        ),
                    );
                    return;
                }
            }
            if (request.method === "POST" && url.pathname === "/sessions") {
                const input = decodeRequest(createSessionInputSchema, body, "Session settings");
                const session: HappySession = {
                    agentId: `test-agent-${String(nextId)}`,
                    archived: false,
                    cwd: input.cwd,
                    id: `test-session-${String(nextId++)}`,
                    projectId: projects[0]?.id ?? "test-project",
                    status: "idle",
                    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
                };
                sessions.push(session);
                send(response, 201, { session });
                return;
            }
            if (request.method === "POST" && url.pathname === "/mcp/servers") {
                if (ready) {
                    throw new Error(
                        "MCP registration must be declared before the plugin reports ready.",
                    );
                }
                const registeredServer = decodeRequest(
                    happyMcpServerRegistrationSchema,
                    body,
                    "MCP server registration",
                );
                if (
                    [...registrations.values()].some(
                        (registration) =>
                            normalizeHappyMcpName(registration.server.name).toLowerCase() ===
                            normalizeHappyMcpName(registeredServer.name).toLowerCase(),
                    )
                ) {
                    throw new Error(
                        `The fake Happy host already has an MCP server named "${registeredServer.name}".`,
                    );
                }
                const registration: TestRegistration = {
                    id: `test-registration-${String(nextId++)}`,
                    server: registeredServer,
                };
                registrations.set(registration.id, registration);
                send(response, 201, { registrationId: registration.id });
                return;
            }
            if (request.method === "POST" && url.pathname === "/hooks/system-prompt") {
                if (ready) {
                    throw new Error(
                        "System-prompt hook registration must be declared before the plugin reports ready.",
                    );
                }
                if (systemPromptHook !== undefined) {
                    send(response, 409, { error: "A system-prompt hook is already registered." });
                    return;
                }
                systemPromptHook = { id: `test-hook-${String(nextId++)}` };
                send(response, 201, { registrationId: systemPromptHook.id });
                return;
            }
            if (request.method === "POST" && url.pathname === "/tracing/subscriptions") {
                if (tracingSubscription !== undefined) {
                    send(response, 409, { error: "A tracing subscription is already registered." });
                    return;
                }
                tracingSubscription = { id: `test-tracing-${String(nextId++)}` };
                send(response, 201, { registrationId: tracingSubscription.id });
                return;
            }
            if (
                request.method === "GET" &&
                parts.length === 4 &&
                parts[0] === "hooks" &&
                parts[1] === "system-prompt" &&
                parts[2] === systemPromptHook?.id &&
                parts[3] === "events"
            ) {
                if (ready) {
                    throw new Error(
                        "System-prompt hook stream attachment must be declared before the plugin reports ready.",
                    );
                }
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                systemPromptHook!.response = response;
                response.once("close", () => {
                    if (systemPromptHook?.response === response) systemPromptHook = undefined;
                });
                return;
            }
            if (
                request.method === "GET" &&
                parts.length === 4 &&
                parts[0] === "tracing" &&
                parts[1] === "subscriptions" &&
                parts[2] === tracingSubscription?.id &&
                parts[3] === "events"
            ) {
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                tracingSubscription!.response = response;
                response.once("close", () => {
                    if (tracingSubscription?.response === response) {
                        tracingSubscription = undefined;
                    }
                });
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 5 &&
                parts[0] === "hooks" &&
                parts[1] === "system-prompt" &&
                parts[2] === systemPromptHook?.id &&
                parts[3] === "calls" &&
                parts[4] !== undefined
            ) {
                const call = systemPromptCalls.get(parts[4]);
                if (call === undefined) {
                    send(response, 409, { error: "That system-prompt call is no longer active." });
                    return;
                }
                systemPromptCalls.delete(parts[4]);
                const completion = decodeRequest(
                    happySystemPromptHookCompletionSchema,
                    body,
                    "System-prompt hook result",
                );
                call.resolve(completion.result);
                send(response, 200, {});
                return;
            }
            if (
                request.method === "DELETE" &&
                parts.length === 3 &&
                parts[0] === "hooks" &&
                parts[1] === "system-prompt" &&
                parts[2] === systemPromptHook?.id
            ) {
                systemPromptHook!.response?.end();
                systemPromptHook = undefined;
                send(response, 200, {});
                return;
            }
            if (
                request.method === "DELETE" &&
                parts.length === 3 &&
                parts[0] === "tracing" &&
                parts[1] === "subscriptions" &&
                parts[2] === tracingSubscription?.id
            ) {
                tracingSubscription!.response?.end();
                tracingSubscription = undefined;
                send(response, 200, {});
                return;
            }
            if (
                request.method === "POST" &&
                (url.pathname === "/network/requests" || url.pathname === "/network/tunnels")
            ) {
                if (ready) {
                    throw new Error(
                        "Network listener registration must be declared before the plugin reports ready.",
                    );
                }
                const registration: TestNetworkRegistration = {
                    id: `test-network-${String(nextId++)}`,
                    type: url.pathname === "/network/requests" ? "request" : "tunnel",
                };
                if (
                    [...networkRegistrations.values()].some(
                        (candidate) => candidate.type === registration.type,
                    )
                ) {
                    send(response, 409, {
                        error: `The fake host already has a ${registration.type} listener.`,
                    });
                    return;
                }
                networkRegistrations.set(registration.id, registration);
                send(response, 201, { registrationId: registration.id });
                return;
            }
            if (
                request.method === "GET" &&
                parts.length === 4 &&
                parts[0] === "network" &&
                (parts[1] === "requests" || parts[1] === "tunnels") &&
                parts[2] !== undefined &&
                parts[3] === "events"
            ) {
                if (ready) {
                    throw new Error(
                        "Network listener stream attachment must be declared before the plugin reports ready.",
                    );
                }
                const registration = networkRegistrations.get(parts[2]);
                if (registration === undefined) {
                    send(response, 404, { error: "That network listener is not active." });
                    return;
                }
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                registration.response = response;
                response.once("close", () => networkRegistrations.delete(registration.id));
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 5 &&
                parts[0] === "network" &&
                parts[1] === "requests" &&
                parts[2] !== undefined &&
                parts[3] === "calls" &&
                parts[4] !== undefined
            ) {
                const call = networkCalls.get(parts[4]);
                if (call === undefined) {
                    send(response, 409, { error: "That network request is no longer active." });
                    return;
                }
                networkCalls.delete(parts[4]);
                call.resolve(
                    decodeRequest(
                        happyNetworkRequestCompletionSchema,
                        body,
                        "Network request result",
                    ),
                );
                send(response, 200, {});
                return;
            }
            if (
                request.method === "DELETE" &&
                parts.length === 3 &&
                parts[0] === "network" &&
                (parts[1] === "requests" || parts[1] === "tunnels") &&
                parts[2] !== undefined
            ) {
                networkRegistrations.get(parts[2])?.response?.end();
                networkRegistrations.delete(parts[2]);
                send(response, 200, {});
                return;
            }
            if (
                request.method === "GET" &&
                parts.length === 4 &&
                parts[0] === "mcp" &&
                parts[1] === "servers" &&
                parts[2] !== undefined &&
                parts[3] === "events"
            ) {
                if (ready) {
                    throw new Error(
                        "MCP stream attachment must be declared before the plugin reports ready.",
                    );
                }
                const registration = registrations.get(parts[2]);
                if (registration === undefined) {
                    send(response, 404, { error: "That MCP registration is not active." });
                    return;
                }
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                registration.response = response;
                response.once("close", () => {
                    if (registration.response === response) registrations.delete(registration.id);
                });
                for (const notify of toolWaiters) notify();
                toolWaiters.clear();
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 5 &&
                parts[0] === "mcp" &&
                parts[1] === "servers" &&
                parts[2] !== undefined &&
                parts[3] === "calls" &&
                parts[4] !== undefined
            ) {
                const call = calls.get(parts[4]);
                if (call === undefined) {
                    send(response, 409, { error: "That MCP call is no longer active." });
                    return;
                }
                calls.delete(parts[4]);
                const completion = decodeRequest(
                    happyMcpCallCompletionSchema,
                    body,
                    "MCP tool result",
                );
                call.resolve(happyMcpCompletionToResult(completion));
                send(response, 200, {});
                return;
            }
            if (
                request.method === "DELETE" &&
                parts.length === 3 &&
                parts[0] === "mcp" &&
                parts[1] === "servers" &&
                parts[2] !== undefined
            ) {
                registrations.get(parts[2])?.response?.end();
                registrations.delete(parts[2]);
                send(response, 200, {});
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 3 &&
                parts[0] === "agents" &&
                parts[1] !== undefined &&
                parts[2] === "messages"
            ) {
                decodeRequest(sendAgentMessageBodySchema, body, "Agent message");
                send(response, 202, {
                    delivered: true,
                    runId: `test-run-${String(nextId++)}`,
                    sessionId:
                        sessions.find((session) => session.agentId === parts[1])?.id ??
                        "test-session",
                });
                return;
            }
            if (
                parts.length >= 3 &&
                parts[0] === "projects" &&
                parts[1] !== undefined &&
                parts[2] === "workspaces"
            ) {
                const projectId = parts[1];
                if (request.method === "POST" && parts.length === 3) {
                    const input = decodeRequest(
                        createWorkspaceBodySchema,
                        body,
                        "Workspace settings",
                    );
                    const existing =
                        input.id === undefined
                            ? undefined
                            : workspaces.find((candidate) => candidate.id === input.id);
                    if (existing !== undefined) {
                        if (
                            existing.projectId !== projectId ||
                            existing.baseRef !== input.baseRef
                        ) {
                            send(response, 409, {
                                error: "That workspace ID already names a different workspace.",
                            });
                            return;
                        }
                        send(response, 202, { workspace: existing });
                        return;
                    }
                    const workspace: HappyWorkspace = {
                        id: input.id ?? `test-workspace-${String(nextId++)}`,
                        name: input.name,
                        path: join(pluginDirectory, input.name),
                        projectId,
                        status: "initializing",
                        version: 0,
                        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                    };
                    workspaces.push(workspace);
                    publishWorkspaceEvent("workspace_created", workspace);
                    send(response, 202, { workspace });
                    const completion = new Promise<void>((resolveCompletion) => {
                        setImmediate(() => {
                            void mkdir(workspace.path, { mode: 0o700, recursive: true })
                                .then(
                                    () => {
                                        Object.assign(workspace, {
                                            status: "ready",
                                            version: workspace.version + 1,
                                        });
                                    },
                                    (error: unknown) => {
                                        Object.assign(workspace, {
                                            error:
                                                error instanceof Error
                                                    ? error.message
                                                    : String(error),
                                            status: "failed",
                                            version: workspace.version + 1,
                                        });
                                    },
                                )
                                .then(() => {
                                    publishWorkspaceEvent("workspace_updated", workspace);
                                })
                                .finally(resolveCompletion);
                        });
                    });
                    workspaceCompletions.add(completion);
                    void completion.finally(() => workspaceCompletions.delete(completion));
                    return;
                }
                const workspace = workspaces.find(
                    (candidate) => candidate.projectId === projectId && candidate.id === parts[3],
                );
                if (workspace === undefined) {
                    send(response, 404, { error: "Workspace not found." });
                    return;
                }
                if (request.method === "PATCH" && parts.length === 4) {
                    const input = decodeRequest(
                        renameWorkspaceBodySchema,
                        body,
                        "Workspace rename settings",
                    );
                    Object.assign(workspace, {
                        name: input.name,
                        version: workspace.version + 1,
                    });
                    send(response, 200, { workspace });
                    return;
                }
                if (request.method === "POST" && parts[4] === "archive") {
                    decodeRequest(archiveWorkspaceBodySchema, body, "Workspace archive settings");
                    Object.assign(workspace, {
                        archivedAt: Date.now(),
                        status: "archived",
                        version: workspace.version + 1,
                    });
                    send(response, 200, { workspace });
                    return;
                }
            }
            send(response, 404, { error: "This fake Happy host action does not exist." });
        })().catch((error: unknown) => {
            if ((request.url ?? "").startsWith("/compute/")) {
                send(response, 400, {
                    code: "invalid_request",
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false,
                });
                return;
            }
            send(response, classifyPluginApiRequestError(error), {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    });

    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });
    } catch (error) {
        await rm(root, { force: true, recursive: true });
        throw error;
    }

    const callTool = (
        audience: "app" | "model",
        serverName: string,
        toolName: string,
        argumentsValue: unknown,
        callOptions: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<HappyMcpToolResult> => {
        const registration = [...registrations.values()].find(
            (candidate) => candidate.server.name === serverName && candidate.response !== undefined,
        );
        if (registration === undefined) {
            return Promise.reject(new Error(`No active fake MCP server is named "${serverName}".`));
        }
        if (
            !registration.server.tools.some(
                (tool) => tool.name === toolName && toolVisibility(tool).includes(audience),
            )
        ) {
            return Promise.reject(
                new Error(
                    `The fake MCP server "${serverName}" has no ${audience}-visible tool named "${toolName}".`,
                ),
            );
        }
        const callId = `test-call-${String(nextId++)}`;
        return new Promise<HappyMcpToolResult>((resolve, reject) => {
            const timeoutMs = callOptions.timeoutMs ?? CALL_TIMEOUT_MS;
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                callOptions.signal?.removeEventListener("abort", abort);
            };
            const finishReject = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const finishResolve = (result: HappyMcpToolResult) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(result);
            };
            const timer = setTimeout(() => {
                registration.response?.write(`${JSON.stringify({ callId, type: "cancel" })}\n`);
                calls.delete(callId);
                finishReject(
                    new Error(`The fake MCP call timed out after ${String(timeoutMs)}ms.`),
                );
            }, timeoutMs);
            timer.unref();
            const abort = () => {
                registration.response?.write(`${JSON.stringify({ callId, type: "cancel" })}\n`);
                calls.delete(callId);
                finishReject(new Error("The fake MCP call was cancelled."));
            };
            calls.set(callId, {
                cleanup,
                reject: finishReject,
                resolve: finishResolve,
            });
            if (callOptions.signal?.aborted === true) {
                abort();
                return;
            }
            callOptions.signal?.addEventListener("abort", abort, { once: true });
            registration.response?.write(
                `${JSON.stringify({
                    arguments: argumentsValue,
                    callId,
                    tool: toolName,
                    type: "call",
                })}\n`,
            );
        });
    };

    const environment = {
        HAPPY_PLUGIN_DIRECTORY: pluginDirectory,
        HAPPY_PLUGIN_SOCKET_PATH: socketPath,
        HAPPY_PLUGIN_TOKEN: token,
    } as const;
    const host: HappyPluginTestHost = {
        apps: {
            callTool: (server, tool, argumentsValue = {}, callOptions = {}) =>
                callTool("app", server, tool, argumentsValue, callOptions),
            storage: {
                async delete(key) {
                    assertHappyPluginStorageKey(key);
                    appStorage.delete(key);
                },
                async get(key) {
                    assertHappyPluginStorageKey(key);
                    const body = appStorage.get(key);
                    return body === undefined ? undefined : decodeHappyPluginStorageValue(body);
                },
                async list() {
                    return [...appStorage.keys()].sort();
                },
                async set(key, value) {
                    assertHappyPluginStorageKey(key);
                    const body = encodeHappyPluginStorageValue(value);
                    if (!appStorage.has(key) && appStorage.size >= HAPPY_PLUGIN_MAX_STORAGE_KEYS) {
                        throw new Error("The plugin has too many storage keys.");
                    }
                    assertHappyPluginStorageQuota(
                        [...appStorage.entries()].reduce(
                            (bytes, [storedKey, storedValue]) =>
                                bytes + (storedKey === key ? 0 : Buffer.byteLength(storedValue)),
                            Buffer.byteLength(body),
                        ),
                    );
                    appStorage.set(key, body);
                },
            },
        },
        client: createHappyPluginClient({ socketPath, token }),
        compute: {
            disconnectProvider(mode = "end") {
                disconnectResponse(computeRegistration?.response, mode, "compute provider");
            },
            waitForProvider(timeoutMs = CALL_TIMEOUT_MS) {
                if (computeRegistration?.response !== undefined) return Promise.resolve();
                return new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        computeWaiters.delete(notify);
                        reject(
                            new Error("The fake host timed out waiting for a compute provider."),
                        );
                    }, timeoutMs);
                    timer.unref();
                    const notify = () => {
                        if (computeRegistration?.response === undefined) return;
                        clearTimeout(timer);
                        computeWaiters.delete(notify);
                        resolve();
                    };
                    computeWaiters.add(notify);
                });
            },
        },
        environment,
        hooks: {
            applySystemPrompt(input, timeoutMs = CALL_TIMEOUT_MS) {
                const registration = systemPromptHook;
                if (registration?.response === undefined) {
                    return Promise.reject(
                        new Error("No system-prompt hook is attached to the fake Happy host."),
                    );
                }
                const callId = `test-prompt-${String(nextId++)}`;
                return new Promise<HappySystemPromptHookResult>((resolve, reject) => {
                    let settled = false;
                    const cleanup = () => clearTimeout(timer);
                    const finishReject = (error: Error) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        reject(error);
                    };
                    const finishResolve = (result: HappySystemPromptHookResult) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve(result);
                    };
                    const timer = setTimeout(() => {
                        systemPromptCalls.delete(callId);
                        finishReject(
                            new Error(
                                `The fake system-prompt hook timed out after ${String(timeoutMs)}ms.`,
                            ),
                        );
                    }, timeoutMs);
                    timer.unref();
                    systemPromptCalls.set(callId, {
                        cleanup,
                        reject: finishReject,
                        resolve: finishResolve,
                    });
                    registration.response!.write(
                        `${JSON.stringify({ callId, input, type: "system_prompt" })}\n`,
                    );
                });
            },
            disconnect(mode = "end") {
                disconnectResponse(systemPromptHook?.response, mode, "system-prompt");
            },
        },
        requests,
        rootDirectory: root,
        mcp: {
            async callTool(serverName, toolName, argumentsValue = {}, options = {}) {
                return callTool("model", serverName, toolName, argumentsValue, options);
            },
            disconnectServers(mode = "end") {
                for (const registration of registrations.values()) {
                    if (mode === "error") {
                        registration.response?.destroy(
                            new Error("The fake Happy MCP stream disconnected."),
                        );
                    } else if (mode === "close") {
                        registration.response?.destroy();
                    } else {
                        registration.response?.end();
                    }
                }
            },
            listTools: () =>
                [...registrations.values()]
                    .filter((registration) => registration.response !== undefined)
                    .flatMap((registration) =>
                        registration.server.tools
                            .filter((tool) => toolVisibility(tool).includes("model"))
                            .map((tool) => ({
                                description: tool.description,
                                inputSchema: structuredClone(tool.inputSchema),
                                server: registration.server.name,
                                tool: tool.name,
                            })),
                    ),
            waitForTools(count = 1, timeoutMs = CALL_TIMEOUT_MS) {
                if (activeToolCount() >= count) {
                    return Promise.resolve();
                }
                return new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        toolWaiters.delete(notify);
                        reject(new Error("The fake host timed out waiting for MCP tools."));
                    }, timeoutMs);
                    timer.unref();
                    const notify = () => {
                        if (activeToolCount() < count) return;
                        clearTimeout(timer);
                        toolWaiters.delete(notify);
                        resolve();
                    };
                    toolWaiters.add(notify);
                });
            },
        },
        network: {
            request(request, requestOptions = {}) {
                const registration = [...networkRegistrations.values()].find(
                    (candidate) => candidate.type === "request" && candidate.response !== undefined,
                );
                if (registration?.response === undefined) {
                    return Promise.reject(
                        new Error("The fake Happy host has no connected network request handler."),
                    );
                }
                const callId = `test-network-call-${String(nextId++)}`;
                return new Promise<HappyNetworkRequestResult>((resolve, reject) => {
                    const timeoutMs = requestOptions.timeoutMs ?? CALL_TIMEOUT_MS;
                    const timer = setTimeout(() => {
                        networkCalls.delete(callId);
                        reject(
                            new Error(
                                `The fake network request timed out after ${String(timeoutMs)}ms.`,
                            ),
                        );
                    }, timeoutMs);
                    timer.unref();
                    networkCalls.set(callId, {
                        cleanup: () => clearTimeout(timer),
                        reject,
                        resolve: (completion) => {
                            clearTimeout(timer);
                            resolve(decodeNetworkCompletion(completion));
                        },
                    });
                    registration.response!.write(
                        `${JSON.stringify({
                            bodyBase64: Buffer.from(request.body).toString("base64"),
                            callId,
                            headers: request.headers,
                            hostname: request.hostname,
                            method: request.method,
                            mode: "handle",
                            type: "request",
                            url: request.url,
                        })}\n`,
                    );
                });
            },
            tunnel(tunnel) {
                for (const registration of networkRegistrations.values()) {
                    if (registration.type !== "tunnel") continue;
                    registration.response?.write(`${JSON.stringify(tunnel)}\n`);
                }
            },
        },
        tracing: {
            disconnect(mode = "end") {
                disconnectResponse(tracingSubscription?.response, mode, "tracing");
            },
            emit(event) {
                tracingSubscription?.response?.write(`${JSON.stringify(event)}\n`);
            },
        },
        async close() {
            if (closed) return;
            closed = true;
            for (const call of calls.values()) {
                call.cleanup();
                call.reject(new Error("The fake Happy host closed."));
            }
            calls.clear();
            for (const call of computeCalls.values()) {
                call.cleanup();
                call.reject(new Error("The fake Happy host closed."));
            }
            computeCalls.clear();
            computeRegistration?.response?.end();
            computeRegistration = undefined;
            for (const call of networkCalls.values()) {
                call.cleanup();
                call.reject(new Error("The fake Happy host closed."));
            }
            networkCalls.clear();
            for (const registration of networkRegistrations.values()) {
                registration.response?.end();
            }
            networkRegistrations.clear();
            for (const call of systemPromptCalls.values()) {
                call.cleanup();
                call.reject(new Error("The fake Happy host closed."));
            }
            systemPromptCalls.clear();
            for (const registration of registrations.values()) registration.response?.end();
            registrations.clear();
            systemPromptHook?.response?.end();
            tracingSubscription?.response?.end();
            for (const response of workspaceEventResponses) response.end();
            workspaceEventResponses.clear();
            systemPromptHook = undefined;
            tracingSubscription = undefined;
            await Promise.allSettled(workspaceCompletions);
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
            await rm(root, { force: true, recursive: true });
        },
    };
    return host;
}

type ComputeCallWithoutEnvelope<T> = T extends { callId: string; type: "call" }
    ? Omit<T, "callId" | "type">
    : never;
type TestComputeCallEvent = ComputeCallWithoutEnvelope<HappyComputeEvent>;

function invokeTestCompute(
    registration: TestComputeRegistration,
    calls: Map<string, TestComputeCall>,
    createCallId: () => string,
    event: TestComputeCallEvent,
    timeoutMs = CALL_TIMEOUT_MS,
    progress?: (progress: HappyComputeProvisioningProgress) => void,
    acknowledgmentTimeoutMs?: number,
): Promise<HappyComputeCallCompletion> {
    if (registration.response === undefined) {
        return Promise.reject(new Error("No compute provider is attached to the fake Happy host."));
    }
    const callId = createCallId();
    return new Promise((resolve, reject) => {
        let settled = false;
        let acknowledgmentTimer: NodeJS.Timeout | undefined;
        let completionTimer: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (acknowledgmentTimer !== undefined) clearTimeout(acknowledgmentTimer);
            if (completionTimer !== undefined) clearTimeout(completionTimer);
        };
        const finishReject = (error: Error) => {
            if (settled) return;
            settled = true;
            calls.delete(callId);
            cleanup();
            reject(error);
        };
        const finishResolve = (completion: HappyComputeCallCompletion) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(completion);
        };
        const call: TestComputeCall = {
            acknowledgment:
                acknowledgmentTimeoutMs === undefined
                    ? { status: "not_required" }
                    : { status: "awaiting_acknowledgment" },
            acknowledge: () => {
                if (call.acknowledgment.status !== "awaiting_acknowledgment") return;
                if (acknowledgmentTimer !== undefined) clearTimeout(acknowledgmentTimer);
                acknowledgmentTimer = undefined;
                call.acknowledgment = { status: "acknowledged" };
            },
            cleanup,
            operation: event.operation,
            ...(progress === undefined ? {} : { progress }),
            reject: finishReject,
            resolve: finishResolve,
        };
        completionTimer = setTimeout(() => {
            registration.response?.write(`${JSON.stringify({ callId, type: "cancel" })}\n`);
            finishReject(
                new Error(`The fake compute call timed out after ${String(timeoutMs)}ms.`),
            );
        }, timeoutMs);
        completionTimer.unref();
        if (acknowledgmentTimeoutMs !== undefined) {
            acknowledgmentTimer = setTimeout(() => {
                finishReject(
                    new Error(
                        `The fake compute provider did not acknowledge provisioning within ${String(acknowledgmentTimeoutMs)}ms.`,
                    ),
                );
            }, acknowledgmentTimeoutMs);
            acknowledgmentTimer.unref();
        }
        calls.set(callId, call);
        registration.response!.write(
            `${JSON.stringify({
                ...event,
                callId,
                type: "call",
            })}\n`,
        );
    });
}

function failTestComputeGeneration(
    registrationId: string,
    reason: string,
    instances: Map<string, TestComputeInstance>,
    calls: Map<string, TestComputeCall>,
    publishPreparation: (
        instance: TestComputeInstance,
        phase: HappyComputePreparationPhase,
        message: string,
        state: HappyComputePreparationEvent["state"],
        error?: HappyComputeError,
    ) => void,
): void {
    for (const instance of instances.values()) {
        if (
            instance.state === "unprovisioned" ||
            instance.state === "failed" ||
            instance.state === "stopped" ||
            instance.registrationId !== registrationId
        ) {
            continue;
        }
        if (instance.state === "provisioning" && instance.providerInstanceId === undefined) {
            const unprovisioned: TestComputeInstance = {
                createdAt: instance.createdAt,
                id: instance.id,
                provider: instance.provider,
                reason,
                state: "unprovisioned",
                workspaceSource: instance.workspaceSource,
            };
            instances.set(instance.id, unprovisioned);
            publishPreparation(instance, "failed", reason, "unprovisioned", {
                code: "preparing_compute",
                message: reason,
                retryable: true,
                state: "unprovisioned",
            });
            continue;
        }
        const failed: TestComputeInstance = {
            ...instance,
            diedAt: Date.now(),
            reason,
            state: "failed",
        };
        instances.set(instance.id, failed);
        if (instance.state === "provisioning") {
            const message = `Compute preparation failed. ${reason}`;
            publishPreparation(instance, "failed", message, "failed", {
                code: "instance_failed",
                message,
                retryable: false,
                state: "failed",
            });
        }
    }
    for (const call of calls.values()) {
        call.cleanup();
        call.reject(new Error(reason));
    }
    calls.clear();
}

function remainingTestComputeDeadline(deadlineAt: number): number {
    return Math.max(1, deadlineAt - Date.now());
}

function decodeNetworkCompletion(
    completion: HappyNetworkRequestCompletion,
): HappyNetworkRequestResult {
    if (completion.type === "pass_through" || completion.type === "error") {
        return { type: "pass_through" };
    }
    const { bodyBase64, ...rest } = completion;
    return {
        ...rest,
        ...(bodyBase64 === undefined ? {} : { body: Buffer.from(bodyBase64, "base64") }),
    };
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maximumBytes) {
            tooLarge = true;
            continue;
        }
        if (!tooLarge) chunks.push(buffer);
    }
    if (tooLarge) throw new PluginApiRequestTooLargeError("The plugin request is too large.");
    const text = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new PluginApiRequestError("The plugin request is not valid JSON.");
    }
}

function decodeRequest<TSchema_ extends TSchema>(
    schema: TSchema_,
    value: unknown,
    subject: string,
): Static<TSchema_> {
    try {
        return Value.Decode(schema, value);
    } catch {
        const first = Value.Errors(schema, value).First();
        const detail = first === undefined ? "" : ` ${first.path || "value"}: ${first.message}`;
        throw new PluginApiRequestError(`${subject} are invalid.${detail}`);
    }
}

function send(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent || response.destroyed) return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
    });
    response.end(body);
}

function sendTestComputeError(
    response: ServerResponse,
    error: HappyComputeError,
    state?: HappyComputeInstanceState,
): void {
    const normalized = normalizeHappyComputeError(
        error.code === "preparing_compute" || state === undefined ? error : { ...error, state },
    );
    send(response, happyComputeErrorStatus(normalized.code), normalized);
}

function toolVisibility(
    tool: HappyMcpServerRegistration["tools"][number],
): readonly ("app" | "model")[] {
    return tool._meta?.ui.visibility ?? ["model", "app"];
}

function disconnectResponse(
    response: ServerResponse | undefined,
    mode: "close" | "end" | "error",
    label: string,
): void {
    if (mode === "error") {
        response?.destroy(new Error(`The fake Happy ${label} stream disconnected.`));
    } else if (mode === "close") {
        response?.destroy();
    } else {
        response?.end();
    }
}
