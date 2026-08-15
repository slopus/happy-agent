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
import type { DocumentDelta, DocumentState } from "./DocumentElement.js";
import { DocumentStore } from "./DocumentStore.js";
import type { FolderDelta, FolderView, FoldersState } from "./FolderElement.js";
import { FolderStore } from "./FolderStore.js";
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
import type { ReadWorkletLogResult, Worklet, WorkletsState } from "./WorkletElement.js";
import { projectWorklet, WorkletManagementRequestError, WorkletStore } from "./WorkletElement.js";
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
    CreateDocumentRequest,
    CreateFolderRequest,
    CreateFolderItemRequest,
    Document,
    DocumentUpdate,
    DocumentUpdatePage,
    Folder,
    FolderItem,
    MoveFolderRequest,
    MoveFolderItemRequest,
    MoveSessionRequest,
    UpdateFolderRequest,
    WriteDocumentRequest,
    GitChangeSnapshot,
    GitWatchResponse,
    GitHubPluginCatalog,
    GitHubPluginPackageSource,
    GlobalEvent,
    MutationId,
    Project,
    ProjectRegistrationErrorCode,
    ProjectRemoteSource,
    ProjectWorkspace,
    ProtocolSession,
    RemoteTerminalGroupState,
    SessionEvent,
    SessionTranscriptWindow,
    SessionUnreadReason,
    SessionUnreadState,
    SessionScope,
    GlobalStreamHello,
    GetTimelineResponse,
    ListProviderUsageResponse,
    InstalledPluginSummary,
    ListPluginsResponse,
    ListWorkletsResponse,
    PluginLogResponse,
    PluginLogSnapshot,
    PluginSummary,
    DiscoverPluginCatalogRequest,
    SessionStateResponse,
    TimelineScope,
    UninstalledPluginSummary,
    HappyCloudCommand,
    HappyCloudProfileCiphertextResponse,
    HappyCloudSessionBlobResponse,
    HappyCloudStatus,
    P2pStatus,
    CreateP2pInvitationResponse,
    JoinP2pInvitationResponse,
    OnboardMurmurRequest,
    OnboardMurmurResponse,
    OnboardingStatus,
    P2pPairingState,
    CreateRigProfileRequest,
    RigProfile,
    RigProfileResponse,
    SharingOutgoingContactRequest,
    SharingOutgoingContactRequestResponse,
    SharingSnapshot,
    CreateSharingInvitationResponse,
    FolderShareStatus,
    UpdateRigProfileRequest,
    SecretRegistration,
    SecretSummary,
    SecretUpdate,
} from "./protocol.js";
import {
    HAPPY_CLOUD_CONTRACT_VERSION,
    happyCloudCommandErrorResponseSchema,
    happyCloudCommandResponseSchema,
    happyCloudChangedEventSchema,
    happyCloudProfileCiphertextResponseSchema,
    happyCloudSessionBlobResponseSchema,
    happyCloudStatusSchema,
    p2pStatusChangedEventSchema,
    p2pStatusSchema,
    onboardMurmurRequestSchema,
    onboardMurmurResponseSchema,
    onboardingStatusSchema,
    createRigProfileRequestSchema,
    listRigProfilesResponseSchema,
    rigProfileIdSchema,
    rigProfileChangedEventSchema,
    rigProfileResponseSchema,
    sharingChangedEventSchema,
    sharingIdentitySchema,
    sharingOutgoingContactRequestResponseSchema,
    sharingSnapshotSchema,
    createSharingInvitationResponseSchema,
    createFolderShareRequestSchema,
    folderShareStatusSchema,
    updateRigProfileRequestSchema,
    createP2pInvitationResponseSchema,
    joinP2pInvitationResponseSchema,
    p2pPairingStateSchema,
    documentEventSchema,
    documentResponseSchema,
    documentUpdatePageSchema,
    folderItemSchema,
    folderResponseSchema,
    listFoldersResponseSchema,
    listPluginsResponseSchema,
    listWorkletsResponseSchema,
    workletSummarySchema,
    discoverPluginCatalogRequestSchema,
    githubPluginCatalogSchema,
    githubPluginPackageSourceSchema,
    pluginInstallClassificationSchema,
    projectRegistrationErrorResponseSchema,
    projectResponseSchema,
    projectWorkspaceSchema,
    listSecretsResponseSchema,
    secretIdSchema,
    secretRegistrationSchema,
    secretResponseSchema,
    secretUpdateSchema,
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
const MAXIMUM_PROFILE_RESPONSE_BYTES = 20 * 1024 * 1024;
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
const workletResponseSchema = Type.Object(
    { worklet: workletSummarySchema },
    { additionalProperties: false },
);
const workletLogResponseSchema = Type.Object(
    { log: Type.String(), truncated: Type.Boolean() },
    { additionalProperties: false },
);
const workletManagementErrorResponseSchema = Type.Object(
    {
        error: Type.Object(
            {
                code: Type.Union([
                    Type.Literal("invalid_request"),
                    Type.Literal("invalid_worklet"),
                    Type.Literal("worklet_not_found"),
                ]),
                message: Type.String(),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
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
const folderItemMutationResponseSchema = Type.Object(
    {
        item: folderItemSchema,
        revision: Type.Integer({ minimum: 0 }),
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
    scope: SessionScope;
    reason: SessionUnreadReason;
    sessionId: string;
    /** When it started waiting, from the event that caused it. */
    since: number;
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

export interface RigProfilesSubscriptionOptions {
    onChange: (profiles: readonly RigProfile[]) => void;
    onError?: (error: unknown) => void;
}

export interface RigProfilesConnection {
    close: () => void;
    /** Empty until the first authoritative profile snapshot has loaded. */
    profiles: () => readonly RigProfile[];
}

export interface RigSharingSubscriptionOptions {
    onChange: (snapshot: SharingSnapshot) => void;
    onError?: (error: unknown) => void;
}

export interface RigSharingConnection {
    close: () => void;
    /** Absent until the first authoritative Sharing snapshot has loaded. */
    snapshot: () => SharingSnapshot | undefined;
}

export interface RigInboxSubscriptionOptions {
    onChange: (items: readonly InboxItem[], state: InboxState) => void;
    onDelta?: (delta: InboxDelta) => void;
    onError?: (error: unknown) => void;
}

export interface RigFoldersSubscriptionOptions {
    onChange: (view: FolderView, state: FoldersState) => void;
    onDelta?: (delta: FolderDelta) => void;
    onError?: (error: unknown) => void;
}

export interface RigDocumentSubscriptionOptions {
    documentId: string;
    onChange: (
        document: Document | undefined,
        updates: readonly DocumentUpdate[],
        state: DocumentState,
    ) => void;
    onDelta?: (delta: DocumentDelta) => void;
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

export interface RigWorkletsSubscriptionOptions {
    onChange: (worklets: readonly Worklet[], state: WorkletsState) => void;
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

export interface RigFoldersConnection {
    /** The folder tree and global Unsorted list as one atomic application value. */
    view: () => FolderView;
    state: () => FoldersState;
    close: () => void;
}

export interface RigDocumentConnection {
    document: () => Document | undefined;
    updates: () => readonly DocumentUpdate[];
    state: () => DocumentState;
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

export interface RigWorkletsConnection {
    worklets: () => readonly Worklet[];
    state: () => WorkletsState;
    /** Reads the worklet's bounded current log. */
    readLog: (name: string, options?: { signal?: AbortSignal }) => Promise<ReadWorkletLogResult>;
    /** Imports a source folder as a new worklet and starts it. */
    install: (request: InstallWorkletInput, options?: { signal?: AbortSignal }) => Promise<Worklet>;
    /** Imports a new version of an installed worklet and restarts it. */
    update: (
        name: string,
        request: UpdateWorkletInput,
        options?: { signal?: AbortSignal },
    ) => Promise<Worklet>;
    /** Makes an existing version current again and restarts the worklet. */
    revert: (name: string, version: number, options?: { signal?: AbortSignal }) => Promise<Worklet>;
    /** Stops a worklet and removes every version of its code, keeping its data folder. */
    uninstall: (name: string, options?: { signal?: AbortSignal }) => Promise<void>;
    close: () => void;
}

/**
 * A source folder and an icon. The worklet's name, description, purpose, and the disk and network
 * access it is granted all come from the `worklet.json` at the root of that folder.
 */
export interface InstallWorkletInput {
    /** Session responsible for this installation, retained with the global worklet record. */
    authorSessionId: string;
    /** Absolute path of the required 512 by 512 PNG worklet icon. */
    iconPath: string;
    /** Absolute path of the source folder to import. */
    path: string;
    sourceDescription?: string;
}

export interface UpdateWorkletInput {
    /** What changed in this import. */
    changeDescription: string;
    /** Absolute path of the source folder to import. */
    path: string;
}

export interface RigTimelineConnection {
    agents: () => readonly TimelineAgentNode[];
    state: () => TimelineState;
    close: () => void;
}

export interface SendMessageInput {
    content?: readonly ContentBlock[];
    displayText?: string;
    identity?: string | null;
    /** Shares the native GitHub credential for this one remote operation. */
    gitSecret?: { kind: "github" };
    text: string;
}

export interface SendContextMessageInput {
    identity?: string | null;
    /** Shares the native GitHub credential for this one remote operation. */
    gitSecret?: { kind: "github" };
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
    /** Human profile responsible for this session. Required when creating it on a peer Rig. */
    identity?: string;
    /** Shares the native GitHub credential for this one remote operation. */
    gitSecret?: { kind: "github" };
    local?: boolean;
    modelId?: string;
    permissionMode?: string;
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
    scope?: Extract<SessionScope, { kind: "folder" | "unsorted" }>;
}

export interface CreateWorkspaceInput {
    /** Explicit base to fork; the project's main branch on the remote is used when it is absent. */
    baseRef?: string;
    /** Human profile that owns the workspace. Required when creating it on a peer Rig. */
    identity?: string;
    name: string;
    projectId: string;
    /** Refreshes the peer daemon's memory-only GitHub authentication for a managed project. */
    secret?: { kind: "github" };
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

export interface CreateRemoteProjectInput {
    /** Human profile responsible for this clone and its Git identity. */
    identity: string;
    name: string;
    /** Reuses a failed managed project reservation, including after reconnecting. */
    projectId?: string;
    secret?: { kind: "github" };
    source: ProjectRemoteSource;
}

export interface RigProjects {
    /**
     * Registers a Git top-level folder and returns Rig's authoritative project entity.
     *
     * Ambiguous transport failures retry with one project identity, so a response lost after the
     * daemon commits still converges on the entity that was already created.
     */
    add(path: string, options?: ProjectAddOptions): Promise<Project>;
    /** Creates a managed project immediately and tracks its background clone in the catalog. */
    clone(input: CreateRemoteProjectInput): MutationId;
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

export interface FolderCreateOptions {
    /** Reuses a caller-owned identity. Rig Connect creates one when this is absent. */
    folderId?: string;
}

export interface FolderItemLinkOptions {
    /** Reuses a caller-owned identity. Rig Connect creates one when this is absent. */
    itemId?: string;
}

export interface DocumentCreateOptions {
    /** Reuses a caller-owned identity. Rig Connect creates one when this is absent. */
    documentId?: string;
}

export interface DocumentUpdatesLoadOptions {
    afterVersion?: number;
    limit?: number;
    signal?: AbortSignal;
}

/**
 * Everything a view does to the folder tree.
 *
 * Each call applies its prediction immediately and returns the mutation identity used to reconcile
 * the daemon's response and live echo. The daemon still derives authoritative order keys, which is
 * why moves name their destination and preceding folder or item rather than inventing an order key.
 */
export interface RigFolders {
    /**
     * Creates one folder.
     *
     * The client names what it creates, so an answer lost after Rig committed still converges on
     * the same folder when the request is retried.
     */
    create(request: CreateFolderRequest, options?: FolderCreateOptions): MutationId;
    /** Changes a folder's own fields. An explicit `null` clears one. */
    update(folderId: string, request: UpdateFolderRequest): MutationId;
    /**
     * Applies one drag-and-drop: the folder it was dropped into and the folder or item it landed
     * below.
     *
     * `parentId` is `null` at the root and `afterId` is `null` when it landed first. Rig derives
     * the order key from that pair.
     */
    move(folderId: string, request: MoveFolderRequest): MutationId;
    /** Puts a folder away together with everything nested under it. */
    archive(folderId: string): MutationId;
    /** Links one project, workspace, or document into this folder's shared direct-child list. */
    linkItem(
        folderId: string,
        request: CreateFolderItemRequest,
        options?: FolderItemLinkOptions,
    ): MutationId;
    /** Moves an item into or within a folder without changing its target's own ordering. */
    moveItem(itemId: string, request: Omit<MoveFolderItemRequest, "mutationId">): MutationId;
    /** Removes the link only. The project, workspace, or document remains unchanged. */
    unlinkItem(itemId: string): MutationId;
    /** Moves one chat within the folder tree or Unsorted ordering domain. */
    moveSession(sessionId: string, request: Omit<MoveSessionRequest, "mutationId">): MutationId;
    /** Files one chat into a folder, or moves it to Unsorted with `null`. */
    setSessionFolder(sessionId: string, folderId: string | null): MutationId;
}

export interface RigDocuments {
    /** Creates an opaque live document and returns its client-chosen document identity. */
    create(request: CreateDocumentRequest, options?: DocumentCreateOptions): MutationId;
    /**
     * Applies one strict compare-version-and-write prediction.
     *
     * The exact caller-supplied version is sent on every attempt. Rig Connect never rebases it.
     */
    write(documentId: string, expectedVersion: number, request: WriteDocumentRequest): MutationId;
    /** Loads one bounded page of the retained opaque update queue. */
    loadUpdates(
        documentId: string,
        options?: DocumentUpdatesLoadOptions,
    ): Promise<DocumentUpdatePage>;
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
 * Optimistic entity mutations return a mutation identity synchronously after
 * their prediction is visible. External capability operations, including P2P
 * pairing and Sharing contact handshakes, await their protocol result.
 */
export interface RigConnection {
    /** Current result of the daemon protocol handshake. */
    compatibility: () => ServerCompatibility;
    connectSession: (options: RigSessionSubscriptionOptions) => RigSessionConnection;
    connectGroups: (options: RigGroupsSubscriptionOptions) => RigGroupsConnection;
    connectInbox: (options: RigInboxSubscriptionOptions) => RigInboxConnection;
    /**
     * Follows the folder tree, ordered and already nested.
     *
     * Folders ride the same stream and the same opening catalog as the groups, so following them
     * adds no request of its own.
     */
    connectFolders: (options: RigFoldersSubscriptionOptions) => RigFoldersConnection;
    /** Follows one opaque document snapshot over the shared global stream. */
    connectDocument: (options: RigDocumentSubscriptionOptions) => RigDocumentConnection;
    /** Follows the authoritative status plus this client's pending Happy Cloud choices. */
    connectHappyCloud: (options: RigHappyCloudSubscriptionOptions) => RigHappyCloudConnection;
    /** Follows authenticated P2P transports and trusted peer reachability. */
    connectP2p: (options: RigP2pSubscriptionOptions) => RigP2pConnection;
    /** Materializes the current daemon-owned onboarding requirement. */
    getOnboardingStatus: (options?: { signal?: AbortSignal }) => Promise<OnboardingStatus>;
    /** Persists the Murmur opt-in or opt-out and lazily creates an identity when enabled. */
    onboardMurmur: (
        request: OnboardMurmurRequest,
        options?: { signal?: AbortSignal },
    ) => Promise<OnboardMurmurResponse>;
    /** Follows the human profiles whose identities appear on messages. */
    connectProfiles: (options: RigProfilesSubscriptionOptions) => RigProfilesConnection;
    connectSharing: (options: RigSharingSubscriptionOptions) => RigSharingConnection;
    getSharing: (options?: { signal?: AbortSignal }) => Promise<SharingSnapshot>;
    createSharingInvitation: (options?: {
        signal?: AbortSignal;
    }) => Promise<CreateSharingInvitationResponse>;
    /** Creates one Murmur group whose invitation descriptor carries the folder's current tree. */
    shareFolder: (
        folderId: string,
        contacts: readonly string[],
        options?: { signal?: AbortSignal },
    ) => Promise<FolderShareStatus>;
    requestSharingContact: (
        invitation: string,
        options?: { signal?: AbortSignal },
    ) => Promise<SharingOutgoingContactRequest>;
    acceptSharingContactRequest: (
        requestId: string,
        options?: { signal?: AbortSignal },
    ) => Promise<SharingSnapshot>;
    rejectSharingContactRequest: (
        requestId: string,
        options?: { signal?: AbortSignal },
    ) => Promise<SharingSnapshot>;
    removeSharingContact: (
        identity: string,
        options?: { signal?: AbortSignal },
    ) => Promise<SharingSnapshot>;
    /** Destroys local Murmur contacts, sessions, and folder shares, then creates a new identity. */
    resetSharing: (options?: { signal?: AbortSignal }) => Promise<SharingSnapshot>;
    listProfiles: (options?: { signal?: AbortSignal }) => Promise<readonly RigProfile[]>;
    createProfile: (
        request: CreateRigProfileRequest,
        options?: { signal?: AbortSignal },
    ) => Promise<RigProfile>;
    updateProfile: (
        profileId: string,
        request: UpdateRigProfileRequest,
        options?: { signal?: AbortSignal },
    ) => Promise<RigProfile>;
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
    /** Follows every installed worklet, its version, its state, and its status. */
    connectWorklets: (options: RigWorkletsSubscriptionOptions) => RigWorkletsConnection;
    connectTimeline: (options: RigTimelineSubscriptionOptions) => RigTimelineConnection;
    /** Reads the current plugin catalog once. Lifecycle changes are also announced live. */
    listPlugins: (options?: { signal?: AbortSignal }) => Promise<{
        failures: readonly { error: string; folder: string }[];
        plugins: readonly PluginSummary[];
    }>;
    /** Reads one bounded current-run log or startup-failure diagnostic snapshot. */
    readPluginLog: (name: string, options?: { signal?: AbortSignal }) => Promise<PluginLogSnapshot>;
    /** Reads secret metadata only. Secret values are never returned by Rig. */
    listSecrets: (options?: SecretOperationOptions) => Promise<readonly SecretSummary[]>;
    /** Stores values entered through a client-owned masked secret form. */
    registerSecret: (
        registration: SecretRegistration,
        options?: SecretOperationOptions,
    ) => Promise<SecretSummary>;
    /** Updates only the fields and values supplied by the client. */
    updateSecret: (
        secretId: string,
        update: SecretUpdate,
        options?: SecretOperationOptions,
    ) => Promise<SecretSummary>;
    /** Resolves and validates one explicit GitHub repository plugin catalog. */
    discoverPluginCatalog: (
        source: DiscoverPluginCatalogRequest,
        options?: { signal?: AbortSignal },
    ) => Promise<GitHubPluginCatalog>;
    /** Installs and starts a plugin from a source folder on the Rig machine. */
    installPlugin: (
        source: string | GitHubPluginPackageSource,
        options?: { requestId?: string; signal?: AbortSignal },
    ) => Promise<InstalledPluginSummary>;
    /** Stops a plugin, removes its managed code, and keeps its writable data folder. */
    uninstallPlugin: (
        name: string,
        options?: { signal?: AbortSignal },
    ) => Promise<UninstalledPluginSummary>;
    /** Entity-first project catalog actions. */
    projects: RigProjects;
    /** Entity-first folder tree actions. */
    folders: RigFolders;
    /** Entity-first live document actions. */
    documents: RigDocuments;
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
    sendContextMessage: (
        sessionId: string,
        message: string | SendContextMessageInput,
    ) => MutationId;
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

export interface HappyCloudOperationOptions {
    signal?: AbortSignal;
}

export interface SecretOperationOptions {
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

interface FolderSubscriber extends RigFoldersSubscriptionOptions {
    closed: boolean;
}

interface FolderEntry {
    folderBaselineApplied: boolean;
    hasFolderSnapshot: boolean;
    loadedRevision: number;
    loading?: Promise<void>;
    reloadGeneration: number;
    requiredRevision: number;
    store: FolderStore;
    subscribers: Set<FolderSubscriber>;
}

interface DocumentSubscriber extends RigDocumentSubscriptionOptions {
    closed: boolean;
}

interface PendingDocumentCreate {
    promise: Promise<boolean>;
    settle: (committed: boolean) => void;
}

interface DocumentEntry {
    bootstrapVersion: number;
    controller: AbortController;
    detachRoot: () => void;
    loading?: Promise<void>;
    pendingCreate?: PendingDocumentCreate;
    reloadPending: boolean;
    requiredVersion: number;
    started: boolean;
    store: DocumentStore;
    subscribers: Set<DocumentSubscriber>;
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

interface WorkletsSubscriber extends RigWorkletsSubscriptionOptions {
    closed: boolean;
}

interface BufferedWorkletsEvent {
    cursor: string;
    data: Extract<GlobalEvent, { type: "worklets_changed" }>["data"];
}

interface WorkletsEntry {
    bootstrapVersion: number;
    bootstrapping: boolean;
    controller: AbortController;
    detachRoot: () => void;
    pending?: BufferedWorkletsEvent;
    started: boolean;
    store: WorkletStore;
    subscribers: Set<WorkletsSubscriber>;
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

function gitSecretForSessionCreate(
    groups: GroupEntry | undefined,
    input: CreateSessionInput,
): { kind: "github" } | undefined {
    const projects = groups?.store.projects() ?? [];
    const project =
        input.projectId !== undefined
            ? projects.find((candidate) => candidate.id === input.projectId)
            : input.workspaceId !== undefined
              ? projects.find((candidate) =>
                    candidate.workspaces.some((workspace) => workspace.id === input.workspaceId),
                )
              : projects.find(
                    (candidate) =>
                        candidate.path === input.cwd ||
                        candidate.workspaces.some((workspace) => workspace.path === input.cwd),
                );
    return project?.requiredSecretKind === "github" ? { kind: "github" } : undefined;
}

function profileIdForSessionCreate(
    groups: GroupEntry | undefined,
    input: CreateSessionInput,
): string | undefined {
    const projects = groups?.store.projects() ?? [];
    const project =
        input.projectId !== undefined
            ? projects.find((candidate) => candidate.id === input.projectId)
            : input.workspaceId !== undefined
              ? projects.find((candidate) =>
                    candidate.workspaces.some((workspace) => workspace.id === input.workspaceId),
                )
              : projects.find(
                    (candidate) =>
                        candidate.path === input.cwd ||
                        candidate.workspaces.some((workspace) => workspace.path === input.cwd),
                );
    return project?.createdBy?.profileId;
}

function gitSecretForSession(
    groups: GroupEntry | undefined,
    sessionId: string,
): { kind: "github" } | undefined {
    const project = groups?.store
        .projects()
        .find(
            (candidate) =>
                candidate.sessions.some((session) => session.id === sessionId) ||
                candidate.workspaces.some((workspace) =>
                    workspace.sessions.some((session) => session.id === sessionId),
                ),
        );
    return project?.requiredSecretKind === "github" ? { kind: "github" } : undefined;
}

function profileIdForSession(
    groups: GroupEntry | undefined,
    sessionId: string,
): string | undefined {
    for (const project of groups?.store.projects() ?? []) {
        const direct = project.sessions.find((session) => session.id === sessionId);
        if (direct !== undefined) return direct.profileId;
        for (const workspace of project.workspaces) {
            const nested = workspace.sessions.find((session) => session.id === sessionId);
            if (nested !== undefined) return nested.profileId;
        }
    }
    return undefined;
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

interface ProfilesSubscriber extends RigProfilesSubscriptionOptions {
    closed: boolean;
}

interface ProfilesEntry {
    controller: AbortController;
    detachRoot: () => void;
    lastLoadError?: unknown;
    loaded: boolean;
    loading?: Promise<void>;
    profiles: readonly RigProfile[];
    recoveryScheduled: boolean;
    reloadPending: boolean;
    started: boolean;
    subscribers: Set<ProfilesSubscriber>;
}

interface SharingSubscriber extends RigSharingSubscriptionOptions {
    closed: boolean;
}

interface SharingEntry {
    controller: AbortController;
    detachRoot: () => void;
    lastLoadError?: unknown;
    loading?: Promise<void>;
    recoveryScheduled: boolean;
    reloadPending: boolean;
    snapshot?: SharingSnapshot;
    started: boolean;
    subscribers: Set<SharingSubscriber>;
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
    documentId?: string;
    entityKey: string;
    expectsWorkspaceResponse?: boolean;
    id: MutationId;
    matchesAuthoritative?: (data: unknown) => boolean;
    prepare: () => MutationRequest;
    reconcileEchoInPlace?: boolean;
    ready?: () => Promise<void>;
    rebaseOnConflict?: (data: unknown) => boolean;
    replacesTranscript?: boolean;
    relatedSessionIds?: ReadonlySet<string>;
    retryOnConflict?: boolean;
    sessionId?: string;
    undo: () => void;
    versionSessionId?: string;
}

interface ReconcileOutput {
    documentDeltas?: ReadonlyMap<string, readonly DocumentDelta[]>;
    folderDeltas?: readonly FolderDelta[];
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

interface DocumentCapture {
    document: Document | undefined;
    entry: DocumentEntry;
    state: DocumentState;
    updates: readonly DocumentUpdate[];
}

interface GitWatchEntity {
    projectId: string;
    workspaceId?: string;
}

/** Creates the one client a UI shares across its group and session views. */
export function connectRig(options: ConnectRigOptions): RigConnection {
    const request = options.fetch ?? globalThis.fetch;
    const usesPeerEndpoint = /\/p2p\/peers\/[^/]+\/api\/?$/u.test(
        new URL(options.endpoint).pathname,
    );
    const wait = options.wait ?? defaultWait;
    const now = options.now ?? Date.now;
    const nextMutationId = orderedUuidV7(now, options.randomValues);
    // What the client creates, the client names. The identity is a cuid2, the
    // same kind the daemon would have minted, and it doubles as the mutation
    // identity so one create is one entity however its echo arrives.
    const nextEntityId = createCuid2(now, options.randomValues);
    const rootController = new AbortController();
    const sessionEntries = new Map<string, SessionEntry>();
    const documentEntries = new Map<string, DocumentEntry>();
    const queues = new Map<string, PendingMutation[]>();
    const activeWorkers = new Set<string>();
    const pendingOverlays: PendingMutation[] = [];
    const pendingFolderCreates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    const pendingDocumentCreates = new Map<string, PendingDocumentCreate>();
    const knownSessionCursors = new Map<string, string>();
    const knownGroupVersions = new Map<string, number>();
    const presenceClosers = new Set<() => void>();
    let groupsEntry: GroupEntry | undefined;
    let groupCatalogMutationLoad: Promise<void> | undefined;
    let happyCloudEntry: HappyCloudEntry | undefined;
    let p2pEntry: P2pEntry | undefined;
    let profilesEntry: ProfilesEntry | undefined;
    let sharingEntry: SharingEntry | undefined;
    let inboxEntry: InboxEntry | undefined;
    let folderEntry: FolderEntry | undefined;
    let pluginsEntry: PluginsEntry | undefined;
    let workletsEntry: WorkletsEntry | undefined;
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

    const createFolderEntry = (): FolderEntry => {
        if (folderEntry !== undefined) return folderEntry;
        folderEntry = {
            folderBaselineApplied: false,
            hasFolderSnapshot: false,
            loadedRevision: 0,
            reloadGeneration: 0,
            requiredRevision: 0,
            store: new FolderStore(),
            subscribers: new Set(),
        };
        return folderEntry;
    };

    const createDocumentEntry = (documentId: string): DocumentEntry => {
        const known = documentEntries.get(documentId);
        if (known !== undefined) return known;
        const linked = linkedController(rootController.signal);
        const pendingCreate = pendingDocumentCreates.get(documentId);
        const entry: DocumentEntry = {
            bootstrapVersion: 0,
            controller: linked.controller,
            detachRoot: linked.detach,
            reloadPending: false,
            requiredVersion: 0,
            started: false,
            store: new DocumentStore(documentId),
            subscribers: new Set(),
            ...(pendingCreate === undefined ? {} : { pendingCreate }),
        };
        documentEntries.set(documentId, entry);
        const key = documentKey(documentId);
        if (pendingOverlays.some((mutation) => mutation.entityKey === key)) {
            reconcile([key], undefined, [], false, () => ({}));
        }
        return entry;
    };

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

    const publishProfiles = (entry: ProfilesEntry): void => {
        if (closed || !entry.loaded) return;
        for (const subscriber of [...entry.subscribers]) {
            if (!subscriber.closed) subscriber.onChange(entry.profiles);
        }
    };

    const publishSharing = (entry: SharingEntry): void => {
        if (closed || entry.snapshot === undefined) return;
        for (const subscriber of [...entry.subscribers]) {
            if (!subscriber.closed) subscriber.onChange(entry.snapshot);
        }
    };

    const applySharing = (entry: SharingEntry, snapshot: SharingSnapshot): void => {
        if (entry.snapshot !== undefined && entry.snapshot.version > snapshot.version) return;
        const changed =
            entry.snapshot === undefined ||
            entry.snapshot.version !== snapshot.version ||
            JSON.stringify(entry.snapshot) !== JSON.stringify(snapshot);
        entry.snapshot = snapshot;
        if (changed) publishSharing(entry);
    };

    const applyProfiles = (entry: ProfilesEntry, incoming: readonly RigProfile[]): boolean => {
        const wasLoaded = entry.loaded;
        const previous = new Map(entry.profiles.map((profile) => [profile.id, profile]));
        const nextById = new Map(previous);
        for (const profile of incoming) {
            const current = previous.get(profile.id);
            if (current === undefined || profile.version > current.version) {
                nextById.set(profile.id, profile);
            }
        }
        const next = [...nextById.values()].sort((first, second) =>
            first.id.localeCompare(second.id),
        );
        const changed =
            next.length !== entry.profiles.length ||
            next.some((profile, index) => profile !== entry.profiles[index]);
        entry.loaded = true;
        if (changed) entry.profiles = next;
        if (!wasLoaded || changed) publishProfiles(entry);
        for (const session of sessionEntries.values()) {
            publishSession(session, session.store.applyProfiles(entry.profiles));
        }
        return true;
    };

    const applyProfileMutation = (entry: ProfilesEntry, profile: RigProfile): void => {
        const current = entry.profiles.find((candidate) => candidate.id === profile.id);
        if (current !== undefined && current.version >= profile.version) return;
        entry.profiles = [
            ...entry.profiles.filter((candidate) => candidate.id !== profile.id),
            profile,
        ].sort((first, second) => first.id.localeCompare(second.id));
        if (!entry.loaded) return;
        publishProfiles(entry);
        for (const session of sessionEntries.values()) {
            publishSession(session, session.store.applyProfiles(entry.profiles));
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

    const publishFolders = (deltas: readonly FolderDelta[]): void => {
        if (closed || deltas.length === 0 || folderEntry === undefined) return;
        for (const subscriber of [...folderEntry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(folderEntry.store.view(), folderEntry.store.state());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const publishDocument = (entry: DocumentEntry, deltas: readonly DocumentDelta[]): void => {
        if (closed || deltas.length === 0) return;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.document(), entry.store.updates(), entry.store.state());
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

    const publishWorklets = (changed: boolean): void => {
        if (closed || !changed || workletsEntry === undefined) return;
        for (const subscriber of [...workletsEntry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(workletsEntry.store.worklets(), workletsEntry.store.state());
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
        for (const [documentId, deltas] of output.documentDeltas ?? []) {
            const entry = documentEntries.get(documentId);
            if (entry !== undefined) publishDocument(entry, deltas);
        }
        for (const [sessionId, deltas] of output.sessionDeltas ?? []) {
            const entry = sessionEntries.get(sessionId);
            if (entry !== undefined) publishSession(entry, deltas);
        }
        if (output.groupDeltas !== undefined && groupsEntry !== undefined) {
            publishGroups(groupsEntry, output.groupDeltas);
        }
        if (output.folderDeltas !== undefined) publishFolders(output.folderDeltas);
    };

    const acknowledge = (mutationId: string | undefined): void => {
        if (mutationId === undefined) return;
        const mutation = pendingOverlays.find((candidate) => candidate.id === mutationId);
        if (mutation === undefined) return;
        mutation.acknowledged = true;
        mutation.attemptController?.abort();
        const index = pendingOverlays.indexOf(mutation);
        if (index >= 0) pendingOverlays.splice(index, 1);
        if (mutation.action === "create_folder") {
            pendingFolderCreates.get(mutation.id)?.resolve();
            pendingFolderCreates.delete(mutation.id);
        }
        if (mutation.action === "create_document") {
            pendingDocumentCreates.get(mutation.id)?.settle(true);
            pendingDocumentCreates.delete(mutation.id);
        }
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
        const documentCaptures = new Map<string, DocumentCapture>();
        for (const [documentId, entry] of documentEntries) {
            if (!keys.has(documentKey(documentId))) continue;
            documentCaptures.set(documentId, {
                document: entry.store.document(),
                entry,
                state: entry.store.state(),
                updates: entry.store.updates(),
            });
        }
        const folderBefore = folderEntry?.store.view();

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
        for (const [documentId, capture] of documentCaptures) {
            const semantic: DocumentDelta[] = [
                ...(output.documentDeltas?.get(documentId) ?? []),
            ].filter(
                (delta) =>
                    delta.type !== "document_changed" &&
                    delta.type !== "document_state_changed" &&
                    delta.type !== "document_updates_changed",
            );
            const document = capture.entry.store.document();
            const state = capture.entry.store.state();
            const updates = capture.entry.store.updates();
            if (document !== capture.document) {
                semantic.unshift({
                    ...(document === undefined ? {} : { document }),
                    type: "document_changed",
                });
            }
            if (updates !== capture.updates) {
                semantic.push({ type: "document_updates_changed", updates });
            }
            if (state !== capture.state) {
                semantic.push({ state, type: "document_state_changed" });
            }
            publishDocument(capture.entry, semantic);
        }
        for (const [documentId, deltas] of output.documentDeltas ?? []) {
            if (documentCaptures.has(documentId)) continue;
            const entry = documentEntries.get(documentId);
            if (entry !== undefined) publishDocument(entry, deltas);
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
        if (folderEntry !== undefined && folderBefore !== undefined) {
            const semantic: FolderDelta[] = [...(output.folderDeltas ?? [])].filter(
                (delta) => delta.type !== "folders_changed",
            );
            const view = folderEntry.store.view();
            if (view !== folderBefore) semantic.unshift({ type: "folders_changed", view });
            publishFolders(semantic);
        } else if (output.folderDeltas !== undefined) {
            publishFolders(output.folderDeltas);
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
        if (mutation.documentId !== undefined) {
            let document: Document;
            try {
                document = Value.Decode(documentResponseSchema, data).document;
            } catch {
                return false;
            }
            const entry = documentEntries.get(mutation.documentId);
            if (entry === undefined) {
                acknowledge(mutation.id);
            } else {
                reconcile([mutation.entityKey], mutation.id, [], false, () => ({
                    documentDeltas: new Map([
                        [
                            mutation.documentId as string,
                            entry.store.applyAuthoritativeDocument(document),
                        ],
                    ]),
                }));
            }
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
            (sessionEntries.has(mutation.sessionId) ||
                groupsEntry !== undefined ||
                folderEntry !== undefined)
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
                    ...(folderEntry === undefined
                        ? {}
                        : { folderDeltas: folderEntry.store.apply(event) }),
                    ...(sessionEntries.has(mutation.sessionId as string)
                        ? {
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
                          }
                        : {}),
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
        if (mutation.documentId !== undefined) {
            const entry = documentEntries.get(mutation.documentId);
            if (entry === undefined) return {};
            try {
                const document = Value.Decode(documentResponseSchema, data).document;
                return {
                    documentDeltas: new Map([
                        [mutation.documentId, entry.store.applyAuthoritativeDocument(document)],
                    ]),
                };
            } catch {
                return {};
            }
        }
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
                ...(folderEntry === undefined
                    ? {}
                    : { folderDeltas: folderEntry.store.apply(event) }),
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
        for (const candidate of sameEntity) {
            for (const sessionId of candidate.relatedSessionIds ?? []) sessionIds.add(sessionId);
        }
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
        const documentEntry =
            mutation.documentId === undefined
                ? undefined
                : documentEntries.get(mutation.documentId);
        const documentCapture: DocumentCapture | undefined =
            documentEntry === undefined
                ? undefined
                : {
                      document: documentEntry.store.document(),
                      entry: documentEntry,
                      state: documentEntry.store.state(),
                      updates: documentEntry.store.updates(),
                  };
        const folderCapture = folderEntry?.store.view();
        for (const candidate of [...sameEntity].reverse()) candidate.undo();
        const index = pendingOverlays.indexOf(mutation);
        if (index >= 0) pendingOverlays.splice(index, 1);
        if (mutation.action === "create_folder") {
            pendingFolderCreates.get(mutation.id)?.resolve();
            pendingFolderCreates.delete(mutation.id);
        }
        if (mutation.action === "create_document") {
            pendingDocumentCreates.get(mutation.id)?.settle(false);
            pendingDocumentCreates.delete(mutation.id);
        }
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
        if (folderEntry !== undefined && folderCapture !== undefined) {
            const deltas: FolderDelta[] = [rejection];
            const view = folderEntry.store.view();
            if (view !== folderCapture) deltas.unshift({ type: "folders_changed", view });
            publishFolders(deltas);
        }
        if (documentCapture !== undefined) {
            const deltas: DocumentDelta[] = [rejection];
            const document = documentCapture.entry.store.document();
            const updates = documentCapture.entry.store.updates();
            const state = documentCapture.entry.store.state();
            if (document !== documentCapture.document) {
                deltas.unshift({
                    ...(document === undefined ? {} : { document }),
                    type: "document_changed",
                });
            }
            if (updates !== documentCapture.updates) {
                deltas.push({ type: "document_updates_changed", updates });
            }
            if (state !== documentCapture.state) {
                deltas.push({ state, type: "document_state_changed" });
            }
            publishDocument(documentCapture.entry, deltas);
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
        ensureProfilesForSession(entry);
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

    const requestDocumentReload = (entry: DocumentEntry): Promise<void> => {
        if (entry.loading !== undefined) {
            entry.reloadPending = true;
            return entry.loading;
        }
        const documentId = entry.store.documentId();
        if (documentId === undefined) {
            return Promise.reject(new Error("A document identity is required."));
        }
        const version = ++entry.bootstrapVersion;
        entry.loading = (async () => {
            const pendingCreate = entry.pendingCreate;
            if (pendingCreate !== undefined) {
                const committed = await pendingCreate.promise;
                if (entry.pendingCreate === pendingCreate) delete entry.pendingCreate;
                if (!committed) {
                    throw new Error("Rig could not create that document.");
                }
            }
            do {
                entry.reloadPending = false;
                const response = await request(
                    endpointUrl(options.endpoint, `documents/${encodeURIComponent(documentId)}`),
                    {
                        headers: {
                            accept: "application/json",
                            authorization: `Bearer ${options.token}`,
                        },
                        signal: entry.controller.signal,
                    },
                );
                const data = await readResponseBody(response);
                if (!response.ok) {
                    throw new MutationHttpError(
                        response.status,
                        humanMutationError(data, response.status),
                        retryAfterMilliseconds(response.headers.get("retry-after"), now()),
                        data,
                    );
                }
                const document = Value.Decode(documentResponseSchema, data).document;
                if (document.id !== documentId) {
                    throw new Error("Rig returned a different document than the one requested.");
                }
                if (version !== entry.bootstrapVersion || entry.controller.signal.aborted) return;
                if (document.version < entry.requiredVersion) {
                    entry.reloadPending = true;
                    await wait(
                        options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS,
                        entry.controller.signal,
                    );
                    continue;
                }
                reconcile([documentKey(documentId)], undefined, [], false, () => ({
                    documentDeltas: new Map([
                        [
                            documentId,
                            [
                                ...entry.store.setConnection("live"),
                                ...entry.store.applyAuthoritativeDocument(document),
                            ],
                        ],
                    ]),
                }));
            } while (entry.reloadPending && !entry.controller.signal.aborted);
        })()
            .catch((error: unknown) => {
                if (closed || entry.controller.signal.aborted) return;
                publishDocument(entry, entry.store.setConnection("closed"));
                for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
            })
            .finally(() => {
                if (documentEntries.get(documentId) === entry) delete entry.loading;
                releaseUnusedEntries();
            });
        return entry.loading;
    };

    const startDocumentEntry = (entry: DocumentEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (liveStreamOpen) void requestDocumentReload(entry);
    };

    const requestFolderReload = (entry: FolderEntry): Promise<void> => {
        if (entry.loading !== undefined) return entry.loading;
        const generation = entry.reloadGeneration;
        entry.loading = (async () => {
            let retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
            do {
                try {
                    const response = await request(endpointUrl(options.endpoint, "folders"), {
                        headers: {
                            accept: "application/json",
                            authorization: `Bearer ${options.token}`,
                        },
                        signal: rootController.signal,
                    });
                    const data = await readResponseBody(response);
                    if (generation !== entry.reloadGeneration) return;
                    if (!response.ok) {
                        throw new MutationHttpError(
                            response.status,
                            humanMutationError(data, response.status),
                            retryAfterMilliseconds(response.headers.get("retry-after"), now()),
                            data,
                        );
                    }
                    const snapshot = Value.Decode(listFoldersResponseSchema, data);
                    const minimumRevision = Math.max(entry.loadedRevision, entry.requiredRevision);
                    // A request already in flight can predate a later invalidation. Keep the
                    // applied tree until a response includes that revision, or this stale
                    // snapshot would publish a false removal before the loop refetches.
                    if (!entry.folderBaselineApplied || snapshot.revision >= minimumRevision) {
                        entry.folderBaselineApplied = true;
                        entry.hasFolderSnapshot = true;
                        entry.loadedRevision = snapshot.revision;
                        reconcile(["folder-tree"], undefined, [], false, () => ({
                            folderDeltas: entry.store.replaceFolders(
                                snapshot.folders,
                                snapshot.items,
                            ),
                        }));
                    }
                    retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                } catch (error) {
                    if (generation !== entry.reloadGeneration) return;
                    if (!isRetryableMutationError(error)) throw error;
                    const delay =
                        error instanceof MutationHttpError && error.retryAfterMs !== undefined
                            ? Math.min(MAXIMUM_MUTATION_RETRY_MS, error.retryAfterMs)
                            : retryDelay;
                    await wait(delay, rootController.signal);
                    retryDelay = Math.min(MAXIMUM_MUTATION_RETRY_MS, retryDelay * 2);
                }
            } while (
                !closed &&
                folderEntry === entry &&
                generation === entry.reloadGeneration &&
                entry.loadedRevision < entry.requiredRevision
            );
        })()
            .catch((error: unknown) => {
                if (closed || folderEntry !== entry) return;
                publishFolders(entry.store.setConnection("closed"));
                for (const subscriber of entry.subscribers) subscriber.onError?.(error);
            })
            .finally(() => {
                if (folderEntry === entry) delete entry.loading;
                releaseUnusedEntries();
            });
        return entry.loading;
    };

    const requestFolderReloadAfterCurrent = async (entry: FolderEntry): Promise<void> => {
        await entry.loading;
        if (closed || folderEntry !== entry) return;
        await requestFolderReload(entry);
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
            () => {
                const groupDeltas = [
                    ...entry.store.setConnection("live"),
                    ...entry.store.applyHello(hello),
                ];
                const sessions = entry.store.sessionSummaries();
                let folderDeltas: readonly FolderDelta[] | undefined;
                if (folderEntry !== undefined) {
                    const folderHelloApplies = !folderEntry.hasFolderSnapshot;
                    if (folderHelloApplies) folderEntry.folderBaselineApplied = true;
                    folderDeltas = [
                        ...folderEntry.store.setConnection("live"),
                        ...(folderHelloApplies
                            ? folderEntry.store.applyHello({ ...hello, sessions })
                            : folderEntry.store.applyCatalogSessions(sessions)),
                    ];
                }
                return {
                    groupDeltas,
                    ...(folderDeltas === undefined ? {} : { folderDeltas }),
                };
            },
        );
        if (inboxEntry !== undefined) {
            publishInbox([
                ...inboxEntry.store.setConnection("live"),
                ...inboxEntry.store.applyHello(hello),
            ]);
        }
        if (folderEntry !== undefined) {
            if (folderEntry.loadedRevision < folderEntry.requiredRevision) {
                void requestFolderReload(folderEntry);
            }
        }
        queueGitWatchSync();
    };

    const ensureGroupCatalogForMutation = (): Promise<void> => {
        const entry = createGroupEntry();
        if (entry.store.state().connection === "live") return Promise.resolve();
        groupCatalogMutationLoad ??= loadCatalog(entry).finally(() => {
            groupCatalogMutationLoad = undefined;
        });
        return groupCatalogMutationLoad;
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
        if (folderEntry !== undefined) {
            publishFolders(folderEntry.store.setConnection("closed"));
            for (const subscriber of [...folderEntry.subscribers]) {
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

    const createWorkletsEntry = (): WorkletsEntry => {
        if (workletsEntry !== undefined) return workletsEntry;
        const linked = linkedController(rootController.signal);
        const entry: WorkletsEntry = {
            bootstrapVersion: 0,
            bootstrapping: false,
            controller: linked.controller,
            detachRoot: linked.detach,
            started: false,
            store: new WorkletStore(),
            subscribers: new Set(),
        };
        workletsEntry = entry;
        return entry;
    };

    const loadWorklets = async (entry: WorkletsEntry): Promise<void> => {
        const version = ++entry.bootstrapVersion;
        entry.bootstrapping = true;
        let snapshot: ListWorkletsResponse;
        try {
            snapshot = await fetchWorkletCatalog(
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
        // Both readings say which change they reflect, so the newer one wins outright.
        const catalog =
            pending !== undefined && pending.data.version > snapshot.version
                ? pending.data
                : snapshot;
        publishWorklets(entry.store.replace(catalog.worklets, "live"));
    };

    const startWorkletsEntry = (entry: WorkletsEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        void loadWorklets(entry).catch((error: unknown) => {
            if (closed || entry.controller.signal.aborted) return;
            publishWorklets(entry.store.setConnection("closed"));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        });
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
                    if (profilesEntry !== undefined && profilesEntry.started) {
                        void loadProfiles(profilesEntry);
                    }
                    if (sharingEntry !== undefined && sharingEntry.started) {
                        void loadSharing(sharingEntry);
                    }
                    if (groupsEntry !== undefined) {
                        publishGroups(groupsEntry, groupsEntry.store.setConnection("live"));
                    }
                    if (inboxEntry !== undefined) {
                        publishInbox(inboxEntry.store.setConnection("live"));
                    }
                    if (folderEntry !== undefined) {
                        publishFolders(folderEntry.store.setConnection("live"));
                    }
                    for (const entry of documentEntries.values()) {
                        if (entry.started) {
                            publishDocument(entry, entry.store.setConnection("live"));
                        }
                    }
                    if (pluginsEntry !== undefined) {
                        publishPlugins(pluginsEntry.store.setConnection("live"));
                    }
                    if (workletsEntry !== undefined) {
                        publishWorklets(workletsEntry.store.setConnection("live"));
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
                if (profilesEntry !== undefined && profilesEntry.started) {
                    void loadProfiles(profilesEntry);
                }
                if (sharingEntry !== undefined && sharingEntry.started) {
                    void loadSharing(sharingEntry);
                }
                for (const entry of documentEntries.values()) {
                    if (entry.started) void requestDocumentReload(entry);
                }
                if (hello.gap && folderEntry !== undefined) {
                    folderEntry.reloadGeneration += 1;
                    void requestFolderReloadAfterCurrent(folderEntry);
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
                const worklets = workletsEntry;
                if (worklets !== undefined && worklets.started) {
                    void loadWorklets(worklets).catch((error: unknown) => {
                        if (closed || worklets.controller.signal.aborted) return;
                        publishWorklets(worklets.store.setConnection("closed"));
                        for (const subscriber of [...worklets.subscribers]) {
                            subscriber.onError?.(error);
                        }
                    });
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
                if (event.type === "profile_changed") {
                    const entry = profilesEntry;
                    if (entry === undefined || !entry.started) return;
                    try {
                        Value.Decode(rigProfileChangedEventSchema, event);
                    } catch {
                        for (const subscriber of [...entry.subscribers]) {
                            subscriber.onError?.(
                                new Error("Rig sent an invalid human profile update."),
                            );
                        }
                        return;
                    }
                    void loadProfiles(entry);
                    return;
                }
                if (event.type === "sharing_changed") {
                    const entry = sharingEntry;
                    if (entry === undefined || !entry.started) return;
                    try {
                        Value.Decode(sharingChangedEventSchema, event);
                    } catch {
                        for (const subscriber of [...entry.subscribers]) {
                            subscriber.onError?.(new Error("Rig sent an invalid Sharing update."));
                        }
                        return;
                    }
                    void loadSharing(entry);
                    return;
                }
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
                if (event.type === "folders_changed") {
                    const entry = folderEntry;
                    if (entry === undefined) return;
                    const changed = event.data as {
                        mutationId?: string;
                        revision: number;
                    };
                    entry.requiredRevision = Math.max(entry.requiredRevision, changed.revision);
                    acknowledge(changed.mutationId);
                    void requestFolderReload(entry);
                    return;
                }
                if (event.type === "document_changed") {
                    let changed: Static<typeof documentEventSchema>;
                    try {
                        changed = Value.Decode(documentEventSchema, event);
                    } catch {
                        const error = new Error("Rig sent an invalid document update.");
                        for (const entry of documentEntries.values()) {
                            for (const subscriber of [...entry.subscribers]) {
                                subscriber.onError?.(error);
                            }
                        }
                        return;
                    }
                    const entry = documentEntries.get(changed.data.documentId);
                    if (entry !== undefined) {
                        entry.requiredVersion = Math.max(
                            entry.requiredVersion,
                            changed.data.version,
                        );
                        publishDocument(entry, entry.store.apply(changed));
                    }
                    acknowledge(changed.data.mutationId);
                    if (entry !== undefined) void requestDocumentReload(entry);
                    releaseUnusedEntries();
                    return;
                }
                if (event.type === "worklets_changed") {
                    const entry = workletsEntry;
                    if (entry === undefined || !entry.started) return;
                    const update = {
                        cursor,
                        data: (event as Extract<GlobalEvent, { type: "worklets_changed" }>).data,
                    };
                    if (entry.bootstrapping) {
                        if (entry.pending === undefined || cursor > entry.pending.cursor) {
                            entry.pending = update;
                        }
                    } else {
                        publishWorklets(entry.store.replace(update.data.worklets, "live"));
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
                            : { groupDeltas: groupsEntry.store.apply(event, cursor) }),
                        ...(folderEntry === undefined
                            ? {}
                            : { folderDeltas: folderEntry.store.apply(event) }),
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
                if (session !== undefined) ensureProfilesForSession(session);
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
                if (folderEntry !== undefined) {
                    publishFolders(folderEntry.store.setConnection("reconnecting"));
                }
                for (const entry of documentEntries.values()) {
                    if (entry.started) {
                        publishDocument(entry, entry.store.setConnection("reconnecting"));
                    }
                }
                if (pluginsEntry !== undefined) {
                    publishPlugins(pluginsEntry.store.setConnection("reconnecting"));
                }
                if (workletsEntry !== undefined) {
                    publishWorklets(workletsEntry.store.setConnection("reconnecting"));
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
                if (workletsEntry !== undefined) {
                    publishWorklets(workletsEntry.store.setConnection("closed"));
                    for (const subscriber of [...workletsEntry.subscribers]) {
                        subscriber.onError?.(error);
                    }
                }
                for (const entry of documentEntries.values()) {
                    publishDocument(entry, entry.store.setConnection("closed"));
                    for (const subscriber of [...entry.subscribers]) {
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
                if (workletsEntry !== undefined) {
                    publishWorklets(workletsEntry.store.setConnection("closed"));
                }
                for (const entry of documentEntries.values()) {
                    publishDocument(entry, entry.store.setConnection("closed"));
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
            reason: unread.reason,
            scope: summary.scope,
            sessionId,
            since: unread.since,
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
            return session.scope.kind === "project"
                ? scope.workspaceId === undefined && session.scope.projectId === scope.projectId
                : session.scope.kind === "workspace" &&
                      session.scope.projectId === scope.projectId &&
                      session.scope.workspaceId === scope.workspaceId;
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
            if (session.scope.kind === "project") add({ projectId: session.scope.projectId });
            if (session.scope.kind === "workspace") {
                add({
                    projectId: session.scope.projectId,
                    workspaceId: session.scope.workspaceId,
                });
            }
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
        for (const [documentId, entry] of documentEntries) {
            const key = documentKey(documentId);
            if (
                entry.subscribers.size > 0 ||
                pendingOverlays.some((mutation) => mutation.entityKey === key) ||
                (queues.get(key)?.length ?? 0) > 0
            ) {
                continue;
            }
            entry.controller.abort();
            entry.detachRoot();
            documentEntries.delete(documentId);
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
            profilesEntry !== undefined &&
            profilesEntry.subscribers.size === 0 &&
            sessionEntries.size === 0
        ) {
            profilesEntry.controller.abort();
            profilesEntry.detachRoot();
            profilesEntry = undefined;
        }
        if (sharingEntry !== undefined && sharingEntry.subscribers.size === 0) {
            sharingEntry.controller.abort();
            sharingEntry.detachRoot();
            sharingEntry = undefined;
        }
        if (
            groupsEntry !== undefined &&
            groupsEntry.subscribers.size === 0 &&
            // Finish notifications are answered from the catalog, which is where
            // the chat's project and whether it is tracked at all are known, so
            // asking for them keeps it loaded with no view open.
            options.onSessionFinished === undefined &&
            inboxEntry === undefined &&
            // Session-only clients still need project ownership and credential requirements for
            // deterministic remote sends, including the first message after a daemon restart.
            sessionEntries.size === 0 &&
            // The folder tree arrives in the same opening catalog, so a folder view keeps it
            // loaded exactly as an inbox view does.
            folderEntry === undefined &&
            pendingOverlays.length === 0 &&
            queues.size === 0
        ) {
            groupsEntry.controller.abort();
            groupsEntry.detachRoot();
            groupsEntry = undefined;
        }
        if (
            folderEntry !== undefined &&
            folderEntry.subscribers.size === 0 &&
            folderEntry.loading === undefined &&
            !pendingOverlays.some((mutation) => mutation.entityKey === "folder-tree") &&
            (queues.get("folder-tree")?.length ?? 0) === 0
        ) {
            folderEntry = undefined;
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
                    const deltas = [...entry.store.prependEarlier(page, started.anchor)];
                    const profiles = profilesEntry;
                    if (profiles?.loaded === true) {
                        deltas.push(...entry.store.applyProfiles(profiles.profiles));
                    }
                    publishSession(entry, deltas);
                    ensureProfilesForSession(entry);
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

    const connectFolders = (subscription: RigFoldersSubscriptionOptions): RigFoldersConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createFolderEntry();
        const subscriber: FolderSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.view(), entry.store.state());
        const groups = createGroupEntry();
        const alreadyLoaded = groups.started;
        startGroupEntry(groups);
        // The tree rides the opening catalog, so a folder view mounted after that catalog has
        // already loaded would have nothing to show until it is loaded again.
        if (alreadyLoaded && liveStreamOpen) {
            void loadCatalog(groups).catch((error: unknown) => reportCatalogError(groups, error));
        }
        return {
            view: () => folderEntry?.store.view() ?? { folders: [], unsorted: [] },
            state: () => folderEntry?.store.state() ?? { connection: "closed" },
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const connectDocument = (
        subscription: RigDocumentSubscriptionOptions,
    ): RigDocumentConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createDocumentEntry(subscription.documentId);
        const subscriber: DocumentSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.document(), entry.store.updates(), entry.store.state());
        startDocumentEntry(entry);
        return {
            document: () => entry.store.document(),
            updates: () => entry.store.updates(),
            state: () => entry.store.state(),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
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

    const connectWorklets = (
        subscription: RigWorkletsSubscriptionOptions,
    ): RigWorkletsConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createWorkletsEntry();
        const subscriber: WorkletsSubscriber = { ...subscription, closed: false };
        const calls = linkedController(entry.controller.signal);
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.worklets(), entry.store.state());
        startWorkletsEntry(entry);

        const call = async <TSchema_ extends ReturnType<typeof Type.Object>>(
            path: string,
            method: "DELETE" | "GET" | "POST",
            body: unknown,
            schema: TSchema_,
            signal?: AbortSignal,
        ): Promise<Static<TSchema_>> => {
            if (subscriber.closed) throw new Error("This worklet connection is closed.");
            const requestSignal = combinedSignal(calls.controller.signal, signal);
            try {
                const response = await request(endpointUrl(options.endpoint, path), {
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${options.token}`,
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    method,
                    signal: requestSignal.signal,
                });
                const payload: unknown = await response.json().catch(() => undefined);
                if (!response.ok) throw workletManagementError(response.status, payload);
                try {
                    return Value.Decode(schema, payload);
                } catch {
                    throw new WorkletManagementRequestError(
                        "invalid_response",
                        response.status,
                        "Rig answered a worklet request with something this client could not read.",
                    );
                }
            } finally {
                requestSignal.detach();
            }
        };

        return {
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                calls.controller.abort();
                calls.detach();
                if (entry.subscribers.size === 0 && workletsEntry === entry) {
                    entry.controller.abort();
                    entry.detachRoot();
                    workletsEntry = undefined;
                }
            },
            install: async (input, callOptions = {}) =>
                projectWorklet(
                    (
                        await call(
                            "worklets",
                            "POST",
                            input,
                            workletResponseSchema,
                            callOptions.signal,
                        )
                    ).worklet,
                ),
            readLog: async (name, callOptions = {}) =>
                call(
                    `worklets/${encodeURIComponent(name)}/log`,
                    "GET",
                    undefined,
                    workletLogResponseSchema,
                    callOptions.signal,
                ),
            revert: async (name, version, callOptions = {}) =>
                projectWorklet(
                    (
                        await call(
                            `worklets/${encodeURIComponent(name)}/revert`,
                            "POST",
                            { version },
                            workletResponseSchema,
                            callOptions.signal,
                        )
                    ).worklet,
                ),
            state: () => entry.store.state(),
            uninstall: async (name, callOptions = {}) => {
                await call(
                    `worklets/${encodeURIComponent(name)}`,
                    "DELETE",
                    undefined,
                    emptyResponseSchema,
                    callOptions.signal,
                );
            },
            update: async (name, input, callOptions = {}) =>
                projectWorklet(
                    (
                        await call(
                            `worklets/${encodeURIComponent(name)}/versions`,
                            "POST",
                            input,
                            workletResponseSchema,
                            callOptions.signal,
                        )
                    ).worklet,
                ),
            worklets: () => entry.store.worklets(),
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

    const projects: RigProjects = {
        clone: (input) => {
            const id = input.projectId ?? nextEntityId();
            const createdAt = now();
            const target: GroupTarget = { kind: "project", projectId: id };
            const optimistic: Project = {
                createdAt,
                id,
                initializationAttempt: 0,
                initializationStatus: "initializing",
                kind: "regular",
                name: input.name,
                nameSource: "user",
                orderKey: "",
                path: "",
                presence: "missing",
                remoteSource: input.source,
                ...(input.secret === undefined ? {} : { requiredSecretKind: input.secret.kind }),
                settings: {},
                storageKey: "",
                updatedAt: createdAt,
                version: 0,
                worktreeSupport: "unknown",
            };
            return enqueue({
                acknowledged: false,
                action: "create_project",
                applyOptimistic: (publish) => {
                    if (groupsEntry === undefined) return () => undefined;
                    const changed = groupsEntry.store.applyOptimisticProjectCreate(optimistic);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                    return changed.undo;
                },
                entityKey: groupKey(target),
                id,
                matchesAuthoritative: (data) => responseEntity(data, "project")?.id === id,
                prepare: () => ({
                    body: {
                        identity: input.identity,
                        name: input.name,
                        projectId: id,
                        ...(input.secret === undefined ? {} : { secret: input.secret }),
                        source: input.source,
                    },
                    headers: { "x-rig-mutation-id": id },
                    method: "POST",
                    url: endpointUrl(options.endpoint, "projects/clone"),
                }),
                undo: () => undefined,
            });
        },
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

    const enqueueFolderMutation = (
        action: Extract<
            MutationAction,
            "archive_folder" | "create_folder" | "move_folder" | "update_folder"
        >,
        id: MutationId,
        applyOptimistic: PendingMutation["applyOptimistic"],
        prepare: PendingMutation["prepare"],
        relatedSessionIds?: ReadonlySet<string>,
    ): MutationId => {
        const entry = createFolderEntry();
        return enqueue({
            acknowledged: false,
            action,
            applyAcceptedResponse: (data) => {
                let response;
                try {
                    response = Value.Decode(folderResponseSchema, data);
                } catch {
                    return false;
                }
                const entry = folderEntry;
                acknowledge(id);
                if (entry !== undefined) {
                    entry.requiredRevision = Math.max(entry.requiredRevision, response.revision);
                    void requestFolderReload(entry);
                }
                return true;
            },
            applyOptimistic,
            entityKey: "folder-tree",
            id,
            matchesAuthoritative: (data) => {
                if (action !== "create_folder") return false;
                try {
                    return Value.Decode(folderResponseSchema, data).folder.id === id;
                } catch {
                    return false;
                }
            },
            prepare,
            ...(relatedSessionIds === undefined ? {} : { relatedSessionIds }),
            ready: async () => {
                if (action === "create_folder") {
                    await entry.loading;
                    return;
                }
                if (!entry.hasFolderSnapshot && entry.loading === undefined) {
                    await requestFolderReload(entry);
                } else {
                    await entry.loading;
                }
                if (!entry.hasFolderSnapshot) {
                    throw new Error("Rig could not load the folder catalog.");
                }
            },
            rebaseOnConflict: (data) => {
                let response;
                try {
                    response = Value.Decode(folderResponseSchema, data);
                } catch {
                    return false;
                }
                const entry = folderEntry;
                if (entry === undefined) return false;
                entry.requiredRevision = Math.max(entry.requiredRevision, response.revision);
                reconcile(["folder-tree"], undefined, [], false, () => ({
                    folderDeltas: entry.store.applyFolder(response.folder),
                }));
                return true;
            },
            undo: () => undefined,
        });
    };

    const enqueueFolderItemMutation = (
        action: Extract<
            MutationAction,
            "link_folder_item" | "move_folder_item" | "unlink_folder_item"
        >,
        id: MutationId,
        applyOptimistic: PendingMutation["applyOptimistic"],
        prepare: PendingMutation["prepare"],
        pendingDocumentCreate?: PendingDocumentCreate,
    ): MutationId => {
        const entry = createFolderEntry();
        let conflictRebases = 0;
        return enqueue({
            acknowledged: false,
            action,
            applyAcceptedResponse: (data) => {
                let response: Static<typeof folderItemMutationResponseSchema>;
                try {
                    response = Value.Decode(folderItemMutationResponseSchema, data);
                } catch {
                    return false;
                }
                const current = folderEntry;
                if (current === undefined) {
                    acknowledge(id);
                    return true;
                }
                current.requiredRevision = Math.max(current.requiredRevision, response.revision);
                reconcile(["folder-tree"], id, [], false, () => ({
                    folderDeltas: current.store.applyItem(response.item),
                }));
                void requestFolderReload(current);
                return true;
            },
            applyOptimistic,
            entityKey: "folder-tree",
            id,
            prepare,
            ready: async () => {
                if (!entry.hasFolderSnapshot && entry.loading === undefined) {
                    await requestFolderReload(entry);
                } else {
                    await entry.loading;
                }
                if (!entry.hasFolderSnapshot) {
                    throw new Error("Rig could not load the folder catalog.");
                }
                if (pendingDocumentCreate !== undefined && !(await pendingDocumentCreate.promise)) {
                    throw new MutationHttpError(
                        409,
                        "Rig could not create that document.",
                        undefined,
                        undefined,
                    );
                }
            },
            rebaseOnConflict: (data) => {
                let response: Static<typeof folderItemMutationResponseSchema>;
                try {
                    response = Value.Decode(folderItemMutationResponseSchema, data);
                } catch {
                    return false;
                }
                const current = folderEntry;
                if (current === undefined || conflictRebases >= 8) return false;
                conflictRebases += 1;
                current.requiredRevision = Math.max(current.requiredRevision, response.revision);
                reconcile(["folder-tree"], undefined, [], false, () => ({
                    folderDeltas: current.store.applyItem(response.item),
                }));
                return true;
            },
            undo: () => undefined,
        });
    };

    const moveSession = (
        sessionId: string,
        request: Omit<MoveSessionRequest, "mutationId">,
    ): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const { afterId, scope } = request;
        return enqueue({
            acknowledged: false,
            action: "move_session",
            applyOptimistic: (publish) => {
                const orderKey =
                    folderEntry?.store.optimisticSessionOrderKey(scope, afterId) ?? "\uffff";
                const undos: (() => void)[] = [];
                const groupDeltas: GroupDelta[] = [];
                const folderDeltas: FolderDelta[] = [];
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        orderKey,
                        scope,
                    });
                    undos.push(changed.undo);
                    if (publish) groupDeltas.push(...changed.deltas);
                }
                if (folderEntry !== undefined) {
                    const changed = folderEntry.store.applyOptimisticSessionScope(
                        sessionId,
                        scope,
                        orderKey,
                    );
                    undos.push(changed.undo);
                    if (publish) folderDeltas.push(...changed.deltas);
                }
                if (publish && groupsEntry !== undefined) publishGroups(groupsEntry, groupDeltas);
                if (publish) publishFolders(folderDeltas);
                return () => {
                    for (const undo of undos.reverse()) undo();
                };
            },
            entityKey: key,
            id,
            rebaseOnConflict: (data) => {
                const session = responseEntity(data, "session");
                if (!isProtocolSessionResponse(session)) return false;
                const event: SessionEvent = {
                    createdAt: now(),
                    data: { session },
                    id: session.lastEventId ?? id,
                    sessionId,
                    type: "session_updated",
                };
                reconcile([key], undefined, [sessionId], true, () => ({
                    ...(groupsEntry === undefined
                        ? {}
                        : { groupDeltas: groupsEntry.store.apply(event) }),
                    ...(folderEntry === undefined
                        ? {}
                        : { folderDeltas: folderEntry.store.apply(event) }),
                }));
                return true;
            },
            prepare: () => ({
                body: { afterId, mutationId: id, scope },
                headers: {
                    ...ifMatchHeader(currentSessionCursor(sessionId)),
                    "x-rig-mutation-id": id,
                },
                method: "PUT",
                url: endpointUrl(
                    options.endpoint,
                    `sessions/${encodeURIComponent(sessionId)}/scope`,
                ),
            }),
            ready: async () => {
                if (scope.kind !== "folder") return;
                const pending = pendingFolderCreates.get(scope.folderId);
                if (pending === undefined) return;
                await pending.promise;
                if (folderEntry?.store.folder(scope.folderId) === undefined) {
                    throw new Error("That folder no longer exists.");
                }
            },
            sessionId,
            undo: () => undefined,
            versionSessionId: sessionId,
        });
    };

    const folders: RigFolders = {
        create: (folderRequest, createOptions = {}) => {
            const id = createOptions.folderId ?? folderRequest.id ?? nextEntityId();
            let resolveFolderCreate!: () => void;
            const folderCreatePromise = new Promise<void>((resolve) => {
                resolveFolderCreate = resolve;
            });
            pendingFolderCreates.set(id, {
                promise: folderCreatePromise,
                resolve: resolveFolderCreate,
            });
            const createdAt = now();
            const optimistic: Folder = {
                createdAt,
                id,
                name: folderRequest.name.trim(),
                orderKey: "\uffff",
                path: "",
                shared: false,
                updatedAt: createdAt,
                version: 0,
                ...(folderRequest.description === undefined
                    ? {}
                    : { description: folderRequest.description }),
                ...(folderRequest.icon === undefined ? {} : { icon: folderRequest.icon }),
                ...(folderRequest.parentId === undefined
                    ? {}
                    : { parentId: folderRequest.parentId }),
                ...(folderRequest.rules === undefined ? {} : { rules: folderRequest.rules }),
            };
            return enqueueFolderMutation(
                "create_folder",
                id,
                (publish) => {
                    if (folderEntry === undefined) return () => undefined;
                    folderEntry.folderBaselineApplied = true;
                    const changed = folderEntry.store.applyOptimisticFolder(optimistic);
                    if (publish) publishFolders(changed.deltas);
                    return changed.undo;
                },
                () => ({
                    body: { ...folderRequest, id, mutationId: id },
                    headers: { "x-rig-mutation-id": id },
                    method: "POST",
                    url: endpointUrl(options.endpoint, "folders"),
                }),
            );
        },
        update: (folderId, folderRequest) => {
            const id = nextMutationId();
            return enqueueFolderMutation(
                "update_folder",
                id,
                (publish) => {
                    if (folderEntry === undefined) return () => undefined;
                    const patch: Partial<Folder> = {
                        ...(folderRequest.name === undefined ? {} : { name: folderRequest.name }),
                    };
                    if (typeof folderRequest.description === "string") {
                        patch.description = folderRequest.description;
                    }
                    if (typeof folderRequest.icon === "string") patch.icon = folderRequest.icon;
                    if (typeof folderRequest.rules === "string") patch.rules = folderRequest.rules;
                    const changed = folderEntry.store.applyOptimisticFolderPatch(folderId, patch, [
                        ...(folderRequest.description === null ? (["description"] as const) : []),
                        ...(folderRequest.icon === null ? (["icon"] as const) : []),
                        ...(folderRequest.rules === null ? (["rules"] as const) : []),
                    ]);
                    if (publish) publishFolders(changed.deltas);
                    return changed.undo;
                },
                () => ({
                    body: { ...folderRequest, mutationId: id },
                    headers: {
                        ...ifMatchHeader(requiredFolderVersion(folderEntry, folderId)),
                        "x-rig-mutation-id": id,
                    },
                    method: "PATCH",
                    url: endpointUrl(options.endpoint, `folders/${encodeURIComponent(folderId)}`),
                }),
            );
        },
        move: (folderId, folderRequest) => {
            const id = nextMutationId();
            return enqueueFolderMutation(
                "move_folder",
                id,
                (publish) => {
                    if (folderEntry === undefined) return () => undefined;
                    const changed = folderEntry.store.applyOptimisticMove(
                        folderId,
                        folderRequest.parentId,
                        folderRequest.afterId,
                    );
                    if (publish) publishFolders(changed.deltas);
                    return changed.undo;
                },
                () => ({
                    body: { ...folderRequest, mutationId: id },
                    headers: {
                        ...ifMatchHeader(requiredFolderVersion(folderEntry, folderId)),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `folders/${encodeURIComponent(folderId)}/move`,
                    ),
                }),
            );
        },
        archive: (folderId) => {
            const id = nextMutationId();
            const relatedSessionIds = new Set<string>();
            return enqueueFolderMutation(
                "archive_folder",
                id,
                (publish) => {
                    if (folderEntry === undefined) return () => undefined;
                    const changed = folderEntry.store.applyOptimisticArchive(folderId, now());
                    for (const sessionId of changed.sessionIds) {
                        relatedSessionIds.add(sessionId);
                    }
                    const folderIds = new Set(changed.folderIds);
                    for (const session of groupsEntry?.store.sessionSummaries() ?? []) {
                        if (
                            session.scope.kind === "folder" &&
                            folderIds.has(session.scope.folderId)
                        ) {
                            relatedSessionIds.add(session.id);
                        }
                    }
                    for (const [sessionId, entry] of sessionEntries) {
                        const scope = entry.store.session().scope;
                        if (scope.kind === "folder" && folderIds.has(scope.folderId)) {
                            relatedSessionIds.add(sessionId);
                        }
                    }
                    const undos: (() => void)[] = [changed.undo];
                    const sessionChanges: {
                        deltas: readonly ChatDelta[];
                        entry: SessionEntry;
                    }[] = [];
                    if (groupsEntry !== undefined) {
                        for (const sessionId of relatedSessionIds) {
                            const groupChange = groupsEntry.store.applyOptimisticSessionArchived(
                                sessionId,
                                true,
                            );
                            undos.push(groupChange.undo);
                        }
                    }
                    for (const sessionId of relatedSessionIds) {
                        const entry = sessionEntries.get(sessionId);
                        if (entry === undefined) continue;
                        const sessionChange = entry.store.applyOptimisticSession({
                            archived: true,
                        });
                        undos.push(sessionChange.undo);
                        sessionChanges.push({ deltas: sessionChange.deltas, entry });
                    }
                    if (publish) {
                        for (const sessionChange of sessionChanges) {
                            publishSession(sessionChange.entry, sessionChange.deltas);
                        }
                        publishFolders(changed.deltas);
                    }
                    return () => {
                        for (const undo of undos.reverse()) undo();
                    };
                },
                () => ({
                    headers: {
                        ...ifMatchHeader(requiredFolderVersion(folderEntry, folderId)),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `folders/${encodeURIComponent(folderId)}/archive`,
                    ),
                }),
                relatedSessionIds,
            );
        },
        linkItem: (folderId, itemRequest, linkOptions = {}) => {
            const id = linkOptions.itemId ?? itemRequest.id ?? nextEntityId();
            const createdAt = now();
            const pendingDocumentCreate =
                itemRequest.target.kind === "document"
                    ? pendingDocumentCreates.get(itemRequest.target.documentId)
                    : undefined;
            return enqueueFolderItemMutation(
                "link_folder_item",
                id,
                (publish) => {
                    if (folderEntry === undefined) return () => undefined;
                    const optimistic: FolderItem = {
                        createdAt,
                        folderId,
                        id,
                        orderKey: folderEntry.store.optimisticItemOrderKey(
                            folderId,
                            itemRequest.afterId,
                        ),
                        target: itemRequest.target,
                        updatedAt: createdAt,
                        version: 0,
                    };
                    const changed = folderEntry.store.applyOptimisticItemCreate(optimistic);
                    if (publish) publishFolders(changed.deltas);
                    return changed.undo;
                },
                () => ({
                    body: { ...itemRequest, id, mutationId: id },
                    headers: { "x-rig-mutation-id": id },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `folders/${encodeURIComponent(folderId)}/items`,
                    ),
                }),
                pendingDocumentCreate,
            );
        },
        moveItem: (itemId, itemRequest) => {
            const id = nextMutationId();
            return enqueueFolderItemMutation(
                "move_folder_item",
                id,
                (publish) => {
                    if (folderEntry === undefined) return () => undefined;
                    const changed = folderEntry.store.applyOptimisticItemMove(
                        itemId,
                        itemRequest.folderId,
                        itemRequest.afterId,
                    );
                    if (publish) publishFolders(changed.deltas);
                    return changed.undo;
                },
                () => ({
                    body: { ...itemRequest, mutationId: id },
                    headers: {
                        ...ifMatchHeader(requiredFolderItemVersion(folderEntry, itemId)),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `folder-items/${encodeURIComponent(itemId)}/move`,
                    ),
                }),
            );
        },
        moveSession,
        setSessionFolder: (sessionId, folderId) =>
            moveSession(sessionId, {
                afterId: null,
                scope: folderId === null ? { kind: "unsorted" } : { folderId, kind: "folder" },
            }),
        unlinkItem: (itemId) => {
            const id = nextMutationId();
            return enqueueFolderItemMutation(
                "unlink_folder_item",
                id,
                (publish) => {
                    if (folderEntry === undefined) return () => undefined;
                    const changed = folderEntry.store.applyOptimisticItemArchive(itemId, now());
                    if (publish) publishFolders(changed.deltas);
                    return changed.undo;
                },
                () => ({
                    headers: {
                        ...ifMatchHeader(requiredFolderItemVersion(folderEntry, itemId)),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `folder-items/${encodeURIComponent(itemId)}/archive`,
                    ),
                }),
            );
        },
    };

    const documents: RigDocuments = {
        create: (documentRequest, createOptions = {}) => {
            const documentId = createOptions.documentId ?? documentRequest.id ?? nextEntityId();
            let settleCreate!: (committed: boolean) => void;
            const createPromise = new Promise<boolean>((resolve) => {
                settleCreate = resolve;
            });
            const pendingCreate = { promise: createPromise, settle: settleCreate };
            pendingDocumentCreates.set(documentId, pendingCreate);
            const entry = documentEntries.get(documentId);
            if (entry !== undefined) entry.pendingCreate = pendingCreate;
            try {
                return enqueue({
                    acknowledged: false,
                    action: "create_document",
                    applyOptimistic: () => () => undefined,
                    documentId,
                    entityKey: documentKey(documentId),
                    id: documentId,
                    prepare: () => ({
                        body: { ...documentRequest, id: documentId, mutationId: documentId },
                        headers: { "x-rig-mutation-id": documentId },
                        method: "POST",
                        url: endpointUrl(options.endpoint, "documents"),
                    }),
                    undo: () => undefined,
                });
            } catch (error) {
                pendingCreate.settle(false);
                pendingDocumentCreates.delete(documentId);
                throw error;
            }
        },
        loadUpdates: async (documentId, loadOptions = {}) => {
            if (closed) throw new Error("This Rig connection is closed.");
            const entry = documentEntries.get(documentId);
            if (entry !== undefined) {
                publishDocument(entry, entry.store.startLoadingUpdates());
            }
            const operation = combinedSignal(rootController.signal, loadOptions.signal);
            try {
                const search = new URLSearchParams({
                    afterVersion: String(loadOptions.afterVersion ?? 0),
                    ...(loadOptions.limit === undefined
                        ? {}
                        : { limit: String(loadOptions.limit) }),
                });
                const response = await request(
                    endpointUrl(
                        options.endpoint,
                        `documents/${encodeURIComponent(documentId)}/updates?${search.toString()}`,
                    ),
                    {
                        headers: {
                            accept: "application/json",
                            authorization: `Bearer ${options.token}`,
                        },
                        signal: operation.signal,
                    },
                );
                const data = await readResponseBody(response);
                if (!response.ok) {
                    throw new MutationHttpError(
                        response.status,
                        humanMutationError(data, response.status),
                        retryAfterMilliseconds(response.headers.get("retry-after"), now()),
                        data,
                    );
                }
                const page = Value.Decode(documentUpdatePageSchema, data);
                if (page.updates.some((update) => update.documentId !== documentId)) {
                    throw new Error("Rig returned updates for a different document.");
                }
                if (entry !== undefined && documentEntries.get(documentId) === entry) {
                    publishDocument(entry, entry.store.applyUpdatePage(page));
                }
                return page;
            } catch (error) {
                if (entry !== undefined && documentEntries.get(documentId) === entry) {
                    publishDocument(entry, entry.store.failLoadingUpdates());
                }
                throw error;
            } finally {
                operation.detach();
            }
        },
        write: (documentId, expectedVersion, documentRequest) => {
            if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
                throw new Error("A document write needs a positive expected version.");
            }
            const id = nextMutationId();
            return enqueue({
                acknowledged: false,
                action: "write_document",
                applyOptimistic: (publish) => {
                    const entry = documentEntries.get(documentId);
                    if (entry?.store.document()?.version !== expectedVersion) {
                        return () => undefined;
                    }
                    const changed = entry.store.applyOptimisticPatch({
                        state: documentRequest.state,
                        updatedAt: now(),
                        ...("mimeType" in documentRequest
                            ? { mimeType: documentRequest.mimeType }
                            : {}),
                        ...("unreadCursor" in documentRequest
                            ? { unreadCursor: documentRequest.unreadCursor }
                            : {}),
                    });
                    if (publish) publishDocument(entry, changed.deltas);
                    return changed.undo;
                },
                documentId,
                entityKey: documentKey(documentId),
                id,
                prepare: () => ({
                    body: { ...documentRequest, mutationId: id },
                    headers: {
                        ...ifMatchHeader(expectedVersion),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `documents/${encodeURIComponent(documentId)}/write`,
                    ),
                }),
                undo: () => undefined,
            });
        },
    };

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

    const readOnboardingStatus = async (signal: AbortSignal): Promise<OnboardingStatus> => {
        if (closed) throw new Error("This Rig connection is closed.");
        const response = await request(endpointUrl(options.endpoint, "onboarding"), {
            headers: {
                accept: "application/json",
                authorization: `Bearer ${options.token}`,
            },
            signal,
        });
        if (!response.ok) {
            throw new Error(`Rig could not read onboarding status (${String(response.status)}).`);
        }
        try {
            return Value.Decode(onboardingStatusSchema, await response.json());
        } catch {
            signal.throwIfAborted();
            throw new Error("Rig returned an invalid onboarding status.");
        }
    };

    const getOnboardingStatus: RigConnection["getOnboardingStatus"] = async (
        operationOptions = {},
    ) => {
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        try {
            return await readOnboardingStatus(operation.signal);
        } finally {
            operation.detach();
        }
    };

    const onboardMurmur: RigConnection["onboardMurmur"] = async (
        onboardingRequest,
        operationOptions = {},
    ) => {
        if (!Value.Check(onboardMurmurRequestSchema, onboardingRequest)) {
            throw new Error("The Murmur onboarding choice is invalid.");
        }
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        try {
            const response = await requestJson("onboarding/murmur", {
                body: JSON.stringify(onboardingRequest),
                headers: { "content-type": "application/json" },
                method: "PUT",
                signal: operation.signal,
            });
            if (response.status >= 400) {
                throw new MutationHttpError(
                    response.status,
                    humanMutationError(response.data, response.status),
                    undefined,
                    response.data,
                );
            }
            let result: OnboardMurmurResponse;
            try {
                result = Value.Decode(onboardMurmurResponseSchema, response.data);
            } catch {
                throw new Error("Rig returned an invalid Murmur onboarding response.");
            }
            if (result.enabled && sharingEntry !== undefined) {
                void loadSharing(sharingEntry);
            }
            return result;
        } finally {
            operation.detach();
        }
    };

    const createProfilesEntry = (): ProfilesEntry => {
        if (profilesEntry !== undefined) return profilesEntry;
        const linked = linkedController(rootController.signal);
        profilesEntry = {
            controller: linked.controller,
            detachRoot: linked.detach,
            loaded: false,
            profiles: [],
            recoveryScheduled: false,
            reloadPending: false,
            started: false,
            subscribers: new Set(),
        };
        return profilesEntry;
    };

    const readProfiles = async (signal: AbortSignal): Promise<readonly RigProfile[]> => {
        if (closed) throw new Error("This Rig connection is closed.");
        const response = await request(endpointUrl(options.endpoint, "profiles"), {
            headers: {
                accept: "application/json",
                authorization: `Bearer ${options.token}`,
            },
            signal,
        });
        const bytes = await readBoundedResponseBytes(
            response,
            MAXIMUM_PROFILE_RESPONSE_BYTES,
            "human profile data",
        );
        const text = new TextDecoder().decode(bytes);
        let data: unknown;
        try {
            data = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
        } catch {
            data = text;
        }
        if (!response.ok) {
            throw new MutationHttpError(
                response.status,
                humanMutationError(data, response.status),
                undefined,
                data,
            );
        }
        try {
            return Value.Decode(listRigProfilesResponseSchema, data).profiles;
        } catch {
            throw new Error("Rig returned an invalid human profile list.");
        }
    };

    const loadProfiles = (entry: ProfilesEntry): Promise<void> => {
        if (entry.loading !== undefined) {
            entry.reloadPending = true;
            return entry.loading;
        }
        let shouldRecover = false;
        const loading = readProfiles(entry.controller.signal).then((profiles) => {
            if (entry.controller.signal.aborted || profilesEntry !== entry) return;
            delete entry.lastLoadError;
            applyProfiles(entry, profiles);
        });
        entry.loading = loading;
        void loading
            .catch((error: unknown) => {
                if (entry.controller.signal.aborted || profilesEntry !== entry) return;
                entry.lastLoadError = error;
                for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                shouldRecover = true;
            })
            .finally(() => {
                if (entry.loading === loading) delete entry.loading;
                if (entry.controller.signal.aborted || profilesEntry !== entry) return;
                if (entry.reloadPending) {
                    entry.reloadPending = false;
                    void loadProfiles(entry);
                } else if (shouldRecover) {
                    scheduleProfilesRecovery(entry);
                }
            });
        return loading;
    };

    const scheduleProfilesRecovery = (entry: ProfilesEntry): void => {
        if (entry.recoveryScheduled || entry.controller.signal.aborted) return;
        entry.recoveryScheduled = true;
        void wait(MAXIMUM_MUTATION_RETRY_MS, entry.controller.signal).then(() => {
            entry.recoveryScheduled = false;
            if (entry.controller.signal.aborted || profilesEntry !== entry) return;
            const neededBySession = [...sessionEntries.values()].some((session) =>
                session.store
                    .elements()
                    .some(
                        (element) => element.kind === "user_message" && element.identity !== null,
                    ),
            );
            if (entry.subscribers.size > 0 || neededBySession) void loadProfiles(entry);
        });
    };

    const startProfilesEntry = (entry: ProfilesEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        void loadProfiles(entry);
    };

    const ensureProfilesForSession = (entry: SessionEntry): void => {
        const attributed = entry.store
            .elements()
            .some((element) => element.kind === "user_message" && element.identity !== null);
        if (!attributed) return;
        const profiles = createProfilesEntry();
        if (profiles.loaded) {
            publishSession(entry, entry.store.applyProfiles(profiles.profiles));
        }
        startProfilesEntry(profiles);
    };

    const connectProfiles: RigConnection["connectProfiles"] = (subscription) => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createProfilesEntry();
        const subscriber: ProfilesSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        if (entry.loaded) subscriber.onChange(entry.profiles);
        if (entry.lastLoadError !== undefined) subscriber.onError?.(entry.lastLoadError);
        startProfilesEntry(entry);
        return {
            profiles: () => (subscriber.closed || !entry.loaded ? [] : entry.profiles),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const listProfiles: RigConnection["listProfiles"] = async (operationOptions = {}) => {
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        try {
            const profiles = await readProfiles(operation.signal);
            const entry = profilesEntry;
            if (entry !== undefined) applyProfiles(entry, profiles);
            return profiles;
        } finally {
            operation.detach();
        }
    };

    const requestProfileMutation = async (
        path: string,
        method: "PATCH" | "POST",
        body: unknown,
        signal: AbortSignal | undefined,
    ): Promise<RigProfile> => {
        const operation = combinedSignal(rootController.signal, signal);
        try {
            const response = await requestJson(path, {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json" },
                method,
                signal: operation.signal,
            });
            if (response.status >= 400) {
                throw new MutationHttpError(
                    response.status,
                    humanMutationError(response.data, response.status),
                    undefined,
                    response.data,
                );
            }
            let profile: RigProfileResponse;
            try {
                profile = Value.Decode(rigProfileResponseSchema, response.data);
            } catch {
                throw new Error("Rig returned an invalid human profile.");
            }
            const entry = createProfilesEntry();
            applyProfileMutation(entry, profile.profile);
            startProfilesEntry(entry);
            return profile.profile;
        } finally {
            operation.detach();
        }
    };

    const createProfile: RigConnection["createProfile"] = (profile, operationOptions = {}) => {
        if (!Value.Check(createRigProfileRequestSchema, profile)) {
            return Promise.reject(new Error("The human profile is invalid."));
        }
        return requestProfileMutation("profiles", "POST", profile, operationOptions.signal);
    };

    const updateProfile: RigConnection["updateProfile"] = (
        profileId,
        profile,
        operationOptions = {},
    ) => {
        if (!Value.Check(rigProfileIdSchema, profileId)) {
            return Promise.reject(new Error("The human profile ID is invalid."));
        }
        if (!Value.Check(updateRigProfileRequestSchema, profile)) {
            return Promise.reject(new Error("The human profile update is invalid."));
        }
        return requestProfileMutation(
            `profiles/${encodeURIComponent(profileId)}`,
            "PATCH",
            profile,
            operationOptions.signal,
        );
    };

    const createSharingEntry = (): SharingEntry => {
        if (sharingEntry !== undefined) return sharingEntry;
        const linked = linkedController(rootController.signal);
        sharingEntry = {
            controller: linked.controller,
            detachRoot: linked.detach,
            recoveryScheduled: false,
            reloadPending: false,
            started: false,
            subscribers: new Set(),
        };
        return sharingEntry;
    };

    const readSharing = async (signal: AbortSignal): Promise<SharingSnapshot> => {
        if (closed) throw new Error("This Rig connection is closed.");
        const response = await request(endpointUrl(options.endpoint, "sharing"), {
            headers: {
                accept: "application/json",
                authorization: `Bearer ${options.token}`,
            },
            signal,
        });
        const bytes = await readBoundedResponseBytes(
            response,
            MAXIMUM_PROFILE_RESPONSE_BYTES,
            "Sharing contact data",
        );
        const text = new TextDecoder().decode(bytes);
        let data: unknown;
        try {
            data = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
        } catch {
            data = text;
        }
        if (!response.ok) {
            throw new MutationHttpError(
                response.status,
                humanMutationError(data, response.status),
                undefined,
                data,
            );
        }
        try {
            return Value.Decode(sharingSnapshotSchema, data);
        } catch {
            throw new Error("Rig returned invalid Sharing contact data.");
        }
    };

    const loadSharing = (entry: SharingEntry): Promise<void> => {
        if (entry.loading !== undefined) {
            entry.reloadPending = true;
            return entry.loading;
        }
        let shouldRecover = false;
        const loading = readSharing(entry.controller.signal).then((snapshot) => {
            if (entry.controller.signal.aborted || sharingEntry !== entry) return;
            delete entry.lastLoadError;
            applySharing(entry, snapshot);
        });
        entry.loading = loading;
        void loading
            .catch((error: unknown) => {
                if (entry.controller.signal.aborted || sharingEntry !== entry) return;
                entry.lastLoadError = error;
                for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                shouldRecover = true;
            })
            .finally(() => {
                if (entry.loading === loading) delete entry.loading;
                if (entry.controller.signal.aborted || sharingEntry !== entry) return;
                if (entry.reloadPending) {
                    entry.reloadPending = false;
                    void loadSharing(entry);
                } else if (shouldRecover) {
                    scheduleSharingRecovery(entry);
                }
            });
        return loading;
    };

    const scheduleSharingRecovery = (entry: SharingEntry): void => {
        if (entry.recoveryScheduled || entry.controller.signal.aborted) return;
        entry.recoveryScheduled = true;
        void wait(MAXIMUM_MUTATION_RETRY_MS, entry.controller.signal).then(() => {
            entry.recoveryScheduled = false;
            if (
                entry.controller.signal.aborted ||
                sharingEntry !== entry ||
                entry.subscribers.size === 0
            ) {
                return;
            }
            void loadSharing(entry);
        });
    };

    const startSharingEntry = (entry: SharingEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (liveStreamOpen) void loadSharing(entry);
    };

    const connectSharing: RigConnection["connectSharing"] = (subscription) => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createSharingEntry();
        const subscriber: SharingSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        if (entry.snapshot !== undefined) subscriber.onChange(entry.snapshot);
        if (entry.lastLoadError !== undefined) subscriber.onError?.(entry.lastLoadError);
        startSharingEntry(entry);
        return {
            snapshot: () => (subscriber.closed ? undefined : entry.snapshot),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const getSharing: RigConnection["getSharing"] = async (operationOptions = {}) => {
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        try {
            const snapshot = await readSharing(operation.signal);
            const entry = sharingEntry;
            if (entry !== undefined) applySharing(entry, snapshot);
            return snapshot;
        } finally {
            operation.detach();
        }
    };

    const requestSharing = async <Result>(
        path: string,
        method: "DELETE" | "POST" | "PUT",
        schema: TSchema,
        operationOptions: { signal?: AbortSignal },
        body?: unknown,
    ): Promise<Result> => {
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        try {
            const response = await requestJson(path, {
                ...(body === undefined
                    ? {}
                    : {
                          body: JSON.stringify(body),
                          headers: { "content-type": "application/json" },
                      }),
                method,
                signal: operation.signal,
            });
            if (response.status >= 400) {
                throw new MutationHttpError(
                    response.status,
                    humanMutationError(response.data, response.status),
                    undefined,
                    response.data,
                );
            }
            try {
                return Value.Decode(schema, response.data) as Result;
            } catch {
                throw new Error("Rig returned an invalid Sharing response.");
            }
        } finally {
            operation.detach();
        }
    };

    const applySharingMutationSnapshot = (snapshot: SharingSnapshot): SharingSnapshot => {
        const entry = sharingEntry;
        if (entry !== undefined) applySharing(entry, snapshot);
        return snapshot;
    };

    const createSharingInvitation: RigConnection["createSharingInvitation"] = (
        operationOptions = {},
    ) =>
        requestSharing<CreateSharingInvitationResponse>(
            "sharing/invitations",
            "POST",
            createSharingInvitationResponseSchema,
            operationOptions,
        );

    const shareFolder: RigConnection["shareFolder"] = (
        folderId,
        contacts,
        operationOptions = {},
    ) => {
        const body = { contacts: [...contacts], folderId };
        if (!Value.Check(createFolderShareRequestSchema, body)) {
            return Promise.reject(
                new Error("A folder share needs a folder and at least one Sharing contact."),
            );
        }
        return requestSharing<FolderShareStatus>(
            "sharing/folders",
            "POST",
            folderShareStatusSchema,
            operationOptions,
            body,
        );
    };

    const requestSharingContact: RigConnection["requestSharingContact"] = async (
        invitation,
        operationOptions = {},
    ) => {
        if (!Value.Check(sharingIdentitySchema, invitation)) {
            throw new Error("The Sharing invitation is invalid.");
        }
        const response = await requestSharing<SharingOutgoingContactRequestResponse>(
            "sharing/contact-requests",
            "POST",
            sharingOutgoingContactRequestResponseSchema,
            operationOptions,
            { invitation },
        );
        const entry = sharingEntry;
        if (entry !== undefined) void loadSharing(entry);
        return response.request;
    };

    const finishSharingRequest = async (
        requestId: string,
        method: "DELETE" | "POST",
        operation: "accept" | "reject",
        operationOptions: { signal?: AbortSignal },
    ): Promise<SharingSnapshot> => {
        if (requestId.length < 1 || requestId.length > 256) {
            throw new Error("The Sharing contact request ID is invalid.");
        }
        return applySharingMutationSnapshot(
            await requestSharing<SharingSnapshot>(
                `sharing/contact-requests/${encodeURIComponent(requestId)}${
                    operation === "accept" ? "/accept" : ""
                }`,
                method,
                sharingSnapshotSchema,
                operationOptions,
            ),
        );
    };

    const acceptSharingContactRequest: RigConnection["acceptSharingContactRequest"] = (
        requestId,
        operationOptions = {},
    ) => finishSharingRequest(requestId, "POST", "accept", operationOptions);

    const rejectSharingContactRequest: RigConnection["rejectSharingContactRequest"] = (
        requestId,
        operationOptions = {},
    ) => finishSharingRequest(requestId, "DELETE", "reject", operationOptions);

    const removeSharingContact: RigConnection["removeSharingContact"] = async (
        identity,
        operationOptions = {},
    ) => {
        if (!Value.Check(sharingIdentitySchema, identity)) {
            throw new Error("The Sharing contact identity is invalid.");
        }
        return applySharingMutationSnapshot(
            await requestSharing<SharingSnapshot>(
                `sharing/contacts/${encodeURIComponent(identity)}`,
                "DELETE",
                sharingSnapshotSchema,
                operationOptions,
            ),
        );
    };

    const resetSharing: RigConnection["resetSharing"] = async (operationOptions = {}) =>
        applySharingMutationSnapshot(
            await requestSharing<SharingSnapshot>(
                "sharing",
                "DELETE",
                sharingSnapshotSchema,
                operationOptions,
            ),
        );

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
        const createdAt = now();
        const optimistic =
            input.scope === undefined
                ? undefined
                : {
                      archived: false,
                      createdAt,
                      cwd: input.cwd,
                      id,
                      modelId: input.modelId ?? "",
                      orderKey:
                          folderEntry?.store.optimisticSessionOrderKey(input.scope) ?? "\uffff",
                      permissionMode: input.permissionMode ?? "auto",
                      providerId: input.providerId ?? "",
                      scope: input.scope,
                      status: "idle" as const,
                      titleStatus: "idle",
                      updatedAt: createdAt,
                  };
        return enqueue({
            acknowledged: false,
            action: "create_session",
            applyOptimistic: (publish) => {
                if (folderEntry === undefined || optimistic === undefined) {
                    return () => undefined;
                }
                const changed = folderEntry.store.applyOptimisticSessionCreate(optimistic);
                if (publish) publishFolders(changed.deltas);
                return changed.undo;
            },
            entityKey: sessionKey(id),
            id,
            prepare: () => {
                const identity = input.identity ?? profileIdForSessionCreate(groupsEntry, input);
                const gitSecret = input.gitSecret ?? gitSecretForSessionCreate(groupsEntry, input);
                return {
                    body: {
                        ...input,
                        id,
                        ...(identity === undefined ? {} : { identity }),
                        ...(gitSecret === undefined ? {} : { gitSecret }),
                    },
                    headers: { "x-rig-mutation-id": id },
                    method: "POST" as const,
                    url: endpointUrl(options.endpoint, "sessions"),
                };
            },
            ready: async () => {
                if (usesPeerEndpoint && input.scope === undefined) {
                    await ensureGroupCatalogForMutation();
                }
                if (input.scope?.kind !== "folder") return;
                const pending = pendingFolderCreates.get(input.scope.folderId);
                if (pending === undefined) return;
                await pending.promise;
                if (folderEntry?.store.folder(input.scope.folderId) === undefined) {
                    throw new Error("That folder no longer exists.");
                }
            },
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
            // Daemon-owned; the authoritative answer names the branch it actually made.
            branch: "",
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
            prepare: () => {
                const project = groupsEntry?.store
                    .projects()
                    .find((candidate) => candidate.id === input.projectId);
                const identity = input.identity ?? project?.createdBy?.profileId;
                const secret =
                    input.secret ??
                    (project?.requiredSecretKind === "github"
                        ? ({ kind: "github" } as const)
                        : undefined);
                return {
                    body: {
                        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                        id,
                        ...(identity === undefined ? {} : { identity }),
                        name: input.name,
                        ...(secret === undefined ? {} : { secret }),
                    },
                    headers: { "x-rig-mutation-id": id },
                    method: "POST" as const,
                    url: endpointUrl(
                        options.endpoint,
                        `projects/${encodeURIComponent(input.projectId)}/workspaces`,
                    ),
                };
            },
            ...(usesPeerEndpoint ? { ready: ensureGroupCatalogForMutation } : {}),
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
        const optimisticIdentity =
            input.identity === undefined
                ? sessionEntries.get(sessionId)?.store.session().profileId
                : input.identity;
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
                    const changed = entry.store.applyOptimisticMessage(
                        id,
                        input.text,
                        now(),
                        optimisticIdentity ?? null,
                    );
                    if (optimisticIdentity !== undefined && optimisticIdentity !== null) {
                        ensureProfilesForSession(entry);
                    }
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
                const identity =
                    input.identity === undefined
                        ? (sessionEntries.get(sessionId)?.store.session().profileId ??
                          profileIdForSession(groupsEntry, sessionId))
                        : input.identity;
                const gitSecret = input.gitSecret ?? gitSecretForSession(groupsEntry, sessionId);
                return {
                    body: {
                        clientSubmissionId: id,
                        ...(input.content === undefined ? {} : { content: input.content }),
                        ...(input.displayText === undefined
                            ? {}
                            : { displayText: input.displayText }),
                        ...(identity === undefined || identity === null ? {} : { identity }),
                        ...(gitSecret === undefined ? {} : { gitSecret }),
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
            ...(usesPeerEndpoint ? { ready: ensureGroupCatalogForMutation } : {}),
        };
        return enqueue(mutation);
    };

    const sendContextMessage = (
        sessionId: string,
        message: string | SendContextMessageInput,
    ): MutationId => {
        const input = typeof message === "string" ? { text: message } : message;
        const optimisticIdentity =
            input.identity === undefined
                ? sessionEntries.get(sessionId)?.store.session().profileId
                : input.identity;
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
                    const changed = entry.store.applyOptimisticContextMessage(
                        id,
                        input.text,
                        now(),
                        optimisticIdentity ?? null,
                    );
                    if (optimisticIdentity !== undefined && optimisticIdentity !== null) {
                        ensureProfilesForSession(entry);
                    }
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
                const identity =
                    input.identity === undefined
                        ? (sessionEntries.get(sessionId)?.store.session().profileId ??
                          profileIdForSession(groupsEntry, sessionId))
                        : input.identity;
                const gitSecret = input.gitSecret ?? gitSecretForSession(groupsEntry, sessionId);
                return {
                    body: {
                        clientSubmissionId: id,
                        ...(identity === undefined || identity === null ? {} : { identity }),
                        ...(gitSecret === undefined ? {} : { gitSecret }),
                        mutationId: id,
                        text: input.text,
                    },
                    headers: ifMatchHeader(expectedEventId),
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/context`,
                    ),
                };
            },
            ...(usesPeerEndpoint ? { ready: ensureGroupCatalogForMutation } : {}),
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

    const callSecretApi = async <TSchema_ extends TSchema>(
        path: string,
        method: "GET" | "PATCH" | "POST",
        body: unknown,
        schema: TSchema_,
        operationOptions: SecretOperationOptions = {},
    ): Promise<Static<TSchema_>> => {
        if (closed) throw new Error("This Rig connection is closed.");
        const operation = combinedSignal(rootController.signal, operationOptions.signal);
        try {
            const response = await request(endpointUrl(options.endpoint, path), {
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                method,
                signal: operation.signal,
            });
            if (!response.ok) {
                throw new Error(
                    `Rig could not ${method === "GET" ? "read" : "save"} secrets (${String(response.status)}).`,
                );
            }
            const payload: unknown = await response.json().catch(() => undefined);
            try {
                return Value.Decode(schema, payload);
            } catch {
                throw new Error("Rig answered a secret request with an invalid response.");
            }
        } finally {
            operation.detach();
        }
    };

    const listSecrets: RigConnection["listSecrets"] = async (operationOptions) =>
        (
            await callSecretApi(
                "secrets",
                "GET",
                undefined,
                listSecretsResponseSchema,
                operationOptions,
            )
        ).secrets;

    const registerSecret: RigConnection["registerSecret"] = async (
        registration,
        operationOptions,
    ) => {
        let decoded: SecretRegistration;
        try {
            decoded = Value.Decode(secretRegistrationSchema, registration);
        } catch {
            throw new Error("The client must provide a valid secret registration.");
        }
        return (
            await callSecretApi("secrets", "POST", decoded, secretResponseSchema, operationOptions)
        ).secret;
    };

    const updateSecret: RigConnection["updateSecret"] = async (
        secretId,
        update,
        operationOptions,
    ) => {
        if (!Value.Check(secretIdSchema, secretId)) {
            throw new Error("The client must provide a valid secret ID.");
        }
        let decoded: SecretUpdate;
        try {
            decoded = Value.Decode(secretUpdateSchema, update);
        } catch {
            throw new Error("The client must provide a valid secret update.");
        }
        return (
            await callSecretApi(
                `secrets/${encodeURIComponent(secretId)}`,
                "PATCH",
                decoded,
                secretResponseSchema,
                operationOptions,
            )
        ).secret;
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
            for (const pending of pendingFolderCreates.values()) pending.resolve();
            pendingFolderCreates.clear();
            for (const pending of pendingDocumentCreates.values()) pending.settle(false);
            pendingDocumentCreates.clear();
            queues.clear();
            for (const entry of sessionEntries.values()) {
                entry.controller.abort();
                entry.detachRoot();
                entry.subscribers.clear();
            }
            sessionEntries.clear();
            for (const entry of documentEntries.values()) {
                entry.controller.abort();
                entry.detachRoot();
                entry.subscribers.clear();
            }
            documentEntries.clear();
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
            profilesEntry?.controller.abort();
            profilesEntry?.detachRoot();
            profilesEntry?.subscribers.clear();
            profilesEntry = undefined;
            sharingEntry?.controller.abort();
            sharingEntry?.detachRoot();
            sharingEntry?.subscribers.clear();
            sharingEntry = undefined;
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
            if (workletsEntry !== undefined) {
                workletsEntry.controller.abort();
                workletsEntry.detachRoot();
                workletsEntry.subscribers.clear();
                workletsEntry = undefined;
            }
            inboxEntry?.subscribers.clear();
            inboxEntry = undefined;
            folderEntry?.subscribers.clear();
            folderEntry = undefined;
            for (const entry of timelineEntries.values()) {
                entry.controller.abort();
                entry.detachRoot();
                entry.subscribers.clear();
            }
            timelineEntries.clear();
        },
        answerUserInput,
        applyHappyCloudCommand,
        attachSecret,
        cancelScheduledMessage,
        clearGoal,
        compactSession,
        connectDocument,
        connectFolders,
        connectGroups,
        connectHappyCloud,
        connectP2p,
        connectProfiles,
        connectSharing,
        connectInbox,
        connectPlugins,
        connectWorklets,
        connectProviderUsage,
        connectSession,
        connectTerminalPresence,
        connectTimeline,
        createP2pInvitation,
        createProfile,
        createSharingInvitation,
        createWorkspace,
        createSession,
        detachSecret,
        discoverPluginCatalog,
        documents,
        forkSession,
        installPlugin,
        getHappyCloudProfile,
        getHappyCloudSessionBlob,
        getHappyCloudStatus,
        getOnboardingStatus,
        onboardMurmur,
        getP2pPairing,
        getSharing,
        joinP2pInvitation,
        folders,
        listProfiles,
        listSecrets,
        projects,
        readBackgroundProcess,
        readPluginLog,
        registerSecret,
        recordActivity,
        renameGroup,
        resetSession,
        requestSharingContact,
        acceptSharingContactRequest,
        rejectSharingContactRequest,
        removeSharingContact,
        resetSharing,
        shareFolder,
        rewindSession,
        runShellCommand,
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
        stopRun,
        stopBackgroundProcess,
        stopBackgroundProcesses,
        stopWorkflow,
        switchModel,
        uninstallPlugin,
        updateProfile,
        updateSecret,
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

function documentKey(documentId: string): string {
    return `document:${documentId}`;
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

function requiredFolderVersion(entry: FolderEntry | undefined, folderId: string): number {
    const version = entry?.store.folder(folderId)?.version;
    if (version === undefined) throw new Error("That folder no longer exists.");
    return version;
}

function requiredFolderItemVersion(entry: FolderEntry | undefined, itemId: string): number {
    const version = entry?.store.item(itemId)?.version;
    if (version === undefined) throw new Error("That folder item no longer exists.");
    return version;
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
            group_chats: denied,
            happy_profile: denied,
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
                group_chats: denied,
                happy_profile: denied,
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
    const abort = () => controller.abort(parent.reason);
    if (parent.aborted) abort();
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
    const abortForParent = () => controller.abort(parent.reason);
    const abortForAdditional = () => controller.abort(additional.reason);
    if (parent.aborted) abortForParent();
    else if (additional.aborted) abortForAdditional();
    else {
        parent.addEventListener("abort", abortForParent, { once: true });
        additional.addEventListener("abort", abortForAdditional, { once: true });
    }
    return {
        detach: () => {
            parent.removeEventListener("abort", abortForParent);
            additional.removeEventListener("abort", abortForAdditional);
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
    description = "plugin data",
): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Rig returned more ${description} than the host can accept.`);
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
                throw new Error(`Rig returned more ${description} than the host can accept.`);
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
        value.scope !== null &&
        typeof value.scope === "object" &&
        typeof (value.scope as { kind?: unknown }).kind === "string" &&
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

async function fetchWorkletCatalog(
    endpoint: string,
    token: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<ListWorkletsResponse> {
    const response = await request(endpointUrl(endpoint, "worklets"), {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        throw new Error(`Rig could not load the worklet catalog (${String(response.status)}).`);
    }
    return Value.Decode(listWorkletsResponseSchema, await response.json());
}

/** Turns rig's worklet failure reply into an error a view can act on. */
function workletManagementError(status: number, payload: unknown): WorkletManagementRequestError {
    if (Value.Check(workletManagementErrorResponseSchema, payload)) {
        return new WorkletManagementRequestError(payload.error.code, status, payload.error.message);
    }
    return new WorkletManagementRequestError(
        "request_failed",
        status,
        `Rig could not complete the worklet request (${String(status)}).`,
    );
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
