import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname } from "node:path";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
    AgentMessageDelivery,
    HappyPlugin,
    HappyPluginStatus,
    HappyProviderUsageEntry,
    HappyProject,
    HappySlotEntry,
    HappySession,
    HappyWorkspace,
    HappyWorkspaceEvent,
    PublishedHappyMedia,
} from "happy-plugins";
import {
    HAPPY_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS,
    HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
    HAPPY_PLUGIN_MAX_MEDIA_BYTES,
    HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES,
    archiveWorkspaceBodySchema,
    createHappySlotEntryInputSchema,
    createSessionInputSchema,
    createWorkspaceBodySchema,
    executeWorkspaceCommandBodySchema,
    happyMcpCallCompletionSchema,
    happyMcpServerRegistrationSchema,
    happyNetworkEventSchema,
    happyPluginReadyBodySchema,
    happySystemPromptHookCompletionSchema,
    updateHappyPluginStatusBodySchema,
    listHappySlotEntriesInputSchema,
    happyNetworkRequestCompletionSchema,
    listWorkspacesInputSchema,
    publishHappyMediaBodySchema,
    readWorkspaceFileBodySchema,
    renameWorkspaceBodySchema,
    sendAgentMessageBodySchema,
    updateHappySlotEntryInputSchema,
    writeWorkspaceFileBodySchema,
} from "happy-plugins";
import {
    classifyPluginApiRequestError,
    createHappyComputeBodySchema,
    createPluginWorkspaceCommandExecutor,
    execHappyComputeBodySchema,
    happyComputeErrorStatus,
    happyComputeProvisioningProgressSchema,
    PluginApiRequestError,
    PluginApiRequestTooLargeError,
    readHappyComputeBodySchema,
    registerHappyComputeProviderInputSchema,
    readPluginWorkspaceFile,
    writeHappyComputeBodySchema,
    writePluginWorkspaceFile,
} from "happy-plugins/internal";

import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { GeneratedMediaStore } from "../generated-media/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import type {
    PluginSummary,
    Project,
    ProjectWorkspace,
    SessionSummary,
} from "../protocol/index.js";
import { configureSessionRequest } from "../session/configureSessionRequest.js";
import type { SessionStore } from "../session/SessionStore.js";
import { SlotEntryInvalidError, SlotEntryNotFoundError } from "../slots/index.js";
import { isAuthorizedProtocolRequest } from "../server/isAuthorizedProtocolRequest.js";
import { sendJson } from "../server/sendJson.js";
import type { PluginHookConnection } from "./PluginHookRegistry.js";
import {
    PluginComputeError,
    type PluginComputeConnection,
    type PluginComputeRegistry,
} from "./PluginComputeRegistry.js";
import type { PluginMcpConnection } from "./PluginMcpRegistry.js";
import type { PluginNetworkConnection } from "./PluginNetworkRegistry.js";
import type { PluginStartupState } from "./PluginStartupState.js";
import { MAX_INSTALLED_PLUGINS } from "./discoverPlugins.js";
import { readPluginMediaFile } from "./readPluginMediaFile.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_COMPUTE_COMPLETION_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_WORKSPACE_FILE_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_REQUEST_BYTES = 15 * 1024 * 1024;

export interface CreatePluginApiServerOptions {
    compute?: PluginComputeConnection;
    computeRegistry?: PluginComputeRegistry;
    defaultDocker?: DockerExecutionConfig;
    generatedMedia?: GeneratedMediaStore;
    listPlugins: () => Promise<readonly PluginSummary[]>;
    listProviderUsage?: () => readonly HappyProviderUsageEntry[];
    hooks?: PluginHookConnection;
    mcp?: PluginMcpConnection;
    network?: PluginNetworkConnection;
    onStatus?: (status: HappyPluginStatus) => void;
    pluginFolder: string;
    pluginDataDirectory?: string;
    pluginName: string;
    startup: PluginStartupState;
    store: SessionStore;
    token: string;
}

export function createPluginApiServer(options: CreatePluginApiServerOptions): Server {
    const executeWorkspaceCommand = createPluginWorkspaceCommandExecutor();
    return createServer((request, response) => {
        if (!isAuthorizedProtocolRequest(request, options.token)) {
            sendJson(response, 401, { error: "This plugin connection is not authorized." });
            return;
        }
        void handleRequest(request, response, options, executeWorkspaceCommand).catch(
            (error: unknown) => {
                if (isDatabaseFailure(error)) throw error;
                if ((request.url ?? "").startsWith("/compute/")) {
                    const computeError =
                        error instanceof PluginComputeError
                            ? error
                            : new PluginComputeError({
                                  code:
                                      error instanceof PluginApiRequestError
                                          ? "invalid_request"
                                          : "invalid_response",
                                  message: errorToMessage(error),
                                  retryable: false,
                              });
                    sendJson(response, happyComputeErrorStatus(computeError.code), {
                        code: computeError.code,
                        ...(computeError.elapsedMs === undefined
                            ? {}
                            : { elapsedMs: computeError.elapsedMs }),
                        ...(computeError.lastProgressAt === undefined
                            ? {}
                            : { lastProgressAt: computeError.lastProgressAt }),
                        message: computeError.message,
                        ...(computeError.percent === undefined
                            ? {}
                            : { percent: computeError.percent }),
                        ...(computeError.phase === undefined ? {} : { phase: computeError.phase }),
                        retryable: computeError.retryable,
                        ...(computeError.startedAt === undefined
                            ? {}
                            : { startedAt: computeError.startedAt }),
                        ...(computeError.state === undefined ? {} : { state: computeError.state }),
                    });
                    return;
                }
                sendJson(
                    response,
                    error instanceof PluginHookConflictError
                        ? 409
                        : error instanceof PluginComputeError
                          ? happyComputeErrorStatus(error.code)
                          : classifyPluginApiRequestError(error),
                    {
                        ...(error instanceof PluginComputeError ? { code: error.code } : {}),
                        error: errorToMessage(error),
                    },
                );
            },
        );
    });
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: CreatePluginApiServerOptions,
    executeWorkspaceCommand: ReturnType<typeof createPluginWorkspaceCommandExecutor>,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://rig-plugin.local");
    if (request.method === "POST" && url.pathname === "/ready") {
        const readiness = await readJson(request, happyPluginReadyBodySchema, "Plugin readiness");
        try {
            options.compute?.assertReady();
            options.startup.ready();
            options.onStatus?.(readiness.status);
        } catch (error) {
            throw new PluginApiRequestError(errorToMessage(error));
        }
        sendJson(response, 200, {});
        return;
    }
    if (request.method === "POST" && url.pathname === "/status") {
        const body = await readJson(request, updateHappyPluginStatusBodySchema, "Plugin status");
        try {
            options.startup.assertActive("Plugin status");
            options.onStatus?.(body.status);
        } catch (error) {
            throw new PluginApiRequestError(errorToMessage(error));
        }
        sendJson(response, 200, {});
        return;
    }
    if (request.method === "GET" && url.pathname === "/projects") {
        sendJson<{ projects: readonly HappyProject[] }>(response, 200, {
            projects: options.store.listProjects().map(toHappyProject),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/workspaces") {
        const input = parseValue(
            listWorkspacesInputSchema,
            url.searchParams.has("projectId")
                ? { projectId: url.searchParams.get("projectId") ?? "" }
                : {},
            "Workspace list settings",
        );
        sendJson<{ workspaces: readonly HappyWorkspace[] }>(response, 200, {
            workspaces: options.store.listWorkspaces(input.projectId).map(toHappyWorkspace),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/workspaces/events") {
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        const unsubscribe = options.store.liveEvents.subscribe((entry) => {
            if (
                (entry.event.type !== "workspace_created" &&
                    entry.event.type !== "workspace_updated") ||
                response.destroyed ||
                response.writableEnded
            ) {
                return;
            }
            const event: HappyWorkspaceEvent = {
                type: entry.event.type,
                workspace: toHappyWorkspace(entry.event.data.workspace),
            };
            response.write(`${JSON.stringify(event)}\n`);
        });
        response.once("close", unsubscribe);
        return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
        sendJson<{ sessions: readonly HappySession[] }>(response, 200, {
            sessions: options.store.list().map((session) => toHappySession(options.store, session)),
        });
        return;
    }
    if (request.method === "POST" && url.pathname === "/sessions") {
        const body = await readJson(request, createSessionInputSchema, "Session settings");
        const session = options.store.create(
            configureSessionRequest(body, options.defaultDocker, () =>
                options.store.queryProjectSettings(body.cwd),
            ),
        );
        sendJson<{ session: HappySession }>(response, 201, {
            session: toHappySession(options.store, session.snapshot()),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/provider-usage") {
        sendJson<{ providers: readonly HappyProviderUsageEntry[] }>(response, 200, {
            providers: options.listProviderUsage?.() ?? [],
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/compute/providers") {
        sendJson(response, 200, { providers: requireComputeRegistry(options).list() });
        return;
    }
    if (request.method === "GET" && url.pathname === "/compute/events") {
        const compute = requireCompute(options);
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        const unsubscribe = requireComputeRegistry(options).subscribe((event) => {
            if (
                event.type !== "preparation" ||
                event.consumerGeneration !== compute.generation ||
                response.destroyed ||
                response.writableEnded
            ) {
                return;
            }
            response.write(
                `${JSON.stringify({
                    createdAt: event.createdAt,
                    ...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
                    ...(event.error === undefined ? {} : { error: event.error }),
                    instanceId: event.instanceId,
                    ...(event.lastProgressAt === undefined
                        ? {}
                        : { lastProgressAt: event.lastProgressAt }),
                    message: event.message,
                    ...(event.percent === undefined ? {} : { percent: event.percent }),
                    phase: event.phase,
                    provider: event.provider,
                    ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
                    state: event.state,
                    type: "compute_preparation",
                })}\n`,
            );
        });
        response.once("close", unsubscribe);
        return;
    }
    if (request.method === "GET" && url.pathname === "/compute/instances") {
        sendJson(response, 200, {
            instances: requireComputeRegistry(options).listInstances(
                requireCompute(options).generation,
            ),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/plugins") {
        const snapshot = await options.listPlugins();
        const bounded = snapshot.slice(0, MAX_INSTALLED_PLUGINS);
        const self = snapshot.find((plugin) => plugin.folder === options.pluginFolder);
        if (self !== undefined && !bounded.includes(self)) {
            bounded[bounded.length - 1] = self;
        }
        const plugins = bounded.map(
            (plugin): HappyPlugin => ({
                ...(plugin.compute === undefined ? {} : { compute: plugin.compute }),
                folder: plugin.folder,
                isSelf: plugin.folder === options.pluginFolder,
                name: plugin.name,
                state: plugin.status,
                ...(plugin.statusMessage === undefined ? {} : { status: plugin.statusMessage }),
                version: plugin.version,
            }),
        );
        sendJson<{ plugins: readonly HappyPlugin[] }>(response, 200, { plugins });
        return;
    }
    if (request.method === "GET" && url.pathname === "/slots") {
        const input = parseValue(
            listHappySlotEntriesInputSchema,
            {
                ...(url.searchParams.has("projectId")
                    ? { projectId: url.searchParams.get("projectId") ?? "" }
                    : {}),
                ...(url.searchParams.has("sessionId")
                    ? { sessionId: url.searchParams.get("sessionId") ?? "" }
                    : {}),
                ...(url.searchParams.has("slot")
                    ? { slot: url.searchParams.get("slot") ?? "" }
                    : {}),
                ...(url.searchParams.has("workspaceId")
                    ? { workspaceId: url.searchParams.get("workspaceId") ?? "" }
                    : {}),
            },
            "Slot list settings",
        );
        sendJson<{ entries: readonly HappySlotEntry[] }>(response, 200, {
            entries: options.store.slots.list(input),
        });
        return;
    }
    if (request.method === "POST" && url.pathname === "/slots") {
        const body = await readJson(request, createHappySlotEntryInputSchema, "Slot entry");
        try {
            sendJson<{ entry: HappySlotEntry }>(response, 201, {
                entry: options.store.slots.create({
                    ...body,
                    author: {
                        folder: options.pluginFolder,
                        name: options.pluginName,
                        type: "plugin",
                    },
                }),
            });
        } catch (error) {
            if (error instanceof SlotEntryInvalidError) {
                throw new PluginApiRequestError(error.message);
            }
            throw error;
        }
        return;
    }
    if (request.method === "POST" && url.pathname === "/media") {
        const generatedMedia = requireGeneratedMedia(options);
        const pluginDataDirectory = requirePluginDataDirectory(options);
        const body = await readJson(
            request,
            publishHappyMediaBodySchema,
            "Published media",
            MAX_MEDIA_REQUEST_BYTES,
        );
        const bytes =
            "contentBase64" in body
                ? Buffer.from(body.contentBase64, "base64")
                : await readPluginMediaFile(pluginDataDirectory, body.path);
        if (bytes.byteLength > HAPPY_PLUGIN_MAX_MEDIA_BYTES) {
            throw new PluginApiRequestTooLargeError(
                `Plugin media cannot exceed ${String(HAPPY_PLUGIN_MAX_MEDIA_BYTES)} bytes.`,
            );
        }
        const preferredName =
            body.name ?? ("path" in body ? basename(body.path) : "plugin-media.bin");
        const written = await generatedMedia.write(bytes, {
            extension: extname(preferredName),
            preferredName,
        });
        sendJson<PublishedHappyMedia>(response, 201, {
            bytes: bytes.byteLength,
            location: written.location,
            name: basename(written.hostPath),
        });
        return;
    }

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "POST" && url.pathname === "/compute/providers") {
        assertStartupContribution(options, "Compute provider registration");
        const body = await readJson(
            request,
            registerHappyComputeProviderInputSchema,
            "Compute provider registration",
        );
        sendJson(response, 201, {
            registrationId: requireCompute(options).register(body),
        });
        return;
    }
    if (request.method === "POST" && url.pathname === "/compute/instances") {
        const body = await readJson(
            request,
            createHappyComputeBodySchema,
            "Compute instance settings",
        );
        sendJson(
            response,
            201,
            requireComputeRegistry(options).create(body, requireCompute(options).generation),
        );
        return;
    }
    if (
        parts.length === 4 &&
        parts[0] === "compute" &&
        parts[1] === "providers" &&
        parts[2] !== undefined &&
        parts[3] === "events" &&
        request.method === "GET"
    ) {
        assertStartupContribution(options, "Compute provider stream attachment");
        const compute = requireCompute(options);
        const detach = compute.attach(parts[2], (event) => {
            if (response.destroyed || response.writableEnded) return false;
            // Node accepting the write into its bounded socket buffer still means the event was
            // delivered. Stream closure, rather than temporary backpressure, retires a provider.
            response.write(`${JSON.stringify(event)}\n`);
            return true;
        });
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        response.once("close", detach);
        return;
    }
    if (
        parts.length === 6 &&
        parts[0] === "compute" &&
        parts[1] === "providers" &&
        parts[2] !== undefined &&
        parts[3] === "calls" &&
        parts[4] !== undefined &&
        parts[5] === "acknowledge" &&
        request.method === "POST"
    ) {
        requireCompute(options).acknowledge(parts[2], parts[4]);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 6 &&
        parts[0] === "compute" &&
        parts[1] === "providers" &&
        parts[2] !== undefined &&
        parts[3] === "calls" &&
        parts[4] !== undefined &&
        parts[5] === "progress" &&
        request.method === "POST"
    ) {
        const progress = await readJson(
            request,
            happyComputeProvisioningProgressSchema,
            "Compute provisioning progress",
        );
        requireCompute(options).progress(parts[2], parts[4], progress);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 5 &&
        parts[0] === "compute" &&
        parts[1] === "providers" &&
        parts[2] !== undefined &&
        parts[3] === "calls" &&
        parts[4] !== undefined &&
        request.method === "POST"
    ) {
        const completion = await readJson(
            request,
            Type.Unknown(),
            "Compute provider result",
            MAX_COMPUTE_COMPLETION_REQUEST_BYTES,
        );
        requireCompute(options).complete(parts[2], parts[4], completion);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 3 &&
        parts[0] === "compute" &&
        parts[1] === "providers" &&
        parts[2] !== undefined &&
        request.method === "DELETE"
    ) {
        requireCompute(options).unregister(parts[2]);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length >= 4 &&
        parts[0] === "compute" &&
        parts[1] === "instances" &&
        parts[2] !== undefined &&
        request.method === "POST"
    ) {
        const compute = requireComputeRegistry(options);
        const instanceId = parts[2];
        if (parts.length === 5 && parts[3] === "files" && parts[4] === "read") {
            const body = await readJson(
                request,
                readHappyComputeBodySchema,
                "Compute file read settings",
            );
            sendJson(
                response,
                200,
                await compute.read(
                    { instanceId, path: body.path },
                    requireCompute(options).generation,
                ),
            );
            return;
        }
        if (parts.length === 5 && parts[3] === "files" && parts[4] === "write") {
            const body = await readJson(
                request,
                writeHappyComputeBodySchema,
                "Compute file write settings",
                MAX_WORKSPACE_FILE_REQUEST_BYTES,
            );
            await compute.write(
                {
                    bytes: Buffer.from(body.contentBase64, "base64"),
                    instanceId,
                    path: body.path,
                },
                requireCompute(options).generation,
            );
            sendJson(response, 200, {});
            return;
        }
        if (parts.length === 4 && parts[3] === "exec") {
            const body = await readJson(
                request,
                execHappyComputeBodySchema,
                "Compute command settings",
            );
            sendJson(
                response,
                200,
                await compute.exec(
                    {
                        command: body.command,
                        instanceId,
                        timeoutMs: body.timeoutMs ?? HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
                    },
                    requireCompute(options).generation,
                ),
            );
            return;
        }
        if (parts.length === 4 && parts[3] === "stop") {
            await compute.stop(instanceId, requireCompute(options).generation);
            sendJson(response, 200, {});
            return;
        }
    }
    if (
        parts.length === 2 &&
        parts[0] === "slots" &&
        parts[1] !== undefined &&
        request.method === "PATCH"
    ) {
        const body = await readJson(request, updateHappySlotEntryInputSchema, "Slot entry update");
        try {
            sendJson<{ entry: HappySlotEntry }>(response, 200, {
                entry: options.store.slots.update(parts[1], body),
            });
        } catch (error) {
            if (error instanceof SlotEntryInvalidError) {
                throw new PluginApiRequestError(error.message);
            }
            if (error instanceof SlotEntryNotFoundError) {
                sendJson(response, 404, { error: error.message });
                return;
            }
            throw error;
        }
        return;
    }
    if (
        parts.length === 2 &&
        parts[0] === "slots" &&
        parts[1] !== undefined &&
        request.method === "DELETE"
    ) {
        try {
            sendJson<{ entry: HappySlotEntry }>(response, 200, {
                entry: options.store.slots.remove(parts[1]),
            });
        } catch (error) {
            if (error instanceof SlotEntryNotFoundError) {
                sendJson(response, 404, { error: error.message });
                return;
            }
            throw error;
        }
        return;
    }
    if (
        request.method === "POST" &&
        parts.length >= 3 &&
        parts[0] === "workspaces" &&
        parts[1] !== undefined
    ) {
        const workspace = options.store
            .listWorkspaces()
            .find((candidate) => candidate.id === parts[1]);
        if (workspace === undefined) {
            sendJson(response, 404, { error: "Workspace not found." });
            return;
        }
        if (workspace.status !== "ready" || workspace.presence !== "present") {
            sendJson(response, 409, {
                error: "The workspace is still initializing or its directory is unavailable.",
            });
            return;
        }
        if (parts.length === 3 && parts[2] === "exec") {
            const body = await readJson(
                request,
                executeWorkspaceCommandBodySchema,
                "Workspace command settings",
            );
            sendJson(
                response,
                200,
                await executeWorkspaceCommand(
                    workspace.path,
                    body.command,
                    body.timeoutMs ?? HAPPY_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS,
                ),
            );
            return;
        }
        if (parts.length === 4 && parts[2] === "files" && parts[3] === "read") {
            const body = await readJson(
                request,
                readWorkspaceFileBodySchema,
                "Workspace file read settings",
            );
            sendJson(response, 200, await readPluginWorkspaceFile(workspace.path, body.path));
            return;
        }
        if (parts.length === 4 && parts[2] === "files" && parts[3] === "write") {
            const body = await readJson(
                request,
                writeWorkspaceFileBodySchema,
                "Workspace file write settings",
                MAX_WORKSPACE_FILE_REQUEST_BYTES,
            );
            sendJson(
                response,
                200,
                await writePluginWorkspaceFile(
                    workspace.path,
                    body.path,
                    Buffer.from(body.contentBase64, "base64"),
                ),
            );
            return;
        }
    }
    if (request.method === "POST" && url.pathname === "/mcp/servers") {
        assertStartupContribution(options, "MCP registration");
        const mcp = requireMcp(options);
        const registration = await readJson(
            request,
            happyMcpServerRegistrationSchema,
            "MCP server registration",
        );
        sendJson(response, 201, { registrationId: mcp.register(registration) });
        return;
    }
    if (request.method === "POST" && url.pathname === "/hooks/system-prompt") {
        assertStartupContribution(options, "System-prompt hook registration");
        const hooks = requireHooks(options);
        sendJson(response, 201, {
            registrationId: runHookRegistrationOperation(() => hooks.registerSystemPrompt()),
        });
        return;
    }
    if (request.method === "POST" && url.pathname === "/tracing/subscriptions") {
        assertActiveGeneration(options, "Tracing subscription registration");
        const hooks = requireHooks(options);
        sendJson(response, 201, {
            registrationId: runHookRegistrationOperation(() => hooks.registerTracing()),
        });
        return;
    }
    if (
        parts.length === 4 &&
        parts[0] === "hooks" &&
        parts[1] === "system-prompt" &&
        parts[2] !== undefined &&
        parts[3] === "events" &&
        request.method === "GET"
    ) {
        assertStartupContribution(options, "System-prompt hook stream attachment");
        const hooks = requireHooks(options);
        const registrationId = parts[2];
        const detach = runHookRegistrationOperation(() =>
            hooks.attachSystemPrompt(registrationId, (event) => {
                if (response.destroyed || response.writableEnded) {
                    throw new Error("The plugin system-prompt stream is closed.");
                }
                // A false return means Node buffered the event; it was still delivered. The hook's
                // deadline, not socket backpressure, decides whether the call missed.
                response.write(`${JSON.stringify(event)}\n`);
            }),
        );
        response.once("close", detach);
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        return;
    }
    if (
        parts.length === 4 &&
        parts[0] === "tracing" &&
        parts[1] === "subscriptions" &&
        parts[2] !== undefined &&
        parts[3] === "events" &&
        request.method === "GET"
    ) {
        assertActiveGeneration(options, "Tracing subscription stream attachment");
        const hooks = requireHooks(options);
        const registrationId = parts[2];
        const detach = runHookRegistrationOperation(() =>
            hooks.attachTracing(registrationId, (event) => {
                if (response.destroyed || response.writableEnded) return false;
                return response.write(`${JSON.stringify(event)}\n`);
            }),
        );
        response.once("close", detach);
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        hooks.drainTracing(registrationId);
        response.on("drain", () => {
            try {
                hooks.drainTracing(registrationId);
            } catch {
                // The subscription may have closed while buffered output was draining.
            }
        });
        return;
    }
    if (
        parts.length === 5 &&
        parts[0] === "hooks" &&
        parts[1] === "system-prompt" &&
        parts[2] !== undefined &&
        parts[3] === "calls" &&
        parts[4] !== undefined &&
        request.method === "POST"
    ) {
        const completion = await readJson(
            request,
            happySystemPromptHookCompletionSchema,
            "System-prompt hook result",
        );
        const hooks = requireHooks(options);
        const registrationId = parts[2];
        const callId = parts[4];
        runHookRegistrationOperation(() =>
            hooks.completeSystemPrompt(registrationId, callId, completion),
        );
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 3 &&
        parts[0] === "hooks" &&
        parts[1] === "system-prompt" &&
        parts[2] !== undefined &&
        request.method === "DELETE"
    ) {
        requireHooks(options).unregisterSystemPrompt(parts[2]);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 3 &&
        parts[0] === "tracing" &&
        parts[1] === "subscriptions" &&
        parts[2] !== undefined &&
        request.method === "DELETE"
    ) {
        requireHooks(options).unregisterTracing(parts[2]);
        sendJson(response, 200, {});
        return;
    }
    if (
        request.method === "POST" &&
        (url.pathname === "/network/requests" || url.pathname === "/network/tunnels")
    ) {
        assertStartupContribution(options, "Network listener registration");
        const network = requireNetwork(options);
        sendJson(response, 201, {
            registrationId: network.register(
                url.pathname === "/network/requests" ? "request" : "tunnel",
            ),
        });
        return;
    }
    if (
        parts.length === 4 &&
        parts[0] === "network" &&
        (parts[1] === "requests" || parts[1] === "tunnels") &&
        parts[2] !== undefined &&
        parts[3] === "events" &&
        request.method === "GET"
    ) {
        assertStartupContribution(options, "Network listener stream attachment");
        const network = requireNetwork(options);
        let writable = true;
        const onDrain = () => {
            writable = true;
        };
        let detach = () => {};
        detach = network.attach(parts[2], (event) => {
            if (!writable || response.destroyed || response.writableEnded) return false;
            const line = encodeNetworkEvent(event);
            if (line === undefined) return false;
            const accepted = response.write(line);
            if (!accepted) {
                // At most this one bounded event is queued. Further events fail open until Node
                // reports that the socket drained, so a stalled plugin cannot grow daemon memory.
                writable = false;
                response.once("drain", onDrain);
            }
            return accepted;
        });
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        response.once("close", () => {
            response.off("drain", onDrain);
            detach();
        });
        return;
    }
    if (
        parts.length === 5 &&
        parts[0] === "network" &&
        parts[1] === "requests" &&
        parts[2] !== undefined &&
        parts[3] === "calls" &&
        parts[4] !== undefined &&
        request.method === "POST"
    ) {
        const completion = await readJson(
            request,
            happyNetworkRequestCompletionSchema,
            "Network request result",
        );
        requireNetwork(options).complete(parts[2], parts[4], completion);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 3 &&
        parts[0] === "network" &&
        (parts[1] === "requests" || parts[1] === "tunnels") &&
        parts[2] !== undefined &&
        request.method === "DELETE"
    ) {
        requireNetwork(options).unregister(parts[2]);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 4 &&
        parts[0] === "mcp" &&
        parts[1] === "servers" &&
        parts[2] !== undefined &&
        parts[3] === "events" &&
        request.method === "GET"
    ) {
        assertStartupContribution(options, "MCP stream attachment");
        const mcp = requireMcp(options);
        let detach = () => {};
        detach = mcp.attach(parts[2], (event) => {
            if (response.destroyed || response.writableEnded) return false;
            response.write(`${JSON.stringify(event)}\n`);
            return true;
        });
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        response.once("close", detach);
        return;
    }
    if (
        parts.length === 5 &&
        parts[0] === "mcp" &&
        parts[1] === "servers" &&
        parts[2] !== undefined &&
        parts[3] === "calls" &&
        parts[4] !== undefined &&
        request.method === "POST"
    ) {
        const mcp = requireMcp(options);
        let completion;
        try {
            completion = await readJson(request, happyMcpCallCompletionSchema, "MCP tool result");
        } catch (error) {
            // A malformed or oversized completion must settle the model call now. Leaving it
            // pending would turn a precise boundary error into an unrelated timeout.
            try {
                mcp.complete(parts[2], parts[4], {
                    error: `Rig rejected the plugin MCP result: ${errorToMessage(error)}`,
                });
            } catch {
                // The call may already have been cancelled or retired; preserve the request error.
            }
            throw error;
        }
        mcp.complete(parts[2], parts[4], completion);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 3 &&
        parts[0] === "mcp" &&
        parts[1] === "servers" &&
        parts[2] !== undefined &&
        request.method === "DELETE"
    ) {
        requireMcp(options).unregister(parts[2]);
        sendJson(response, 200, {});
        return;
    }
    if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "agents" &&
        parts[1] !== undefined &&
        parts[2] === "messages"
    ) {
        const body = await readJson(request, sendAgentMessageBodySchema, "Agent message");
        const target = options.store.findByAgentId(parts[1]);
        if (target === undefined) {
            sendJson(response, 404, { error: "No agent has that Agent ID." });
            return;
        }
        const delivered = target.deliverNotification({
            displayText: `${options.pluginName}: ${body.message}`,
            text: [
                `Message from the Rig plugin ${JSON.stringify(options.pluginName)}.`,
                "",
                body.message,
            ].join("\n"),
        });
        sendJson<AgentMessageDelivery>(response, 202, {
            delivered: true,
            runId: delivered.runId,
            sessionId: delivered.sessionId,
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
            const body = await readJson(request, createWorkspaceBodySchema, "Workspace settings");
            try {
                const workspace = await options.store.createWorkspace(projectId, {
                    ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                    ...(body.id === undefined ? {} : { id: body.id }),
                    name: body.name,
                });
                if (workspace === undefined) {
                    sendJson(response, 404, { error: "Project not found." });
                    return;
                }
                sendJson<{ workspace: HappyWorkspace }>(response, 202, {
                    workspace: toHappyWorkspace(workspace),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                const message = errorToMessage(error);
                sendJson(response, message.includes("already names") ? 409 : 400, {
                    error: message,
                });
            }
            return;
        }
        const workspaceId = parts[3];
        if (workspaceId !== undefined && request.method === "PATCH" && parts.length === 4) {
            const body = await readJson(
                request,
                renameWorkspaceBodySchema,
                "Workspace rename settings",
            );
            const workspace = options.store.renameWorkspace(
                projectId,
                workspaceId,
                body.name,
                body.version,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found." });
                return;
            }
            sendJson<{ workspace: HappyWorkspace }>(response, 200, {
                workspace: toHappyWorkspace(workspace),
            });
            return;
        }
        if (
            workspaceId !== undefined &&
            request.method === "POST" &&
            parts.length === 5 &&
            parts[4] === "archive"
        ) {
            const body = await readJson(
                request,
                archiveWorkspaceBodySchema,
                "Workspace archive settings",
            );
            const workspace = await options.store.archiveWorkspace(
                projectId,
                workspaceId,
                body.version,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found." });
                return;
            }
            sendJson<{ workspace: HappyWorkspace }>(response, 202, {
                workspace: toHappyWorkspace(workspace),
            });
            return;
        }
    }

    sendJson(response, 404, { error: "This Rig plugin API action does not exist." });
}

function requireGeneratedMedia(options: CreatePluginApiServerOptions): GeneratedMediaStore {
    if (options.generatedMedia !== undefined) return options.generatedMedia;
    throw new PluginApiRequestError("Generated media is unavailable to this plugin.");
}

function requireCompute(options: CreatePluginApiServerOptions): PluginComputeConnection {
    if (options.compute !== undefined) return options.compute;
    throw new PluginApiRequestError("Compute registration is unavailable to this plugin.");
}

function requireComputeRegistry(options: CreatePluginApiServerOptions): PluginComputeRegistry {
    if (options.computeRegistry !== undefined) return options.computeRegistry;
    throw new PluginApiRequestError("Compute providers are unavailable to this plugin.");
}

function requirePluginDataDirectory(options: CreatePluginApiServerOptions): string {
    if (options.pluginDataDirectory !== undefined) return options.pluginDataDirectory;
    throw new PluginApiRequestError("This plugin has no writable folder for media publishing.");
}

function toHappyProject(project: Project): HappyProject {
    return {
        ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
        id: project.id,
        name: project.name,
        path: project.path,
    };
}

function toHappyWorkspace(workspace: ProjectWorkspace): HappyWorkspace {
    return {
        ...(workspace.archivedAt === undefined ? {} : { archivedAt: workspace.archivedAt }),
        ...(workspace.baseRef === undefined ? {} : { baseRef: workspace.baseRef }),
        ...(workspace.error === undefined ? {} : { error: workspace.error }),
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        projectId: workspace.projectId,
        status: workspace.status,
        version: workspace.version,
    };
}

function toHappySession(
    store: SessionStore,
    session: Pick<
        SessionSummary,
        "archived" | "cwd" | "id" | "projectId" | "status" | "title" | "workspaceId"
    >,
): HappySession {
    const agentId = store.get(session.id)?.agentIdentity().agentId;
    if (agentId === undefined) {
        throw new Error(`Rig could not resolve the agent for session ${session.id}.`);
    }
    return {
        agentId,
        archived: session.archived,
        cwd: session.cwd,
        id: session.id,
        projectId: session.projectId,
        status: session.status,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    };
}

async function readJson<TSchema_ extends TSchema>(
    request: IncomingMessage,
    schema: TSchema_,
    subject: string,
    maximumBytes = MAX_REQUEST_BYTES,
): Promise<Static<TSchema_>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maximumBytes) {
            throw new PluginApiRequestTooLargeError("The plugin request is too large.");
        }
        chunks.push(bytes);
    }
    let value: unknown;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new PluginApiRequestError("The plugin request is not valid JSON.");
    }
    return parseValue(schema, value, subject);
}

function parseValue<TSchema_ extends TSchema>(
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

function requireMcp(options: CreatePluginApiServerOptions): PluginMcpConnection {
    if (options.mcp === undefined) {
        throw new PluginApiRequestError("This plugin runtime does not provide MCP registration.");
    }
    return options.mcp;
}

function requireHooks(options: CreatePluginApiServerOptions): PluginHookConnection {
    if (options.hooks === undefined) {
        throw new PluginApiRequestError("This plugin runtime does not provide hooks.");
    }
    return options.hooks;
}

function requireNetwork(options: CreatePluginApiServerOptions): PluginNetworkConnection {
    if (options.network === undefined) {
        throw new PluginApiRequestError("Plugin network interception is unavailable.");
    }
    return options.network;
}

function encodeNetworkEvent(event: unknown): string | undefined {
    try {
        const line = `${JSON.stringify(Value.Decode(happyNetworkEventSchema, event))}\n`;
        return Buffer.byteLength(line) <= HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES ? line : undefined;
    } catch {
        return undefined;
    }
}

class PluginHookConflictError extends Error {}

function runHookRegistrationOperation<T>(operation: () => T): T {
    try {
        return operation();
    } catch (error) {
        throw new PluginHookConflictError(errorToMessage(error));
    }
}

function assertStartupContribution(
    options: CreatePluginApiServerOptions,
    contribution: string,
): void {
    try {
        options.startup.assertStarting(contribution);
    } catch (error) {
        throw new PluginApiRequestError(errorToMessage(error));
    }
}

function assertActiveGeneration(options: CreatePluginApiServerOptions, contribution: string): void {
    try {
        options.startup.assertActive(contribution);
    } catch (error) {
        throw new PluginApiRequestError(errorToMessage(error));
    }
}
