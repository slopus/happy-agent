import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type {
    ChatDelta,
    ChatElement,
    MutationAction,
    MutationRejectedDelta,
    SessionState,
} from "./ChatElement.js";
import { ChatStore } from "./ChatStore.js";
import type { GroupDelta, GroupsState, ProjectGroup } from "./GroupElement.js";
import { GroupStore } from "./GroupStore.js";
import type { InboxDelta, InboxItem, InboxState } from "./InboxElement.js";
import { InboxStore } from "./InboxStore.js";
import { mergeForwardTranscriptWindow } from "./mergeTranscriptWindow.js";
import type {
    ProviderUsageDelta,
    ProviderUsageEntry,
    ProviderUsageState,
} from "./ProviderUsageElement.js";
import { ProviderUsageStore } from "./ProviderUsageStore.js";
import type {
    LocalPlugin,
    PluginApp,
    PluginsState,
    ReadPluginAppResourceResult,
    ReadPluginIconResult,
} from "./PluginElement.js";
import {
    PluginAppRequestError,
    PluginCatalogRequestError,
    PluginIconRequestError,
    PluginManagementRequestError,
    PluginStore,
} from "./PluginElement.js";
import { MurmurFriendsStore, type MurmurFriendsState } from "./MurmurFriendElement.js";
import type { TimelineAgentNode, TimelineDelta, TimelineState } from "./TimelineElement.js";
import { TimelineStore } from "./TimelineStore.js";
import { createCuid2 } from "./createCuid2.js";
import { orderedUuidV7, type RandomValues } from "./orderedUuidV7.js";
import {
    CHECKING_SERVER_COMPATIBILITY,
    describeServerCompatibility,
    serverCompatibility,
    type ServerCompatibility,
} from "./ServerCompatibility.js";
import type {
    ContentBlock,
    BackgroundProcessSnapshot,
    ComputePreparationEvent,
    ExternalToolCallResolution,
    GitChangeSnapshot,
    GitWatchResponse,
    GitHubPluginCatalog,
    GitHubPluginPackageSource,
    GlobalEvent,
    MutationId,
    Project,
    ProjectRegistrationErrorCode,
    ProjectWorkspace,
    ProtocolSession,
    RemoteTerminalGroupState,
    SessionEvent,
    SessionTranscriptWindow,
    SessionUnreadReason,
    SessionUnreadState,
    GlobalStreamHello,
    GetTimelineResponse,
    ListProviderUsageResponse,
    InstalledPluginSummary,
    ListMurmurContactsResponse,
    ListMurmurFriendRequestsResponse,
    ListPluginsResponse,
    PluginLogResponse,
    PluginLogSnapshot,
    PluginSummary,
    DiscoverPluginCatalogRequest,
    SessionStateResponse,
    TimelineScope,
    UninstalledPluginSummary,
    AnswerMurmurFriendRequestResponse,
    DeleteMurmurAccountResponse,
    GetMurmurAccountResponse,
    GetMurmurFriendsResponse,
    HappyCloudCommand,
    HappyCloudProfileCiphertextResponse,
    HappyCloudSessionBlobResponse,
    HappyCloudStatus,
    P2pStatus,
    CreateP2pInvitationResponse,
    JoinP2pInvitationResponse,
    P2pPairingState,
    SendMurmurFriendRequestResponse,
    SignupMurmurAccountRequest,
    SignupMurmurAccountResponse,
    StartMurmurServiceRequest,
    StartMurmurServiceResponse,
    StopMurmurServiceResponse,
    AddSessionShareMemberRequest,
    CreateSessionShareRequest,
    GetSessionShareHealthResponse,
    GetSessionSharePeerActivityResponse,
    GetSessionShareReplicaHistoryResponse,
    ListSessionShareReplicaCapabilitiesResponse,
    ListSessionShareReplicasResponse,
    PostSessionShareFriendMessageRequest,
    PostSessionShareFriendMessageResponse,
    SessionSharedMetadata,
    SessionShareFriendInput,
    SessionSharePeerCapability,
    SessionShareOwnerResponse,
    SessionShareToolOutput,
} from "./protocol.js";
import {
    describeSessionShareToolOutput,
    getSessionShareHealthResponseSchema,
    getSessionSharePeerActivityResponseSchema,
    getSessionShareReplicaHistoryResponseSchema,
    listSessionShareReplicaCapabilitiesResponseSchema,
    listSessionShareReplicasResponseSchema,
    postSessionShareFriendMessageResponseSchema,
    sessionShareCapabilitiesChangedEventSchema,
    HAPPY_CLOUD_CONTRACT_VERSION,
    answerMurmurFriendRequestResponseSchema,
    deleteMurmurAccountResponseSchema,
    getMurmurAccountResponseSchema,
    getMurmurFriendsResponseSchema,
    happyCloudCommandErrorResponseSchema,
    happyCloudCommandResponseSchema,
    happyCloudChangedEventSchema,
    happyCloudProfileCiphertextResponseSchema,
    happyCloudSessionBlobResponseSchema,
    happyCloudStatusSchema,
    p2pStatusChangedEventSchema,
    p2pStatusSchema,
    createP2pInvitationResponseSchema,
    joinP2pInvitationResponseSchema,
    p2pPairingStateSchema,
    listMurmurContactsResponseSchema,
    listMurmurFriendRequestsResponseSchema,
    listPluginsResponseSchema,
    discoverPluginCatalogRequestSchema,
    githubPluginCatalogSchema,
    githubPluginPackageSourceSchema,
    pluginInstallClassificationSchema,
    projectRegistrationErrorResponseSchema,
    projectResponseSchema,
    projectWorkspaceSchema,
    sessionShareOwnerResponseSchema,
    sendMurmurFriendRequestResponseSchema,
    signupMurmurAccountResponseSchema,
    startMurmurServiceResponseSchema,
    stopMurmurServiceResponseSchema,
} from "./protocol.js";
import { streamLiveEvents } from "./streamLiveEvents.js";
import { endpointUrl } from "./endpointUrl.js";

const INITIAL_MUTATION_RETRY_MS = 100;
const MAXIMUM_MUTATION_RETRY_MS = 5_000;
const PROJECT_REGISTRATION_MAX_ATTEMPTS = 3;
const PLUGIN_INSTALLATION_MAX_ATTEMPTS = 3;
const MAXIMUM_PENDING_PER_ENTITY = 256;
const MAXIMUM_BUFFERED_SESSION_EVENTS = 1_000;
/** Well inside the fifteen minutes the daemon refreshes provider usage on. */
const DEFAULT_PROVIDER_USAGE_REFRESH_MS = 60_000;
const GIT_WATCH_RENEWAL_MS = 4 * 60 * 1_000;
const GIT_WATCH_RETRY_MS = 5_000;
const MAXIMUM_PLUGIN_APP_REQUEST_BYTES = 1024 * 1024;
const MAXIMUM_PLUGIN_APP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_PLUGIN_ICON_BYTES = 4 * 1024 * 1024;
const MAXIMUM_REMEMBERED_MURMUR_FRIENDSHIP_EVENTS = 1_024;
const pluginAppToolResponseSchema = Type.Object(
    { result: Type.Unknown() },
    { additionalProperties: false },
);
const pluginAppResourceResponseSchema = Type.Object(
    {
        contents: Type.Array(
            Type.Object(
                {
                    blob: Type.Optional(Type.String()),
                    mimeType: Type.String(),
                    text: Type.Optional(Type.String()),
                    uri: Type.String(),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
const pluginAppStorageGetResponseSchema = Type.Object(
    { value: Type.Optional(Type.Unknown()) },
    { additionalProperties: false },
);
const pluginAppStorageListResponseSchema = Type.Object(
    { keys: Type.Array(Type.String(), { maxItems: 1_024 }) },
    { additionalProperties: false },
);
const emptyResponseSchema = Type.Object({}, { additionalProperties: false });
const installedPluginSummarySchema = Type.Object(
    {
        classification: pluginInstallClassificationSchema,
        description: Type.String(),
        directory: Type.String(),
        folder: Type.String(),
        name: Type.String(),
        version: Type.String(),
    },
    { additionalProperties: false },
);
const uninstalledPluginSummarySchema = Type.Object(
    {
        dataDirectory: Type.String(),
        folder: Type.String(),
        name: Type.String(),
    },
    { additionalProperties: false },
);
const installPluginResponseSchema = Type.Object(
    { plugin: installedPluginSummarySchema },
    { additionalProperties: false },
);
const uninstallPluginResponseSchema = Type.Object(
    { plugin: uninstalledPluginSummarySchema },
    { additionalProperties: false },
);
const pluginManagementErrorResponseSchema = Type.Object(
    {
        error: Type.Object(
            {
                code: Type.Union([
                    Type.Literal("install_failed"),
                    Type.Literal("catalog_invalid"),
                    Type.Literal("catalog_not_found"),
                    Type.Literal("invalid_request"),
                    Type.Literal("plugin_not_found"),
                    Type.Literal("plugins_unavailable"),
                    Type.Literal("repository_not_found"),
                    Type.Literal("source_changed"),
                    Type.Literal("source_unavailable"),
                    Type.Literal("uninstall_failed"),
                ]),
                message: Type.String(),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
const pluginCatalogErrorResponseSchema = Type.Object(
    {
        error: Type.Object(
            {
                code: Type.Union([
                    Type.Literal("catalog_invalid"),
                    Type.Literal("catalog_not_found"),
                    Type.Literal("invalid_request"),
                    Type.Literal("plugins_unavailable"),
                    Type.Literal("repository_not_found"),
                    Type.Literal("source_changed"),
                    Type.Literal("source_unavailable"),
                ]),
                message: Type.String(),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

export interface ConnectRigOptions {
    endpoint: string;
    token: string;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Test seam shared by stream reconnects and mutation backoff. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Test seam for UUIDv7 timestamps and optimistic occurrence times. */
    now?: () => number;
    /** Test seam. Production uses Web Crypto. */
    randomValues?: RandomValues;
    mutationRetryDelayMs?: number;
    /** Receives rejected actions even when their entity has no active subscriber. */
    onMutationRejected?: (delta: MutationRejectedDelta) => void;
    /** Reports the result of the daemon protocol handshake. */
    onCompatibilityChange?: (compatibility: ServerCompatibility) => void;
    /**
     * Fires the moment a chat starts waiting for the person.
     *
     * This is the notification an interface plays a sound for, so it reports the
     * transition rather than the state: a chat already waiting does not announce
     * itself again, and one that stops working after asking a question announces
     * only the question. It comes off the shared stream, so it arrives whether or
     * not a view is subscribed to that chat, and reports only chats the daemon
     * tracks unread state for.
     */
    onSessionFinished?: (finished: SessionFinished) => void;
}

/** A chat that has just started waiting for the person. */
export interface SessionFinished {
    projectId: string;
    reason: SessionUnreadReason;
    sessionId: string;
    /** When it started waiting, from the event that caused it. */
    since: number;
    workspaceId?: string;
}

export interface RigSessionSubscriptionOptions {
    sessionId: string;
    onChange: (elements: readonly ChatElement[], session: SessionState) => void;
    onDelta?: (delta: ChatDelta) => void;
    onError?: (error: unknown) => void;
    transcriptTurnLimit?: number;
}

export interface RigGroupsSubscriptionOptions {
    onChange: (projects: readonly ProjectGroup[], state: GroupsState) => void;
    onDelta?: (delta: GroupDelta) => void;
    /** Reports terminal catalog failures and recoverable live protocol diagnostics. */
    onError?: (error: unknown) => void;
}

export type HappyCloudCommandInput = HappyCloudCommand extends infer Command
    ? Command extends HappyCloudCommand
        ? Omit<Command, "contractVersion" | "expectedVersion" | "mutationId">
        : never
    : never;

export interface RigHappyCloudSubscriptionOptions {
    onChange: (status: HappyCloudStatus) => void;
    onError?: (error: unknown) => void;
}

export interface RigHappyCloudConnection {
    close: () => void;
    /** Absent until the first authoritative snapshot has loaded. */
    status: () => HappyCloudStatus | undefined;
}

export interface RigP2pSubscriptionOptions {
    onChange: (status: P2pStatus) => void;
    onError?: (error: unknown) => void;
}

export interface RigP2pConnection {
    close: () => void;
    /** Absent until the first daemon snapshot has loaded. */
    status: () => P2pStatus | undefined;
}

export interface RigInboxSubscriptionOptions {
    onChange: (items: readonly InboxItem[], state: InboxState) => void;
    onDelta?: (delta: InboxDelta) => void;
    onError?: (error: unknown) => void;
}

export interface RigProviderUsageSubscriptionOptions {
    onChange: (providers: readonly ProviderUsageEntry[], state: ProviderUsageState) => void;
    onDelta?: (delta: ProviderUsageDelta) => void;
    onError?: (error: unknown) => void;
    /**
     * How often to read the daemon again. Defaults to a minute, which is well
     * inside the fifteen minutes the daemon itself refreshes on, so a view sees
     * a new reading shortly after the daemon takes one.
     */
    refreshIntervalMs?: number;
}

export interface RigPluginsSubscriptionOptions {
    onChange: (
        apps: readonly PluginApp[],
        plugins: readonly LocalPlugin[],
        state: PluginsState,
    ) => void;
    onError?: (error: unknown) => void;
}

/**
 * Follows the authoritative Murmur social graph shared by every friends view.
 *
 * The snapshot is refetched after each friendship event instead of making a UI
 * infer the graph from a lightweight notification.
 */
export interface RigMurmurFriendsSubscriptionOptions {
    onChange: (state: MurmurFriendsState) => void;
    onError?: (error: unknown) => void;
}

export interface RigTimelineSubscriptionOptions {
    /** Leave archived chats out, as the daemon does by default. */
    includeArchived?: boolean;
    onChange: (agents: readonly TimelineAgentNode[], state: TimelineState) => void;
    onDelta?: (delta: TimelineDelta) => void;
    onError?: (error: unknown) => void;
    scope: TimelineScope;
    /** Drop work that had already finished by this moment, in milliseconds. */
    since?: number;
}

export interface RigSessionConnection {
    elements: () => readonly ChatElement[];
    session: () => SessionState;
    loadMore: (token: string) => void;
    close: () => void;
}

export interface RigGroupsConnection {
    projects: () => readonly ProjectGroup[];
    remoteTerminals: () => readonly RemoteTerminalGroupState[];
    state: () => GroupsState;
    close: () => void;
}

export interface RigInboxConnection {
    items: () => readonly InboxItem[];
    state: () => InboxState;
    close: () => void;
}

export interface RigProviderUsageConnection {
    providers: () => readonly ProviderUsageEntry[];
    state: () => ProviderUsageState;
    /** Reads the daemon now and restarts the interval from this moment. */
    refresh: () => Promise<void>;
    close: () => void;
}

export interface RigPluginsConnection {
    apps: () => readonly PluginApp[];
    plugins: () => readonly LocalPlugin[];
    state: () => PluginsState;
    readResource: (
        app: Pick<PluginApp, "generation" | "id" | "resources">,
        uri: string,
        options?: { signal?: AbortSignal },
    ) => Promise<ReadPluginAppResourceResult>;
    /** Reads the exact validated PNG generation declared by this catalog entry. */
    readIcon: (
        plugin: Pick<LocalPlugin, "icon" | "id">,
        options?: { signal?: AbortSignal },
    ) => Promise<ReadPluginIconResult>;
    callTool: (
        app: Pick<PluginApp, "generation" | "id" | "tools">,
        server: string,
        name: string,
        argumentsValue: unknown,
        options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    storageDelete(app: Pick<PluginApp, "generation" | "id">, key: string): Promise<void>;
    storageGet(
        app: Pick<PluginApp, "generation" | "id">,
        key: string,
    ): Promise<unknown | undefined>;
    storageList(app: Pick<PluginApp, "generation" | "id">): Promise<readonly string[]>;
    storageSet(
        app: Pick<PluginApp, "generation" | "id">,
        key: string,
        value: unknown,
    ): Promise<void>;
    close: () => void;
}

export interface RigMurmurFriendsConnection {
    account: () => MurmurFriendsState["account"];
    contacts: () => MurmurFriendsState["contacts"];
    friendships: () => MurmurFriendsState["friendships"];
    state: () => MurmurFriendsState;
    stats: () => MurmurFriendsState["stats"];
    close: () => void;
}

export interface RigTimelineConnection {
    agents: () => readonly TimelineAgentNode[];
    state: () => TimelineState;
    close: () => void;
}

export interface SendMessageInput {
    content?: readonly ContentBlock[];
    displayText?: string;
    text: string;
}

export interface ModelSelection {
    modelId: string;
    providerId?: string;
}

export interface DraftUpdate {
    draft: string | null;
    origin?: string;
    updatedAt?: number;
}

export interface UserInputAnswers {
    answers: Readonly<Record<string, readonly string[]>>;
}

export type GoalStatus = "active" | "blocked" | "complete" | "paused";
export type SecretAttachmentScope = "project" | "session";

export interface ShellCommandInput {
    command: string;
    commandId: string;
}

export interface CreateSessionInput {
    appendSystemPrompt?: string;
    cwd: string;
    effort?: string;
    local?: boolean;
    modelId?: string;
    permissionMode?: string;
    hostedCapabilities?: readonly string[];
    /**
     * Identity to give the project if this directory is not one yet.
     *
     * A directory that Rig already knows keeps the identity it has, so this
     * names an import rather than asserting which project the session lands in.
     */
    projectId?: string;
    providerId?: string;
    secretIds?: readonly string[];
    serviceTier?: string;
    trackUnread?: boolean;
    workflowsEnabled?: boolean;
    workspaceId?: string;
}

export interface CreateWorkspaceInput {
    /** Explicit base to fork; the project's main branch on the remote is used when it is absent. */
    baseRef?: string;
    name: string;
    projectId: string;
}

export interface TerminalPresence {
    connectionId: string;
    close: () => Promise<void>;
    setFocused: (focused: boolean) => Promise<void>;
}

export interface ProjectAddOptions {
    /** Reuses a caller-owned identity. Rig Connect creates one when this is absent. */
    projectId?: string;
    signal?: AbortSignal;
}

export interface RigProjects {
    /**
     * Registers a Git top-level folder and returns Rig's authoritative project entity.
     *
     * Ambiguous transport failures retry with one project identity, so a response lost after the
     * daemon commits still converges on the entity that was already created.
     */
    add(path: string, options?: ProjectAddOptions): Promise<Project>;
}

export class ProjectRegistrationError extends Error {
    constructor(
        readonly code: ProjectRegistrationErrorCode,
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "ProjectRegistrationError";
    }
}

export class ProjectRegistrationProtocolError extends Error {
    constructor(
        readonly code: "invalid_response" | "request_failed",
        readonly status: number | undefined,
        message: string,
    ) {
        super(message);
        this.name = "ProjectRegistrationProtocolError";
    }
}

export type GroupTarget =
    | { kind: "project"; projectId: string }
    | { kind: "workspace"; projectId: string; workspaceId: string };

/**
 * One shared Rig connection.
 *
 * Every action returns a mutation identity synchronously, after its prediction
 * is already visible. Delivery, retries, reconciliation, and rejection are
 * handled in the background.
 */
export interface RigConnection {
    /** Current result of the daemon protocol handshake. */
    compatibility: () => ServerCompatibility;
    connectSession: (options: RigSessionSubscriptionOptions) => RigSessionConnection;
    connectGroups: (options: RigGroupsSubscriptionOptions) => RigGroupsConnection;
    connectInbox: (options: RigInboxSubscriptionOptions) => RigInboxConnection;
    /** Follows the authoritative status plus this client's pending Happy Cloud choices. */
    connectHappyCloud: (options: RigHappyCloudSubscriptionOptions) => RigHappyCloudConnection;
    /** Follows authenticated P2P transports and trusted peer reachability. */
    connectP2p: (options: RigP2pSubscriptionOptions) => RigP2pConnection;
    createP2pInvitation: () => Promise<CreateP2pInvitationResponse>;
    joinP2pInvitation: (invitation: string) => Promise<JoinP2pInvitationResponse>;
    getP2pPairing: (id: string) => Promise<P2pPairingState>;
    answerP2pVerification: (id: string, accept: boolean) => Promise<P2pPairingState>;
    /**
     * Follows how much of each provider account's plan has been used.
     *
     * Usage is polled rather than streamed, so this subscription reads the
     * daemon itself and repeats on an interval for as long as a view is
     * mounted. It reports a loading state until the first answer arrives.
     */
    connectProviderUsage: (
        options: RigProviderUsageSubscriptionOptions,
    ) => RigProviderUsageConnection;
    /** Follows the complete local plugin and application catalog. */
    connectPlugins: (options: RigPluginsSubscriptionOptions) => RigPluginsConnection;
    /** Follows the complete Murmur friendship graph and its counters. */
    connectMurmurFriends: (
        options: RigMurmurFriendsSubscriptionOptions,
    ) => RigMurmurFriendsConnection;
    connectTimeline: (options: RigTimelineSubscriptionOptions) => RigTimelineConnection;
    /** Reads the current plugin catalog once. Lifecycle changes are also announced live. */
    listPlugins: (options?: { signal?: AbortSignal }) => Promise<{
        failures: readonly { error: string; folder: string }[];
        plugins: readonly PluginSummary[];
    }>;
    /** Reads one bounded current-run log or startup-failure diagnostic snapshot. */
    readPluginLog: (name: string, options?: { signal?: AbortSignal }) => Promise<PluginLogSnapshot>;
    /** Resolves and validates one explicit GitHub repository plugin catalog. */
    discoverPluginCatalog: (
        source: DiscoverPluginCatalogRequest,
        options?: { signal?: AbortSignal },
    ) => Promise<GitHubPluginCatalog>;
    /**
     * Installs and starts a plugin from an absolute source-folder path on the machine running Rig.
     *
     * The source folder belongs to the daemon machine, not to the browser or other remote client.
     */
    installPlugin: (
        source: string | GitHubPluginPackageSource,
        options?: { requestId?: string; signal?: AbortSignal },
    ) => Promise<InstalledPluginSummary>;
    /** Stops a plugin, removes its managed code, and keeps its writable data folder. */
    uninstallPlugin: (
        name: string,
        options?: { signal?: AbortSignal },
    ) => Promise<UninstalledPluginSummary>;
    getMurmurAccount: (options?: MurmurOperationOptions) => Promise<GetMurmurAccountResponse>;
    signupMurmurAccount: (
        request: SignupMurmurAccountRequest,
        options?: MurmurOperationOptions,
    ) => Promise<SignupMurmurAccountResponse>;
    startMurmurService: (
        request?: StartMurmurServiceRequest,
        options?: MurmurOperationOptions,
    ) => Promise<StartMurmurServiceResponse>;
    stopMurmurService: (options?: MurmurOperationOptions) => Promise<StopMurmurServiceResponse>;
    deleteMurmurAccount: (options?: MurmurOperationOptions) => Promise<DeleteMurmurAccountResponse>;
    sendMurmurFriendRequest: (
        token: string,
        options?: MurmurOperationOptions,
    ) => Promise<SendMurmurFriendRequestResponse>;
    listMurmurFriendRequests: (
        options?: MurmurOperationOptions,
    ) => Promise<ListMurmurFriendRequestsResponse>;
    answerMurmurFriendRequest: (
        peerId: string,
        answer: "accept" | "reject",
        options?: MurmurOperationOptions,
    ) => Promise<AnswerMurmurFriendRequestResponse>;
    listMurmurContacts: (options?: MurmurOperationOptions) => Promise<ListMurmurContactsResponse>;
    /** Reads the complete current friendship graph once. */
    listMurmurFriends: (options?: MurmurOperationOptions) => Promise<GetMurmurFriendsResponse>;
    /** Owner operations are queued like other session mutations; daemon routes may be unavailable. */
    createSessionShare: (
        sessionId: string,
        input: Omit<CreateSessionShareRequest, "mutationId">,
    ) => MutationId;
    addSessionShareMember: (sessionId: string, friend: SessionShareFriendInput) => MutationId;
    revokeSessionShareMember: (sessionId: string, shareMemberId: string) => MutationId;
    stopSessionShare: (sessionId: string) => MutationId;
    setSessionShareFriendMessages: (
        sessionId: string,
        includeFriendMessagesInModel: boolean,
    ) => MutationId;
    /** Raises or lowers how much of each tool's work friends receive from now on. */
    setSessionShareToolOutput: (
        sessionId: string,
        toolOutput: SessionShareToolOutput,
    ) => MutationId;
    /** Replaces one member's whole capability set; it is not a delta. */
    setSessionShareMemberCapabilities: (
        sessionId: string,
        shareMemberId: string,
        capabilities: readonly SessionSharePeerCapability[],
    ) => MutationId;
    /** Posts through an authenticated member grant; this is not an optimistic owner mutation. */
    postSessionShareFriendMessage: (
        request: PostSessionShareFriendMessageRequest,
        options?: SessionShareOperationOptions,
    ) => Promise<PostSessionShareFriendMessageResponse>;
    listSessionShareReplicas: (
        options?: SessionShareOperationOptions,
    ) => Promise<ListSessionShareReplicasResponse>;
    getSessionShareReplicaHistory: (
        shareId: string,
        options?: SessionShareOperationOptions & { after?: string },
    ) => Promise<GetSessionShareReplicaHistoryResponse>;
    getSessionShareHealth: (
        shareId: string,
        options?: SessionShareOperationOptions,
    ) => Promise<GetSessionShareHealthResponse>;
    /** The owner's own read of what happened: who was allowed, and who was denied. */
    getSessionSharePeerActivity: (
        sessionId: string,
        options?: SessionShareOperationOptions & { after?: string },
    ) => Promise<GetSessionSharePeerActivityResponse>;
    /** What a member's own replica of a shared session may currently do. */
    listSessionShareReplicaCapabilities: (
        shareId: string,
        options?: SessionShareOperationOptions,
    ) => Promise<ListSessionShareReplicaCapabilitiesResponse>;
    /** Entity-first project catalog actions. */
    projects: RigProjects;
    /** Reads enrollment, profile status, and every independently denied/granted capability. */
    getHappyCloudStatus: (options?: HappyCloudOperationOptions) => Promise<HappyCloudStatus>;
    /**
     * Applies one Happy Cloud choice optimistically.
     *
     * Rig Connect supplies the strict contract version, expected state version,
     * and stable mutation identity used for ordered retry and reconciliation.
     */
    applyHappyCloudCommand: (command: HappyCloudCommandInput) => MutationId;
    /** Reads caller-encrypted Happy Profile ciphertext without interpreting it. */
    getHappyCloudProfile: (
        options?: HappyCloudOperationOptions,
    ) => Promise<HappyCloudProfileCiphertextResponse | undefined>;
    /** Reads caller-encrypted mobile session ciphertext without interpreting it. */
    getHappyCloudSessionBlob: (
        sessionId: string,
        options?: HappyCloudOperationOptions,
    ) => Promise<HappyCloudSessionBlobResponse | undefined>;
    /** Returns the workspace's own identity, which is also this action's identity. */
    createWorkspace: (input: CreateWorkspaceInput) => MutationId;
    archiveWorkspace: (projectId: string, workspaceId: string) => MutationId;
    /** Returns the session's own identity, which is also this action's identity. */
    createSession: (input: CreateSessionInput) => MutationId;
    forkSession: (sessionId: string) => MutationId;
    /** Clears a chat's unread state, the way focusing a terminal on it does. */
    markSessionRead: (sessionId: string) => MutationId;
    sendMessage: (sessionId: string, message: string | SendMessageInput) => MutationId;
    sendContextMessage: (sessionId: string, text: string) => MutationId;
    stopRun: (sessionId: string) => MutationId;
    switchModel: (sessionId: string, selection: string | ModelSelection) => MutationId;
    setEffort: (sessionId: string, effort?: string) => MutationId;
    setServiceTier: (sessionId: string, serviceTier?: string) => MutationId;
    setPermissionMode: (sessionId: string, permissionMode: string) => MutationId;
    setDraft: (sessionId: string, update: string | DraftUpdate) => MutationId;
    setAppendSystemPrompt: (sessionId: string, prompt: string | null) => MutationId;
    answerUserInput: (
        sessionId: string,
        requestId: string,
        response: UserInputAnswers,
    ) => MutationId;
    setGoal: (sessionId: string, objective: string) => MutationId;
    setGoalStatus: (sessionId: string, status: GoalStatus) => MutationId;
    clearGoal: (sessionId: string) => MutationId;
    attachSecret: (
        sessionId: string,
        secretId: string,
        scope?: SecretAttachmentScope,
    ) => MutationId;
    detachSecret: (
        sessionId: string,
        secretId: string,
        scope?: SecretAttachmentScope,
    ) => MutationId;
    compactSession: (sessionId: string) => MutationId;
    resetSession: (sessionId: string) => MutationId;
    rewindSession: (sessionId: string, messageId: string) => MutationId;
    runShellCommand: (sessionId: string, input: ShellCommandInput) => MutationId;
    stopWorkflow: (sessionId: string, runId: string) => MutationId;
    stopBackgroundProcesses: (sessionId: string) => MutationId;
    stopBackgroundProcess: (sessionId: string, processSessionId: number) => MutationId;
    readBackgroundProcess: (
        sessionId: string,
        processSessionId: number,
        options?: { signal?: AbortSignal; waitMs?: number },
    ) => Promise<BackgroundProcessSnapshot | undefined>;
    resolveExternalToolCall: (
        sessionId: string,
        callId: string,
        resolution: ExternalToolCallResolution,
    ) => MutationId;
    cancelScheduledMessage: (sessionId: string, scheduledMessageId: string) => MutationId;
    recordActivity: (sessionId: string) => MutationId;
    connectTerminalPresence: (
        sessionId: string,
        options: { focused?: boolean; targetPid: number },
    ) => Promise<TerminalPresence>;
    setSessionArchived: (sessionId: string, archived: boolean) => MutationId;
    renameGroup: (target: GroupTarget, name: string) => MutationId;
    close: () => void;
}

export interface MurmurOperationOptions {
    signal?: AbortSignal;
}

export interface SessionShareOperationOptions {
    signal?: AbortSignal;
}

export interface HappyCloudOperationOptions {
    signal?: AbortSignal;
}

interface SessionSubscriber extends RigSessionSubscriptionOptions {
    closed: boolean;
}

interface GroupSubscriber extends RigGroupsSubscriptionOptions {
    closed: boolean;
}

interface InboxSubscriber extends RigInboxSubscriptionOptions {
    closed: boolean;
}

interface InboxEntry {
    store: InboxStore;
    subscribers: Set<InboxSubscriber>;
}

interface ProviderUsageSubscriber extends RigProviderUsageSubscriptionOptions {
    closed: boolean;
}

interface ProviderUsageEntryState {
    controller: AbortController;
    inFlight: boolean;
    refreshIntervalMs: number;
    store: ProviderUsageStore;
    subscribers: Set<ProviderUsageSubscriber>;
    timer: ReturnType<typeof setTimeout> | undefined;
}

interface PluginsSubscriber extends RigPluginsSubscriptionOptions {
    closed: boolean;
}

interface BufferedPluginsEvent {
    cursor: string;
    data: Extract<GlobalEvent, { type: "plugins_changed" }>["data"];
}

interface PluginsEntry {
    bootstrapVersion: number;
    bootstrapping: boolean;
    controller: AbortController;
    detachRoot: () => void;
    pending?: BufferedPluginsEvent;
    started: boolean;
    store: PluginStore;
    subscribers: Set<PluginsSubscriber>;
}

interface MurmurFriendsSubscriber extends RigMurmurFriendsSubscriptionOptions {
    closed: boolean;
}

interface MurmurFriendsEntry {
    bootstrapVersion: number;
    controller: AbortController;
    detachRoot: () => void;
    loading: boolean;
    reloadPending: boolean;
    rememberedEventIds: Set<string>;
    rememberedEventOrder: string[];
    snapshotLoaded: boolean;
    started: boolean;
    store: MurmurFriendsStore;
    subscribers: Set<MurmurFriendsSubscriber>;
}

interface TimelineSubscriber extends RigTimelineSubscriptionOptions {
    closed: boolean;
}

interface TimelineEntry {
    bootstrapVersion: number;
    controller: AbortController;
    detachRoot: () => void;
    includeArchived: boolean;
    key: string;
    scope: TimelineScope;
    since?: number;
    started: boolean;
    store: TimelineStore;
    subscribers: Set<TimelineSubscriber>;
}

interface BufferedSessionEvent {
    cursor: string;
    event: SessionEvent;
}

interface SessionEntry {
    bootstrapVersion: number;
    bufferOverflowed: boolean;
    controller: AbortController;
    detachRoot: () => void;
    /**
     * Events held while a bootstrap is in flight.
     *
     * A snapshot is taken at one position and delivered asynchronously, so events
     * after that position can arrive before it lands. They are kept here and
     * replayed onto the snapshot rather than being applied to a session the
     * snapshot is about to replace.
     */
    pending?: BufferedSessionEvent[] | undefined;
    started: boolean;
    store: ChatStore;
    subscribers: Set<SessionSubscriber>;
    transcriptTurnLimit?: number;
}

interface GroupEntry {
    bootstrapVersion: number;
    controller: AbortController;
    detachRoot: () => void;
    started: boolean;
    store: GroupStore;
    subscribers: Set<GroupSubscriber>;
}

interface HappyCloudSubscriber extends RigHappyCloudSubscriptionOptions {
    closed: boolean;
}

interface HappyCloudEntry {
    acknowledgements: Map<string, number>;
    authoritativeVersion: number;
    bootstrapVersion: number;
    controller: AbortController;
    detachRoot: () => void;
    lastLoadError?: unknown;
    loadErrorReported: boolean;
    loaded: boolean;
    loading?: Promise<void>;
    recoveryScheduled: boolean;
    ready: Promise<void>;
    requiredVersion: number;
    started: boolean;
    status: HappyCloudStatus;
    subscribers: Set<HappyCloudSubscriber>;
}

interface P2pSubscriber extends RigP2pSubscriptionOptions {
    closed: boolean;
}

interface P2pEntry {
    controller: AbortController;
    detachRoot: () => void;
    eventRevision: number;
    lastLoadError?: unknown;
    loading?: Promise<void>;
    recoveryScheduled: boolean;
    reloadPending: boolean;
    started: boolean;
    status?: P2pStatus;
    subscribers: Set<P2pSubscriber>;
}

interface MutationRequest {
    body?: unknown;
    headers?: Readonly<Record<string, string>>;
    method: "DELETE" | "PATCH" | "POST" | "PUT";
    url: string;
}

interface PendingMutation {
    acknowledged: boolean;
    action: MutationAction;
    applyAuthoritativeResponse?: (data: unknown) => void;
    applyAcceptedResponse?: (data: unknown) => boolean;
    applyOptimistic: (publish: boolean) => () => void;
    attemptController?: AbortController;
    entityKey: string;
    expectsWorkspaceResponse?: boolean;
    id: MutationId;
    matchesAuthoritative?: (data: unknown) => boolean;
    prepare: () => MutationRequest;
    reconcileEchoInPlace?: boolean;
    ready?: () => Promise<void>;
    rebaseOnConflict?: (data: unknown) => boolean;
    replacesTranscript?: boolean;
    retryOnConflict?: boolean;
    sessionId?: string;
    undo: () => void;
    versionSessionId?: string;
}

interface ReconcileOutput {
    groupDeltas?: readonly GroupDelta[];
    sessionDeltas?: ReadonlyMap<string, readonly ChatDelta[]>;
}

interface SessionCapture {
    elements: readonly ChatElement[];
    entry: SessionEntry;
    session: SessionState;
}

interface GroupCapture {
    entry: GroupEntry;
    projects: readonly ProjectGroup[];
    state: GroupsState;
}

interface GitWatchEntity {
    projectId: string;
    workspaceId?: string;
}

/** Creates the one client a UI shares across its group and session views. */
export function connectRig(options: ConnectRigOptions): RigConnection {
    const request = options.fetch ?? globalThis.fetch;
    const wait = options.wait ?? defaultWait;
    const now = options.now ?? Date.now;
    const nextMutationId = orderedUuidV7(now, options.randomValues);
    // What the client creates, the client names. The identity is a cuid2, the
    // same kind the daemon would have minted, and it doubles as the mutation
    // identity so one create is one entity however its echo arrives.
    const nextEntityId = createCuid2(now, options.randomValues);
    const rootController = new AbortController();
    const sessionEntries = new Map<string, SessionEntry>();
    const queues = new Map<string, PendingMutation[]>();
    const activeWorkers = new Set<string>();
    const pendingOverlays: PendingMutation[] = [];
    const knownSessionCursors = new Map<string, string>();
    const knownGroupVersions = new Map<string, number>();
    const presenceClosers = new Set<() => void>();
    let groupsEntry: GroupEntry | undefined;
    let happyCloudEntry: HappyCloudEntry | undefined;
    let p2pEntry: P2pEntry | undefined;
    let inboxEntry: InboxEntry | undefined;
    let murmurFriendsEntry: MurmurFriendsEntry | undefined;
    let pluginsEntry: PluginsEntry | undefined;
    let providerUsageEntry: ProviderUsageEntryState | undefined;
    const timelineEntries = new Map<string, TimelineEntry>();
    let liveStreamStarted = false;
    let liveStreamOpen = false;
    let compatibility = CHECKING_SERVER_COMPATIBILITY;
    let gitWatchInFlight = false;
    let gitWatchPending = false;
    let gitWatchSignature = "";
    let gitWatchTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const publishSession = (entry: SessionEntry, deltas: readonly ChatDelta[]): void => {
        if (closed || deltas.length === 0) return;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.elements(), entry.store.session());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const publishGroups = (entry: GroupEntry, deltas: readonly GroupDelta[]): void => {
        if (closed || deltas.length === 0) return;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.projects(), entry.store.state());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const publishHappyCloud = (): void => {
        const entry = happyCloudEntry;
        if (closed || entry === undefined || !entry.loaded) return;
        for (const subscriber of [...entry.subscribers]) {
            if (!subscriber.closed) subscriber.onChange(entry.status);
        }
    };

    const publishP2p = (): void => {
        const entry = p2pEntry;
        if (closed || entry?.status === undefined) return;
        for (const subscriber of [...entry.subscribers]) {
            if (!subscriber.closed) subscriber.onChange(entry.status);
        }
    };

    const publishInbox = (deltas: readonly InboxDelta[]): void => {
        if (closed || deltas.length === 0 || inboxEntry === undefined) return;
        for (const subscriber of [...inboxEntry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(inboxEntry.store.items(), inboxEntry.store.state());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const publishPlugins = (changed: boolean): void => {
        if (closed || !changed || pluginsEntry === undefined) return;
        for (const subscriber of [...pluginsEntry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(
                pluginsEntry.store.apps(),
                pluginsEntry.store.plugins(),
                pluginsEntry.store.state(),
            );
        }
    };

    const publishMurmurFriends = (changed: boolean): void => {
        const entry = murmurFriendsEntry;
        if (closed || !changed || entry === undefined) return;
        for (const subscriber of [...entry.subscribers]) {
            if (!subscriber.closed) subscriber.onChange(entry.store.state());
        }
    };

    const publishTimeline = (entry: TimelineEntry, deltas: readonly TimelineDelta[]): void => {
        if (closed || deltas.length === 0) return;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.agents(), entry.store.state());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const setTimelineConnection = (connection: TimelineState["connection"]): void => {
        for (const entry of [...timelineEntries.values()]) {
            if (entry.started) publishTimeline(entry, entry.store.setConnection(connection));
        }
    };

    const applyOutput = (output: ReconcileOutput): void => {
        for (const [sessionId, deltas] of output.sessionDeltas ?? []) {
            const entry = sessionEntries.get(sessionId);
            if (entry !== undefined) publishSession(entry, deltas);
        }
        if (output.groupDeltas !== undefined && groupsEntry !== undefined) {
            publishGroups(groupsEntry, output.groupDeltas);
        }
    };

    const acknowledge = (mutationId: string | undefined): void => {
        if (mutationId === undefined) return;
        const mutation = pendingOverlays.find((candidate) => candidate.id === mutationId);
        if (mutation === undefined) return;
        mutation.acknowledged = true;
        mutation.attemptController?.abort();
        const index = pendingOverlays.indexOf(mutation);
        if (index >= 0) pendingOverlays.splice(index, 1);
    };

    /**
     * Applies one authoritative update beneath the optimistic layer.
     *
     * Predictions are removed in reverse order and reapplied in FIFO order,
     * which makes every undo capture the newest authoritative-before value.
     */
    const reconcile = (
        entityKeys: readonly string[],
        mutationId: string | undefined,
        affectedSessionIds: readonly string[],
        affectsGroups: boolean,
        authoritative: () => ReconcileOutput,
    ): void => {
        const keys = new Set(entityKeys);
        const relevant = pendingOverlays.filter(
            (mutation) =>
                keys.has(mutation.entityKey) &&
                !(mutation.id === mutationId && mutation.reconcileEchoInPlace === true),
        );
        if (relevant.length === 0) {
            acknowledge(mutationId);
            applyOutput(authoritative());
            return;
        }

        const sessionIds = new Set(affectedSessionIds);
        for (const mutation of relevant) {
            if (mutation.sessionId !== undefined) sessionIds.add(mutation.sessionId);
        }
        const sessionCaptures = new Map<string, SessionCapture>();
        for (const sessionId of sessionIds) {
            const entry = sessionEntries.get(sessionId);
            if (entry === undefined) continue;
            sessionCaptures.set(sessionId, {
                elements: entry.store.elements(),
                entry,
                session: entry.store.session(),
            });
        }
        const groupCapture: GroupCapture | undefined =
            groupsEntry === undefined || (!affectsGroups && relevant.length === 0)
                ? undefined
                : {
                      entry: groupsEntry,
                      projects: groupsEntry.store.projects(),
                      state: groupsEntry.store.state(),
                  };

        for (const mutation of [...relevant].reverse()) mutation.undo();
        const output = authoritative();
        acknowledge(mutationId);
        for (const mutation of pendingOverlays) {
            if (keys.has(mutation.entityKey)) mutation.undo = mutation.applyOptimistic(false);
        }

        for (const [sessionId, capture] of sessionCaptures) {
            const semantic: ChatDelta[] = [...(output.sessionDeltas?.get(sessionId) ?? [])].filter(
                (delta) => delta.type !== "elements_changed" && delta.type !== "session_changed",
            );
            if (capture.entry.store.session() !== capture.session) {
                semantic.push({
                    session: capture.entry.store.session(),
                    type: "session_changed",
                });
            }
            if (capture.entry.store.elements() !== capture.elements) {
                semantic.push({
                    elements: capture.entry.store.elements(),
                    type: "elements_changed",
                });
            }
            publishSession(capture.entry, semantic);
        }
        for (const [sessionId, deltas] of output.sessionDeltas ?? []) {
            if (!sessionCaptures.has(sessionId)) {
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) publishSession(entry, deltas);
            }
        }

        if (groupCapture !== undefined) {
            const semantic: GroupDelta[] = [...(output.groupDeltas ?? [])].filter(
                (delta) =>
                    delta.type !== "projects_changed" && delta.type !== "groups_state_changed",
            );
            if (groupCapture.entry.store.state() !== groupCapture.state) {
                semantic.unshift({
                    state: groupCapture.entry.store.state(),
                    type: "groups_state_changed",
                });
            }
            if (groupCapture.entry.store.projects() !== groupCapture.projects) {
                semantic.unshift({
                    projects: groupCapture.entry.store.projects(),
                    type: "projects_changed",
                });
            }
            publishGroups(groupCapture.entry, semantic);
        } else if (output.groupDeltas !== undefined && groupsEntry !== undefined) {
            publishGroups(groupsEntry, output.groupDeltas);
        }
    };

    const currentSessionCursor = (sessionId: string): string | undefined =>
        knownSessionCursors.get(sessionId) ??
        sessionEntries.get(sessionId)?.store.session().lastEventId ??
        groupsEntry?.store.sessionSummary(sessionId)?.lastEventId;

    const groupVersion = (target: GroupTarget): number | undefined =>
        knownGroupVersions.get(groupKey(target)) ?? groupsEntry?.store.groupVersion(target);

    const rememberSessionCursor = (sessionId: string, cursor: string): void => {
        const known = knownSessionCursors.get(sessionId);
        if (known === undefined || known < cursor) knownSessionCursors.set(sessionId, cursor);
    };

    const rememberGroupVersion = (key: string, version: number): void => {
        const known = knownGroupVersions.get(key);
        if (known === undefined || known < version) knownGroupVersions.set(key, version);
    };

    const recordAcceptedResponse = (mutation: PendingMutation, data: unknown): void => {
        if (data === null || typeof data !== "object") return;
        const value = data as {
            eventId?: unknown;
            project?: { version?: unknown };
            session?: { lastEventId?: unknown };
            workspace?: { version?: unknown };
        };
        const versionSessionId = mutation.versionSessionId ?? mutation.sessionId;
        if (versionSessionId !== undefined) {
            const cursor =
                typeof value.session?.lastEventId === "string"
                    ? value.session.lastEventId
                    : typeof value.eventId === "string"
                      ? value.eventId
                      : undefined;
            if (cursor !== undefined) rememberSessionCursor(versionSessionId, cursor);
        }
        const version = value.project?.version ?? value.workspace?.version;
        if (typeof version === "number") rememberGroupVersion(mutation.entityKey, version);
    };

    const applyAcceptedResponse = (mutation: PendingMutation, data: unknown): boolean => {
        if (mutation.applyAcceptedResponse?.(data) === true) return true;
        if (mutation.sessionId !== undefined && isSessionShareMutationAction(mutation.action)) {
            let response: SessionShareOwnerResponse;
            try {
                response = Value.Decode(sessionShareOwnerResponseSchema, data);
            } catch {
                rejectMutation(mutation, "Rig returned an invalid session-sharing response.");
                return true;
            }
            const sessionId = mutation.sessionId;
            reconcile(
                [mutation.entityKey],
                mutation.id,
                [sessionId],
                groupsEntry !== undefined,
                () => ({
                    ...(groupsEntry === undefined
                        ? {}
                        : {
                              groupDeltas: groupsEntry.store.applySessionShare(
                                  sessionId,
                                  response.share,
                              ),
                          }),
                    ...(sessionEntries.has(sessionId)
                        ? {
                              sessionDeltas: new Map([
                                  [
                                      sessionId,
                                      sessionEntries
                                          .get(sessionId)!
                                          .store.applySessionShare(response.share),
                                  ],
                              ]),
                          }
                        : {}),
                }),
            );
            return true;
        }

        const project = responseEntity(data, "project");
        if (
            groupsEntry !== undefined &&
            typeof project?.id === "string" &&
            typeof project.version === "number"
        ) {
            const entry = groupsEntry;
            const event = {
                createdAt: now(),
                data: { mutationId: mutation.id, project: project as unknown as Project },
                id: mutation.id,
                projectId: project.id,
                type: "project_updated",
            } as GlobalEvent;
            reconcile([mutation.entityKey], mutation.id, [], true, () => ({
                groupDeltas: entry.store.apply(event),
            }));
            return true;
        }

        const workspace = responseEntity(data, "workspace");
        if (
            groupsEntry !== undefined &&
            workspace !== undefined &&
            Value.Check(projectWorkspaceSchema, workspace)
        ) {
            const entry = groupsEntry;
            const event = {
                createdAt: now(),
                data: {
                    mutationId: mutation.id,
                    workspace,
                },
                id: mutation.id,
                projectId: workspace.projectId,
                type: "workspace_updated",
                workspaceId: workspace.id,
            } as GlobalEvent;
            reconcile([mutation.entityKey], mutation.id, [], true, () => ({
                groupDeltas: entry.store.apply(event),
            }));
            return true;
        }

        const session = responseEntity(data, "session");
        if (
            mutation.sessionId !== undefined &&
            isProtocolSessionResponse(session) &&
            sessionEntries.has(mutation.sessionId)
        ) {
            const event: SessionEvent = {
                createdAt: now(),
                data: { session },
                id: typeof session.lastEventId === "string" ? session.lastEventId : mutation.id,
                sessionId: mutation.sessionId,
                type: "session_updated",
            };
            reconcile(
                [mutation.entityKey],
                mutation.id,
                [mutation.sessionId],
                groupsEntry !== undefined,
                () => ({
                    ...(groupsEntry === undefined
                        ? {}
                        : { groupDeltas: groupsEntry.store.apply(event) }),
                    sessionDeltas: new Map([
                        [
                            mutation.sessionId as string,
                            (mutation.replacesTranscript
                                ? sessionEntries
                                      .get(mutation.sessionId as string)
                                      ?.store.applySessionReplacement(session)
                                : sessionEntries
                                      .get(mutation.sessionId as string)
                                      ?.store.applySessionSnapshot(session)) ?? [],
                        ],
                    ]),
                }),
            );
            return true;
        }
        return false;
    };

    const applyAuthoritativeResponseDirectly = (
        mutation: PendingMutation,
        data: unknown,
    ): ReconcileOutput => {
        mutation.applyAuthoritativeResponse?.(data);
        const project = responseEntity(data, "project");
        if (
            groupsEntry !== undefined &&
            typeof project?.id === "string" &&
            typeof project.version === "number"
        ) {
            const event = {
                createdAt: now(),
                data: { project: project as unknown as Project },
                id: mutation.id,
                projectId: project.id,
                type: "project_updated",
            } as GlobalEvent;
            return { groupDeltas: groupsEntry.store.apply(event) };
        }
        const workspace = responseEntity(data, "workspace");
        if (
            groupsEntry !== undefined &&
            workspace !== undefined &&
            Value.Check(projectWorkspaceSchema, workspace)
        ) {
            const event = {
                createdAt: now(),
                data: { workspace },
                id: mutation.id,
                projectId: workspace.projectId,
                type: "workspace_updated",
                workspaceId: workspace.id,
            } as GlobalEvent;
            return { groupDeltas: groupsEntry.store.apply(event) };
        }
        const session = responseEntity(data, "session");
        if (mutation.sessionId !== undefined && isProtocolSessionResponse(session)) {
            const event: SessionEvent = {
                createdAt: now(),
                data: { session },
                id: typeof session.lastEventId === "string" ? session.lastEventId : mutation.id,
                sessionId: mutation.sessionId,
                type: "session_updated",
            };
            const entry = sessionEntries.get(mutation.sessionId);
            return {
                ...(groupsEntry === undefined
                    ? {}
                    : { groupDeltas: groupsEntry.store.apply(event) }),
                ...(entry === undefined
                    ? {}
                    : {
                          sessionDeltas: new Map([
                              [mutation.sessionId, entry.store.applySessionSnapshot(session)],
                          ]),
                      }),
            };
        }
        return {};
    };

    const rejectMutation = (
        mutation: PendingMutation,
        message: string,
        authoritativeData?: unknown,
    ): void => {
        const sameEntity = pendingOverlays.filter(
            (candidate) => candidate.entityKey === mutation.entityKey,
        );
        const sessionIds = new Set(
            sameEntity.flatMap((candidate) =>
                candidate.sessionId === undefined ? [] : [candidate.sessionId],
            ),
        );
        const captures = new Map<string, SessionCapture>();
        for (const sessionId of sessionIds) {
            const entry = sessionEntries.get(sessionId);
            if (entry === undefined) continue;
            captures.set(sessionId, {
                elements: entry.store.elements(),
                entry,
                session: entry.store.session(),
            });
        }
        const groupCapture =
            groupsEntry === undefined
                ? undefined
                : {
                      entry: groupsEntry,
                      projects: groupsEntry.store.projects(),
                      state: groupsEntry.store.state(),
                  };
        for (const candidate of [...sameEntity].reverse()) candidate.undo();
        const index = pendingOverlays.indexOf(mutation);
        if (index >= 0) pendingOverlays.splice(index, 1);
        const authoritative = applyAuthoritativeResponseDirectly(mutation, authoritativeData);
        for (const candidate of pendingOverlays) {
            if (candidate.entityKey === mutation.entityKey) {
                candidate.undo = candidate.applyOptimistic(false);
            }
        }
        if (mutation.entityKey === "happy-cloud") publishHappyCloud();

        const rejection: MutationRejectedDelta = {
            action: mutation.action,
            message,
            mutationId: mutation.id,
            type: "mutation_rejected",
        };
        options.onMutationRejected?.(rejection);
        for (const capture of captures.values()) {
            const deltas: ChatDelta[] = [
                ...(authoritative.sessionDeltas?.get(capture.entry.store.session().sessionId) ??
                    []),
                rejection,
            ].filter(
                (delta) => delta.type !== "elements_changed" && delta.type !== "session_changed",
            );
            if (capture.entry.store.session() !== capture.session) {
                deltas.unshift({
                    session: capture.entry.store.session(),
                    type: "session_changed",
                });
            }
            if (capture.entry.store.elements() !== capture.elements) {
                deltas.unshift({
                    elements: capture.entry.store.elements(),
                    type: "elements_changed",
                });
            }
            publishSession(capture.entry, deltas);
        }
        if (groupCapture !== undefined) {
            const deltas: GroupDelta[] = [...(authoritative.groupDeltas ?? []), rejection].filter(
                (delta) =>
                    delta.type !== "projects_changed" && delta.type !== "groups_state_changed",
            );
            if (groupCapture.entry.store.projects() !== groupCapture.projects) {
                deltas.unshift({
                    projects: groupCapture.entry.store.projects(),
                    type: "projects_changed",
                });
            }
            publishGroups(groupCapture.entry, deltas);
        }
    };

    const performMutation = async (
        mutation: PendingMutation,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const prepared = mutation.prepare();
        const headers: Record<string, string> = {
            accept: "application/json",
            authorization: `Bearer ${options.token}`,
            ...prepared.headers,
        };
        if (prepared.body !== undefined) headers["content-type"] = "application/json";
        const response = await request(prepared.url, {
            ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }),
            headers,
            method: prepared.method,
            signal,
        });
        const data = await readResponseBody(response);
        if (!response.ok) {
            throw new MutationHttpError(
                response.status,
                humanMutationError(data, response.status),
                retryAfterMilliseconds(response.headers.get("retry-after"), now()),
                data,
            );
        }
        return data;
    };

    const pump = async (entityKey: string): Promise<void> => {
        if (activeWorkers.has(entityKey)) return;
        activeWorkers.add(entityKey);
        let retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
        try {
            for (;;) {
                if (closed) return;
                const queue = queues.get(entityKey);
                const mutation = queue?.[0];
                if (queue === undefined || mutation === undefined) return;
                if (mutation.acknowledged) {
                    queue.shift();
                    retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                    continue;
                }

                const controller = linkedController(rootController.signal);
                mutation.attemptController = controller.controller;
                try {
                    if (mutation.ready !== undefined) await mutation.ready();
                    const data = await performMutation(mutation, controller.controller.signal);
                    if (closed) return;
                    if (mutation.expectsWorkspaceResponse === true && !isWorkspaceResponse(data)) {
                        queue.shift();
                        rejectMutation(
                            mutation,
                            "Rig returned an invalid workspace response.",
                            data,
                        );
                        retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                        continue;
                    }
                    recordAcceptedResponse(mutation, data);
                    // A successful response commits the prediction. It stays
                    // visible in the store, but is no longer an overlay that a
                    // reconnect snapshot could accidentally reapply forever.
                    if (!applyAcceptedResponse(mutation, data)) acknowledge(mutation.id);
                    queue.shift();
                    retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                } catch (error) {
                    if (closed) return;
                    if (mutation.acknowledged) {
                        queue.shift();
                        retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                        continue;
                    }
                    if (
                        error instanceof MutationHttpError &&
                        error.status === 409 &&
                        mutation.matchesAuthoritative?.(error.data) === true
                    ) {
                        recordAcceptedResponse(mutation, error.data);
                        acknowledge(mutation.id);
                        queue.shift();
                        retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                        continue;
                    }
                    if (
                        error instanceof MutationHttpError &&
                        error.status === 409 &&
                        mutation.rebaseOnConflict?.(error.data) === true
                    ) {
                        recordAcceptedResponse(mutation, error.data);
                        continue;
                    }
                    if (
                        error instanceof MutationHttpError &&
                        error.status === 409 &&
                        mutation.retryOnConflict === true
                    ) {
                        recordAcceptedResponse(mutation, error.data);
                        continue;
                    }
                    if (
                        error instanceof MutationHttpError &&
                        error.status === 409 &&
                        mutation.expectsWorkspaceResponse === true &&
                        hasInvalidWorkspaceField(error.data)
                    ) {
                        queue.shift();
                        rejectMutation(
                            mutation,
                            "Rig returned an invalid workspace response.",
                            error.data,
                        );
                        retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                        continue;
                    }
                    if (isRetryableMutationError(error)) {
                        const delay =
                            error instanceof MutationHttpError && error.retryAfterMs !== undefined
                                ? Math.min(MAXIMUM_MUTATION_RETRY_MS, error.retryAfterMs)
                                : retryDelay;
                        await wait(delay, rootController.signal);
                        retryDelay = Math.min(MAXIMUM_MUTATION_RETRY_MS, retryDelay * 2);
                        continue;
                    }
                    queue.shift();
                    rejectMutation(
                        mutation,
                        describeMutationRejection(error),
                        error instanceof MutationHttpError ? error.data : undefined,
                    );
                } finally {
                    delete mutation.attemptController;
                    controller.detach();
                }
            }
        } finally {
            activeWorkers.delete(entityKey);
            const queue = queues.get(entityKey);
            if (queue?.length === 0) queues.delete(entityKey);
            releaseUnusedEntries();
        }
    };

    const enqueue = (mutation: PendingMutation): MutationId => {
        if (closed) throw new Error("This Rig connection is closed.");
        mutation.undo = mutation.applyOptimistic(true);
        pendingOverlays.push(mutation);
        const queue = queues.get(mutation.entityKey) ?? [];
        if (!queues.has(mutation.entityKey)) queues.set(mutation.entityKey, queue);
        if (queue.length >= MAXIMUM_PENDING_PER_ENTITY) {
            rejectMutation(
                mutation,
                "Rig could not queue that change because too many changes are already pending.",
            );
            return mutation.id;
        }
        queue.push(mutation);
        void pump(mutation.entityKey);
        return mutation.id;
    };

    const createSessionEntry = (
        sessionId: string,
        transcriptTurnLimit: number | undefined,
    ): SessionEntry => {
        const known = sessionEntries.get(sessionId);
        if (known !== undefined) return known;
        const linked = linkedController(rootController.signal);
        const entry: SessionEntry = {
            bootstrapVersion: 0,
            bufferOverflowed: false,
            controller: linked.controller,
            detachRoot: linked.detach,
            started: false,
            store: new ChatStore(sessionId),
            subscribers: new Set(),
            ...(transcriptTurnLimit === undefined ? {} : { transcriptTurnLimit }),
        };
        sessionEntries.set(sessionId, entry);
        const key = sessionKey(sessionId);
        if (pendingOverlays.some((mutation) => mutation.entityKey === key)) {
            reconcile([key], undefined, [sessionId], true, () => ({}));
        }
        return entry;
    };

    /**
     * Loads a session by request-response and rebases it onto the live stream.
     *
     * The stream is opened first and this runs second, so an event that lands
     * while the bootstrap is in flight is still delivered and replayed on top of
     * what it describes.
     */
    const bootstrapSession = async (entry: SessionEntry): Promise<void> => {
        const sessionId = entry.store.session().sessionId;
        let version = ++entry.bootstrapVersion;
        // Collecting starts before the request, so an event that lands while it is
        // in flight is held rather than lost or applied out of order.
        entry.pending ??= [];
        let state: SessionStateResponse;
        while (true) {
            try {
                state = await fetchSessionState(
                    options.endpoint,
                    options.token,
                    sessionId,
                    entry.transcriptTurnLimit,
                    entry.store.newestMessageEventId(),
                    request,
                    entry.controller.signal,
                );
            } catch (error) {
                if (version !== entry.bootstrapVersion) return;
                entry.bufferOverflowed = false;
                entry.pending = undefined;
                throw error;
            }
            // A newer reload supersedes this answer. It shares the same pending
            // buffer, so events collected by this request remain available to the
            // request that will actually land.
            if (version !== entry.bootstrapVersion) return;
            if (!entry.bufferOverflowed) break;
            // The bounded buffer could not prove continuity. Take a newer
            // snapshot while continuing to collect, rather than applying a
            // response that might have an event missing after its cursor.
            entry.bufferOverflowed = false;
            entry.pending = [];
            version = ++entry.bootstrapVersion;
        }
        // Only what the snapshot does not already contain. The cursor is the
        // global-stream position it was taken at. Session event ids come from a
        // different UUID scope and cannot be compared with it.
        const replay = (entry.pending ?? []).filter((item) => item.cursor > state.cursor);
        entry.pending = undefined;
        const newest = replay.at(-1)?.event.id ?? state.lastEventId;
        if (newest !== undefined) rememberSessionCursor(sessionId, newest);
        reconcile([sessionKey(sessionId)], undefined, [sessionId], true, () => ({
            sessionDeltas: new Map([
                [
                    sessionId,
                    [
                        ...entry.store.setConnection("live"),
                        ...entry.store.applyHello(state),
                        ...replay.flatMap(({ event }) => [...entry.store.apply(event)]),
                    ],
                ],
            ]),
        }));
        queueGitWatchSync();
    };

    const startSessionEntry = (entry: SessionEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        // Opening the stream reports a position, and that is what triggers the
        // load. A view attaching to a stream that is already open has missed that
        // signal, so it loads now instead.
        if (!liveStreamOpen) return;
        void bootstrapSession(entry).catch((error: unknown) => {
            if (closed || entry.controller.signal.aborted) return;
            publishSession(entry, entry.store.setConnection("closed"));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        });
    };

    const createGroupEntry = (): GroupEntry => {
        if (groupsEntry !== undefined) return groupsEntry;
        const linked = linkedController(rootController.signal);
        const entry: GroupEntry = {
            bootstrapVersion: 0,
            controller: linked.controller,
            detachRoot: linked.detach,
            started: false,
            store: new GroupStore(),
            subscribers: new Set(),
        };
        groupsEntry = entry;
        if (pendingOverlays.length > 0) {
            reconcile(
                pendingOverlays.map((mutation) => mutation.entityKey),
                undefined,
                [],
                true,
                () => ({}),
            );
        }
        return entry;
    };

    const loadCatalog = async (entry: GroupEntry): Promise<void> => {
        const version = ++entry.bootstrapVersion;
        let hello: GlobalStreamHello;
        try {
            hello = await fetchCatalog(
                options.endpoint,
                options.token,
                request,
                entry.controller.signal,
            );
        } catch (error) {
            if (version !== entry.bootstrapVersion) return;
            throw error;
        }
        if (version !== entry.bootstrapVersion) return;
        const catalogCompatibility = serverCompatibility(hello.protocolVersion);
        if (catalogCompatibility.status !== "compatible") {
            throw new Error(describeServerCompatibility(catalogCompatibility));
        }
        if (
            !hello.workspaces.every((workspace) => Value.Check(projectWorkspaceSchema, workspace))
        ) {
            throw new Error("Rig returned an invalid workspace catalog.");
        }
        for (const project of hello.projects) {
            rememberGroupVersion(projectKey(project.id), project.version);
        }
        for (const workspace of hello.workspaces) {
            rememberGroupVersion(
                workspaceKey(workspace.projectId, workspace.id),
                workspace.version,
            );
        }
        for (const session of hello.sessions) {
            if (session.lastEventId !== undefined) {
                rememberSessionCursor(session.id, session.lastEventId);
            }
        }
        reconcile(
            pendingOverlays.map((mutation) => mutation.entityKey),
            undefined,
            [],
            true,
            () => ({
                groupDeltas: [
                    ...entry.store.setConnection("live"),
                    ...entry.store.applyHello(hello),
                ],
            }),
        );
        if (inboxEntry !== undefined) {
            publishInbox([
                ...inboxEntry.store.setConnection("live"),
                ...inboxEntry.store.applyHello(hello),
            ]);
        }
        queueGitWatchSync();
    };

    const reportCatalogError = (entry: GroupEntry, error: unknown): void => {
        if (closed || entry.controller.signal.aborted) return;
        publishGroups(entry, entry.store.setConnection("closed"));
        for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        if (inboxEntry !== undefined) {
            publishInbox(inboxEntry.store.setConnection("closed"));
            for (const subscriber of [...inboxEntry.subscribers]) {
                subscriber.onError?.(error);
            }
        }
    };

    const reportInvalidWorkspaceEvent = (): void => {
        const error = new Error("Rig ignored an invalid live workspace update.");
        if (groupsEntry !== undefined) {
            for (const subscriber of [...groupsEntry.subscribers]) subscriber.onError?.(error);
        }
        if (inboxEntry !== undefined) {
            for (const subscriber of [...inboxEntry.subscribers]) subscriber.onError?.(error);
        }
    };

    const startGroupEntry = (entry: GroupEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        void loadCatalog(entry).catch((error: unknown) => reportCatalogError(entry, error));
    };

    const createPluginsEntry = (): PluginsEntry => {
        if (pluginsEntry !== undefined) return pluginsEntry;
        const linked = linkedController(rootController.signal);
        const entry: PluginsEntry = {
            bootstrapVersion: 0,
            bootstrapping: false,
            controller: linked.controller,
            detachRoot: linked.detach,
            started: false,
            store: new PluginStore(),
            subscribers: new Set(),
        };
        pluginsEntry = entry;
        return entry;
    };

    const loadPlugins = async (entry: PluginsEntry): Promise<void> => {
        const version = ++entry.bootstrapVersion;
        entry.bootstrapping = true;
        let snapshot: ListPluginsResponse;
        try {
            snapshot = await fetchPluginCatalog(
                options.endpoint,
                options.token,
                request,
                entry.controller.signal,
            );
        } catch (error) {
            if (version !== entry.bootstrapVersion) return;
            entry.bootstrapping = false;
            delete entry.pending;
            throw error;
        }
        if (version !== entry.bootstrapVersion) return;
        const pending = entry.pending;
        delete entry.pending;
        entry.bootstrapping = false;
        const catalog =
            pending !== undefined && pending.data.version > snapshot.version
                ? pending.data
                : snapshot;
        publishPlugins(entry.store.replace(catalog.plugins, catalog.failures, "live"));
    };

    const startPluginsEntry = (entry: PluginsEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        void loadPlugins(entry).catch((error: unknown) => {
            if (closed || entry.controller.signal.aborted) return;
            publishPlugins(entry.store.setConnection("closed"));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        });
    };

    const createMurmurFriendsEntry = (): MurmurFriendsEntry => {
        if (murmurFriendsEntry !== undefined) return murmurFriendsEntry;
        const linked = linkedController(rootController.signal);
        const entry: MurmurFriendsEntry = {
            bootstrapVersion: 0,
            controller: linked.controller,
            detachRoot: linked.detach,
            loading: false,
            reloadPending: false,
            rememberedEventIds: new Set(),
            rememberedEventOrder: [],
            snapshotLoaded: false,
            started: false,
            store: new MurmurFriendsStore(),
            subscribers: new Set(),
        };
        murmurFriendsEntry = entry;
        return entry;
    };

    const reportMurmurFriendsError = (entry: MurmurFriendsEntry, error: unknown): void => {
        if (closed || entry.controller.signal.aborted) return;
        // A request event may have arrived immediately before this failed
        // reload. Retain that fact so a clean stream reconnect also rebuilds
        // instead of relabeling a stale graph as live.
        entry.reloadPending = true;
        publishMurmurFriends(entry.store.setConnection("closed"));
        for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
    };

    /**
     * Keeps at most one fetch in flight. Events that land while it is reading
     * merely ask it for one newer snapshot once that read has settled.
     */
    const loadMurmurFriends = async (entry: MurmurFriendsEntry): Promise<void> => {
        if (entry.loading) {
            entry.reloadPending = true;
            return;
        }
        entry.loading = true;
        const version = ++entry.bootstrapVersion;
        try {
            do {
                entry.reloadPending = false;
                const snapshot = await requestMurmur(
                    "murmur/friends",
                    getMurmurFriendsResponseSchema,
                    murmurJsonInit("GET", undefined, { signal: entry.controller.signal }),
                );
                if (
                    closed ||
                    entry.controller.signal.aborted ||
                    version !== entry.bootstrapVersion ||
                    murmurFriendsEntry !== entry
                ) {
                    return;
                }
                entry.snapshotLoaded = true;
                publishMurmurFriends(entry.store.replace(snapshot, "live"));
            } while (entry.reloadPending);
        } finally {
            entry.loading = false;
        }
    };

    const requestMurmurFriendsReload = (entry: MurmurFriendsEntry): void => {
        void loadMurmurFriends(entry).catch((error: unknown) => {
            reportMurmurFriendsError(entry, error);
        });
    };

    const rememberMurmurFriendshipEvent = (entry: MurmurFriendsEntry, id: string): boolean => {
        if (entry.rememberedEventIds.has(id)) return false;
        entry.rememberedEventIds.add(id);
        entry.rememberedEventOrder.push(id);
        if (entry.rememberedEventOrder.length > MAXIMUM_REMEMBERED_MURMUR_FRIENDSHIP_EVENTS) {
            const oldest = entry.rememberedEventOrder.shift();
            if (oldest !== undefined) entry.rememberedEventIds.delete(oldest);
        }
        return true;
    };

    const startMurmurFriendsEntry = (entry: MurmurFriendsEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        requestMurmurFriendsReload(entry);
    };

    const createTimelineEntry = (subscription: RigTimelineSubscriptionOptions): TimelineEntry => {
        const key = timelineKey(subscription);
        const existing = timelineEntries.get(key);
        if (existing !== undefined) return existing;
        const linked = linkedController(rootController.signal);
        const entry: TimelineEntry = {
            bootstrapVersion: 0,
            controller: linked.controller,
            detachRoot: linked.detach,
            includeArchived: subscription.includeArchived ?? false,
            key,
            scope: subscription.scope,
            started: false,
            store: new TimelineStore(subscription.scope),
            subscribers: new Set(),
            ...(subscription.since === undefined ? {} : { since: subscription.since }),
        };
        timelineEntries.set(key, entry);
        return entry;
    };

    const loadTimeline = async (entry: TimelineEntry): Promise<void> => {
        const version = ++entry.bootstrapVersion;
        let snapshot: GetTimelineResponse;
        try {
            snapshot = await fetchTimeline(
                options.endpoint,
                options.token,
                request,
                entry,
                entry.controller.signal,
            );
        } catch (error) {
            if (version !== entry.bootstrapVersion) return;
            throw error;
        }
        if (version !== entry.bootstrapVersion) return;
        publishTimeline(entry, [
            ...entry.store.setConnection("live"),
            ...entry.store.applySnapshot(snapshot),
        ]);
    };

    const startTimelineEntry = (entry: TimelineEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        void loadTimeline(entry).catch((error: unknown) => {
            if (closed || entry.controller.signal.aborted) return;
            publishTimeline(entry, entry.store.setConnection("closed"));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        });
    };

    /**
     * Opens the one subscription this connection has, if it is not open already.
     *
     * Groups and chats are both views over this single stream: a chat filters it
     * down to the session it is showing rather than opening a stream of its own.
     */
    const ensureLiveStream = (): void => {
        if (liveStreamStarted) return;
        liveStreamStarted = true;
        void streamLiveEvents({
            endpoint: options.endpoint,
            fetch: request,
            signal: rootController.signal,
            token: options.token,
            ...(options.wait === undefined ? {} : { wait }),
            onOpen: (hello) => {
                const nextCompatibility = serverCompatibility(hello.protocolVersion);
                if (
                    nextCompatibility.status !== compatibility.status ||
                    ("serverProtocolVersion" in nextCompatibility &&
                        (!("serverProtocolVersion" in compatibility) ||
                            nextCompatibility.serverProtocolVersion !==
                                compatibility.serverProtocolVersion))
                ) {
                    compatibility = nextCompatibility;
                    options.onCompatibilityChange?.(compatibility);
                }
                if (nextCompatibility.status !== "compatible") return false;
                liveStreamOpen = true;
                // A clean resume replayed every missed event, so what this client
                // holds is already current. A gap is what leaves it uncertain, and
                // a first open is the case where it holds nothing at all.
                //
                // Nothing needs reloading here, but the views are still showing
                // "reconnecting", so they are told the stream is live. On the
                // reload path this is deliberately left to the load itself: a view
                // must not report live while it is still empty.
                if (hello.resumed && !hello.gap) {
                    if (p2pEntry !== undefined && p2pEntry.started) {
                        void loadP2p(p2pEntry);
                    }
                    if (groupsEntry !== undefined) {
                        publishGroups(groupsEntry, groupsEntry.store.setConnection("live"));
                    }
                    if (inboxEntry !== undefined) {
                        publishInbox(inboxEntry.store.setConnection("live"));
                    }
                    if (pluginsEntry !== undefined) {
                        publishPlugins(pluginsEntry.store.setConnection("live"));
                    }
                    if (murmurFriendsEntry !== undefined) {
                        const friends = murmurFriendsEntry;
                        if (friends.started && (!friends.snapshotLoaded || friends.reloadPending)) {
                            requestMurmurFriendsReload(friends);
                        } else {
                            publishMurmurFriends(friends.store.setConnection("live"));
                        }
                    }
                    setTimelineConnection("live");
                    for (const entry of [...sessionEntries.values()]) {
                        if (entry.started) publishSession(entry, entry.store.setConnection("live"));
                    }
                    return true;
                }
                gitWatchSignature = "";
                if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
                gitWatchTimer = undefined;
                if (happyCloudEntry !== undefined && happyCloudEntry.started) {
                    void requestHappyCloudReload(happyCloudEntry, hello.gap);
                }
                if (p2pEntry !== undefined && p2pEntry.started) {
                    void loadP2p(p2pEntry);
                }
                const groups = groupsEntry;
                if (groups !== undefined && groups.started) {
                    void loadCatalog(groups).catch((error: unknown) =>
                        reportCatalogError(groups, error),
                    );
                }
                const plugins = pluginsEntry;
                if (plugins !== undefined && plugins.started) {
                    void loadPlugins(plugins).catch((error: unknown) => {
                        if (closed || plugins.controller.signal.aborted) return;
                        publishPlugins(plugins.store.setConnection("closed"));
                        for (const subscriber of [...plugins.subscribers]) {
                            subscriber.onError?.(error);
                        }
                    });
                }
                const friends = murmurFriendsEntry;
                if (friends !== undefined && friends.started) {
                    requestMurmurFriendsReload(friends);
                }
                for (const entry of [...sessionEntries.values()]) {
                    if (!entry.started) continue;
                    void bootstrapSession(entry).catch((error: unknown) => {
                        if (closed || entry.controller.signal.aborted) return;
                        for (const subscriber of [...entry.subscribers]) {
                            subscriber.onError?.(error);
                        }
                    });
                }
                // A gap means this chart may have missed the events that closed
                // a span, so it is rebuilt from the daemon rather than left to
                // drift. A first open loads it for the first time.
                for (const entry of [...timelineEntries.values()]) {
                    if (!entry.started) continue;
                    void loadTimeline(entry).catch((error: unknown) => {
                        if (closed || entry.controller.signal.aborted) return;
                        for (const subscriber of [...entry.subscribers]) {
                            subscriber.onError?.(error);
                        }
                    });
                }
                return true;
            },
            onEvent: (event, cursor) => {
                if (!isValidWorkspaceEvent(event)) {
                    reportInvalidWorkspaceEvent();
                    return;
                }
                rememberGlobalIdentity(event);
                if (event.type === "p2p_status_changed") {
                    const entry = p2pEntry;
                    if (entry === undefined || !entry.started) return;
                    try {
                        const changed = Value.Decode(p2pStatusChangedEventSchema, event);
                        entry.eventRevision += 1;
                        const statusChanged = !sameP2pStatus(entry.status, changed.data.status);
                        if (statusChanged) entry.status = changed.data.status;
                        delete entry.lastLoadError;
                        if (statusChanged) publishP2p();
                    } catch {
                        void loadP2p(entry);
                    }
                    return;
                }
                if (event.type === "happy_cloud_changed") {
                    const entry = happyCloudEntry;
                    if (entry === undefined || !entry.started) return;
                    let changed: Static<typeof happyCloudChangedEventSchema>;
                    try {
                        changed = Value.Decode(happyCloudChangedEventSchema, event);
                    } catch {
                        void requestHappyCloudReload(entry);
                        return;
                    }
                    if (
                        pendingOverlays.some((mutation) => mutation.id === changed.data.mutationId)
                    ) {
                        entry.acknowledgements.set(changed.data.mutationId, changed.data.version);
                    }
                    if (entry.loaded && changed.data.version <= entry.authoritativeVersion) {
                        acknowledge(changed.data.mutationId);
                        entry.acknowledgements.delete(changed.data.mutationId);
                        releaseUnusedEntries();
                        return;
                    }
                    entry.requiredVersion = Math.max(entry.requiredVersion, changed.data.version);
                    void requestHappyCloudReload(entry);
                    return;
                }
                if (event.type === "murmur_friendship_changed") {
                    const entry = murmurFriendsEntry;
                    if (
                        entry !== undefined &&
                        entry.started &&
                        rememberMurmurFriendshipEvent(entry, event.id)
                    ) {
                        requestMurmurFriendsReload(entry);
                    }
                    return;
                }
                if (event.type === "session_share_capabilities_changed") {
                    let changed: Static<typeof sessionShareCapabilitiesChangedEventSchema>;
                    try {
                        changed = Value.Decode(sessionShareCapabilitiesChangedEventSchema, event);
                    } catch {
                        return;
                    }
                    // Keyed by shareId, not sessionId: an owner session has at
                    // most one current share, so every open session whose share
                    // matches is the one this member row belongs to.
                    for (const entry of sessionEntries.values()) {
                        if (entry.pending !== undefined) continue;
                        publishSession(
                            entry,
                            entry.store.applySessionShareMemberCapabilities(
                                changed.data.shareId,
                                changed.data.shareMemberId,
                                changed.data.capabilities,
                                changed.data.capabilitiesDescription,
                                changed.data.memberState,
                            ),
                        );
                    }
                    return;
                }
                if (event.type === "plugins_changed") {
                    const entry = pluginsEntry;
                    if (entry === undefined || !entry.started) return;
                    const update = {
                        cursor,
                        data: (event as Extract<GlobalEvent, { type: "plugins_changed" }>).data,
                    };
                    if (entry.bootstrapping) {
                        if (entry.pending === undefined || cursor > entry.pending.cursor) {
                            entry.pending = update;
                        }
                    } else {
                        publishPlugins(
                            entry.store.replace(update.data.plugins, update.data.failures, "live"),
                        );
                    }
                    return;
                }
                if (
                    event.type === "project_git_changed" ||
                    event.type === "workspace_git_changed"
                ) {
                    applyGitSnapshot(event);
                    return;
                }
                if ("sessionId" in event && typeof event.sessionId === "string") {
                    // Held only while that session is bootstrapping; the snapshot
                    // replays these itself once it lands.
                    const entry = sessionEntries.get(event.sessionId);
                    if (entry?.pending !== undefined) {
                        if (entry.pending.length === MAXIMUM_BUFFERED_SESSION_EVENTS) {
                            entry.pending.shift();
                            entry.bufferOverflowed = true;
                        }
                        entry.pending.push({ cursor, event: event as SessionEvent });
                    }
                }
                const mutationId = mutationIdOf(event);
                const mutationKey = pendingOverlays.find(
                    (mutation) => mutation.id === mutationId,
                )?.entityKey;
                const key = globalEventKey(event);
                const sessionId =
                    "sessionId" in event && typeof event.sessionId === "string"
                        ? event.sessionId
                        : undefined;
                const session = sessionId === undefined ? undefined : sessionEntries.get(sessionId);
                const unreadBefore =
                    sessionId === undefined
                        ? undefined
                        : groupsEntry?.store.sessionSummary(sessionId)?.unread;
                reconcile(
                    mutationKey === undefined ? [key] : [key, mutationKey],
                    mutationId,
                    sessionId === undefined ? [] : [sessionId],
                    true,
                    () => ({
                        ...(groupsEntry === undefined
                            ? {}
                            : { groupDeltas: groupsEntry.store.apply(event) }),
                        ...(session === undefined ||
                        sessionId === undefined ||
                        session.pending !== undefined
                            ? {}
                            : {
                                  sessionDeltas: new Map([
                                      [sessionId, session.store.apply(event as SessionEvent)],
                                  ]),
                              }),
                    }),
                );
                if (inboxEntry !== undefined) publishInbox(inboxEntry.store.apply(event));
                for (const entry of [...timelineEntries.values()]) {
                    if (entry.started) publishTimeline(entry, entry.store.apply(event));
                }
                if (sessionId !== undefined) reportFinished(sessionId, unreadBefore);
                if (
                    event.type === "project_created" ||
                    event.type === "project_updated" ||
                    event.type === "workspace_created" ||
                    event.type === "workspace_updated"
                ) {
                    queueGitWatchSync();
                }
            },
            onDisconnected: () => {
                liveStreamOpen = false;
                if (groupsEntry !== undefined) {
                    publishGroups(groupsEntry, groupsEntry.store.setConnection("reconnecting"));
                }
                if (inboxEntry !== undefined) {
                    publishInbox(inboxEntry.store.setConnection("reconnecting"));
                }
                if (pluginsEntry !== undefined) {
                    publishPlugins(pluginsEntry.store.setConnection("reconnecting"));
                }
                if (murmurFriendsEntry !== undefined) {
                    publishMurmurFriends(murmurFriendsEntry.store.setConnection("reconnecting"));
                }
                setTimelineConnection("reconnecting");
                for (const entry of [...sessionEntries.values()]) {
                    if (entry.started) {
                        publishSession(entry, entry.store.setConnection("reconnecting"));
                    }
                }
            },
        })
            .catch((error: unknown) => {
                if (closed || rootController.signal.aborted) return;
                if (groupsEntry !== undefined) {
                    publishGroups(groupsEntry, groupsEntry.store.setConnection("closed"));
                    for (const subscriber of [...groupsEntry.subscribers]) {
                        subscriber.onError?.(error);
                    }
                }
                if (inboxEntry !== undefined) {
                    publishInbox(inboxEntry.store.setConnection("closed"));
                    for (const subscriber of [...inboxEntry.subscribers]) {
                        subscriber.onError?.(error);
                    }
                }
                if (pluginsEntry !== undefined) {
                    publishPlugins(pluginsEntry.store.setConnection("closed"));
                    for (const subscriber of [...pluginsEntry.subscribers]) {
                        subscriber.onError?.(error);
                    }
                }
                if (murmurFriendsEntry !== undefined) {
                    publishMurmurFriends(murmurFriendsEntry.store.setConnection("closed"));
                    for (const subscriber of [...murmurFriendsEntry.subscribers]) {
                        subscriber.onError?.(error);
                    }
                }
                for (const entry of [...sessionEntries.values()]) {
                    publishSession(entry, entry.store.setConnection("closed"));
                    for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                }
                for (const entry of [...timelineEntries.values()]) {
                    publishTimeline(entry, entry.store.setConnection("closed"));
                    for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                }
            })
            .finally(() => {
                if (closed || rootController.signal.aborted) return;
                if (groupsEntry !== undefined) {
                    publishGroups(groupsEntry, groupsEntry.store.setConnection("closed"));
                }
                if (inboxEntry !== undefined) {
                    publishInbox(inboxEntry.store.setConnection("closed"));
                }
                if (pluginsEntry !== undefined) {
                    publishPlugins(pluginsEntry.store.setConnection("closed"));
                }
                if (murmurFriendsEntry !== undefined) {
                    publishMurmurFriends(murmurFriendsEntry.store.setConnection("closed"));
                }
                for (const entry of [...sessionEntries.values()]) {
                    publishSession(entry, entry.store.setConnection("closed"));
                }
                setTimelineConnection("closed");
            });
    };

    /**
     * Announces a chat that has just started waiting for the person.
     *
     * Only the transition is reported. A chat already waiting stays quiet, so a
     * burst of events from one stopped run makes one sound, and a reconnect that
     * reloads the same waiting chat makes none.
     */
    const reportFinished = (sessionId: string, before: SessionUnreadState | undefined): void => {
        const notify = options.onSessionFinished;
        if (notify === undefined) return;
        const summary = groupsEntry?.store.sessionSummary(sessionId);
        const unread = summary?.unread;
        if (summary === undefined || unread === undefined) return;
        if (before !== undefined && before.reason === unread.reason) return;
        notify({
            projectId: summary.projectId,
            reason: unread.reason,
            sessionId,
            since: unread.since,
            ...(summary.workspaceId === undefined ? {} : { workspaceId: summary.workspaceId }),
        });
    };

    const rememberGlobalIdentity = (event: GlobalEvent): void => {
        if (
            event.type !== "session_current" &&
            "sessionId" in event &&
            typeof event.sessionId === "string"
        ) {
            rememberSessionCursor(event.sessionId, event.id);
        }
        if (event.type === "project_created" || event.type === "project_updated") {
            const project = (event.data as { project: { id: string; version: number } }).project;
            rememberGroupVersion(projectKey(project.id), project.version);
        }
        if (event.type === "workspace_created" || event.type === "workspace_updated") {
            const workspace = (
                event.data as {
                    workspace: { id: string; projectId: string; version: number };
                }
            ).workspace;
            rememberGroupVersion(
                workspaceKey(workspace.projectId, workspace.id),
                workspace.version,
            );
        }
        if (event.type === "session_current") {
            const session = (event.data as { session: { id: string; lastEventId?: string } })
                .session;
            if (session.lastEventId !== undefined) {
                rememberSessionCursor(session.id, session.lastEventId);
            }
        }
    };

    const applyGitSnapshot = (event: GlobalEvent): void => {
        if (event.type !== "project_git_changed" && event.type !== "workspace_git_changed") return;
        const scope = event as {
            data: { git: GitChangeSnapshot };
            projectId: string;
            workspaceId?: string;
        };
        const affected = [...sessionEntries.entries()].filter(([, entry]) => {
            const session = entry.store.session();
            return (
                session.projectId === scope.projectId && session.workspaceId === scope.workspaceId
            );
        });
        reconcile(
            [globalEventKey(event)],
            undefined,
            affected.map(([sessionId]) => sessionId),
            groupsEntry !== undefined,
            () => ({
                ...(groupsEntry === undefined
                    ? {}
                    : { groupDeltas: groupsEntry.store.apply(event) }),
                ...(affected.length === 0
                    ? {}
                    : {
                          sessionDeltas: new Map(
                              affected.map(([sessionId, entry]) => [
                                  sessionId,
                                  entry.store.applyGitSnapshot(scope.data.git),
                              ]),
                          ),
                      }),
            }),
        );
    };

    const gitWatchEntities = (): readonly GitWatchEntity[] => {
        const entities = new Map<string, GitWatchEntity>();
        const add = (entity: GitWatchEntity): void => {
            const key =
                entity.workspaceId === undefined
                    ? `project:${entity.projectId}`
                    : `workspace:${entity.workspaceId}`;
            entities.set(key, entity);
        };
        for (const project of groupsEntry?.store.projects() ?? []) {
            add({ projectId: project.id });
            for (const workspace of project.workspaces) {
                add({ projectId: project.id, workspaceId: workspace.id });
            }
        }
        for (const entry of sessionEntries.values()) {
            const session = entry.store.session();
            if (session.projectId.length === 0) continue;
            add({
                projectId: session.projectId,
                ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            });
        }
        return [...entities]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => value);
    };

    const scheduleGitWatchSync = (delay: number): void => {
        if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
        gitWatchTimer = setTimeout(() => {
            gitWatchTimer = undefined;
            queueGitWatchSync(true);
        }, delay);
    };

    const queueGitWatchSync = (force = false): void => {
        if (closed) return;
        const entities = gitWatchEntities();
        const signature = JSON.stringify(entities);
        if (!force && signature === gitWatchSignature) return;
        if (gitWatchInFlight) {
            gitWatchPending = true;
            return;
        }
        if (entities.length === 0) {
            gitWatchSignature = "";
            if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
            gitWatchTimer = undefined;
            return;
        }
        gitWatchInFlight = true;
        gitWatchSignature = signature;
        void fetchGitWatch(
            options.endpoint,
            options.token,
            entities,
            request,
            rootController.signal,
        )
            .then((snapshots) => {
                if (closed) return;
                for (const snapshot of snapshots) applyGitSnapshot(snapshot);
                scheduleGitWatchSync(GIT_WATCH_RENEWAL_MS);
            })
            .catch(() => {
                if (closed || rootController.signal.aborted) return;
                if (gitWatchSignature === signature) gitWatchSignature = "";
                scheduleGitWatchSync(GIT_WATCH_RETRY_MS);
            })
            .finally(() => {
                gitWatchInFlight = false;
                if (!gitWatchPending || closed) return;
                gitWatchPending = false;
                queueGitWatchSync();
            });
    };

    const releaseUnusedEntries = (): void => {
        for (const [sessionId, entry] of sessionEntries) {
            const key = sessionKey(sessionId);
            if (
                entry.subscribers.size > 0 ||
                pendingOverlays.some((mutation) => mutation.entityKey === key) ||
                (queues.get(key)?.length ?? 0) > 0
            ) {
                continue;
            }
            entry.controller.abort();
            entry.detachRoot();
            sessionEntries.delete(sessionId);
        }
        for (const [key, entry] of [...timelineEntries]) {
            if (entry.subscribers.size > 0) continue;
            entry.controller.abort();
            entry.detachRoot();
            timelineEntries.delete(key);
        }
        if (
            happyCloudEntry !== undefined &&
            happyCloudEntry.subscribers.size === 0 &&
            !pendingOverlays.some((mutation) => mutation.entityKey === "happy-cloud") &&
            (queues.get("happy-cloud")?.length ?? 0) === 0
        ) {
            happyCloudEntry.controller.abort();
            happyCloudEntry.detachRoot();
            happyCloudEntry = undefined;
        }
        if (p2pEntry !== undefined && p2pEntry.subscribers.size === 0) {
            p2pEntry.controller.abort();
            p2pEntry.detachRoot();
            p2pEntry = undefined;
        }
        if (
            groupsEntry !== undefined &&
            groupsEntry.subscribers.size === 0 &&
            // Finish notifications are answered from the catalog, which is where
            // the chat's project and whether it is tracked at all are known, so
            // asking for them keeps it loaded with no view open.
            options.onSessionFinished === undefined &&
            inboxEntry === undefined &&
            pendingOverlays.length === 0 &&
            queues.size === 0
        ) {
            groupsEntry.controller.abort();
            groupsEntry.detachRoot();
            groupsEntry = undefined;
        }
    };

    const connectSession = (subscription: RigSessionSubscriptionOptions): RigSessionConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createSessionEntry(subscription.sessionId, subscription.transcriptTurnLimit);
        const subscriber: SessionSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.elements(), entry.store.session());
        startSessionEntry(entry);

        const loadMore = (token: string): void => {
            if (closed || subscriber.closed) return;
            const started = entry.store.startLoadingMore(token);
            if (started === undefined) return;
            publishSession(entry, started.deltas);
            void fetchEarlier(
                options.endpoint,
                options.token,
                subscription.sessionId,
                started.anchor.before,
                request,
                entry.controller.signal,
            )
                .then((page) => {
                    if (closed || entry.controller.signal.aborted) return;
                    publishSession(entry, entry.store.prependEarlier(page, started.anchor));
                })
                .catch((error: unknown) => {
                    if (closed || entry.controller.signal.aborted) return;
                    publishSession(
                        entry,
                        entry.store.failLoadingMore(started.anchor, describeLoadFailure(error)),
                    );
                });
        };

        return {
            elements: () => entry.store.elements(),
            loadMore,
            session: () => entry.store.session(),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const connectGroups = (subscription: RigGroupsSubscriptionOptions): RigGroupsConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createGroupEntry();
        const subscriber: GroupSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.projects(), entry.store.state());
        startGroupEntry(entry);
        return {
            projects: () => entry.store.projects(),
            remoteTerminals: () => entry.store.remoteTerminals(),
            state: () => entry.store.state(),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const connectInbox = (subscription: RigInboxSubscriptionOptions): RigInboxConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        inboxEntry ??= { store: new InboxStore(), subscribers: new Set() };
        const subscriber: InboxSubscriber = { ...subscription, closed: false };
        inboxEntry.subscribers.add(subscriber);
        subscriber.onChange(inboxEntry.store.items(), inboxEntry.store.state());
        startGroupEntry(createGroupEntry());
        return {
            items: () => inboxEntry?.store.items() ?? [],
            state: () => inboxEntry?.store.state() ?? { connection: "closed" },
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                inboxEntry?.subscribers.delete(subscriber);
                if (inboxEntry?.subscribers.size === 0) inboxEntry = undefined;
                releaseUnusedEntries();
            },
        };
    };

    const publishProviderUsage = (deltas: readonly ProviderUsageDelta[]): void => {
        if (closed || providerUsageEntry === undefined || deltas.length === 0) return;
        const entry = providerUsageEntry;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.providers(), entry.store.state());
            if (subscriber.onDelta === undefined) continue;
            for (const delta of deltas) subscriber.onDelta(delta);
        }
    };

    const readProviderUsage = async (): Promise<void> => {
        const entry = providerUsageEntry;
        // One read at a time: a manual refresh landing on top of the interval
        // must not produce two answers racing into the same store.
        if (entry === undefined || entry.inFlight || closed) return;
        entry.inFlight = true;
        try {
            const { data } = await requestJson("/provider-usage", {
                signal: entry.controller.signal,
            });
            if (providerUsageEntry !== entry) return;
            const providers = (data as ListProviderUsageResponse | null)?.providers ?? [];
            publishProviderUsage(entry.store.applyProviders(providers, now()));
        } catch (error) {
            if (providerUsageEntry !== entry || entry.controller.signal.aborted) return;
            publishProviderUsage(entry.store.applyError(humanProviderUsageError(error)));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        } finally {
            entry.inFlight = false;
        }
    };

    const scheduleProviderUsage = (entry: ProviderUsageEntryState): void => {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            if (providerUsageEntry !== entry) return;
            void readProviderUsage().finally(() => {
                // Chained from the end of a read rather than run on a fixed
                // interval, so a slow daemon cannot queue reads behind itself.
                if (providerUsageEntry === entry) scheduleProviderUsage(entry);
            });
        }, entry.refreshIntervalMs);
    };

    const connectProviderUsage = (
        subscription: RigProviderUsageSubscriptionOptions,
    ): RigProviderUsageConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const first = providerUsageEntry === undefined;
        providerUsageEntry ??= {
            controller: new AbortController(),
            inFlight: false,
            refreshIntervalMs: subscription.refreshIntervalMs ?? DEFAULT_PROVIDER_USAGE_REFRESH_MS,
            store: new ProviderUsageStore(),
            subscribers: new Set(),
            timer: undefined,
        };
        const entry = providerUsageEntry;
        const subscriber: ProviderUsageSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        // The state is handed over before anything is read, so a view renders
        // its loading state from the same value it will later render usage from.
        subscriber.onChange(entry.store.providers(), entry.store.state());
        if (first) {
            void readProviderUsage().finally(() => {
                if (providerUsageEntry === entry) scheduleProviderUsage(entry);
            });
        }
        return {
            providers: () => entry.store.providers(),
            state: () => entry.store.state(),
            refresh: async () => {
                if (providerUsageEntry !== entry) return;
                await readProviderUsage();
                if (providerUsageEntry === entry) scheduleProviderUsage(entry);
            },
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                // The last view leaving stops the polling and forgets the
                // readings, so a mounted view never shows a stale first frame.
                if (entry.subscribers.size === 0) {
                    if (entry.timer !== undefined) clearTimeout(entry.timer);
                    entry.controller.abort();
                    if (providerUsageEntry === entry) providerUsageEntry = undefined;
                }
            },
        };
    };

    const connectMurmurFriends = (
        subscription: RigMurmurFriendsSubscriptionOptions,
    ): RigMurmurFriendsConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createMurmurFriendsEntry();
        const subscriber: MurmurFriendsSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.state());
        startMurmurFriendsEntry(entry);
        return {
            account: () => entry.store.state().account,
            contacts: () => entry.store.state().contacts,
            friendships: () => entry.store.state().friendships,
            state: () => entry.store.state(),
            stats: () => entry.store.state().stats,
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                if (entry.subscribers.size !== 0 || murmurFriendsEntry !== entry) return;
                entry.controller.abort();
                entry.detachRoot();
                murmurFriendsEntry = undefined;
            },
        };
    };

    const connectPlugins = (subscription: RigPluginsSubscriptionOptions): RigPluginsConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createPluginsEntry();
        const subscriber: PluginsSubscriber = { ...subscription, closed: false };
        const calls = linkedController(entry.controller.signal);
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.apps(), entry.store.plugins(), entry.store.state());
        startPluginsEntry(entry);

        const postApp = async <TSchema_ extends ReturnType<typeof Type.Object>>(
            app: Pick<PluginApp, "generation" | "id">,
            operation: string,
            bodyValue: unknown,
            schema: TSchema_,
            signal?: AbortSignal,
        ) => {
            let body: string;
            try {
                body = JSON.stringify(bodyValue);
            } catch {
                throw new Error("MCP App input must be JSON serializable.");
            }
            if (new TextEncoder().encode(body).byteLength > MAXIMUM_PLUGIN_APP_REQUEST_BYTES) {
                throw new Error("MCP App input exceeds the host limit.");
            }
            const requestSignal = combinedSignal(calls.controller.signal, signal);
            try {
                const response = await request(
                    endpointUrl(
                        options.endpoint,
                        `plugin-apps/${encodeURIComponent(app.id)}/generations/${encodeURIComponent(app.generation)}/${operation}`,
                    ),
                    {
                        body,
                        headers: {
                            accept: "application/json",
                            authorization: `Bearer ${options.token}`,
                            "content-type": "application/json",
                        },
                        method: "POST",
                        signal: requestSignal.signal,
                    },
                );
                const bytes = await readBoundedResponseBytes(
                    response,
                    MAXIMUM_PLUGIN_APP_RESPONSE_BYTES,
                );
                if (!response.ok) throw responseError(response.status, bytes);
                return Value.Decode(schema, JSON.parse(new TextDecoder().decode(bytes)) as unknown);
            } finally {
                requestSignal.detach();
            }
        };

        const readResource: RigPluginsConnection["readResource"] = async (
            app,
            uri,
            readOptions = {},
        ) => {
            if (subscriber.closed) throw new Error("This plugin connection is closed.");
            const expected = app.resources.find((resource) => resource.uri === uri);
            if (expected === undefined) {
                throw new Error("That resource is not declared by this MCP App.");
            }
            return postApp(
                app,
                "resources/read",
                { uri },
                pluginAppResourceResponseSchema,
                readOptions.signal,
            );
        };

        const callTool: RigPluginsConnection["callTool"] = async (
            app,
            server,
            name,
            argumentsValue,
            invokeOptions = {},
        ) => {
            if (subscriber.closed) throw new Error("This plugin connection is closed.");
            if (!app.tools.some((tool) => tool.server === server && tool.name === name)) {
                throw new Error("That tool is not declared for this MCP App.");
            }
            return (
                await postApp(
                    app,
                    "tools/call",
                    { arguments: argumentsValue, name, server },
                    pluginAppToolResponseSchema,
                    invokeOptions.signal,
                )
            ).result;
        };

        const readIcon: RigPluginsConnection["readIcon"] = async (plugin, readOptions = {}) => {
            if (subscriber.closed) throw new Error("This plugin connection is closed.");
            const requestSignal = combinedSignal(calls.controller.signal, readOptions.signal);
            try {
                const response = await request(
                    endpointUrl(
                        options.endpoint,
                        `plugins/${encodeURIComponent(plugin.id)}/generations/${encodeURIComponent(plugin.icon.generation)}/icon`,
                    ),
                    {
                        headers: {
                            accept: plugin.icon.mediaType,
                            authorization: `Bearer ${options.token}`,
                        },
                        signal: requestSignal.signal,
                    },
                );
                const bytes = await readBoundedResponseBytes(response, MAXIMUM_PLUGIN_ICON_BYTES);
                if (!response.ok) throw pluginIconResponseError(response.status, bytes);
                const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
                if (mediaType !== plugin.icon.mediaType || bytes.byteLength !== plugin.icon.size) {
                    throw new Error("Rig returned an invalid plugin icon response.");
                }
                return { bytes, mediaType: plugin.icon.mediaType };
            } finally {
                requestSignal.detach();
            }
        };

        return {
            apps: () => entry.store.apps(),
            callTool,
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                calls.controller.abort();
                calls.detach();
                if (entry.subscribers.size === 0 && pluginsEntry === entry) {
                    entry.controller.abort();
                    entry.detachRoot();
                    pluginsEntry = undefined;
                }
            },
            plugins: () => entry.store.plugins(),
            readIcon,
            readResource,
            state: () => entry.store.state(),
            storageDelete: async (app, key) => {
                if (subscriber.closed) throw new Error("This plugin connection is closed.");
                await postApp(
                    app,
                    "extensions/io.slopus.happy/storage/delete",
                    { key },
                    emptyResponseSchema,
                );
            },
            storageGet: async (app, key) => {
                if (subscriber.closed) throw new Error("This plugin connection is closed.");
                return (
                    await postApp(
                        app,
                        "extensions/io.slopus.happy/storage/get",
                        { key },
                        pluginAppStorageGetResponseSchema,
                    )
                ).value;
            },
            storageList: async (app) => {
                if (subscriber.closed) throw new Error("This plugin connection is closed.");
                return (
                    await postApp(
                        app,
                        "extensions/io.slopus.happy/storage/list",
                        {},
                        pluginAppStorageListResponseSchema,
                    )
                ).keys;
            },
            storageSet: async (app, key, value) => {
                if (subscriber.closed) throw new Error("This plugin connection is closed.");
                await postApp(
                    app,
                    "extensions/io.slopus.happy/storage/set",
                    { key, value },
                    emptyResponseSchema,
                );
            },
        };
    };

    const connectTimeline = (
        subscription: RigTimelineSubscriptionOptions,
    ): RigTimelineConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createTimelineEntry(subscription);
        const subscriber: TimelineSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.agents(), entry.store.state());
        startTimelineEntry(entry);
        return {
            agents: () => entry.store.agents(),
            state: () => entry.store.state(),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const requestJson = async (
        path: string,
        init: RequestInit = {},
    ): Promise<{ data: unknown; status: number }> => {
        if (closed) throw new Error("This Rig connection is closed.");
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        headers.set("authorization", `Bearer ${options.token}`);
        const response = await request(endpointUrl(options.endpoint, path), {
            ...init,
            headers,
        });
        const data = await readResponseBody(response);
        if (!response.ok && response.status !== 404) {
            throw new MutationHttpError(
                response.status,
                humanMutationError(data, response.status),
                retryAfterMilliseconds(response.headers.get("retry-after"), now()),
                data,
            );
        }
        return { data, status: response.status };
    };

    const requestP2pPairing = async <Schema extends TSchema>(
        path: string,
        schema: Schema,
        init: RequestInit = {},
    ): Promise<Static<Schema>> => {
        const response = await requestJson(path, init);
        try {
            return Value.Decode(schema, response.data);
        } catch {
            throw new Error("Rig returned an invalid P2P pairing response.");
        }
    };

    const createP2pInvitation: RigConnection["createP2pInvitation"] = () =>
        requestP2pPairing("p2p/invitations", createP2pInvitationResponseSchema, {
            method: "POST",
        });
    const joinP2pInvitation: RigConnection["joinP2pInvitation"] = (invitation) =>
        requestP2pPairing("p2p/joins", joinP2pInvitationResponseSchema, {
            body: JSON.stringify({ invitation }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
    const getP2pPairing: RigConnection["getP2pPairing"] = (id) =>
        requestP2pPairing(`p2p/pairings/${encodeURIComponent(id)}`, p2pPairingStateSchema);
    const answerP2pVerification: RigConnection["answerP2pVerification"] = (id, accept) =>
        requestP2pPairing(`p2p/pairings/${encodeURIComponent(id)}/answer`, p2pPairingStateSchema, {
            body: JSON.stringify({ accept }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

    const requestSessionShare = async <T extends TSchema>(
        path: string,
        schema: T,
        init: RequestInit = {},
    ): Promise<Static<T>> => {
        const response = await requestJson(path, init);
        try {
            return Value.Decode(schema, response.data);
        } catch {
            throw new Error("Rig returned an invalid session-sharing response.");
        }
    };

    const enqueueSessionShareMutation = (
        action: Extract<
            MutationAction,
            | "add_session_share_member"
            | "create_session_share"
            | "revoke_session_share_member"
            | "set_session_share_friend_messages"
            | "set_session_share_member_capabilities"
            | "set_session_share_tool_output"
            | "stop_session_share"
        >,
        sessionId: string,
        path: string,
        body: Readonly<Record<string, unknown>>,
        project?: (shared: SessionSharedMetadata) => SessionSharedMetadata,
        method: "POST" | "PUT" = "POST",
    ): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        let expectedEventId: string | undefined;
        return enqueue({
            acknowledged: false,
            action,
            applyOptimistic: (publish) => {
                if (project === undefined) return () => undefined;
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                const chatShared = entry?.store.session().shared;
                if (entry !== undefined && chatShared !== undefined) {
                    const changed = entry.store.applyOptimisticSession({
                        shared: project(chatShared),
                    });
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                const catalogShared = groupsEntry?.store.sessionSummary(sessionId)?.shared;
                if (groupsEntry !== undefined && catalogShared !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        shared: project(catalogShared),
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            entityKey: key,
            id,
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    body: { ...body, mutationId: id },
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method,
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/share${path}`,
                    ),
                };
            },
            retryOnConflict: true,
            sessionId,
            undo: () => undefined,
            versionSessionId: sessionId,
        });
    };

    const createSessionShare: RigConnection["createSessionShare"] = (sessionId, input) =>
        enqueueSessionShareMutation("create_session_share", sessionId, "", input);

    const addSessionShareMember: RigConnection["addSessionShareMember"] = (sessionId, friend) =>
        enqueueSessionShareMutation(
            "add_session_share_member",
            sessionId,
            "/members",
            { friend } satisfies Omit<AddSessionShareMemberRequest, "mutationId">,
            (shared) => ({ ...shared, memberCount: shared.memberCount + 1 }),
        );

    const revokeSessionShareMember: RigConnection["revokeSessionShareMember"] = (
        sessionId,
        shareMemberId,
    ) =>
        enqueueSessionShareMutation(
            "revoke_session_share_member",
            sessionId,
            `/members/${encodeURIComponent(shareMemberId)}/revoke`,
            {},
            (shared) => ({ ...shared, memberCount: Math.max(0, shared.memberCount - 1) }),
        );

    const stopSessionShare: RigConnection["stopSessionShare"] = (sessionId) =>
        enqueueSessionShareMutation("stop_session_share", sessionId, "/stop", {}, (shared) => ({
            ...shared,
            state: "stopped",
        }));

    const setSessionShareFriendMessages: RigConnection["setSessionShareFriendMessages"] = (
        sessionId,
        includeFriendMessagesInModel,
    ) =>
        enqueueSessionShareMutation(
            "set_session_share_friend_messages",
            sessionId,
            "/friend-messages",
            { includeFriendMessagesInModel },
            (shared) => ({ ...shared, includeFriendMessagesInModel }),
        );

    const setSessionShareToolOutput: RigConnection["setSessionShareToolOutput"] = (
        sessionId,
        toolOutput,
    ) =>
        enqueueSessionShareMutation(
            "set_session_share_tool_output",
            sessionId,
            "/tool-output",
            { toolOutput },
            (shared) => ({
                ...shared,
                toolOutput,
                toolOutputDescription: describeSessionShareToolOutput(toolOutput),
            }),
        );

    const setSessionShareMemberCapabilities: RigConnection["setSessionShareMemberCapabilities"] = (
        sessionId,
        shareMemberId,
        capabilities,
    ) =>
        enqueueSessionShareMutation(
            "set_session_share_member_capabilities",
            sessionId,
            `/members/${encodeURIComponent(shareMemberId)}/capabilities`,
            { capabilities },
            // capabilityMemberCount depends on this member's capabilities before
            // the change, which this client does not track, so it waits for the
            // authoritative response instead of predicting a count it cannot know.
            undefined,
            "PUT",
        );

    const postSessionShareFriendMessage: RigConnection["postSessionShareFriendMessage"] = (
        post,
        operationOptions = {},
    ) =>
        requestSessionShare(
            "session-shares/friend-messages",
            postSessionShareFriendMessageResponseSchema,
            {
                body: JSON.stringify(post),
                headers: { "content-type": "application/json" },
                method: "POST",
                ...(operationOptions.signal === undefined
                    ? {}
                    : { signal: operationOptions.signal }),
            },
        );

    const listSessionShareReplicas: RigConnection["listSessionShareReplicas"] = (
        operationOptions = {},
    ) =>
        requestSessionShare("session-share-replicas", listSessionShareReplicasResponseSchema, {
            ...(operationOptions.signal === undefined ? {} : { signal: operationOptions.signal }),
        });

    const getSessionShareReplicaHistory: RigConnection["getSessionShareReplicaHistory"] = (
        shareId,
        operationOptions = {},
    ) => {
        const after =
            operationOptions.after === undefined
                ? ""
                : `?after=${encodeURIComponent(operationOptions.after)}`;
        return requestSessionShare(
            `session-share-replicas/${encodeURIComponent(shareId)}/history${after}`,
            getSessionShareReplicaHistoryResponseSchema,
            {
                ...(operationOptions.signal === undefined
                    ? {}
                    : { signal: operationOptions.signal }),
            },
        );
    };

    const getSessionShareHealth: RigConnection["getSessionShareHealth"] = (
        shareId,
        operationOptions = {},
    ) =>
        requestSessionShare(
            `session-shares/${encodeURIComponent(shareId)}/health`,
            getSessionShareHealthResponseSchema,
            {
                ...(operationOptions.signal === undefined
                    ? {}
                    : { signal: operationOptions.signal }),
            },
        );

    const getSessionSharePeerActivity: RigConnection["getSessionSharePeerActivity"] = (
        sessionId,
        operationOptions = {},
    ) => {
        const after =
            operationOptions.after === undefined
                ? ""
                : `?after=${encodeURIComponent(operationOptions.after)}`;
        return requestSessionShare(
            `sessions/${encodeURIComponent(sessionId)}/share/peer-activity${after}`,
            getSessionSharePeerActivityResponseSchema,
            {
                ...(operationOptions.signal === undefined
                    ? {}
                    : { signal: operationOptions.signal }),
            },
        );
    };

    const listSessionShareReplicaCapabilities: RigConnection["listSessionShareReplicaCapabilities"] =
        (shareId, operationOptions = {}) =>
            requestSessionShare(
                `session-share-replicas/${encodeURIComponent(shareId)}/capabilities`,
                listSessionShareReplicaCapabilitiesResponseSchema,
                {
                    ...(operationOptions.signal === undefined
                        ? {}
                        : { signal: operationOptions.signal }),
                },
            );

    const projects: RigProjects = {
        add: async (path, addOptions = {}) => {
            const projectId = addOptions.projectId ?? nextEntityId();
            const operation = combinedSignal(rootController.signal, addOptions.signal);
            let retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
            let attempts = 0;
            try {
                for (;;) {
                    operation.signal.throwIfAborted();
                    attempts += 1;
                    try {
                        const response = await requestJson("projects", {
                            body: JSON.stringify({ path, projectId }),
                            headers: { "content-type": "application/json" },
                            method: "POST",
                            signal: operation.signal,
                        });
                        if (response.status >= 400) {
                            throw (
                                projectRegistrationResponseError(response.status, response.data) ??
                                new MutationHttpError(
                                    response.status,
                                    `Rig rejected project registration with status ${String(response.status)}.`,
                                    undefined,
                                    response.data,
                                )
                            );
                        }
                        try {
                            return Value.Decode(projectResponseSchema, response.data).project;
                        } catch {
                            throw new ProjectRegistrationProtocolError(
                                "invalid_response",
                                response.status,
                                "Rig returned an invalid project registration response.",
                            );
                        }
                    } catch (error) {
                        if (
                            error instanceof ProjectRegistrationError ||
                            error instanceof ProjectRegistrationProtocolError
                        ) {
                            throw error;
                        }
                        if (error instanceof MutationHttpError) {
                            const registrationError = projectRegistrationResponseError(
                                error.status,
                                error.data,
                            );
                            if (registrationError !== undefined) throw registrationError;
                        }
                        if (!isRetryableMutationError(error)) {
                            if (error instanceof DOMException && error.name === "AbortError") {
                                throw error;
                            }
                            throw projectRegistrationRequestFailure(error);
                        }
                        if (attempts >= PROJECT_REGISTRATION_MAX_ATTEMPTS) {
                            throw projectRegistrationRequestFailure(error);
                        }
                        await wait(
                            error instanceof MutationHttpError
                                ? (error.retryAfterMs ?? retryDelay)
                                : retryDelay,
                            operation.signal,
                        );
                        operation.signal.throwIfAborted();
                        retryDelay = Math.min(MAXIMUM_MUTATION_RETRY_MS, retryDelay * 2);
                    }
                }
            } finally {
                operation.detach();
            }
        },
    };

    const requestMurmur = async <Schema extends TSchema>(
        path: string,
        schema: Schema,
        init: RequestInit = {},
    ): Promise<Static<Schema>> => {
        const { data, status } = await requestJson(path, init);
        if (status >= 400) {
            throw new MutationHttpError(status, humanMutationError(data, status), undefined, data);
        }
        try {
            return Value.Decode(schema, data);
        } catch {
            throw new Error("Rig returned an invalid Murmur response.");
        }
    };

    const murmurJsonInit = (
        method: "DELETE" | "GET" | "POST",
        body: object | undefined,
        operationOptions: MurmurOperationOptions,
    ): RequestInit => ({
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
        method,
        ...(operationOptions.signal === undefined ? {} : { signal: operationOptions.signal }),
    });

    const getMurmurAccount: RigConnection["getMurmurAccount"] = (operationOptions = {}) =>
        requestMurmur(
            "murmur/account",
            getMurmurAccountResponseSchema,
            murmurJsonInit("GET", undefined, operationOptions),
        );

    const signupMurmurAccount: RigConnection["signupMurmurAccount"] = (
        signup,
        operationOptions = {},
    ) =>
        requestMurmur(
            "murmur/account",
            signupMurmurAccountResponseSchema,
            murmurJsonInit("POST", signup, operationOptions),
        );

    const startMurmurService: RigConnection["startMurmurService"] = (
        start = {},
        operationOptions = {},
    ) =>
        requestMurmur(
            "murmur/service/start",
            startMurmurServiceResponseSchema,
            murmurJsonInit("POST", start, operationOptions),
        );

    const stopMurmurService: RigConnection["stopMurmurService"] = (operationOptions = {}) =>
        requestMurmur(
            "murmur/service/stop",
            stopMurmurServiceResponseSchema,
            murmurJsonInit("POST", undefined, operationOptions),
        );

    const deleteMurmurAccount: RigConnection["deleteMurmurAccount"] = (operationOptions = {}) =>
        requestMurmur(
            "murmur/account",
            deleteMurmurAccountResponseSchema,
            murmurJsonInit("DELETE", undefined, operationOptions),
        );

    const sendMurmurFriendRequest: RigConnection["sendMurmurFriendRequest"] = (
        token,
        operationOptions = {},
    ) =>
        requestMurmur(
            "murmur/friend-requests",
            sendMurmurFriendRequestResponseSchema,
            murmurJsonInit("POST", { token }, operationOptions),
        );

    const listMurmurFriendRequests: RigConnection["listMurmurFriendRequests"] = (
        operationOptions = {},
    ) =>
        requestMurmur(
            "murmur/friend-requests",
            listMurmurFriendRequestsResponseSchema,
            murmurJsonInit("GET", undefined, operationOptions),
        );

    const answerMurmurFriendRequest: RigConnection["answerMurmurFriendRequest"] = (
        peerId,
        answer,
        operationOptions = {},
    ) =>
        requestMurmur(
            `murmur/friend-requests/${encodeURIComponent(peerId)}/answer`,
            answerMurmurFriendRequestResponseSchema,
            murmurJsonInit("POST", { answer }, operationOptions),
        );

    const listMurmurContacts: RigConnection["listMurmurContacts"] = (operationOptions = {}) =>
        requestMurmur(
            "murmur/contacts",
            listMurmurContactsResponseSchema,
            murmurJsonInit("GET", undefined, operationOptions),
        );

    const listMurmurFriends: RigConnection["listMurmurFriends"] = (operationOptions = {}) =>
        requestMurmur(
            "murmur/friends",
            getMurmurFriendsResponseSchema,
            murmurJsonInit("GET", undefined, operationOptions),
        );

    const happyCloudGetInit = (operationOptions: HappyCloudOperationOptions): RequestInit => ({
        method: "GET",
        ...(operationOptions.signal === undefined ? {} : { signal: operationOptions.signal }),
    });

    const requestHappyCloud = async <Schema extends TSchema>(
        path: string,
        schema: Schema,
        init: RequestInit,
        optional = false,
    ): Promise<Static<Schema> | undefined> => {
        const { data, status } = await requestJson(path, init);
        if (optional && status === 404) return undefined;
        if (status >= 400) {
            throw new MutationHttpError(status, humanMutationError(data, status), undefined, data);
        }
        try {
            return Value.Decode(schema, data);
        } catch {
            throw new Error("Rig returned an invalid Happy Cloud response.");
        }
    };

    const createP2pEntry = (): P2pEntry => {
        if (p2pEntry !== undefined) return p2pEntry;
        const linked = linkedController(rootController.signal);
        p2pEntry = {
            controller: linked.controller,
            detachRoot: linked.detach,
            eventRevision: 0,
            recoveryScheduled: false,
            reloadPending: false,
            started: false,
            subscribers: new Set(),
        };
        return p2pEntry;
    };

    const loadP2p = (entry: P2pEntry): Promise<void> => {
        if (entry.loading !== undefined) {
            entry.reloadPending = true;
            return entry.loading;
        }
        const eventRevision = entry.eventRevision;
        let shouldRecover = false;
        const loading = (async () => {
            const response = await request(endpointUrl(options.endpoint, "p2p/status"), {
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                },
                signal: entry.controller.signal,
            });
            if (!response.ok) {
                throw new Error(`Rig could not read P2P status (${String(response.status)}).`);
            }
            const status = Value.Decode(p2pStatusSchema, await response.json());
            if (entry.controller.signal.aborted || p2pEntry !== entry) return;
            const statusChanged =
                entry.eventRevision === eventRevision && !sameP2pStatus(entry.status, status);
            if (statusChanged) entry.status = status;
            delete entry.lastLoadError;
            if (statusChanged) publishP2p();
        })();
        entry.loading = loading;
        void loading
            .catch((error: unknown) => {
                if (entry.controller.signal.aborted || p2pEntry !== entry) return;
                if (entry.eventRevision !== eventRevision) return;
                const changedError =
                    entry.lastLoadError instanceof Error && error instanceof Error
                        ? entry.lastLoadError.message !== error.message
                        : entry.lastLoadError !== error;
                entry.lastLoadError = error;
                if (changedError) {
                    for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                }
                shouldRecover = true;
            })
            .finally(() => {
                if (entry.loading === loading) delete entry.loading;
                if (entry.controller.signal.aborted || p2pEntry !== entry) return;
                if (entry.reloadPending) {
                    entry.reloadPending = false;
                    void loadP2p(entry);
                } else if (shouldRecover) {
                    scheduleP2pRecovery(entry);
                }
            });
        return loading;
    };

    const scheduleP2pRecovery = (entry: P2pEntry): void => {
        if (entry.recoveryScheduled || entry.controller.signal.aborted) return;
        entry.recoveryScheduled = true;
        void wait(MAXIMUM_MUTATION_RETRY_MS, entry.controller.signal).then(() => {
            entry.recoveryScheduled = false;
            if (
                entry.controller.signal.aborted ||
                p2pEntry !== entry ||
                entry.subscribers.size === 0
            ) {
                return;
            }
            void loadP2p(entry);
        });
    };

    const connectP2p: RigConnection["connectP2p"] = (subscription) => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createP2pEntry();
        const subscriber: P2pSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        if (entry.status !== undefined) subscriber.onChange(entry.status);
        if (entry.lastLoadError !== undefined) subscriber.onError?.(entry.lastLoadError);
        entry.started = true;
        ensureLiveStream();
        void loadP2p(entry);
        return {
            status: () => (subscriber.closed ? undefined : entry.status),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const getHappyCloudStatus: RigConnection["getHappyCloudStatus"] = (operationOptions = {}) =>
        requestHappyCloud(
            "happy-cloud/status",
            happyCloudStatusSchema,
            happyCloudGetInit(operationOptions),
        ) as Promise<HappyCloudStatus>;

    const createHappyCloudEntry = (): HappyCloudEntry => {
        if (happyCloudEntry !== undefined) return happyCloudEntry;
        const linked = linkedController(rootController.signal);
        happyCloudEntry = {
            acknowledgements: new Map(),
            authoritativeVersion: 0,
            bootstrapVersion: 0,
            controller: linked.controller,
            detachRoot: linked.detach,
            loadErrorReported: false,
            loaded: false,
            ready: Promise.resolve(),
            recoveryScheduled: false,
            requiredVersion: 0,
            started: false,
            status: initialHappyCloudStatus(),
            subscribers: new Set(),
        };
        return happyCloudEntry;
    };

    const reconcileHappyCloud = (
        entry: HappyCloudEntry,
        status: HappyCloudStatus,
        mutationId: string | undefined,
        allowVersionReset = false,
    ): boolean => {
        if (happyCloudEntry !== entry) return false;
        const minimumVersion = Math.max(entry.authoritativeVersion, entry.requiredVersion);
        if (status.version < minimumVersion && !allowVersionReset) return false;
        if (allowVersionReset && status.version < minimumVersion) {
            for (const acknowledgedMutationId of entry.acknowledgements.keys()) {
                acknowledge(acknowledgedMutationId);
            }
            entry.acknowledgements.clear();
            entry.requiredVersion = status.version;
        }
        const relevant = pendingOverlays.filter((mutation) => mutation.entityKey === "happy-cloud");
        for (const mutation of [...relevant].reverse()) mutation.undo();
        entry.status = status;
        entry.authoritativeVersion = status.version;
        entry.loadErrorReported = false;
        delete entry.lastLoadError;
        entry.loaded = true;
        acknowledge(mutationId);
        for (const [echoedMutationId, version] of entry.acknowledgements) {
            if (version > status.version) continue;
            acknowledge(echoedMutationId);
            entry.acknowledgements.delete(echoedMutationId);
        }
        for (const mutation of pendingOverlays) {
            if (mutation.entityKey === "happy-cloud") {
                mutation.undo = mutation.applyOptimistic(false);
            }
        }
        publishHappyCloud();
        return true;
    };

    const loadHappyCloudEntry = async (
        entry: HappyCloudEntry,
        bootstrapVersion: number,
        allowVersionReset: boolean,
    ): Promise<void> => {
        let retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
        let staleSnapshots = 0;
        for (;;) {
            let status: HappyCloudStatus;
            try {
                status = await getHappyCloudStatus({ signal: entry.controller.signal });
            } catch (error) {
                if (
                    entry.controller.signal.aborted ||
                    entry.bootstrapVersion !== bootstrapVersion
                ) {
                    return;
                }
                if (!isRetryableMutationError(error)) {
                    throw error;
                }
                await wait(retryDelay, entry.controller.signal);
                retryDelay = Math.min(MAXIMUM_MUTATION_RETRY_MS, retryDelay * 2);
                continue;
            }
            if (
                happyCloudEntry !== entry ||
                entry.controller.signal.aborted ||
                entry.bootstrapVersion !== bootstrapVersion
            ) {
                return;
            }
            if (reconcileHappyCloud(entry, status, undefined, allowVersionReset)) {
                return;
            }
            staleSnapshots += 1;
            if (staleSnapshots === 8) {
                throw new Error("Happy Cloud status did not reach the version announced by Rig.");
            }
            await wait(retryDelay, entry.controller.signal);
            retryDelay = Math.min(MAXIMUM_MUTATION_RETRY_MS, retryDelay * 2);
        }
    };

    const requestHappyCloudReload = (
        entry: HappyCloudEntry,
        allowVersionReset = false,
    ): Promise<void> => {
        if (entry.loading !== undefined && !allowVersionReset) return entry.loading;
        const bootstrapVersion = ++entry.bootstrapVersion;
        const loading = loadHappyCloudEntry(entry, bootstrapVersion, allowVersionReset);
        let shouldRecover = false;
        entry.loading = loading;
        entry.ready = loading;
        void loading
            .catch((error: unknown) => {
                if (entry.controller.signal.aborted || happyCloudEntry !== entry) return;
                const changedError =
                    entry.lastLoadError instanceof Error && error instanceof Error
                        ? entry.lastLoadError.message !== error.message
                        : entry.lastLoadError !== error;
                entry.lastLoadError = error;
                if (!entry.loadErrorReported || changedError) {
                    entry.loadErrorReported = true;
                    for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                }
                shouldRecover = true;
            })
            .finally(() => {
                if (entry.loading === loading) delete entry.loading;
                if (shouldRecover) scheduleHappyCloudRecovery(entry);
                releaseUnusedEntries();
            });
        return loading;
    };

    const scheduleHappyCloudRecovery = (entry: HappyCloudEntry): void => {
        if (entry.recoveryScheduled || entry.controller.signal.aborted) return;
        entry.recoveryScheduled = true;
        void wait(MAXIMUM_MUTATION_RETRY_MS, entry.controller.signal).then(
            () => {
                entry.recoveryScheduled = false;
                if (
                    entry.controller.signal.aborted ||
                    happyCloudEntry !== entry ||
                    entry.loading !== undefined
                ) {
                    return;
                }
                void requestHappyCloudReload(entry);
            },
            () => {
                entry.recoveryScheduled = false;
            },
        );
    };

    const startHappyCloudEntry = (entry: HappyCloudEntry): void => {
        if (!entry.started) entry.started = true;
        if (!entry.loaded && entry.loading === undefined) void requestHappyCloudReload(entry);
    };

    const connectHappyCloud: RigConnection["connectHappyCloud"] = (subscription) => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createHappyCloudEntry();
        const subscriber: HappyCloudSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        if (entry.loaded) subscriber.onChange(entry.status);
        if (entry.loadErrorReported) subscriber.onError?.(entry.lastLoadError);
        ensureLiveStream();
        startHappyCloudEntry(entry);
        return {
            status: () => (subscriber.closed || !entry.loaded ? undefined : entry.status),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const applyHappyCloudCommand: RigConnection["applyHappyCloudCommand"] = (input) => {
        const entry = createHappyCloudEntry();
        startHappyCloudEntry(entry);
        const mutationId = nextMutationId();
        const attemptedExpectedVersions = new Set<number>();
        let conflictRebases = 0;
        let deliveredCommand: HappyCloudCommand | undefined;
        let projectedExpectedVersion = entry.status.version;
        const projectedCommand = (): HappyCloudCommand =>
            ({
                ...input,
                contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
                expectedVersion: projectedExpectedVersion,
                mutationId,
            }) as HappyCloudCommand;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "apply_happy_cloud_command",
            applyAcceptedResponse: (data) => {
                const response = Value.Decode(happyCloudCommandResponseSchema, data);
                if (!reconcileHappyCloud(entry, response.status, mutationId)) {
                    entry.acknowledgements.set(mutationId, response.status.version);
                    entry.requiredVersion = Math.max(
                        entry.requiredVersion,
                        response.status.version,
                    );
                    void requestHappyCloudReload(entry);
                }
                return true;
            },
            applyAuthoritativeResponse: (data) => {
                try {
                    const response = Value.Decode(happyCloudCommandErrorResponseSchema, data);
                    if (response.status.version >= entry.requiredVersion) {
                        entry.status = response.status;
                        entry.authoritativeVersion = response.status.version;
                        entry.loaded = true;
                    }
                } catch {
                    // A malformed error response cannot become authoritative state.
                }
            },
            applyOptimistic: (publish) => {
                const before = entry.status;
                projectedExpectedVersion = before.version;
                entry.status = predictHappyCloudStatus(before, projectedCommand(), now());
                if (publish && entry.loaded) publishHappyCloud();
                return () => {
                    entry.status = before;
                };
            },
            entityKey: "happy-cloud",
            id: mutationId,
            prepare: () => {
                deliveredCommand ??= projectedCommand();
                attemptedExpectedVersions.add(deliveredCommand.expectedVersion);
                return {
                    body: deliveredCommand,
                    headers: { "x-rig-mutation-id": mutationId },
                    method: "POST",
                    url: endpointUrl(options.endpoint, "happy-cloud/commands"),
                };
            },
            ready: () => entry.ready,
            rebaseOnConflict: (data) => {
                try {
                    const response = Value.Decode(happyCloudCommandErrorResponseSchema, data);
                    if (response.code !== "version_conflict") return false;
                    if (
                        conflictRebases >= 8 ||
                        attemptedExpectedVersions.has(response.status.version)
                    ) {
                        return false;
                    }
                    conflictRebases += 1;
                    deliveredCommand = undefined;
                    if (!reconcileHappyCloud(entry, response.status, undefined)) {
                        entry.requiredVersion = Math.max(
                            entry.requiredVersion,
                            response.status.version,
                        );
                        void requestHappyCloudReload(entry);
                    }
                    return true;
                } catch {
                    return false;
                }
            },
            undo: () => undefined,
        };
        const id = enqueue(mutation);
        return id;
    };

    const getHappyCloudProfile: RigConnection["getHappyCloudProfile"] = (operationOptions = {}) =>
        requestHappyCloud(
            "happy-cloud/profile",
            happyCloudProfileCiphertextResponseSchema,
            happyCloudGetInit(operationOptions),
            true,
        );

    const getHappyCloudSessionBlob: RigConnection["getHappyCloudSessionBlob"] = (
        sessionId,
        operationOptions = {},
    ) =>
        requestHappyCloud(
            `happy-cloud/session-blobs/${encodeURIComponent(sessionId)}`,
            happyCloudSessionBlobResponseSchema,
            happyCloudGetInit(operationOptions),
            true,
        );

    const enqueueSessionUpdate = (
        action: MutationAction,
        sessionId: string,
        path: string,
        method: MutationRequest["method"],
        body: object,
        patch: Partial<SessionState>,
        clear: readonly (keyof SessionState)[] = [],
        replacesTranscript = false,
    ): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const mutation: PendingMutation = {
            acknowledged: false,
            action,
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const entry = sessionEntries.get(sessionId);
                if (entry === undefined) return () => undefined;
                const changed = entry.store.applyOptimisticSession(patch, clear);
                if (publish) publishSession(entry, changed.deltas);
                return changed.undo;
            },
            prepare: () => {
                const expectedEventId = currentSessionCursor(sessionId);
                return {
                    body: { ...body, mutationId: id },
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method,
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}${path.length === 0 ? "" : `/${path}`}`,
                    ),
                };
            },
            matchesAuthoritative: (data) => {
                const session = responseEntity(data, "session");
                return (
                    session !== undefined &&
                    Object.entries(patch).every(([name, value]) => session[name] === value) &&
                    clear.every((name) => session[name] === undefined)
                );
            },
            ...(replacesTranscript ? { replacesTranscript: true } : {}),
            retryOnConflict: true,
            versionSessionId: sessionId,
        };
        return enqueue(mutation);
    };

    const createSession = (input: CreateSessionInput): MutationId => {
        const id = nextEntityId();
        return enqueue({
            acknowledged: false,
            action: "create_session",
            applyOptimistic: () => () => undefined,
            entityKey: sessionKey(id),
            id,
            prepare: () => ({
                body: { ...input, id },
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(options.endpoint, "sessions"),
            }),
            sessionId: id,
            undo: () => undefined,
        });
    };

    const createWorkspace = (input: CreateWorkspaceInput): MutationId => {
        const id = nextEntityId();
        const key = workspaceKey(input.projectId, id);
        const createdAt = now();
        const optimistic: ProjectWorkspace = {
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            createdAt,
            // Daemon-owned and unknown until the authoritative answer replaces this row.
            gitCommonDir: "",
            id,
            kind: "git_worktree",
            name: input.name,
            orderKey: "",
            path: "",
            presence: "missing",
            projectId: input.projectId,
            status: "initializing",
            // Daemon-owned and unknown until the authoritative answer replaces this row.
            storageKey: "",
            updatedAt: createdAt,
            version: 0,
        };
        return enqueue({
            acknowledged: false,
            action: "create_workspace",
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const changed = groupsEntry.store.applyOptimisticWorkspaceCreate(optimistic);
                if (publish) publishGroups(groupsEntry, changed.deltas);
                return changed.undo;
            },
            entityKey: key,
            expectsWorkspaceResponse: true,
            id,
            matchesAuthoritative: (data) => responseEntity(data, "workspace")?.id === id,
            prepare: () => ({
                body: {
                    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                    id,
                    name: input.name,
                },
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `projects/${encodeURIComponent(input.projectId)}/workspaces`,
                ),
            }),
            undo: () => undefined,
        });
    };

    const archiveWorkspace = (projectId: string, workspaceId: string): MutationId => {
        const id = nextMutationId();
        const target: GroupTarget = { kind: "workspace", projectId, workspaceId };
        let expectedVersion: number | undefined;
        return enqueue({
            acknowledged: false,
            action: "archive_workspace",
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const changed = groupsEntry.store.applyOptimisticWorkspaceArchived(
                    projectId,
                    workspaceId,
                );
                if (publish) publishGroups(groupsEntry, changed.deltas);
                return changed.undo;
            },
            entityKey: groupKey(target),
            expectsWorkspaceResponse: true,
            id,
            matchesAuthoritative: (data) => {
                const workspace = responseEntity(data, "workspace");
                return (
                    workspace === undefined ||
                    workspace.status === "archiving" ||
                    workspace.status === "archived"
                );
            },
            prepare: () => {
                expectedVersion ??= groupVersion(target);
                return {
                    headers: {
                        ...ifMatchHeader(expectedVersion),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/archive`,
                    ),
                };
            },
            retryOnConflict: true,
            undo: () => undefined,
        });
    };

    const forkSession = (sourceSessionId: string): MutationId => {
        const id = nextMutationId();
        return enqueue({
            acknowledged: false,
            action: "fork_session",
            applyOptimistic: () => () => undefined,
            entityKey: sessionKey(sourceSessionId),
            id,
            prepare: () => {
                const expectedEventId = currentSessionCursor(sourceSessionId);
                return {
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sourceSessionId)}/fork`,
                    ),
                };
            },
            retryOnConflict: true,
            sessionId: id,
            undo: () => undefined,
            versionSessionId: sourceSessionId,
        });
    };

    const sendMessage = (sessionId: string, message: string | SendMessageInput): MutationId => {
        const input = typeof message === "string" ? { text: message } : message;
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const expectedRunId = sessionEntries.get(sessionId)?.store.session().activeTurn?.runId;
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "send_message",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const changed = entry.store.applyOptimisticMessage(id, input.text, now());
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        lastMessageAt: now(),
                        status: expectedRunId === undefined ? "queued" : "running",
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    body: {
                        clientSubmissionId: id,
                        ...(input.content === undefined ? {} : { content: input.content }),
                        ...(input.displayText === undefined
                            ? {}
                            : { displayText: input.displayText }),
                        ...(expectedRunId === undefined ? {} : { expectedRunId }),
                        mutationId: id,
                        text: input.text,
                    },
                    headers: ifMatchHeader(expectedEventId),
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/${expectedRunId === undefined ? "messages" : "steer"}`,
                    ),
                };
            },
        };
        return enqueue(mutation);
    };

    const sendContextMessage = (sessionId: string, text: string): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "send_context_message",
            entityKey: key,
            id,
            reconcileEchoInPlace: true,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const changed = entry.store.applyOptimisticContextMessage(id, text, now());
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        lastMessageAt: now(),
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    body: {
                        clientSubmissionId: id,
                        mutationId: id,
                        text,
                    },
                    headers: ifMatchHeader(expectedEventId),
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/context`,
                    ),
                };
            },
        };
        return enqueue(mutation);
    };

    const stopRun = (sessionId: string): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const expectedRunId = sessionEntries.get(sessionId)?.store.session().activeTurn?.runId;
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "stop_run",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const current = entry.store.session();
                    const changed = entry.store.applyOptimisticSession({
                        activity: {
                            kind: "stopped",
                            label: "Stopping",
                            ...(current.activeTurn === undefined
                                ? {}
                                : { runId: current.activeTurn.runId }),
                            since: now(),
                        },
                    });
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        status: "aborted",
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                const query =
                    expectedRunId === undefined
                        ? ""
                        : `?expectedRunId=${encodeURIComponent(expectedRunId)}`;
                return {
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/abort${query}`,
                    ),
                };
            },
        };
        return enqueue(mutation);
    };

    const switchModel = (sessionId: string, selection: string | ModelSelection): MutationId => {
        const selected = typeof selection === "string" ? { modelId: selection } : selection;
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "switch_model",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const changed = entry.store.applyOptimisticSession({
                        modelId: selected.modelId,
                        ...(selected.providerId === undefined
                            ? {}
                            : { providerId: selected.providerId }),
                    });
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        modelId: selected.modelId,
                        ...(selected.providerId === undefined
                            ? {}
                            : { providerId: selected.providerId }),
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    body: { ...selected, mutationId: id },
                    headers: ifMatchHeader(expectedEventId),
                    method: "PATCH",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/model`,
                    ),
                };
            },
            matchesAuthoritative: (data) => {
                const session = responseEntity(data, "session");
                return (
                    session?.modelId === selected.modelId &&
                    (selected.providerId === undefined ||
                        session.providerId === selected.providerId)
                );
            },
        };
        return enqueue(mutation);
    };

    const setEffort = (sessionId: string, effort?: string): MutationId =>
        enqueueSessionUpdate(
            "set_effort",
            sessionId,
            "effort",
            "PATCH",
            effort === undefined ? {} : { effort },
            effort === undefined ? {} : { effort },
            effort === undefined ? ["effort"] : [],
        );

    const setServiceTier = (sessionId: string, serviceTier?: string): MutationId =>
        enqueueSessionUpdate(
            "set_service_tier",
            sessionId,
            "service-tier",
            "PATCH",
            serviceTier === undefined ? {} : { serviceTier },
            serviceTier === undefined ? {} : { serviceTier },
            serviceTier === undefined ? ["serviceTier"] : [],
        );

    const setPermissionMode = (sessionId: string, permissionMode: string): MutationId =>
        enqueueSessionUpdate(
            "set_permission_mode",
            sessionId,
            "permissions",
            "PATCH",
            { permissionMode },
            { permissionMode },
        );

    const setDraft = (sessionId: string, input: string | DraftUpdate): MutationId => {
        const update: DraftUpdate =
            typeof input === "string" ? { draft: input.length === 0 ? null : input } : input;
        const updatedAt = update.updatedAt ?? now();
        return enqueueSessionUpdate(
            "set_draft",
            sessionId,
            "draft",
            "PUT",
            {
                draft: update.draft,
                ...(update.origin === undefined ? {} : { origin: update.origin }),
                updatedAt,
            },
            update.draft === null
                ? { draftUpdatedAt: updatedAt }
                : { draft: update.draft, draftUpdatedAt: updatedAt },
            update.draft === null ? ["draft"] : [],
        );
    };

    const setAppendSystemPrompt = (sessionId: string, prompt: string | null): MutationId =>
        enqueueSessionUpdate(
            "set_append_system_prompt",
            sessionId,
            "",
            "PATCH",
            { appendSystemPrompt: prompt },
            prompt === null ? {} : { appendSystemPrompt: prompt },
            prompt === null ? ["appendSystemPrompt"] : [],
        );

    const answerUserInput = (
        sessionId: string,
        requestId: string,
        response: UserInputAnswers,
    ): MutationId => {
        const current = sessionEntries.get(sessionId)?.store.session().pendingUserInputs ?? [];
        return enqueueSessionUpdate(
            "answer_user_input",
            sessionId,
            `user-input/${encodeURIComponent(requestId)}`,
            "POST",
            response,
            {
                pendingUserInputs: current.filter((request) => request.requestId !== requestId),
            },
        );
    };

    const setGoal = (sessionId: string, objective: string): MutationId => {
        const timestamp = now();
        return enqueueSessionUpdate(
            "set_goal",
            sessionId,
            "goal",
            "POST",
            { objective },
            {
                goal: {
                    createdAt: timestamp,
                    objective,
                    status: "active",
                    updatedAt: timestamp,
                },
            },
        );
    };

    const setGoalStatus = (sessionId: string, status: GoalStatus): MutationId => {
        const goal = sessionEntries.get(sessionId)?.store.session().goal;
        return enqueueSessionUpdate(
            "set_goal_status",
            sessionId,
            "goal",
            "PATCH",
            { status },
            goal === undefined ? {} : { goal: { ...goal, status, updatedAt: now() } },
        );
    };

    const clearGoal = (sessionId: string): MutationId =>
        enqueueSessionUpdate("clear_goal", sessionId, "goal", "DELETE", {}, {}, ["goal"]);

    const attachSecret = (
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope = "session",
    ): MutationId => {
        const session = sessionEntries.get(sessionId)?.store.session();
        const scoped =
            scope === "project"
                ? uniqueAppend(session?.projectSecretIds ?? [], secretId)
                : uniqueAppend(session?.sessionSecretIds ?? [], secretId);
        return enqueueSessionUpdate(
            "attach_secret",
            sessionId,
            "secrets",
            "POST",
            { scope, secretId },
            {
                ...(scope === "project"
                    ? { projectSecretIds: scoped }
                    : { sessionSecretIds: scoped }),
                secretIds: uniqueAppend(session?.secretIds ?? [], secretId),
            },
        );
    };

    const detachSecret = (
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope = "session",
    ): MutationId => {
        const session = sessionEntries.get(sessionId)?.store.session();
        const remainingProject =
            scope === "project"
                ? (session?.projectSecretIds ?? []).filter((id) => id !== secretId)
                : (session?.projectSecretIds ?? []);
        const remainingSession =
            scope === "session"
                ? (session?.sessionSecretIds ?? []).filter((id) => id !== secretId)
                : (session?.sessionSecretIds ?? []);
        return enqueueSessionUpdate(
            "detach_secret",
            sessionId,
            `secrets/${encodeURIComponent(secretId)}?scope=${scope}`,
            "DELETE",
            {},
            {
                projectSecretIds: remainingProject,
                secretIds: uniqueAppend(remainingProject, ...remainingSession),
                sessionSecretIds: remainingSession,
            },
        );
    };

    const compactSession = (sessionId: string): MutationId =>
        enqueueSessionUpdate(
            "compact_session",
            sessionId,
            "compact",
            "POST",
            {},
            {
                activity: {
                    kind: "compacting",
                    label: "Compacting",
                    since: now(),
                },
            },
            [],
            true,
        );

    const resetSession = (sessionId: string): MutationId =>
        enqueueSessionUpdate(
            "reset_session",
            sessionId,
            "reset",
            "POST",
            {},
            {
                activity: { kind: "stopped", label: "Resetting", since: now() },
            },
            [],
            true,
        );

    const rewindSession = (sessionId: string, messageId: string): MutationId =>
        enqueueSessionUpdate(
            "rewind_session",
            sessionId,
            "rewind",
            "POST",
            { messageId },
            {
                activity: { kind: "stopped", label: "Rewinding", since: now() },
            },
            [],
            true,
        );

    const runShellCommand = (sessionId: string, input: ShellCommandInput): MutationId => {
        const commands = sessionEntries.get(sessionId)?.store.session().shellCommands ?? [];
        return enqueueSessionUpdate("run_shell_command", sessionId, "shell", "POST", input, {
            shellCommands: [
                ...commands.filter((command) => command.commandId !== input.commandId),
                { ...input, status: "running" },
            ],
        });
    };

    const stopWorkflow = (sessionId: string, runId: string): MutationId => {
        const workflows = sessionEntries.get(sessionId)?.store.session().workflows ?? [];
        return enqueueSessionUpdate(
            "stop_workflow",
            sessionId,
            `workflows/${encodeURIComponent(runId)}/stop`,
            "POST",
            {},
            {
                workflows: workflows.map((workflow) =>
                    workflow.runId === runId
                        ? { ...workflow, finishedAt: now(), status: "stopped" }
                        : workflow,
                ),
            },
        );
    };

    const stopBackgroundProcesses = (sessionId: string): MutationId =>
        enqueueSessionUpdate(
            "stop_background_processes",
            sessionId,
            "background-processes/stop",
            "POST",
            {},
            { backgroundProcesses: [] },
        );

    const stopBackgroundProcess = (sessionId: string, processSessionId: number): MutationId => {
        const processes = sessionEntries.get(sessionId)?.store.session().backgroundProcesses ?? [];
        return enqueueSessionUpdate(
            "stop_background_process",
            sessionId,
            `background-processes/${encodeURIComponent(String(processSessionId))}`,
            "DELETE",
            {},
            {
                backgroundProcesses: processes.filter(
                    (process) => process.sessionId !== processSessionId,
                ),
            },
        );
    };

    const readBackgroundProcess = async (
        sessionId: string,
        processSessionId: number,
        readOptions: { signal?: AbortSignal; waitMs?: number } = {},
    ): Promise<BackgroundProcessSnapshot | undefined> => {
        const query =
            readOptions.waitMs === undefined
                ? ""
                : `?waitMs=${encodeURIComponent(String(readOptions.waitMs))}`;
        const response = await requestJson(
            `sessions/${encodeURIComponent(sessionId)}/background-processes/${encodeURIComponent(String(processSessionId))}${query}`,
            readOptions.signal === undefined ? {} : { signal: readOptions.signal },
        );
        return response.status === 404 ? undefined : (response.data as BackgroundProcessSnapshot);
    };

    const resolveExternalToolCall = (
        sessionId: string,
        callId: string,
        resolution: ExternalToolCallResolution,
    ): MutationId => {
        const pending =
            sessionEntries.get(sessionId)?.store.session().pendingExternalToolCalls ?? [];
        return enqueueSessionUpdate(
            "resolve_external_tool_call",
            sessionId,
            `external-tool-calls/${encodeURIComponent(callId)}`,
            "POST",
            resolution,
            { pendingExternalToolCalls: pending.filter((call) => call.id !== callId) },
        );
    };

    const cancelScheduledMessage = (sessionId: string, scheduledMessageId: string): MutationId => {
        const id = nextMutationId();
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "cancel_scheduled_message",
            entityKey: sessionKey(sessionId),
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const entry = sessionEntries.get(sessionId);
                if (entry === undefined) return () => undefined;
                const current = entry.store.session().scheduledMessages;
                const changed = entry.store.applyOptimisticSession({
                    scheduledMessages: current.map((message) =>
                        message.id === scheduledMessageId && message.status === "pending"
                            ? { ...message, status: "cancelled", updatedAt: now() }
                            : message,
                    ),
                });
                if (publish) publishSession(entry, changed.deltas);
                return changed.undo;
            },
            prepare: () => ({
                body: {},
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `sessions/${encodeURIComponent(sessionId)}/scheduled-messages/${encodeURIComponent(scheduledMessageId)}/cancel`,
                ),
            }),
            matchesAuthoritative: (data) =>
                (data as { message?: { id?: unknown; status?: unknown } } | null)?.message?.id ===
                    scheduledMessageId &&
                (data as { message?: { status?: unknown } } | null)?.message?.status ===
                    "cancelled",
        };
        return enqueue(mutation);
    };

    const recordActivity = (sessionId: string): MutationId => {
        const id = nextMutationId();
        return enqueue({
            acknowledged: false,
            action: "record_activity",
            applyOptimistic: () => () => undefined,
            entityKey: sessionKey(sessionId),
            id,
            prepare: () => ({
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `sessions/${encodeURIComponent(sessionId)}/activity`,
                ),
            }),
            undo: () => undefined,
        });
    };

    const connectTerminalPresence = async (
        sessionId: string,
        presenceOptions: { focused?: boolean; targetPid: number },
    ): Promise<TerminalPresence> => {
        const connectionId = nextMutationId();
        let focused = presenceOptions.focused === true;
        let presenceClosed = false;
        let inFlight: Promise<void> | undefined;
        const heartbeat = async (): Promise<void> => {
            await requestJson(
                `sessions/${encodeURIComponent(sessionId)}/terminal-connections/${encodeURIComponent(connectionId)}`,
                {
                    body: JSON.stringify({
                        connectionId,
                        focused,
                        targetPid: presenceOptions.targetPid,
                    }),
                    headers: { "content-type": "application/json" },
                    method: "PUT",
                },
            );
        };
        const sendHeartbeat = (): Promise<void> => {
            if (presenceClosed) return Promise.resolve();
            inFlight ??= heartbeat()
                .catch(() => undefined)
                .finally(() => {
                    inFlight = undefined;
                });
            return inFlight;
        };
        await heartbeat();
        const timer = setInterval(() => void sendHeartbeat(), 5_000);
        const closeLocally = (): void => {
            if (presenceClosed) return;
            presenceClosed = true;
            clearInterval(timer);
            presenceClosers.delete(closeLocally);
        };
        presenceClosers.add(closeLocally);
        return {
            connectionId,
            close: async () => {
                if (presenceClosed) return;
                closeLocally();
                await inFlight;
                await requestJson(
                    `sessions/${encodeURIComponent(sessionId)}/terminal-connections/${encodeURIComponent(connectionId)}`,
                    { method: "DELETE" },
                ).then(() => undefined);
            },
            setFocused: async (nextFocused) => {
                if (presenceClosed) return;
                focused = nextFocused;
                await sendHeartbeat();
            },
        };
    };

    const setSessionArchived = (sessionId: string, archived: boolean): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "set_session_archived",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const changed = entry.store.applyOptimisticSession({ archived });
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionArchived(
                        sessionId,
                        archived,
                    );
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/${archived ? "archive" : "unarchive"}`,
                    ),
                };
            },
            matchesAuthoritative: (data) => responseEntity(data, "session")?.archived === archived,
        };
        return enqueue(mutation);
    };

    /**
     * Marks a chat as caught up on, clearing its unread state everywhere.
     *
     * This is what an interface without a terminal uses in place of focusing
     * one. Repeating it is harmless, so a retry after a lost answer settles on
     * the same state rather than failing.
     */
    const markSessionRead = (sessionId: string): MutationId => {
        const id = nextMutationId();
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "mark_session_read",
            entityKey: sessionKey(sessionId),
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const entry = groupsEntry;
                const changed = entry.store.applyOptimisticSessionRead(sessionId);
                if (publish) publishGroups(entry, changed.deltas);
                return changed.undo;
            },
            prepare: () => ({
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `sessions/${encodeURIComponent(sessionId)}/read`,
                ),
            }),
            matchesAuthoritative: (data) => responseEntity(data, "session")?.unread === undefined,
        };
        return enqueue(mutation);
    };

    const renameGroup = (target: GroupTarget, name: string): MutationId => {
        const id = nextMutationId();
        const key = groupKey(target);
        let expectedVersion: number | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "rename_group",
            entityKey: key,
            ...(target.kind === "workspace" ? { expectsWorkspaceResponse: true } : {}),
            id,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const changed = groupsEntry.store.applyOptimisticGroupName(target, name);
                if (publish) publishGroups(groupsEntry, changed.deltas);
                return changed.undo;
            },
            prepare: () => {
                expectedVersion ??= groupVersion(target);
                const path =
                    target.kind === "project"
                        ? `projects/${encodeURIComponent(target.projectId)}`
                        : `projects/${encodeURIComponent(target.projectId)}/workspaces/${encodeURIComponent(target.workspaceId)}`;
                return {
                    body: { mutationId: id, name },
                    headers: ifMatchHeader(expectedVersion),
                    method: "PATCH",
                    url: endpointUrl(options.endpoint, path),
                };
            },
            matchesAuthoritative: (data) =>
                responseEntity(data, target.kind === "project" ? "project" : "workspace")?.name ===
                name,
        };
        return enqueue(mutation);
    };

    const listPlugins = async (
        readOptions: { signal?: AbortSignal } = {},
    ): Promise<ListPluginsResponse> => {
        const response = await request(endpointUrl(options.endpoint, "plugins"), {
            headers: {
                accept: "application/json",
                authorization: `Bearer ${options.token}`,
            },
            ...(readOptions.signal === undefined ? {} : { signal: readOptions.signal }),
        });
        if (!response.ok) {
            throw new Error(`Rig could not read plugins (${String(response.status)}).`);
        }
        return (await response.json()) as ListPluginsResponse;
    };

    const readPluginLog = async (
        name: string,
        readOptions: { signal?: AbortSignal } = {},
    ): Promise<PluginLogSnapshot> => {
        const response = await request(
            endpointUrl(options.endpoint, `plugins/${encodeURIComponent(name)}/log`),
            {
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                },
                ...(readOptions.signal === undefined ? {} : { signal: readOptions.signal }),
            },
        );
        if (!response.ok) {
            throw new Error(`Rig could not read the plugin log (${String(response.status)}).`);
        }
        return ((await response.json()) as PluginLogResponse).log;
    };

    const discoverPluginCatalog: RigConnection["discoverPluginCatalog"] = async (
        source,
        operationOptions = {},
    ) => {
        if (closed) throw new Error("This Rig connection is closed.");
        let requestBody: DiscoverPluginCatalogRequest;
        try {
            requestBody = Value.Decode(discoverPluginCatalogRequestSchema, source);
        } catch {
            throw new PluginCatalogRequestError(
                "invalid_request",
                0,
                "A plugin catalog source must use GitHub owner/repo form and a valid optional ref.",
            );
        }
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        try {
            const response = await request(
                endpointUrl(options.endpoint, "plugin-catalogs/github"),
                {
                    body: JSON.stringify(requestBody),
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${options.token}`,
                        "content-type": "application/json",
                    },
                    method: "POST",
                    signal: operation.signal,
                },
            );
            const body = await readBoundedResponseBytes(response, 4 * 1024 * 1024);
            if (!response.ok) throw pluginCatalogResponseError(response.status, body);
            try {
                return Value.Decode(
                    githubPluginCatalogSchema,
                    JSON.parse(new TextDecoder().decode(body)) as unknown,
                );
            } catch {
                throw new PluginCatalogRequestError(
                    "invalid_response",
                    response.status,
                    "Rig returned an invalid plugin catalog response.",
                );
            }
        } catch (error) {
            if (error instanceof PluginCatalogRequestError || operation.signal.aborted) {
                throw error;
            }
            throw new PluginCatalogRequestError(
                "request_failed",
                0,
                "Rig could not complete plugin catalog discovery.",
            );
        } finally {
            operation.detach();
        }
    };

    const installPlugin: RigConnection["installPlugin"] = async (source, operationOptions = {}) => {
        if (closed) throw new Error("This Rig connection is closed.");
        const requestId = operationOptions.requestId ?? nextEntityId();
        let installSource;
        if (typeof source === "string") {
            installSource = { sourceDirectory: source, type: "local-directory" as const };
        } else {
            try {
                installSource = Value.Decode(githubPluginPackageSourceSchema, source);
            } catch {
                throw new PluginManagementRequestError(
                    "invalid_request",
                    0,
                    "The selected plugin package source is invalid.",
                );
            }
        }
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        let retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
        try {
            for (let attempt = 1; ; attempt += 1) {
                operation.signal.throwIfAborted();
                try {
                    const response = await request(endpointUrl(options.endpoint, "plugins"), {
                        body: JSON.stringify({ requestId, source: installSource }),
                        headers: {
                            accept: "application/json",
                            authorization: `Bearer ${options.token}`,
                            "content-type": "application/json",
                        },
                        method: "POST",
                        signal: operation.signal,
                    });
                    const payload = await readPluginManagementResponse(
                        response,
                        installPluginResponseSchema,
                    );
                    return payload.plugin;
                } catch (error) {
                    if (
                        error instanceof PluginManagementRequestError ||
                        (error instanceof Error &&
                            error.message ===
                                "Rig returned an invalid plugin management response.") ||
                        !isRetryableMutationError(error)
                    ) {
                        throw error;
                    }
                    if (attempt >= PLUGIN_INSTALLATION_MAX_ATTEMPTS) {
                        throw new PluginManagementRequestError(
                            "request_failed",
                            0,
                            "Rig could not confirm plugin installation after repeated transport failures.",
                        );
                    }
                    await wait(retryDelay, operation.signal);
                    retryDelay = Math.min(MAXIMUM_MUTATION_RETRY_MS, retryDelay * 2);
                }
            }
        } finally {
            operation.detach();
        }
    };

    const uninstallPlugin: RigConnection["uninstallPlugin"] = async (
        name,
        operationOptions = {},
    ) => {
        if (closed) throw new Error("This Rig connection is closed.");
        const response = await request(
            endpointUrl(options.endpoint, `plugins/${encodeURIComponent(name)}`),
            {
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                },
                method: "DELETE",
                ...(operationOptions.signal === undefined
                    ? {}
                    : { signal: operationOptions.signal }),
            },
        );
        const payload = await readPluginManagementResponse(response, uninstallPluginResponseSchema);
        return payload.plugin;
    };

    // Finish notifications are told from the catalog, so a caller that wants
    // them gets it loaded and followed without opening a view of its own.
    if (options.onSessionFinished !== undefined) startGroupEntry(createGroupEntry());
    return {
        answerP2pVerification,
        archiveWorkspace,
        compatibility: () => compatibility,
        markSessionRead,
        listPlugins,
        close: () => {
            if (closed) return;
            for (const closePresence of [...presenceClosers]) closePresence();
            closed = true;
            if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
            gitWatchTimer = undefined;
            rootController.abort();
            for (const mutation of [...pendingOverlays].reverse()) mutation.undo();
            pendingOverlays.length = 0;
            queues.clear();
            for (const entry of sessionEntries.values()) {
                entry.controller.abort();
                entry.detachRoot();
                entry.subscribers.clear();
            }
            sessionEntries.clear();
            if (groupsEntry !== undefined) {
                groupsEntry.controller.abort();
                groupsEntry.detachRoot();
                groupsEntry.subscribers.clear();
                groupsEntry = undefined;
            }
            happyCloudEntry?.controller.abort();
            happyCloudEntry?.detachRoot();
            happyCloudEntry?.subscribers.clear();
            happyCloudEntry = undefined;
            p2pEntry?.controller.abort();
            p2pEntry?.detachRoot();
            p2pEntry?.subscribers.clear();
            p2pEntry = undefined;
            if (providerUsageEntry !== undefined) {
                if (providerUsageEntry.timer !== undefined) {
                    clearTimeout(providerUsageEntry.timer);
                }
                providerUsageEntry.controller.abort();
                providerUsageEntry.subscribers.clear();
                providerUsageEntry = undefined;
            }
            if (pluginsEntry !== undefined) {
                pluginsEntry.controller.abort();
                pluginsEntry.detachRoot();
                pluginsEntry.subscribers.clear();
                pluginsEntry = undefined;
            }
            if (murmurFriendsEntry !== undefined) {
                murmurFriendsEntry.controller.abort();
                murmurFriendsEntry.detachRoot();
                murmurFriendsEntry.subscribers.clear();
                murmurFriendsEntry = undefined;
            }
            inboxEntry?.subscribers.clear();
            inboxEntry = undefined;
            for (const entry of timelineEntries.values()) {
                entry.controller.abort();
                entry.detachRoot();
                entry.subscribers.clear();
            }
            timelineEntries.clear();
        },
        answerUserInput,
        answerMurmurFriendRequest,
        applyHappyCloudCommand,
        attachSecret,
        cancelScheduledMessage,
        clearGoal,
        compactSession,
        connectGroups,
        connectHappyCloud,
        connectP2p,
        connectInbox,
        connectMurmurFriends,
        connectPlugins,
        connectProviderUsage,
        connectSession,
        connectTerminalPresence,
        connectTimeline,
        createP2pInvitation,
        createSessionShare,
        createWorkspace,
        createSession,
        addSessionShareMember,
        deleteMurmurAccount,
        detachSecret,
        discoverPluginCatalog,
        forkSession,
        installPlugin,
        getMurmurAccount,
        getSessionSharePeerActivity,
        getSessionShareHealth,
        getSessionShareReplicaHistory,
        getHappyCloudProfile,
        getHappyCloudSessionBlob,
        getHappyCloudStatus,
        getP2pPairing,
        joinP2pInvitation,
        listMurmurContacts,
        listMurmurFriends,
        listMurmurFriendRequests,
        listSessionShareReplicaCapabilities,
        listSessionShareReplicas,
        projects,
        readBackgroundProcess,
        readPluginLog,
        postSessionShareFriendMessage,
        recordActivity,
        renameGroup,
        resolveExternalToolCall,
        revokeSessionShareMember,
        resetSession,
        rewindSession,
        runShellCommand,
        sendMurmurFriendRequest,
        sendMessage,
        sendContextMessage,
        setDraft,
        setAppendSystemPrompt,
        setEffort,
        setPermissionMode,
        setServiceTier,
        setGoal,
        setGoalStatus,
        setSessionArchived,
        setSessionShareFriendMessages,
        setSessionShareMemberCapabilities,
        setSessionShareToolOutput,
        stopRun,
        startMurmurService,
        stopMurmurService,
        stopSessionShare,
        stopBackgroundProcess,
        stopBackgroundProcesses,
        stopWorkflow,
        switchModel,
        signupMurmurAccount,
        uninstallPlugin,
    };
}

function sameP2pStatus(first: P2pStatus | undefined, second: P2pStatus): boolean {
    return first !== undefined && JSON.stringify(first) === JSON.stringify(second);
}

/** One chart per scope and filter, so two identical views share a load. */
function timelineKey(subscription: RigTimelineSubscriptionOptions): string {
    const scope = subscription.scope;
    const target =
        scope.kind === "global"
            ? "global"
            : scope.kind === "project"
              ? `project:${scope.projectId}`
              : scope.kind === "workspace"
                ? `workspace:${scope.projectId}:${scope.workspaceId}`
                : `session:${scope.sessionId}`;
    return `timeline:${target}:${String(subscription.includeArchived ?? false)}:${String(subscription.since ?? "")}`;
}

function sessionKey(sessionId: string): string {
    return `session:${sessionId}`;
}

function projectKey(projectId: string): string {
    return `project:${projectId}`;
}

function workspaceKey(projectId: string, workspaceId: string): string {
    return `workspace:${projectId}:${workspaceId}`;
}

function groupKey(target: GroupTarget): string {
    return target.kind === "project"
        ? projectKey(target.projectId)
        : workspaceKey(target.projectId, target.workspaceId);
}

function globalEventKey(event: GlobalEvent): string {
    if (event.type === "compute_preparation") {
        return `compute:${(event as ComputePreparationEvent).computeInstanceId}`;
    }
    if ("sessionId" in event && typeof event.sessionId === "string") {
        return sessionKey(event.sessionId);
    }
    const scoped = event as { projectId: string; workspaceId?: string };
    if (scoped.workspaceId !== undefined) {
        return workspaceKey(scoped.projectId, scoped.workspaceId);
    }
    return projectKey(scoped.projectId);
}

function mutationIdOf(event: SessionEvent | GlobalEvent): string | undefined {
    if (event.data === null || typeof event.data !== "object") return undefined;
    const mutationId = (event.data as { mutationId?: unknown }).mutationId;
    return typeof mutationId === "string" ? mutationId : undefined;
}

function ifMatchHeader(value: string | number | undefined): Record<string, string> {
    return value === undefined ? {} : { "if-match": JSON.stringify(String(value)) };
}

function composeUndo(undos: readonly (() => void)[]): () => void {
    return () => {
        for (const undo of [...undos].reverse()) undo();
    };
}

function initialHappyCloudStatus(): HappyCloudStatus {
    const denied = { changedAt: 0, consent: "denied" as const };
    return {
        authority: "local_record_only",
        capabilities: {
            friends: denied,
            group_chats: denied,
            happy_profile: denied,
            live_session_sharing: denied,
            remote_control: denied,
            session_blob_persistence: denied,
        },
        contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
        enrollment: { changedAt: 0, state: "not_enrolled" },
        profile: { changedAt: 0, state: "not_created" },
        updatedAt: 0,
        version: 0,
    };
}

function predictHappyCloudStatus(
    status: HappyCloudStatus,
    command: HappyCloudCommand,
    changedAt: number,
): HappyCloudStatus {
    const next: HappyCloudStatus = {
        ...status,
        updatedAt: changedAt,
        version: status.version + 1,
    };
    if (command.action === "set_enrollment") {
        if (command.state === "enrolled") {
            return { ...next, enrollment: { changedAt, state: "enrolled" } };
        }
        const denied = { changedAt, consent: "denied" as const };
        return {
            ...next,
            capabilities: {
                friends: denied,
                group_chats: denied,
                happy_profile: denied,
                live_session_sharing: denied,
                remote_control: denied,
                session_blob_persistence: denied,
            },
            enrollment: { changedAt, state: "not_enrolled" },
            profile: { changedAt, state: "not_created" },
        };
    }
    if (command.action === "set_capability") {
        return {
            ...next,
            capabilities: {
                ...status.capabilities,
                [command.capability]: { changedAt, consent: command.consent },
            },
            ...(command.capability === "happy_profile" && command.consent === "denied"
                ? { profile: { changedAt, state: "not_created" as const } }
                : {}),
        };
    }
    if (command.action === "put_profile") {
        return { ...next, profile: { changedAt, state: "created" } };
    }
    if (command.action === "delete_profile") {
        return { ...next, profile: { changedAt, state: "not_created" } };
    }
    return next;
}

function uniqueAppend(values: readonly string[], ...added: readonly string[]): readonly string[] {
    return [...new Set([...values, ...added])];
}

function linkedController(parent: AbortSignal): {
    controller: AbortController;
    detach: () => void;
} {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", abort, { once: true });
    return {
        controller,
        detach: () => parent.removeEventListener("abort", abort),
    };
}

function combinedSignal(
    parent: AbortSignal,
    additional: AbortSignal | undefined,
): { detach: () => void; signal: AbortSignal } {
    if (additional === undefined) return { detach: () => undefined, signal: parent };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent.aborted || additional.aborted) controller.abort();
    else {
        parent.addEventListener("abort", abort, { once: true });
        additional.addEventListener("abort", abort, { once: true });
    }
    return {
        detach: () => {
            parent.removeEventListener("abort", abort);
            additional.removeEventListener("abort", abort);
        },
        signal: controller.signal,
    };
}

async function readResponseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

async function readBoundedResponseBytes(
    response: Response,
    maximumBytes: number,
): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Rig returned more plugin data than the host can accept.");
    }
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maximumBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error("Rig returned more plugin data than the host can accept.");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

function responseError(status: number, body: Uint8Array): Error {
    const text = new TextDecoder().decode(body);
    try {
        const payload = JSON.parse(text) as {
            error?: { code?: unknown; message?: unknown } | string;
        };
        if (typeof payload.error === "string") return new Error(payload.error);
        if (typeof payload.error?.code === "string" && typeof payload.error.message === "string") {
            return new PluginAppRequestError(payload.error.code, status, payload.error.message);
        }
    } catch {
        // A non-JSON refusal still gets a deterministic host-facing fallback.
    }
    return new Error(`Rig rejected the MCP App request (${String(status)}).`);
}

function pluginIconResponseError(status: number, body: Uint8Array): Error {
    const text = new TextDecoder().decode(body);
    try {
        const payload = JSON.parse(text) as {
            error?: { code?: unknown; message?: unknown };
        };
        if (
            (payload.error?.code === "icon_unavailable" ||
                payload.error?.code === "plugin_not_found" ||
                payload.error?.code === "stale_generation") &&
            typeof payload.error.message === "string"
        ) {
            return new PluginIconRequestError(payload.error.code, status, payload.error.message);
        }
    } catch {
        // A non-JSON refusal still gets a deterministic host-facing fallback.
    }
    return new Error(`Rig could not read the plugin icon (${String(status)}).`);
}

async function readPluginManagementResponse<TSchema_ extends TSchema>(
    response: Response,
    schema: TSchema_,
): Promise<Static<TSchema_>> {
    const body = await readBoundedResponseBytes(response, 64 * 1024);
    if (!response.ok) throw pluginManagementResponseError(response.status, body);
    try {
        return Value.Decode(schema, JSON.parse(new TextDecoder().decode(body)) as unknown);
    } catch {
        throw new PluginManagementRequestError(
            "invalid_response",
            response.status,
            "Rig returned an invalid plugin management response.",
        );
    }
}

function pluginCatalogResponseError(status: number, body: Uint8Array): Error {
    const text = new TextDecoder().decode(body);
    try {
        const payload = Value.Decode(pluginCatalogErrorResponseSchema, JSON.parse(text));
        return new PluginCatalogRequestError(payload.error.code, status, payload.error.message);
    } catch {
        return new Error(`Rig rejected the plugin catalog request (${String(status)}).`);
    }
}

function pluginManagementResponseError(status: number, body: Uint8Array): Error {
    const text = new TextDecoder().decode(body);
    try {
        const payload = Value.Decode(pluginManagementErrorResponseSchema, JSON.parse(text));
        return new PluginManagementRequestError(payload.error.code, status, payload.error.message);
    } catch {
        // The stable fallback below covers malformed and non-JSON daemon refusals.
    }
    return new Error(`Rig rejected the plugin management request (${String(status)}).`);
}

class MutationHttpError extends Error {
    readonly data: unknown;
    readonly retryAfterMs: number | undefined;
    readonly status: number;

    constructor(status: number, message: string, retryAfterMs: number | undefined, data?: unknown) {
        super(message);
        this.name = "MutationHttpError";
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.data = data;
    }
}

function projectRegistrationResponseError(
    status: number,
    data: unknown,
): ProjectRegistrationError | undefined {
    try {
        const response = Value.Decode(projectRegistrationErrorResponseSchema, data);
        return new ProjectRegistrationError(response.error.code, status, response.error.message);
    } catch {
        return undefined;
    }
}

function projectRegistrationRequestFailure(error: unknown): ProjectRegistrationProtocolError {
    if (error instanceof MutationHttpError) {
        return new ProjectRegistrationProtocolError(
            "request_failed",
            error.status,
            `Rig could not register the project (${String(error.status)}): ${error.message}`,
        );
    }
    return new ProjectRegistrationProtocolError(
        "request_failed",
        undefined,
        "Rig could not confirm project registration after repeated transport failures.",
    );
}

function isRetryableMutationError(error: unknown): boolean {
    if (!(error instanceof MutationHttpError)) {
        return !(error instanceof DOMException && error.name === "AbortError");
    }
    return (
        error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
    );
}

function isSessionShareMutationAction(
    action: MutationAction,
): action is Extract<
    MutationAction,
    | "add_session_share_member"
    | "create_session_share"
    | "revoke_session_share_member"
    | "set_session_share_friend_messages"
    | "set_session_share_member_capabilities"
    | "set_session_share_tool_output"
    | "stop_session_share"
> {
    return (
        action === "add_session_share_member" ||
        action === "create_session_share" ||
        action === "revoke_session_share_member" ||
        action === "set_session_share_friend_messages" ||
        action === "set_session_share_member_capabilities" ||
        action === "set_session_share_tool_output" ||
        action === "stop_session_share"
    );
}

function retryAfterMilliseconds(value: string | null, currentTime: number): number | undefined {
    if (value === null) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - currentTime) : undefined;
}

function humanMutationError(data: unknown, status: number): string {
    if (
        data !== null &&
        typeof data === "object" &&
        typeof (data as { error?: unknown }).error === "string"
    ) {
        return (data as { error: string }).error;
    }
    return `Rig rejected the change with status ${String(status)}.`;
}

function describeMutationRejection(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return "Rig could not apply that change.";
}

function humanProviderUsageError(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return "Rig could not read how much of each provider has been used.";
}

function responseEntity(
    data: unknown,
    key: "project" | "session" | "workspace",
): Record<string, unknown> | undefined {
    if (data === null || typeof data !== "object") return undefined;
    const entity = (data as Record<string, unknown>)[key];
    return entity !== null && typeof entity === "object"
        ? (entity as Record<string, unknown>)
        : undefined;
}

function isWorkspaceResponse(data: unknown): boolean {
    const workspace = responseEntity(data, "workspace");
    return workspace !== undefined && Value.Check(projectWorkspaceSchema, workspace);
}

function hasInvalidWorkspaceField(data: unknown): boolean {
    return (
        data !== null &&
        typeof data === "object" &&
        Object.hasOwn(data, "workspace") &&
        !isWorkspaceResponse(data)
    );
}

function isValidWorkspaceEvent(event: GlobalEvent): boolean {
    if (event.type !== "workspace_created" && event.type !== "workspace_updated") return true;
    const workspace = responseEntity(event.data, "workspace");
    return workspace !== undefined && Value.Check(projectWorkspaceSchema, workspace);
}

function isProtocolSessionResponse(
    value: Record<string, unknown> | undefined,
): value is Record<string, unknown> & ProtocolSession {
    return (
        typeof value?.id === "string" &&
        typeof value.archived === "boolean" &&
        typeof value.cwd === "string" &&
        typeof value.modelId === "string" &&
        typeof value.projectId === "string" &&
        typeof value.providerId === "string" &&
        typeof value.status === "string"
    );
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(finish, ms);
        function finish(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

/**
 * Loads the catalog by request-response.
 *
 * Entities never travel on the stream, so this is how a client learns what
 * exists. It is called after the stream is open, which is what makes the load
 * safe to rebase: anything that changes while it is in flight arrives on the
 * stream carrying a cursor.
 */
async function fetchTimeline(
    endpoint: string,
    token: string,
    request: typeof fetch,
    entry: { includeArchived: boolean; scope: TimelineScope; since?: number },
    signal: AbortSignal,
): Promise<GetTimelineResponse> {
    const response = await request(endpointUrl(endpoint, "/timeline"), {
        body: JSON.stringify({
            includeArchived: entry.includeArchived,
            scope: entry.scope,
            ...(entry.since === undefined ? {} : { since: entry.since }),
        }),
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        method: "POST",
        signal,
    });
    if (!response.ok) {
        throw new Error(`Rig could not load the timeline (${String(response.status)}).`);
    }
    return (await readResponseBody(response)) as GetTimelineResponse;
}

async function fetchCatalog(
    endpoint: string,
    token: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<GlobalStreamHello> {
    const response = await request(endpointUrl(endpoint, "catalog"), {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) throw new Error(`Rig answered with ${String(response.status)}.`);
    return (await response.json()) as GlobalStreamHello;
}

async function fetchPluginCatalog(
    endpoint: string,
    token: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<ListPluginsResponse> {
    const response = await request(endpointUrl(endpoint, "plugins"), {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        throw new Error(`Rig could not load the plugin catalog (${String(response.status)}).`);
    }
    return Value.Decode(listPluginsResponseSchema, await response.json());
}

async function fetchGitWatch(
    endpoint: string,
    token: string,
    entities: readonly GitWatchEntity[],
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<readonly GlobalEvent[]> {
    const response = await request(endpointUrl(endpoint, "git/watch"), {
        body: JSON.stringify({ entities }),
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        method: "POST",
        signal,
    });
    if (response.status === 404 || response.status === 503) return [];
    if (!response.ok) throw new Error(`Rig answered with ${String(response.status)}.`);
    return ((await response.json()) as GitWatchResponse).snapshots;
}

/**
 * Loads everything needed to start showing a session, by request-response.
 *
 * The reply states the position in the live stream it reflects, so the events
 * that arrive after it can be replayed on top rather than guessed about.
 */
async function fetchSessionState(
    endpoint: string,
    token: string,
    sessionId: string,
    turnLimit: number | undefined,
    after: string | undefined,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<SessionStateResponse> {
    const query = new URLSearchParams();
    if (turnLimit !== undefined) query.set("turns", String(turnLimit));
    // The newest transcript row already held, so the daemon sends only what follows it.
    if (after !== undefined) query.set("after", after);
    const path = `sessions/${encodeURIComponent(sessionId)}/state`;
    const url = endpointUrl(endpoint, query.size === 0 ? path : `${path}?${query.toString()}`);
    const response = await request(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) throw new Error(`Rig answered with ${String(response.status)}.`);
    let state = (await response.json()) as SessionStateResponse;
    if (state.append !== true || state.transcript === undefined) return state;

    let transcript = state.transcript;
    while (!transcript.complete) {
        const pageAnchor = newestMessageEventId(transcript);
        if (pageAnchor === undefined) {
            throw new Error("Rig returned a forward transcript page without a message cursor.");
        }
        const page = await fetchTranscriptAfter(
            endpoint,
            token,
            sessionId,
            pageAnchor,
            request,
            signal,
        );
        const nextAnchor = newestMessageEventId(page);
        if (!page.complete && (nextAnchor === undefined || nextAnchor === pageAnchor)) {
            throw new Error("Rig returned a forward transcript page that made no progress.");
        }
        transcript = mergeForwardTranscriptWindow(transcript, page, page.complete);
    }
    state = {
        ...state,
        transcript,
        ...(state.session === undefined
            ? {}
            : {
                  session: {
                      ...state.session,
                      snapshot: { ...state.session.snapshot, messages: transcript.messages },
                  },
              }),
    };
    return state;
}

async function fetchTranscriptAfter(
    endpoint: string,
    token: string,
    sessionId: string,
    after: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<SessionTranscriptWindow> {
    const url = endpointUrl(
        endpoint,
        `sessions/${encodeURIComponent(sessionId)}/transcript?after=${encodeURIComponent(after)}`,
    );
    const response = await request(url, {
        headers: { authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        throw new Error(
            response.status === 409
                ? "That part of the conversation is no longer available."
                : `Rig answered with ${String(response.status)}.`,
        );
    }
    return (await response.json()) as SessionTranscriptWindow;
}

function newestMessageEventId(transcript: SessionTranscriptWindow): string | undefined {
    let newest: string | undefined;
    for (const message of transcript.messages) {
        const eventId = transcript.messageEventId?.[message.id];
        if (eventId !== undefined && (newest === undefined || eventId > newest)) newest = eventId;
    }
    for (const notice of transcript.notices ?? []) {
        if (newest === undefined || notice.eventId > newest) newest = notice.eventId;
    }
    return newest;
}

async function fetchEarlier(
    endpoint: string,
    token: string,
    sessionId: string,
    before: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<SessionTranscriptWindow> {
    const url = endpointUrl(
        endpoint,
        `sessions/${encodeURIComponent(sessionId)}/transcript?before=${encodeURIComponent(before)}`,
    );
    const response = await request(url, {
        headers: { authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        throw new Error(
            response.status === 409
                ? "That part of the conversation is no longer available."
                : `Rig answered with ${String(response.status)}.`,
        );
    }
    return (await response.json()) as SessionTranscriptWindow;
}

function describeLoadFailure(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return "Earlier messages could not be loaded.";
}
