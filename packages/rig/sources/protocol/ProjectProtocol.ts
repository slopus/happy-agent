import type {
    HappyComputePreparationEvent,
    HappyComputePreparationPhase,
    HappyComputeProviderContribution,
    HappyPluginAppContribution,
    HappyPluginCategory,
} from "./PluginWireTypes.js";
import { Type, type Static } from "@sinclair/typebox";

import type { EventId } from "./EventId.js";
import type {
    BaseSessionEvent,
    DaemonIdentity,
    ModelCatalog,
    SessionEvent,
    SessionSummary,
} from "./SessionProtocol.js";
import type { RemoteTerminalSummary } from "../terminal/types.js";
import type { SlotsChangedEvent } from "./SlotProtocol.js";
import type { AppletsChangedEvent } from "./AppletProtocol.js";
import type { WorkletsChangedEvent } from "./WorkletProtocol.js";
import {
    githubGitRefSchema,
    githubPluginCatalogSchema,
    githubPluginPackageSourceSchema,
    githubRepositorySchema,
} from "./GitHubPluginProtocol.js";
import type { Folder, FolderEvent, FolderItem } from "./FolderProtocol.js";
import type { DocumentEvent } from "./DocumentProtocol.js";
import type { HappyCloudChangedEvent } from "./HappyCloudProtocol.js";
import type { P2pStatusChangedEvent } from "./P2pProtocol.js";
import type { RigProfileChangedEvent } from "./ProfileProtocol.js";
import type { SharingChangedEvent } from "./SharingProtocol.js";
import { rigProfileIdSchema } from "./ProfileProtocol.js";
import { p2pInstanceIdSchema } from "./P2pIdentityProtocol.js";

export type ProjectKind = "regular" | "home";
export type ProjectInitializationStatus = "initializing" | "ready" | "failed";
export type ProjectNameSource = "folder" | "git_remote" | "user";
export type ProjectAvatarSource = "repository" | "hosting" | "user";

export const projectRemoteSourceSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("github"),
            repository: githubRepositorySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("git"),
            url: Type.String({ maxLength: 16_384, minLength: 1 }),
        },
        { additionalProperties: false },
    ),
]);
export type ProjectRemoteSource = Static<typeof projectRemoteSourceSchema>;

export const projectGitSecretSchema = Type.Object(
    { kind: Type.Literal("github") },
    { additionalProperties: false },
);
export type ProjectGitSecret = Static<typeof projectGitSecretSchema>;

export const projectCreatorSchema = Type.Object(
    {
        instanceId: p2pInstanceIdSchema,
        profileId: rigProfileIdSchema,
    },
    { additionalProperties: false },
);
export type ProjectCreator = Static<typeof projectCreatorSchema>;

/** A folder-backed operation targets either a project root or one workspace inside it. */
export interface ProjectScope {
    projectId: string;
    workspaceId?: string;
}

/** Whether the directory backing a project or workspace still exists on disk. */
export type ProjectPresence = "present" | "missing";

/** Whether a managed workspace can be created from a project. */
export type ProjectWorktreeSupport = "supported" | "unsupported" | "unknown";

/** Slow-moving Git facts cached on a project or workspace row. */
export interface GitRepositoryFacts {
    ahead: number;
    behind: number;
    branch?: string;
    detached: boolean;
    head?: string;
    upstream?: string;
}

export type GitFileChangeStatus =
    | "added"
    | "conflicted"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "submodule"
    | "type_changed"
    | "untracked";

export interface GitFileChange {
    binary: boolean;
    /**
     * Opaque identity of this file's content, to be compared for equality against the one carried
     * by an earlier snapshot. The same value means the bytes a client already fetched are still
     * current; a different value means it should read the file again. It is the only per-file
     * re-fetch signal there is: the snapshot's own version changes whenever anything in the
     * repository does, and the line counts stay put across an edit that leaves them equal.
     *
     * It is never to be parsed, ordered, or read as a hash, a size, or a time — its shape is not
     * part of this contract. A file the branch deleted has no content, which is itself an identity,
     * and it holds steady until the file comes back.
     *
     * It describes what the scan can observe about a file rather than its bytes, so it cannot see a
     * write that replaces a file with content of the same size within the same clock tick.
     *
     * Absent when the file could not be examined at all, which is not a claim that it is unchanged:
     * a client that finds no identity should read the file again rather than keep what it holds.
     */
    contentToken?: string;
    /** Absent for binary files, submodule pointers, and files a cap left uncounted. */
    deletions?: number;
    insertions?: number;
    path: string;
    /** Original path of a rename or copy. */
    previousPath?: string;
    staged: boolean;
    status: GitFileChangeStatus;
    unstaged: boolean;
}

export type GitComparisonState = "ready" | "unavailable";

/** Everything a change snapshot reports, before the tracker stamps it with an identity. */
export interface GitChangeState {
    /** Commit the comparison is measured against. */
    base?: string;
    /** Total changed files, including any the list cap omitted. */
    changedFiles: number;
    comparison: GitComparisonState;
    /** True while a merge or rebase is unresolved, so a client can suppress a misleading total. */
    conflicted: boolean;
    /** False when any cap or failure prevented exact line counting. */
    countsExact: boolean;
    deletions: number;
    /** Human-readable explanation of a failed scan or an unavailable comparison. */
    error?: string;
    facts: GitRepositoryFacts;
    files: readonly GitFileChange[];
    filesTruncated: boolean;
    insertions: number;
    scannedAt: number;
}

export interface ProjectAvatar {
    hash: string;
    height: number;
    mediaType: "image/webp";
    source: ProjectAvatarSource;
    url: string;
    width: number;
}

export const projectWorkspaceComputeInputSchema = Type.Union([
    Type.Object({ type: Type.Literal("local") }, { additionalProperties: false }),
    Type.Object(
        {
            image: Type.String({ minLength: 1, pattern: "^\\S+$" }),
            type: Type.Literal("docker"),
        },
        { additionalProperties: false },
    ),
]);

export type ProjectWorkspaceComputeInput = Static<typeof projectWorkspaceComputeInputSchema>;

export const projectWorkspaceComputeSchema = Type.Union([
    Type.Object(
        {
            generation: Type.Integer({ minimum: 1 }),
            type: Type.Literal("local"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            generation: Type.Integer({ minimum: 1 }),
            image: Type.String({ minLength: 1, pattern: "^\\S+$" }),
            type: Type.Literal("docker"),
        },
        { additionalProperties: false },
    ),
]);

export type ProjectWorkspaceCompute = Static<typeof projectWorkspaceComputeSchema>;

export const projectSettingsSchema = Type.Object(
    {
        defaultWorkspaceCompute: Type.Optional(projectWorkspaceComputeSchema),
    },
    { additionalProperties: false },
);

export type ProjectSettings = Static<typeof projectSettingsSchema>;

export const projectSettingsUpdateSchema = Type.Object(
    {
        defaultWorkspaceCompute: Type.Optional(projectWorkspaceComputeInputSchema),
    },
    { additionalProperties: false },
);
export type ProjectSettingsUpdate = Static<typeof projectSettingsUpdateSchema>;

export const updateProjectSettingsRequestSchema = Type.Object(
    {
        defaultWorkspaceCompute: Type.Optional(projectWorkspaceComputeInputSchema),
        mutationId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);
export type UpdateProjectSettingsRequest = Static<typeof updateProjectSettingsRequestSchema>;

export interface Project {
    archivedAt?: number;
    avatar?: ProjectAvatar;
    avatarBuiltin?: "home";
    createdAt: number;
    createdBy?: ProjectCreator;
    /** Branch new workspaces are cut from, decided once when the project was added. */
    defaultBranch?: string;
    git?: GitRepositoryFacts;
    id: string;
    initializationAttempt: number;
    initializationError?: string;
    initializationStatus: ProjectInitializationStatus;
    kind: ProjectKind;
    name: string;
    nameSource: ProjectNameSource;
    orderKey: string;
    path: string;
    presence: ProjectPresence;
    /** Remote repository Rig manages in this project's fixed folder. */
    remoteSource?: ProjectRemoteSource;
    /** Credential kind needed to retry the clone. Secret material is never persisted. */
    requiredSecretKind?: "github";
    settings: ProjectSettings;
    storageKey: string;
    updatedAt: number;
    version: number;
    worktreeSupport: ProjectWorktreeSupport;
    /** Human-readable explanation, present only when worktreeSupport is "unsupported". */
    worktreeSupportReason?: string;
}

export type ProjectWorkspaceKind = "git_worktree";
export type ProjectWorkspaceStatus = "initializing" | "ready" | "failed" | "archiving" | "archived";
/** Maximum human-readable failure detail persisted and sent for one project or workspace. */
export const PROJECT_ERROR_MAX_LENGTH = 500;

export interface ProjectWorkspace {
    archivedAt?: number;
    /** Immutable commit the workspace was created from; the anchor for its comparison base. */
    baseCommit?: string;
    baseRef?: string;
    /** Branch Rig manages for this worktree; it follows the workspace name. */
    branch: string;
    createdAt: number;
    /** Human profile that owns this remote workspace. */
    createdBy?: ProjectCreator;
    error?: string;
    git?: GitRepositoryFacts;
    gitCommonDir: string;
    id: string;
    kind: ProjectWorkspaceKind;
    name: string;
    orderKey: string;
    path: string;
    presence: ProjectPresence;
    projectId: string;
    status: ProjectWorkspaceStatus;
    storageKey: string;
    updatedAt: number;
    version: number;
}

export interface CreateProjectWorkspaceRequest {
    /** Explicit base to fork; the project's trunk on `origin` is used when it is absent. */
    baseRef?: string;
    /** Client-chosen cuid2 identity. Repeating it returns the same workspace. */
    id?: string;
    /** Human profile that owns the workspace. Required for remote creation. */
    identity?: string;
    name: string;
    /** Whether `name` was chosen deliberately, which keeps the first chat from replacing it. */
    nameConfigured?: boolean;
    /** Credential kind to share temporarily with a remote Rig. */
    secret?: ProjectGitSecret;
}

export const registerProjectRequestSchema = Type.Object(
    {
        path: Type.String({ maxLength: 16_384, minLength: 1 }),
        projectId: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
    },
    { additionalProperties: false },
);
export type RegisterProjectRequest = Static<typeof registerProjectRequestSchema>;

export const createRemoteProjectRequestSchema = Type.Object(
    {
        identity: rigProfileIdSchema,
        name: Type.String({ maxLength: 100, minLength: 1 }),
        projectId: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        secret: Type.Optional(projectGitSecretSchema),
        source: projectRemoteSourceSchema,
    },
    { additionalProperties: false },
);
export type CreateRemoteProjectRequest = Static<typeof createRemoteProjectRequestSchema>;

export const projectRegistrationErrorCodeSchema = Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("path_missing"),
    Type.Literal("not_directory"),
    Type.Literal("path_inaccessible"),
    Type.Literal("not_git_repository"),
    Type.Literal("not_git_top_level"),
    Type.Literal("project_id_conflict"),
    Type.Literal("project_path_conflict"),
    Type.Literal("secret_unavailable"),
    Type.Literal("unsupported_git_source"),
    Type.Literal("managed_workspace_unavailable"),
]);
export type ProjectRegistrationErrorCode = Static<typeof projectRegistrationErrorCodeSchema>;

export const projectRegistrationErrorResponseSchema = Type.Object(
    {
        error: Type.Object(
            {
                code: projectRegistrationErrorCodeSchema,
                message: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
export type ProjectRegistrationErrorResponse = Static<
    typeof projectRegistrationErrorResponseSchema
>;

export interface RenameProjectRequest {
    mutationId?: string;
    name: string;
}

export interface RenameProjectWorkspaceRequest {
    mutationId?: string;
    name: string;
}

export interface ReorderRequest {
    afterId: string | null;
}

export interface ListProjectsResponse {
    projects: readonly Project[];
}

export interface ProjectResponse {
    project: Project;
}

export interface GitStateResponse {
    git: GitChangeSnapshot;
}

export interface ListProjectWorkspacesResponse {
    workspaces: readonly ProjectWorkspace[];
}

export interface ProjectWorkspaceResponse {
    workspace: ProjectWorkspace;
}

export interface GitWatchRequest {
    entities: readonly { projectId: string; workspaceId?: string }[];
}

export interface GitWatchResponse {
    snapshots: readonly GlobalLiveEvent[];
}

export interface BaseProjectEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    projectId: string;
    type: TType;
}

export interface BaseProjectWorkspaceEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    projectId: string;
    type: TType;
    workspaceId: string;
}

export type ProjectEvent =
    | BaseProjectEvent<"project_created", { mutationId?: string; project: Project }>
    | BaseProjectEvent<"project_updated", { mutationId?: string; project: Project }>;

export type ProjectWorkspaceEvent =
    | BaseProjectWorkspaceEvent<
          "workspace_created",
          { mutationId?: string; workspace: ProjectWorkspace }
      >
    | BaseProjectWorkspaceEvent<
          "workspace_updated",
          { mutationId?: string; workspace: ProjectWorkspace }
      >;

/**
 * Git change snapshots, carrying the detail that is recomputed from disk on demand.
 *
 * These are live-only: delivered to current subscribers, never stored, and never advancing a
 * cursor. Persisting them would grow the durable log without adding recoverable information, since
 * one bounded scan reproduces them exactly. The durable half of Git state — branch, HEAD, upstream,
 * presence — rides on `project_updated` and `workspace_updated` instead.
 */
export type ProjectGitEvent = BaseProjectEvent<"project_git_changed", { git: GitChangeSnapshot }>;
export type ProjectWorkspaceGitEvent = BaseProjectWorkspaceEvent<
    "workspace_git_changed",
    { git: GitChangeSnapshot }
>;

export interface GitChangeSnapshot extends GitChangeState {
    /** Identity of the daemon run, so a client can tell a restart from an update. */
    generation: string;
    /** Monotonic within one generation; survives eviction so a client never regresses. */
    version: number;
}

export type RemoteTerminalsChangedEvent =
    | BaseProjectEvent<"remote_terminals_changed", { terminals: readonly RemoteTerminalSummary[] }>
    | BaseProjectWorkspaceEvent<
          "remote_terminals_changed",
          { terminals: readonly RemoteTerminalSummary[] }
      >;

export type SessionCurrentEvent = BaseSessionEvent<"session_current", { session: SessionSummary }>;

export interface RemoteTerminalGroupState {
    projectId: string;
    workspaceId?: string;
    terminals: readonly RemoteTerminalSummary[];
}

/** One presence state the user can be in. */
export interface PresenceSummary {
    /** How long a question may wait for an answer. `null` waits indefinitely, `0` never waits. */
    answerWaitMs: number | null;
    emoji: string;
    id: string;
    prompt: string;
    title: string;
}

/** Where the user is right now, and everything they can switch to. */
export interface PresenceSnapshot {
    /** When the current presence expires and the fallback takes over, when that is known. */
    changesAt?: number;
    fallbackPresenceId?: string;
    presence: PresenceSummary;
    presences: readonly PresenceSummary[];
    since: number;
}

/**
 * The user switched presence. It is live-only: presence says where the user is now, and a client
 * that reconnects reads the current state from the catalog rather than replaying old switches.
 */
export interface PresenceChangedEvent {
    createdAt: number;
    data: { presence: PresenceSnapshot };
    id: EventId;
    type: "presence_changed";
}

export interface SetPresenceRequestBody {
    fallbackPresenceId?: string;
    presenceId: string;
    /** Expiry in milliseconds since the epoch. Omitted keeps the presence until it is changed. */
    until?: number;
}

/** One plugin installed on this machine, as a client should show it. */
export interface PluginSummary {
    /** Running local MCP Apps, ordered exactly as a navigation host should present them. */
    apps: readonly HappyPluginAppContribution[];
    /** The bounded human-readable publisher/author label from the manifest. */
    author: string;
    /** The one catalog section chosen by the plugin author. */
    category: HappyPluginCategory;
    /** The live compute contribution from this plugin process, when attached. */
    compute?: HappyComputeProviderContribution;
    /** The folder the plugin writes to, which the user can open. */
    dataDirectory: string;
    description: string;
    /** Where Rig installed the plugin's code. */
    directory: string;
    folder: string;
    /** A private resource handle. It contains no filesystem location or credential. */
    icon: {
        /** SHA-256 identity of the validated icon bytes. */
        generation: string;
        mediaType: "image/png";
        size: number;
    };
    /** Why the current plugin generation is or is not available. */
    status: "failed" | "running" | "stopped";
    /** The plugin's own human-readable description of its current state. */
    statusMessage?: string;
    /** Present for a startup or process failure. */
    error?: string;
    /** Whether a bounded current-run log or startup diagnostic is available. */
    logAvailable: boolean;
    name: string;
    /** The manifest version, normalized to 0.0.0 when the author omitted it. */
    version: string;
}

/** One bounded snapshot of the current plugin generation's output. */
export interface PluginLogSnapshot {
    /** Startup or exit reason when the current generation is unavailable. */
    error?: string;
    folder: string;
    name: string;
    source: "current_run" | "error";
    status: PluginSummary["status"];
    text: string;
    truncated: boolean;
    updatedAt: number;
}

export interface ListPluginsResponse {
    /** The live-stream position read immediately before this catalog was assembled. */
    cursor: EventId;
    failures: readonly { error: string; folder: string }[];
    plugins: readonly PluginSummary[];
    /** Ordered identity of the exact catalog state in this response. */
    version: EventId;
}

export interface PluginLogResponse {
    log: PluginLogSnapshot;
}

export const pluginInstallClassificationSchema = Type.Union([
    Type.Literal("fresh-install"),
    Type.Literal("upgrade"),
    Type.Literal("downgrade"),
    Type.Literal("reinstall"),
]);
export type PluginInstallClassification = Static<typeof pluginInstallClassificationSchema>;

export const discoverPluginCatalogRequestSchema = Type.Object(
    {
        ref: Type.Optional(githubGitRefSchema),
        repository: githubRepositorySchema,
    },
    { additionalProperties: false },
);
export type DiscoverPluginCatalogRequest = Static<typeof discoverPluginCatalogRequestSchema>;

export const discoverPluginCatalogResponseSchema = githubPluginCatalogSchema;
export type DiscoverPluginCatalogResponse = Static<typeof discoverPluginCatalogResponseSchema>;

export const pluginInstallSourceSchema = Type.Union([
    Type.Object(
        {
            sourceDirectory: Type.String({ maxLength: 16_384, minLength: 1 }),
            type: Type.Literal("local-directory"),
        },
        { additionalProperties: false },
    ),
    githubPluginPackageSourceSchema,
]);
export type PluginInstallSource = Static<typeof pluginInstallSourceSchema>;

export const installPluginRequestSchema = Type.Object(
    {
        requestId: Type.String({ maxLength: 256, minLength: 1 }),
        source: pluginInstallSourceSchema,
    },
    { additionalProperties: false },
);
export type InstallPluginRequest = Static<typeof installPluginRequestSchema>;

export interface InstalledPluginSummary {
    classification: PluginInstallClassification;
    description: string;
    directory: string;
    folder: string;
    name: string;
    version: string;
}

export interface UninstalledPluginSummary {
    dataDirectory: string;
    folder: string;
    name: string;
}

export interface InstallPluginResponse {
    plugin: InstalledPluginSummary;
}

export interface UninstallPluginResponse {
    plugin: UninstalledPluginSummary;
}

export type PluginManagementErrorCode =
    | "catalog_invalid"
    | "catalog_not_found"
    | "install_failed"
    | "invalid_request"
    | "plugin_not_found"
    | "plugins_unavailable"
    | "repository_not_found"
    | "source_changed"
    | "source_unavailable"
    | "uninstall_failed";

export interface PluginManagementErrorResponse {
    error: {
        code: PluginManagementErrorCode;
        message: string;
    };
}

/**
 * The installed plugins changed, or one of them started or stopped. It is live-only and carries
 * the whole current set: plugins are folders on disk, so a client that reconnects reads them again
 * rather than replaying every past registration.
 */
export interface PluginsChangedEvent {
    createdAt: number;
    data: {
        failures: readonly { error: string; folder: string }[];
        /**
         * Best-effort metadata on the final catalog event for an installation. It may be absent
         * when a concurrent catalog change supersedes that event before publication.
         */
        installation?: InstalledPluginSummary;
        plugins: readonly PluginSummary[];
        version: EventId;
    };
    id: EventId;
    type: "plugins_changed";
}

export type ComputePreparationPhase = HappyComputePreparationPhase;

/** Durable compute materialization progress, also projected into attributed session timelines. */
export interface ComputePreparationEvent {
    computeInstanceId: string;
    createdAt: number;
    data: Pick<
        HappyComputePreparationEvent,
        | "elapsedMs"
        | "error"
        | "lastProgressAt"
        | "message"
        | "percent"
        | "phase"
        | "provider"
        | "startedAt"
        | "state"
    >;
    id: EventId;
    type: "compute_preparation";
}

export type GlobalLiveEvent =
    | HappyCloudChangedEvent
    | P2pStatusChangedEvent
    | RigProfileChangedEvent
    | SharingChangedEvent
    | PluginsChangedEvent
    | PresenceChangedEvent
    | SlotsChangedEvent
    | AppletsChangedEvent
    | WorkletsChangedEvent
    | ProjectGitEvent
    | ProjectWorkspaceGitEvent
    | RemoteTerminalsChangedEvent
    | SessionCurrentEvent
    | Extract<SessionEvent, { type: "session_draft_changed" }>;

export type GlobalEvent =
    | ComputePreparationEvent
    | DocumentEvent
    | SessionEvent
    | FolderEvent
    | ProjectEvent
    | ProjectWorkspaceEvent
    | GlobalLiveEvent;

export interface GlobalEventQueueEntry {
    cursor: string;
    event: GlobalEvent;
}

/**
 * A live delivery. It carries no cursor, so a client's `Last-Event-Id` keeps pointing at the last
 * durable position and reconnecting never skips stored events.
 */
export interface GlobalLiveEventDelivery {
    event: GlobalLiveEvent;
    live: true;
}

export type GlobalEventDelivery = GlobalEventQueueEntry | GlobalLiveEventDelivery;

export function isLiveGlobalEvent(event: GlobalEvent): event is GlobalLiveEvent {
    return (
        event.type === "plugins_changed" ||
        event.type === "sharing_changed" ||
        event.type === "profile_changed" ||
        event.type === "p2p_status_changed" ||
        event.type === "happy_cloud_changed" ||
        event.type === "presence_changed" ||
        event.type === "slots_changed" ||
        event.type === "applets_changed" ||
        event.type === "worklets_changed" ||
        event.type === "project_git_changed" ||
        event.type === "workspace_git_changed" ||
        event.type === "remote_terminals_changed" ||
        event.type === "session_current" ||
        event.type === "session_draft_changed"
    );
}

export interface ListGlobalEventsResponse {
    events: readonly GlobalEventQueueEntry[];
}

/**
 * The catalog snapshot a client loads from `GET /catalog`.
 *
 * It carries the group state a client needs to render immediately — the
 * projects, the workspaces inside them, and the sessions they contain — taken
 * at one point in the event stream, so a client can open the live stream first
 * and rebase this snapshot onto whatever arrived while it was loading.
 *
 * Git snapshots are deliberately absent. They are live-only, and a client
 * declares the entities it cares about with `POST /git/watch`, which answers
 * with their current snapshots.
 */
export interface GlobalStreamHello {
    /** The queue position this snapshot reflects; events after it follow on the stream. */
    cursor: string;
    catalog: ModelCatalog;
    /** The whole folder tree; virtual nesting is carried by each folder's parent. */
    folders: readonly Folder[];
    folderItems: readonly FolderItem[];
    identity: DaemonIdentity;
    /** Where the user is right now, and every presence they can switch to. */
    presence: PresenceSnapshot;
    protocolVersion: number;
    projects: readonly Project[];
    terminalGroups: readonly RemoteTerminalGroupState[];
    workspaces: readonly ProjectWorkspace[];
    sessions: readonly SessionSummary[];
    /** False when the daemon holds more sessions than this frame carried. */
    sessionsComplete: boolean;
}

export interface TrimGlobalEventsRequest {
    through: string;
}

export interface TrimGlobalEventsResponse {
    trimmed: number;
    through: string;
}
