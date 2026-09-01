import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as inspector from "node:inspector";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import {
    createSecretRequestSchema,
    secretAttachmentMutationRequestSchema,
    updateSecretRequestSchema,
    archiveBotRequestSchema,
    cloudKeyValueSchema,
    createBotRequestSchema,
    renameBotRequestSchema,
    reorderBotRequestSchema,
    unarchiveBotRequestSchema,
    configPatchSchema,
    providerVerificationRequestSchema,
    type MessageMode,
} from "@slopus/happy-agent-client";
import {
    cuid2Schema,
    currentAgentEnvironment,
    type AgentConfig,
    type AgentBaseMessageOptions,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, shutdown, type Context } from "@steve.kite/stdlib";
import { WebSocketServer } from "ws";

import { AbortModule } from "../abort/index.js";
import {
    BotAvatarInputError,
    BotConflictError,
    BotNotFoundError,
    BotsModule,
    type BotEvent,
    type BotRecord,
} from "../bots/index.js";
import {
    CompactionAgentBusyError,
    CompactionAlreadyRunningError,
    CompactionsModule,
    compactionSchema,
    type Compaction,
} from "../compactions/index.js";
import { ComputeModule, type ComputeProcessEvent } from "../compute/index.js";
import { ConfigModule } from "../config/index.js";
import { CloudModule, CloudOperationError, type CloudSocialMutationKind } from "../cloud/index.js";
import { EventsModule, eventIdSchema, type AgentEvent } from "../events/index.js";
import {
    fileReadQuerySchema,
    fileRevisionQuerySchema,
    fileSearchQuerySchema,
    fileTreeQuerySchema,
    fileWriteSchema,
    ProjectFileError,
    ProjectFilesModule,
} from "../files/index.js";
import { GitModule } from "../git/index.js";
import { HappyIntegrationStartError, HappyModule } from "../happy/index.js";
import {
    HistoryModule,
    type HistoryPendingMessage,
    type HistoryRunState,
} from "../history/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { decodeRequestProfile, requestProfilesForAgent } from "../impl/requestProfile.js";
import {
    PermissionsModule,
    type PermissionEvent,
    type ToolPermissionReview,
} from "../permissions/index.js";
import {
    ProfileModule,
    ProfileVersionConflictError,
    type ProfileChangedEvent,
    type ProfilePhotoContentType,
} from "../profile/index.js";
import {
    ProjectRegistrationError,
    ProjectAvatarInputError,
    ProjectLifecycleError,
    ProjectsModule,
    type Project,
    type ProjectEvent,
} from "../projects/index.js";
import { ProviderUsageModule } from "../providerUsage/index.js";
import { ProviderNotFoundError, ProviderScanModule } from "../providerScan/index.js";
import {
    SlashCommandInputError,
    SlashCommandNotFoundError,
    SlashCommandsModule,
    slashCommandCatalogEventPayloadSchema,
} from "../slashCommands/index.js";
import {
    SecretApiConflictError,
    secretApiIdSchema,
    SecretApiInputError,
    SecretsModule,
    type SecretApiRecord,
    type SecretApiTarget,
    type SecretEvent,
} from "../secrets/index.js";
import {
    TerminalError,
    TerminalsModule,
    type TerminalEvent,
    type TerminalScope,
} from "../terminals/index.js";
import {
    teamUser,
    TEAM_ONBOARDING_PROFILE_VERSION,
    TeamAuthenticationError,
    TeamModule,
    TeamProfileInputError,
    TeamProfileVersionConflictError,
    type TeamUser,
} from "../team/index.js";
import {
    createNodeBinaryWebSocket,
    createSseWriter,
    type SseWriter,
    WebSocketDuplex,
} from "../transport/index.js";
import { UsageModule, type UsageCurrentContext } from "../usage/index.js";
import { UserInputModule, type UserInputEvent } from "../userInput/index.js";
import {
    WorkspaceInputError,
    WorkspaceLifecycleError,
    WorkspacesModule,
    type Workspace,
    type WorkspaceEvent,
} from "../workspaces/index.js";
import { ApiError, invalidRequest, notFound, type ApiErrorCode } from "./ApiError.js";
import { ApiEventJournal, type ApiEvent } from "./ApiEventJournal.js";
import {
    messageHiddenFromUser,
    messageResource,
    providerMessageContent,
    reviewedToolCalls,
    toolResultPresentations,
} from "./ApiMessageProjection.js";
import { prepareLocalApiToken } from "./prepareLocalApiToken.js";
import {
    agentResource,
    agentModeFromConfig,
    apiResourceVersion,
    botResource,
    botWorkspaceResource,
    gitResource,
    profileResource,
    projectResource,
    questionResource,
    rootWorkspaceResource,
    terminalResource,
    workspaceResource,
} from "./ApiResourceProjection.js";
import {
    abortBodySchema,
    agentCreateBodySchema,
    apiIdSchema,
    cloudMutationRequestSchema,
    cloudSocialMutationRequestSchema,
    completeCloudAuthorizationRequestSchema,
    createCloudKeysRequestSchema,
    deleteCloudKeysRequestSchema,
    documentBodySchema,
    draftBodySchema,
    emptyMutationBodySchema,
    enrollCloudProfileRequestSchema,
    gitWatchBodySchema,
    invokeSlashCommandRequestSchema,
    messageSendBodySchema,
    profilePatchBodySchema,
    projectCloneBodySchema,
    projectRegisterBodySchema,
    projectSettingsBodySchema,
    questionAnswerBodySchema,
    renameBodySchema,
    reorderBodySchema,
    restoreCloudKeysRequestSchema,
    securityDocumentBodySchema,
    startCloudAuthorizationRequestSchema,
    terminalCreateBodySchema,
    terminalResizeBodySchema,
    workspaceCreateBodySchema,
} from "./ApiSchemas.js";
import { WorkspaceProxy } from "./WorkspaceProxy.js";

const API_PROTOCOL_VERSION = 23;
const MAX_JSON_BODY_BYTES = 48 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const MAX_TERMINAL_WIRE_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;
const MAX_ANNOUNCED_PENDING_MESSAGES = 10_000;
const MAX_ANNOUNCED_AGENT_CREATIONS = 10_000;
const MAX_ANNOUNCED_TERMINAL_RUNS = 10_000;
const DRAIN_MUTATION_LOG_INTERVAL_MS = 5_000;

interface AcceptedMessageBatch {
    readonly kind: "send" | "steering";
    readonly runId: string;
    readonly startedAt: number;
    readonly messages: {
        /** An internal message still starts its run, but never enters `acceptedMessageIds`. */
        readonly hidden: boolean;
        readonly id: string;
        readonly occurredAt: number;
        readonly previousVersion: string;
        readonly version: string;
        readonly mutationId?: string;
    }[];
}

export interface ApiSocketRejection {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly status: number;
}

export type PreparedTerminalSocket =
    | { readonly handled: false }
    | { readonly handled: true; readonly rejection: ApiSocketRejection }
    | {
          readonly attach: (stream: import("node:stream").Duplex) => void;
          readonly handled: true;
      };

export type PreparedWorkspaceProxySocket =
    | { readonly handled: false }
    | { readonly handled: true; readonly rejection: ApiSocketRejection }
    | { readonly handled: true };

export interface ApiDrainAgentProgress {
    readonly id: string;
    readonly stage: "compaction" | "inference" | "settlement" | "tools";
}

export interface ApiDrainProgress {
    /** Exact number of operations still holding this component open. */
    readonly count: number;
    /** Agent detail is sorted and capped by the API before it crosses the wire. */
    readonly agents?: readonly ApiDrainAgentProgress[];
    readonly truncated?: true;
}

export interface ApiDrainSource {
    /** Publish the component's sticky drain and resolve when it reaches its safe edge. */
    readonly start: () => Promise<void>;
    /** Read the component's current structured progress without waiting. */
    readonly progress: () => ApiDrainProgress;
}

interface ApiRunningDrain {
    finished: boolean;
}

/** What one admitted HTTP mutation is, for the log that explains a drain that will not finish. */
interface ApiAdmittedMutation {
    readonly method: string;
    readonly path: string;
    readonly startedAt: number;
}

/**
 * The daemon's complete application protocol boundary.
 *
 * It is an agent module so it can subscribe before any other module starts emitting. It does not
 * own a listener or a socket: the executable binds the Unix socket and forwards requests here.
 */
export class ApiModule implements AgentModule {
    readonly name = "api";

    readonly #abort: AbortModule;
    readonly #config: ConfigModule;
    readonly #events: EventsModule;
    readonly #cloud: CloudModule;
    readonly #compactions: CompactionsModule;
    readonly #bots: BotsModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #terminals: TerminalsModule;
    readonly #files: ProjectFilesModule;
    readonly #git: GitModule;
    readonly #history: HistoryModule;
    readonly #permissions: PermissionsModule;
    readonly #userInput: UserInputModule;
    readonly #usage: UsageModule;
    readonly #providerUsage: ProviderUsageModule;
    readonly #providerScan: ProviderScanModule;
    readonly #happy: HappyModule;
    readonly #profile: ProfileModule;
    readonly #team: TeamModule;
    readonly #compute: ComputeModule;
    readonly #slashCommands: SlashCommandsModule;
    readonly #secrets: SecretsModule;
    readonly #daemonId = createId();
    readonly #daemonStartedAt = Date.now();
    readonly #mutationIds = new AsyncLocalStorage<string>();
    readonly #backgroundScope = new AsyncResource("happy-agent-api");
    /** Agents whose usage-driven metadata refresh is already scheduled. */
    readonly #pendingUsageMetadataAgents = new Set<string>();
    /** Per agent, the streamed assistant message being accumulated block by block. */
    readonly #streamingAssistantBlocks = new Map<
        string,
        {
            committed: Record<string, unknown>[];
            current: Record<string, unknown>[];
            messageId: string;
            runId: string;
        }
    >();
    readonly #streamingDeltaOffsets = new Map<string, number[]>();
    readonly #journal = new MutationAwareApiEventJournal(this.#mutationIds);
    readonly #webSockets = new WebSocketServer({
        maxPayload: MAX_TERMINAL_WIRE_MESSAGE_BYTES,
        noServer: true,
        perMessageDeflate: false,
    });
    readonly #workspaceProxy = new WorkspaceProxy();
    readonly #unsubscribe: (() => void)[] = [];
    readonly #streams = new Set<SseWriter>();
    readonly #shutdownListeners = new Set<() => void | Promise<void>>();
    readonly #drainSources = new Map<string, ApiDrainSource>();
    readonly #runningDrains = new Map<string, ApiRunningDrain>();
    /** HTTP mutations admitted before draining published its read-only boundary. */
    readonly #apiMutations = new Map<symbol, ApiAdmittedMutation>();
    readonly #announcedPendingMessages = new Set<string>();
    readonly #apiPendingMessageIds = new Set<string>();
    readonly #announcedAgentCreations = new Set<string>();
    readonly #pendingAgentCreations = new Set<string>();
    readonly #announcedTerminalRuns = new Set<string>();
    readonly #acceptedMessageBatches = new Map<string, AcceptedMessageBatch>();
    readonly #pendingMessageAnnouncements = new Map<
        string,
        { readonly promise: Promise<void>; readonly resolve: () => void }
    >();
    readonly #messageSendGates = new Map<string, Promise<void>>();
    readonly #agentEventChains = new Map<string, Promise<void>>();
    readonly #backgroundMetadataUpdates = new Set<Promise<void>>();

    #agents: AgentSystemRef | undefined;
    #ready = false;
    #draining = false;
    #drainMutationsLoggedAt = 0;
    #closed = false;
    #token: string | undefined;
    #preparePromise: Promise<void> | undefined;

    constructor(
        abort: AbortModule,
        config: ConfigModule,
        events: EventsModule,
        cloud: CloudModule,
        compactions: CompactionsModule,
        bots: BotsModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        terminals: TerminalsModule,
        files: ProjectFilesModule,
        git: GitModule,
        history: HistoryModule,
        permissions: PermissionsModule,
        userInput: UserInputModule,
        usage: UsageModule,
        providerUsage: ProviderUsageModule,
        providerScan: ProviderScanModule,
        happy: HappyModule,
        profile: ProfileModule,
        compute: ComputeModule,
        slashCommands: SlashCommandsModule,
        secrets: SecretsModule,
        team: TeamModule,
    ) {
        this.#abort = abort;
        this.#config = config;
        this.#events = events;
        this.#cloud = cloud;
        this.#compactions = compactions;
        this.#bots = bots;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#terminals = terminals;
        this.#files = files;
        this.#git = git;
        this.#history = history;
        this.#permissions = permissions;
        this.#userInput = userInput;
        this.#usage = usage;
        this.#providerUsage = providerUsage;
        this.#providerScan = providerScan;
        this.#happy = happy;
        this.#profile = profile;
        this.#compute = compute;
        this.#slashCommands = slashCommands;
        this.#secrets = secrets;
        this.#team = team;
    }

    readonly beforeStart = async (
        ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        this.#agents = agents;
        // Install first. Reading or creating the token may touch disk, and no producer should gain
        // a window in which it can emit while the API is awaiting that work.
        this.#subscribeToModules(ctx);
        await this.prepare();
        return {
            metadataChangedTransact: async (hookCtx, scope, change) => {
                const archivedAt = change.update["archivedAt"];
                if (
                    !Object.hasOwn(change.update, "archivedAt") ||
                    (archivedAt !== null && typeof archivedAt !== "number")
                ) {
                    return;
                }
                await this.#refreshAgentOwnerVisibility(
                    hookCtx,
                    scope.agent.id,
                    archivedAt === null,
                );
            },
        };
    };

    get ready(): boolean {
        return this.#ready;
    }

    token(): string | undefined {
        return this.#token;
    }

    /** Prepare authentication before the executable exposes the starting-health socket. */
    async prepare(): Promise<void> {
        this.#preparePromise ??= (async () => {
            this.#token = await prepareLocalApiToken(
                this.#config.configuration.paths.tokenPath,
                this.#config.configuration.values?.feature?.team?.enabled ?? false,
            );
        })();
        await this.#preparePromise;
    }

    cursor(): string {
        return this.#journal.cursor();
    }

    /** Subscribe to the daemon-level shutdown request after the response has been flushed. */
    onShutdown(listener: () => void | Promise<void>): () => void {
        this.#shutdownListeners.add(listener);
        return () => {
            this.#shutdownListeners.delete(listener);
        };
    }

    /** Register one stable component that the daemon-level drain waits for and reports. */
    onDrain(name: string, source: ApiDrainSource): () => void {
        if (name.length === 0) throw new Error("A drain source must have a name.");
        if (this.#draining) throw new Error("The daemon has already started draining.");
        if (this.#drainSources.has(name)) {
            throw new Error(`A drain source named "${name}" is already registered.`);
        }
        this.#drainSources.set(name, source);
        return () => {
            if (this.#drainSources.get(name) === source) this.#drainSources.delete(name);
        };
    }

    async markReady(): Promise<void> {
        if (this.#closed) throw new Error("The API module is already closed.");
        this.#ready = true;
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#ready = false;
        for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
        this.#shutdownListeners.clear();
        this.#drainSources.clear();
        this.#runningDrains.clear();
        this.#apiMutations.clear();
        const streamDone = [...this.#streams].map((stream) => stream.done);
        for (const stream of this.#streams) stream.close();
        await Promise.all(streamDone);
        this.#streams.clear();
        this.#announcedPendingMessages.clear();
        this.#apiPendingMessageIds.clear();
        this.#announcedAgentCreations.clear();
        this.#pendingAgentCreations.clear();
        this.#acceptedMessageBatches.clear();
        for (const pending of this.#pendingMessageAnnouncements.values()) pending.resolve();
        this.#pendingMessageAnnouncements.clear();
        this.#messageSendGates.clear();
        await Promise.allSettled(this.#agentEventChains.values());
        this.#agentEventChains.clear();
        await Promise.allSettled(this.#backgroundMetadataUpdates);
        this.#backgroundMetadataUpdates.clear();
        this.#backgroundScope.emitDestroy();
        for (const client of this.#webSockets.clients) client.terminate();
        this.#webSockets.close();
        await this.#workspaceProxy.close();
    }

    async handleRequest(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        setCommonHeaders(response);
        let finishMutation: (() => void) | undefined;
        try {
            ctx = await this.#authenticate(ctx, request.headers.authorization);
            const url = requestUrl(request);
            if (request.method === "GET" && url.pathname === "/v0/health") {
                sendJson(response, 200, this.#health(ctx));
                return;
            }
            if (!this.#ready) {
                throw new ApiError(503, "not_initialized", "Happy Agent is still starting.");
            }
            if (
                this.#team.enabled &&
                teamUser(ctx) === undefined &&
                !isTeamOnboardingRoute(request.method, url.pathname)
            ) {
                throw new ApiError(401, "unauthorized", "Unauthorized");
            }
            if (this.#isMutation(request, url)) {
                if (this.#draining) {
                    throw new ApiError(
                        503,
                        "draining",
                        "Happy Agent is draining and no longer accepts mutations.",
                    );
                }
                finishMutation = this.#admitMutation(request, url);
            }
            if (request.method === "GET" && url.pathname === "/") {
                sendJson(response, 200, { text: "Welcome to Happy Agent!" });
                return;
            }
            if (
                (url.pathname === "/v0/workspaces" ||
                    url.pathname.startsWith("/v0/workspaces/") ||
                    url.pathname === "/v0/git/watch") &&
                this.#config.configuration.values.features.workspaces === false
            ) {
                throw new ApiError(503, "unsupported", "Workspaces are disabled in this daemon.");
            }
            if (request.method === "GET" && url.pathname === "/v0/config") {
                sendJson(response, 200, { config: this.#sanitizedConfig() });
                return;
            }
            if (request.method === "PATCH" && url.pathname === "/v0/config") {
                const body = await bodyAs(request, configPatchSchema, "configuration patch");
                if (
                    body.providers === undefined ||
                    Object.keys(body).some((key) => key !== "providers") ||
                    Object.values(body.providers).some(
                        (provider) =>
                            Object.keys(provider).length !== 1 ||
                            !Object.hasOwn(provider, "enabled"),
                    )
                ) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "This daemon can only change provider enablement at runtime.",
                    );
                }
                try {
                    await this.#providerScan.setOverrides(ctx, body.providers);
                } catch (error: unknown) {
                    if (error instanceof ProviderNotFoundError) throw notFound(error.message);
                    throw error;
                }
                this.#journal.append("config.updated", {});
                sendJson(response, 200, { config: this.#sanitizedConfig() });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/providers/scan") {
                const result = await this.#providerScan.scan(ctx);
                this.#journal.append("config.updated", {});
                sendJson(response, 200, result);
                return;
            }
            const providerVerification = /^\/v0\/providers\/([^/]+)\/verify$/u.exec(url.pathname);
            if (request.method === "POST" && providerVerification !== null) {
                const encodedProviderId = providerVerification[1];
                if (encodedProviderId === undefined) throw notFound("Provider not found.");
                const providerId = decodePathSegment(encodedProviderId, "provider ID");
                const body = await bodyAs(
                    request,
                    providerVerificationRequestSchema,
                    "provider verification request",
                );
                try {
                    const result = await this.#providerScan.verify(ctx, providerId, body.level);
                    if (result.status === "passed") this.#journal.append("config.updated", {});
                    sendJson(response, 200, result);
                } catch (error: unknown) {
                    if (error instanceof ProviderNotFoundError) throw notFound(error.message);
                    throw error;
                }
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/config/instructions") {
                sendJson(response, 200, {
                    instructions:
                        (await this.#config.readGlobalInstructions(ctx, 256 * 1_024)) ?? "",
                });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/config/security") {
                sendJson(response, 200, {
                    policy: (await this.#config.readGlobalSecurity(ctx, 32 * 1_024)) ?? "",
                });
                return;
            }
            if (request.method === "PUT" && url.pathname === "/v0/config/instructions") {
                const body = await bodyAs(request, documentBodySchema, "instructions document");
                await this.#withMutationId(body.mutationId, async () => {
                    await writeOwnerOnlyDocument(
                        this.#config.configuration.paths.instructionsPath,
                        body.instructions,
                    );
                    this.#journal.append("config.updated", {});
                });
                sendJson(response, 200, { instructions: body.instructions });
                return;
            }
            if (request.method === "PUT" && url.pathname === "/v0/config/security") {
                const body = await bodyAs(request, securityDocumentBodySchema, "security policy");
                await this.#withMutationId(body.mutationId, async () => {
                    await writeOwnerOnlyDocument(
                        this.#config.configuration.paths.securityPath,
                        body.policy,
                    );
                    this.#journal.append("config.updated", {});
                });
                sendJson(response, 200, { policy: body.policy });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/onboarding") {
                sendJson(response, 200, await this.#onboarding(ctx));
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/onboarding/complete") {
                await writeOwnerOnlyDocument(this.#onboardingMarker(), "complete\n");
                sendJson(response, 200, { completed: true });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/cloud") {
                sendJson(response, 200, { cloud: this.#cloud.status(ctx) });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/cloud/auth/start") {
                const body = await bodyAs(
                    request,
                    startCloudAuthorizationRequestSchema,
                    "Cloud authorization request",
                    8 * 1_024,
                );
                const cloud = await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#cloudOperation(() => this.#cloud.start(ctx, body)),
                );
                sendJson(response, 200, { cloud });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/cloud/auth/complete") {
                const body = await bodyAs(
                    request,
                    completeCloudAuthorizationRequestSchema,
                    "Cloud authorization callback",
                    8 * 1_024,
                );
                const cloud = await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#cloudOperation(() => this.#cloud.complete(ctx, body)),
                );
                sendJson(response, 200, { cloud });
                return;
            }
            if (request.method === "DELETE" && url.pathname === "/v0/cloud/auth") {
                const body = await optionalBodyAs(
                    request,
                    cloudMutationRequestSchema,
                    "Cloud disconnect request",
                    2 * 1_024,
                );
                const cloud = await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#cloudOperation(() => this.#cloud.disconnect(ctx)),
                );
                sendJson(response, 200, { cloud });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/cloud/access-token") {
                const body = await optionalBodyAs(
                    request,
                    cloudMutationRequestSchema,
                    "Cloud access-token request",
                    2 * 1_024,
                );
                const result = await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#cloudOperation(() => this.#cloud.mint(ctx)),
                );
                sendJson(response, 200, result);
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/cloud/keys/create") {
                const body = await bodyAs(
                    request,
                    createCloudKeysRequestSchema,
                    "Cloud key creation",
                    8 * 1_024,
                );
                const cloud = await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#cloudOperation(() => this.#cloud.createKeys(ctx, body)),
                );
                sendJson(response, 200, { cloud });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/cloud/keys/restore") {
                const body = await bodyAs(
                    request,
                    restoreCloudKeysRequestSchema,
                    "Cloud key restoration",
                    8 * 1_024,
                );
                const cloud = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#cloudOperation(() => this.#cloud.restoreKeys(ctx, body)),
                );
                sendJson(response, 200, { cloud });
                return;
            }
            if (request.method === "DELETE" && url.pathname === "/v0/cloud/keys") {
                const body = await bodyAs(
                    request,
                    deleteCloudKeysRequestSchema,
                    "Cloud vault reset",
                    2 * 1_024,
                );
                const cloud = await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#cloudOperation(() => this.#cloud.deleteKeys(ctx, body)),
                );
                sendJson(response, 200, { cloud });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/cloud/keys/backup") {
                const backup = await this.#cloudOperation(() => this.#cloud.getKeyBackup(ctx));
                sendJson(response, 200, { backup });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/cloud/devices") {
                sendJson(
                    response,
                    200,
                    await this.#cloudOperation(() => this.#cloud.getDevices(ctx)),
                );
                return;
            }
            if (request.method === "DELETE" && url.pathname.startsWith("/v0/cloud/devices/")) {
                const match = /^\/v0\/cloud\/devices\/([^/]+)$/.exec(url.pathname);
                if (match === null) throw invalidRequest("The Cloud device route is invalid.");
                await requireEmptyBody(request);
                const deviceId = decodePathSegment(match[1]!, "Cloud device ID");
                if (!Value.Check(cloudKeyValueSchema, deviceId)) {
                    throw invalidRequest("The Cloud device ID is invalid.");
                }
                sendJson(
                    response,
                    200,
                    await this.#cloudOperation(() => this.#cloud.removeDevice(ctx, deviceId)),
                );
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/cloud/profile") {
                sendJson(
                    response,
                    200,
                    await this.#cloudOperation(() => this.#cloud.getProfile(ctx)),
                );
                return;
            }
            if (request.method === "PUT" && url.pathname === "/v0/cloud/profile") {
                const body = await bodyAs(
                    request,
                    enrollCloudProfileRequestSchema,
                    "Cloud enrollment",
                    8 * 1_024,
                );
                const result = await this.#withMutationId(body.mutationId, async () => {
                    return await this.#cloudOperation(() => this.#cloud.enrollProfile(ctx, body));
                });
                sendJson(response, 200, result);
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/cloud/social") {
                sendJson(response, 200, this.#cloud.getSocial(ctx));
                return;
            }
            const cloudSocialMutation = parseCloudSocialMutation(request.method, url.pathname);
            if (cloudSocialMutation !== undefined) {
                const body = await optionalBodyAs(
                    request,
                    cloudSocialMutationRequestSchema,
                    "Cloud friends request",
                    2 * 1_024,
                );
                const result = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#cloudOperation(() =>
                            this.#cloud.mutateSocial(
                                ctx,
                                cloudSocialMutation.mutation,
                                cloudSocialMutation.username,
                            ),
                        ),
                );
                sendJson(response, 200, result);
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/integrations/happy") {
                sendJson(response, 200, { integration: this.#happy.integration(ctx) });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/integrations/happy/start") {
                try {
                    sendJson(response, 200, {
                        integration: await this.#happy.startIntegration(ctx),
                    });
                } catch (error: unknown) {
                    if (error instanceof HappyIntegrationStartError) {
                        throw new ApiError(503, error.code, error.message, {
                            integration: error.integration,
                        });
                    }
                    throw error;
                }
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/integrations/happy/cancel") {
                sendJson(response, 200, {
                    integration: await this.#happy.cancelIntegration(ctx),
                });
                return;
            }
            if (request.method === "DELETE" && url.pathname === "/v0/integrations/happy") {
                sendJson(response, 200, {
                    integration: await this.#happy.disconnectIntegration(ctx),
                });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/integrations/happy/re-pair") {
                try {
                    sendJson(response, 200, {
                        integration: await this.#happy.rePairIntegration(ctx),
                    });
                } catch (error: unknown) {
                    if (error instanceof HappyIntegrationStartError) {
                        throw new ApiError(503, error.code, error.message, {
                            integration: error.integration,
                        });
                    }
                    throw error;
                }
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/profile") {
                sendJson(response, 200, {
                    profile: this.#team.enabled
                        ? teamProfileResource(await this.#team.currentUser(ctx))
                        : profileResource(await this.#profile.ensure(ctx)),
                });
                return;
            }
            if (request.method === "PATCH" && url.pathname === "/v0/profile") {
                if (this.#team.enabled) {
                    await this.#handleTeamProfilePatch(ctx, request, response);
                } else {
                    await this.#handleProfilePatch(ctx, request, response);
                }
                return;
            }
            if (url.pathname === "/v0/profile/photo" && request.method === "GET") {
                const photo = this.#team.enabled
                    ? await this.#team.getCurrentUserPhoto(ctx)
                    : await this.#profile.getPhoto(ctx);
                if (photo === undefined) throw notFound("The profile has no photo.");
                if (request.headers["if-none-match"] === photo.etag) {
                    response.writeHead(304, {
                        "cache-control": "no-store",
                        etag: photo.etag,
                    });
                    response.end();
                    return;
                }
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-length": photo.bytes.byteLength,
                    "content-type": photo.contentType,
                    etag: photo.etag,
                });
                response.end(Buffer.from(photo.bytes));
                return;
            }
            if (url.pathname === "/v0/profile/photo" && request.method === "PUT") {
                const resource = this.#team.enabled
                    ? teamProfileResource(await this.#team.currentUser(ctx))
                    : profileResource(await this.#profile.ensure(ctx));
                const expectedVersion = requireIfMatch(request, resource["version"], {
                    currentVersion: resource["version"],
                    profile: resource,
                });
                const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
                if (
                    contentType !== "image/png" &&
                    contentType !== "image/jpeg" &&
                    contentType !== "image/webp"
                ) {
                    throw invalidRequest("The profile photo must be a PNG, JPEG, or WebP image.");
                }
                const bytes = await readBytes(request, 8 * 1024 * 1024);
                if (this.#team.enabled) {
                    const user = await this.#team.putCurrentUserPhoto(
                        ctx,
                        bytes,
                        contentType as ProfilePhotoContentType,
                        expectedVersion,
                    );
                    sendJson(response, 200, { profile: teamProfileResource(user) });
                } else {
                    const profile = await this.#profile.putPhoto(
                        ctx,
                        bytes,
                        contentType as ProfilePhotoContentType,
                        { expectedVersion },
                    );
                    sendJson(response, 200, { profile: profileResource(profile) });
                }
                return;
            }
            if (url.pathname === "/v0/profile/photo" && request.method === "DELETE") {
                const resource = this.#team.enabled
                    ? teamProfileResource(await this.#team.currentUser(ctx))
                    : profileResource(await this.#profile.ensure(ctx));
                const expectedVersion = requireIfMatch(request, resource["version"], {
                    currentVersion: resource["version"],
                    profile: resource,
                });
                if (this.#team.enabled) {
                    const user = await this.#team.deleteCurrentUserPhoto(ctx, expectedVersion);
                    sendJson(response, 200, { profile: teamProfileResource(user) });
                } else {
                    const profile = await this.#profile.deletePhoto(ctx, {
                        expectedVersion,
                    });
                    sendJson(response, 200, { profile: profileResource(profile) });
                }
                return;
            }
            if (await this.#handleSecretRoute(ctx, request, response, url)) return;
            if (request.method === "GET" && url.pathname === "/v0/bots") {
                sendJson(response, 200, {
                    bots: await Promise.all(
                        (await this.#bots.list(ctx)).map(
                            async (bot) => await this.#botResource(ctx, bot),
                        ),
                    ),
                });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/bots") {
                const body = await bodyAs(request, createBotRequestSchema, "bot creation");
                const { mutationId, ...input } = body;
                const existing =
                    body.id === undefined ? undefined : await this.#bots.get(ctx, body.id);
                const bot = await this.#withMutationId(
                    mutationId,
                    async () => await this.#bots.create(ctx, input),
                );
                // Initial slash-command discovery is part of the same settled public agent
                // snapshot used by ordinary agent creation.
                await this.#slashCommands.catalog(ctx, bot.agentId);
                await this.#queueAgentWork(ctx, bot.agentId, undefined, async () => undefined);
                const resource = await this.#botResource(ctx, bot);
                if (existing === undefined && !this.#announcedAgentCreations.has(bot.agentId)) {
                    const agent = resource["agent"] as Record<string, unknown>;
                    boundedAdd(
                        this.#announcedAgentCreations,
                        bot.agentId,
                        MAX_ANNOUNCED_AGENT_CREATIONS,
                    );
                    this.#journal.append("agent.created", {
                        agent,
                        ...(mutationId === undefined ? {} : { mutationId }),
                    });
                }
                sendJson(response, 201, { bot: resource });
                return;
            }
            if (await this.#handleBotRoute(ctx, request, response, url)) return;
            if (request.method === "GET" && url.pathname === "/v0/projects") {
                const projects = await this.#allProjects(ctx, true);
                sendJson(response, 200, {
                    projects: await Promise.all(
                        projects.map(
                            async (project) => await this.#projectWithAgents(ctx, project),
                        ),
                    ),
                });
                return;
            }
            if (await this.#handleProjectRoute(ctx, request, response, url)) return;
            if (request.method === "GET" && url.pathname === "/v0/workspaces") {
                await this.#handleWorkspaceList(ctx, url, response);
                return;
            }
            if (await this.#handleWorkspaceRoute(ctx, request, response, url)) return;
            if (await this.#handleWorkspaceContentRoute(ctx, request, response, url)) return;
            if (request.method === "POST" && url.pathname === "/v0/git/watch") {
                await this.#handleGitWatch(ctx, request, response);
                return;
            }
            if (await this.#handleAgentRoute(ctx, request, response, url)) return;
            if (request.method === "GET" && url.pathname === "/v0/usage") {
                sendJson(response, 200, await this.#daemonUsage(ctx));
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/bootstrap/desktop") {
                sendJson(response, 200, await this.#desktopBootstrap(ctx));
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/events") {
                this.#handleEventPull(url, response);
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/events/stream") {
                this.#handleEventStream(request, response, url);
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/drain") {
                if (this.#drainSources.size === 0) {
                    sendJson(response, 403, { error: "Daemon draining is not enabled." });
                    return;
                }
                this.#beginDrain(ctx);
                sendJson(response, 202, { draining: true, pid: process.pid });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/shutdown") {
                ctx.log.info(`daemon:shutdown:request pid=${String(process.pid)} source=api`);
                sendJson(response, 202, { shuttingDown: true, pid: process.pid });
                setImmediate(() => {
                    for (const listener of [...this.#shutdownListeners]) {
                        void Promise.resolve(listener()).catch((error: unknown) => {
                            ctx.log.error("A daemon shutdown listener failed.", {}, error);
                        });
                    }
                });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/debug/inspector") {
                inspector.open(0, "127.0.0.1", false);
                sendJson(response, 200, { inspectorUrl: inspector.url() });
                return;
            }
            if (request.method === "DELETE" && url.pathname === "/v0/debug/inspector") {
                const stopped = inspector.url() !== undefined;
                if (stopped) inspector.close();
                sendJson(response, 200, { stopped });
                return;
            }
            throw notFound("The requested endpoint does not exist.");
        } catch (error: unknown) {
            this.#sendError(ctx, response, error);
        } finally {
            finishMutation?.();
        }
    }

    async handleUpgrade(
        ctx: Context,
        request: IncomingMessage,
        socket: Socket,
        head: Buffer,
    ): Promise<boolean> {
        const prepared = await this.prepareTerminalSocket(
            ctx,
            requestUrl(request).pathname,
            request.headers.authorization,
        );
        if (!prepared.handled) return false;
        if ("rejection" in prepared) {
            writeSocketError(
                socket,
                prepared.rejection.status,
                prepared.rejection.message,
                prepared.rejection.code,
            );
            return true;
        }
        this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
            prepared.attach(new WebSocketDuplex(createNodeBinaryWebSocket(webSocket)));
        });
        return true;
    }

    async handleConnect(
        ctx: Context,
        request: IncomingMessage,
        socket: Socket,
        head: Buffer,
    ): Promise<boolean> {
        const prepared = await this.prepareWorkspaceProxySocket(
            ctx,
            requestUrl(request).pathname,
            request.headers.authorization,
        );
        if (!prepared.handled) return false;
        if ("rejection" in prepared) {
            writeSocketError(
                socket,
                prepared.rejection.status,
                prepared.rejection.message,
                prepared.rejection.code,
            );
            return true;
        }
        this.#workspaceProxy.accept(socket, head);
        return true;
    }

    async prepareTerminalSocket(
        ctx: Context,
        pathname: string,
        authorization: string | string[] | undefined,
    ): Promise<PreparedTerminalSocket> {
        const match =
            /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/terminals\/([a-z][a-z0-9]*)\/attach$/.exec(
                pathname,
            );
        if (match === null) return { handled: false };
        try {
            ctx = await this.#authenticate(ctx, authorization);
            this.#assertTeamUser(ctx);
            this.#assertSocketReady();
            const workspaceId = match[1] as string;
            const terminalId = match[2] as string;
            const { scope } = await this.#resolveWorkspaceScope(ctx, workspaceId);
            const session = await this.#terminals.session(ctx, scope, terminalId);
            return {
                handled: true,
                attach(stream) {
                    const detach = session.attach(stream);
                    stream.once("close", detach);
                },
            };
        } catch (error: unknown) {
            return {
                handled: true,
                rejection: this.#socketRejection(ctx, error, "The terminal was not found."),
            };
        }
    }

    async prepareWorkspaceProxySocket(
        ctx: Context,
        pathname: string,
        authorization: string | string[] | undefined,
    ): Promise<PreparedWorkspaceProxySocket> {
        const match = /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/proxy$/.exec(pathname);
        if (match === null) return { handled: false };
        try {
            ctx = await this.#authenticate(ctx, authorization);
            this.#assertTeamUser(ctx);
            this.#assertSocketReady();
            await this.#resolveWorkspaceScope(ctx, match[1] as string);
            return { handled: true };
        } catch (error: unknown) {
            return {
                handled: true,
                rejection: this.#socketRejection(ctx, error, "The workspace was not found."),
            };
        }
    }

    async listenWorkspaceProxyHttp(path: string): Promise<void> {
        await this.#workspaceProxy.listen(path);
    }

    #subscribeToModules(ctx: Context): void {
        if (this.#unsubscribe.length > 0) return;
        this.#unsubscribe.push(
            this.#events.subscribe((event) => this.#enqueueAgentEvent(ctx, event)),
            this.#projects.onEvent(async (_eventCtx, event) => {
                await this.#convertProjectEvent(ctx, event);
            }),
            this.#workspaces.onEvent(async (_eventCtx, event) => {
                await this.#convertWorkspaceEvent(ctx, event);
            }),
            this.#bots.onEvent(async (_eventCtx, event) => {
                await this.#convertBotEvent(ctx, event);
            }),
            this.#terminals.onEvent(async (event) => {
                this.#convertTerminalEvent(event);
            }),
            this.#git.onSnapshot(async (_ctx, entity, snapshot) => {
                this.#journal.append("git.updated", {
                    workspaceId: entity.workspaceId ?? entity.projectId,
                    git: gitResource(snapshot),
                });
            }),
            this.#files.onEvent((_eventCtx, event) => {
                this.#journal.append(
                    "files.updated",
                    { workspaceId: event.workspaceId, paths: event.paths },
                    event.at,
                );
            }),
            this.#history.onAppend((_ctx, agentId, messages) => {
                for (const message of messages) {
                    if (
                        messageHiddenFromUser(message) ||
                        message.blocks.some((block) => block.type === "compaction") ||
                        message.role === "user" ||
                        message.senderAgentId !== undefined ||
                        message.provider !== undefined ||
                        message.model !== undefined
                    ) {
                        continue;
                    }
                    this.#journal.append("message.created", {
                        agentId,
                        runId: message.runId ?? null,
                        message: messageResource(message),
                    });
                }
            }),
            this.#permissions.onEvent(async (eventCtx, event) => {
                await this.#convertPermissionEvent(eventCtx, event);
            }),
            this.#userInput.onEvent(async (_eventCtx, event) => {
                await this.#convertUserInputEvent(ctx, event);
            }),
            this.#usage.onEvent((_eventCtx, event) => {
                if (event.type === "usage_context_changed") {
                    this.#journal.append(
                        "agent.context.updated",
                        {
                            agentId: event.agentId,
                            context: this.#agentContext(event.context ?? undefined),
                        },
                        event.at,
                    );
                    return;
                }
                if (event.type === "usage_reset") {
                    if (event.agentId !== null) {
                        this.#journal.append(
                            "agent.context.updated",
                            { agentId: event.agentId, context: null },
                            event.at,
                        );
                    }
                    return;
                }
                if (event.type !== "usage_recorded") return;
                this.#scheduleUsageMetadataRefresh(ctx, event.record.agentId);
            }),
            this.#profile.onEvent(async (_eventCtx: Context, event: ProfileChangedEvent) => {
                const profile = profileResource(await this.#profile.ensure(ctx));
                this.#journal.append("profile.updated", {
                    previousVersion: event.data.previousVersion,
                    version: event.data.version,
                    profile,
                });
            }),
            this.#team.onProfileUpdated((_eventCtx, event) => {
                // Team profile events are server-wide invalidations. Keep private profile fields
                // out of the shared journal while identifying exactly which user became stale.
                this.#journal.append("profile.updated", { userId: event.user.id });
            }),
            this.#cloud.onUpdated((_eventCtx, cloud) => {
                this.#journal.append("cloud.updated", { cloud }, cloud.updatedAt);
            }),
            this.#cloud.onProfileUpdated(() => {
                this.#journal.append("cloud.profile.updated", {});
            }),
            this.#cloud.onSocialUpdated((_eventCtx, social, origin) => {
                const append = (): void => {
                    this.#journal.append("cloud.social.updated", { version: social.version });
                };
                if (origin === "background") {
                    this.#journal.appendOutsideMutation("cloud.social.updated", {
                        version: social.version,
                    });
                } else append();
            }),
            this.#happy.onIntegrationUpdated((_eventCtx, integration) => {
                this.#journal.append(
                    "happy.integration.updated",
                    { integration },
                    integration.updatedAt,
                );
            }),
            this.#compute.onProcessEvent(async (event) => {
                await this.#convertProcessEvent(ctx, event);
            }),
            this.#secrets.onEvent(async (_eventCtx, event) => {
                this.#convertSecretEvent(event);
            }),
        );
    }

    #convertSecretEvent(event: SecretEvent): void {
        if (event.type === "secret_api_created") {
            this.#journal.append("secret.created", { secret: event.secret }, event.at);
            return;
        }
        if (event.type === "secret_api_updated") {
            this.#journal.append(
                "secret.updated",
                {
                    secretId: event.secret.id,
                    previousVersion: event.previousSecret.version,
                    version: event.secret.version,
                    changes: secretChanges(event.previousSecret, event.secret),
                },
                event.at,
            );
            return;
        }
        if (event.type === "secret_api_removed") {
            this.#journal.append(
                "secret.removed",
                { secretId: event.secretId, previousVersion: event.previousVersion },
                event.at,
            );
            return;
        }
        if (event.type === "secret_api_attached") {
            this.#journal.append("secret.attached", { attachment: event.attachment }, event.at);
            return;
        }
        if (event.type === "secret_api_detached") {
            this.#journal.append("secret.detached", { attachment: event.attachment }, event.at);
        }
    }

    async #convertProcessEvent(ctx: Context, event: ComputeProcessEvent): Promise<void> {
        if (event.type === "process_started") {
            this.#journal.append("process.started", { process: event.process });
        } else {
            this.#journal.append(
                event.type === "process_exited" ? "process.exited" : "process.updated",
                {
                    processId: event.processId,
                    previousVersion: event.previousVersion,
                    version: event.version,
                    changes: event.changes,
                },
            );
        }
        await this.#updateAgentMetadata(ctx, event.agentId, {
            processes: { running: event.runningProcesses },
        });
    }

    async #convertProjectEvent(ctx: Context, event: ProjectEvent): Promise<void> {
        if (event.type === "project_settings_updated") {
            const resource = await this.#projectWithAgents(ctx, event.project);
            this.#journal.append(
                "project.updated",
                {
                    projectId: event.project.id,
                    previousVersion: apiResourceVersion(
                        event.previousProject.updatedAt,
                        event.previousProject.version,
                        event.previousProject.id,
                    ),
                    version: resource["version"],
                    changes: {
                        settings: event.settings,
                        updatedAt: event.project.updatedAt,
                    },
                },
                event.at,
            );
            this.#appendRootWorkspaceProjectUpdate(
                event.project,
                event.previousProject,
                resource["agents"],
                false,
                event.at,
            );
            return;
        }
        const resource = await this.#projectWithAgents(ctx, event.project);
        if (event.type === "project_created") {
            this.#journal.append("project.created", { project: resource }, event.at);
            this.#journal.append(
                "workspace.created",
                {
                    workspace: {
                        ...rootWorkspaceResource(event.project),
                        agents: resource["agents"],
                    },
                },
                event.at,
            );
            return;
        }
        const previous = await projectResource(ctx, this.#projects, event.previousProject);
        const agentsChanged =
            event.type === "project_agent_attached" ||
            event.type === "project_agent_reordered" ||
            event.type === "project_agent_visibility_changed";
        const changes = agentsChanged
            ? {
                  agents: resource["agents"],
                  updatedAt: resource["updatedAt"],
              }
            : resourceChanges(previous, resource);
        this.#journal.append(
            "project.updated",
            {
                projectId: event.project.id,
                previousVersion: previous["version"],
                version: resource["version"],
                changes,
            },
            event.at,
        );
        this.#appendRootWorkspaceProjectUpdate(
            event.project,
            event.previousProject,
            resource["agents"],
            agentsChanged,
            event.at,
        );
    }

    #appendRootWorkspaceProjectUpdate(
        project: Project,
        previousProject: Project,
        agents: unknown,
        agentsChanged: boolean,
        at: number,
    ): void {
        const resource: Record<string, unknown> = {
            ...rootWorkspaceResource(project),
            agents,
        };
        const previous = rootWorkspaceResource(previousProject);
        this.#journal.append(
            "workspace.updated",
            {
                workspaceId: project.id,
                previousVersion: previous["version"],
                version: resource["version"],
                changes: agentsChanged
                    ? {
                          agents,
                          updatedAt: resource["updatedAt"],
                      }
                    : resourceChanges(previous, resource),
            },
            at,
        );
    }

    async #convertWorkspaceEvent(ctx: Context, event: WorkspaceEvent): Promise<void> {
        const resource: Record<string, unknown> = {
            ...workspaceResource(event.workspace),
            agents: await this.#agentsForWorkspace(ctx, event.workspace.id),
        };
        if (event.type === "workspace_created") {
            this.#journal.append("workspace.created", { workspace: resource }, event.at);
            return;
        }
        const previous = workspaceResource(event.previousWorkspace);
        const changes =
            event.type === "workspace_agent_attached" ||
            event.type === "workspace_agent_reordered" ||
            event.type === "workspace_agent_visibility_changed"
                ? {
                      agents: resource["agents"],
                      updatedAt: resource["updatedAt"],
                  }
                : resourceChanges(previous, resource);
        this.#journal.append(
            "workspace.updated",
            {
                workspaceId: event.workspace.id,
                previousVersion: previous["version"],
                version: resource["version"],
                changes,
            },
            event.at,
        );
    }

    async #convertBotEvent(ctx: Context, event: BotEvent): Promise<void> {
        // Agent creation and archival have their own independently versioned event chain. Bot
        // delivery runs inside the catalog's post-commit notification, so it must not wait on
        // another post-commit chain from that same transaction.
        const agent = await this.#buildAgentResource(
            ctx,
            event.bot.agentId,
            event.bot.workspaceId,
            null,
        );
        if (agent === undefined) throw new Error("The bot event has no agent.");
        const resource = botResource(event.bot, agent);
        const workspace = botWorkspaceResource(event.bot, agent);
        if (event.type === "bot_created") {
            this.#journal.append("bot.created", { bot: resource }, event.at);
            this.#journal.append("workspace.created", { workspace }, event.at);
            return;
        }
        const previous = botResource(event.previousBot, agent);
        const changes = resourceChanges(previous, resource);
        delete changes["agent"];
        this.#journal.append(
            "bot.updated",
            {
                botId: event.bot.id,
                previousVersion: previous["version"],
                version: resource["version"],
                changes,
            },
            event.at,
        );
        if (event.bot.workspaceVersion !== event.previousBot.workspaceVersion) {
            const previousWorkspace = botWorkspaceResource(event.previousBot, agent);
            this.#journal.append(
                "workspace.updated",
                {
                    workspaceId: event.bot.workspaceId,
                    previousVersion: previousWorkspace["version"],
                    version: workspace["version"],
                    changes: resourceChanges(previousWorkspace, workspace),
                },
                event.at,
            );
        }
    }

    #convertTerminalEvent(event: TerminalEvent): void {
        if (event.type === "terminal_created") {
            this.#journal.append("terminal.created", {
                terminal: terminalResource(event.terminal.workspaceId, event.terminal),
            });
            return;
        }
        this.#journal.append("terminal.updated", {
            terminalId: event.terminalId,
            previousVersion: event.previousVersion,
            version: event.version,
            changes: event.changes,
        });
    }

    async #convertUserInputEvent(ctx: Context, event: UserInputEvent): Promise<void> {
        const question = questionResource(
            event.request,
            await this.#activeRunId(ctx, event.request.askingAgentId),
        );
        if (event.type === "user_input_requested") {
            this.#journal.append("question.created", { question }, event.at);
            await this.#updateAgentMetadata(ctx, event.request.askingAgentId, {
                pendingQuestionId: event.request.id,
            });
            return;
        }
        this.#journal.append(
            "question.updated",
            {
                questionId: event.request.id,
                agentId: event.request.askingAgentId,
                previousVersion: apiResourceVersion(event.request.createdAt, 1, event.request.id),
                version: question["version"],
                changes: {
                    status: question["status"],
                    answers: question["answers"],
                    answeredAt: question["answeredAt"],
                    updatedAt: event.request.updatedAt,
                },
            },
            event.at,
        );
        await this.#updateAgentMetadata(ctx, event.request.askingAgentId, {
            pendingQuestionId: null,
        });
    }

    #enqueueAgentEvent(ctx: Context, event: AgentEvent): void {
        const key = event.agentId ?? "\u0000daemon";
        const mutationId = this.#mutationIds.getStore();
        const queued = this.#queueAgentWork(
            ctx,
            key,
            mutationId,
            async () => await this.#convertAgentEvent(ctx, event),
        );
        void queued.catch((error: unknown) => {
            ctx.log.error(
                "The API could not convert an agent event.",
                { agentId: event.agentId, eventType: event.type },
                error,
            );
        });
    }

    #queueAgentWork(
        ctx: Context,
        key: string,
        mutationId: string | undefined,
        work: () => Promise<void>,
    ): Promise<void> {
        const previous = this.#agentEventChains.get(key) ?? Promise.resolve();
        const result = previous.then(
            async () =>
                await this.#backgroundScope.runInAsyncScope(async () => {
                    if (mutationId === undefined) {
                        await work();
                    } else {
                        await this.#mutationIds.run(mutationId, work);
                    }
                }),
        );
        const settled = result.catch(() => undefined);
        this.#agentEventChains.set(key, settled);
        void settled.finally(() => {
            if (this.#agentEventChains.get(key) === settled) {
                this.#agentEventChains.delete(key);
            }
        });
        return result;
    }

    async #convertAgentEvent(ctx: Context, event: AgentEvent): Promise<void> {
        const agentId = event.agentId;
        if (agentId === undefined) return;
        const payload = recordValue(event.payload);
        if (event.type !== "message.accepted" && this.#acceptedMessageBatches.has(agentId)) {
            await this.#waitForPendingMessageAnnouncements(agentId);
            await this.#flushAcceptedMessages(ctx, agentId);
        }
        if (event.type === "slash_commands.updated") {
            if (!Value.Check(slashCommandCatalogEventPayloadSchema, payload)) {
                throw new Error("The slash command catalog event is invalid.");
            }
            this.#journal.append(
                "agent.slash_commands.updated",
                { agentId, slashCommands: payload.slashCommands },
                event.occurredAt,
            );
            // Initial discovery is part of the created agent's settled public snapshot. Announce
            // creation only after publishing that computed catalog so the creation cursor closes
            // the snapshot and no immediately-created state trails it.
            if (this.#pendingAgentCreations.delete(agentId)) {
                await this.#announceCreatedAgent(ctx, agentId);
            } else {
                // Restore-time discovery is a new durable agent event, so its resource version
                // must remain replayable through the ordinary agent update chain.
                await this.#appendAgentUpdate(ctx, event, { updatedAt: event.occurredAt });
            }
            return;
        }
        if (event.type === "agent.created") {
            boundedAdd(this.#pendingAgentCreations, agentId, MAX_ANNOUNCED_AGENT_CREATIONS);
            // Creation hooks discover slash commands after the durable lifecycle event. A forced
            // refresh also guarantees the corresponding event exists when conversion reaches an
            // agent created outside the HTTP route, such as a collaborator.
            await this.#slashCommands.refresh(ctx, agentId);
            await this.#refreshParentSubagents(ctx, agentId);
            return;
        }
        if (
            event.type === "compaction.message-created" ||
            event.type === "compaction.message-updated"
        ) {
            const compaction = payload?.["compaction"];
            if (!Value.Check(compactionSchema, compaction)) {
                throw new Error("The durable compaction event is invalid.");
            }
            const previous = payload?.["previous"];
            if (
                event.type === "compaction.message-updated" &&
                !Value.Check(compactionSchema, previous)
            ) {
                throw new Error("The prior durable compaction state is invalid.");
            }
            await this.#convertCompactionMessageEvent(
                ctx,
                event,
                compaction as Compaction,
                Value.Check(compactionSchema, previous) ? (previous as Compaction) : undefined,
            );
            const status =
                (compaction as Compaction).trigger !== "manual"
                    ? undefined
                    : (compaction as Compaction).status === "running"
                      ? "working"
                      : "idle";
            await this.#appendAgentUpdate(ctx, event, {
                ...(status === undefined ? {} : { status }),
                updatedAt: event.occurredAt,
            });
            return;
        }
        if (event.type === "loop.started") {
            await this.#appendAgentUpdate(ctx, event, {
                status: "working",
                updatedAt: event.occurredAt,
            });
            return;
        }
        if (event.type === "message.accepted") {
            const previousVersion = await this.#events.previousCursor(ctx, agentId, event.id);
            if (previousVersion === undefined) {
                throw new Error("An accepted message has no prior agent resource version.");
            }
            await this.#acceptMessageEvent(ctx, agentId, event, payload, previousVersion);
            await this.#refreshParentSubagents(ctx, agentId);
            return;
        }
        if (event.type === "loop.settled") {
            await this.#flushAcceptedMessages(ctx, agentId);
            this.#streamingAssistantBlocks.delete(agentId);
            this.#streamingDeltaOffsets.delete(agentId);
            const runId = stringValue(payload?.["runId"]);
            const run =
                runId === undefined ? undefined : await this.#history.run(ctx, agentId, runId);
            if (run === undefined) {
                await this.#appendAgentUpdate(ctx, event, {
                    status: "idle",
                    updatedAt: event.occurredAt,
                });
                await this.#refreshParentSubagents(ctx, agentId);
                return;
            }
            if (run.status === "running") {
                await this.#appendAgentUpdate(ctx, event, {
                    status: "working",
                    updatedAt: event.occurredAt,
                });
                await this.#refreshParentSubagents(ctx, agentId);
                return;
            }
            const errorText =
                stringValue(payload?.["error"]) ?? stringValue(payload?.["errorMessage"]);
            if (errorText !== undefined) {
                // History records the failure as the run's error message; clients watching live
                // hear about it the same way they hear about any message coming into being.
                this.#journal.append(
                    "message.created",
                    {
                        agentId,
                        runId: run.id,
                        message: {
                            id: `${run.id}-error`,
                            role: "service",
                            createdAt: event.occurredAt,
                            content: [{ type: "text", text: errorText }],
                        },
                    },
                    event.occurredAt,
                );
            }
            if (!this.#announcedTerminalRuns.has(run.id)) {
                boundedAdd(this.#announcedTerminalRuns, run.id, MAX_ANNOUNCED_TERMINAL_RUNS);
                this.#journal.append(
                    "run.finished",
                    { agentId, run: await this.#runResource(ctx, run) },
                    event.occurredAt,
                );
            }
            await this.#appendAgentUpdate(ctx, event, {
                status: "idle",
                updatedAt: event.occurredAt,
            });
            this.#scheduleUnreadUpdate(ctx, agentId, event.occurredAt);
            await this.#refreshParentSubagents(ctx, agentId);
            return;
        }
        if (event.type === "agent.metadata-changed") {
            const update = recordValue(payload?.["update"]);
            if (update === undefined) return;
            if (Object.hasOwn(update, "draft")) {
                this.#journal.append(
                    "agent.draft.updated",
                    { agentId, draft: await this.#agentDraft(ctx, agentId) },
                    event.occurredAt,
                );
            }
            const canSendMessages = Object.hasOwn(update, "archivedAt")
                ? (await this.#agentSystem().parentOf(ctx, agentId)) === null &&
                  update["archivedAt"] === null
                : undefined;
            await this.#appendAgentUpdate(
                ctx,
                event,
                agentMetadataChanges(update, event.occurredAt, canSendMessages),
            );
            return;
        }
        if (event.type === "provider.event" || event.type === "tool.completed") {
            await this.#convertProviderMessageEvent(ctx, event, payload);
        }
        const status = statusForAgentEvent(event.type, payload);
        await this.#appendAgentUpdate(ctx, event, {
            ...(status === undefined ? {} : { status }),
            updatedAt: event.occurredAt,
        });
    }

    async #convertCompactionMessageEvent(
        ctx: Context,
        event: AgentEvent,
        compaction: Compaction,
        previous: Compaction | undefined,
    ): Promise<void> {
        const message = messageResource(this.#compactions.historyMessage(compaction));
        if (event.type === "compaction.message-created") {
            if (compaction.trigger === "manual") {
                const run = await this.#history.run(ctx, compaction.agentId, compaction.runId);
                if (run === undefined) {
                    throw new Error("The manual compaction run is missing from durable history.");
                }
                this.#journal.append(
                    "run.started",
                    {
                        agentId: compaction.agentId,
                        run: startedRunResource(run),
                        acceptedMessageIds: [],
                    },
                    event.occurredAt,
                );
            }
            this.#journal.append(
                "message.created",
                {
                    agentId: compaction.agentId,
                    runId: compaction.runId,
                    message,
                },
                event.occurredAt,
            );
            return;
        }
        this.#journal.append(
            "message.updated",
            {
                agentId: compaction.agentId,
                runId: compaction.runId,
                message,
            },
            event.occurredAt,
        );
        if (
            compaction.trigger === "manual" &&
            previous?.status === "running" &&
            compaction.status !== "running"
        ) {
            const run = await this.#history.run(ctx, compaction.agentId, compaction.runId);
            if (run === undefined || run.status === "running") {
                throw new Error("The terminal manual compaction run is not settled in history.");
            }
            if (!this.#announcedTerminalRuns.has(run.id)) {
                boundedAdd(this.#announcedTerminalRuns, run.id, MAX_ANNOUNCED_TERMINAL_RUNS);
                this.#journal.append(
                    "run.finished",
                    { agentId: compaction.agentId, run: await this.#runResource(ctx, run) },
                    event.occurredAt,
                );
            }
        }
    }

    async #runResource(ctx: Context, run: HistoryRunState): Promise<Record<string, unknown>> {
        const summary = await this.#usage.readRun(ctx, run.agentId, run.id);
        return {
            id: run.id,
            status: run.status,
            reason: run.reason,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            usage: summary.usage,
            costUsd: summary.costUsd,
        };
    }

    async #activeRunId(ctx: Context, agentId: string): Promise<string | undefined> {
        return (
            this.#events.activeRunId(agentId) ?? (await this.#history.runningRun(ctx, agentId))?.id
        );
    }

    async #convertProviderMessageEvent(
        ctx: Context,
        event: AgentEvent,
        payload: Readonly<Record<string, unknown>> | undefined,
    ): Promise<void> {
        if (payload?.["recovered"] === true) return;
        const agentId = event.agentId;
        const underlyingRunId = stringValue(payload?.["runId"]);
        const rigEvent = recordValue(payload?.["rigEvent"]);
        const type = stringValue(rigEvent?.["type"]);
        if (agentId === undefined || underlyingRunId === undefined || type === undefined) {
            return;
        }
        const streaming = this.#streamingAssistantBlocks.get(agentId);
        const { messageId, runId } = apiAssistantIdentityForProviderEvent(
            type,
            underlyingRunId,
            stringValue(rigEvent?.["messageId"]),
            streaming,
        );
        const metadata = {
            ...(stringValue(payload?.["provider"]) === undefined
                ? {}
                : { providerId: stringValue(payload?.["provider"]) }),
            ...(stringValue(payload?.["model"]) === undefined
                ? {}
                : { modelId: stringValue(payload?.["model"]) }),
        };
        if (type === "block_start") {
            // The provider streams one block at a time, but the API message accumulates them:
            // a later block joins the message instead of restarting it.
            if (streaming !== undefined && streaming.messageId === messageId) {
                streaming.committed.push(...streaming.current);
                streaming.current = [];
                return;
            }
            this.#streamingAssistantBlocks.set(agentId, {
                committed: [],
                current: [],
                messageId,
                runId,
            });
            this.#streamingDeltaOffsets.set(agentId, []);
            this.#journal.append(
                "message.created",
                {
                    agentId,
                    runId,
                    message: {
                        id: messageId,
                        role: "agent",
                        createdAt: event.occurredAt,
                        content: [],
                        metadata,
                    },
                },
                event.occurredAt,
            );
            return;
        }
        if (type === "block_reset") {
            this.#streamingAssistantBlocks.delete(agentId);
            this.#streamingDeltaOffsets.delete(agentId);
            this.#journal.append(
                "message.deleted",
                { agentId, runId, messageId },
                event.occurredAt,
            );
            return;
        }
        const committed = streaming?.messageId === messageId ? streaming.committed : [];
        if (type === "text_delta" || type === "thinking_delta") {
            const blockIndex = rigEvent?.["contentIndex"];
            const append = rigEvent?.["delta"];
            const block =
                typeof blockIndex === "number" && streaming?.messageId === messageId
                    ? streaming.current[blockIndex]
                    : undefined;
            if (
                typeof blockIndex === "number" &&
                Number.isSafeInteger(blockIndex) &&
                blockIndex >= 0 &&
                typeof append === "string"
            ) {
                const absoluteBlockIndex = committed.length + blockIndex;
                const offsets = this.#streamingDeltaOffsets.get(agentId) ?? [];
                const offset = offsets[absoluteBlockIndex] ?? 0;
                this.#journal.append(
                    "message.delta",
                    {
                        agentId,
                        runId,
                        messageId,
                        blockIndex: absoluteBlockIndex,
                        offset,
                        append,
                    },
                    event.occurredAt,
                );
                offsets[absoluteBlockIndex] = offset + append.length;
                this.#streamingDeltaOffsets.set(agentId, offsets);
                if (
                    streaming !== undefined &&
                    (block?.["type"] === "text" || block?.["type"] === "reasoning") &&
                    typeof block["text"] === "string"
                ) {
                    streaming.current = streaming.current.map((candidate, index) =>
                        index === blockIndex
                            ? { ...candidate, text: block["text"] + append }
                            : candidate,
                    );
                }
            }
            return;
        }
        const partial = recordValue(rigEvent?.["partial"]);
        const historical = await this.#history.assistantMessage(ctx, agentId, runId);
        const content = providerMessageContent(
            partial?.["content"],
            reviewedToolCalls(historical),
            toolResultPresentations(historical),
        );
        if (content === undefined) return;
        if (streaming !== undefined && streaming.messageId === messageId) {
            streaming.current = [...content];
            const offsets = this.#streamingDeltaOffsets.get(agentId) ?? [];
            for (const [index, block] of content.entries()) {
                if (
                    (block["type"] === "text" || block["type"] === "reasoning") &&
                    typeof block["text"] === "string"
                ) {
                    offsets[committed.length + index] = block["text"].length;
                }
            }
            this.#streamingDeltaOffsets.set(agentId, offsets);
        }
        this.#journal.append(
            "message.updated",
            {
                agentId,
                runId,
                message: {
                    id: messageId,
                    role: "agent",
                    createdAt: event.occurredAt,
                    content,
                    metadata,
                },
            },
            event.occurredAt,
        );
    }

    async #convertPermissionEvent(ctx: Context, event: PermissionEvent): Promise<void> {
        let elevated: boolean;
        let review: ToolPermissionReview;
        if (event.type === "permission_action_reviewed") {
            elevated = event.elevated;
            review = {
                outcome: "allowed",
                reason: event.reason,
                risk: event.risk,
                userAuthorization: event.userAuthorization,
            };
        } else if (event.type === "permission_action_denied") {
            elevated = false;
            review = {
                outcome: "denied",
                reason: event.reason,
                risk: event.risk,
                userAuthorization: event.userAuthorization,
            };
        } else if (event.type === "permission_action_unproven") {
            elevated = false;
            review = {
                outcome: "unproven",
                kind: event.kind,
                reason: event.reason,
            };
        } else {
            return;
        }
        const message = await this.#history.recordToolPermissionReview(
            ctx,
            event.agentId,
            event.callId,
            elevated,
            review,
        );
        if (message === undefined || message.runId === undefined) {
            throw new Error("The reviewed tool call is missing from public message history.");
        }
        const runId = message.runId;
        afterCommit(ctx, () => {
            this.#journal.append("message.updated", {
                agentId: event.agentId,
                runId,
                message: messageResource(message),
            });
        });
    }

    async #appendAgentUpdate(
        ctx: Context,
        event: AgentEvent,
        changes: Readonly<Record<string, unknown>>,
    ): Promise<void> {
        const agentId = event.agentId;
        if (agentId === undefined) return;
        const previousVersion = await this.#events.previousCursor(ctx, agentId, event.id);
        if (previousVersion === undefined) {
            throw new Error("An agent update has no prior resource version.");
        }
        this.#journal.append(
            "agent.updated",
            {
                agentId,
                previousVersion,
                version: event.id,
                changes,
            },
            event.occurredAt,
        );
    }

    async #acceptMessageEvent(
        ctx: Context,
        agentId: string,
        event: AgentEvent,
        payload: Record<string, unknown> | undefined,
        previousVersion: string,
    ): Promise<void> {
        const id = stringValue(payload?.["id"]);
        const kind = stringValue(payload?.["kind"]);
        const runId = stringValue(payload?.["runId"]);
        if (id === undefined || runId === undefined) return;
        const message = await this.#history.message(ctx, agentId, id);
        if (message === undefined) {
            throw new Error("An accepted message is missing from durable history.");
        }
        const projected = messageResource(message);
        const role = projected["role"];
        const fromUser = role === "user";
        const hidden = messageHiddenFromUser(message);
        if (!fromUser) {
            if (!hidden) {
                this.#journal.append(
                    "message.created",
                    {
                        agentId,
                        runId,
                        message: projected,
                    },
                    event.occurredAt,
                );
            }
        } else if (!hidden && !this.#apiPendingMessageIds.has(id)) {
            this.#journal.append(
                "message.created",
                {
                    agentId,
                    runId: null,
                    message: {
                        ...projected,
                        status: "pending",
                        delivery: kind === "steering" ? "steer" : "queue",
                        runId: null,
                    },
                },
                event.occurredAt,
            );
        }
        const acceptedKind = kind === "steering" ? "steering" : "send";
        const existing = this.#acceptedMessageBatches.get(agentId);
        if (
            existing !== undefined &&
            (existing.kind !== acceptedKind || existing.runId !== runId)
        ) {
            await this.#flushAcceptedMessages(ctx, agentId);
        }
        const batch: AcceptedMessageBatch = this.#acceptedMessageBatches.get(agentId) ?? {
            kind: acceptedKind,
            runId,
            startedAt: message.at ?? event.occurredAt,
            messages: [],
        };
        batch.messages.push({
            hidden,
            id,
            occurredAt: event.occurredAt,
            previousVersion,
            version: event.id,
            ...(message.mutationId === undefined ? {} : { mutationId: message.mutationId }),
        });
        this.#acceptedMessageBatches.set(agentId, batch);
        this.#scheduleAcceptedMessageFlush(ctx, agentId, batch);
    }

    #scheduleAcceptedMessageFlush(
        ctx: Context,
        agentId: string,
        batch: AcceptedMessageBatch,
    ): void {
        setImmediate(() => {
            if (this.#closed || this.#acceptedMessageBatches.get(agentId) !== batch) return;
            const queued = this.#queueAgentWork(ctx, agentId, undefined, async () => {
                if (this.#acceptedMessageBatches.get(agentId) !== batch) return;
                await this.#waitForPendingMessageAnnouncements(agentId);
                await this.#flushAcceptedMessages(ctx, agentId);
            });
            void queued.catch((error: unknown) => {
                ctx.log.error(
                    "The API could not flush accepted messages.",
                    { agentId, runId: batch.runId },
                    error,
                );
            });
        });
    }

    async #flushAcceptedMessages(ctx: Context, agentId: string): Promise<void> {
        const batch = this.#acceptedMessageBatches.get(agentId);
        if (batch === undefined || batch.messages.length === 0) return;
        if (batch.messages.some((message) => this.#announcedPendingMessages.has(message.id))) {
            return;
        }
        const previous = await this.#history.previousRun(ctx, agentId, batch.runId);
        if (this.#acceptedMessageBatches.get(agentId) !== batch) return;
        const first = batch.messages[0] as AcceptedMessageBatch["messages"][number];
        const occurredAt = batch.messages.at(-1)?.occurredAt ?? first.occurredAt;
        const mutationIds = new Set(
            batch.messages.flatMap((message) =>
                message.mutationId === undefined ? [] : [message.mutationId],
            ),
        );
        const mutationId = mutationIds.size === 1 ? [...mutationIds][0] : undefined;
        const append = (type: string, payload: unknown, at: number): void => {
            if (mutationId === undefined) {
                this.#journal.append(type, payload, at);
            } else {
                this.#mutationIds.run(mutationId, () => {
                    this.#journal.append(type, payload, at);
                });
            }
        };
        const startedRun = startedRunResource({ id: batch.runId, startedAt: batch.startedAt });
        const acceptedMessageIds = batch.messages.flatMap((message) =>
            message.hidden ? [] : [message.id],
        );
        const finishedRun =
            batch.kind === "steering" && previous?.reason === "steering"
                ? await this.#runResource(ctx, previous)
                : undefined;
        const queuedFinishedRun =
            batch.kind === "send" &&
            previous !== undefined &&
            previous.status !== "running" &&
            !this.#announcedTerminalRuns.has(previous.id)
                ? await this.#runResource(ctx, previous)
                : undefined;
        this.#acceptedMessageBatches.delete(agentId);
        if (finishedRun !== undefined) {
            boundedAdd(
                this.#announcedTerminalRuns,
                finishedRun["id"] as string,
                MAX_ANNOUNCED_TERMINAL_RUNS,
            );
            append(
                "run.boundary",
                {
                    agentId,
                    finishedRun,
                    startedRun,
                    acceptedMessageIds,
                },
                occurredAt,
            );
        } else {
            if (queuedFinishedRun !== undefined) {
                boundedAdd(
                    this.#announcedTerminalRuns,
                    queuedFinishedRun["id"] as string,
                    MAX_ANNOUNCED_TERMINAL_RUNS,
                );
                append("run.finished", { agentId, run: queuedFinishedRun }, occurredAt);
            }
            append("run.started", { agentId, run: startedRun, acceptedMessageIds }, occurredAt);
        }
        append(
            "agent.updated",
            {
                agentId,
                previousVersion: first.previousVersion,
                version: batch.messages.at(-1)?.version ?? first.version,
                changes: { status: "thinking", updatedAt: occurredAt },
            },
            occurredAt,
        );
    }

    async #waitForPendingMessageAnnouncements(agentId: string): Promise<void> {
        const batch = this.#acceptedMessageBatches.get(agentId);
        if (batch === undefined) return;
        const pending = batch.messages.flatMap((message) => {
            const announcement = this.#pendingMessageAnnouncements.get(message.id);
            return announcement === undefined ? [] : [announcement.promise];
        });
        if (pending.length > 0) await Promise.all(pending);
    }

    #beginPendingMessageAnnouncement(messageId: string): void {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
            resolve = done;
        });
        this.#pendingMessageAnnouncements.set(messageId, { promise, resolve });
    }

    #finishPendingMessageAnnouncement(messageId: string): void {
        const pending = this.#pendingMessageAnnouncements.get(messageId);
        if (pending === undefined) return;
        this.#pendingMessageAnnouncements.delete(messageId);
        pending.resolve();
    }

    async #announceCreatedAgent(ctx: Context, agentId: string): Promise<void> {
        if (this.#announcedAgentCreations.has(agentId)) return;
        const workspaceId = await this.#workspaceIdForAgent(ctx, agentId);
        if (workspaceId === undefined) return;
        const agent = await this.#buildAgentResource(
            ctx,
            agentId,
            workspaceId,
            await this.#agentOrderKey(ctx, agentId),
        );
        if (agent === undefined || this.#announcedAgentCreations.has(agentId)) return;
        boundedAdd(this.#announcedAgentCreations, agentId, MAX_ANNOUNCED_AGENT_CREATIONS);
        this.#journal.append("agent.created", { agent });
    }

    async #refreshParentSubagents(ctx: Context, childAgentId: string): Promise<void> {
        const agents = this.#agentSystem();
        const parentAgentId = await agents.parentOf(ctx, childAgentId);
        if (parentAgentId === null) return;
        const children = await agents.childOf(ctx, parentAgentId);
        const running = await Promise.all(
            children.map(async (agentId) => await this.#activeRunId(ctx, agentId)),
        );
        const subagents = {
            total: children.length,
            running: running.filter((runId) => runId !== undefined).length,
        };
        const parent = await agents.config(ctx, parentAgentId);
        if (parent === undefined || sameJsonValue(parent.metadata?.["subagents"], subagents)) {
            return;
        }
        await this.#updateAgentMetadata(ctx, parentAgentId, { subagents });
    }

    async #handleAgentRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        if (request.method === "POST" && url.pathname === "/v0/agents") {
            const body = await bodyAs(request, agentCreateBodySchema, "agent creation");
            const agents = this.#agentSystem();
            if (body.id !== undefined && (await agents.config(ctx, body.id)) !== undefined) {
                sendJson(response, 201, await this.#focusedAgentResponse(ctx, body.id));
                return true;
            }
            const ownership = await this.#resolveWorkspaceScope(ctx, body.workspaceId);
            if (ownership.botId !== undefined) {
                throw new ApiError(
                    409,
                    "conflict",
                    "A bot workspace already has its one permanent agent.",
                );
            }
            const managedByAnotherAgent = body.parentAgentId !== undefined;
            if (body.parentAgentId !== undefined) {
                if ((await agents.config(ctx, body.parentAgentId)) === undefined) {
                    throw notFound("The managing agent was not found.");
                }
                const parentWorkspaceId = await this.#workspaceIdForAgent(ctx, body.parentAgentId);
                if (parentWorkspaceId === undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "The managing agent does not belong to a workspace.",
                    );
                }
                if (parentWorkspaceId === body.workspaceId) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "A managed root agent must run in a different workspace from its parent.",
                    );
                }
            }
            const baseEnvironment = currentAgentEnvironment();
            const now = Date.now();
            const config: AgentConfig = {
                provenance: { createdAt: now },
                environment: {
                    ...baseEnvironment,
                    workingDirectory: ownership.root,
                },
                metadata: {
                    ...(body.title === undefined ? {} : { title: body.title }),
                    updatedAt: now,
                    version: 1,
                },
                modules: {
                    compute: {
                        cwd: ownership.root,
                        secretScope: {
                            projectId: ownership.projectId,
                            workspaceId: body.workspaceId,
                        },
                    },
                },
            };
            const created = await this.#withMutationId(
                body.mutationId,
                async () =>
                    await ctx.inTx(async (txCtx) => {
                        const agent = await agents.create(txCtx, config, {
                            ...(body.id === undefined ? {} : { id: body.id }),
                            parent: body.parentAgentId ?? null,
                        });
                        if (ownership.childWorkspaceId === undefined) {
                            if (managedByAnotherAgent) {
                                await this.#projects.attachManagedRootAgent(
                                    txCtx,
                                    ownership.projectId,
                                    agent.id,
                                );
                            } else {
                                await this.#projects.attachAgent(
                                    txCtx,
                                    ownership.projectId,
                                    agent.id,
                                );
                            }
                        } else if (managedByAnotherAgent) {
                            await this.#workspaces.attachManagedRootAgent(
                                txCtx,
                                ownership.childWorkspaceId,
                                agent.id,
                            );
                        } else {
                            await this.#workspaces.attachAgent(
                                txCtx,
                                ownership.childWorkspaceId,
                                agent.id,
                            );
                        }
                        return agent;
                    }),
            );
            // Initial discovery records a durable cursor when the catalog first appears. Await it
            // before snapshotting the resource so creation and an immediate ID replay return the
            // same settled agent version.
            const slashCommands = await this.#slashCommands.catalog(ctx, created.id);
            await this.#queueAgentWork(ctx, created.id, undefined, async () => undefined);
            const agent = await this.#requireAgentResource(ctx, created.id);
            if (!this.#announcedAgentCreations.has(created.id)) {
                boundedAdd(
                    this.#announcedAgentCreations,
                    created.id,
                    MAX_ANNOUNCED_AGENT_CREATIONS,
                );
                this.#journal.append("agent.created", {
                    agent,
                    ...(body.mutationId === undefined ? {} : { mutationId: body.mutationId }),
                });
            }
            sendJson(response, 201, {
                agent,
                profiles: requestProfilesForAgent(created.id),
                slashCommands,
            });
            return true;
        }
        const agentMatch = /^\/v0\/agents\/([a-z][a-z0-9]*)$/.exec(url.pathname);
        if (agentMatch !== null && request.method === "GET") {
            sendJson(response, 200, await this.#focusedAgentResponse(ctx, agentMatch[1] as string));
            return true;
        }
        const action =
            /^\/v0\/agents\/([a-z][a-z0-9]*)\/(send|messages|question|abort|compact|read|archive|unarchive|reorder|draft|usage|mode|bootstrap|activity)$/.exec(
                url.pathname,
            );
        if (action !== null) {
            const agentId = action[1] as string;
            const operation = action[2] as string;
            if (operation === "send" && request.method === "POST") {
                await this.#handleAgentSend(ctx, request, response, agentId);
                return true;
            }
            if (operation === "messages" && request.method === "GET") {
                await this.#handleAgentMessages(ctx, response, url, agentId);
                return true;
            }
            if (operation === "question" && request.method === "GET") {
                const page = await this.#userInput.listPage(ctx, agentId, {
                    askingAgentId: agentId,
                    status: "pending",
                    limit: 1,
                });
                const pending = page.requests[0];
                sendJson(response, 200, {
                    question:
                        pending === undefined
                            ? null
                            : questionResource(pending, await this.#activeRunId(ctx, agentId)),
                });
                return true;
            }
            if (operation === "abort" && request.method === "POST") {
                const body = await bodyAs(request, abortBodySchema, "agent abort");
                const active = await this.#activeRunId(ctx, agentId);
                if (
                    body.expectedRunId !== undefined &&
                    active !== undefined &&
                    body.expectedRunId !== active
                ) {
                    throw new ApiError(409, "conflict", "A different run is active.");
                }
                const cursor = this.#journal.cursor();
                await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#abort.abort(ctx, agentId),
                );
                sendJson(response, 202, {
                    ...(await this.#focusedAgentResponse(ctx, agentId)),
                    cursor,
                });
                return true;
            }
            if (operation === "compact" && request.method === "POST") {
                await this.#requireAgentResource(ctx, agentId);
                if ((await this.#activeRunId(ctx, agentId)) !== undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "A working agent cannot be compacted explicitly.",
                    );
                }
                const body = await bodyAs(request, emptyMutationBodySchema, "agent compaction");
                const cursor = this.#journal.cursor();
                let compaction;
                try {
                    compaction = await this.#withMutationId(
                        body.mutationId,
                        async () => await this.#compactions.startManual(ctx, agentId),
                    );
                } catch (error: unknown) {
                    if (error instanceof CompactionAlreadyRunningError) {
                        throw new ApiError(409, "conflict", error.message);
                    }
                    throw error;
                }
                const run = await this.#history.run(ctx, agentId, compaction.runId);
                if (run === undefined) {
                    throw new Error("The manual compaction response has no durable run.");
                }
                sendJson(response, 202, {
                    ...(await this.#focusedAgentResponse(ctx, agentId)),
                    run: await this.#runResource(ctx, run),
                    message: messageResource(this.#compactions.historyMessage(compaction)),
                    cursor,
                });
                return true;
            }
            if (operation === "read" && request.method === "POST") {
                await this.#assertUserControlledAgent(ctx, agentId);
                const body = await bodyAs(request, emptyMutationBodySchema, "read marker");
                await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#updateAgentMetadata(ctx, agentId, { unread: null }),
                );
                sendJson(response, 200, await this.#focusedAgentResponse(ctx, agentId));
                return true;
            }
            if (
                (operation === "archive" || operation === "unarchive") &&
                request.method === "POST"
            ) {
                if ((await this.#bots.forAgent(ctx, agentId)) !== undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "Archive or unarchive this agent through its bot.",
                    );
                }
                await this.#assertUserControlledAgent(ctx, agentId, true);
                const body = await bodyAs(request, emptyMutationBodySchema, "agent archival");
                const config = await this.#agentSystem().config(ctx, agentId);
                if (config === undefined) throw notFound("The agent was not found.");
                const archived = typeof config.metadata?.["archivedAt"] === "number";
                const shouldChange =
                    (operation === "archive" && !archived) ||
                    (operation === "unarchive" && archived);
                if (shouldChange) {
                    await this.#withMutationId(body.mutationId, async () => {
                        if (operation === "archive") {
                            await this.#abort.abort(ctx, agentId);
                            await this.#compute.archiveAgent(ctx, agentId);
                        }
                        await this.#updateAgentMetadata(ctx, agentId, {
                            archivedAt: operation === "archive" ? Date.now() : null,
                        });
                    });
                }
                sendJson(response, 200, await this.#focusedAgentResponse(ctx, agentId));
                return true;
            }
            if (operation === "reorder" && request.method === "POST") {
                if ((await this.#bots.forAgent(ctx, agentId)) !== undefined) {
                    throw new ApiError(409, "conflict", "Reorder this agent through its bot.");
                }
                await this.#assertUserControlledAgent(ctx, agentId);
                const body = await bodyAs(request, reorderBodySchema, "agent reorder");
                const before = await this.#requireAgentResource(ctx, agentId);
                const workspaceId = this.#config.configuration.values.features.workspaces
                    ? await this.#workspaces.workspaceForAgent(ctx, agentId)
                    : undefined;
                if (workspaceId === undefined) {
                    const project = await this.#projects.projectForAgent(ctx, agentId);
                    if (project === undefined) throw notFound("The agent was not found.");
                    await this.#withMutationId(
                        body.mutationId,
                        async () =>
                            await this.#projects.reorderAgent(
                                ctx,
                                project.id,
                                agentId,
                                body.afterId,
                            ),
                    );
                } else {
                    await this.#withMutationId(
                        body.mutationId,
                        async () =>
                            await this.#workspaces.reorderAgent(
                                ctx,
                                workspaceId,
                                agentId,
                                body.afterId,
                            ),
                    );
                }
                const orderKey = await this.#agentOrderKey(ctx, agentId);
                if (before["orderKey"] !== orderKey) {
                    await this.#withMutationId(
                        body.mutationId,
                        async () =>
                            await this.#updateAgentMetadata(ctx, agentId, {
                                orderKey,
                            }),
                    );
                }
                sendJson(response, 200, await this.#focusedAgentResponse(ctx, agentId));
                return true;
            }
            if (operation === "draft" && request.method === "PUT") {
                await this.#assertUserControlledAgent(ctx, agentId);
                const body = await bodyAs(request, draftBodySchema, "agent draft");
                const config = await this.#agentSystem().config(ctx, agentId);
                if (config === undefined) throw notFound("The agent was not found.");
                const storedAt =
                    typeof config.metadata?.["draftUpdatedAt"] === "number"
                        ? config.metadata["draftUpdatedAt"]
                        : -1;
                if (body.updatedAt === undefined || body.updatedAt >= storedAt) {
                    await this.#withMutationId(
                        body.mutationId,
                        async () =>
                            await this.#updateAgentMetadata(ctx, agentId, {
                                draft: body.draft,
                                draftUpdatedAt: body.updatedAt ?? Date.now(),
                            }),
                    );
                }
                sendJson(response, 200, { draft: await this.#agentDraft(ctx, agentId) });
                return true;
            }
            if (operation === "draft" && request.method === "GET") {
                await this.#requireAgentResource(ctx, agentId);
                sendJson(response, 200, { draft: await this.#agentDraft(ctx, agentId) });
                return true;
            }
            if (operation === "usage" && request.method === "GET") {
                await this.#requireAgentResource(ctx, agentId);
                sendJson(response, 200, await this.#agentUsage(ctx, agentId));
                return true;
            }
            if (operation === "mode" && request.method === "GET") {
                await this.#requireAgentResource(ctx, agentId);
                sendJson(response, 200, { mode: await this.#agentMode(ctx, agentId) });
                return true;
            }
            if (operation === "bootstrap" && request.method === "GET") {
                sendJson(response, 200, await this.#agentBootstrap(ctx, agentId));
                return true;
            }
            if (operation === "activity" && request.method === "GET") {
                sendJson(response, 200, await this.#agentActivity(ctx, agentId));
                return true;
            }
            return false;
        }
        const slashCommandImage =
            /^\/v0\/agents\/([a-z][a-z0-9]*)\/slash-commands\/([^/]+)\/image$/.exec(url.pathname);
        if (slashCommandImage !== null && request.method === "GET") {
            const agentId = slashCommandImage[1] as string;
            await this.#requireAgentResource(ctx, agentId);
            const name = decodePathSegment(slashCommandImage[2] as string, "slash command name");
            const image = await this.#slashCommands.image(ctx, agentId, name);
            if (image === undefined) throw notFound("The slash command has no image.");
            if (request.headers["if-none-match"] === image.etag) {
                response.writeHead(304, {
                    "cache-control": "no-store",
                    etag: image.etag,
                });
                response.end();
                return true;
            }
            response.writeHead(200, {
                "cache-control": "no-store",
                "content-length": image.blob.byteLength,
                "content-type": image.mediaType,
                etag: image.etag,
            });
            response.end(Buffer.from(image.blob));
            return true;
        }
        const slashCommand = /^\/v0\/agents\/([a-z][a-z0-9]*)\/slash-commands\/([^/]+)$/.exec(
            url.pathname,
        );
        if (slashCommand !== null && request.method === "POST") {
            const agentId = slashCommand[1] as string;
            await this.#requireAgentResource(ctx, agentId);
            const name = decodePathSegment(slashCommand[2] as string, "slash command name");
            const body = await bodyAs(
                request,
                invokeSlashCommandRequestSchema,
                "slash command invocation",
            );
            this.#assertAvailableAgentMode(body.mode);
            const cursor = this.#journal.cursor();
            let invoked;
            try {
                invoked = await this.#withMutationId(
                    body.mutationId,
                    async () => await this.#slashCommands.invoke(ctx, agentId, name, body),
                );
            } catch (error: unknown) {
                if (error instanceof SlashCommandNotFoundError) {
                    throw notFound(error.message);
                }
                if (error instanceof SlashCommandInputError) {
                    throw invalidRequest(error.message);
                }
                if (
                    error instanceof CompactionAgentBusyError ||
                    error instanceof CompactionAlreadyRunningError
                ) {
                    throw new ApiError(409, "conflict", error.message);
                }
                throw error;
            }
            sendJson(response, 202, {
                agent: await this.#requireAgentResource(ctx, agentId),
                profiles: requestProfilesForAgent(agentId),
                slashCommands: invoked.slashCommands,
                command: invoked.command,
                cursor,
            });
            return true;
        }
        // Question IDs are provider tool-call IDs, which mix cases, underscores, and hyphens.
        const answer =
            /^\/v0\/agents\/([a-z][a-z0-9]*)\/question\/([A-Za-z0-9][A-Za-z0-9_-]*)\/answer$/.exec(
                url.pathname,
            );
        if (answer !== null && request.method === "POST") {
            const agentId = answer[1] as string;
            const questionId = answer[2] as string;
            const body = await bodyAs(request, questionAnswerBodySchema, "question answer");
            const requestRow = await this.#userInput.get(ctx, agentId, questionId);
            if (requestRow === undefined) throw notFound("The question was not found.");
            const questionRunId = await this.#activeRunId(ctx, agentId);
            if (requestRow.status !== "pending") {
                throw new ApiError(409, "conflict", "The question has already been resolved.", {
                    question: questionResource(requestRow, questionRunId),
                });
            }
            const expectedQuestionIds = requestRow.questions?.map((question) => question.id) ?? [
                requestRow.id,
            ];
            const answeredQuestionIds = Object.keys(body.answers);
            if (
                answeredQuestionIds.length !== expectedQuestionIds.length ||
                expectedQuestionIds.some((questionId) => !Object.hasOwn(body.answers, questionId))
            ) {
                throw invalidRequest("Every question in the batch must receive an answer.");
            }
            const toAnswer = (values: readonly string[]) =>
                values.length === 1 ? (values[0] as string) : { selectedOptions: [...values] };
            // A one-question request is stored in its singular shape and only accepts the
            // singular answer; a batched request only accepts the batch.
            const answered = await this.#withMutationId(
                body.mutationId,
                async () =>
                    await this.#userInput.answer(
                        ctx,
                        agentId,
                        requestRow.questions === undefined
                            ? {
                                  requestId: questionId,
                                  answer: toAnswer(body.answers[requestRow.id] ?? []),
                              }
                            : {
                                  requestId: questionId,
                                  answers: Object.fromEntries(
                                      Object.entries(body.answers).map(([id, values]) => [
                                          id,
                                          toAnswer(values),
                                      ]),
                                  ),
                              },
                    ),
            );
            sendJson(response, 200, {
                question: questionResource(answered, questionRunId),
            });
            return true;
        }
        const process = /^\/v0\/agents\/([a-z][a-z0-9]*)\/processes\/([a-z][a-z0-9]*)$/.exec(
            url.pathname,
        );
        if (process !== null && request.method === "DELETE") {
            const agentId = process[1] as string;
            const processId = process[2] as string;
            await this.#requireAgentResource(ctx, agentId);
            const stopped = await this.#compute.stopProcess(ctx, agentId, processId);
            if (stopped === undefined) throw notFound("The process was not found.");
            sendJson(response, 200, { process: stopped });
            return true;
        }
        return false;
    }

    async #handleAgentSend(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        agentId: string,
    ): Promise<void> {
        await this.#assertUserControlledAgent(ctx, agentId);
        const body = await bodyAs(request, messageSendBodySchema, "agent message");
        const id = body.id ?? createId();
        await this.#serializeMessageSend(id, async () => {
            const cursor = this.#journal.cursor();
            const existing = await ctx.inTx(
                async (txCtx) => await this.#sentUserMessage(txCtx, agentId, id),
            );
            if (existing !== undefined) {
                sendJson(response, 202, { message: existing, cursor });
                return;
            }

            const selected = this.#config.models.find(
                (model) =>
                    model.providerId === body.mode.providerId && model.id === body.mode.modelId,
            );
            if (
                selected === undefined ||
                !selected.effortLevels.some((effort) => effort === body.mode.effort) ||
                (body.mode.serviceTier !== null &&
                    !selected.serviceTiers?.some((tier) => tier === body.mode.serviceTier))
            ) {
                throw invalidRequest(
                    "The selected provider, model, effort, or service tier is unavailable.",
                );
            }
            const effort = selected.effortLevels.find(
                (candidate) => candidate === body.mode.effort,
            );
            if (effort === undefined) throw invalidRequest("The selected effort is unavailable.");
            const serviceTier =
                body.mode.serviceTier === null
                    ? undefined
                    : selected.serviceTiers?.find(
                          (candidate) => candidate === body.mode.serviceTier,
                      );
            const content = [{ type: "text" as const, text: body.text }, ...(body.content ?? [])];
            const profile = decodeRequestProfile(body.profile);
            const options: AgentBaseMessageOptions = {
                id,
                provider: body.mode.providerId,
                model: body.mode.modelId,
                effort,
                ...(serviceTier === undefined ? {} : { serviceTier }),
                permissionMode: body.mode.permissionMode,
                profile,
                metadata: {
                    ...USER_MESSAGE_ORIGIN_METADATA,
                    mode: body.mode,
                    ...(body.clientMetadata === undefined
                        ? {}
                        : { clientMetadata: body.clientMetadata }),
                },
            };
            const agents = this.#agentSystem();
            const createdAt = Date.now();
            const delivery = body.delivery ?? "queue";
            const pending: HistoryPendingMessage = {
                id,
                agentId,
                role: "user",
                status: "pending",
                delivery,
                createdAt,
                blocks: content.map((block) =>
                    block.type === "text"
                        ? { type: "text" as const, text: block.text }
                        : {
                              type: "image" as const,
                              mediaType: block.mimeType,
                              data: block.data,
                          },
                ),
                mode: body.mode,
                profile,
                ...(body.clientMetadata === undefined
                    ? {}
                    : { clientMetadata: body.clientMetadata }),
                runId: null,
            };
            this.#announcedPendingMessages.add(id);
            this.#beginPendingMessageAnnouncement(id);
            boundedAdd(this.#apiPendingMessageIds, id, MAX_ANNOUNCED_PENDING_MESSAGES);
            if (this.#announcedPendingMessages.size > MAX_ANNOUNCED_PENDING_MESSAGES) {
                const oldest = this.#announcedPendingMessages.values().next().value as
                    | string
                    | undefined;
                if (oldest !== undefined) this.#announcedPendingMessages.delete(oldest);
            }
            try {
                await ctx.inTx(async (txCtx) => {
                    await this.#history.queuePending(txCtx, pending);
                    if (delivery === "steer") {
                        await agents.steer(txCtx, agentId, { role: "user", content }, options);
                    } else {
                        await agents.send(txCtx, agentId, { role: "user", content }, options);
                    }
                });
            } catch (error) {
                this.#announcedPendingMessages.delete(id);
                this.#apiPendingMessageIds.delete(id);
                this.#finishPendingMessageAnnouncement(id);
                throw error;
            }
            const accepted = await this.#history.message(ctx, agentId, id);
            const message =
                accepted === undefined
                    ? pendingMessageResource(pending)
                    : messageResource(accepted);
            await this.#updateAgentMetadata(ctx, agentId, { lastMode: body.mode });
            this.#journal.append("message.created", {
                agentId,
                runId: null,
                message: pendingMessageResource(pending),
            });
            this.#announcedPendingMessages.delete(id);
            this.#finishPendingMessageAnnouncement(id);
            await this.#flushAcceptedMessages(ctx, agentId);
            sendJson(response, 202, { message, cursor });
        });
    }

    async #handleAgentMessages(
        ctx: Context,
        response: ServerResponse,
        url: URL,
        agentId: string,
    ): Promise<void> {
        // Capture first so a concurrent message change is either visible in history or replayed
        // after this cursor. Stable identities and offset-addressed deltas make overlap harmless.
        const cursor = this.#journal.cursor();
        const before = optionalApiId(url.searchParams.get("before"), "run");
        const after = optionalApiId(url.searchParams.get("after"), "message");
        if (before !== undefined && after !== undefined) {
            throw invalidRequest("History cannot page before a run and after a message together.");
        }
        const limit = integerParameter(url.searchParams.get("limit"), 50, 1, 500);
        const omitToolData = booleanParameter(url.searchParams.get("omitToolData"), false);
        await this.#requireAgentResource(ctx, agentId);
        const page = await this.#history.runs(ctx, agentId, {
            ...(before === undefined ? {} : { before }),
            ...(after === undefined ? {} : { after }),
            limit,
        });
        sendJson(response, 200, {
            cursor,
            runs: await Promise.all(
                page.runs.map(async (run) => {
                    const runUsage = await this.#usage.readRun(ctx, agentId, run.id);
                    return {
                        id: run.id,
                        status: run.status,
                        reason: run.reason,
                        startedAt: run.startedAt,
                        endedAt: run.endedAt,
                        usage: runUsage.usage,
                        costUsd: runUsage.costUsd,
                        messages: run.messages
                            .filter((message) => !messageHiddenFromUser(message))
                            .map((message) => messageResource(message, { omitToolData })),
                    };
                }),
            ),
            hasMore: page.hasMore,
        });
    }

    async #agentMode(ctx: Context, agentId: string): Promise<unknown> {
        const config = await this.#agentSystem().config(ctx, agentId);
        if (config === undefined) throw notFound("The agent was not found.");
        return agentModeFromConfig(config);
    }

    async #agentDraft(ctx: Context, agentId: string): Promise<Record<string, unknown>> {
        const config = await this.#agentSystem().config(ctx, agentId);
        if (config === undefined) throw notFound("The agent was not found.");
        const value = config.metadata?.["draft"] ?? null;
        const updatedAt = config.metadata?.["draftUpdatedAt"];
        return {
            value: Value.Check(draftBodySchema.properties.draft, value) ? value : null,
            updatedAt:
                typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) && updatedAt >= 0
                    ? updatedAt
                    : null,
        };
    }

    async #agentUsage(ctx: Context, agentId: string): Promise<Record<string, unknown>> {
        const [usage, summary] = await Promise.all([
            this.#usageForAgentTree(ctx, agentId),
            this.#usage.read(ctx, agentId),
        ]);
        return {
            context: this.#agentContext(summary.currentContext),
            usage,
        };
    }

    #agentContext(context: UsageCurrentContext | undefined): Record<string, unknown> | null {
        if (context === undefined) return null;
        const modelContext =
            context.model === undefined
                ? undefined
                : this.#config.modelContext(context.provider, context.model);
        return {
            approximate: context.approximate,
            contextTokens: context.contextTokens,
            contextWindow: modelContext?.contextWindow ?? null,
            modelId: context.model ?? null,
            providerId: context.provider,
        };
    }

    async #agentBootstrap(ctx: Context, agentId: string): Promise<Record<string, unknown>> {
        // Capture first so every concurrent mutation is either in this snapshot or replayed.
        const cursor = this.#journal.cursor();
        const agent = await this.#requireAgentResource(ctx, agentId);
        const [draft, mode, usage, pending, slashCommands, activity] = await Promise.all([
            this.#agentDraft(ctx, agentId),
            this.#agentMode(ctx, agentId),
            this.#agentUsage(ctx, agentId),
            this.#history.pending(ctx, agentId),
            this.#slashCommands.catalog(ctx, agentId),
            this.#agentActivity(ctx, agentId),
        ]);
        return {
            ...usage,
            ...activity,
            agent,
            draft,
            mode,
            pending: pending.map(pendingMessageResource),
            profiles: requestProfilesForAgent(agentId),
            slashCommands,
            cursor,
        };
    }

    async #agentActivity(ctx: Context, agentId: string): Promise<Record<string, unknown>> {
        const agents = this.#agentSystem();
        if ((await agents.config(ctx, agentId)) === undefined) {
            throw notFound("The agent was not found.");
        }
        const children = await agents.childOf(ctx, agentId);
        return {
            subagents: await Promise.all(
                [...children]
                    .reverse()
                    .map(async (childId) => await this.#requireAgentResource(ctx, childId)),
            ),
            processes: await this.#compute.listProcesses(ctx, agentId),
        };
    }

    async #focusedAgentResponse(ctx: Context, agentId: string): Promise<Record<string, unknown>> {
        const agent = await this.#requireAgentResource(ctx, agentId);
        return {
            agent,
            profiles: requestProfilesForAgent(agentId),
            slashCommands: await this.#slashCommands.catalog(ctx, agentId),
        };
    }

    #assertAvailableAgentMode(mode: MessageMode): void {
        const selected = this.#config.models.find(
            (model) => model.providerId === mode.providerId && model.id === mode.modelId,
        );
        if (
            selected === undefined ||
            !selected.effortLevels.some((effort) => effort === mode.effort) ||
            (mode.serviceTier !== null &&
                !selected.serviceTiers?.some((tier) => tier === mode.serviceTier))
        ) {
            throw invalidRequest(
                "The selected provider, model, effort, or service tier is unavailable.",
            );
        }
    }

    async #requireAgentResource(ctx: Context, agentId: string): Promise<Record<string, unknown>> {
        if ((await this.#agentSystem().config(ctx, agentId)) === undefined) {
            throw notFound("The agent was not found.");
        }
        const workspaceId = await this.#workspaceIdForAgent(ctx, agentId);
        if (workspaceId === undefined) throw notFound("The agent was not found.");
        const resource = await this.#buildAgentResource(
            ctx,
            agentId,
            workspaceId,
            await this.#agentOrderKey(ctx, agentId),
        );
        if (resource === undefined) throw notFound("The agent was not found.");
        return resource;
    }

    async #buildAgentResource(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        orderKey?: string | null,
    ): Promise<Record<string, unknown> | undefined> {
        const botOwned = (await this.#bots.forAgent(ctx, agentId)) !== undefined;
        const children = await this.#agentSystem().childOf(ctx, agentId);
        const [processes, questions, runningSubagents, activeRunId] = await Promise.all([
            this.#compute.listProcesses(ctx, agentId),
            this.#userInput.listPage(ctx, agentId, {
                askingAgentId: agentId,
                status: "pending",
                limit: 1,
            }),
            Promise.all(
                children.map(async (childId) => await this.#activeRunId(ctx, childId)),
            ).then((runIds) => runIds.filter((runId) => runId !== undefined).length),
            this.#activeRunId(ctx, agentId),
        ]);
        return await agentResource(ctx, this.#agentSystem(), this.#events, agentId, workspaceId, {
            ...(orderKey === undefined ? {} : { orderKey }),
            ...(botOwned ? { userVisible: true } : {}),
            pendingQuestionId: questions.requests[0]?.id ?? null,
            runningProcesses: processes.filter((process) => process.status === "running").length,
            runningSubagents,
            working: activeRunId !== undefined,
        });
    }

    async #agentOrderKey(ctx: Context, agentId: string): Promise<string | null> {
        if ((await this.#bots.forAgent(ctx, agentId)) !== undefined) return null;
        const workspaceId = this.#config.configuration.values.features.workspaces
            ? await this.#workspaces.workspaceForAgent(ctx, agentId)
            : undefined;
        if (workspaceId !== undefined) {
            return (
                (await this.#workspaces.listAgents(ctx, workspaceId)).find(
                    (association) => association.agentId === agentId,
                )?.orderKey ?? null
            );
        }
        const project = await this.#projects.projectForAgent(ctx, agentId);
        if (project === undefined) return null;
        return (
            (await this.#projects.listAgents(ctx, project.id)).find(
                (association) => association.agentId === agentId,
            )?.orderKey ?? null
        );
    }

    async #workspaceIdForAgent(ctx: Context, agentId: string): Promise<string | undefined> {
        let current = agentId;
        for (let depth = 0; depth < 64; depth += 1) {
            const bot = await this.#bots.forAgent(ctx, current);
            if (bot !== undefined) return bot.workspaceId;
            const workspaceId = this.#config.configuration.values.features.workspaces
                ? await this.#workspaces.workspaceForAgent(ctx, current)
                : undefined;
            if (workspaceId !== undefined) return workspaceId;
            const project = await this.#projects.projectForAgent(ctx, current);
            if (project !== undefined) return project.id;
            const parent = await this.#agentSystem().parentOf(ctx, current);
            if (parent === null) return undefined;
            current = parent;
        }
        throw new Error("The agent ancestry exceeds the supported depth.");
    }

    async #assertUserControlledAgent(
        ctx: Context,
        agentId: string,
        allowArchived = false,
    ): Promise<void> {
        const agents = this.#agentSystem();
        if ((await agents.config(ctx, agentId)) === undefined) {
            throw notFound("The agent was not found.");
        }
        if ((await agents.parentOf(ctx, agentId)) !== null) {
            throw new ApiError(
                409,
                "conflict",
                "Agents managed by another agent are read-only through this API.",
            );
        }
        const config = await agents.config(ctx, agentId);
        if (!allowArchived && typeof config?.metadata?.["archivedAt"] === "number") {
            throw new ApiError(409, "conflict", "The agent is archived.");
        }
    }

    async #updateAgentMetadata(
        ctx: Context,
        agentId: string,
        update: Record<string, unknown>,
    ): Promise<void> {
        const config = await this.#agentSystem().config(ctx, agentId);
        if (config === undefined) throw notFound("The agent was not found.");
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await this.#agentSystem().updateMetadata(ctx, agentId, {
            ...update,
            updatedAt: Date.now(),
            version,
        });
    }

    /**
     * Usage is recorded from inside the agent's own operation, where a metadata update would
     * wait on that same operation. The version bump runs from the module's background scope
     * instead, as an ordinary external caller the loop never waits on.
     */
    #scheduleUsageMetadataRefresh(ctx: Context, agentId: string, depth = 0): void {
        if (depth >= 64) return;
        if (this.#pendingUsageMetadataAgents.has(agentId)) return;
        this.#pendingUsageMetadataAgents.add(agentId);
        const task = this.#backgroundScope.runInAsyncScope(async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            try {
                if (this.#closed) return;
                await this.#updateAgentMetadata(ctx, agentId, {});
            } catch (error: unknown) {
                ctx.log.warn(
                    "The API could not refresh agent metadata after usage.",
                    { agentId },
                    error,
                );
            } finally {
                this.#pendingUsageMetadataAgents.delete(agentId);
            }
            if (this.#closed) return;
            try {
                const parentAgentId = await this.#agentSystem().parentOf(ctx, agentId);
                if (parentAgentId !== null) {
                    this.#scheduleUsageMetadataRefresh(ctx, parentAgentId, depth + 1);
                }
            } catch (error: unknown) {
                ctx.log.warn(
                    "The API could not refresh parent metadata after descendant usage.",
                    { agentId },
                    error,
                );
            }
        });
        this.#backgroundMetadataUpdates.add(task);
        void task.finally(() => this.#backgroundMetadataUpdates.delete(task));
    }

    #scheduleUnreadUpdate(ctx: Context, agentId: string, since: number): void {
        const task = (async () => {
            for (let attempt = 0; attempt < 8; attempt += 1) {
                await new Promise<void>((resolve) => setImmediate(resolve));
                if (this.#closed) return;
                try {
                    await this.#updateAgentMetadata(ctx, agentId, {
                        unread: { reason: "turn_finished", since },
                    });
                    return;
                } catch (error: unknown) {
                    if (attempt === 7) {
                        ctx.log.error(
                            "The API could not mark a completed agent turn unread.",
                            { agentId },
                            error,
                        );
                        return;
                    }
                }
            }
        })();
        this.#backgroundMetadataUpdates.add(task);
        void task.finally(() => this.#backgroundMetadataUpdates.delete(task));
    }

    #handleEventPull(url: URL, response: ServerResponse): void {
        const after = optionalCursor(url.searchParams.get("after"));
        const until = optionalCursor(url.searchParams.get("until"));
        const limit = integerParameter(url.searchParams.get("limit"), 100, 1, 10_000);
        const replay = this.#journal.replay(after, until, limit);
        if (replay === undefined) {
            throw new ApiError(409, "cursor_unavailable", "Event cursor is unavailable.", {
                cursor: this.#journal.cursor(),
            });
        }
        sendJson(response, 200, replay);
    }

    #handleEventStream(request: IncomingMessage, response: ServerResponse, url: URL): void {
        const supplied =
            request.headers["last-event-id"] ?? url.searchParams.get("after") ?? undefined;
        const after = Array.isArray(supplied)
            ? optionalCursor(supplied[0] ?? null)
            : optionalCursor(supplied);
        let replaying = true;
        const pending: ApiEvent[] = [];
        response.writeHead(200, {
            "cache-control": "no-store",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            "x-accel-buffering": "no",
        });
        const writer = createSseWriter(request, response, {
            maxBufferedBytes: MAX_SSE_BUFFER_BYTES,
            maxWritableBytes: MAX_SSE_BUFFER_BYTES,
        });
        this.#streams.add(writer);
        let heartbeat: NodeJS.Timeout | undefined;
        let unsubscribe = (): void => undefined;
        void writer.done.then(() => {
            if (heartbeat !== undefined) clearInterval(heartbeat);
            unsubscribe();
            this.#streams.delete(writer);
        });
        unsubscribe = this.#journal.subscribe((event) => {
            if (writer.closed) return;
            if (replaying) {
                pending.push(event);
                return;
            }
            writer.write(sseEventFrame(event));
        });
        const current = this.#journal.cursor();
        const gap = after !== undefined && !this.#journal.hasCursor(after);
        const replay =
            after === undefined || gap
                ? []
                : (this.#journal.replay(after, current, 10_000)?.events ?? []);
        if (
            !writer.write(
                `event: hello\ndata: ${JSON.stringify({
                    cursor: current,
                    gap,
                    resumed: after !== undefined && !gap,
                    connectedAt: Date.now(),
                    daemonId: this.#daemonId,
                    daemonStartedAt: this.#daemonStartedAt,
                    draining: this.#draining,
                })}\n\n`,
            )
        ) {
            return;
        }
        for (const event of replay) {
            if (!writer.write(sseEventFrame(event))) return;
        }
        replaying = false;
        for (const event of pending) {
            if (event.cursor > current && !writer.write(sseEventFrame(event))) return;
        }
        pending.splice(0);
        heartbeat = setInterval(() => {
            writer.heartbeat(`: heartbeat ${Date.now()}\n\n`);
        }, HEARTBEAT_MS);
        heartbeat.unref();
    }

    async #handleProjectRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        if (request.method === "POST" && url.pathname === "/v0/projects") {
            const body = await bodyAs(request, projectRegisterBodySchema, "project registration");
            const project = await this.#withMutationId(
                body.mutationId,
                async () =>
                    await this.#projects.register(ctx, {
                        path: body.path,
                        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
                    }),
            );
            sendJson(response, 200, { project: await this.#projectWithAgents(ctx, project) });
            return true;
        }
        if (request.method === "POST" && url.pathname === "/v0/projects/clone") {
            const body = await bodyAs(request, projectCloneBodySchema, "project clone");
            const project = await this.#withMutationId(
                body.mutationId,
                async () =>
                    await this.#projects.createRemote(ctx, {
                        name: body.name,
                        source: body.source,
                        ...(body.secret === undefined ? {} : { secret: body.secret }),
                        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
                    }),
            );
            sendJson(response, 202, { project: await this.#projectWithAgents(ctx, project) });
            return true;
        }
        const match = /^\/v0\/projects\/([a-z][a-z0-9]*)$/.exec(url.pathname);
        if (match !== null) {
            const projectId = match[1] as string;
            if (request.method === "GET") {
                const project = await this.#requireProject(ctx, projectId);
                sendJson(response, 200, {
                    project: await this.#projectWithAgents(ctx, project),
                });
                return true;
            }
            if (request.method === "PATCH") {
                const body = await bodyAs(request, renameBodySchema, "project rename");
                const current = await this.#requireProjectMatch(ctx, request, projectId);
                const project = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#projects.rename(ctx, {
                            projectId,
                            name: body.name,
                            expectedVersion: current.version,
                        }),
                );
                sendJson(response, 200, {
                    project: await this.#projectWithAgents(ctx, project),
                });
                return true;
            }
            return false;
        }
        const settings = /^\/v0\/projects\/([a-z][a-z0-9]*)\/settings$/.exec(url.pathname);
        if (settings !== null && request.method === "PUT") {
            const projectId = settings[1] as string;
            const body = await bodyAs(request, projectSettingsBodySchema, "project settings");
            const current = await this.#requireProjectMatch(ctx, request, projectId);
            await this.#withMutationId(
                body.mutationId,
                async () =>
                    await this.#projects.updateSettings(ctx, {
                        projectId,
                        expectedVersion: current.version,
                        settings: {
                            defaultWorkspaceCompute:
                                body.defaultWorkspaceCompute.type === "host"
                                    ? { type: "local" }
                                    : body.defaultWorkspaceCompute,
                        },
                    }),
            );
            const project = await this.#requireProject(ctx, projectId);
            const resource = await this.#projectWithAgents(ctx, project);
            sendJson(response, 200, {
                project: resource,
                settings: resource["settings"],
            });
            return true;
        }
        const action = /^\/v0\/projects\/([a-z][a-z0-9]*)\/(refresh|reorder|archive)$/.exec(
            url.pathname,
        );
        if (action !== null && request.method === "POST") {
            const projectId = action[1] as string;
            const operation = action[2] as "refresh" | "reorder" | "archive";
            if (operation === "refresh") {
                const project = await this.#projects.setUpAgain(ctx, projectId);
                sendJson(response, 202, {
                    project: await this.#projectWithAgents(ctx, project),
                });
                return true;
            }
            const current = await this.#requireProjectMatch(ctx, request, projectId);
            if (operation === "reorder") {
                const body = await bodyAs(request, reorderBodySchema, "project reorder");
                const project = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#projects.reorder(ctx, {
                            projectId,
                            afterId: body.afterId,
                            expectedVersion: current.version,
                        }),
                );
                sendJson(response, 200, {
                    project: await this.#projectWithAgents(ctx, project),
                });
                return true;
            }
            const body = await bodyAs(request, emptyMutationBodySchema, "project archive");
            const project = await this.#withMutationId(
                body.mutationId,
                async () => await this.#projects.archive(ctx, projectId),
            );
            sendJson(response, 202, {
                project: await this.#projectWithAgents(ctx, project),
            });
            return true;
        }
        const avatar = /^\/v0\/projects\/([a-z][a-z0-9]*)\/avatar$/.exec(url.pathname);
        if (avatar === null) return false;
        const projectId = avatar[1] as string;
        if (request.method === "GET") {
            await this.#requireProject(ctx, projectId);
            const asset = await this.#projects.avatarAsset(ctx, projectId);
            if (asset === undefined) throw notFound("The project has no avatar.");
            if (request.headers["if-none-match"] === asset.etag) {
                response.writeHead(304, {
                    "cache-control": "no-store",
                    etag: asset.etag,
                });
                response.end();
                return true;
            }
            response.writeHead(200, {
                "cache-control": "no-store",
                "content-length": asset.bytes.byteLength,
                "content-type": asset.contentType,
                etag: asset.etag,
            });
            response.end(Buffer.from(asset.bytes));
            return true;
        }
        if (request.method === "PUT") {
            const current = await this.#requireProjectMatch(ctx, request, projectId);
            const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
            if (
                contentType !== "image/png" &&
                contentType !== "image/jpeg" &&
                contentType !== "image/webp"
            ) {
                throw invalidRequest("The project avatar must be a PNG, JPEG, or WebP image.");
            }
            const bytes = await readBytes(request, 8 * 1024 * 1024);
            const project = await this.#projects.setAvatar(ctx, {
                projectId,
                bytes,
                contentType,
                source: "user",
                expectedVersion: current.version,
            });
            sendJson(response, 200, {
                project: await this.#projectWithAgents(ctx, project),
            });
            return true;
        }
        if (request.method === "DELETE") {
            const current = await this.#requireProjectMatch(ctx, request, projectId);
            const project = await this.#projects.clearAvatar(ctx, {
                projectId,
                expectedVersion: current.version,
            });
            sendJson(response, 200, {
                project: await this.#projectWithAgents(ctx, project),
            });
            return true;
        }
        return false;
    }

    async #requireProject(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.#projects.get(ctx, projectId);
        if (project === undefined) throw notFound("The project was not found.");
        return project;
    }

    async #handleBotRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        const direct = /^\/v0\/bots\/([a-z][a-z0-9]*)$/.exec(url.pathname);
        if (direct !== null) {
            const botId = direct[1] as string;
            if (request.method === "GET") {
                const bot = await this.#bots.get(ctx, botId);
                if (bot === undefined) throw notFound("The bot was not found.");
                sendJson(response, 200, { bot: await this.#botResource(ctx, bot) });
                return true;
            }
            if (request.method === "PATCH") {
                const body = await bodyAs(request, renameBotRequestSchema, "bot rename");
                const current = await this.#requireBotMatch(ctx, request, botId);
                const bot = await this.#botMutation(
                    ctx,
                    botId,
                    async () =>
                        await this.#withMutationId(
                            body.mutationId,
                            async () =>
                                await this.#bots.rename(ctx, botId, body.name, current.bot.version),
                        ),
                );
                sendJson(response, 200, { bot: await this.#botResource(ctx, bot) });
                return true;
            }
            return false;
        }

        const avatar = /^\/v0\/bots\/([a-z][a-z0-9]*)\/avatar$/.exec(url.pathname);
        if (avatar !== null) {
            const botId = avatar[1] as string;
            if (request.method === "GET") {
                const asset = await this.#bots.avatar(ctx, botId).catch((error: unknown) => {
                    if (error instanceof BotNotFoundError) throw notFound(error.message);
                    throw error;
                });
                if (asset === undefined) throw notFound("The bot has no avatar.");
                if (request.headers["if-none-match"] === asset.etag) {
                    response.writeHead(304, { "cache-control": "no-store", etag: asset.etag });
                    response.end();
                    return true;
                }
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-length": asset.bytes.byteLength,
                    "content-type": "image/webp",
                    etag: asset.etag,
                });
                response.end(Buffer.from(asset.bytes));
                return true;
            }
            if (request.method === "PUT") {
                const current = await this.#requireBotMatch(ctx, request, botId);
                const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
                if (
                    contentType !== "image/jpeg" &&
                    contentType !== "image/png" &&
                    contentType !== "image/webp"
                ) {
                    throw invalidRequest("The bot avatar must be a PNG, JPEG, or WebP image.");
                }
                const bytes = await readBytes(request, 8 * 1024 * 1024);
                const bot = await this.#botMutation(
                    ctx,
                    botId,
                    async () =>
                        await this.#bots.setAvatar(
                            ctx,
                            botId,
                            bytes,
                            contentType,
                            current.bot.version,
                        ),
                );
                sendJson(response, 200, { bot: await this.#botResource(ctx, bot) });
                return true;
            }
            if (request.method === "DELETE") {
                const current = await this.#requireBotMatch(ctx, request, botId);
                const bot = await this.#botMutation(
                    ctx,
                    botId,
                    async () => await this.#bots.clearAvatar(ctx, botId, current.bot.version),
                );
                sendJson(response, 200, { bot: await this.#botResource(ctx, bot) });
                return true;
            }
            return false;
        }

        const action = /^\/v0\/bots\/([a-z][a-z0-9]*)\/(archive|unarchive|reorder)$/.exec(
            url.pathname,
        );
        if (action === null || request.method !== "POST") return false;
        const botId = action[1] as string;
        const operation = action[2] as "archive" | "unarchive" | "reorder";
        const current = await this.#requireBotMatch(ctx, request, botId);
        if (operation === "reorder") {
            const body = await bodyAs(request, reorderBotRequestSchema, "bot reorder");
            const bot = await this.#botMutation(
                ctx,
                botId,
                async () =>
                    await this.#withMutationId(
                        body.mutationId,
                        async () =>
                            await this.#bots.reorder(ctx, botId, body.afterId, current.bot.version),
                    ),
            );
            sendJson(response, 200, { bot: await this.#botResource(ctx, bot) });
            return true;
        }
        const schema =
            operation === "archive" ? archiveBotRequestSchema : unarchiveBotRequestSchema;
        const body = await bodyAs(request, schema, `bot ${operation}`);
        const bot = await this.#botMutation(
            ctx,
            botId,
            async () =>
                await this.#withMutationId(body.mutationId, async () =>
                    operation === "archive"
                        ? await this.#bots.archive(ctx, botId, current.bot.version)
                        : await this.#bots.unarchive(ctx, botId, current.bot.version),
                ),
        );
        sendJson(response, 200, { bot: await this.#botResource(ctx, bot) });
        return true;
    }

    async #requireBotMatch(
        ctx: Context,
        request: IncomingMessage,
        botId: string,
    ): Promise<{ readonly bot: BotRecord; readonly resource: Record<string, unknown> }> {
        const bot = await this.#bots.get(ctx, botId);
        if (bot === undefined) throw notFound("The bot was not found.");
        const resource = await this.#botResource(ctx, bot);
        requireIfMatch(request, resource["version"], {
            currentVersion: resource["version"],
            bot: resource,
        });
        return { bot, resource };
    }

    async #botMutation(
        ctx: Context,
        botId: string,
        mutate: () => Promise<BotRecord>,
    ): Promise<BotRecord> {
        try {
            return await mutate();
        } catch (error: unknown) {
            if (!(error instanceof BotConflictError)) throw error;
            const current = await this.#bots.get(ctx, botId);
            if (current === undefined) throw notFound("The bot was not found.");
            const bot = await this.#botResource(ctx, current);
            throw new ApiError(409, "conflict", error.message, {
                currentVersion: bot["version"],
                bot,
            });
        }
    }

    async #requireProjectMatch(
        ctx: Context,
        request: IncomingMessage,
        projectId: string,
    ): Promise<Project> {
        const project = await this.#requireProject(ctx, projectId);
        const resource = await this.#projectWithAgents(ctx, project);
        requireIfMatch(request, resource["version"], {
            currentVersion: resource["version"],
            project: resource,
        });
        return project;
    }

    async #handleWorkspaceRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        if (request.method === "POST" && url.pathname === "/v0/workspaces") {
            const body = await bodyAs(request, workspaceCreateBodySchema, "workspace creation");
            if ((await this.#bots.forWorkspace(ctx, body.parentId)) !== undefined) {
                throw new ApiError(
                    409,
                    "conflict",
                    "A bot workspace cannot have child workspaces.",
                );
            }
            const root = await this.#projects.get(ctx, body.parentId);
            let projectId: string;
            if (root !== undefined) {
                if (root.archivedAt !== undefined || root.status !== "active") {
                    throw notFound("The parent workspace was not found.");
                }
                projectId = root.id;
            } else {
                const parent = await this.#workspaces.get(ctx, body.parentId);
                if (
                    parent === undefined ||
                    parent.archivedAt !== undefined ||
                    parent.status === "archived" ||
                    parent.status === "archiving"
                ) {
                    throw notFound("The parent workspace was not found.");
                }
                if (parent.status === "initializing") {
                    throw new ApiError(
                        409,
                        "not_initialized",
                        "The parent workspace is still initializing.",
                    );
                }
                if (parent.status !== "ready") {
                    throw new ApiError(409, "conflict", "The parent workspace is unavailable.");
                }
                projectId = parent.projectRef;
            }
            const workspace = await this.#withMutationId(
                body.mutationId,
                async () =>
                    await this.#workspaces.createWorkspace(
                        ctx,
                        projectId,
                        {
                            name: body.name,
                            nameConfigured: body.nameConfigured ?? true,
                            parentId: body.parentId,
                            ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                            ...(body.id === undefined ? {} : { id: body.id }),
                        },
                        body.agentId,
                    ),
            );
            if (workspace === undefined) throw notFound("The parent workspace was not found.");
            sendJson(response, 202, {
                workspace: {
                    ...workspaceResource(workspace),
                    agents: await this.#agentsForWorkspace(ctx, workspace.id),
                },
            });
            return true;
        }
        const match = /^\/v0\/workspaces\/([a-z][a-z0-9]*)$/.exec(url.pathname);
        if (match !== null) {
            const workspaceId = match[1] as string;
            if (request.method === "GET") {
                sendJson(response, 200, {
                    workspace: await this.#workspaceWithAgents(ctx, workspaceId),
                });
                return true;
            }
            if (request.method === "PATCH") {
                if ((await this.#bots.forWorkspace(ctx, workspaceId)) !== undefined) {
                    throw new ApiError(409, "conflict", "Rename this workspace through its bot.");
                }
                const project = await this.#projects.get(ctx, workspaceId);
                if (project !== undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "Rename the root workspace through its project.",
                    );
                }
                const body = await bodyAs(request, renameBodySchema, "workspace rename");
                const current = await this.#requireWorkspaceMatch(ctx, request, workspaceId);
                const workspace = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#workspaces.rename(ctx, {
                            workspaceId,
                            name: body.name,
                            expectedVersion: current.version,
                        }),
                );
                sendJson(response, 200, {
                    workspace: {
                        ...workspaceResource(workspace),
                        agents: await this.#agentsForWorkspace(ctx, workspace.id),
                    },
                });
                return true;
            }
            return false;
        }
        const action = /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/(archive|reorder)$/.exec(url.pathname);
        if (action === null || request.method !== "POST") return false;
        const workspaceId = action[1] as string;
        if ((await this.#bots.forWorkspace(ctx, workspaceId)) !== undefined) {
            throw new ApiError(
                409,
                "conflict",
                action[2] === "archive"
                    ? "Archive this workspace through its bot."
                    : "Reorder this workspace through its bot.",
            );
        }
        if ((await this.#projects.get(ctx, workspaceId)) !== undefined) {
            throw new ApiError(
                409,
                "conflict",
                action[2] === "archive"
                    ? "Archive the root workspace through its project."
                    : "Reorder the root workspace through its project.",
            );
        }
        const current = await this.#requireWorkspaceMatch(ctx, request, workspaceId);
        if (action[2] === "reorder") {
            const body = await bodyAs(request, reorderBodySchema, "workspace reorder");
            const workspace = await this.#withMutationId(
                body.mutationId,
                async () =>
                    await this.#workspaces.reorder(ctx, {
                        workspaceId,
                        afterId: body.afterId,
                        expectedVersion: current.version,
                    }),
            );
            sendJson(response, 200, {
                workspace: {
                    ...workspaceResource(workspace),
                    agents: await this.#agentsForWorkspace(ctx, workspace.id),
                },
            });
            return true;
        }
        const body = await bodyAs(request, emptyMutationBodySchema, "workspace archive");
        const workspace = await this.#withMutationId(
            body.mutationId,
            async () =>
                await this.#workspaces.archive(ctx, workspaceId, {
                    expectedVersion: current.version,
                }),
        );
        sendJson(response, 202, {
            workspace: {
                ...workspaceResource(workspace),
                agents: await this.#agentsForWorkspace(ctx, workspace.id),
            },
        });
        return true;
    }

    async #workspaceWithAgents(
        ctx: Context,
        workspaceId: string,
    ): Promise<Record<string, unknown>> {
        const bot = await this.#bots.forWorkspace(ctx, workspaceId);
        if (bot !== undefined) {
            const agent = await this.#buildAgentResource(ctx, bot.agentId, bot.workspaceId, null);
            if (agent === undefined) throw new Error("The bot workspace has no agent.");
            return botWorkspaceResource(bot, agent);
        }
        const project = await this.#projects.get(ctx, workspaceId);
        if (project !== undefined) {
            if (project.status === "archived" || project.archivedAt !== undefined) {
                return {
                    ...rootWorkspaceResource(project),
                    agents: await this.#agentsForProject(ctx, project.id),
                };
            }
            if (project.status !== "active") {
                throw new ApiError(409, "conflict", "The root workspace is not available.");
            }
            if (project.initializationStatus === "initializing") {
                throw new ApiError(
                    409,
                    "not_initialized",
                    "The root workspace is still initializing.",
                );
            }
            if (project.initializationStatus !== "ready") {
                throw new ApiError(409, "conflict", "The root workspace is not available.");
            }
            return {
                ...rootWorkspaceResource(project),
                agents: await this.#agentsForProject(ctx, project.id),
            };
        }
        const workspace = await this.#workspaces.get(ctx, workspaceId);
        if (workspace === undefined) throw notFound("The workspace was not found.");
        return {
            ...workspaceResource(workspace),
            agents: await this.#agentsForWorkspace(ctx, workspace.id),
        };
    }

    async #requireWorkspaceMatch(
        ctx: Context,
        request: IncomingMessage,
        workspaceId: string,
    ): Promise<Workspace> {
        const workspace = await this.#workspaces.get(ctx, workspaceId);
        if (workspace === undefined) throw notFound("The workspace was not found.");
        const resource: Record<string, unknown> = {
            ...workspaceResource(workspace),
            agents: await this.#agentsForWorkspace(ctx, workspace.id),
        };
        requireIfMatch(request, resource["version"], {
            currentVersion: resource["version"],
            workspace: resource,
        });
        return workspace;
    }

    async #refreshAgentOwnerVisibility(
        ctx: Context,
        agentId: string,
        visible: boolean,
    ): Promise<void> {
        // A bot's one agent is always embedded and visible; bot lifecycle owns archival.
        if ((await this.#bots.forAgent(ctx, agentId)) !== undefined) return;
        const workspaceId = this.#config.configuration.values.features.workspaces
            ? await this.#workspaces.workspaceForAgent(ctx, agentId)
            : undefined;
        if (workspaceId !== undefined) {
            await this.#workspaces.refreshAgentVisibility(ctx, workspaceId, agentId, visible);
            return;
        }
        const project = await this.#projects.projectForAgent(ctx, agentId);
        if (project === undefined) throw notFound("The agent owner was not found.");
        await this.#projects.refreshAgentVisibility(ctx, project.id, agentId, visible);
    }

    async #handleWorkspaceContentRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        const terminals = /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/terminals$/.exec(url.pathname);
        if (terminals !== null) {
            const workspaceId = terminals[1] as string;
            const { scope } = await this.#resolveWorkspaceScope(ctx, workspaceId);
            if (request.method === "GET") {
                const rows = await this.#terminals.list(ctx, scope);
                sendJson(response, 200, {
                    terminals: rows.map((row) => terminalResource(workspaceId, row)),
                });
                return true;
            }
            if (request.method === "POST") {
                const body = await bodyAs(request, terminalCreateBodySchema, "terminal settings");
                const { mutationId, ...input } = body;
                const terminal = await this.#withMutationId(
                    mutationId,
                    async () => await this.#terminals.create(ctx, scope, input),
                );
                sendJson(response, 201, { terminal: terminalResource(workspaceId, terminal) });
                return true;
            }
            return false;
        }
        const terminal = /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/terminals\/([a-z][a-z0-9]*)$/.exec(
            url.pathname,
        );
        if (terminal !== null) {
            const workspaceId = terminal[1] as string;
            const terminalId = terminal[2] as string;
            const { scope } = await this.#resolveWorkspaceScope(ctx, workspaceId);
            if (request.method === "PATCH") {
                const body = await bodyAs(request, terminalResizeBodySchema, "terminal size");
                const { mutationId, ...input } = body;
                const resized = await this.#withMutationId(
                    mutationId,
                    async () => await this.#terminals.resize(ctx, scope, terminalId, input),
                );
                sendJson(response, 200, {
                    terminal: terminalResource(workspaceId, resized),
                });
                return true;
            }
            if (request.method === "DELETE") {
                const stopped = await this.#terminals.stop(ctx, scope, terminalId);
                sendJson(response, 200, {
                    terminal: terminalResource(workspaceId, stopped),
                });
                return true;
            }
            return false;
        }
        const fileRoute =
            /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/(files|file-tree|file|file-revision)$/.exec(
                url.pathname,
            );
        if (fileRoute !== null) {
            const workspaceId = fileRoute[1] as string;
            const kind = fileRoute[2] as "files" | "file-tree" | "file" | "file-revision";
            const { projectId, childWorkspaceId } = await this.#resolveWorkspaceScope(
                ctx,
                workspaceId,
            );
            const bot = await this.#bots.forWorkspace(ctx, workspaceId);
            const root =
                bot === undefined
                    ? await this.#files.resolveRoot(ctx, projectId, childWorkspaceId)
                    : await this.#files.resolveBotRoot(ctx, workspaceId);
            if (kind === "files" && request.method === "GET") {
                const query = queryAs(
                    {
                        query: url.searchParams.get("query") ?? undefined,
                        ...(url.searchParams.has("limit")
                            ? {
                                  limit: integerParameter(url.searchParams.get("limit"), 50, 1, 50),
                              }
                            : {}),
                    },
                    fileSearchQuerySchema,
                    "file search",
                );
                sendJson(response, 200, await this.#files.search(root, query));
                return true;
            }
            if (kind === "file-tree" && request.method === "GET") {
                const query = queryAs(
                    {
                        ...(url.searchParams.has("path")
                            ? { path: url.searchParams.get("path") ?? "" }
                            : {}),
                        ...(url.searchParams.has("cursor")
                            ? { cursor: url.searchParams.get("cursor") ?? "" }
                            : {}),
                        ...(url.searchParams.has("limit")
                            ? {
                                  limit: integerParameter(
                                      url.searchParams.get("limit"),
                                      100,
                                      1,
                                      500,
                                  ),
                              }
                            : {}),
                    },
                    fileTreeQuerySchema,
                    "file tree",
                );
                const tree = await this.#files.tree(root, query);
                sendJson(response, 200, {
                    entries: tree.entries,
                    nextCursor: tree.nextCursor,
                });
                return true;
            }
            if (kind === "file" && request.method === "GET") {
                const query = queryAs(
                    { path: url.searchParams.get("path") ?? undefined },
                    fileReadQuerySchema,
                    "file read",
                );
                sendJson(response, 200, await this.#files.read(root, query));
                return true;
            }
            if (kind === "file" && request.method === "PUT") {
                const body = await bodyAs(request, fileWriteSchema, "file write");
                sendJson(response, 200, await this.#files.write(root, body));
                return true;
            }
            if (kind === "file-revision" && request.method === "GET") {
                const query = queryAs(
                    {
                        path: url.searchParams.get("path") ?? undefined,
                        revision: url.searchParams.get("revision") ?? undefined,
                    },
                    fileRevisionQuerySchema,
                    "file revision",
                );
                const revision = await this.#files.readRevision(root, query);
                if (revision.content === null) {
                    throw notFound("The file was not found at that revision.");
                }
                sendJson(response, 200, { content: revision.content });
                return true;
            }
            return false;
        }
        const git = /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/git$/.exec(url.pathname);
        if (git !== null && request.method === "GET") {
            const workspaceId = git[1] as string;
            const { root } = await this.#resolveWorkspaceScope(ctx, workspaceId);
            const snapshot = await this.#git.snapshot(root, workspaceId);
            sendJson(response, 200, { git: gitResource(snapshot) });
            return true;
        }
        return false;
    }

    async #handleGitWatch(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const body = await bodyAs(request, gitWatchBodySchema, "Git watch request");
        const snapshots: Record<string, unknown> = {};
        const tracked: {
            readonly entity: {
                readonly path: string;
                readonly projectId: string;
                readonly workspaceId?: string;
            };
            readonly workspaceId: string;
        }[] = [];
        for (const workspaceId of body.workspaceIds) {
            const { projectId, childWorkspaceId, root } = await this.#resolveWorkspaceScope(
                ctx,
                workspaceId,
            );
            const entity = {
                path: root,
                projectId,
                ...(childWorkspaceId === undefined ? {} : { workspaceId: childWorkspaceId }),
            };
            tracked.push({ entity, workspaceId });
        }
        this.#git.replaceTracked(tracked.map(({ entity }) => entity));
        for (const { entity, workspaceId } of tracked) {
            const snapshot = this.#git.trackedSnapshot(entity);
            if (snapshot !== undefined) snapshots[workspaceId] = gitResource(snapshot);
        }
        sendJson(response, 200, { snapshots });
    }

    async #resolveWorkspaceScope(
        ctx: Context,
        workspaceId: string,
    ): Promise<{
        readonly botId?: string;
        readonly childWorkspaceId?: string;
        readonly projectId: string;
        readonly root: string;
        readonly scope: TerminalScope;
    }> {
        const bot = await this.#bots.forWorkspace(ctx, workspaceId);
        if (bot !== undefined) {
            if (bot.status !== "active") {
                throw new ApiError(409, "conflict", "The workspace is not available.");
            }
            return {
                botId: bot.id,
                childWorkspaceId: bot.workspaceId,
                projectId: bot.id,
                root: bot.path,
                scope: { projectId: bot.id, workspaceId: bot.workspaceId },
            };
        }
        const project = await this.#projects.get(ctx, workspaceId);
        if (project !== undefined) {
            // A root workspace is its project, and an archived project's folder is on its way out.
            // The child branch below refuses a workspace that is not ready for the same reason.
            if (project.status !== "active") {
                throw new ApiError(409, "conflict", "The workspace is not available.");
            }
            return {
                projectId: project.id,
                root: project.repositoryRef,
                scope: { projectId: project.id },
            };
        }
        const workspace = await this.#workspaces.get(ctx, workspaceId);
        if (workspace === undefined) throw notFound("The workspace was not found.");
        if (workspace.status === "initializing") {
            throw new ApiError(409, "not_initialized", "The workspace is still initializing.");
        }
        if (workspace.status !== "ready") {
            throw new ApiError(409, "conflict", "The workspace is not available.");
        }
        return {
            childWorkspaceId: workspace.id,
            projectId: workspace.projectRef,
            root: workspace.path,
            scope: { projectId: workspace.projectRef, workspaceId: workspace.id },
        };
    }

    async #handleWorkspaceList(ctx: Context, url: URL, response: ServerResponse): Promise<void> {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        const includeArchived = booleanParameter(url.searchParams.get("includeArchived"), false);
        const projects = (await this.#allProjects(ctx, includeArchived)).filter(
            (project) => projectId === undefined || project.id === projectId,
        );
        const workspaces = await this.#allWorkspaces(ctx, projectId, includeArchived);
        const roots = await Promise.all(
            projects.map(async (project) => ({
                ...rootWorkspaceResource(project),
                agents: await this.#agentsForProject(ctx, project.id),
            })),
        );
        sendJson(response, 200, {
            workspaces: [
                ...roots,
                ...(await Promise.all(
                    workspaces.map(async (workspace) => ({
                        ...workspaceResource(workspace),
                        agents: await this.#agentsForWorkspace(ctx, workspace.id),
                    })),
                )),
            ],
        });
    }

    async #allProjects(ctx: Context, includeArchived: boolean): Promise<Project[]> {
        const projects: Project[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.#projects.list(ctx, {
                includeArchived,
                ...(cursor === undefined ? {} : { cursor }),
                limit: 50,
            });
            projects.push(...page.projects);
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return projects;
    }

    async #allWorkspaces(
        ctx: Context,
        projectRef: string | undefined,
        includeArchived: boolean,
    ): Promise<Workspace[]> {
        const workspaces: Workspace[] = [];
        let cursor: number | undefined;
        do {
            const page = await this.#workspaces.listPage(ctx, {
                includeArchived,
                ...(projectRef === undefined ? {} : { projectRef }),
                ...(cursor === undefined ? {} : { cursor }),
                limit: 50,
            });
            workspaces.push(...page.workspaces);
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return workspaces;
    }

    async #projectWithAgents(ctx: Context, project: Project): Promise<Record<string, unknown>> {
        return {
            ...(await projectResource(ctx, this.#projects, project)),
            agents: await this.#agentsForProject(ctx, project.id),
        };
    }

    async #botResource(ctx: Context, bot: BotRecord): Promise<Record<string, unknown>> {
        const agent = await this.#buildAgentResource(ctx, bot.agentId, bot.workspaceId, null);
        if (agent === undefined) throw new Error("The bot has no agent.");
        return botResource(bot, agent);
    }

    async #agentsForProject(
        ctx: Context,
        projectId: string,
    ): Promise<readonly Record<string, unknown>[]> {
        const associations = await this.#projects.listAgents(ctx, projectId);
        const resources = await Promise.all(
            associations.map(
                async (association) =>
                    await this.#buildAgentResource(
                        ctx,
                        association.agentId,
                        projectId,
                        association.orderKey,
                    ),
            ),
        );
        return resources.filter(
            (resource): resource is Record<string, unknown> =>
                resource !== undefined && resource["archivedAt"] === null,
        );
    }

    async #agentsForWorkspace(
        ctx: Context,
        workspaceId: string,
    ): Promise<readonly Record<string, unknown>[]> {
        const associations = await this.#workspaces.listAgents(ctx, workspaceId);
        const resources = await Promise.all(
            associations.map(
                async (association) =>
                    await this.#buildAgentResource(
                        ctx,
                        association.agentId,
                        workspaceId,
                        association.orderKey,
                    ),
            ),
        );
        return resources.filter(
            (resource): resource is Record<string, unknown> =>
                resource !== undefined && resource["archivedAt"] === null,
        );
    }

    #agentSystem(): AgentSystemRef {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The API module has not started.");
        return agents;
    }

    /** Serialize concurrent retries before they touch the shared pending-announcement state. */
    async #serializeMessageSend(messageId: string, operation: () => Promise<void>): Promise<void> {
        const predecessor = this.#messageSendGates.get(messageId);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#messageSendGates.set(messageId, gate);
        if (predecessor !== undefined) await predecessor;
        try {
            await operation();
        } finally {
            release();
            if (this.#messageSendGates.get(messageId) === gate) {
                this.#messageSendGates.delete(messageId);
            }
        }
    }

    /** Read one existing client-owned user message from a single transaction snapshot. */
    async #sentUserMessage(
        ctx: Context,
        agentId: string,
        messageId: string,
    ): Promise<Record<string, unknown> | undefined> {
        const accepted = await this.#history.message(ctx, agentId, messageId);
        if (accepted !== undefined) {
            if (accepted.role !== "user") {
                throw new ApiError(409, "conflict", "The message ID is already in use.");
            }
            return messageResource(accepted);
        }
        const pending = (await this.#history.pending(ctx, agentId)).find(
            (message) => message.id === messageId,
        );
        return pending === undefined ? undefined : pendingMessageResource(pending);
    }

    async #withMutationId<Value>(
        mutationId: string | undefined,
        operation: () => Promise<Value>,
    ): Promise<Value> {
        return mutationId === undefined
            ? await operation()
            : await this.#mutationIds.run(mutationId, operation);
    }

    async #cloudOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
        try {
            return await operation();
        } catch (error: unknown) {
            if (error instanceof CloudOperationError) {
                const details = {
                    cloud: error.cloud,
                    ...(error.cloudSocial === undefined ? {} : { cloudSocial: error.cloudSocial }),
                    ...(error.devices === undefined ? {} : { devices: error.devices }),
                };
                throw new ApiError(error.status, error.code, error.message, {
                    ...details,
                });
            }
            throw error;
        }
    }

    async #handleProfilePatch(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const body = await bodyAs(request, profilePatchBodySchema, "profile update");
        if (body.name === undefined && body.email === undefined) {
            throw invalidRequest("A profile update must change a name or email address.");
        }
        const current = await this.#profile.ensure(ctx);
        const resource = profileResource(current);
        const expectedVersion = requireIfMatch(request, resource["version"], {
            currentVersion: resource["version"],
            profile: resource,
        });
        const updated = await this.#withMutationId(
            body.mutationId,
            async () =>
                await this.#profile.update(
                    ctx,
                    current.id,
                    {
                        ...(body.name === undefined ? {} : { name: body.name }),
                        ...(body.email === undefined ? {} : { email: body.email }),
                    },
                    { expectedVersion },
                ),
        );
        if (updated === undefined) throw notFound("The profile was not found.");
        sendJson(response, 200, { profile: profileResource(updated) });
    }

    async #handleTeamProfilePatch(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const body = await bodyAs(request, profilePatchBodySchema, "profile update");
        if (body.name === undefined && body.email === undefined) {
            throw invalidRequest("A profile update must change a name or email address.");
        }
        const current = await this.#team.currentUser(ctx);
        const resource = teamProfileResource(current);
        const expectedVersion = requireIfMatch(request, resource["version"], {
            currentVersion: resource["version"],
            profile: resource,
        });
        const updated = await this.#withMutationId(
            body.mutationId,
            async () =>
                await this.#team.updateCurrentProfile(
                    ctx,
                    {
                        ...(body.name === undefined ? {} : { name: body.name }),
                        ...(body.email === undefined ? {} : { email: body.email }),
                    },
                    expectedVersion,
                ),
        );
        sendJson(response, 200, { profile: teamProfileResource(updated) });
    }

    async #handleSecretRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        if (url.pathname === "/v0/secrets" && request.method === "GET") {
            assertOnlyQueryParameters(url, ["cursor", "limit", "targetId", "targetType"]);
            const cursor = url.searchParams.get("cursor") ?? undefined;
            if (cursor !== undefined && !Value.Check(secretApiIdSchema, cursor)) {
                throw invalidRequest("The secret cursor is invalid.");
            }
            const targetId = url.searchParams.get("targetId") ?? undefined;
            const targetType = url.searchParams.get("targetType") ?? undefined;
            if ((targetId === undefined) !== (targetType === undefined)) {
                throw invalidRequest("Secret targetType and targetId must be supplied together.");
            }
            const target =
                targetId === undefined || targetType === undefined
                    ? undefined
                    : secretTarget(targetType, targetId);
            if (target !== undefined) await this.#requireSecretTarget(ctx, target, false);
            sendJson(
                response,
                200,
                await this.#secrets.listCatalog(ctx, {
                    ...(cursor === undefined ? {} : { cursor }),
                    limit: integerParameter(url.searchParams.get("limit"), 50, 1, 100),
                    ...(target === undefined ? {} : { target }),
                }),
            );
            return true;
        }
        if (url.pathname === "/v0/secrets" && request.method === "POST") {
            const body = await bodyAs(request, createSecretRequestSchema, "secret creation");
            const { mutationId, ...input } = body;
            try {
                const secret = await this.#withMutationId(
                    mutationId,
                    async () => await this.#secrets.createCatalogSecret(ctx, input),
                );
                sendJson(response, 201, { secret });
            } catch (error: unknown) {
                throw secretMutationError(error);
            }
            return true;
        }

        const attachment =
            /^\/v0\/secrets\/([^/]+)\/attachments\/(project|workspace|agent)\/([^/]+)$/u.exec(
                url.pathname,
            );
        if (attachment !== null && (request.method === "PUT" || request.method === "DELETE")) {
            const secretId = secretPathId(attachment[1]!, "secret ID");
            const target = secretTarget(
                attachment[2]!,
                decodePathSegment(attachment[3]!, "secret target ID"),
            );
            const current = await this.#secrets.catalogSecret(ctx, secretId);
            if (current === undefined) throw notFound("The secret was not found.");
            await this.#requireSecretTarget(ctx, target, request.method === "PUT");
            const body = await optionalBodyAs(
                request,
                secretAttachmentMutationRequestSchema,
                "secret attachment mutation",
                2 * 1_024,
            );
            try {
                if (request.method === "PUT") {
                    const result = await this.#withMutationId(
                        body.mutationId,
                        async () => await this.#secrets.attachCatalogSecret(ctx, secretId, target),
                    );
                    sendJson(response, result.created ? 201 : 200, result);
                } else {
                    const removed = await this.#withMutationId(
                        body.mutationId,
                        async () => await this.#secrets.detachCatalogSecret(ctx, secretId, target),
                    );
                    sendJson(response, 200, {
                        detached: removed !== undefined,
                        attachment: removed ?? null,
                    });
                }
            } catch (error: unknown) {
                throw secretMutationError(error);
            }
            return true;
        }

        const attachments = /^\/v0\/secrets\/([^/]+)\/attachments$/u.exec(url.pathname);
        if (attachments !== null && request.method === "GET") {
            assertOnlyQueryParameters(url, ["cursor", "limit"]);
            const secretId = secretPathId(attachments[1]!, "secret ID");
            const cursor = url.searchParams.get("cursor") ?? undefined;
            if (cursor !== undefined && !Value.Check(cuid2Schema, cursor)) {
                throw invalidRequest("The secret attachment cursor is invalid.");
            }
            const page = await this.#secrets.listCatalogAttachments(ctx, secretId, {
                ...(cursor === undefined ? {} : { cursor }),
                limit: integerParameter(url.searchParams.get("limit"), 50, 1, 100),
            });
            if (page === undefined) throw notFound("The secret was not found.");
            sendJson(response, 200, page);
            return true;
        }

        const single = /^\/v0\/secrets\/([^/]+)$/u.exec(url.pathname);
        if (single === null) return false;
        const secretId = secretPathId(single[1]!, "secret ID");
        if (request.method === "GET") {
            const secret = await this.#secrets.catalogSecret(ctx, secretId);
            if (secret === undefined) throw notFound("The secret was not found.");
            sendJson(response, 200, { secret });
            return true;
        }
        if (request.method === "PATCH") {
            const current = await this.#secrets.catalogSecret(ctx, secretId);
            if (current === undefined) throw notFound("The secret was not found.");
            const expectedVersion = requireIfMatch(request, current.version, {
                currentVersion: current.version,
                secret: current,
            });
            const body = await bodyAs(request, updateSecretRequestSchema, "secret update");
            const { mutationId, ...input } = body;
            try {
                const secret = await this.#withMutationId(
                    mutationId,
                    async () =>
                        await this.#secrets.updateCatalogSecret(
                            ctx,
                            secretId,
                            expectedVersion,
                            input,
                        ),
                );
                if (secret === undefined) throw notFound("The secret was not found.");
                sendJson(response, 200, { secret });
            } catch (error: unknown) {
                throw secretMutationError(error);
            }
            return true;
        }
        return false;
    }

    async #requireSecretTarget(
        ctx: Context,
        target: SecretApiTarget,
        requireActive: boolean,
    ): Promise<void> {
        if (target.type === "project") {
            const project = await this.#projects.get(ctx, target.id);
            if (project === undefined)
                throw notFound("The secret attachment project was not found.");
            if (requireActive && project.status !== "active") {
                throw new ApiError(409, "conflict", "The secret attachment project is archived.");
            }
            return;
        }
        if (target.type === "workspace") {
            const bot = await this.#bots.forWorkspace(ctx, target.id);
            if (bot !== undefined) {
                if (requireActive && bot.status !== "active") {
                    throw new ApiError(
                        409,
                        "conflict",
                        "The secret attachment workspace is archived.",
                    );
                }
                return;
            }
            const project = await this.#projects.get(ctx, target.id);
            if (project !== undefined) {
                if (requireActive && project.status !== "active") {
                    throw new ApiError(
                        409,
                        "conflict",
                        "The secret attachment workspace is archived.",
                    );
                }
                return;
            }
            const workspace = await this.#workspaces.get(ctx, target.id);
            if (workspace === undefined) {
                throw notFound("The secret attachment workspace was not found.");
            }
            if (requireActive && workspace.status !== "ready") {
                throw new ApiError(
                    409,
                    "conflict",
                    "The secret attachment workspace is unavailable.",
                );
            }
            return;
        }
        const agent = await this.#agentSystem().config(ctx, target.id);
        if (agent === undefined) throw notFound("The secret attachment agent was not found.");
        if (requireActive && typeof agent.metadata?.["archivedAt"] === "number") {
            throw new ApiError(409, "conflict", "The secret attachment agent is archived.");
        }
    }

    async #onboarding(ctx: Context): Promise<Record<string, unknown>> {
        const [profileDone, projects, marker] = await Promise.all([
            this.#team.enabled
                ? this.#team.currentUser(ctx).then((user) => user !== undefined)
                : this.#profile.get(ctx).then((profile) => profile?.name != null),
            this.#allProjects(ctx, false),
            readFile(this.#onboardingMarker(), "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
            }),
        ]);
        const signedIn = [...new Set(this.#config.models.map((model) => model.providerId))];
        return {
            completed: marker !== undefined,
            steps: {
                providers: { done: signedIn.length > 0, signedIn },
                profile: { done: profileDone },
                project: { done: projects.length > 0 },
            },
        };
    }

    async #desktopBootstrap(ctx: Context): Promise<Record<string, unknown>> {
        // Capture first. A mutation concurrent with the reads is replayed after this cursor, which
        // may cause a harmless dirty/refetch but can never disappear between snapshot and stream.
        const cursor = this.#journal.cursor();
        const [profile, onboarding, projects, workspaces, bots] = await Promise.all([
            this.#team.enabled
                ? this.#team.currentUser(ctx).then(teamProfileResource)
                : this.#profile.ensure(ctx).then(profileResource),
            this.#onboarding(ctx),
            this.#allProjects(ctx, false),
            this.#config.configuration.values.features.workspaces
                ? this.#allWorkspaces(ctx, undefined, false)
                : Promise.resolve([]),
            this.#bots.list(ctx),
        ]);
        const shallow = workspaces.filter(
            (workspace: Workspace) => workspace.parentId === workspace.projectRef,
        );
        return {
            config: this.#sanitizedConfig(),
            profile,
            onboarding,
            cloud: this.#cloud.status(ctx),
            cloudSocial: this.#cloud.socialStatus(ctx),
            happyIntegration: this.#happy.integration(ctx),
            bots: await Promise.all(bots.map(async (bot) => await this.#botResource(ctx, bot))),
            projects: await Promise.all(
                projects.map(
                    async (project: Project) => await this.#projectWithAgents(ctx, project),
                ),
            ),
            workspaces: [
                ...(await Promise.all(
                    projects.map(async (project: Project) => ({
                        ...rootWorkspaceResource(project),
                        agents: await this.#agentsForProject(ctx, project.id),
                    })),
                )),
                ...(await Promise.all(
                    shallow.map(async (workspace: Workspace) => ({
                        ...workspaceResource(workspace),
                        agents: await this.#agentsForWorkspace(ctx, workspace.id),
                    })),
                )),
            ],
            cursor,
        };
    }

    async #daemonUsage(ctx: Context): Promise<Record<string, unknown>> {
        const now = Date.now();
        const accountUsage = new Map(
            this.#providerUsage.list().map((entry) => [entry.providerId, entry]),
        );
        const providers = Object.entries(this.#sanitizedCatalog().providers).map(
            ([providerId, provider]) => {
                const account = accountUsage.get(providerId);
                return {
                    providerId,
                    ...provider,
                    usage: account?.usage ?? null,
                    checkedAt: account?.checkedAt ?? null,
                    error: account?.error ?? null,
                };
            },
        );
        // Each window is summed by the database over the complete durable history, so a window
        // reports everything that actually ran inside it rather than whatever a bounded page held.
        // The four are read together: the month contains the rest, so they cost one pass.
        const [hour, day, week, month] = await this.#usage.readWindowUsage(ctx, [
            now - 60 * 60 * 1_000,
            now - 24 * 60 * 60 * 1_000,
            now - 7 * 24 * 60 * 60 * 1_000,
            now - 30 * 24 * 60 * 60 * 1_000,
        ]);
        return { providers, hour, day, week, month };
    }

    async #usageForAgentTree(
        ctx: Context,
        rootAgentId: string,
    ): Promise<Record<string, Record<string, ApiUsageTokens>>> {
        const agents = this.#agentSystem();
        const pending = [rootAgentId];
        const visited = new Set<string>();
        const usage: Record<string, Record<string, ApiUsageTokens>> = {};
        while (pending.length > 0) {
            if (visited.size >= 10_000) {
                throw new ApiError(
                    413,
                    "too_large",
                    "The agent tree is too large to aggregate usage.",
                );
            }
            const agentId = pending.shift() as string;
            if (visited.has(agentId)) continue;
            visited.add(agentId);
            pending.push(...(await agents.childOf(ctx, agentId)));
            mergeUsageBreakdown(usage, await this.#usage.readAgentModelUsage(ctx, agentId));
        }
        return usage;
    }

    #onboardingMarker(): string {
        return join(this.#config.configuration.paths.agentHome, "onboarding-v0");
    }

    /** Reads remain available while drain and shutdown control requests bypass admission. */
    #isMutation(request: IncomingMessage, url: URL): boolean {
        if (request.method === "GET") return false;
        if (request.method !== "POST") return true;
        return url.pathname !== "/v0/drain" && url.pathname !== "/v0/shutdown";
    }

    /** Admit one HTTP mutation synchronously and return its exact-once release. */
    #admitMutation(request: IncomingMessage, url: URL): () => void {
        const admission = Symbol("api-mutation");
        this.#apiMutations.set(admission, {
            method: request.method ?? "UNKNOWN",
            path: url.pathname,
            startedAt: Date.now(),
        });
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            this.#apiMutations.delete(admission);
        };
    }

    /** Publish sticky draining before starting every registered component. */
    #beginDrain(ctx: Context): void {
        if (this.#draining) return;
        this.#draining = true;
        this.#journal.append("daemon.draining", {
            daemonId: this.#daemonId,
            draining: true,
        });
        for (const [name, source] of this.#drainSources) {
            const running: ApiRunningDrain = { finished: false };
            this.#runningDrains.set(name, running);
            let work: Promise<void>;
            try {
                work = source.start();
            } catch (error: unknown) {
                work = Promise.reject(error);
            }
            void work.then(
                () => {
                    running.finished = true;
                },
                (error: unknown) => {
                    ctx.log.error(`The daemon drain source "${name}" failed.`, {}, error);
                },
            );
        }
    }

    /** Build bounded, stable progress without allowing optional reporting to break health. */
    #drainWaitingFor(ctx?: Context): Record<string, unknown>[] {
        if (!this.#draining) return [];
        const waiting: Record<string, unknown>[] = [];
        if (this.#apiMutations.size > 0) {
            waiting.push({ name: "api-mutations", count: this.#apiMutations.size });
            this.#reportDrainMutations(ctx);
        }
        for (const [name, source] of this.#drainSources) {
            const running = this.#runningDrains.get(name);
            if (running === undefined) continue;
            let progress: ApiDrainProgress;
            try {
                progress = source.progress();
            } catch (error: unknown) {
                ctx?.log.warn(
                    `The daemon drain source "${name}" could not report progress.`,
                    {},
                    error,
                );
                progress = { count: 0 };
            }
            const reportedCount =
                Number.isSafeInteger(progress.count) && progress.count > 0 ? progress.count : 0;
            const count = reportedCount > 0 ? reportedCount : running.finished ? 0 : 1;
            if (count === 0) continue;
            const suppliedAgents = progress.agents;
            const agents =
                suppliedAgents === undefined
                    ? undefined
                    : [...suppliedAgents]
                          .sort((left, right) => left.id.localeCompare(right.id))
                          .slice(0, 100);
            waiting.push({
                name,
                count,
                ...(agents === undefined ? {} : { agents }),
                ...(progress.truncated === true || (suppliedAgents?.length ?? 0) > 100
                    ? { truncated: true }
                    : {}),
            });
        }
        return waiting;
    }

    /**
     * Name the requests holding the drain open. A mutation that never finishes keeps the daemon
     * draining forever, and the count alone does not say which request to go and look at.
     */
    #reportDrainMutations(ctx: Context | undefined): void {
        const now = Date.now();
        if (
            ctx === undefined ||
            now - this.#drainMutationsLoggedAt < DRAIN_MUTATION_LOG_INTERVAL_MS
        ) {
            return;
        }
        this.#drainMutationsLoggedAt = now;
        const oldest = [...this.#apiMutations.values()]
            .sort((left, right) => left.startedAt - right.startedAt)
            .slice(0, 5)
            .map(
                (mutation) =>
                    `${mutation.method} ${mutation.path} age=${String(
                        Math.round((now - mutation.startedAt) / 1000),
                    )}s`,
            )
            .join(", ");
        ctx.log.info(`daemon:drain:waiting mutations=${String(this.#apiMutations.size)} ${oldest}`);
    }

    #health(ctx: Context): Record<string, unknown> {
        const gracefulShutdown = shutdown.get(ctx);
        return {
            healthy: true,
            ready: this.#ready,
            draining: this.#draining,
            drainWaitingFor: this.#drainWaitingFor(ctx),
            shuttingDown: gracefulShutdown?.shuttingDown ?? false,
            status: this.#ready ? "ready" : "starting",
            version: {
                protocol: API_PROTOCOL_VERSION,
                daemon: this.#config.configuration.version,
            },
            waitingFor: gracefulShutdown?.pending() ?? [],
        };
    }

    #sanitizedConfig(): Record<string, unknown> {
        const values = this.#config.configuration.values;
        const { models, providers } = this.#sanitizedCatalog();
        const defaultModel = this.#config.models[0] ?? this.#config.offeredModels[0];
        return {
            defaults: {
                providerId: defaultModel?.providerId ?? values.defaults.providerId,
                modelId: defaultModel?.id ?? values.defaults.modelId,
                effort: defaultModel?.defaultEffort ?? values.defaults.effort,
                permissionMode: values.defaults.permissionMode,
            },
            features: values.features,
            mcpServers: Object.fromEntries(
                Object.entries(this.#config.mcpServers).map(([name, server]) => [
                    name,
                    { enabled: server.enabled !== false, transport: server.transport },
                ]),
            ),
            network: {
                allowedDomains: values.network?.allowedDomains ?? [],
                deniedDomains: values.network?.deniedDomains ?? [],
                allowedPorts: values.network?.allowedPorts ?? [],
                allowedLoopbackPorts: values.network?.allowedLoopbackPorts ?? [],
                allowLocalBinding: values.network?.allowLocalBinding ?? false,
            },
            p2p: {
                name: values.p2p.name,
                role: values.p2p.role,
                enableIroh: values.p2p.enableIroh,
                enableDirect: values.p2p.enableDirect,
                enableSsh: values.p2p.enableSsh,
                exposeApi: values.p2p.exposeApi,
            },
            permissions: values.permissions,
            presence: values.presence,
            models,
            providers,
            settings: {
                compactCompletedTurns: values.settings.compactCompletedTurns,
                completionChime: values.settings.completionChime,
                inferenceMaxRetries: values.settings.inferenceMaxRetries,
                showReasoning: values.settings.showReasoning,
                showUsage: values.settings.showUsage,
                toolResultRetentionDays: values.settings.toolResultRetentionDays,
            },
            theme: values.theme,
            workspace: values.workspace,
        };
    }

    #sanitizedCatalog(): ApiCatalog {
        const routes = this.#config.catalog;
        const models: Record<string, ApiModelDefinition> = {};
        for (const route of routes) {
            const candidate: ApiModelDefinition = {
                name: route.name,
                contextWindow: route.contextWindow,
                efforts: [...route.effortLevels],
                defaultEffort: route.defaultEffort,
                serviceTiers: [...(route.serviceTiers ?? [])],
            };
            const existing = models[route.id];
            if (
                existing === undefined ||
                candidate.efforts.length + candidate.serviceTiers.length >
                    existing.efforts.length + existing.serviceTiers.length
            ) {
                models[route.id] = candidate;
            }
        }

        const providers: Record<string, ApiProviderDefinition> = {};
        for (const [providerId, provider] of Object.entries(
            this.#config.configuration.values.providers,
        )) {
            const compatibility = this.#config.providers.typeOf(providerId);
            providers[providerId] = {
                type:
                    provider.type === "smart"
                        ? compatibility === null || compatibility === "gym"
                            ? "codex"
                            : compatibility
                        : provider.type,
                enabled: this.#config.isProviderEnabled(providerId),
                models: [],
            };
        }
        for (const route of routes) {
            let provider = providers[route.providerId];
            if (provider === undefined) {
                const compatibility = this.#config.providers.typeOf(route.providerId);
                provider = {
                    type:
                        compatibility === null || compatibility === "gym" ? "codex" : compatibility,
                    enabled: this.#config.isProviderEnabled(route.providerId),
                    models: [],
                };
                providers[route.providerId] = provider;
            }
            const definition = models[route.id];
            if (definition === undefined) continue;
            const efforts = [...route.effortLevels];
            const serviceTiers = [...(route.serviceTiers ?? [])];
            provider.models.push({
                id: route.id,
                enabled: route.enabled,
                ...(sameStrings(efforts, definition.efforts) ? {} : { efforts }),
                ...(route.defaultEffort === definition.defaultEffort
                    ? {}
                    : { defaultEffort: route.defaultEffort }),
                ...(route.name === definition.name ? {} : { name: route.name }),
                ...(sameStrings(serviceTiers, definition.serviceTiers) ? {} : { serviceTiers }),
            });
        }
        return { models, providers };
    }

    async #authenticate(
        ctx: Context,
        authorization: string | string[] | undefined,
    ): Promise<Context> {
        if (this.#team.enabled) {
            try {
                return this.#ready
                    ? await this.#team.authenticate(ctx, authorization)
                    : await this.#team.authenticateIdentity(ctx, authorization);
            } catch (error: unknown) {
                if (!(error instanceof TeamAuthenticationError)) throw error;
                throw new ApiError(401, "unauthorized", "Unauthorized");
            }
        }
        if (!this.#authorizedHeader(authorization)) {
            throw new ApiError(401, "unauthorized", "Unauthorized");
        }
        return ctx;
    }

    #authorizedHeader(authorization: string | string[] | undefined): boolean {
        const token = this.#token;
        if (token === undefined) return false;
        if (
            authorization === undefined ||
            Array.isArray(authorization) ||
            !authorization.startsWith("Bearer ")
        ) {
            return false;
        }
        const supplied = authorization.slice("Bearer ".length);
        if (supplied.length !== token.length) return false;
        return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    }

    #assertTeamUser(ctx: Context): void {
        if (this.#team.enabled && teamUser(ctx) === undefined) {
            throw new ApiError(401, "unauthorized", "Unauthorized");
        }
    }

    #assertSocketReady(): void {
        if (!this.#ready) {
            throw new ApiError(503, "not_initialized", "Happy Agent is still starting.");
        }
        if (this.#draining) {
            throw new ApiError(
                503,
                "draining",
                "Happy Agent is draining and no longer accepts mutations.",
            );
        }
        if (this.#config.configuration.values.features.workspaces === false) {
            throw new ApiError(503, "unsupported", "Workspaces are disabled in this daemon.");
        }
    }

    #sendError(ctx: Context, response: ServerResponse, error: unknown): void {
        if (response.headersSent) {
            response.end();
            return;
        }
        if (error instanceof ApiError) {
            sendJson(response, error.status, error.body());
            return;
        }
        if (error instanceof SecretApiInputError) {
            sendJson(response, 400, { code: "invalid_request", error: error.message });
            return;
        }
        if (error instanceof BotNotFoundError) {
            sendJson(response, 404, { code: "not_found", error: error.message });
            return;
        }
        if (error instanceof BotConflictError) {
            sendJson(response, 409, { code: "conflict", error: error.message });
            return;
        }
        if (error instanceof ProjectFileError) {
            const code =
                error.code === "missing"
                    ? "not_found"
                    : error.code === "invalid" || error.code === "forbidden"
                      ? "invalid_request"
                      : error.code === "conflict"
                        ? "hash_mismatch"
                        : error.code === "unavailable"
                          ? "not_initialized"
                          : error.code;
            sendJson(response, error.status, {
                error: error.message,
                code,
                ...(error.code === "conflict" ? { hash: error.currentHash } : {}),
            });
            return;
        }
        if (error instanceof TerminalError) {
            const status =
                error.code === "not_found"
                    ? 404
                    : error.code === "invalid"
                      ? 400
                      : error.code === "conflict"
                        ? 409
                        : 503;
            sendJson(response, status, {
                error: error.message,
                code:
                    error.code === "not_found"
                        ? "not_found"
                        : error.code === "invalid"
                          ? "invalid_request"
                          : "conflict",
            });
            return;
        }
        if (error instanceof ProjectRegistrationError) {
            sendJson(response, 400, {
                error: error.message,
                code: "invalid_request",
            });
            return;
        }
        if (error instanceof ProjectAvatarInputError) {
            sendJson(response, 400, {
                error: error.message,
                code: "invalid_request",
            });
            return;
        }
        if (error instanceof BotAvatarInputError) {
            sendJson(response, 400, {
                error: error.message,
                code: "invalid_request",
            });
            return;
        }
        if (error instanceof WorkspaceInputError) {
            sendJson(response, 400, {
                error: error.message,
                code: "invalid_request",
            });
            return;
        }
        if (error instanceof TeamProfileInputError) {
            sendJson(response, 400, {
                error: error.message,
                code: "invalid_request",
            });
            return;
        }
        if (error instanceof TeamAuthenticationError) {
            sendJson(response, 401, {
                error: "Unauthorized",
                code: "unauthorized",
            });
            return;
        }
        // A folder archived while this request was in flight. The request was legitimate when it
        // arrived and the caller simply lost the race, so it reads as a conflict rather than a
        // daemon fault the person can do nothing about.
        if (error instanceof ProjectLifecycleError || error instanceof WorkspaceLifecycleError) {
            sendJson(response, 409, {
                error: error.message,
                code: "conflict",
            });
            return;
        }
        if (error instanceof ProfileVersionConflictError) {
            const profile = profileResource(error.current);
            sendJson(response, 409, {
                error: error.message,
                code: "conflict",
                currentVersion: profile["version"],
                profile,
            });
            return;
        }
        if (error instanceof TeamProfileVersionConflictError) {
            const profile = teamProfileResource(error.current);
            sendJson(response, 409, {
                error: error.message,
                code: "conflict",
                currentVersion: profile["version"],
                profile,
            });
            return;
        }
        ctx.log.error("The Happy Agent API request failed.", {}, error);
        sendJson(response, 500, {
            error: "The request could not be completed.",
            code: "internal",
        });
    }

    #socketRejection(ctx: Context, error: unknown, notFoundMessage: string): ApiSocketRejection {
        if (error instanceof ApiError) {
            return { code: error.code, message: error.message, status: error.status };
        }
        if (error instanceof TerminalError && error.code === "not_found") {
            return { code: "not_found", message: notFoundMessage, status: 404 };
        }
        ctx.log.error("The Happy Agent socket attachment failed.", {}, error);
        return {
            code: "internal",
            message: "The attachment could not be completed.",
            status: 500,
        };
    }
}

function isTeamOnboardingRoute(method: string | undefined, pathname: string): boolean {
    return (
        (method === "GET" && pathname === "/v0/onboarding") ||
        ((method === "GET" || method === "PATCH") && pathname === "/v0/profile")
    );
}

function teamProfileResource(user: TeamUser | undefined): Record<string, unknown> {
    if (user === undefined) {
        return {
            name: null,
            email: null,
            photo: null,
            version: TEAM_ONBOARDING_PROFILE_VERSION,
            updatedAt: 0,
        };
    }
    return {
        name: user.lastName === null ? user.firstName : `${user.firstName} ${user.lastName}`,
        email: user.email,
        photo: user.photo === null ? null : { thumbhash: user.photo.thumbhash },
        version: user.version,
        updatedAt: user.updatedAt,
    };
}

function requestUrl(request: IncomingMessage): URL {
    try {
        return new URL(request.url ?? "/", "http://happy-agent.invalid");
    } catch {
        throw invalidRequest("The request URL is invalid.");
    }
}

function decodePathSegment(value: string, name: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        throw invalidRequest(`The ${name} is not valid URL encoding.`);
    }
}

async function readJson(
    request: IncomingMessage,
    maximum: number = MAX_JSON_BODY_BYTES,
    allowEmpty = false,
): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.byteLength;
        if (bytes > maximum) {
            throw new ApiError(413, "too_large", "The request body is too large.");
        }
        chunks.push(buffer);
    }
    if (bytes === 0 && allowEmpty) return {};
    const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
    if (contentType !== "application/json") {
        throw invalidRequest("The request content type must be application/json.");
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw invalidRequest("The request body must be valid JSON.");
    }
}

async function bodyAs<Schema extends TSchema>(
    request: IncomingMessage,
    schema: Schema,
    name: string,
    maximum: number = MAX_JSON_BODY_BYTES,
): Promise<Static<Schema>> {
    const value = await readJson(request, maximum);
    if (!Value.Check(schema, value)) {
        throw invalidRequest(`The ${name} is invalid.`);
    }
    return value as Static<Schema>;
}

async function optionalBodyAs<Schema extends TSchema>(
    request: IncomingMessage,
    schema: Schema,
    name: string,
    maximum: number,
): Promise<Static<Schema>> {
    const value = await readJson(request, maximum, true);
    if (!Value.Check(schema, value)) throw invalidRequest(`The ${name} is invalid.`);
    return value as Static<Schema>;
}

async function requireEmptyBody(request: IncomingMessage): Promise<void> {
    if ((await readBytes(request, 2 * 1_024)).byteLength !== 0) {
        throw invalidRequest("This request must not have a body.");
    }
}

function queryAs<Schema extends TSchema>(
    value: unknown,
    schema: Schema,
    name: string,
): Static<Schema> {
    if (!Value.Check(schema, value)) {
        throw invalidRequest(`The ${name} query is invalid.`);
    }
    return value as Static<Schema>;
}

async function readBytes(request: IncomingMessage, maximum: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.byteLength;
        if (bytes > maximum) {
            throw new ApiError(413, "too_large", "The request body is too large.");
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

interface ApiUsageTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

interface ApiCatalog {
    readonly models: Record<string, ApiModelDefinition>;
    readonly providers: Record<string, ApiProviderDefinition>;
}

interface ApiModelDefinition {
    readonly name: string;
    readonly contextWindow: number | null;
    readonly efforts: string[];
    readonly defaultEffort: string;
    readonly serviceTiers: string[];
}

interface ApiProviderDefinition {
    readonly type: string;
    readonly enabled: boolean;
    readonly models: ApiProviderModelReference[];
}

interface ApiProviderModelReference {
    readonly id: string;
    readonly enabled: boolean;
    readonly efforts?: string[];
    readonly defaultEffort?: string;
    readonly name?: string;
    readonly serviceTiers?: string[];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mergeUsageBreakdown(
    target: Record<string, Record<string, ApiUsageTokens>>,
    source: Readonly<Record<string, Readonly<Record<string, ApiUsageTokens>>>>,
): void {
    for (const [providerId, models] of Object.entries(source)) {
        const provider = (target[providerId] ??= {});
        for (const [modelId, tokens] of Object.entries(models)) {
            const current = (provider[modelId] ??= {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
            });
            current.input += tokens.input;
            current.output += tokens.output;
            current.cacheRead += tokens.cacheRead;
            current.cacheWrite += tokens.cacheWrite;
        }
    }
}

/** @internal API event journal that inherits only the current async mutation scope. */
export class MutationAwareApiEventJournal extends ApiEventJournal {
    readonly #mutationIds: AsyncLocalStorage<string>;

    constructor(mutationIds: AsyncLocalStorage<string>) {
        super();
        this.#mutationIds = mutationIds;
    }

    override append(type: string, payload: unknown, occurredAt?: number): ApiEvent {
        const mutationId = this.#mutationIds.getStore();
        if (
            mutationId === undefined ||
            payload === null ||
            typeof payload !== "object" ||
            Array.isArray(payload)
        ) {
            return super.append(type, payload, occurredAt);
        }
        return super.append(
            type,
            { ...(payload as Record<string, unknown>), mutationId },
            occurredAt,
        );
    }

    /** Append a background invalidation without inheriting a mutation that scheduled it. */
    appendOutsideMutation(type: string, payload: unknown, occurredAt?: number): ApiEvent {
        return this.#mutationIds.exit(() => this.append(type, payload, occurredAt));
    }
}

function requireIfMatch(
    request: IncomingMessage,
    currentVersion: unknown,
    details: Readonly<Record<string, unknown>>,
): string {
    const value = request.headers["if-match"];
    if (
        typeof value !== "string" ||
        !Value.Check(eventIdSchema, value) ||
        typeof currentVersion !== "string"
    ) {
        throw invalidRequest("A valid If-Match resource version is required.");
    }
    if (value !== currentVersion) {
        throw new ApiError(409, "conflict", "The resource has changed.", details);
    }
    return value;
}

async function writeOwnerOnlyDocument(path: string, content: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
}

function setCommonHeaders(response: ServerResponse): void {
    response.setHeader("cache-control", "no-store");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(encoded),
        "content-type": "application/json; charset=utf-8",
    });
    response.end(encoded);
}

function writeSocketError(
    socket: Socket,
    status: number,
    message: string,
    code: ApiErrorCode = socketErrorCode(status),
): void {
    const body = JSON.stringify({ error: message, code });
    socket.end(
        `HTTP/1.1 ${status} ${httpStatusText(status)}\r\n` +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Cache-Control: no-store\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "Connection: close\r\n\r\n" +
            body,
    );
}

function socketErrorCode(
    status: number,
): "internal" | "not_found" | "not_initialized" | "unauthorized" {
    if (status === 401) return "unauthorized";
    if (status === 404) return "not_found";
    if (status === 503) return "not_initialized";
    return "internal";
}

function httpStatusText(status: number): string {
    if (status === 400) return "Bad Request";
    if (status === 401) return "Unauthorized";
    if (status === 404) return "Not Found";
    if (status === 409) return "Conflict";
    if (status === 413) return "Content Too Large";
    if (status === 501) return "Not Implemented";
    if (status === 503) return "Service Unavailable";
    return "Internal Server Error";
}

function sseEventFrame(event: ApiEvent): string {
    return `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function optionalCursor(value: string | null | undefined): string | undefined {
    if (value === null || value === undefined || value === "") return undefined;
    if (!Value.Check(eventIdSchema, value)) throw invalidRequest("The event cursor is invalid.");
    return value;
}

function optionalApiId(value: string | null | undefined, resourceName: string): string | undefined {
    if (value === null || value === undefined || value === "") return undefined;
    if (!Value.Check(apiIdSchema, value)) {
        throw invalidRequest(`The ${resourceName} identifier is invalid.`);
    }
    return value;
}

function integerParameter(
    value: string | null,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    if (value === null) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw invalidRequest("A numeric query parameter is invalid.");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw invalidRequest("A numeric query parameter is outside its allowed range.");
    }
    return parsed;
}

function assertOnlyQueryParameters(url: URL, allowed: readonly string[]): void {
    const names = new Set(allowed);
    for (const name of url.searchParams.keys()) {
        if (!names.has(name)) throw invalidRequest(`The ${name} query parameter is not supported.`);
    }
}

function secretPathId(value: string, name: string): string {
    const decoded = decodePathSegment(value, name);
    if (!Value.Check(secretApiIdSchema, decoded)) throw invalidRequest(`The ${name} is invalid.`);
    return decoded;
}

function secretTarget(type: string, id: string): SecretApiTarget {
    const target = { type, id };
    if (
        (type !== "project" && type !== "workspace" && type !== "agent") ||
        !Value.Check(cuid2Schema, id)
    ) {
        throw invalidRequest("The secret attachment target is invalid.");
    }
    return target as SecretApiTarget;
}

function secretMutationError(error: unknown): Error {
    if (error instanceof SecretApiConflictError) {
        const details =
            error.current === undefined
                ? {}
                : { currentVersion: error.current.version, secret: error.current };
        return new ApiError(409, "conflict", error.message, details);
    }
    return error instanceof Error ? error : new Error("The secret mutation failed.");
}

function secretChanges(
    previous: SecretApiRecord,
    current: SecretApiRecord,
): Record<string, unknown> {
    const changes: Record<string, unknown> = { updatedAt: current.updatedAt };
    if (previous.description !== current.description) changes["description"] = current.description;
    if (previous.availableToAgents !== current.availableToAgents) {
        changes["availableToAgents"] = current.availableToAgents;
    }
    if (!sameStrings(previous.environmentVariables, current.environmentVariables)) {
        changes["environmentVariables"] = current.environmentVariables;
    }
    return changes;
}

function booleanParameter(value: string | null, fallback: boolean): boolean {
    if (value === null) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw invalidRequest("A boolean query parameter must be true or false.");
}

function boundedAdd(set: Set<string>, value: string, maximum: number): void {
    set.add(value);
    while (set.size > maximum) {
        const oldest = set.values().next().value as string | undefined;
        if (oldest === undefined) return;
        set.delete(oldest);
    }
}

function pendingMessageResource(pending: HistoryPendingMessage): Record<string, unknown> {
    return {
        ...messageResource({
            recordId: pending.id,
            role: "user",
            blocks: pending.blocks,
            at: pending.createdAt,
            ...(pending.clientMetadata === undefined
                ? {}
                : { clientMetadata: pending.clientMetadata }),
            delivery: pending.delivery,
            mode: pending.mode,
            profile: pending.profile ?? null,
        }),
        status: "pending",
        runId: null,
    };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function agentMetadataChanges(
    update: Readonly<Record<string, unknown>>,
    occurredAt: number,
    canSendMessages?: boolean,
): Record<string, unknown> {
    const changes: Record<string, unknown> = { updatedAt: occurredAt };
    for (const key of [
        "archivedAt",
        "orderKey",
        "pendingQuestionId",
        "processes",
        "subagents",
        "title",
        "unread",
    ]) {
        if (Object.hasOwn(update, key)) changes[key] = update[key];
    }
    if (Object.hasOwn(update, "title")) {
        changes["titleStatus"] = typeof update["title"] === "string" ? "ready" : "idle";
    }
    if (canSendMessages !== undefined) changes["canSendMessages"] = canSendMessages;
    return changes;
}

function statusForAgentEvent(
    eventType: string,
    payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
    if (eventType === "tool.started") return "running_tools";
    if (eventType === "tool.completed") return "working";
    if (eventType === "inference.completed" || eventType === "turn.completed") {
        return "working";
    }
    if (eventType !== "provider.event") return undefined;
    const rigEvent = recordValue(payload?.["rigEvent"]);
    const type = stringValue(rigEvent?.["type"]);
    if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
        return "generating_tools";
    }
    if (
        type === "tool_execution_start" ||
        type === "tool_execution_progress" ||
        type === "tool_execution_end"
    ) {
        return "running_tools";
    }
    if (type === "thinking_start" || type === "thinking_delta") return "thinking";
    if (type === "text_start" || type === "text_delta") return "working";
    return undefined;
}

function startedRunResource(
    run: Pick<HistoryRunState, "id" | "startedAt">,
): Record<string, unknown> {
    return {
        id: run.id,
        status: "running",
        reason: null,
        startedAt: run.startedAt,
        endedAt: null,
        usage: {},
        costUsd: null,
    };
}

function apiAssistantMessageId(runId: string): string {
    return `a${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
}

export function apiAssistantIdentityForProviderEvent(
    eventType: string,
    candidateRunId: string,
    candidateMessageId: string | undefined,
    streaming: { readonly messageId: string; readonly runId: string } | undefined,
): { readonly messageId: string; readonly runId: string } {
    if (eventType !== "block_start" && streaming !== undefined) {
        return { messageId: streaming.messageId, runId: streaming.runId };
    }
    return {
        messageId: candidateMessageId ?? apiAssistantMessageId(candidateRunId),
        runId: candidateRunId,
    };
}

function resourceChanges(
    previous: Readonly<Record<string, unknown>>,
    current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
        if (key === "version" || key === "agents") continue;
        if (!sameJsonValue(previous[key], value)) changes[key] = value;
    }
    if (Object.hasOwn(current, "updatedAt")) changes["updatedAt"] = current["updatedAt"];
    return changes;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function parseCloudSocialMutation(
    method: string | undefined,
    pathname: string,
): { readonly mutation: CloudSocialMutationKind; readonly username: string } | undefined {
    if (method !== "DELETE" && method !== "POST" && method !== "PUT") return undefined;
    const request = /^\/v0\/cloud\/social\/requests\/([^/]+)$/.exec(pathname);
    const decision = /^\/v0\/cloud\/social\/requests\/([^/]+)\/(approve|reject)$/.exec(pathname);
    const blocked = /^\/v0\/cloud\/social\/blocked\/([^/]+)$/.exec(pathname);
    let mutation: CloudSocialMutationKind | undefined;
    let encodedUsername: string | undefined;
    if (request !== null && method === "PUT") {
        mutation = "send-request";
        encodedUsername = request[1];
    } else if (request !== null && method === "DELETE") {
        mutation = "revoke-request";
        encodedUsername = request[1];
    } else if (decision !== null && method === "POST") {
        mutation = decision[2] === "approve" ? "approve-request" : "reject-request";
        encodedUsername = decision[1];
    } else if (blocked !== null && method === "PUT") {
        mutation = "block";
        encodedUsername = blocked[1];
    } else if (blocked !== null && method === "DELETE") {
        mutation = "unblock";
        encodedUsername = blocked[1];
    } else if (pathname.startsWith("/v0/cloud/social/")) {
        throw invalidRequest("The Cloud friends route is invalid.");
    } else return undefined;
    try {
        return { mutation, username: decodeURIComponent(encodedUsername!) };
    } catch {
        throw invalidRequest("The Cloud username is invalid.");
    }
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
