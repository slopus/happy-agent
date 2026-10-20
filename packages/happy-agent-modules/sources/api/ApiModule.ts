import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as inspector from "node:inspector";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import {
    BridgeError,
    BridgesModule,
    type BridgeAdmission,
    type BridgeWebSocket,
    type BridgeWebSocketBinding,
} from "../bridges/index.js";
import { ConnectionsModule, RemoteConnectionError } from "../connections/index.js";
import { LocalExecutionDisabledError, RunnersModule } from "../runners/index.js";
import { GlobalSkillsModule, GlobalSkillsError } from "../skills/index.js";
import { teamDraftMigration } from "./persistence/migrations/001-team-drafts.js";
import {
    LiveModule,
    LiveError,
    type LiveControlSocket,
    type LiveControlBinding,
} from "../live/index.js";

import { createId } from "@paralleldrive/cuid2";
import {
    closeWorkspaceBridgeRequestSchema,
    createSurfaceRequestSchema,
    updateSurfaceRequestSchema,
    surfaceIdSchema,
    surfaceMemberRequestSchema,
    reorderSurfaceRequestSchema,
    ensureSurfaceChatRequestSchema,
    createTodoRequestSchema,
    updateTodoRequestSchema,
    sendSurfaceDocumentUpdateRequestSchema,
    surfaceDocumentSubscriptionRequestSchema,
    sendSurfaceDocumentPresenceRequestSchema,
    reorderTodoRequestSchema,
    todoMutationRequestSchema,
    todoListScopeSchema,
    createCalendarEventRequestSchema,
    updateCalendarEventRequestSchema,
    calendarEventMutationRequestSchema,
    WORKSPACE_BRIDGE_MAX_BINARY_MESSAGE_BYTES,
    createLiveSessionRequestSchema,
    closeLiveSessionRequestSchema,
    liveDesktopIdSchema,
    createSecretRequestSchema,
    deleteSecretRequestSchema,
    secretAttachmentMutationRequestSchema,
    updateSecretRequestSchema,
    archiveBotRequestSchema,
    archiveTaskRequestSchema,
    createArtifactRequestSchema,
    createBotRequestSchema,
    createTaskRequestSchema,
    renameTaskRequestSchema,
    joinTaskRequestSchema,
    leaveTaskRequestSchema,
    reorderTaskRequestSchema,
    taskListScopeSchema,
    unarchiveTaskRequestSchema,
    renameBotRequestSchema,
    reorderBotRequestSchema,
    reorderConnectionRequestSchema,
    unarchiveBotRequestSchema,
    configPatchSchema,
    deleteArtifactRequestSchema,
    nodeConfigPatchSchema,
    voiceConfigPatchSchema,
    updateArtifactRequestSchema,
    providerVerificationRequestSchema,
    providerUsageRefreshRequestSchema,
    userIdsSchema,
    networkIdSchema,
    skillPageQuerySchema,
    updateGlobalSkillRequestSchema,
    type ArtifactFileInput as ArtifactRequestFile,
    type ArtifactSourceInput as ArtifactRequestSource,
    type AuthenticationChallenge,
    type AuthenticationResponse,
    type DrainWaitingFor,
    type MessageMode,
    type ServiceTierOption,
    agentWaitSchema,
} from "@slopus/happy-agent-client";
import {
    cuid2Schema,
    currentAgentEnvironment,
    type AgentConfig,
    type AgentBaseMessageOptions,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    withAgentConfig,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, shutdown, type Context } from "@steve.kite/stdlib";
import {
    createHostNetwork,
    MAX_RUNNER_FRAME_BYTES,
    RunnerUnavailableError,
    type ComputeNetwork,
} from "@slopus/happy-agent-compute";
import { WebSocketServer } from "ws";

import { AbortModule } from "../abort/index.js";
import { SurfacesModule, SurfaceError } from "../surfaces/index.js";
import type { SchedulingModule } from "../scheduling/index.js";
import {
    ArtifactConflictError,
    ArtifactInputError,
    ArtifactNotFoundError,
    ArtifactsModule,
    ArtifactTooLargeError,
    DEFAULT_ARTIFACT_PAGE_SIZE,
    MAX_ARTIFACT_PAGE_SIZE,
    type ArtifactAuthor,
    type ArtifactEvent,
    type ArtifactFileInput,
    type ArtifactListQuery,
    type ArtifactSource,
    type ArtifactSourceInput,
} from "../artifacts/index.js";
import { ArtifactDataModule } from "../artifactData/index.js";
import {
    EXPORTED_BOT_MAX_FRAME_BYTES,
    type ExportedBotsModule,
    type ExportedBotSocket,
    type PreparedExportedBotSocket,
} from "../exportedBots/index.js";
import { ChatMediaModule } from "../chatMedia/index.js";
import {
    BotAvatarInputError,
    BotConflictError,
    BotInputError,
    BotNotFoundError,
    BotsModule,
    type BotEvent,
    type BotRecord,
} from "../bots/index.js";
import {
    STANDALONE_TASK_MEMBER,
    TaskConflictError,
    TaskInputError,
    TaskNotFoundError,
    TasksModule,
    type TaskEvent,
    type TaskMemberId,
    type TaskRecord,
} from "../tasks/index.js";
import {
    CompactionAgentBusyError,
    CompactionAlreadyRunningError,
    CompactionsModule,
    compactionSchema,
    type Compaction,
} from "../compactions/index.js";
import { ComputeModule, type ComputeProcessEvent } from "../compute/index.js";
import { ConfigModule, VoiceSettingsError } from "../config/index.js";
import { NodeModule } from "../node/index.js";
import { CloudModule, CloudOperationError } from "../cloud/index.js";
import {
    EventsModule,
    eventIdSchema,
    type AgentEvent,
    type LatestAgentEvent,
} from "../events/index.js";
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
import { HappyIntegrationRequestError, HappyModule } from "../happy/index.js";
import {
    HistoryModule,
    type HistoryMessage,
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
    type ProjectCompute,
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
    isTeamGuest,
    teamUser,
    TEAM_ONBOARDING_PROFILE_VERSION,
    TeamAuthenticationError,
    TeamModule,
    TeamProfileInputError,
    TeamProfileVersionConflictError,
    type TeamUser,
} from "../team/index.js";
import {
    MobileConnectorError,
    MobileConnectorModule,
    STANDALONE_MOBILE_OWNER,
    type MobileConnectorSnapshot,
    type MobileCredential,
} from "../mobileConnector/index.js";
import { isMobileTransport, mobileDevice, withMobileDevice } from "./impl/apiMobileTransport.js";
import {
    createNodeBinaryWebSocket,
    createSseWriter,
    type BinaryWebSocket,
    type SseWriter,
    WebSocketDuplex,
} from "../transport/index.js";
import { UsageModule, type UsageCurrentContext, type UsageRunSummary } from "../usage/index.js";
import { UserInputModule, type UserInputEvent } from "../userInput/index.js";
import {
    STANDALONE_USER_SETTINGS_OWNER,
    UserSettingsError,
    UserSettingsModule,
} from "../userSettings/index.js";
import {
    WorkspaceInputError,
    WorkspaceLifecycleError,
    WorkspacesModule,
    type Workspace,
    type WorkspaceEvent,
} from "../workspaces/index.js";
import { ApiArtifactData, ARTIFACT_DATA_ROUTE } from "./ApiArtifactData.js";
import { ARTIFACT_FILE_ROUTE, artifactFileRequest, sendArtifactFile } from "./ApiArtifactFiles.js";
import { sendStoredFile } from "./sendStoredFile.js";
import { ApiError, invalidRequest, notFound, unsupported, type ApiErrorCode } from "./ApiError.js";
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
    agentArchivedAt,
    agentResource,
    agentModeFromConfig,
    apiResourceVersion,
    artifactResource,
    artifactUploadResource,
    artifactVersionResource,
    botResource,
    botWorkspaceResource,
    profileResource,
    projectResource,
    questionResource,
    rootWorkspaceResource,
    taskMembershipResource,
    taskResource,
    taskWorkspaceResource,
    surfaceWorkspaceResource,
    terminalResource,
    workspaceResource,
} from "./ApiResourceProjection.js";
import {
    abortBodySchema,
    agentCreateBodySchema,
    apiIdSchema,
    cloudMutationRequestSchema,
    cloudOrganizationSchema,
    completeCloudAuthorizationRequestSchema,
    createCloudOrganizationRequestSchema,
    documentBodySchema,
    draftBodySchema,
    emptyMutationBodySchema,
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
    securityDocumentBodySchema,
    startCloudAuthorizationRequestSchema,
    terminalCreateBodySchema,
    terminalResizeBodySchema,
    userSettingBodySchema,
    mobilePairingBodySchema,
    workspaceCreateBodySchema,
} from "./ApiSchemas.js";
import { WorkspaceProxy, type WorkspaceProxyTcpHop } from "./WorkspaceProxy.js";
import { requestedAgentMode } from "./requestedAgentMode.js";
import { describeDrainBlockers, type DrainBlocker } from "./impl/describeDrainBlockers.js";
import {
    projectEventDiagnostics,
    projectMessageDiagnostics,
} from "./projectCredentialDiagnostics.js";
import { SubtaskInputError, SubtasksModule } from "../subtasks/index.js";

const API_PROTOCOL_VERSION = 29;

/**
 * How many archived agents the desktop bootstrap carries. Recent history is what the desktop
 * shows on launch; everything older stays readable by ID, and the bound keeps the composed
 * snapshot from growing with every chat a user has ever closed.
 */
const DESKTOP_BOOTSTRAP_ARCHIVED_AGENT_LIMIT = 200;

/** An archived agent met while building an owner's series, kept for the bootstrap history. */
interface ArchivedOwnerAgent {
    readonly agentId: string;
    readonly ownerId: string;
    readonly orderKey: string | null;
    readonly config: AgentConfig;
    readonly archivedAt: number;
}
const MAX_JSON_BODY_BYTES = 48 * 1024 * 1024;
// One setting write carries a value of at most 64 KiB as compact JSON. A body sixteen times that
// leaves room for any reasonable spacing and escaping, and anything larger is refused unparsed.
const MAX_USER_SETTING_BODY_BYTES = 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const MAX_TERMINAL_WIRE_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;
const MAX_ANNOUNCED_PENDING_MESSAGES = 10_000;
const MAX_ANNOUNCED_AGENT_CREATIONS = 10_000;
const MAX_ANNOUNCED_TERMINAL_RUNS = 10_000;
const MAX_ANNOUNCED_EXECUTION_CONFIGURATIONS = 512 * 64;
const DRAIN_MUTATION_LOG_INTERVAL_MS = 5_000;
/** How often a drain looks at what still holds it open; it logs only on change or every 5s. */
const DRAIN_REPORT_TICK_MS = 1_000;
const DRAIN_REPORT_INTERVAL_MS = 5_000;
/** What `artifact.updated` and `artifact.deleted` always carry in `changes`. */
const ARTIFACT_UPDATED_FIELDS = [
    "latestVersion",
    "latestMajor",
    "latestMinor",
    "title",
    "entry",
    "fileCount",
    "size",
    "background",
    "display",
    "updatedBy",
    "updatedSource",
    "updatedAt",
] as const;
const ARTIFACT_DELETED_FIELDS = [
    "status",
    "deletedBy",
    "deletedSource",
    "deletedAt",
    "updatedBy",
    "updatedSource",
    "updatedAt",
] as const;

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
    /** How to sign in, carried by a `401` when the deployment offers a way. */
    readonly authentication?: AuthenticationChallenge;
    readonly code: ApiErrorCode;
    /** Further fields of the error body, such as an unavailable bridge's `reason`. */
    readonly details?: Readonly<Record<string, unknown>>;
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

export type PreparedLiveSocket =
    | { readonly handled: false }
    | { readonly handled: true; readonly rejection: ApiSocketRejection }
    | {
          readonly handled: true;
          readonly attach: (socket: LiveControlSocket) => LiveControlBinding;
          readonly failed: () => void;
      };

/**
 * A bridge WebSocket: a USB device, a port bridge's control channel, or one of its connections.
 * `failed` must be called when an admitted upgrade does not complete, to release its reservation.
 */
export type PreparedBridgeSocket =
    | { readonly handled: false }
    | { readonly handled: true; readonly rejection: ApiSocketRejection }
    | ({ readonly handled: true } & BridgeAdmission);

/** `GET /v0/runners/connect`, admitted by a runner token and nothing else. */
export type PreparedRunnerSocket =
    | { readonly handled: false }
    | { readonly handled: true; readonly rejection: ApiSocketRejection }
    | {
          readonly attach: (webSocket: BinaryWebSocket) => void;
          readonly handled: true;
      };

export type PreparedWorkspaceProxySocket =
    | { readonly handled: false }
    | { readonly handled: true; readonly rejection: ApiSocketRejection }
    | {
          readonly handled: true;
          /**
           * The one-time key the attachment presents to the workspace proxy, naming the network
           * every one of its connections is opened from.
           */
          readonly route: string;
          /**
           * Aborts when the credential that opened this attachment is withdrawn, such as a
           * removed phone's. A transport that keeps the tunnel itself closes it then.
           */
          readonly revoked?: AbortSignal;
      };

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

/** Work one agent is doing right now, named for the drain log and never shown to clients. */
export interface ApiDrainWork {
    readonly agentId: string;
    /** A running tool's name, or the agent's stage when no tool is running. */
    readonly category: string;
    readonly startedAt: number;
}

export interface ApiDrainSource {
    /** Publish the component's sticky drain and resolve when it reaches its safe edge. */
    readonly start: () => Promise<void>;
    /** Read the component's current structured progress without waiting. */
    readonly progress: () => ApiDrainProgress;
    /** What the agents in `progress` are doing, so the drain log can say what it waits for. */
    readonly work?: () => readonly ApiDrainWork[];
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
    readonly migrations = [teamDraftMigration];

    readonly #abort: AbortModule;
    readonly #config: ConfigModule;
    readonly #events: EventsModule;
    readonly #scheduling: SchedulingModule | undefined;
    readonly #cloud: CloudModule;
    readonly #compactions: CompactionsModule;
    readonly #bots: BotsModule;
    readonly #subtasks: SubtasksModule | undefined;
    readonly #tasks: TasksModule | undefined;
    readonly #artifacts: ArtifactsModule | undefined;
    readonly #artifactData: ApiArtifactData | undefined;
    readonly #chatMedia: ChatMediaModule | undefined;
    readonly #exportedBots: ExportedBotsModule | undefined;
    readonly #userSettings: UserSettingsModule | undefined;
    readonly #surfaces: SurfacesModule | undefined;
    readonly #mobileConnector: MobileConnectorModule | undefined;
    /** The revocation signals each mobile connection already closes on. */
    readonly #mobileConnections = new WeakMap<MobileConnection, Set<AbortSignal>>();
    readonly #mobileClosers = new WeakMap<MobileConnection, () => void>();
    readonly #live: LiveModule | undefined;
    readonly #runners: RunnersModule | undefined;
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
    readonly #connections: ConnectionsModule;
    readonly #node: NodeModule;
    readonly #globalSkills: GlobalSkillsModule | undefined;
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
    /** A runner frame may carry a whole file, so runner messages get the protocol's own bound. */
    readonly #runnerWebSockets = new WebSocketServer({
        maxPayload: MAX_RUNNER_FRAME_BYTES,
        noServer: true,
        perMessageDeflate: false,
    });
    readonly #liveWebSockets = new WebSocketServer({
        maxPayload: 256 * 1024,
        noServer: true,
        perMessageDeflate: false,
    });
    readonly #bridgeWebSockets = new WebSocketServer({
        maxPayload: WORKSPACE_BRIDGE_MAX_BINARY_MESSAGE_BYTES,
        noServer: true,
        perMessageDeflate: false,
    });
    readonly #bridges: BridgesModule | undefined;
    readonly #exportedBotWebSockets = new WebSocketServer({
        maxPayload: EXPORTED_BOT_MAX_FRAME_BYTES,
        noServer: true,
        perMessageDeflate: false,
    });
    readonly #unsubscribe: (() => void)[] = [];
    readonly #streams = new Set<SseWriter>();
    /** Event streams that live document frames can address, with the person who opened each. */
    readonly #eventStreams = new Map<string, { writer: SseWriter; userId: string | undefined }>();
    readonly #shutdownListeners = new Set<() => void | Promise<void>>();
    readonly #drainSources = new Map<string, ApiDrainSource>();
    readonly #runningDrains = new Map<string, ApiRunningDrain>();
    /** HTTP mutations admitted before draining published its read-only boundary. */
    readonly #apiMutations = new Map<symbol, ApiAdmittedMutation>();
    readonly #announcedPendingMessages = new Set<string>();
    readonly #apiPendingMessageIds = new Set<string>();
    readonly #announcedExecutionConfigurations = new Map<string, string>();
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
    /** The drain's own log of what holds it open, from its start until it is drained. */
    #drainReport:
        | {
              readonly startedAt: number;
              readonly timer: NodeJS.Timeout;
              key: string | undefined;
              loggedAt: number;
          }
        | undefined;
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
        connections: ConnectionsModule,
        node: NodeModule,
        globalSkills?: GlobalSkillsModule,
        subtasks?: SubtasksModule,
        live?: LiveModule,
        runners?: RunnersModule,
        tasks?: TasksModule,
        artifacts?: ArtifactsModule,
        artifactData?: ArtifactDataModule,
        chatMedia?: ChatMediaModule,
        bridges?: BridgesModule,
        exportedBots?: ExportedBotsModule,
        scheduling?: SchedulingModule,
        userSettings?: UserSettingsModule,
        surfaces?: SurfacesModule,
        mobileConnector?: MobileConnectorModule,
    ) {
        this.#abort = abort;
        this.#config = config;
        this.#events = events;
        this.#scheduling = scheduling;
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
        this.#connections = connections;
        this.#node = node;
        this.#globalSkills = globalSkills;
        this.#subtasks = subtasks;
        this.#live = live;
        this.#runners = runners;
        this.#tasks = tasks;
        this.#artifacts = artifacts;
        this.#artifactData =
            artifactData === undefined
                ? undefined
                : new ApiArtifactData(artifactData, this.#streams);
        this.#chatMedia = chatMedia;
        this.#bridges = bridges;
        this.#exportedBots = exportedBots;
        this.#userSettings = userSettings;
        this.#surfaces = surfaces;
        this.#mobileConnector = mobileConnector;
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
                this.#config.configuration.values?.api?.token,
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

    /** Enter the same read-only drain boundary for local OS control and HTTP callers. */
    beginDrain(ctx: Context): void {
        if (this.#closed || !this.#ready) throw new Error("The daemon is not ready to drain.");
        if (this.#drainSources.size === 0) throw new Error("Daemon draining is not enabled.");
        this.#beginDrain(ctx);
    }

    /** The same bounded completion barrier exposed by authenticated health. */
    drainProgress(ctx: Context): readonly DrainWaitingFor[] {
        return this.#drainWaitingFor(ctx);
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
        if (this.#drainReport !== undefined) clearInterval(this.#drainReport.timer);
        this.#drainReport = undefined;
        this.#drainSources.clear();
        this.#runningDrains.clear();
        this.#apiMutations.clear();
        const streamDone = [...this.#streams].map((stream) => stream.done);
        for (const stream of this.#streams) stream.close();
        await Promise.all(streamDone);
        this.#streams.clear();
        this.#announcedPendingMessages.clear();
        this.#apiPendingMessageIds.clear();
        this.#announcedExecutionConfigurations.clear();
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
        for (const client of this.#liveWebSockets.clients) client.terminate();
        this.#liveWebSockets.close();
        for (const client of this.#bridgeWebSockets.clients) client.terminate();
        this.#bridgeWebSockets.close();
        for (const client of this.#exportedBotWebSockets.clients) client.terminate();
        this.#exportedBotWebSockets.close();
        this.#runnerWebSockets.close();
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
            if (isMobileTransport(ctx)) {
                // Before anything else: only a phone's own credentials reach anything here.
                const admitted = await this.#admitMobile(
                    ctx,
                    request.headers.authorization,
                    request.socket,
                );
                if (admitted.kind !== "device") {
                    await this.#handleMobileHandshake(ctx, admitted, request, response);
                    return;
                }
                if (isDeviceForbiddenPath(requestUrl(request).pathname)) {
                    throw new ApiError(403, "forbidden", "Phones cannot use this endpoint.");
                }
                ctx = admitted.ctx;
            }
            if (request.method === "GET" && requestUrl(request).pathname === "/v0/authentication") {
                sendJson(
                    response,
                    200,
                    await this.#authenticationStatus(ctx, request.headers.authorization),
                );
                return;
            }
            ctx = await this.#authenticate(ctx, request.headers.authorization);
            const url = requestUrl(request);
            if (request.method === "GET" && url.pathname === "/v0/health") {
                sendJson(response, 200, this.#health(ctx));
                return;
            }
            if (!this.#ready) {
                throw new ApiError(503, "not_initialized", "Happy Agent is still starting.");
            }
            if (this.#team.enabled && isCloudOrganizationRoute(url.pathname)) {
                throw unsupported("Cloud organizations are unavailable in team mode.");
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
            if (
                url.pathname === "/v0/live/sessions" ||
                url.pathname.startsWith("/v0/live/sessions/")
            ) {
                if (this.#live === undefined)
                    throw unsupported("Desktop voice control is unavailable.");
                const ownerId = teamUser(ctx)?.id ?? "standalone";
                if (request.method === "POST" && url.pathname === "/v0/live/sessions") {
                    const body = await bodyAs(
                        request,
                        createLiveSessionRequestSchema,
                        "voice request",
                        640 * 1024,
                    );
                    const reserved = await this.#live.reserve(ctx, ownerId, body);
                    const sdp = await reserved.allocated;
                    const session = await this.#live.get(ctx, ownerId, reserved.session.id);
                    if (session.status !== "starting" && session.status !== "active")
                        throw new LiveError(
                            503,
                            "live_unavailable",
                            "Voice ended before startup completed.",
                            session,
                        );
                    sendJson(response, 201, {
                        session,
                        transport: { type: "webrtc", sdp },
                    });
                    return;
                }
                const match = /^\/v0\/live\/sessions\/([a-z][a-z0-9]{1,31})(\/close)?$/.exec(
                    url.pathname,
                );
                if (match !== null && request.method === "GET" && match[2] === undefined) {
                    sendJson(response, 200, {
                        session: await this.#live.get(ctx, ownerId, match[1]!),
                    });
                    return;
                }
                if (match !== null && request.method === "POST" && match[2] === "/close") {
                    const body = await bodyAs(
                        request,
                        closeLiveSessionRequestSchema,
                        "voice close request",
                        4096,
                    );
                    sendJson(response, 200, {
                        session: await this.#live.close(ctx, ownerId, match[1]!, body.mutationId),
                    });
                    return;
                }
                throw notFound("The requested voice endpoint does not exist.");
            }
            if (url.pathname === "/v0/skills" || url.pathname.startsWith("/v0/skills/")) {
                const skills = this.#globalSkills;
                if (skills === undefined) throw notFound("Global skill management is unavailable.");
                const query = {
                    ...(url.searchParams.has("limit")
                        ? { limit: Number(url.searchParams.get("limit")) }
                        : {}),
                    ...(url.searchParams.has("pageCursor")
                        ? { pageCursor: url.searchParams.get("pageCursor")! }
                        : {}),
                };
                if (!Value.Check(skillPageQuerySchema, query))
                    throw invalidRequest("The skill page query is invalid.");
                if (request.method === "GET" && url.pathname === "/v0/skills") {
                    const cursor = this.#journal.cursor();
                    sendJson(response, 200, { ...(await skills.list(ctx, query)), cursor });
                    return;
                }
                const match = /^\/v0\/skills\/([a-z][a-z0-9]*)(?:\/(files|file))?$/.exec(
                    url.pathname,
                );
                if (match === null) throw notFound("The requested skill endpoint does not exist.");
                const id = match[1]!;
                if (request.method === "GET" && match[2] === undefined) {
                    sendJson(response, 200, await skills.read(ctx, id));
                    return;
                }
                if (request.method === "GET" && match[2] === "files") {
                    sendJson(response, 200, await skills.files(ctx, id, query));
                    return;
                }
                if (request.method === "GET" && match[2] === "file") {
                    const paths = url.searchParams.getAll("path");
                    if (paths.length !== 1)
                        throw invalidRequest("Provide one skill-relative file path.");
                    const bytes = await skills.readFile(ctx, id, paths[0]!);
                    response.writeHead(200, {
                        "content-type": "application/octet-stream",
                        "content-length": bytes.length,
                        "cache-control": "no-store",
                    });
                    response.end(bytes);
                    return;
                }
                if (request.method === "PATCH" && match[2] === undefined) {
                    if (this.#team.enabled && teamUser(ctx)?.isOwner !== true)
                        throw new ApiError(
                            403,
                            "forbidden",
                            "Only the team owner can enable or disable global skills.",
                        );
                    const body = await bodyAs(
                        request,
                        updateGlobalSkillRequestSchema,
                        "skill enablement",
                    );
                    const expectedVersion = request.headers["if-match"];
                    if (!Value.Check(eventIdSchema, expectedVersion))
                        throw invalidRequest("A valid If-Match resource version is required.");
                    sendJson(response, 200, {
                        skill: await skills.setEnabled(
                            ctx,
                            id,
                            body.enabled,
                            expectedVersion,
                            body.mutationId,
                        ),
                    });
                    return;
                }
                throw notFound("The requested skill endpoint does not exist.");
            }
            if (request.method === "GET" && url.pathname === "/v0/users") {
                // Standalone has one person, described by the profile; only guests are users.
                const parameters = url.searchParams.getAll("ids");
                const ids =
                    parameters.length === 0 || parameters[0] === ""
                        ? []
                        : parameters[0]!.split(",");
                if (parameters.length > 1 || !Value.Check(userIdsSchema, ids)) {
                    throw invalidRequest("Provide one list of at most 100 valid Happy user IDs.");
                }
                const users = (await this.#team.getUsers(ctx, ids)).filter(
                    (user) => this.#team.enabled || isTeamGuest(user),
                );
                sendJson(response, 200, {
                    users: users.map((user) => ({
                        id: user.id,
                        name:
                            user.lastName === null
                                ? user.firstName
                                : `${user.firstName} ${user.lastName}`,
                        photo: user.photo === null ? null : { thumbhash: user.photo.thumbhash },
                        version: user.version,
                        updatedAt: user.updatedAt,
                        kind: isTeamGuest(user) ? "guest" : "member",
                        canLogIn: !isTeamGuest(user),
                    })),
                });
                return;
            }
            const userPhoto = /^\/v0\/users\/([^/]+)\/photo$/.exec(url.pathname);
            if (request.method === "GET" && userPhoto !== null) {
                const userId = decodeURIComponent(userPhoto[1] as string);
                if (!Value.Check(cuid2Schema, userId)) {
                    throw invalidRequest("Provide a valid Happy user ID.");
                }
                if (!this.#team.enabled) {
                    // Standalone users are guests, and guests have no photo.
                    const user = await this.#team.getUser(ctx, userId);
                    if (user === undefined || !isTeamGuest(user)) {
                        throw notFound("The user does not exist.");
                    }
                }
                const photo = await this.#team.getUserPhoto(ctx, userId);
                if (photo === undefined) throw notFound("The user has no photo.");
                setImageCacheHeaders(response);
                if (request.headers["if-none-match"] === photo.etag) {
                    response.writeHead(304, { etag: photo.etag });
                    response.end();
                    return;
                }
                response.writeHead(200, {
                    "content-length": photo.bytes.byteLength,
                    "content-type": photo.contentType,
                    etag: photo.etag,
                });
                response.end(Buffer.from(photo.bytes));
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/connections") {
                sendJson(response, 200, await this.#connections.getSnapshot(ctx));
                return;
            }
            if (
                request.method === "GET" &&
                url.pathname === "/v0/runners" &&
                this.#runners !== undefined
            ) {
                sendJson(response, 200, await this.#runners.getSnapshot(ctx));
                return;
            }
            const connectionReorder = /^\/v0\/connections\/([a-z][a-z0-9_-]{0,63})\/reorder$/.exec(
                url.pathname,
            );
            if (request.method === "POST" && connectionReorder !== null) {
                const body = await bodyAs(
                    request,
                    reorderConnectionRequestSchema,
                    "connection reorder",
                );
                const expectedVersion = request.headers["if-match"];
                if (!Value.Check(eventIdSchema, expectedVersion))
                    throw invalidRequest("A valid If-Match resource version is required.");
                const snapshot = await this.#connections.reorder(
                    ctx,
                    connectionReorder[1]!,
                    body.afterId,
                    expectedVersion,
                    body.mutationId,
                );
                sendJson(response, 200, snapshot);
                return;
            }
            const remote = remoteRoute(request.url);
            if (remote !== undefined) {
                await this.#cloudOperation(() =>
                    this.#connections.forward(ctx, request, response, remote.id, remote.path),
                );
                return;
            }
            const retiredService =
                /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/services(?:\/[a-z][a-z0-9]*(?:\/(?:input|access-token))?)?$/.exec(
                    url.pathname,
                );
            if (retiredService !== null) {
                await this.#resolveWorkspaceScope(ctx, retiredService[1]!);
                throw unsupported("Workspace services are unavailable in this daemon.");
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
                sendJson(response, 200, { config: await this.#sanitizedConfig(ctx) });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/node/avatar") {
                const asset = await this.#node.avatar(ctx);
                if (asset === null) throw notFound("This installation has no avatar.");
                setImageCacheHeaders(response);
                response.setHeader("etag", asset.etag);
                if (request.headers["if-none-match"] === asset.etag) {
                    response.writeHead(304);
                    response.end();
                    return;
                }
                const bytes = Buffer.from(asset.data, "base64");
                response.writeHead(200, {
                    "content-type": "image/webp",
                    "content-length": bytes.length,
                });
                response.end(bytes);
                return;
            }
            if (request.method === "PATCH" && url.pathname === "/v0/config") {
                const body = await bodyAs(request, configPatchSchema, "configuration patch");
                if (
                    !Value.Check(runtimeConfigPatchSchema, body) ||
                    (body.voice !== undefined && this.#live === undefined)
                ) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "This daemon can only change provider enablement, its display name, and voice settings at runtime.",
                    );
                }
                if (
                    body.voice !== undefined &&
                    this.#team.enabled &&
                    teamUser(ctx)?.isOwner !== true
                ) {
                    throw new ApiError(
                        403,
                        "forbidden",
                        "Only the team owner can change voice settings.",
                    );
                }
                if (
                    body.node?.name !== undefined &&
                    this.#team.enabled &&
                    teamUser(ctx)?.isOwner !== true
                ) {
                    throw new ApiError(
                        403,
                        "forbidden",
                        "Only the team owner can change this installation's name.",
                    );
                }
                if (body.voice !== undefined) {
                    try {
                        // Voice applies first so a refused selection leaves every other field unchanged.
                        await this.#live!.updateVoiceSettings(ctx, body.voice);
                    } catch (error: unknown) {
                        if (error instanceof VoiceSettingsError)
                            throw invalidRequest(error.message);
                        throw error;
                    }
                }
                try {
                    if (body.providers !== undefined)
                        await this.#providerScan.setOverrides(ctx, body.providers);
                } catch (error: unknown) {
                    if (error instanceof ProviderNotFoundError) throw notFound(error.message);
                    throw error;
                }
                const nameChanged = await ctx.inTx(async (txCtx) => {
                    if (body.node?.name === undefined) return false;
                    const previous = await this.#node.get(txCtx);
                    await this.#node.setName(txCtx, body.node.name);
                    return previous.name !== body.node.name;
                });
                if (body.providers !== undefined && !nameChanged)
                    this.#journal.append("config.updated", {});
                sendJson(response, 200, { config: await this.#sanitizedConfig(ctx) });
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
                if (this.#team.enabled) {
                    throw unsupported("Connecting a Cloud account is unavailable in team mode.");
                }
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
                if (this.#team.enabled) {
                    throw unsupported("Connecting a Cloud account is unavailable in team mode.");
                }
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
            if (request.method === "GET" && url.pathname === "/v0/cloud/organizations") {
                sendJson(
                    response,
                    200,
                    await this.#cloudOperation(() => this.#cloud.listOrganizations(ctx)),
                );
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/cloud/organizations") {
                const body = await bodyAs(
                    request,
                    createCloudOrganizationRequestSchema,
                    "Cloud organization",
                    2 * 1_024,
                );
                const organization = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#cloudOperation(() =>
                            this.#cloud.createOrganization(ctx, body.name),
                        ),
                );
                sendJson(response, 201, { organization });
                return;
            }
            if (
                request.method === "DELETE" &&
                url.pathname.startsWith("/v0/cloud/organizations/")
            ) {
                const match = /^\/v0\/cloud\/organizations\/([^/]+)$/.exec(url.pathname);
                if (match === null) {
                    throw invalidRequest("The Cloud organization route is invalid.");
                }
                const body = await optionalBodyAs(
                    request,
                    cloudMutationRequestSchema,
                    "Cloud organization deletion",
                    2 * 1_024,
                );
                const organizationId = decodePathSegment(match[1]!, "Cloud organization ID");
                if (!Value.Check(cloudOrganizationSchema.properties.id, organizationId)) {
                    throw invalidRequest("The Cloud organization ID is invalid.");
                }
                await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#cloudOperation(() =>
                            this.#cloud.deleteOrganization(ctx, organizationId),
                        ),
                );
                sendJson(response, 200, { deleted: true });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/integrations/happy") {
                sendJson(response, 200, { integration: await this.#happy.integration(ctx) });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/integrations/happy/start") {
                try {
                    sendJson(response, 200, {
                        integration: await this.#happy.startIntegration(ctx),
                    });
                } catch (error: unknown) {
                    if (error instanceof HappyIntegrationRequestError) {
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
                try {
                    sendJson(response, 200, {
                        integration: await this.#happy.disconnectIntegration(ctx),
                    });
                } catch (error: unknown) {
                    if (error instanceof HappyIntegrationRequestError) {
                        throw new ApiError(503, error.code, error.message, {
                            integration: error.integration,
                        });
                    }
                    throw error;
                }
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/integrations/happy/re-pair") {
                try {
                    sendJson(response, 200, {
                        integration: await this.#happy.rePairIntegration(ctx),
                    });
                } catch (error: unknown) {
                    if (error instanceof HappyIntegrationRequestError) {
                        throw new ApiError(503, error.code, error.message, {
                            integration: error.integration,
                        });
                    }
                    throw error;
                }
                return;
            }
            if (
                this.#mobileConnector !== undefined &&
                (url.pathname === "/v0/mobile-connector" ||
                    url.pathname.startsWith("/v0/mobile-connector/")) &&
                (await this.#handleMobileConnectorRoute(
                    ctx,
                    request,
                    response,
                    url,
                    this.#mobileConnector,
                ))
            ) {
                return;
            }
            if (
                this.#userSettings !== undefined &&
                request.method === "GET" &&
                url.pathname === "/v0/user-settings"
            ) {
                // Capture first, so a write concurrent with the read is replayed after it.
                const cursor = this.#journal.cursor();
                sendJson(response, 200, {
                    settings: await this.#userSettings.list(ctx),
                    cursor,
                });
                return;
            }
            if (
                this.#userSettings !== undefined &&
                (request.method === "GET" || request.method === "PUT") &&
                url.pathname.startsWith("/v0/user-settings/")
            ) {
                await this.#handleUserSettingRoute(
                    ctx,
                    request,
                    response,
                    url.pathname.slice("/v0/user-settings/".length),
                    this.#userSettings,
                );
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
                setImageCacheHeaders(response);
                if (request.headers["if-none-match"] === photo.etag) {
                    response.writeHead(304, {
                        etag: photo.etag,
                    });
                    response.end();
                    return;
                }
                response.writeHead(200, {
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
                const creation = await this.#withMutationId(mutationId, async () => {
                    try {
                        return await this.#bots.createWithResult(ctx, input);
                    } catch (error) {
                        if (error instanceof BotConflictError && error.bot !== undefined) {
                            const bot = await this.#botResource(ctx, error.bot);
                            throw new ApiError(409, "conflict", error.message, {
                                currentVersion: bot["version"],
                                bot,
                            });
                        }
                        throw error;
                    }
                });
                const { bot, created } = creation;
                // Initial slash-command discovery is part of the same settled public agent
                // snapshot used by ordinary agent creation.
                if (created) {
                    await this.#slashCommands.catalog(ctx, bot.agentId);
                }
                // Join already-running creation work without starting discovery again on a retry.
                // Creation itself can enqueue its catalog event, so fence after that work settles.
                await this.#agentEventChains.get(bot.agentId);
                await this.#queueAgentWork(ctx, bot.agentId, undefined, async () => undefined);
                const resource = await this.#botResource(ctx, bot);
                if (created && !this.#announcedAgentCreations.has(bot.agentId)) {
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
            if (await this.#handleTaskRoute(ctx, request, response, url)) return;
            if (await this.#handleSurfaceRoute(ctx, request, response, url)) return;
            if (await this.#handleArtifactRoute(ctx, request, response, url)) return;
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
            if (await this.#handleBridgeRoute(ctx, request, response, url)) return;
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
            if (request.method === "POST" && url.pathname === "/v0/usage/refresh") {
                const body = await readJson(request, MAX_JSON_BODY_BYTES, true);
                if (!Value.Check(providerUsageRefreshRequestSchema, body)) {
                    throw invalidRequest("The usage refresh request is invalid.");
                }
                sendJson(response, 202, {
                    started: this.#providerUsage.requestRefresh(ctx, {
                        ...(body.providerIds === undefined
                            ? {}
                            : { providerIds: body.providerIds }),
                        ...(body.olderThanMs === undefined
                            ? {}
                            : { olderThanMs: body.olderThanMs }),
                    }),
                });
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/bootstrap/desktop") {
                sendJson(response, 200, await this.#desktopBootstrap(ctx));
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/events") {
                this.#handleEventPull(ctx, url, response);
                return;
            }
            if (request.method === "GET" && url.pathname === "/v0/events/stream") {
                this.#handleEventStream(ctx, request, response, url);
                return;
            }
            if (request.method === "POST" && url.pathname === "/v0/drain") {
                if (this.#drainSources.size === 0) {
                    sendJson(response, 403, { error: "Daemon draining is not enabled." });
                    return;
                }
                this.beginDrain(ctx);
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
            await this.#sendError(
                ctx,
                response,
                error instanceof LiveError
                    ? new ApiError(
                          error.status,
                          error.code,
                          error.message,
                          error.session === undefined ? {} : { session: error.session },
                      )
                    : error instanceof GlobalSkillsError
                      ? new ApiError(error.status, error.code, error.message, error.details)
                      : error,
            );
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
        if (isMobileTransport(ctx)) {
            try {
                ctx = await this.#admitMobileDevice(ctx, request.headers.authorization, socket);
            } catch (error: unknown) {
                writeSocketError(socket, this.#socketRejection(ctx, error, "Not found."));
                return true;
            }
        }
        const runner = this.prepareRunnerSocket(
            ctx,
            requestUrl(request).pathname,
            request.headers.authorization,
        );
        if (runner.handled) {
            if ("rejection" in runner) {
                writeSocketError(socket, runner.rejection);
                return true;
            }
            this.#runnerWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
                runner.attach(createNodeBinaryWebSocket(webSocket));
            });
            return true;
        }
        if (await this.#handleExportedBotUpgrade(ctx, request, socket, head)) return true;
        if (await this.handleRemoteAttachment(ctx, request, socket, head)) return true;
        const live = await this.prepareLiveSocket(
            ctx,
            requestUrl(request),
            request.headers.authorization,
        );
        if (live.handled) {
            if ("rejection" in live) {
                writeSocketError(socket, live.rejection);
                return true;
            }
            const upgradeFailed = () => live.failed();
            socket.once("close", upgradeFailed);
            socket.once("error", upgradeFailed);
            try {
                this.#liveWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
                    socket.off("close", upgradeFailed);
                    socket.off("error", upgradeFailed);
                    const binding = live.attach({
                        send: (text) => {
                            if (webSocket.bufferedAmount > 256 * 1024)
                                throw new Error("The voice control connection is too slow.");
                            webSocket.send(text);
                        },
                        close: (code, reason) => webSocket.close(code, reason),
                    });
                    webSocket.on("message", (data, binary) =>
                        binding.message(binary ? "" : data.toString()),
                    );
                    webSocket.on("close", () => binding.closed());
                    webSocket.on("error", () => binding.message(""));
                });
            } catch {
                socket.off("close", upgradeFailed);
                socket.off("error", upgradeFailed);
                live.failed();
                socket.destroy();
            }
            return true;
        }
        const bridge = await this.prepareBridgeSocket(
            ctx,
            requestUrl(request),
            request.headers.authorization,
        );
        if (bridge.handled) {
            if ("rejection" in bridge) {
                writeSocketError(socket, bridge.rejection);
                return true;
            }
            const upgradeFailed = () => bridge.failed();
            socket.once("close", upgradeFailed);
            socket.once("error", upgradeFailed);
            try {
                this.#bridgeWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
                    socket.off("close", upgradeFailed);
                    socket.off("error", upgradeFailed);
                    let binding: BridgeWebSocketBinding | undefined;
                    webSocket.on("message", (data, binary) => {
                        binding?.message(
                            binary ? webSocketBytes(data) : webSocketBytes(data).toString(),
                        );
                    });
                    webSocket.on("close", () => binding?.closed());
                    webSocket.on("error", () => webSocket.terminate());
                    binding = bridge.attach({
                        get bufferedAmount() {
                            return webSocket.bufferedAmount;
                        },
                        send: (data) => {
                            if (webSocket.readyState !== webSocket.OPEN) return;
                            webSocket.send(data, {
                                binary: typeof data !== "string",
                                compress: false,
                            });
                        },
                        close: (code, reason) => {
                            if (webSocket.readyState === webSocket.OPEN)
                                webSocket.close(code, reason);
                            else if (webSocket.readyState !== webSocket.CLOSED)
                                webSocket.terminate();
                        },
                        pause: () => {
                            if (webSocket.readyState === webSocket.OPEN) webSocket.pause();
                        },
                        resume: () => {
                            if (webSocket.readyState === webSocket.OPEN) webSocket.resume();
                        },
                    });
                });
            } catch {
                socket.off("close", upgradeFailed);
                socket.off("error", upgradeFailed);
                bridge.failed();
                socket.destroy();
            }
            return true;
        }
        const prepared = await this.prepareTerminalSocket(
            ctx,
            requestUrl(request).pathname,
            request.headers.authorization,
        );
        if (!prepared.handled) return false;
        if ("rejection" in prepared) {
            writeSocketError(socket, prepared.rejection);
            return true;
        }
        this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
            prepared.attach(new WebSocketDuplex(createNodeBinaryWebSocket(webSocket)));
        });
        return true;
    }

    /**
     * `GET /v0/exported-bots/connect`: a bridge, admitted by its export's own bridge token and
     * nothing else, so neither the API token nor team sign-in applies.
     */
    async prepareExportedBotSocket(
        ctx: Context,
        url: URL,
        authorization: string | string[] | undefined,
    ): Promise<PreparedExportedBotSocket> {
        if (this.#exportedBots === undefined) return { handled: false };
        if (isMobileTransport(ctx) && url.pathname === "/v0/exported-bots/connect") {
            return {
                handled: true,
                rejection: { code: "unauthorized", message: "Unauthorized", status: 401 },
            };
        }
        return await this.#exportedBots.prepareSocket(ctx, url, authorization);
    }

    async #handleExportedBotUpgrade(
        ctx: Context,
        request: IncomingMessage,
        socket: Socket,
        head: Buffer,
    ): Promise<boolean> {
        const prepared = await this.prepareExportedBotSocket(
            ctx,
            requestUrl(request),
            request.headers.authorization,
        );
        if (!prepared.handled) return false;
        if ("rejection" in prepared) {
            writeSocketError(socket, prepared.rejection);
            return true;
        }
        this.#exportedBotWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
            const socket: ExportedBotSocket = {
                send: (text) => webSocket.send(text),
                close: (code, reason) => webSocket.close(code, reason),
                terminate: () => webSocket.terminate(),
                ping: () => webSocket.ping(),
                get bufferedAmount() {
                    return webSocket.bufferedAmount;
                },
            };
            const binding = prepared.attach(socket);
            webSocket.on("message", (data, binary) =>
                binding.message(binary ? undefined : data.toString()),
            );
            webSocket.on("pong", () => binding.pong());
            webSocket.on("close", () => binding.closed());
            // A failed socket closes next, and the close is what the export acts on.
            webSocket.on("error", () => undefined);
        });
        return true;
    }

    async handleConnect(
        ctx: Context,
        request: IncomingMessage,
        socket: Socket,
        head: Buffer,
    ): Promise<boolean> {
        // HTTP hands a CONNECT socket over without its error handling, and admission waits.
        socket.on("error", () => undefined);
        if (isMobileTransport(ctx)) {
            try {
                ctx = await this.#admitMobileDevice(ctx, request.headers.authorization, socket);
            } catch (error: unknown) {
                writeSocketError(socket, this.#socketRejection(ctx, error, "Not found."));
                return true;
            }
        }
        if (await this.handleRemoteAttachment(ctx, request, socket, head)) return true;
        const prepared = await this.prepareWorkspaceProxySocket(
            ctx,
            requestUrl(request).pathname,
            request.headers.authorization,
        );
        if (!prepared.handled) return false;
        if ("rejection" in prepared) {
            writeSocketError(socket, prepared.rejection);
            return true;
        }
        this.#workspaceProxy.accept(socket, head, prepared.route);
        return true;
    }

    async prepareLiveSocket(
        ctx: Context,
        url: URL,
        authorization: string | string[] | undefined,
    ): Promise<PreparedLiveSocket> {
        const match = /^\/v0\/live\/sessions\/([a-z][a-z0-9]{1,31})\/control$/.exec(url.pathname);
        if (match === null) return { handled: false };
        try {
            ctx = await this.#authenticate(ctx, authorization);
            this.#assertTeamUser(ctx);
            this.#assertSocketReady();
            if (this.#live === undefined)
                throw unsupported("Desktop voice control is unavailable.");
            const windowId = url.searchParams.get("windowId");
            if (
                !Value.Check(liveDesktopIdSchema, windowId) ||
                url.searchParams.getAll("windowId").length !== 1 ||
                [...url.searchParams.keys()].some((key) => key !== "windowId")
            )
                throw invalidRequest("The voice window identity is invalid.");
            const control = await this.#live.prepareControl(
                ctx,
                teamUser(ctx)?.id ?? "standalone",
                match[1]!,
                windowId,
            );
            const attachedCtx = ctx;
            return {
                handled: true,
                failed: () => control.failed(),
                attach: (socket) => {
                    const binding = control.attach(socket);
                    const stop = this.#onMobileRevoke(attachedCtx, () =>
                        socket.close(MOBILE_REVOKED_CLOSE, "This phone was removed."),
                    );
                    return {
                        message: (text) => binding.message(text),
                        closed: () => {
                            stop();
                            binding.closed();
                        },
                    };
                },
            };
        } catch (error) {
            const failure =
                error instanceof LiveError
                    ? new ApiError(error.status, error.code, error.message)
                    : error;
            return {
                handled: true,
                rejection: this.#socketRejection(ctx, failure, "The voice session was not found."),
            };
        }
    }

    /**
     * A local bridge's WebSocket: a USB device, a port bridge's control channel, or one connection
     * of a port bridge.
     *
     * Everything refusable is refused before the upgrade, so a client sees an ordinary status. A
     * draining daemon opens no new bridge, but still lets an open port bridge's owner accept its
     * connections: the bridge stays useful until it is closed.
     */
    async prepareBridgeSocket(
        ctx: Context,
        url: URL,
        authorization: string | string[] | undefined,
    ): Promise<PreparedBridgeSocket> {
        const match =
            /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/bridges\/(?:(usb|port)|([a-z][a-z0-9]*)\/connections\/([a-z][a-z0-9]*))$/.exec(
                url.pathname,
            );
        if (match === null) return { handled: false };
        try {
            ctx = await this.#authenticate(ctx, authorization);
            this.#assertTeamUser(ctx);
            const bridges = this.#bridges;
            if (bridges === undefined)
                throw notFound("Local bridges are unavailable in this daemon.");
            const ownerId = teamUser(ctx)?.id ?? "standalone";
            const workspaceId = match[1]!;
            if (match[2] === undefined) {
                if (!this.#ready || this.#closed)
                    throw new ApiError(503, "not_initialized", "Happy Agent is still starting.");
                if (this.#config.configuration.values.features.workspaces === false)
                    throw new ApiError(
                        503,
                        "unsupported",
                        "Workspaces are disabled in this daemon.",
                    );
                const connection = bridges.admitConnection(
                    ownerId,
                    workspaceId,
                    match[3]!,
                    match[4]!,
                );
                return {
                    handled: true,
                    attach: (webSocket) =>
                        this.#closeBridgeOnRevoke(ctx, webSocket, connection.attach(webSocket)),
                    failed: () => {
                        connection.failed();
                    },
                };
            }
            this.#assertSocketReady();
            const query = bridgeQuery(url);
            const admission =
                match[2] === "usb"
                    ? await bridges.admitUsb(ctx, ownerId, workspaceId, {
                          ...query,
                          busId: url.searchParams.get("busId") ?? "",
                      })
                    : await bridges.admitPort(ctx, ownerId, workspaceId, {
                          ...query,
                          port: portParameter(url.searchParams.get("port")),
                      });
            const attachedCtx = ctx;
            return {
                handled: true,
                attach: (webSocket) =>
                    this.#closeBridgeOnRevoke(attachedCtx, webSocket, admission.attach(webSocket)),
                failed: () => {
                    admission.failed();
                },
            };
        } catch (error) {
            return {
                handled: true,
                rejection: this.#socketRejection(ctx, error, "The bridge was not found."),
            };
        }
    }

    /**
     * A runner's connection. Only a configured runner token is accepted here, and it is accepted
     * nowhere else; an unknown token is refused before the upgrade. Runners are not team users, so
     * neither team sign-in nor the local API token applies.
     */
    prepareRunnerSocket(
        ctx: Context,
        pathname: string,
        authorization: string | string[] | undefined,
    ): PreparedRunnerSocket {
        if (pathname !== "/v0/runners/connect" || this.#runners === undefined) {
            return { handled: false };
        }
        if (isMobileTransport(ctx)) return { handled: true, rejection: MOBILE_UNAUTHORIZED };
        const runnerId = this.#runners.authenticate(authorization);
        if (runnerId === undefined) {
            return {
                handled: true,
                rejection: { code: "unauthorized", message: "Unauthorized", status: 401 },
            };
        }
        if (!this.#ready) {
            return {
                handled: true,
                rejection: {
                    code: "not_initialized",
                    message: "Happy Agent is still starting.",
                    status: 503,
                },
            };
        }
        const runners = this.#runners;
        return {
            handled: true,
            attach: (webSocket) => runners.acceptWebSocket(runnerId, webSocket),
        };
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
            const attachedCtx = ctx;
            return {
                handled: true,
                attach: (stream) => {
                    const detach = session.attach(stream);
                    stream.once("close", detach);
                    this.#closeWithMobileDevice(attachedCtx, stream);
                },
            };
        } catch (error: unknown) {
            return {
                handled: true,
                rejection: this.#socketRejection(ctx, error, "The terminal was not found."),
            };
        }
    }

    async handleRemoteAttachment(
        ctx: Context,
        request: IncomingMessage,
        socket: import("node:stream").Duplex,
        head: Buffer,
    ): Promise<boolean> {
        const remote = remoteRoute(request.url);
        if (remote === undefined) return false;
        try {
            ctx = await this.#authenticate(ctx, request.headers.authorization);
            this.#closeWithMobileDevice(ctx, socket);
            this.#assertTeamUser(ctx);
            if (!this.#ready)
                throw new ApiError(503, "not_initialized", "Happy Agent is still starting.");
            if (this.#draining)
                throw new ApiError(
                    503,
                    "draining",
                    "Happy Agent is draining and no longer accepts attachments.",
                );
            await this.#cloudOperation(() =>
                this.#connections.forward(ctx, request, socket, remote.id, remote.path, head),
            );
        } catch (error) {
            const rejection = this.#socketRejection(
                ctx,
                error,
                "The remote connection was not found.",
            );
            writeSocketError(socket, rejection);
        }
        return true;
    }

    async prepareWorkspaceProxySocket(
        ctx: Context,
        pathname: string,
        authorization: string | string[] | undefined,
    ): Promise<PreparedWorkspaceProxySocket> {
        const network = /^\/v0\/networks\/([^/]*)\/proxy$/.exec(pathname);
        if (network !== null)
            return await this.#prepareNetworkProxy(ctx, network[1]!, authorization);
        const match =
            /^\/v0\/workspaces\/([a-z][a-z0-9]*)(?:\/services\/([a-z][a-z0-9]*)|\/agents\/([a-z][a-z0-9]*))?\/proxy$/.exec(
                pathname,
            );
        if (match === null) return { handled: false };
        try {
            ctx = await this.#authenticate(ctx, authorization);
            this.#assertTeamUser(ctx);
            this.#assertSocketReady();
            const workspaceId = match[1] as string;
            const scope = await this.#resolveWorkspaceScope(ctx, workspaceId);
            if (match[2] !== undefined)
                throw unsupported("Workspace services are unavailable in this daemon.");
            const revoked = mobileDevice(ctx)?.revoked;
            if (match[3] !== undefined) {
                const route = await this.#agentProxyRoute(ctx, workspaceId, match[3]);
                return { handled: true, route, ...(revoked === undefined ? {} : { revoked }) };
            }
            if (await this.#agentsWorkInContainers(ctx, scope)) {
                throw unsupported(
                    "Each agent in this workspace works in a container of its own. Open an agent's proxy to reach its network.",
                );
            }
            const network = await this.#folderNetwork(scope.runnerId);
            // Connections outlive the request that opened the attachment.
            const connectCtx = detach(ctx).named("workspace-proxy-connections");
            const route = this.#workspaceProxy.route(
                async (host, port) => await (await network()).connect(connectCtx, { host, port }),
            );
            return { handled: true, route, ...(revoked === undefined ? {} : { revoked }) };
        } catch (error: unknown) {
            return {
                handled: true,
                rejection: this.#socketRejection(ctx, error, "The workspace was not found."),
            };
        }
    }

    /**
     * A route through the network a `networkId` names. Only a network served right now is opened;
     * an unknown or stale one is `404`, never another network.
     */
    async #prepareNetworkProxy(
        ctx: Context,
        networkId: string,
        authorization: string | string[] | undefined,
    ): Promise<PreparedWorkspaceProxySocket> {
        try {
            ctx = await this.#authenticate(ctx, authorization);
            this.#assertTeamUser(ctx);
            this.#assertSocketReady();
            if (!Value.Check(networkIdSchema, networkId))
                throw notFound("The network was not found.");
            const connect = await this.#machineNetwork(() => this.#compute.namedNetwork(networkId));
            if (connect === undefined) throw notFound("The network was not found.");
            // Connections outlive the request that opened the attachment.
            const connectCtx = detach(ctx).named("network-proxy-connections");
            const route = this.#workspaceProxy.route(
                async (host, port) => await connect(connectCtx, { host, port }),
            );
            const revoked = mobileDevice(ctx)?.revoked;
            return { handled: true, route, ...(revoked === undefined ? {} : { revoked }) };
        } catch (error: unknown) {
            return {
                handled: true,
                rejection: this.#socketRejection(ctx, error, "The network was not found."),
            };
        }
    }

    /**
     * A route through one agent's own machine. The agent must belong to this workspace; every
     * connection is then opened from its machine and nowhere else.
     */
    async #agentProxyRoute(ctx: Context, workspaceId: string, agentId: string): Promise<string> {
        const agentCtx = await this.#proxiedAgent(ctx, workspaceId, agentId);
        // Connections outlive the request that opened the attachment.
        const connectCtx = detach(ctx).named("workspace-agent-proxy-connections");
        const connect = await this.#machineNetwork(() => this.#compute.network(agentCtx, agentId));
        return this.#workspaceProxy.route(
            async (host, port) => await connect(connectCtx, { host, port }),
        );
    }

    /** `GET /v0/workspaces/:workspaceId/agents/:agentId/proxy`, refused as its `CONNECT` is. */
    async #agentNetwork(
        ctx: Context,
        workspaceId: string,
        agentId: string,
    ): Promise<{ readonly networkId: string }> {
        this.#assertSocketReady();
        await this.#resolveWorkspaceScope(ctx, workspaceId);
        const agentCtx = await this.#proxiedAgent(ctx, workspaceId, agentId);
        const networkId = await this.#machineNetwork(() =>
            this.#compute.networkId(agentCtx, agentId),
        );
        return { networkId };
    }

    /** The agent's own context, once it is known to belong to this workspace and is not archived. */
    async #proxiedAgent(ctx: Context, workspaceId: string, agentId: string): Promise<Context> {
        const config = await this.#agentSystem().config(ctx, agentId);
        if (config === undefined || (await this.#workspaceIdForAgent(ctx, agentId)) !== workspaceId)
            throw notFound("The agent was not found.");
        if (typeof config.metadata?.["archivedAt"] === "number")
            throw new ApiError(409, "conflict", "The agent is archived.");
        return withAgentConfig(ctx, config);
    }

    /** Ask Compute about a machine's network, refusing one that cannot open connections. */
    async #machineNetwork<Result>(ask: () => Promise<Result>): Promise<Result> {
        try {
            return await ask();
        } catch (error: unknown) {
            if ((error as { code?: unknown } | null)?.code === "ENOTSUP")
                throw unsupported("This agent's machine cannot open network connections.");
            throw error;
        }
    }

    /**
     * The network of the machine a folder is on: this computer or its runner. The machine is
     * checked now, so an attachment for a runner that is away is refused instead of every
     * connection on it. Each connection asks again, since a runner may have reconnected.
     */
    async #folderNetwork(runnerId: string | undefined): Promise<() => Promise<ComputeNetwork>> {
        const runners = this.#runners;
        if (runners === undefined) {
            const network = createHostNetwork();
            return async () => network;
        }
        const reachable = async (): Promise<ComputeNetwork> => {
            const network = (await runners.machine(runnerId)).network;
            if (network === undefined) {
                throw unsupported("This folder's machine cannot open network connections.");
            }
            return network;
        };
        await reachable();
        return reachable;
    }

    /** Whether a workspace's agents each work in a container, so it has no one network. */
    async #agentsWorkInContainers(
        ctx: Context,
        scope: { readonly botId?: string; readonly docker?: { readonly image: string } },
    ): Promise<boolean> {
        if (scope.docker !== undefined) return true;
        if (scope.botId === undefined) return false;
        return (await this.#bots.settings(ctx, scope.botId)).compute.type === "docker";
    }

    async listenWorkspaceProxyHttp(path: string): Promise<void> {
        await this.#workspaceProxy.listen(path);
    }

    /** The one loopback TCP workspace-proxy hop; every Bun front door shares it. */
    async listenWorkspaceProxyTcp(): Promise<WorkspaceProxyTcpHop> {
        return await this.#workspaceProxy.listenTcp();
    }

    #subscribeToModules(ctx: Context): void {
        if (this.#unsubscribe.length > 0) return;
        if (this.#scheduling !== undefined) {
            this.#unsubscribe.push(
                this.#scheduling.onEventTransactional(async (eventCtx, event) => {
                    if (!("activeWait" in event) || event.activeWait === undefined) return;
                    await this.#events.record(eventCtx, {
                        type: "scheduling.wait-changed",
                        agentId: event.agentId,
                        payload: { wait: event.activeWait },
                    });
                }),
            );
        }
        if (this.#live !== undefined)
            this.#unsubscribe.push(
                this.#live.onEvent((event) => {
                    this.#mutationIds.exit(() =>
                        this.#journal.append(
                            event.type,
                            event.payload,
                            undefined,
                            event.ownerId === "standalone" ? undefined : event.ownerId,
                        ),
                    );
                }),
            );
        if (this.#bridges !== undefined)
            this.#unsubscribe.push(
                this.#bridges.onEvent((event) => {
                    // A bridge's closing event carries the mutation that closed it, if any, and
                    // must not inherit one from whatever request happened to end it otherwise.
                    this.#mutationIds.exit(() => {
                        if (event.type === "bridges.capabilities.updated") {
                            this.#journal.append(event.type, event.payload);
                            return;
                        }
                        this.#journal.append(
                            event.type,
                            event.payload,
                            event.type === "bridge.created"
                                ? event.payload.bridge.createdAt
                                : event.payload.changes.updatedAt,
                            event.ownerId === "standalone" ? undefined : event.ownerId,
                        );
                    });
                }),
            );
        if (this.#globalSkills !== undefined)
            this.#unsubscribe.push(
                this.#globalSkills.onUpdated((_eventCtx, payload) => {
                    this.#journal.appendOutsideMutation("skills.updated", payload);
                }),
            );
        this.#unsubscribe.push(
            this.#config.onProviderServiceTiersChanged(() => {
                this.#journal.appendOutsideMutation("config.updated", {});
            }),
            this.#node.onUpdated(() => {
                this.#journal.append("config.updated", {});
            }),
            ...(this.#live === undefined
                ? []
                : [
                      this.#live.onSettingsUpdated(() => {
                          this.#journal.append("config.updated", {});
                      }),
                  ]),
            ...(this.#runners === undefined
                ? []
                : [
                      this.#runners.onUpdated((_eventCtx, snapshot) => {
                          this.#journal.appendOutsideMutation("runners.updated", snapshot);
                      }),
                  ]),
            // Account readings change outside any mutation: a poll, a vendor reporting in band, or a
            // refresh some other client asked for. Each change is the complete entry state.
            this.#providerUsage.onChanged((entry) => {
                this.#journal.appendOutsideMutation("provider.usage.updated", {
                    providerId: entry.providerId,
                    usage: entry.usage,
                    checkedAt: entry.checkedAt,
                    error: entry.error,
                    refreshedAt: entry.refreshedAt,
                    refreshError: entry.refreshError,
                    retryAt: entry.retryAt,
                    refreshing: entry.refreshing,
                });
            }),
            this.#connections.onUpdated((_eventCtx, snapshot, mutationId) => {
                this.#journal.appendOutsideMutation(
                    "connections.updated",
                    mutationId === undefined ? snapshot : { ...snapshot, mutationId },
                );
            }),
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
            ...(this.#tasks === undefined
                ? []
                : [
                      this.#tasks.onEvent(async (_eventCtx, event) => {
                          await this.#convertTaskEvent(ctx, event);
                      }),
                  ]),
            ...(this.#artifacts === undefined
                ? []
                : [
                      this.#artifacts.onEvent((_eventCtx, event) => {
                          this.#convertArtifactEvent(event);
                      }),
                  ]),
            this.#terminals.onEvent(async (event) => {
                this.#convertTerminalEvent(event);
            }),
            this.#git.onSnapshot(async (_ctx, entity, snapshot) => {
                this.#journal.append("git.updated", {
                    workspaceId: entity.workspaceId ?? entity.projectId,
                    git: this.#git.resource(snapshot),
                });
            }),
            this.#files.onEvent((_eventCtx, event) => {
                this.#journal.append(
                    "files.updated",
                    { workspaceId: event.workspaceId, paths: event.paths },
                    event.at,
                );
            }),
            this.#history.onPending((_ctx, pending) => {
                // API-originated submissions announce themselves after their route has built the
                // response. Every other producer still enters through History, so project that
                // same durable pending row before Agent Base can publish its acceptance.
                if (this.#apiPendingMessageIds.has(pending.id)) return;
                this.#journal.append(
                    "message.created",
                    {
                        agentId: pending.agentId,
                        runId: null,
                        message: pendingMessageResource(pending),
                    },
                    pending.createdAt,
                );
                boundedAdd(this.#apiPendingMessageIds, pending.id, MAX_ANNOUNCED_PENDING_MESSAGES);
            }),
            this.#history.onToolSpawn((_ctx, agentId, message) => {
                if (messageHiddenFromUser(message)) return;
                this.#journal.append("message.updated", {
                    agentId,
                    runId: message.runId ?? null,
                    message: messageResource(message),
                });
            }),
            this.#history.onAppend((_ctx, agentId, messages) => {
                const eligible = messages.filter(
                    (message) =>
                        !(
                            messageHiddenFromUser(message) ||
                            message.blocks.some((block) => block.type === "compaction") ||
                            message.role === "user" ||
                            message.senderAgentId !== undefined ||
                            message.provider !== undefined ||
                            message.model !== undefined
                        ),
                );
                if (eligible.length === 0) return;
                // All eligible service appends share the provider conversion queue. Otherwise
                // a committed row can overtake a streamed assistant block still awaiting delivery.
                const queued = this.#queueAgentWork(
                    ctx,
                    agentId,
                    this.#mutationIds.getStore(),
                    async () => {
                        for (const message of eligible) {
                            // Reserved is not announced. Only a successfully journaled creation may
                            // suppress this durable fallback; a failed conversion leaves it eligible.
                            if (this.#announcedExecutionConfigurations.delete(message.recordId))
                                continue;
                            this.#journal.append("message.created", {
                                agentId,
                                runId: message.runId ?? null,
                                message: messageResource(message),
                            });
                        }
                    },
                );
                void queued.catch(() => {
                    ctx.log.warn("The API could not announce committed messages.", { agentId });
                });
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
            this.#team.onDraftUpdated((_eventCtx, event) => {
                this.#journal.append(
                    "agent.draft.updated",
                    { agentId: event.agentId, draft: event.draft },
                    Date.now(),
                    event.userId,
                );
            }),
            this.#cloud.onUpdated((_eventCtx, cloud) => {
                this.#journal.append("cloud.updated", { cloud }, cloud.updatedAt);
            }),
            this.#happy.onIntegrationUpdated((_eventCtx, integration, ownerId) => {
                this.#journal.append(
                    "happy.integration.updated",
                    { integration },
                    integration.updatedAt,
                    ownerId,
                );
            }),
            this.#compute.onProcessEvent(async (event) => {
                await this.#convertProcessEvent(ctx, event);
            }),
            this.#secrets.onEvent(async (_eventCtx, event) => {
                this.#convertSecretEvent(event);
            }),
        );
        if (this.#surfaces !== undefined)
            this.#unsubscribe.push(
                this.#surfaces.onEvent(async (eventCtx, event) => {
                    // A new chat's agent is announced before the Surface that names it.
                    if (
                        event.type === "surface.updated" &&
                        typeof event.payload.changes.chatAgentId === "string"
                    )
                        await this.#announceSurfaceChat(
                            eventCtx,
                            event.payload.changes.chatAgentId,
                            event.payload.mutationId,
                        );
                    this.#journal.append(event.type, event.payload);
                }),
                // Live document frames bypass the journal: no id, no cursor, one stream each.
                this.#surfaces.onDocumentFrame((streamId, frame) => {
                    this.#eventStreams
                        .get(streamId)
                        ?.writer.write(
                            `event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`,
                        );
                }),
            );
        if (this.#mobileConnector !== undefined)
            this.#unsubscribe.push(
                this.#mobileConnector.onEvent((_eventCtx, event) => {
                    this.#journal.append(
                        "mobile_connector.updated",
                        { mobileConnector: event.mobileConnector },
                        event.mobileConnector.updatedAt,
                        event.owner === STANDALONE_MOBILE_OWNER ? undefined : event.owner,
                    );
                }),
            );
        if (this.#userSettings !== undefined)
            this.#unsubscribe.push(
                this.#userSettings.onEvent((_eventCtx, event) => {
                    // The payload never names the owner; the journal keeps it to filter readers.
                    this.#journal.append(
                        "user_settings.updated",
                        { setting: event.setting },
                        Date.now(),
                        event.owner === STANDALONE_USER_SETTINGS_OWNER ? undefined : event.owner,
                    );
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
                        ...rootWorkspaceResource(
                            event.project,
                            this.#projects.compute(event.project),
                        ),
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
            ...rootWorkspaceResource(project, this.#projects.compute(project)),
            agents,
        };
        const previous = rootWorkspaceResource(
            previousProject,
            this.#projects.compute(previousProject),
        );
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

    async #convertTaskEvent(ctx: Context, event: TaskEvent): Promise<void> {
        if (
            event.type === "task_joined" ||
            event.type === "task_reordered" ||
            event.type === "task_left"
        ) {
            const type =
                event.type === "task_joined"
                    ? "task.joined"
                    : event.type === "task_reordered"
                      ? "task.reordered"
                      : "task.left";
            // A person's list is private: in team mode only the member sees their own changes.
            const memberId = event.membership.memberId;
            this.#journal.append(
                type,
                { membership: taskMembershipResource(event.membership) },
                event.at,
                memberId === STANDALONE_TASK_MEMBER ? undefined : memberId,
            );
            return;
        }
        // Like bot events, this runs inside the catalog's post-commit notification and must not
        // wait on the agent's own event chain from that same transaction.
        const agent = await this.#buildAgentResource(
            ctx,
            event.task.agentId,
            event.task.workspaceId,
            null,
            { userVisible: true },
        );
        if (agent === undefined) throw new Error("The task event has no agent.");
        const resource = taskResource(event.task, agent);
        if (event.type === "task_created") {
            this.#journal.append("task.created", { task: resource }, event.at);
            return;
        }
        const previous = taskResource(event.previousTask, agent);
        const changes = resourceChanges(previous, resource);
        delete changes["agent"];
        this.#journal.append(
            "task.updated",
            {
                taskId: event.task.id,
                previousVersion: previous["version"],
                version: resource["version"],
                changes,
            },
            event.at,
        );
    }

    /**
     * Artifact events reach everyone. A new version and a deletion each carry their fixed set of
     * changed fields, even when a value is the same as before.
     */
    #convertArtifactEvent(event: ArtifactEvent): void {
        const artifact = artifactResource(event.artifact);
        if (event.type === "artifact_created") {
            this.#journal.append("artifact.created", { artifact }, event.at);
            return;
        }
        const fields =
            event.type === "artifact_updated" ? ARTIFACT_UPDATED_FIELDS : ARTIFACT_DELETED_FIELDS;
        this.#journal.append(
            event.type === "artifact_updated" ? "artifact.updated" : "artifact.deleted",
            {
                artifactId: event.artifact.id,
                previousVersion: artifactResource(event.previousArtifact)["version"],
                version: artifact["version"],
                changes: Object.fromEntries(fields.map((field) => [field, artifact[field]])),
            },
            event.at,
        );
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
        let configurations: readonly HistoryMessage[] = [];
        const payload = recordValue(event.payload);
        const rigEvent = recordValue(payload?.["rigEvent"]);
        const inferenceId = stringValue(rigEvent?.["messageId"]);
        if (
            event.agentId !== undefined &&
            event.type === "provider.event" &&
            rigEvent?.["type"] === "block_start" &&
            inferenceId !== undefined
        ) {
            // Events publishes synchronously. Capture before the Promise chain can fall behind
            // a different attempt or completion; no database or other I/O belongs at this edge.
            try {
                configurations = this.#history.pendingExecutionConfigurations(
                    event.agentId,
                    inferenceId,
                );
            } catch {
                this.#history.invalidateExecutionConfigurations(event.agentId, inferenceId);
                ctx.log.warn("The execution configuration snapshot is unavailable.", {
                    agentId: event.agentId,
                    inferenceId,
                });
            }
        }
        const queued = this.#queueAgentWork(
            ctx,
            key,
            mutationId,
            async () => await this.#convertAgentEvent(ctx, event, configurations),
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

    async #convertAgentEvent(
        ctx: Context,
        event: AgentEvent,
        configurations: readonly HistoryMessage[],
    ): Promise<void> {
        const agentId = event.agentId;
        if (agentId === undefined) return;
        const payload = recordValue(event.payload);
        if (event.type !== "message.accepted" && this.#acceptedMessageBatches.has(agentId)) {
            await this.#waitForPendingMessageAnnouncements(agentId);
            await this.#flushAcceptedMessages(ctx, agentId);
        }
        if (event.type === "scheduling.wait-changed") {
            const wait = payload?.["wait"];
            if (!Value.Check(agentWaitStateSchema, wait))
                throw new Error("The durable scheduled wait state is invalid.");
            await this.#appendAgentUpdate(ctx, event, { wait, updatedAt: event.occurredAt });
            return;
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
            for (const [recordId, owner] of this.#announcedExecutionConfigurations) {
                if (owner === agentId) this.#announcedExecutionConfigurations.delete(recordId);
            }
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
                const failure = await this.#history.runFailure(ctx, agentId, run.id);
                if (failure !== undefined) {
                    this.#journal.append(
                        "message.created",
                        {
                            agentId,
                            runId: run.id,
                            message: messageResource(failure),
                        },
                        event.occurredAt,
                    );
                }
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
            if (!this.#team.enabled && Object.hasOwn(update, "draft")) {
                this.#journal.append(
                    "agent.draft.updated",
                    { agentId, draft: await this.#agentDraft(ctx, agentId) },
                    event.occurredAt,
                );
            }
            const canSendMessages = Object.hasOwn(update, "archivedAt")
                ? ((await this.#agentSystem().parentOf(ctx, agentId)) === null ||
                      this.#subtasks?.isSubtask(await this.#agentSystem().config(ctx, agentId)) ===
                          true) &&
                  update["archivedAt"] === null
                : undefined;
            // A reordered parent carries its complete new subtask list, so clients need no refetch.
            const subtasks = Object.hasOwn(update, "subtasksOrderedAt")
                ? await this.#subtaskResources(
                      ctx,
                      await this.#agentSystem().childOf(ctx, agentId),
                      0,
                  )
                : undefined;
            await this.#appendAgentUpdate(ctx, event, {
                ...agentMetadataChanges(update, event.occurredAt, canSendMessages),
                ...(subtasks === undefined ? {} : { subtasks }),
            });
            return;
        }
        if (event.type === "provider.event" || event.type === "tool.completed") {
            await this.#convertProviderMessageEvent(ctx, event, payload, configurations);
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
        configurations: readonly HistoryMessage[],
    ): Promise<void> {
        if (payload?.["recovered"] === true) return;
        const agentId = event.agentId;
        const underlyingRunId = stringValue(payload?.["runId"]);
        const rigEvent = recordValue(payload?.["rigEvent"]);
        const type = stringValue(rigEvent?.["type"]);
        if (agentId === undefined || underlyingRunId === undefined || type === undefined) {
            return;
        }
        // Requested calls have their own durable assistant message under the call ID, not an
        // inference ID. Base emits ordinary tool events but no provider block_start for them.
        // Publish that exact row rather than inventing a streaming inference identity.
        const callId =
            event.type === "tool.completed"
                ? stringValue(payload?.["callId"])
                : stringValue(recordValue(payload?.["event"])?.["callId"]);
        const requestedMessage =
            callId === undefined ? undefined : await this.#history.message(ctx, agentId, callId);
        if (requestedMessage?.role === "assistant") {
            await this.#flushAcceptedMessages(ctx, agentId);
            if (type === "toolcall_start" || event.type === "tool.completed") {
                this.#journal.append(
                    type === "toolcall_start" ? "message.created" : "message.updated",
                    {
                        agentId,
                        runId: requestedMessage.runId ?? underlyingRunId,
                        message: messageResource(requestedMessage),
                    },
                    event.occurredAt,
                );
            }
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
            for (const configuration of configurations) {
                this.#journal.append(
                    "message.created",
                    {
                        agentId,
                        runId: configuration.runId ?? runId,
                        message: messageResource(configuration),
                    },
                    configuration.at,
                );
                this.#announcedExecutionConfigurations.set(configuration.recordId, agentId);
                while (
                    this.#announcedExecutionConfigurations.size >
                    MAX_ANNOUNCED_EXECUTION_CONFIGURATIONS
                ) {
                    const oldest = this.#announcedExecutionConfigurations.keys().next();
                    if (!oldest.done) this.#announcedExecutionConfigurations.delete(oldest.value);
                }
            }
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
                    content: [...committed, ...content],
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

    /** Announce a Surface chat's new agent once, echoing the winning ensure request. */
    async #announceSurfaceChat(
        ctx: Context,
        agentId: string,
        mutationId: string | undefined,
    ): Promise<void> {
        if (this.#announcedAgentCreations.has(agentId)) return;
        const chat = await this.#surfaces?.chatForAgent(ctx, agentId);
        if (chat === undefined) return;
        // As for bots and tasks, initial slash-command discovery belongs to the settled snapshot.
        await this.#slashCommands.catalog(ctx, agentId);
        await this.#agentEventChains.get(agentId);
        await this.#queueAgentWork(ctx, agentId, undefined, async () => undefined);
        const agent = await this.#buildAgentResource(ctx, agentId, chat.workspaceId, null, {
            userVisible: true,
        });
        if (agent === undefined || this.#announcedAgentCreations.has(agentId)) return;
        boundedAdd(this.#announcedAgentCreations, agentId, MAX_ANNOUNCED_AGENT_CREATIONS);
        this.#journal.append("agent.created", {
            agent,
            ...(mutationId === undefined ? {} : { mutationId }),
        });
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
            if (ownership.taskId !== undefined) {
                throw new ApiError(
                    409,
                    "conflict",
                    "A task workspace already has its one permanent agent.",
                );
            }
            if (ownership.surfaceId !== undefined) {
                throw new ApiError(
                    409,
                    "conflict",
                    "A Surface chat workspace already has its one permanent agent.",
                );
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
                        ...(ownership.runnerId === undefined
                            ? {}
                            : { runnerId: ownership.runnerId }),
                        ...(ownership.docker === undefined ? {} : { docker: ownership.docker }),
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
                            parent: null,
                        });
                        if (ownership.childWorkspaceId === undefined) {
                            await this.#projects.attachAgent(txCtx, ownership.projectId, agent.id);
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
            /^\/v0\/agents\/([a-z][a-z0-9]*)\/(send|messages|question|abort|compact|read|archive|unarchive|reorder|subtask-reorder|draft|usage|mode|bootstrap|activity)$/.exec(
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
                if ((await this.#tasks?.forAgent(ctx, agentId)) !== undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "Archive or unarchive this agent through its task.",
                    );
                }
                if ((await this.#surfaces?.chatForAgent(ctx, agentId)) !== undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "A Surface's shared chat lasts as long as its Surface.",
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
                    try {
                        await this.#withMutationId(body.mutationId, async () => {
                            // A subtask's archival commits atomically with its abort, durable
                            // cleanup intent, and workspace archival through the subtasks module,
                            // exactly like archive_subtask. That module also refuses restoration.
                            if (
                                operation === "archive" &&
                                this.#subtasks?.isSubtask(config) !== true
                            ) {
                                await this.#abort.abort(ctx, agentId);
                                await this.#compute.archiveAgent(ctx, agentId);
                            }
                            await this.#updateAgentMetadata(ctx, agentId, {
                                archivedAt: operation === "archive" ? Date.now() : null,
                            });
                        });
                    } catch (error: unknown) {
                        if (error instanceof SubtaskInputError) {
                            throw new ApiError(409, "conflict", error.message);
                        }
                        throw error;
                    }
                }
                sendJson(response, 200, await this.#focusedAgentResponse(ctx, agentId));
                return true;
            }
            if (operation === "reorder" && request.method === "POST") {
                if ((await this.#bots.forAgent(ctx, agentId)) !== undefined) {
                    throw new ApiError(409, "conflict", "Reorder this agent through its bot.");
                }
                if ((await this.#tasks?.forAgent(ctx, agentId)) !== undefined) {
                    throw new ApiError(409, "conflict", "Reorder this agent through its task.");
                }
                if ((await this.#surfaces?.chatForAgent(ctx, agentId)) !== undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "A Surface's shared chat has no place among ordinary agents.",
                    );
                }
                await this.#assertUserControlledAgent(ctx, agentId);
                const body = await bodyAs(request, reorderBodySchema, "agent reorder");
                const before = await this.#requireAgentResource(ctx, agentId);
                if (before["orderKey"] === null) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "This agent does not belong to an ordered workspace list.",
                    );
                }
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
            if (operation === "subtask-reorder" && request.method === "POST") {
                const body = await bodyAs(request, reorderBodySchema, "subtask reorder");
                if ((await this.#agentSystem().config(ctx, agentId)) === undefined) {
                    throw notFound("The agent was not found.");
                }
                if (this.#subtasks === undefined) {
                    throw new ApiError(409, "conflict", "Only an active subtask can be reordered.");
                }
                const subtasks = this.#subtasks;
                try {
                    await this.#withMutationId(
                        body.mutationId,
                        async () => await subtasks.reorder(ctx, agentId, body.afterId),
                    );
                } catch (error: unknown) {
                    if (error instanceof SubtaskInputError) {
                        throw new ApiError(409, "conflict", error.message);
                    }
                    throw error;
                }
                sendJson(response, 200, await this.#focusedAgentResponse(ctx, agentId));
                return true;
            }
            if (operation === "draft" && request.method === "PUT") {
                await this.#assertUserControlledAgent(ctx, agentId);
                const body = await bodyAs(request, draftBodySchema, "agent draft");
                body.draft =
                    body.draft === null
                        ? null
                        : { ...requestedAgentMode(body.draft), text: body.draft.text };
                if (this.#team.enabled) {
                    const userId = teamUser(ctx)?.id;
                    if (userId === undefined)
                        throw new ApiError(401, "unauthorized", "Unauthorized");
                    const draft = await this.#withMutationId(
                        body.mutationId,
                        async () =>
                            (
                                await this.#team.saveDraft(ctx, agentId, userId, {
                                    draft: body.draft,
                                    ...(body.updatedAt === undefined
                                        ? {}
                                        : { updatedAt: body.updatedAt }),
                                })
                            ).draft,
                    );
                    sendJson(response, 200, { draft });
                    return true;
                }
                // Happy writes these same two fields from its own socket, so rejecting a stale
                // write and performing it — including the version bump's own read — is one
                // decision.
                await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await ctx.inTx(async (txCtx) => {
                            const config = await this.#agentSystem().config(txCtx, agentId);
                            if (config === undefined) throw notFound("The agent was not found.");
                            const storedAt =
                                typeof config.metadata?.["draftUpdatedAt"] === "number"
                                    ? config.metadata["draftUpdatedAt"]
                                    : -1;
                            if (body.updatedAt !== undefined && body.updatedAt < storedAt) return;
                            await this.#updateAgentMetadata(txCtx, agentId, {
                                draft: body.draft,
                                draftUpdatedAt: body.updatedAt ?? Date.now(),
                            });
                        }),
                );
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
        const toolCallMedia =
            /^\/v0\/agents\/([a-z][a-z0-9]*)\/tool-calls\/([a-z][a-z0-9]*)\/media\/(0|[1-9][0-9]{0,8})$/.exec(
                url.pathname,
            );
        if (toolCallMedia !== null && request.method === "GET") {
            const agentId = toolCallMedia[1] as string;
            await this.#requireAgentResource(ctx, agentId);
            const stored = await this.#chatMedia?.storedItem(
                ctx,
                agentId,
                toolCallMedia[2] as string,
                Number(toolCallMedia[3]),
            );
            if (stored === undefined) throw notFound("The tool call has no such media.");
            await sendStoredFile(request, response, {
                contentPath: stored.contentPath,
                sha256: stored.item.sha256,
                size: stored.item.size,
                mimeType: stored.item.mimeType,
                name: stored.item.name,
                // An item's snapshot is taken once, so the same URL never names other bytes.
                cacheControl: "private, max-age=31536000, immutable",
            });
            return true;
        }
        const slashCommandImage =
            /^\/v0\/agents\/([a-z][a-z0-9]*)\/slash-commands\/([^/]+)\/image$/.exec(url.pathname);
        if (slashCommandImage !== null && request.method === "GET") {
            const agentId = slashCommandImage[1] as string;
            await this.#requireAgentResource(ctx, agentId);
            const name = decodePathSegment(slashCommandImage[2] as string, "slash command name");
            const image = await this.#slashCommands.image(ctx, agentId, name);
            if (image === undefined) throw notFound("The slash command has no image.");
            setImageCacheHeaders(response);
            if (request.headers["if-none-match"] === image.etag) {
                response.writeHead(304, {
                    etag: image.etag,
                });
                response.end();
                return true;
            }
            response.writeHead(200, {
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
            body.mode = requestedAgentMode(body.mode);
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
        body.mode = requestedAgentMode(body.mode);
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
                    ? null
                    : selected.serviceTiers?.find(
                          (candidate) => candidate === body.mode.serviceTier,
                      );
            if (serviceTier === undefined) {
                throw invalidRequest("The selected service tier is unavailable.");
            }
            const content = [{ type: "text" as const, text: body.text }, ...(body.content ?? [])];
            const userId = this.#team.enabled ? teamUser(ctx)?.id : undefined;
            const profile = decodeRequestProfile(body.profile);
            const options: AgentBaseMessageOptions = {
                id,
                provider: body.mode.providerId,
                model: body.mode.modelId,
                effort,
                // A null mode means the provider's ordinary tier. Send the explicit clear rather
                // than omitting, because an omitted tier keeps whatever the agent last persisted —
                // including the retired "default" sentinel that Codex rejects on every turn.
                serviceTier,
                permissionMode: body.mode.permissionMode,
                profile,
                metadata: {
                    ...USER_MESSAGE_ORIGIN_METADATA,
                    ...(userId === undefined ? {} : { userId }),
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
                blocks: this.#history.inputBlocks(content),
                ...(userId === undefined ? {} : { userId }),
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
                    await this.#assertUserControlledAgent(txCtx, agentId);
                    await this.#history.queuePending(txCtx, pending);
                    if (delivery === "steer") {
                        await agents.steer(txCtx, agentId, { role: "user", content }, options);
                    } else {
                        await agents.send(txCtx, agentId, { role: "user", content }, options);
                    }
                    afterCommit(txCtx, (postCommitCtx) =>
                        this.#scheduling?.interruptWaits(postCommitCtx, agentId),
                    );
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
        await ctx.span("api.messages", async (ctx) => {
            // Capture first so a concurrent message change is either visible in history or replayed
            // after this cursor. Stable identities and offset-addressed deltas make overlap harmless.
            const cursor = this.#journal.cursor();
            const before = optionalApiId(url.searchParams.get("before"), "run");
            const after = optionalApiId(url.searchParams.get("after"), "message");
            if (before !== undefined && after !== undefined) {
                throw invalidRequest(
                    "History cannot page before a run and after a message together.",
                );
            }
            const limit = integerParameter(url.searchParams.get("limit"), 50, 1, 500);
            const omitToolData = booleanParameter(url.searchParams.get("omitToolData"), false);
            await ctx.span("api.messages.agent", (ctx) => this.#requireAgent(ctx, agentId));
            const page = await ctx.span("api.messages.history", (ctx) =>
                this.#history.runs(ctx, agentId, {
                    ...(before === undefined ? {} : { before }),
                    ...(after === undefined ? {} : { after }),
                    limit,
                }),
            );
            const runUsage = await ctx.span("api.messages.usage", (ctx) =>
                this.#usage.readRuns(
                    ctx,
                    agentId,
                    page.runs.map((run) => run.id),
                ),
            );
            const runs = ctx.span("api.messages.project", () =>
                page.runs.map((run, index) => {
                    const usage = runUsage[index] as UsageRunSummary;
                    return {
                        id: run.id,
                        status: run.status,
                        reason: run.reason,
                        startedAt: run.startedAt,
                        endedAt: run.endedAt,
                        usage: usage.usage,
                        costUsd: usage.costUsd,
                        messages: run.messages
                            .filter((message) => !messageHiddenFromUser(message))
                            .map((message) =>
                                projectMessageDiagnostics(
                                    messageResource(message, { omitToolData }),
                                    this.#canDiscloseCredentialSource(ctx),
                                ),
                            ),
                    };
                }),
            );
            ctx.span("api.messages.serialize", () =>
                sendJson(response, 200, {
                    cursor,
                    runs,
                    hasMore: page.hasMore,
                }),
            );
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
        if (this.#team.enabled) {
            const userId = teamUser(ctx)?.id;
            if (userId === undefined) throw new ApiError(401, "unauthorized", "Unauthorized");
            return await this.#team.draft(ctx, agentId, userId);
        }
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

    /** Check that an agent exists as a resource without projecting its activity and subtasks. */
    async #requireAgent(ctx: Context, agentId: string): Promise<void> {
        if ((await this.#agentSystem().config(ctx, agentId)) === undefined) {
            throw notFound("The agent was not found.");
        }
        if ((await this.#workspaceIdForAgent(ctx, agentId)) === undefined) {
            throw notFound("The agent was not found.");
        }
    }

    async #requireAgentResource(ctx: Context, agentId: string): Promise<Record<string, unknown>> {
        const config = await this.#agentSystem().config(ctx, agentId);
        if (config === undefined) {
            throw notFound("The agent was not found.");
        }
        const workspaceId = await this.#workspaceIdForAgent(ctx, agentId);
        if (workspaceId === undefined) throw notFound("The agent was not found.");
        const resource = await this.#buildAgentResource(
            ctx,
            agentId,
            workspaceId,
            await this.#agentOrderKey(ctx, agentId),
            { config },
        );
        if (resource === undefined) throw notFound("The agent was not found.");
        return resource;
    }

    async #buildAgentResource(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        orderKey?: string | null,
        options: {
            readonly config?: AgentConfig;
            readonly userVisible?: boolean;
            readonly subtaskDepth?: number;
            readonly latestEvent?: LatestAgentEvent | null;
        } = {},
    ): Promise<Record<string, unknown> | undefined> {
        // Read the version before the scheduled interval, so a concurrent transition cannot
        // label an old interval with a newer version and hide its correcting event.
        const latestEvent =
            options.latestEvent === undefined
                ? ((await this.#events.latestAgentEvent(ctx, agentId)) ?? null)
                : options.latestEvent;
        const config = options.config ?? (await this.#agentSystem().config(ctx, agentId));
        if (config === undefined) return undefined;
        // Owner-series entries and bot and task projections already establish visibility. Only an
        // unscoped resource needs a bot or task lookup; never infer ancestry from owner membership.
        const userVisible =
            this.#subtasks?.isSubtask(config) === true ||
            (options.userVisible ??
                (orderKey != null ||
                    (await this.#bots.forAgent(ctx, agentId)) !== undefined ||
                    (await this.#tasks?.forAgent(ctx, agentId)) !== undefined ||
                    (await this.#surfaces?.chatForAgent(ctx, agentId)) !== undefined));
        const children = await this.#agentSystem().childOf(ctx, agentId);
        const [processes, questions, runningSubagents, activeRunId, subtasks] = await Promise.all([
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
            this.#subtaskResources(ctx, children, options.subtaskDepth ?? 0),
        ]);
        const wait =
            activeRunId === undefined
                ? null
                : ((await this.#scheduling?.readActiveWait(ctx, agentId)) ?? null);
        return await agentResource(ctx, this.#agentSystem(), this.#events, agentId, workspaceId, {
            config,
            children,
            latestEvent,
            ...(orderKey === undefined ? {} : { orderKey }),
            userVisible,
            subtask: this.#subtasks?.isSubtask(config) ?? false,
            subtasks,
            subtaskOrderKey: this.#subtasks?.siblingOrderKey(config) ?? null,
            pendingQuestionId: questions.requests[0]?.id ?? null,
            runningProcesses: processes.filter((process) => process.status === "running").length,
            runningSubagents,
            working: activeRunId !== undefined,
            wait,
        });
    }

    async #subtaskResources(
        ctx: Context,
        children: readonly string[],
        depth: number,
    ): Promise<Record<string, unknown>[]> {
        if (this.#subtasks === undefined || depth >= 2) return [];
        const active: { id: string; config: AgentConfig; latestEvent: LatestAgentEvent | null }[] =
            [];
        for (const id of children) {
            // Read the version before the state. A change committing between the two reads then
            // pairs newer state with an older version, which that change's own event corrects;
            // the reverse would label stale state, such as an old sibling key, with a new version.
            const latestEvent = (await this.#events.latestAgentEvent(ctx, id)) ?? null;
            const config = await this.#agentSystem().config(ctx, id);
            if (
                config !== undefined &&
                this.#subtasks.isSubtask(config) &&
                agentArchivedAt(config) === null
            ) {
                active.push({ id, config, latestEvent });
            }
        }
        const subtasks = this.#subtasks;
        return await Promise.all(
            subtasks.sortSiblings(active).map(async ({ id, config, latestEvent }) => {
                const workspaceId = await this.#workspaceIdForAgent(ctx, id);
                if (workspaceId === undefined)
                    throw notFound("The subtask workspace was not found.");
                return (await this.#buildAgentResource(
                    ctx,
                    id,
                    workspaceId,
                    await this.#agentOrderKey(ctx, id),
                    {
                        config,
                        latestEvent,
                        subtaskDepth: depth + 1,
                    },
                ))!;
            }),
        );
    }

    async #agentOrderKey(ctx: Context, agentId: string): Promise<string | null> {
        if ((await this.#bots.forAgent(ctx, agentId)) !== undefined) return null;
        if ((await this.#tasks?.forAgent(ctx, agentId)) !== undefined) return null;
        if ((await this.#surfaces?.chatForAgent(ctx, agentId)) !== undefined) return null;
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
            const task = await this.#tasks?.forAgent(ctx, current);
            if (task !== undefined) return task.workspaceId;
            const chat = await this.#surfaces?.chatForAgent(ctx, current);
            if (chat !== undefined) return chat.workspaceId;
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
        const config = await agents.config(ctx, agentId);
        if (config === undefined) {
            throw notFound("The agent was not found.");
        }
        if ((await agents.parentOf(ctx, agentId)) !== null && !this.#subtasks?.isSubtask(config)) {
            throw new ApiError(
                409,
                "conflict",
                "Agents managed by another agent are read-only through this API.",
            );
        }
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

    #handleEventPull(ctx: Context, url: URL, response: ServerResponse): void {
        const after = optionalCursor(url.searchParams.get("after"));
        const until = optionalCursor(url.searchParams.get("until"));
        const limit = integerParameter(url.searchParams.get("limit"), 100, 1, 10_000);
        const replay = this.#journal.replay(after, until, limit);
        if (replay === undefined) {
            throw new ApiError(409, "cursor_unavailable", "Event cursor is unavailable.", {
                cursor: this.#journal.cursor(),
            });
        }
        sendJson(response, 200, {
            ...replay,
            events: replay.events
                .filter((event) => this.#journal.visibleTo(event, teamUser(ctx)?.id))
                .map((event) =>
                    projectEventDiagnostics(event, this.#canDiscloseCredentialSource(ctx)),
                ),
        });
    }

    #handleEventStream(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): void {
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
        // Live document frames address a stream by this name; journal events never use it.
        const streamId = this.#surfaces === undefined ? undefined : createId();
        if (streamId !== undefined)
            this.#eventStreams.set(streamId, { writer, userId: teamUser(ctx)?.id });
        let heartbeat: NodeJS.Timeout | undefined;
        let unsubscribe = (): void => undefined;
        void writer.done.then(() => {
            if (heartbeat !== undefined) clearInterval(heartbeat);
            unsubscribe();
            this.#streams.delete(writer);
            if (streamId !== undefined) {
                this.#eventStreams.delete(streamId);
                this.#surfaces?.closeDocumentStream(streamId);
            }
        });
        unsubscribe = this.#journal.subscribe((event) => {
            if (writer.closed) return;
            if (!this.#journal.visibleTo(event, teamUser(ctx)?.id)) return;
            if (replaying) {
                pending.push(event);
                return;
            }
            writer.write(
                sseEventFrame(
                    projectEventDiagnostics(event, this.#canDiscloseCredentialSource(ctx)),
                ),
            );
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
                    ...(streamId === undefined ? {} : { streamId }),
                })}\n\n`,
            )
        ) {
            return;
        }
        for (const event of replay) {
            if (!this.#journal.visibleTo(event, teamUser(ctx)?.id)) continue;
            if (
                !writer.write(
                    sseEventFrame(
                        projectEventDiagnostics(event, this.#canDiscloseCredentialSource(ctx)),
                    ),
                )
            )
                return;
        }
        replaying = false;
        for (const event of pending) {
            if (
                event.cursor > current &&
                !writer.write(
                    sseEventFrame(
                        projectEventDiagnostics(event, this.#canDiscloseCredentialSource(ctx)),
                    ),
                )
            )
                return;
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
                        ...(body.runnerId === undefined ? {} : { runnerId: body.runnerId }),
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
                        ...(body.runnerId === undefined ? {} : { runnerId: body.runnerId }),
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
            const defaultWorkspaceCompute = storedWorkspaceCompute(
                body.defaultWorkspaceCompute,
                this.#projects.compute(current),
            );
            await this.#withMutationId(
                body.mutationId,
                async () =>
                    await this.#projects.updateSettings(ctx, {
                        projectId,
                        expectedVersion: current.version,
                        settings: {
                            defaultWorkspaceCompute,
                            // Blank is nothing to say; the text itself is kept as typed.
                            ...(body.workspaceInitialPrompt === undefined ||
                            body.workspaceInitialPrompt === null ||
                            body.workspaceInitialPrompt.trim().length === 0
                                ? {}
                                : { workspaceInitialPrompt: body.workspaceInitialPrompt }),
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
            setImageCacheHeaders(response);
            if (request.headers["if-none-match"] === asset.etag) {
                response.writeHead(304, {
                    etag: asset.etag,
                });
                response.end();
                return true;
            }
            response.writeHead(200, {
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
                setImageCacheHeaders(response);
                if (request.headers["if-none-match"] === asset.etag) {
                    response.writeHead(304, { etag: asset.etag });
                    response.end();
                    return true;
                }
                response.writeHead(200, {
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

    async #handleSurfaceRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        const surfaces = this.#surfaces;
        if (surfaces === undefined || !url.pathname.startsWith("/v0/surfaces")) return false;
        try {
            if (url.pathname === "/v0/surfaces") {
                if (request.method === "GET") {
                    const cursor = this.#journal.cursor();
                    sendJson(response, 200, { surfaces: await surfaces.list(ctx), cursor });
                    return true;
                }
                if (request.method === "POST") {
                    const body = await bodyAs(
                        request,
                        createSurfaceRequestSchema,
                        "Surface creation",
                        14 * 1024 * 1024,
                    );
                    sendJson(response, 201, {
                        surface: await surfaces.create(ctx, body, await surfaces.owner(ctx)),
                    });
                    return true;
                }
                return false;
            }
            const edited = /^\/v0\/surfaces\/([a-z][a-z0-9]*)$/.exec(url.pathname);
            if (edited !== null) {
                const id = edited[1]!;
                if (request.method !== "PATCH" || !Value.Check(surfaceIdSchema, id)) return false;
                const body = await bodyAs(
                    request,
                    updateSurfaceRequestSchema,
                    "Surface edit",
                    14 * 1024 * 1024,
                );
                // Only onboarded people may edit shared Surfaces.
                await surfaces.owner(ctx);
                sendJson(response, 200, { surface: await surfaces.update(ctx, id, body) });
                return true;
            }
            const membership =
                /^\/v0\/surfaces\/([a-z][a-z0-9]*)\/(join|leave|reorder|image|chat)$/.exec(
                    url.pathname,
                );
            if (membership !== null) {
                const id = membership[1]!;
                if (!Value.Check(surfaceIdSchema, id)) return false;
                const operation = membership[2]!;
                if (operation === "image" && request.method === "GET") {
                    const image = await surfaces.image(ctx, id);
                    setImageCacheHeaders(response);
                    response.setHeader("etag", image.etag);
                    if (request.headers["if-none-match"] === image.etag) {
                        response.writeHead(304);
                        response.end();
                        return true;
                    }
                    response.writeHead(200, { "content-type": "image/webp" });
                    response.end(Buffer.from(image.data, "base64"));
                    return true;
                }
                if (request.method !== "POST" || operation === "image") return false;
                if (operation === "chat") {
                    const body = await optionalBodyAs(
                        request,
                        ensureSurfaceChatRequestSchema,
                        "Surface chat",
                        2048,
                    );
                    await surfaces.requestChat(ctx, id, body.mutationId);
                    const { surface, chat } = await surfaces.awaitChat(ctx, id);
                    const agent = await this.#buildAgentResource(
                        ctx,
                        chat.agentId,
                        chat.workspaceId,
                        null,
                        { userVisible: true },
                    );
                    if (agent === undefined) throw new Error("The Surface chat has no agent.");
                    sendJson(response, 200, { surface, agent });
                    return true;
                }
                if (operation === "reorder") {
                    const body = await bodyAs(
                        request,
                        reorderSurfaceRequestSchema,
                        "Surface reorder",
                    );
                    sendJson(response, 200, {
                        surface: await surfaces.changeMember(
                            ctx,
                            id,
                            await surfaces.owner(ctx),
                            "reorder",
                            body.afterId,
                            body.mutationId,
                        ),
                    });
                } else {
                    const body = await optionalBodyAs(
                        request,
                        surfaceMemberRequestSchema,
                        "Surface membership",
                        2048,
                    );
                    sendJson(response, 200, {
                        surface: await surfaces.changeMember(
                            ctx,
                            id,
                            await surfaces.owner(ctx),
                            operation === "join" ? "join" : "leave",
                            null,
                            body.mutationId,
                        ),
                    });
                }
                return true;
            }
            const documentMatch =
                /^\/v0\/surfaces\/document\/([a-z][a-z0-9]*)(?:\/(state|updates|versions|subscribe|unsubscribe|presence)(?:\/([^/]+))?)?$/.exec(
                    url.pathname,
                );
            if (documentMatch !== null) {
                const surfaceId = documentMatch[1]!;
                if (!Value.Check(surfaceIdSchema, surfaceId)) return false;
                const route = documentMatch[2];
                const selectedVersion = documentMatch[3];
                if (selectedVersion !== undefined && route !== "versions") return false;
                if (route === undefined && request.method === "PUT") {
                    // Older clients saved Markdown here; they stop on 405 instead of retrying.
                    response.setHeader("allow", "GET");
                    throw new ApiError(
                        405,
                        "method_not_allowed",
                        "Editing this document needs a newer Happy.",
                    );
                }
                if (route === undefined && request.method === "GET") {
                    const { seq } = documentQuery(url, ["seq"]);
                    const cursor = this.#journal.cursor();
                    const { document } = await surfaces.document(ctx, surfaceId, seq);
                    sendJson(response, 200, { document, cursor });
                    return true;
                }
                if (route === "state" && request.method === "GET") {
                    const { seq, stateVector } = documentQuery(url, ["seq", "stateVector"]);
                    sendJson(
                        response,
                        200,
                        await surfaces.documentState(ctx, surfaceId, {
                            ...(seq === undefined ? {} : { seq }),
                            ...(stateVector === undefined ? {} : { stateVector }),
                        }),
                    );
                    return true;
                }
                if (route === "updates" && request.method === "POST") {
                    const body = await bodyAs(
                        request,
                        sendSurfaceDocumentUpdateRequestSchema,
                        "document change",
                        2 * 1024 * 1024,
                    );
                    sendJson(
                        response,
                        200,
                        await surfaces.changeDocument(
                            ctx,
                            surfaceId,
                            body.update,
                            { userId: await surfaces.owner(ctx), agentId: null },
                            body.mutationId,
                        ),
                    );
                    return true;
                }
                if (route === "updates" && request.method === "GET") {
                    const { afterSeq, limit } = documentQuery(url, ["afterSeq", "limit"]);
                    if (limit !== undefined && (limit < 1 || limit > 200))
                        throw invalidRequest("The document change page is invalid.");
                    sendJson(
                        response,
                        200,
                        await surfaces.documentChanges(ctx, surfaceId, afterSeq ?? 0, limit ?? 100),
                    );
                    return true;
                }
                if (route === "versions" && request.method === "GET") {
                    if (selectedVersion !== undefined) {
                        documentQuery(url, []);
                        sendJson(response, 200, {
                            revision: await surfaces.getDocumentVersion(
                                ctx,
                                surfaceId,
                                decodePathSegment(selectedVersion, "document revision"),
                            ),
                        });
                        return true;
                    }
                    const after = url.searchParams.getAll("afterVersion");
                    const limits = url.searchParams.getAll("limit");
                    const limit = limits[0] === undefined ? 100 : Number(limits[0]);
                    if (
                        [...url.searchParams.keys()].some(
                            (key) => key !== "afterVersion" && key !== "limit",
                        ) ||
                        after.length > 1 ||
                        limits.length > 1 ||
                        (limits[0] !== undefined &&
                            !Value.Check(Type.String({ pattern: "^[1-9][0-9]*$" }), limits[0])) ||
                        !Value.Check(Type.Integer({ minimum: 1, maximum: 200 }), limit)
                    )
                        throw invalidRequest("The document history page is invalid.");
                    sendJson(
                        response,
                        200,
                        await surfaces.documentVersions(ctx, surfaceId, after[0], limit),
                    );
                    return true;
                }
                if (route === "presence" && request.method === "POST") {
                    const body = await bodyAs(
                        request,
                        sendSurfaceDocumentPresenceRequestSchema,
                        "document presence",
                        2 * 1024 * 1024,
                    );
                    this.#requireOwnEventStream(ctx, body.streamId);
                    await surfaces.shareDocumentPresence(
                        ctx,
                        surfaceId,
                        body.streamId,
                        body.awarenessClientId,
                        body.update,
                    );
                    sendJson(response, 200, {});
                    return true;
                }
                if (
                    (route === "subscribe" || route === "unsubscribe") &&
                    request.method === "POST"
                ) {
                    const body = await bodyAs(
                        request,
                        surfaceDocumentSubscriptionRequestSchema,
                        "document subscription",
                    );
                    this.#requireOwnEventStream(ctx, body.streamId);
                    if (route === "subscribe")
                        sendJson(
                            response,
                            200,
                            await surfaces.subscribeDocument(ctx, surfaceId, body.streamId),
                        );
                    else {
                        await surfaces.unsubscribeDocument(ctx, surfaceId, body.streamId);
                        sendJson(response, 200, {});
                    }
                    return true;
                }
                return false;
            }
            const monitorMatch = /^\/v0\/surfaces\/system-monitor\/([a-z][a-z0-9]*)$/.exec(
                url.pathname,
            );
            if (monitorMatch !== null) {
                const surfaceId = monitorMatch[1]!;
                if (request.method !== "GET" || !Value.Check(surfaceIdSchema, surfaceId))
                    return false;
                sendJson(response, 200, await surfaces.systemMonitor(ctx, surfaceId));
                return true;
            }
            const calendarMatch =
                /^\/v0\/surfaces\/calendar\/([a-z][a-z0-9]*)(?:\/([a-z][a-z0-9]*)(?:\/(versions)(?:\/([^/]+))?)?)?$/.exec(
                    url.pathname,
                );
            if (calendarMatch !== null)
                return await this.#handleCalendarRoute(ctx, request, response, url, calendarMatch);
            const match =
                /^\/v0\/surfaces\/todo\/([a-z][a-z0-9]*)(?:\/([a-z][a-z0-9]*)(?:\/(reorder|versions)(?:\/([^/]+))?)?)?$/.exec(
                    url.pathname,
                );
            if (match === null) return false;
            const surfaceId = match[1]!;
            if (!Value.Check(surfaceIdSchema, surfaceId)) return false;
            const todoId = match[2];
            const action = match[3];
            const selectedVersion = match[4];
            const actor = { userId: await surfaces.owner(ctx), agentId: null };
            if (todoId === undefined) {
                if (request.method === "GET") {
                    const scopes = url.searchParams.getAll("scope");
                    const scope = scopes[0] ?? "active";
                    if (scopes.length > 1 || !Value.Check(todoListScopeSchema, scope))
                        throw invalidRequest("The todo list scope is invalid.");
                    const cursor = this.#journal.cursor();
                    sendJson(response, 200, {
                        todos: await surfaces.listTodos(ctx, surfaceId, scope),
                        cursor,
                    });
                    return true;
                }
                if (request.method === "POST") {
                    const body = await bodyAs(request, createTodoRequestSchema, "todo creation");
                    sendJson(response, 201, {
                        todo: await surfaces.createTodo(ctx, surfaceId, body, actor, actor.userId),
                    });
                    return true;
                }
                return false;
            }
            if (request.method === "GET") {
                if (action === undefined) {
                    sendJson(response, 200, {
                        todo: await surfaces.getTodo(ctx, surfaceId, todoId),
                    });
                    return true;
                }
                if (action !== "versions") return false;
                if (selectedVersion !== undefined) {
                    sendJson(response, 200, {
                        revision: await surfaces.getVersion(
                            ctx,
                            surfaceId,
                            todoId,
                            decodePathSegment(selectedVersion, "todo revision"),
                        ),
                    });
                    return true;
                }
                const after = url.searchParams.getAll("afterVersion");
                const limits = url.searchParams.getAll("limit");
                const limit = limits[0] === undefined ? 100 : Number(limits[0]);
                if (
                    after.length > 1 ||
                    limits.length > 1 ||
                    (limits[0] !== undefined &&
                        !Value.Check(Type.String({ pattern: "^[1-9][0-9]*$" }), limits[0])) ||
                    !Value.Check(Type.Integer({ minimum: 1, maximum: 200 }), limit)
                )
                    throw invalidRequest("The todo history page is invalid.");
                sendJson(
                    response,
                    200,
                    await surfaces.versions(ctx, surfaceId, todoId, after[0], limit),
                );
                return true;
            }
            if (selectedVersion !== undefined) return false;
            const current = await surfaces.getTodo(ctx, surfaceId, todoId);
            const version = requireIfMatch(request, current.version, {
                currentVersion: current.version,
                todo: current,
            });
            let todo;
            if (request.method === "PATCH" && action === undefined) {
                const body = await bodyAs(request, updateTodoRequestSchema, "todo update");
                todo = await surfaces.mutateTodo(
                    ctx,
                    surfaceId,
                    todoId,
                    version,
                    "update",
                    body,
                    actor,
                    body.mutationId,
                );
            } else if (request.method === "DELETE" && action === undefined) {
                const body = await optionalBodyAs(
                    request,
                    todoMutationRequestSchema,
                    "todo deletion",
                    2048,
                );
                todo = await surfaces.mutateTodo(
                    ctx,
                    surfaceId,
                    todoId,
                    version,
                    "delete",
                    {},
                    actor,
                    body.mutationId,
                );
            } else if (request.method === "POST" && action === "reorder") {
                const body = await bodyAs(request, reorderTodoRequestSchema, "todo reorder");
                todo = await surfaces.mutateTodo(
                    ctx,
                    surfaceId,
                    todoId,
                    version,
                    "reorder",
                    body,
                    actor,
                    body.mutationId,
                );
            } else return false;
            sendJson(response, 200, { todo });
            return true;
        } catch (error) {
            if (!(error instanceof SurfaceError)) throw error;
            throw new ApiError(
                error.code === "not_found"
                    ? 404
                    : error.code === "conflict"
                      ? 409
                      : error.code === "forbidden"
                        ? 403
                        : error.code === "not_initialized"
                          ? 503
                          : 400,
                error.code,
                error.message,
                error.current === undefined
                    ? {}
                    : {
                          ...error.current,
                          currentVersion: ("todo" in error.current
                              ? error.current.todo
                              : error.current.event
                          ).version,
                      },
            );
        }
    }

    /** `/v0/surfaces/calendar/:surfaceId` routes; Surface errors map in the caller's handler. */
    async #handleCalendarRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        match: RegExpExecArray,
    ): Promise<boolean> {
        const surfaces = this.#surfaces!;
        const surfaceId = match[1]!;
        if (!Value.Check(surfaceIdSchema, surfaceId)) return false;
        const eventId = match[2];
        const action = match[3];
        const selectedVersion = match[4];
        const actor = { userId: await surfaces.owner(ctx), agentId: null };
        if (eventId === undefined) {
            if (request.method === "GET") {
                const single = (name: string) => {
                    const values = url.searchParams.getAll(name);
                    if (values.length !== 1)
                        throw invalidRequest(`The calendar range needs exactly one ${name}.`);
                    return values[0]!;
                };
                const instant = (name: string) => {
                    const value = single(name);
                    if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value))
                        throw invalidRequest(`The calendar range ${name} is invalid.`);
                    return Number(value);
                };
                const range = {
                    from: instant("from"),
                    to: instant("to"),
                    timeZone: single("timeZone"),
                };
                const cursor = this.#journal.cursor();
                sendJson(response, 200, {
                    ...(await surfaces.listCalendar(ctx, surfaceId, range)),
                    cursor,
                });
                return true;
            }
            if (request.method === "POST") {
                const body = await bodyAs(
                    request,
                    createCalendarEventRequestSchema,
                    "calendar event creation",
                );
                sendJson(response, 201, {
                    event: await surfaces.createCalendarEvent(
                        ctx,
                        surfaceId,
                        body,
                        actor,
                        actor.userId,
                    ),
                });
                return true;
            }
            return false;
        }
        if (request.method === "GET") {
            if (action === undefined) {
                sendJson(response, 200, {
                    event: await surfaces.getCalendarEvent(ctx, surfaceId, eventId),
                });
                return true;
            }
            if (selectedVersion !== undefined) {
                sendJson(response, 200, {
                    revision: await surfaces.getCalendarEventVersion(
                        ctx,
                        surfaceId,
                        eventId,
                        decodePathSegment(selectedVersion, "calendar event revision"),
                    ),
                });
                return true;
            }
            const after = url.searchParams.getAll("afterVersion");
            const limits = url.searchParams.getAll("limit");
            const limit = limits[0] === undefined ? 100 : Number(limits[0]);
            if (
                after.length > 1 ||
                limits.length > 1 ||
                (limits[0] !== undefined &&
                    !Value.Check(Type.String({ pattern: "^[1-9][0-9]*$" }), limits[0])) ||
                !Value.Check(Type.Integer({ minimum: 1, maximum: 200 }), limit)
            )
                throw invalidRequest("The calendar event history page is invalid.");
            sendJson(
                response,
                200,
                await surfaces.calendarEventVersions(ctx, surfaceId, eventId, after[0], limit),
            );
            return true;
        }
        if (action !== undefined) return false;
        const current = await surfaces.getCalendarEvent(ctx, surfaceId, eventId);
        const version = requireIfMatch(request, current.version, {
            currentVersion: current.version,
            event: current,
        });
        let event;
        if (request.method === "PATCH") {
            const body = await bodyAs(
                request,
                updateCalendarEventRequestSchema,
                "calendar event update",
            );
            event = await surfaces.mutateCalendarEvent(
                ctx,
                surfaceId,
                eventId,
                version,
                body,
                actor,
                body.mutationId,
            );
        } else if (request.method === "DELETE") {
            const body = await optionalBodyAs(
                request,
                calendarEventMutationRequestSchema,
                "calendar event deletion",
                2048,
            );
            event = await surfaces.mutateCalendarEvent(
                ctx,
                surfaceId,
                eventId,
                version,
                "delete",
                actor,
                body.mutationId,
            );
        } else return false;
        sendJson(response, 200, { event });
        return true;
    }

    /** Only the person who opened an event stream may route live document frames to it. */
    #requireOwnEventStream(ctx: Context, streamId: string): void {
        const stream = this.#eventStreams.get(streamId);
        if (stream === undefined || stream.writer.closed || stream.userId !== teamUser(ctx)?.id)
            throw new ApiError(404, "not_found", "The event stream was not found.");
    }

    async #handleTaskRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        const tasks = this.#tasks;
        if (tasks === undefined || !url.pathname.startsWith("/v0/tasks")) return false;
        if (request.method === "GET" && url.pathname === "/v0/tasks") {
            const scopes = url.searchParams.getAll("scope");
            const scope = scopes[0] ?? "all";
            if (scopes.length > 1 || !Value.Check(taskListScopeSchema, scope)) {
                throw invalidRequest('The task list scope must be "all" or "joined".');
            }
            const joined = await tasks.listForMember(ctx, this.#taskMember(ctx));
            const listed = scope === "all" ? await tasks.list(ctx) : joined.map(({ task }) => task);
            sendJson(response, 200, {
                tasks: await Promise.all(
                    listed.map(async (task) => await this.#taskResource(ctx, task)),
                ),
                memberships: joined.map(({ membership }) => taskMembershipResource(membership)),
            });
            return true;
        }
        if (request.method === "POST" && url.pathname === "/v0/tasks") {
            const body = await bodyAs(request, createTaskRequestSchema, "task creation");
            const { mutationId } = body;
            // The person creating the task owns it; on a standalone installation nobody is named.
            const owner = this.#team.enabled ? teamUser(ctx)?.id : undefined;
            this.#taskMember(ctx);
            const creation = await this.#withMutationId(mutationId, async () => {
                try {
                    return await tasks.createWithResult(ctx, {
                        ...(body.id === undefined ? {} : { id: body.id }),
                        ...(body.workspaceId === undefined
                            ? {}
                            : { workspaceId: body.workspaceId }),
                        ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
                        ...(body.name === undefined ? {} : { name: body.name }),
                        ...(body.folderName === undefined ? {} : { folderName: body.folderName }),
                        ...(owner === undefined ? {} : { ownerUserId: owner }),
                    });
                } catch (error) {
                    if (error instanceof TaskConflictError && error.task !== undefined) {
                        const task = await this.#taskResource(ctx, error.task);
                        throw new ApiError(409, "conflict", error.message, {
                            currentVersion: task["version"],
                            task,
                        });
                    }
                    throw error;
                }
            });
            const { task, created } = creation;
            // As for bots: initial slash-command discovery belongs to the settled agent snapshot,
            // and a retry joins creation work already running instead of starting it again.
            if (created) await this.#slashCommands.catalog(ctx, task.agentId);
            await this.#agentEventChains.get(task.agentId);
            await this.#queueAgentWork(ctx, task.agentId, undefined, async () => undefined);
            const resource = await this.#taskResponse(ctx, task);
            if (created && !this.#announcedAgentCreations.has(task.agentId)) {
                boundedAdd(
                    this.#announcedAgentCreations,
                    task.agentId,
                    MAX_ANNOUNCED_AGENT_CREATIONS,
                );
                this.#journal.append("agent.created", {
                    agent: (resource["task"] as Record<string, unknown>)["agent"],
                    ...(mutationId === undefined ? {} : { mutationId }),
                });
            }
            sendJson(response, 201, resource);
            return true;
        }
        const direct = /^\/v0\/tasks\/([a-z][a-z0-9]*)$/.exec(url.pathname);
        if (direct !== null && request.method === "GET") {
            const task = await tasks.get(ctx, direct[1] as string);
            if (task === undefined) throw notFound("The task was not found.");
            sendJson(response, 200, await this.#taskResponse(ctx, task));
            return true;
        }
        if (direct !== null && request.method === "PATCH") {
            const taskId = direct[1] as string;
            const body = await bodyAs(request, renameTaskRequestSchema, "task rename");
            const current = await tasks.get(ctx, taskId);
            if (current === undefined) throw notFound("The task was not found.");
            const resource = await this.#taskResource(ctx, current);
            requireIfMatch(request, resource["version"], {
                currentVersion: resource["version"],
                task: resource,
            });
            try {
                await this.#withMutationId(
                    body.mutationId,
                    async () => await tasks.rename(ctx, taskId, body.name, current.version),
                );
            } catch (error: unknown) {
                if (!(error instanceof TaskConflictError)) throw error;
                const latest = await tasks.get(ctx, taskId);
                if (latest === undefined) throw notFound("The task was not found.");
                const task = await this.#taskResource(ctx, latest);
                throw new ApiError(409, "conflict", error.message, {
                    currentVersion: task["version"],
                    task,
                });
            }
            const renamed = await tasks.get(ctx, taskId);
            if (renamed === undefined) throw notFound("The task was not found.");
            sendJson(response, 200, await this.#taskResponse(ctx, renamed));
            return true;
        }
        const action =
            /^\/v0\/tasks\/([a-z][a-z0-9]*)\/(join|leave|reorder|archive|unarchive)$/.exec(
                url.pathname,
            );
        if (action === null || request.method !== "POST") return false;
        const taskId = action[1] as string;
        const operation = action[2] as "join" | "leave" | "reorder" | "archive" | "unarchive";
        const member = this.#taskMember(ctx);
        try {
            if (operation === "join" || operation === "leave") {
                const body = await bodyAs(
                    request,
                    operation === "join" ? joinTaskRequestSchema : leaveTaskRequestSchema,
                    `task ${operation}`,
                );
                await this.#withMutationId(body.mutationId, async () =>
                    operation === "join"
                        ? await tasks.join(ctx, taskId, member)
                        : await tasks.leave(ctx, taskId, member),
                );
            } else if (operation === "reorder") {
                const body = await bodyAs(request, reorderTaskRequestSchema, "task reorder");
                await this.#withMutationId(
                    body.mutationId,
                    async () => await tasks.reorder(ctx, taskId, member, body.afterId),
                );
            } else {
                const body = await bodyAs(
                    request,
                    operation === "archive" ? archiveTaskRequestSchema : unarchiveTaskRequestSchema,
                    `task ${operation}`,
                );
                const current = await tasks.get(ctx, taskId);
                if (current === undefined) throw notFound("The task was not found.");
                if (!this.#canArchiveTask(ctx, current)) {
                    throw new ApiError(
                        403,
                        "forbidden",
                        operation === "archive"
                            ? "Only the task's owner or the team owner can archive this task."
                            : "Only the task's owner or the team owner can unarchive this task.",
                    );
                }
                const resource = await this.#taskResource(ctx, current);
                requireIfMatch(request, resource["version"], {
                    currentVersion: resource["version"],
                    task: resource,
                });
                await this.#withMutationId(body.mutationId, async () =>
                    operation === "archive"
                        ? await tasks.archive(ctx, taskId, current.version)
                        : await tasks.unarchive(ctx, taskId, current.version),
                );
            }
        } catch (error: unknown) {
            if (error instanceof TaskNotFoundError) throw notFound("The task was not found.");
            if (error instanceof TaskInputError) throw invalidRequest(error.message);
            if (error instanceof TaskConflictError) {
                const current = await tasks.get(ctx, taskId);
                if (current === undefined) throw notFound("The task was not found.");
                const task = await this.#taskResource(ctx, current);
                throw new ApiError(409, "conflict", error.message, {
                    currentVersion: task["version"],
                    task,
                });
            }
            throw error;
        }
        const task = await tasks.get(ctx, taskId);
        if (task === undefined) throw notFound("The task was not found.");
        sendJson(response, 200, await this.#taskResponse(ctx, task));
        return true;
    }

    async #handleArtifactRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        const artifacts = this.#artifacts;
        if (artifacts === undefined) return false;
        if (this.#artifactData !== undefined && ARTIFACT_DATA_ROUTE.test(url.pathname)) {
            await this.#artifactData.handle(ctx, request, response);
            return true;
        }
        try {
            if (url.pathname === "/v0/artifact-uploads") {
                if (request.method !== "POST") return false;
                const upload = await artifacts.stageUpload(ctx, request);
                sendJson(response, 201, { upload: artifactUploadResource(upload) });
                return true;
            }
            if (url.pathname === "/v0/artifacts") {
                if (request.method === "GET") {
                    const query = artifactListQuery(url);
                    const cursor = this.#journal.cursor();
                    const page = await artifacts.list(ctx, query);
                    sendJson(response, 200, {
                        artifacts: page.artifacts.map(artifactResource),
                        nextPageCursor: page.nextAfter ?? null,
                        cursor,
                    });
                    return true;
                }
                if (request.method !== "POST") return false;
                const body = await bodyAs(
                    request,
                    createArtifactRequestSchema,
                    "artifact creation",
                );
                // A repeated ID answers before anything is staged, so a retry uses up nothing.
                const existing =
                    body.id === undefined ? undefined : await artifacts.get(ctx, body.id);
                if (existing !== undefined) {
                    sendJson(response, 201, { artifact: artifactResource(existing) });
                    return true;
                }
                const source = await this.#artifactSource(ctx, body.source);
                const files = await artifacts.stageFiles(ctx, body.files.map(artifactFileInput));
                const { artifact } = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await artifacts.create(ctx, {
                            ...(body.id === undefined ? {} : { id: body.id }),
                            type: body.type,
                            title: body.title,
                            files,
                            ...(body.background == null ? {} : { background: body.background }),
                            author: this.#artifactUser(ctx),
                            ...(source === undefined ? {} : { source }),
                        }),
                );
                sendJson(response, 201, { artifact: artifactResource(artifact) });
                return true;
            }
            if (ARTIFACT_FILE_ROUTE.test(url.pathname)) {
                if (request.method !== "GET") return false;
                const target = artifactFileRequest(request.url);
                if (target === undefined) throw notFound("The artifact version has no such file.");
                const stored = await artifacts.storedFile(
                    ctx,
                    target.artifactId,
                    target.selector,
                    target.path,
                );
                await sendArtifactFile(request, response, stored, target.selector === "latest");
                return true;
            }
            const route =
                /^\/v0\/artifacts\/([a-z][a-z0-9]*)(?:\/(delete|versions)(?:\/([^/]+))?)?$/.exec(
                    url.pathname,
                );
            if (route === null) return false;
            const artifactId = route[1] as string;
            const action = route[2];
            const selector = route[3];
            if (action === "versions" && request.method === "GET") {
                if (selector !== undefined) {
                    const number = /^[1-9][0-9]*$/.test(selector) ? Number(selector) : undefined;
                    if (selector !== "latest" && !Number.isSafeInteger(number)) {
                        throw notFound("The version was not found.");
                    }
                    const version = await artifacts.getVersion(
                        ctx,
                        artifactId,
                        selector === "latest" ? "latest" : (number as number),
                    );
                    sendJson(response, 200, { version: artifactVersionResource(version) });
                    return true;
                }
                const page = await artifacts.listVersions(ctx, artifactId, {
                    limit: integerParameter(
                        url.searchParams.get("limit"),
                        DEFAULT_ARTIFACT_PAGE_SIZE,
                        1,
                        MAX_ARTIFACT_PAGE_SIZE,
                    ),
                    ...versionPageCursor(url.searchParams.get("pageCursor")),
                });
                sendJson(response, 200, {
                    versions: page.versions.map(artifactVersionResource),
                    nextPageCursor: page.nextBefore === undefined ? null : String(page.nextBefore),
                });
                return true;
            }
            if (selector !== undefined) return false;
            if (action === undefined && request.method === "GET") {
                const artifact = await artifacts.get(ctx, artifactId);
                if (artifact === undefined) throw notFound("The artifact was not found.");
                sendJson(response, 200, { artifact: artifactResource(artifact) });
                return true;
            }
            if (action === undefined && request.method === "PATCH") {
                const body = await bodyAs(request, updateArtifactRequestSchema, "artifact update");
                const current = await artifacts.get(ctx, artifactId);
                if (current === undefined) throw notFound("The artifact was not found.");
                const resource = artifactResource(current);
                const conflict = { currentVersion: resource["version"], artifact: resource };
                requireIfMatch(request, resource["version"], conflict);
                if (current.status === "deleted") {
                    throw new ApiError(
                        409,
                        "conflict",
                        "The artifact was deleted, so it cannot change.",
                        conflict,
                    );
                }
                const source = await this.#artifactSource(ctx, body.source);
                const files =
                    body.files === undefined
                        ? undefined
                        : await artifacts.stageFiles(ctx, body.files.map(artifactFileInput));
                const artifact = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await artifacts.update(ctx, {
                            artifactId,
                            expectedRevision: current.revision,
                            ...(body.title === undefined ? {} : { title: body.title }),
                            ...(body.background === undefined
                                ? {}
                                : { background: body.background }),
                            ...(files === undefined ? {} : { files }),
                            ...(body.remove === undefined ? {} : { remove: body.remove }),
                            ...(body.replaceAll === undefined
                                ? {}
                                : { replaceAll: body.replaceAll }),
                            ...(body.major === undefined ? {} : { major: body.major }),
                            author: this.#artifactUser(ctx),
                            ...(source === undefined ? {} : { source }),
                        }),
                );
                sendJson(response, 200, { artifact: artifactResource(artifact) });
                return true;
            }
            if (action === "delete" && request.method === "POST") {
                const body = await bodyAs(
                    request,
                    deleteArtifactRequestSchema,
                    "artifact deletion",
                );
                const current = await artifacts.get(ctx, artifactId);
                if (current === undefined) throw notFound("The artifact was not found.");
                const resource = artifactResource(current);
                // A retried deletion succeeds with whatever version it was first sent with.
                if (current.status === "deleted") {
                    if (!Value.Check(eventIdSchema, request.headers["if-match"])) {
                        throw invalidRequest("A valid If-Match resource version is required.");
                    }
                    sendJson(response, 200, { artifact: resource });
                    return true;
                }
                requireIfMatch(request, resource["version"], {
                    currentVersion: resource["version"],
                    artifact: resource,
                });
                const source = await this.#artifactSource(ctx, body.source);
                const artifact = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await artifacts.delete(ctx, {
                            artifactId,
                            expectedRevision: current.revision,
                            author: this.#artifactUser(ctx),
                            ...(source === undefined ? {} : { source }),
                        }),
                );
                sendJson(response, 200, { artifact: artifactResource(artifact) });
                return true;
            }
            return false;
        } catch (error: unknown) {
            if (error instanceof ArtifactInputError) throw invalidRequest(error.message);
            if (error instanceof ArtifactNotFoundError) throw notFound(error.message);
            if (error instanceof ArtifactTooLargeError) {
                throw new ApiError(413, "too_large", error.message);
            }
            if (error instanceof ArtifactConflictError) {
                const artifact =
                    error.artifact === undefined ? undefined : artifactResource(error.artifact);
                throw new ApiError(
                    409,
                    "conflict",
                    error.message,
                    artifact === undefined ? {} : { currentVersion: artifact["version"], artifact },
                );
            }
            throw error;
        }
    }

    /** The person making an artifact change: a team member, or the standalone installation's one. */
    #artifactUser(ctx: Context): ArtifactAuthor {
        const userId = this.#team.enabled ? teamUser(ctx)?.id : undefined;
        return userId === undefined ? { kind: "user" } : { kind: "user", userId };
    }

    /** A source a person names, checked against what exists; `null` agents are left out. */
    async #artifactSource(
        ctx: Context,
        source: ArtifactRequestSource | undefined,
    ): Promise<ArtifactSource | undefined> {
        if (source === undefined) return undefined;
        return await this.#artifacts?.resolveSource(ctx, artifactSourceInput(source));
    }

    /** The caller as a task member: the standalone person, or the authenticated team member. */
    #taskMember(ctx: Context): TaskMemberId {
        const member = this.#tasks?.memberFor(teamUser(ctx)?.id);
        if (member === undefined) throw new TeamAuthenticationError();
        return member;
    }

    /**
     * The standalone installation's one person may archive every task. In team mode the task's
     * owner and the team owner may; a task nobody owns is the team owner's to archive.
     */
    #canArchiveTask(ctx: Context, task: TaskRecord): boolean {
        if (!this.#team.enabled) return true;
        const user = teamUser(ctx);
        if (user === undefined) return false;
        return user.isOwner || (task.ownerUserId !== undefined && task.ownerUserId === user.id);
    }

    /** Standalone API bearer possession is authority; team disclosure requires the proven owner. */
    #canDiscloseCredentialSource(ctx: Context): boolean {
        return !this.#team.enabled || teamUser(ctx)?.isOwner === true;
    }

    async #taskResource(ctx: Context, task: TaskRecord): Promise<Record<string, unknown>> {
        const agent = await this.#buildAgentResource(ctx, task.agentId, task.workspaceId, null, {
            userVisible: true,
        });
        if (agent === undefined) throw new Error("The task has no agent.");
        return taskResource(task, agent, this.#canArchiveTask(ctx, task));
    }

    async #taskResponse(ctx: Context, task: TaskRecord): Promise<Record<string, unknown>> {
        const membership = await this.#tasks?.membership(ctx, task.id, this.#taskMember(ctx));
        return {
            task: await this.#taskResource(ctx, task),
            membership: membership === undefined ? null : taskMembershipResource(membership),
        };
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
            if ((await this.#tasks?.forWorkspace(ctx, body.parentId)) !== undefined) {
                throw new ApiError(
                    409,
                    "conflict",
                    "A task workspace cannot have child workspaces.",
                );
            }
            if ((await this.#surfaces?.chatForWorkspace(ctx, body.parentId)) !== undefined) {
                throw new ApiError(
                    409,
                    "conflict",
                    "A Surface chat workspace cannot have child workspaces.",
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
                if ((await this.#tasks?.forWorkspace(ctx, workspaceId)) !== undefined) {
                    throw new ApiError(409, "conflict", "Rename this workspace through its task.");
                }
                if ((await this.#surfaces?.chatForWorkspace(ctx, workspaceId)) !== undefined) {
                    throw new ApiError(
                        409,
                        "conflict",
                        "A Surface chat workspace is named by its Surface.",
                    );
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
        if ((await this.#tasks?.forWorkspace(ctx, workspaceId)) !== undefined) {
            throw new ApiError(
                409,
                "conflict",
                action[2] === "archive"
                    ? "Archive this workspace through its task."
                    : "Reorder this workspace through its task.",
            );
        }
        if ((await this.#surfaces?.chatForWorkspace(ctx, workspaceId)) !== undefined) {
            throw new ApiError(
                409,
                "conflict",
                "A Surface chat workspace lasts as long as its Surface and has no order.",
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
        const task = await this.#tasks?.forWorkspace(ctx, workspaceId);
        if (task !== undefined) {
            const agent = await this.#buildAgentResource(
                ctx,
                task.agentId,
                task.workspaceId,
                null,
                {
                    userVisible: true,
                },
            );
            if (agent === undefined) throw new Error("The task workspace has no agent.");
            return taskWorkspaceResource(task, agent);
        }
        const chat = await this.#surfaces?.chatForWorkspace(ctx, workspaceId);
        if (chat !== undefined) {
            const agent = await this.#buildAgentResource(
                ctx,
                chat.agentId,
                chat.workspaceId,
                null,
                { userVisible: true },
            );
            if (agent === undefined) throw new Error("The Surface chat workspace has no agent.");
            return surfaceWorkspaceResource(chat, agent);
        }
        const project = await this.#projects.get(ctx, workspaceId);
        if (project !== undefined) {
            if (project.status === "archived" || project.archivedAt !== undefined) {
                return {
                    ...rootWorkspaceResource(project, this.#projects.compute(project)),
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
                ...rootWorkspaceResource(project, this.#projects.compute(project)),
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
        // A bot's or task's one agent is always embedded and visible; its lifecycle owns archival.
        if ((await this.#bots.forAgent(ctx, agentId)) !== undefined) return;
        if ((await this.#tasks?.forAgent(ctx, agentId)) !== undefined) return;
        if ((await this.#surfaces?.chatForAgent(ctx, agentId)) !== undefined) return;
        const workspaceId = this.#config.configuration.values.features.workspaces
            ? await this.#workspaces.workspaceForAgent(ctx, agentId)
            : undefined;
        if (workspaceId !== undefined) {
            await this.#workspaces.refreshAgentVisibility(ctx, workspaceId, agentId, visible);
            return;
        }
        const project = await this.#projects.projectForAgent(ctx, agentId);
        if (
            project === undefined &&
            this.#subtasks?.isSubtask(await this.#agentSystem().config(ctx, agentId))
        ) {
            // Shared-filesystem subtasks have no owner-series membership to change.
            return;
        }
        if (project === undefined) throw notFound("The agent owner was not found.");
        await this.#projects.refreshAgentVisibility(ctx, project.id, agentId, visible);
    }

    async #handleWorkspaceContentRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        const agentProxy =
            /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/agents\/([a-z][a-z0-9]*)\/proxy$/.exec(
                url.pathname,
            );
        if (agentProxy !== null) {
            if (request.method !== "GET") return false;
            sendJson(
                response,
                200,
                await this.#agentNetwork(ctx, agentProxy[1] as string, agentProxy[2] as string),
            );
            return true;
        }
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
            const { projectId, childWorkspaceId, botId, taskId, surfaceId } =
                await this.#resolveWorkspaceScope(ctx, workspaceId);
            const root =
                botId !== undefined
                    ? await this.#files.resolveBotRoot(ctx, workspaceId)
                    : taskId !== undefined
                      ? await this.#files.resolveTaskRoot(ctx, workspaceId)
                      : surfaceId !== undefined
                        ? await this.#files.resolveSurfaceRoot(ctx, workspaceId)
                        : await this.#files.resolveRoot(ctx, projectId, childWorkspaceId);
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
            const { root, runnerId } = await this.#resolveWorkspaceScope(ctx, workspaceId);
            // Live Git state is read only for folders this process reads itself.
            if (this.#runners !== undefined && !this.#runners.native(runnerId)) {
                throw notFound(
                    runnerId === undefined
                        ? "Git state is not tracked while work runs as a separate Linux user."
                        : "Git state is not tracked on runners.",
                );
            }
            const snapshot = await this.#git.snapshot(root, workspaceId);
            sendJson(response, 200, { git: this.#git.resource(snapshot) });
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
            const { projectId, childWorkspaceId, root, runnerId } =
                await this.#resolveWorkspaceScope(ctx, workspaceId);
            // A folder on a runner, or a workload user's, has no live Git state; it is simply
            // absent from the answer.
            if (this.#runners !== undefined && !this.#runners.native(runnerId)) continue;
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
            if (snapshot !== undefined) snapshots[workspaceId] = this.#git.resource(snapshot);
        }
        sendJson(response, 200, { snapshots });
    }

    async #resolveWorkspaceScope(
        ctx: Context,
        workspaceId: string,
    ): Promise<{
        readonly botId?: string;
        readonly taskId?: string;
        readonly surfaceId?: string;
        readonly childWorkspaceId?: string;
        readonly docker?: { readonly image: string };
        readonly projectId: string;
        readonly root: string;
        readonly runnerId?: string;
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
                ...(bot.runnerId === undefined ? {} : { runnerId: bot.runnerId }),
                scope: { projectId: bot.id, workspaceId: bot.workspaceId },
            };
        }
        const task = await this.#tasks?.forWorkspace(ctx, workspaceId);
        if (task !== undefined) {
            if (task.status !== "active") {
                throw new ApiError(409, "conflict", "The workspace is not available.");
            }
            return {
                taskId: task.id,
                childWorkspaceId: task.workspaceId,
                projectId: task.id,
                root: task.path,
                ...(task.runnerId === undefined ? {} : { runnerId: task.runnerId }),
                scope: { projectId: task.id, workspaceId: task.workspaceId },
            };
        }
        const chat = await this.#surfaces?.chatForWorkspace(ctx, workspaceId);
        if (chat !== undefined) {
            return {
                surfaceId: chat.surfaceId,
                childWorkspaceId: chat.workspaceId,
                projectId: chat.surfaceId,
                root: chat.path,
                ...(chat.runnerId === undefined ? {} : { runnerId: chat.runnerId }),
                scope: { projectId: chat.surfaceId, workspaceId: chat.workspaceId },
            };
        }
        const project = await this.#projects.get(ctx, workspaceId);
        if (project !== undefined) {
            // A root workspace is its project, and an archived project's folder is on its way out.
            // The child branch below refuses a workspace that is not ready for the same reason.
            if (project.status !== "active") {
                throw new ApiError(409, "conflict", "The workspace is not available.");
            }
            const location = this.#projects.location(project);
            return {
                projectId: project.id,
                root: location.path,
                ...(location.runnerId === undefined ? {} : { runnerId: location.runnerId }),
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
            ...(workspace.dockerImage === undefined
                ? {}
                : { docker: { image: workspace.dockerImage } }),
            projectId: workspace.projectRef,
            root: workspace.path,
            ...(workspace.runnerId === undefined ? {} : { runnerId: workspace.runnerId }),
            scope: { projectId: workspace.projectRef, workspaceId: workspace.id },
        };
    }

    /** The plain HTTP side of local bridges: reading them and closing one. */
    async #handleBridgeRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<boolean> {
        const match =
            /^\/v0\/workspaces\/([a-z][a-z0-9]*)\/bridges(?:\/([a-z][a-z0-9]*)(\/connections\/[a-z][a-z0-9]*)?)?$/.exec(
                url.pathname,
            );
        if (match === null) return false;
        const bridges = this.#bridges;
        if (bridges === undefined) throw notFound("Local bridges are unavailable in this daemon.");
        const workspaceId = match[1]!;
        const bridgeId = match[2];
        const ownerId = teamUser(ctx)?.id ?? "standalone";
        if (request.method === "GET" && bridgeId === undefined) {
            const cursor = this.#journal.cursor();
            sendJson(response, 200, {
                ...(await bridges.list(ctx, ownerId, workspaceId)),
                cursor,
            });
            return true;
        }
        if (
            request.method === "GET" &&
            (match[3] !== undefined || bridgeId === "usb" || bridgeId === "port")
        ) {
            throw invalidRequest("This bridge endpoint is a WebSocket; send an upgrade request.");
        }
        if (request.method === "DELETE" && bridgeId !== undefined && match[3] === undefined) {
            const body = await optionalBodyAs(
                request,
                closeWorkspaceBridgeRequestSchema,
                "bridge close request",
                8192,
            );
            sendJson(response, 200, {
                bridge: bridges.closeBridge(ownerId, workspaceId, bridgeId, body.mutationId),
            });
            return true;
        }
        throw notFound("The requested bridge endpoint does not exist.");
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
                ...rootWorkspaceResource(project, this.#projects.compute(project)),
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

    async #projectWithAgents(
        ctx: Context,
        project: Project,
        archived?: ArchivedOwnerAgent[],
    ): Promise<Record<string, unknown>> {
        return {
            ...(await projectResource(ctx, this.#projects, project)),
            agents: await this.#agentsForProject(ctx, project.id, archived),
        };
    }

    async #botResource(ctx: Context, bot: BotRecord): Promise<Record<string, unknown>> {
        const agent = await this.#buildAgentResource(ctx, bot.agentId, bot.workspaceId, null, {
            userVisible: true,
        });
        if (agent === undefined) throw new Error("The bot has no agent.");
        return botResource(bot, agent);
    }

    async #agentsForProject(
        ctx: Context,
        projectId: string,
        archived?: ArchivedOwnerAgent[],
    ): Promise<readonly Record<string, unknown>[]> {
        return await this.#ownerAgentSeries(
            ctx,
            projectId,
            await this.#projects.listAgents(ctx, projectId),
            archived,
        );
    }

    async #agentsForWorkspace(
        ctx: Context,
        workspaceId: string,
        archived?: ArchivedOwnerAgent[],
    ): Promise<readonly Record<string, unknown>[]> {
        return await this.#ownerAgentSeries(
            ctx,
            workspaceId,
            await this.#workspaces.listAgents(ctx, workspaceId),
            archived,
        );
    }

    /**
     * Builds one owner's active agent series from its ordered associations. Every attached
     * agent's configuration is read exactly once, here: archival is decided from it before any
     * detail read, and the same configuration is handed on to the resource projection. An
     * archived association stays out of the series; when the caller collects archived agents,
     * its configuration and order are recorded there so a later projection needs no second read.
     */
    async #ownerAgentSeries(
        ctx: Context,
        ownerId: string,
        associations: readonly { readonly agentId: string; readonly orderKey: string | null }[],
        archived?: ArchivedOwnerAgent[],
    ): Promise<readonly Record<string, unknown>[]> {
        const resources = await Promise.all(
            associations.map(async (association) => {
                const config = await this.#agentSystem().config(ctx, association.agentId);
                if (config === undefined) return undefined;
                const archivedAt = agentArchivedAt(config);
                if (archivedAt !== null) {
                    archived?.push({
                        agentId: association.agentId,
                        ownerId,
                        orderKey: association.orderKey,
                        config,
                        archivedAt,
                    });
                    return undefined;
                }
                return await this.#buildAgentResource(
                    ctx,
                    association.agentId,
                    ownerId,
                    association.orderKey,
                    { config },
                );
            }),
        );
        return resources.filter(
            (resource): resource is Record<string, unknown> => resource !== undefined,
        );
    }

    /**
     * Projects the most recently archived agents met while building the bootstrap's owner
     * series, newest first with the agent ID as the tie-breaker, bounded so the snapshot stays
     * small. Only the agents inside the bound are projected; the rest cost nothing beyond the
     * configuration read that decided their archival.
     */
    async #archivedAgentResources(
        ctx: Context,
        archived: readonly ArchivedOwnerAgent[],
    ): Promise<readonly Record<string, unknown>[]> {
        const newest = [...archived]
            .sort(
                (left, right) =>
                    right.archivedAt - left.archivedAt ||
                    (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0),
            )
            .slice(0, DESKTOP_BOOTSTRAP_ARCHIVED_AGENT_LIMIT);
        const resources = await Promise.all(
            newest.map(
                async (entry) =>
                    await this.#buildAgentResource(
                        ctx,
                        entry.agentId,
                        entry.ownerId,
                        entry.orderKey,
                        { config: entry.config },
                    ),
            ),
        );
        return resources.filter(
            (resource): resource is Record<string, unknown> => resource !== undefined,
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
                throw new ApiError(error.status, error.code, error.message, {
                    cloud: error.cloud,
                });
            }
            throw error;
        }
    }

    /** The desktop's side of the mobile connector: its snapshot, pairing, and paired phones. */
    async #handleMobileConnectorRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        mobileConnector: MobileConnectorModule,
    ): Promise<boolean> {
        const route = url.pathname.slice("/v0/mobile-connector".length);
        const device = /^\/devices\/([^/]+)$/.exec(route);
        let snapshot: MobileConnectorSnapshot;
        if (request.method === "GET" && route === "") {
            snapshot = await mobileConnector.snapshot(ctx);
        } else if (request.method === "POST" && route === "/pairing") {
            snapshot = await mobileConnector.startPairing(ctx);
        } else if (request.method === "POST" && route === "/pairing/confirm") {
            const body = await bodyAs(request, mobilePairingBodySchema, "pairing confirmation");
            snapshot = await mobileConnector.confirmPairing(ctx, body.pairingId);
        } else if (request.method === "POST" && route === "/pairing/cancel") {
            const body = await bodyAs(request, mobilePairingBodySchema, "pairing cancellation");
            snapshot = await mobileConnector.cancelPairing(ctx, body.pairingId);
        } else if (request.method === "DELETE" && device !== null) {
            snapshot = await mobileConnector.revokeDevice(ctx, decodeURIComponent(device[1]!));
        } else {
            return false;
        }
        sendJson(response, 200, { mobileConnector: snapshot });
        return true;
    }

    /**
     * Identify the credential of work on the mobile connector's socket, or refuse it. A phone's
     * `connection`, when the transport has one, is closed if that phone is removed.
     */
    async #admitMobile(
        ctx: Context,
        authorization: string | string[] | undefined,
        connection: MobileConnection | undefined,
    ): Promise<
        | { readonly kind: "device"; readonly ctx: Context }
        | Exclude<MobileCredential, { readonly kind: "device" }>
    > {
        const credential = await this.#mobileConnector?.authenticate(ctx, authorization);
        if (credential === undefined) throw mobileUnauthorized();
        if (credential.kind !== "device") return credential;
        if (credential.revoked.aborted) throw mobileUnauthorized();
        // A phone paired in one mode does not carry over to the other.
        if (this.#team.enabled === (credential.owner === STANDALONE_MOBILE_OWNER)) {
            throw mobileUnauthorized();
        }
        let deviceCtx = withMobileDevice(ctx, credential);
        if (this.#team.enabled) {
            const user = await this.#team.getUser(ctx, credential.owner);
            if (user === undefined || isTeamGuest(user)) throw mobileUnauthorized();
            deviceCtx = this.#team.connectionContext(deviceCtx, user);
        }
        if (connection !== undefined) this.#closeOnRevoke(credential.revoked, connection);
        return { kind: "device", ctx: deviceCtx };
    }

    /** Upgrades and tunnels on the mobile connector's socket belong to paired phones only. */
    async #admitMobileDevice(
        ctx: Context,
        authorization: string | string[] | undefined,
        connection: MobileConnection | undefined,
    ): Promise<Context> {
        const admitted = await this.#admitMobile(ctx, authorization, connection);
        if (admitted.kind !== "device") throw mobileUnauthorized();
        return admitted.ctx;
    }

    /** Run `close` if the phone this work authenticated as is removed; returns the release. */
    #onMobileRevoke(ctx: Context, close: () => void): () => void {
        const revoked = mobileDevice(ctx)?.revoked;
        if (revoked === undefined) return () => undefined;
        if (revoked.aborted) {
            close();
            return () => undefined;
        }
        revoked.addEventListener("abort", close, { once: true });
        return () => revoked.removeEventListener("abort", close);
    }

    #closeBridgeOnRevoke(
        ctx: Context,
        webSocket: BridgeWebSocket,
        binding: BridgeWebSocketBinding,
    ): BridgeWebSocketBinding {
        const stop = this.#onMobileRevoke(ctx, () =>
            webSocket.close(MOBILE_REVOKED_CLOSE, "This phone was removed."),
        );
        return {
            message: (data) => binding.message(data),
            closed: () => {
                stop();
                binding.closed();
            },
        };
    }

    /** Close a connection a paired phone opened when that phone is removed. */
    #closeWithMobileDevice(ctx: Context, connection: MobileConnection): void {
        const device = mobileDevice(ctx);
        if (device !== undefined) this.#closeOnRevoke(device.revoked, connection);
    }

    /**
     * One listener per connection serves every phone that used it, and leaves each revocation
     * signal when the connection closes, so a long-paired phone accumulates nothing.
     */
    #closeOnRevoke(revoked: AbortSignal, connection: MobileConnection): void {
        if (revoked.aborted) {
            connection.destroy();
            return;
        }
        let signals = this.#mobileConnections.get(connection);
        let destroy = this.#mobileClosers.get(connection);
        if (signals === undefined || destroy === undefined) {
            const tracked = new Set<AbortSignal>();
            const close = () => connection.destroy();
            signals = tracked;
            destroy = close;
            this.#mobileConnections.set(connection, tracked);
            this.#mobileClosers.set(connection, close);
            connection.once("close", () => {
                for (const signal of tracked) signal.removeEventListener("abort", close);
                tracked.clear();
            });
        }
        if (signals.has(revoked)) return;
        signals.add(revoked);
        revoked.addEventListener("abort", destroy, { once: true });
    }

    /**
     * A phone pairing over the connector's socket. Each credential reaches only its own routes;
     * anything else is refused exactly as an unknown credential is.
     */
    async #handleMobileHandshake(
        ctx: Context,
        credential: Exclude<MobileCredential, { readonly kind: "device" }>,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const mobileConnector = this.#mobileConnector;
        if (mobileConnector === undefined) throw mobileUnauthorized();
        const url = requestUrl(request);
        const route = url.pathname;
        if (credential.kind === "pairing") {
            if (request.method !== "POST" || route !== MOBILE_HANDSHAKE_ROUTE) {
                throw mobileUnauthorized();
            }
            const body = await readJson(request, MAX_MOBILE_HANDSHAKE_BODY_BYTES);
            sendJson(
                response,
                200,
                await mobileConnector.startHandshake(ctx, credential.token, body),
            );
            return;
        }
        const handshakeId = credential.handshakeId;
        if (request.method === "GET" && route === MOBILE_HANDSHAKE_ROUTE) {
            const closed = new AbortController();
            response.once("close", () => closed.abort());
            const wait = Number(url.searchParams.get("wait") ?? "0");
            sendJson(
                response,
                200,
                await mobileConnector.handshakeStatus(handshakeId, wait, closed.signal),
            );
            return;
        }
        if (request.method !== "POST") throw mobileUnauthorized();
        if (route === `${MOBILE_HANDSHAKE_ROUTE}/reveal`) {
            const body = await readJson(request, MAX_MOBILE_HANDSHAKE_BODY_BYTES);
            sendJson(response, 200, await mobileConnector.revealHandshake(ctx, handshakeId, body));
            return;
        }
        if (route === `${MOBILE_HANDSHAKE_ROUTE}/confirm`) {
            const body = await readJson(request, MAX_MOBILE_HANDSHAKE_BODY_BYTES);
            sendJson(response, 200, await mobileConnector.confirmHandshake(ctx, handshakeId, body));
            return;
        }
        if (route === `${MOBILE_HANDSHAKE_ROUTE}/reject`) {
            await readJson(request, MAX_MOBILE_HANDSHAKE_BODY_BYTES, true);
            sendJson(response, 200, await mobileConnector.rejectHandshake(ctx, handshakeId));
            return;
        }
        throw mobileUnauthorized();
    }

    /** Read one of the caller's settings, or set or clear it last-write-wins. */
    async #handleUserSettingRoute(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        key: string,
        userSettings: UserSettingsModule,
    ): Promise<void> {
        try {
            if (request.method === "GET") {
                sendJson(response, 200, { setting: await userSettings.get(ctx, key) });
                return;
            }
            const body = await bodyAs(
                request,
                userSettingBodySchema,
                "user setting",
                MAX_USER_SETTING_BODY_BYTES,
            );
            const setting = await this.#withMutationId(
                body.mutationId,
                async () =>
                    await userSettings.save(ctx, key, {
                        value: body.value,
                        ...(body.updatedAt === undefined ? {} : { updatedAt: body.updatedAt }),
                    }),
            );
            sendJson(response, 200, { setting });
        } catch (error: unknown) {
            if (!(error instanceof UserSettingsError)) throw error;
            throw new ApiError(
                error.code === "too_large" ? 413 : error.code === "settings_full" ? 409 : 400,
                error.code,
                error.message,
            );
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
        if (request.method === "DELETE") {
            const current = await this.#secrets.catalogSecret(ctx, secretId);
            if (current === undefined) throw notFound("The secret was not found.");
            const expectedVersion = requireIfMatch(request, current.version, {
                currentVersion: current.version,
                secret: current,
            });
            const body = await optionalBodyAs(
                request,
                deleteSecretRequestSchema,
                "secret deletion",
                2 * 1_024,
            );
            try {
                const secret = await this.#withMutationId(
                    body.mutationId,
                    async () =>
                        await this.#secrets.deleteCatalogSecret(ctx, secretId, expectedVersion),
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
            if ((await this.#surfaces?.chatForWorkspace(ctx, target.id)) !== undefined) return;
            const owner =
                (await this.#bots.forWorkspace(ctx, target.id)) ??
                (await this.#tasks?.forWorkspace(ctx, target.id));
            if (owner !== undefined) {
                if (requireActive && owner.status !== "active") {
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

    async #onboarding(ctx: Context, hasProject?: boolean): Promise<Record<string, unknown>> {
        const [profileDone, projectDone, marker] = await Promise.all([
            this.#team.enabled
                ? this.#team.currentUser(ctx).then((user) => user !== undefined)
                : this.#profile.get(ctx).then((profile) => profile?.name != null),
            hasProject ??
                this.#projects
                    .list(ctx, { includeArchived: false, limit: 1 })
                    .then((page) => page.projects.length > 0),
            readFile(this.#onboardingMarker(), "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
            }),
        ]);
        const signedIn = [...new Set(this.#config.models.map((model) => model.providerId))];
        const installationCompleted = marker !== undefined;
        const userCompleted = !this.#team.enabled || profileDone;
        return {
            completed: installationCompleted && userCompleted,
            steps: {
                providers: { done: signedIn.length > 0, signedIn },
                profile: { done: profileDone },
                project: { done: projectDone },
            },
        };
    }

    async #desktopBootstrap(ctx: Context): Promise<Record<string, unknown>> {
        // Capture first. A mutation concurrent with the reads is replayed after this cursor, which
        // may cause a harmless dirty/refetch but can never disappear between snapshot and stream.
        const cursor = this.#journal.cursor();
        const [profile, projects, workspaces, bots] = await Promise.all([
            this.#team.enabled
                ? this.#team.currentUser(ctx).then(teamProfileResource)
                : this.#profile.ensure(ctx).then(profileResource),
            this.#allProjects(ctx, false),
            this.#config.configuration.values.features.workspaces
                ? this.#allWorkspaces(ctx, undefined, false)
                : Promise.resolve([]),
            this.#bots.list(ctx),
        ]);
        const shallow = workspaces.filter(
            (workspace: Workspace) => workspace.parentId === workspace.projectRef,
        );
        // Every owner series built below drops its archived agents in here, so the history the
        // desktop shows is drawn from the same single configuration read that filtered them out.
        const archived: ArchivedOwnerAgent[] = [];
        const projectResources = await Promise.all(
            projects.map(async (project) => {
                const resource = await this.#projectWithAgents(ctx, project, archived);
                return {
                    project: resource,
                    workspace: {
                        ...rootWorkspaceResource(project, this.#projects.compute(project)),
                        agents: resource["agents"],
                    },
                };
            }),
        );
        const shallowResources = await Promise.all(
            shallow.map(async (workspace: Workspace) => ({
                ...workspaceResource(workspace),
                agents: await this.#agentsForWorkspace(ctx, workspace.id, archived),
            })),
        );
        return {
            config: await this.#sanitizedConfig(ctx),
            profile,
            onboarding: await this.#onboarding(ctx, projects.length > 0),
            cloud: this.#cloud.status(ctx),
            happyIntegration: await this.#happy.integration(ctx),
            bots: await Promise.all(bots.map(async (bot) => await this.#botResource(ctx, bot))),
            projects: projectResources.map((resource) => resource.project),
            workspaces: [
                ...projectResources.map((resource) => resource.workspace),
                ...shallowResources,
            ],
            archivedAgents: await this.#archivedAgentResources(ctx, archived),
            ...(await this.#taskBootstrap(ctx)),
            ...(this.#surfaces === undefined ? {} : { surfaces: await this.#surfaces.list(ctx) }),
            ...(this.#userSettings === undefined
                ? {}
                : { userSettings: await this.#userSettings.list(ctx) }),
            cursor,
        };
    }

    /** Every task oldest first, and the caller's own memberships in the caller's order. */
    async #taskBootstrap(ctx: Context): Promise<Record<string, unknown>> {
        const tasks = this.#tasks;
        if (tasks === undefined) return {};
        const member = this.#taskMember(ctx);
        const [all, joined] = await Promise.all([
            tasks.list(ctx),
            tasks.listForMember(ctx, member),
        ]);
        return {
            tasks: await Promise.all(all.map(async (task) => await this.#taskResource(ctx, task))),
            taskMemberships: joined.map(({ membership }) => taskMembershipResource(membership)),
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
                    type: provider.type,
                    enabled: provider.enabled,
                    hidden: provider.hidden,
                    models: provider.models,
                    usage: account?.usage ?? null,
                    checkedAt: account?.checkedAt ?? null,
                    error: account?.error ?? null,
                    refreshedAt: account?.refreshedAt ?? null,
                    refreshError: account?.refreshError ?? null,
                    retryAt: account?.retryAt ?? null,
                    refreshing: account?.refreshing ?? false,
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
    #beginDrain(callerCtx: Context): void {
        if (this.#draining) return;
        this.#draining = true;
        // The drain outlives the request or signal that started it.
        const ctx = detach(callerCtx).named("daemon-drain");
        this.#journal.append("daemon.draining", {
            daemonId: this.#daemonId,
            draining: true,
        });
        ctx.log.info(
            `daemon:drain:start pid=${String(process.pid)} mutations=${String(this.#apiMutations.size)}`,
        );
        const timer = setInterval(() => this.#reportDrain(ctx), DRAIN_REPORT_TICK_MS);
        timer.unref();
        this.#drainReport = { key: undefined, loggedAt: 0, startedAt: Date.now(), timer };
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
        // What was running when the drain began, before any of it has had a chance to finish.
        this.#reportDrain(ctx);
    }

    /** Build bounded, stable progress without allowing optional reporting to break health. */
    #drainWaitingFor(ctx?: Context): DrainWaitingFor[] {
        if (!this.#draining) return [];
        const waiting: DrainWaitingFor[] = [];
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
     * Log what holds the drain open, grouped by tool or stage with the age of the oldest of each,
     * whenever that changes and otherwise every five seconds; then log how long the drain took.
     * A slow reload is read from these lines afterwards, so they name work and never its content.
     */
    #reportDrain(ctx: Context): void {
        const report = this.#drainReport;
        if (report === undefined) return;
        const now = Date.now();
        const waiting = this.#drainWaitingFor(ctx);
        if (waiting.length === 0) {
            clearInterval(report.timer);
            this.#drainReport = undefined;
            ctx.log.info(
                `daemon:drain:finish pid=${String(process.pid)} durationMs=${String(now - report.startedAt)}`,
            );
            return;
        }
        const blockers: DrainBlocker[] = [];
        for (const row of waiting) {
            if (row.name === "api-mutations") {
                for (const mutation of this.#apiMutations.values()) {
                    blockers.push({ category: "api-mutation", startedAt: mutation.startedAt });
                }
                continue;
            }
            if (row.agents === undefined) {
                for (let index = 0; index < row.count; index += 1) {
                    blockers.push({ category: row.name, startedAt: undefined });
                }
                continue;
            }
            let work: readonly ApiDrainWork[] = [];
            try {
                work = this.#drainSources.get(row.name)?.work?.() ?? [];
            } catch {
                // The log is optional; the drain itself does not depend on it.
            }
            for (const agent of row.agents) {
                const own = work.filter((entry) => entry.agentId === agent.id);
                if (own.length === 0)
                    blockers.push({ category: agent.stage, startedAt: undefined });
                for (const entry of own) {
                    blockers.push({ category: entry.category, startedAt: entry.startedAt });
                }
            }
            // Agents beyond the reported list, or a source that has not settled yet.
            for (let index = row.agents.length; index < row.count; index += 1) {
                blockers.push({ category: row.name, startedAt: undefined });
            }
        }
        const summary = describeDrainBlockers(blockers, now);
        if (summary.key === report.key && now - report.loggedAt < DRAIN_REPORT_INTERVAL_MS) return;
        report.key = summary.key;
        report.loggedAt = now;
        const counts = waiting.map((row) => `${row.name}=${String(row.count)}`).join(" ");
        ctx.log.info(
            `daemon:drain:waiting pid=${String(process.pid)} elapsedMs=${String(now - report.startedAt)} ${counts} blockers=${summary.text}`,
        );
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
            capabilities: {
                desktopLiveControl: this.#live !== undefined,
                ...(this.#bridges === undefined ? {} : { workspaceBridges: true }),
                ...(this.#live === undefined
                    ? {}
                    : { desktopLiveCapabilities: [...this.#live.desktopCapabilities] }),
                ...(this.#surfaces === undefined
                    ? {}
                    : {
                          collaborativeDocuments: true,
                          calendarSurfaces: true,
                          systemMonitorSurfaces: true,
                          surfaceEditing: true,
                      }),
            },
            version: {
                protocol: API_PROTOCOL_VERSION,
                daemon: this.#config.configuration.version,
            },
            waitingFor: gracefulShutdown?.pending() ?? [],
        };
    }

    async #sanitizedConfig(ctx: Context): Promise<Record<string, unknown>> {
        const values = this.#config.configuration.values;
        const { models, providers } = this.#sanitizedCatalog();
        const defaultModel = this.#config.models[0] ?? this.#config.offeredModels[0];
        return {
            node: await this.#node.get(ctx),
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
            ...(this.#live === undefined ? {} : { voice: this.#live.voiceSettings() }),
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
                autoCompactWindow: route.autoCompactWindow,
                efforts: [...route.effortLevels],
                defaultEffort: route.defaultEffort,
                serviceTiers: [...(route.serviceTiers ?? [])],
                serviceTierOptions: [...route.serviceTierOptions],
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
        for (const providerId of Object.keys(this.#config.configuration.values.providers)) {
            providers[providerId] = {
                name: this.#config.providerName(providerId),
                type: this.#config.providerType(providerId) ?? "codex",
                enabled: this.#config.isProviderEnabled(providerId),
                hidden: this.#config.isProviderHidden(providerId),
                models: [],
            };
        }
        for (const route of routes) {
            let provider = providers[route.providerId];
            if (provider === undefined) {
                provider = {
                    name: this.#config.providerName(route.providerId),
                    type: this.#config.providerType(route.providerId) ?? "codex",
                    enabled: this.#config.isProviderEnabled(route.providerId),
                    hidden: this.#config.isProviderHidden(route.providerId),
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
                serviceTierOptions: [...route.serviceTierOptions],
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

    /** Report the caller's authentication and the sign-in methods, without requiring a token. */
    async #authenticationStatus(
        ctx: Context,
        authorization: string | string[] | undefined,
    ): Promise<AuthenticationResponse> {
        let authenticated = true;
        try {
            ctx = await this.#authenticate(ctx, authorization);
        } catch (error: unknown) {
            if (!(error instanceof ApiError) || error.status !== 401) throw error;
            authenticated = false;
        }
        return {
            authenticated,
            methods: [...this.#team.authenticationMethods()],
            userId: authenticated ? (teamUser(ctx)?.id ?? null) : null,
        };
    }

    /** The additive `401` field telling a client how to sign in, when there is a way. */
    #authenticationChallenge(ctx: Context): { readonly authentication?: AuthenticationChallenge } {
        // A phone's socket has no sign-in method; advertising one would only mislead it.
        if (isMobileTransport(ctx)) return {};
        const methods = this.#team.authenticationMethods();
        return methods.length === 0 ? {} : { authentication: { methods: [...methods] } };
    }

    async #authenticate(
        ctx: Context,
        authorization: string | string[] | undefined,
    ): Promise<Context> {
        if (isMobileTransport(ctx)) {
            // Usually admitted at the transport's entry; Bun's native upgrades arrive here first.
            return mobileDevice(ctx) === undefined
                ? await this.#admitMobileDevice(ctx, authorization, undefined)
                : ctx;
        }
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

    async #sendError(ctx: Context, response: ServerResponse, error: unknown): Promise<void> {
        error = bridgeApiError(error) ?? error;
        if (response.headersSent) {
            response.end();
            return;
        }
        if (error instanceof ApiError) {
            sendJson(response, error.status, {
                ...error.body(),
                ...(error.status === 401 ? this.#authenticationChallenge(ctx) : {}),
            });
            return;
        }
        if (error instanceof RemoteConnectionError) {
            sendJson(response, error.status, {
                error: error.message,
                code: error.code,
                ...(error.current === undefined
                    ? {}
                    : {
                          currentVersion: error.current.version,
                          connections: error.current.connections,
                      }),
            });
            return;
        }
        if (error instanceof SecretApiInputError) {
            sendJson(response, 400, { code: "invalid_request", error: error.message });
            return;
        }
        if (error instanceof MobileConnectorError) {
            sendJson(response, error.status, {
                error: error.message,
                code: error.code,
                ...(error.status === 401 ? this.#authenticationChallenge(ctx) : {}),
            });
            return;
        }
        if (error instanceof RunnerUnavailableError) {
            sendJson(response, 503, { code: "runner_unavailable", error: error.message });
            return;
        }
        if (error instanceof LocalExecutionDisabledError) {
            sendJson(response, 409, { code: "local_execution_disabled", error: error.message });
            return;
        }
        if (error instanceof BotNotFoundError) {
            sendJson(response, 404, { code: "not_found", error: error.message });
            return;
        }
        if (error instanceof BotInputError) {
            sendJson(response, 400, { code: "invalid_request", error: error.message });
            return;
        }
        if (error instanceof BotConflictError) {
            sendJson(response, 409, { code: "conflict", error: error.message });
            return;
        }
        if (error instanceof TaskNotFoundError) {
            sendJson(response, 404, { code: "not_found", error: error.message });
            return;
        }
        if (error instanceof TaskInputError) {
            sendJson(response, 400, { code: "invalid_request", error: error.message });
            return;
        }
        if (error instanceof TaskConflictError) {
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
                ...this.#authenticationChallenge(ctx),
            });
            return;
        }
        // A folder archived while this request was in flight. The request was legitimate when it
        // arrived and the caller simply lost the race, so it reads as a conflict rather than a
        // daemon fault the person can do nothing about.
        if (error instanceof ProjectLifecycleError || error instanceof WorkspaceLifecycleError) {
            const project =
                error instanceof ProjectLifecycleError && error.current !== undefined
                    ? await this.#projectWithAgents(ctx, error.current)
                    : undefined;
            sendJson(response, 409, {
                error: error.message,
                code: "conflict",
                ...(project === undefined ? {} : { currentVersion: project["version"], project }),
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
        error = bridgeApiError(error) ?? error;
        if (error instanceof RemoteConnectionError)
            return { code: error.code, status: error.status, message: error.message };
        if (error instanceof ApiError) {
            return {
                code: error.code,
                message: error.message,
                status: error.status,
                ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
                ...(error.status === 401 ? this.#authenticationChallenge(ctx) : {}),
            };
        }
        if (error instanceof TerminalError && error.code === "not_found") {
            return { code: "not_found", message: notFoundMessage, status: 404 };
        }
        if (error instanceof RunnerUnavailableError) {
            return { code: "runner_unavailable", message: error.message, status: 503 };
        }
        if (error instanceof LocalExecutionDisabledError) {
            return { code: "local_execution_disabled", message: error.message, status: 409 };
        }
        ctx.log.error("The Happy Agent socket attachment failed.", {}, error);
        return {
            code: "internal",
            message: "The attachment could not be completed.",
            status: 500,
        };
    }
}

function remoteRoute(target: string | undefined): { id: string; path: string } | undefined {
    const match = /^\/v0\/connections\/([a-z][a-z0-9_-]{0,63})\/api(\/[^\r\n]*)?$/.exec(
        target ?? "",
    );
    if (match === null) return undefined;
    return { id: match[1]!, path: match[2] ?? "/" };
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
            userId: null,
            name: null,
            email: null,
            photo: null,
            version: TEAM_ONBOARDING_PROFILE_VERSION,
            updatedAt: 0,
        };
    }
    return {
        userId: user.id,
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

const agentWaitStateSchema = Type.Union([agentWaitSchema, Type.Null()]);

const runtimeConfigPatchSchema = Type.Object(
    {
        node: Type.Optional(nodeConfigPatchSchema),
        voice: Type.Optional(voiceConfigPatchSchema),
        providers: Type.Optional(
            Type.Record(
                Type.String(),
                Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
            ),
        ),
    },
    { additionalProperties: false, minProperties: 1 },
);

/**
 * A document route's query: only the named fields, each at most once. Positions are non-negative
 * integers and state vectors are base64.
 */
function documentQuery<const Key extends "seq" | "afterSeq" | "limit" | "stateVector">(
    url: URL,
    allowed: readonly Key[],
): { seq?: number; afterSeq?: number; limit?: number; stateVector?: string } {
    const query: { seq?: number; afterSeq?: number; limit?: number; stateVector?: string } = {};
    for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        const value = values[0]!;
        if (!allowed.includes(key as Key) || values.length > 1)
            throw invalidRequest("The document query is invalid.");
        if (key === "stateVector") {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value))
                throw invalidRequest("The state vector must be base64.");
            query.stateVector = value;
        } else {
            if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)))
                throw invalidRequest("The document query is invalid.");
            query[key as "seq" | "afterSeq" | "limit"] = Number(value);
        }
    }
    return query;
}

/** Anything on the mobile connector's socket that closes when its phone is removed. */
type MobileConnection = import("node:stream").Duplex;

/** Every phone pairing route; only the mobile connector's socket serves it. */
const MOBILE_HANDSHAKE_ROUTE = "/v0/mobile-connector/handshake";
/** The WebSocket close a removed phone's upgraded connections receive. */
const MOBILE_REVOKED_CLOSE = 1008;
const MAX_MOBILE_HANDSHAKE_BODY_BYTES = 4 * 1024;

const MOBILE_UNAUTHORIZED: ApiSocketRejection = {
    code: "unauthorized",
    message: "Unauthorized",
    status: 401,
};

function mobileUnauthorized(): ApiError {
    return new ApiError(401, "unauthorized", "Unauthorized");
}

/** Daemon lifecycle, debugging, and mobile connector management stay with the desktop. */
function isDeviceForbiddenPath(pathname: string): boolean {
    return ["/v0/drain", "/v0/shutdown", "/v0/debug", "/v0/mobile-connector"].some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
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

/** The query parameters every bridge upgrade shares. A repeated parameter is refused. */
function bridgeQuery(url: URL): { id?: string; name?: string } {
    for (const key of ["busId", "port", "id", "name"]) {
        if (url.searchParams.getAll(key).length > 1)
            throw invalidRequest("The bridge query contains duplicate parameters.");
    }
    const id = url.searchParams.get("id");
    const name = url.searchParams.get("name");
    return {
        ...(id === null ? {} : { id }),
        ...(name === null ? {} : { name }),
    };
}

/** A decimal port number, or `NaN` for anything else so the bridge refuses it. */
function portParameter(value: string | null): number {
    return value !== null && /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
}

/** Bytes of one WebSocket message, however `ws` delivered them. */
function webSocketBytes(data: import("ws").RawData): Buffer {
    if (Array.isArray(data)) return Buffer.concat(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function bridgeApiError(error: unknown): ApiError | undefined {
    if (!(error instanceof BridgeError)) return undefined;
    const statuses = {
        invalid_request: 400,
        not_found: 404,
        not_initialized: 409,
        conflict: 409,
        bridge_unavailable: 409,
        bridge_limit: 409,
        port_unavailable: 409,
        unavailable: 503,
    } as const;
    return new ApiError(
        statuses[error.code],
        error.code === "unavailable" ? "not_initialized" : error.code,
        error.message,
        error.reason === undefined ? {} : { reason: error.reason },
    );
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
    readonly autoCompactWindow: number | null;
    readonly efforts: string[];
    readonly defaultEffort: string;
    readonly serviceTiers: string[];
    readonly serviceTierOptions: ServiceTierOption[];
}

interface ApiProviderDefinition {
    readonly name: string;
    readonly type: string;
    readonly enabled: boolean;
    readonly hidden: boolean;
    readonly models: ApiProviderModelReference[];
}

interface ApiProviderModelReference {
    readonly id: string;
    readonly enabled: boolean;
    readonly efforts?: string[];
    readonly defaultEffort?: string;
    readonly name?: string;
    readonly serviceTiers?: string[];
    readonly serviceTierOptions: ServiceTierOption[];
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

    override append(
        type: string,
        payload: unknown,
        occurredAt?: number,
        ownerId?: string,
    ): ApiEvent {
        const mutationId = this.#mutationIds.getStore();
        if (
            mutationId === undefined ||
            payload === null ||
            typeof payload !== "object" ||
            Array.isArray(payload)
        ) {
            return super.append(type, payload, occurredAt, ownerId);
        }
        return super.append(
            type,
            { ...(payload as Record<string, unknown>), mutationId },
            occurredAt,
            ownerId,
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

function setImageCacheHeaders(response: ServerResponse): void {
    response.setHeader("cache-control", "private, max-age=3600, stale-while-revalidate=86400");
    response.setHeader("vary", "Authorization");
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
    socket: import("node:stream").Duplex,
    rejection: ApiSocketRejection,
): void {
    const { status } = rejection;
    const body = JSON.stringify(socketRejectionBody(rejection));
    socket.end(
        `HTTP/1.1 ${status} ${httpStatusText(status)}\r\n` +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Cache-Control: no-store\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "Connection: close\r\n\r\n" +
            body,
    );
}

/** The JSON error body for a rejected attachment, shared by the Node and Bun transports. */
export function socketRejectionBody(rejection: ApiSocketRejection): Record<string, unknown> {
    return {
        ...rejection.details,
        error: rejection.message,
        code: rejection.code,
        ...(rejection.authentication === undefined
            ? {}
            : { authentication: rejection.authentication }),
    };
}

function httpStatusText(status: number): string {
    if (status === 400) return "Bad Request";
    if (status === 401) return "Unauthorized";
    if (status === 404) return "Not Found";
    if (status === 409) return "Conflict";
    if (status === 413) return "Content Too Large";
    if (status === 501) return "Not Implemented";
    if (status === 503) return "Service Unavailable";
    if (status === 504) return "Gateway Timeout";
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

/** `GET /v0/artifacts` filters; a page cursor is the last listed artifact's ID. */
function artifactListQuery(url: URL): ArtifactListQuery {
    const text = (name: string): string | undefined => {
        const value = url.searchParams.get(name);
        return value === null || value === "" ? undefined : value;
    };
    const pageCursor = text("pageCursor");
    if (pageCursor !== undefined && !Value.Check(cuid2Schema, pageCursor)) {
        throw invalidRequest("The page cursor is not recognized.");
    }
    const filters = {
        type: text("type"),
        sourceKind: text("sourceKind"),
        sourceId: text("sourceId"),
        agentId: text("agentId"),
        authorKind: text("authorKind"),
        authorId: text("authorId"),
        after: pageCursor,
    };
    return {
        ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
        includeDeleted: booleanParameter(url.searchParams.get("includeDeleted"), false),
        limit: integerParameter(
            url.searchParams.get("limit"),
            DEFAULT_ARTIFACT_PAGE_SIZE,
            1,
            MAX_ARTIFACT_PAGE_SIZE,
        ),
    };
}

/** A version page cursor is the number of the last listed version. */
function versionPageCursor(value: string | null): { before?: number } {
    if (value === null || value === "") return {};
    const before = /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
    if (before === undefined || !Number.isSafeInteger(before)) {
        throw invalidRequest("The page cursor is not recognized.");
    }
    return { before };
}

function artifactFileInput(file: ArtifactRequestFile): ArtifactFileInput {
    if ("uploadId" in file && "text" in file) {
        throw invalidRequest(`Give "${file.path}" either its text or an upload, not both.`);
    }
    return "uploadId" in file
        ? { path: file.path, uploadId: file.uploadId }
        : { path: file.path, text: file.text };
}

function artifactSourceInput(source: ArtifactRequestSource): ArtifactSourceInput {
    const agent = source.agentId == null ? {} : { agentId: source.agentId };
    switch (source.kind) {
        case "bot":
            return { kind: "bot", botId: source.botId, ...agent };
        case "task":
            return { kind: "task", taskId: source.taskId, ...agent };
        case "project":
            return { kind: "project", projectId: source.projectId, ...agent };
        case "workspace":
            return {
                kind: "workspace",
                workspaceId: source.workspaceId,
                ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
                ...agent,
            };
        case "agent":
            return { kind: "agent", agentId: source.agentId };
    }
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
            ...(pending.userId === undefined ? {} : { userId: pending.userId }),
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
        "subtaskOrderKey",
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
    if (type === "toolcall_start" || type === "toolcall_end") {
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

function isCloudOrganizationRoute(pathname: string): boolean {
    return (
        pathname === "/v0/cloud/organizations" || pathname.startsWith("/v0/cloud/organizations/")
    );
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * The stored form of a project's workspace compute choice, refusing one that does not fit where the
 * project is. A runner project's workspaces stay on its runner, so it accepts only that runner,
 * directly or as the runner a container runs on; a project here accepts this machine or a
 * container on it.
 */
function storedWorkspaceCompute(
    requested:
        | { readonly type: "host" }
        | { readonly type: "docker"; readonly image: string; readonly runnerId?: string }
        | { readonly type: "runner"; readonly runnerId: string },
    compute: ProjectCompute,
): { readonly type: "local" } | { readonly type: "docker"; readonly image: string } {
    const runnerId = compute.type === "runner" ? compute.runnerId : undefined;
    if (requested.type === "host") {
        if (runnerId !== undefined) {
            throw new ApiError(
                400,
                "invalid_request",
                "This project is on a runner, so its workspaces cannot run on this machine.",
            );
        }
        return { type: "local" };
    }
    if (requested.type === "runner") {
        if (requested.runnerId !== runnerId) {
            throw new ApiError(
                400,
                "invalid_request",
                "A project's workspaces can only run on the runner its folder is on.",
            );
        }
        return { type: "local" };
    }
    if (requested.runnerId !== undefined && requested.runnerId !== runnerId) {
        throw new ApiError(
            400,
            "invalid_request",
            "A project's workspace containers can only run on the runner its folder is on.",
        );
    }
    return { type: "docker", image: requested.image };
}
