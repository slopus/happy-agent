import type { Context } from "@steve.kite/stdlib";

import type {
    Attachment,
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateDocumentRequest,
    CreateFolderItemRequest,
    CreateFolderRequest,
    CreateProjectWorkspaceRequest,
    CreateRemoteProjectRequest,
    CreateSessionRequest,
    Document,
    DocumentCreatedBy,
    DocumentUpdatePage,
    Folder,
    FolderItem,
    ListFoldersResponse,
    ListDocumentUpdatesRequest,
    GetTimelineRequest,
    GitRepositoryFacts,
    MoveFolderItemRequest,
    MoveFolderRequest,
    Project,
    ProjectCreator,
    ProjectSettingsUpdate,
    ProjectWorkspace,
    RegisterProjectRequest,
    ReorderRequest,
    RegisterSecretRequest,
    SecretSummary,
    SubagentSummary,
    SessionSummary,
    SharedFolderState,
    TimelineAgent,
    TransferSessionRequest,
    TransferSessionResponse,
    UpdateSecretRequest,
    UpdateFolderRequest,
    WriteDocumentRequest,
} from "../protocol/index.js";
import type { AgentTreeUsage } from "../agent/index.js";
import type { InMemorySession } from "./InMemorySession.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { SpecialSecretKind, SpecialSecretRegistration } from "../secrets/index.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import type { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";
import type { ProjectAvatarAsset, ProjectSessionSettings } from "../project/ProjectRepository.js";
import type { ProjectRemoteTerminalStore } from "../terminal/index.js";
import type { PresenceStore } from "../presence/index.js";
import type { SlotEntryStore } from "../slots/index.js";
import type { AppletStore } from "../applets/index.js";
import type { WorkletStore } from "../worklets/index.js";

/** Internal server-side attributes for a new root session. */
export interface SessionCreationOptions {
    ownerInstanceId?: string;
    profileId?: string;
}

export interface SessionStore {
    /** Stable identity of this Rig installation. */
    readonly localInstanceId: string;
    /** Stable identity for this initialized Rig data generation. */
    readonly dataEpoch: string;
    /** Schema version observed from the initialized store after migration. */
    readonly dataSchemaVersion: number;
    readonly globalEventQueue: GlobalEventQueue;
    /** The ephemeral stream every local client follows. Never persisted. */
    readonly liveEvents: LiveGlobalEventQueue;
    /** Where the user is right now, and every presence they can switch to. */
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    /** Agent- and plugin-authored content plugged into the fixed Happy UI slots. */
    readonly slots: SlotEntryStore;
    /** Imported, versioned applets rig serves as static files. */
    readonly applets: AppletStore;
    /** Installed, versioned worklets: the background compute rig keeps running. */
    readonly worklets: WorkletStore;
    attachSecret(
        ctx: Context,
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined>;
    attachment(
        ctx: Context,
        sessionId: string,
        attachmentId: string,
    ): Promise<Attachment | undefined>;
    changeEffort(
        ctx: Context,
        sessionId: string,
        request: ChangeEffortRequest,
    ): Promise<InMemorySession | undefined>;
    changeModel(
        ctx: Context,
        sessionId: string,
        request: ChangeModelRequest,
    ): Promise<InMemorySession | undefined>;
    changeServiceTier(
        ctx: Context,
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): Promise<InMemorySession | undefined>;
    create(
        ctx: Context,
        request: CreateSessionRequest,
        options?: SessionCreationOptions,
    ): Promise<InMemorySession>;
    createWithId(
        ctx: Context,
        id: string,
        request: CreateSessionRequest,
        options?: SessionCreationOptions,
    ): Promise<InMemorySession>;
    createWorkspace(
        ctx: Context,
        projectId: string,
        request: CreateProjectWorkspaceRequest,
        options?: { createdBy?: ProjectCreator; githubToken?: string },
    ): Promise<ProjectWorkspace | undefined>;
    createRemoteProject(
        ctx: Context,
        request: CreateRemoteProjectRequest,
        options?: { createdBy?: ProjectCreator; githubToken?: string; mutationId?: string },
    ): Promise<Project>;
    detachSecret(
        ctx: Context,
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined>;
    fork(
        ctx: Context,
        sessionId: string,
        targetSessionId?: string,
    ): Promise<InMemorySession | undefined>;
    findByAgentId(ctx: Context, agentId: string): Promise<InMemorySession | undefined>;
    get(
        ctx: Context,
        sessionId: string,
        options?: { loadAgentTree?: boolean },
    ): Promise<InMemorySession | undefined>;
    getProject(ctx: Context, projectId: string): Promise<Project | undefined>;
    getProjectAvatar(ctx: Context, hash: string): Promise<ProjectAvatarAsset | undefined>;
    getWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined>;
    list(ctx: Context, options?: { limit?: number }): Promise<readonly SessionSummary[]>;
    /** Every explicitly unarchived primary session, with no default limit. */
    listActive(ctx: Context, options?: { limit?: number }): Promise<readonly SessionSummary[]>;
    /** Sessions already resident in memory; implementations must not hydrate storage to answer. */
    loadedSessions(): readonly InMemorySession[];
    listSubagents(ctx: Context, parentSessionId: string): Promise<readonly SubagentSummary[]>;
    queryAgentTreeUsage(ctx: Context, sessionId: string): Promise<AgentTreeUsage | undefined>;
    listSecrets(ctx: Context): Promise<readonly SecretSummary[]>;
    applyGitFacts(
        ctx: Context,
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): Promise<void>;
    /** The whole folder tree, every parent ahead of what is nested under it. */
    listFolders(ctx: Context): Promise<readonly Folder[]>;
    folderCatalog(ctx: Context): Promise<ListFoldersResponse>;
    getFolder(ctx: Context, folderId: string): Promise<Folder | undefined>;
    getFolderItem(ctx: Context, itemId: string): Promise<FolderItem | undefined>;
    createFolderItem(
        ctx: Context,
        folderId: string,
        request: CreateFolderItemRequest,
    ): Promise<FolderItem>;
    moveFolderItem(
        ctx: Context,
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion?: number,
    ): Promise<FolderItem | undefined>;
    archiveFolderItem(
        ctx: Context,
        itemId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<FolderItem | undefined>;
    createFolder(ctx: Context, request: CreateFolderRequest): Promise<Folder>;
    updateFolder(
        ctx: Context,
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined>;
    moveFolder(
        ctx: Context,
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined>;
    /** Puts a folder away together with everything nested under it. */
    archiveFolder(
        ctx: Context,
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Folder | undefined>;
    sharedFolderState(ctx: Context, rootFolderId: string): Promise<SharedFolderState>;
    sharedFolderGroup(ctx: Context, folderId: string): Promise<string | undefined>;
    sharedFolderRoot(ctx: Context, groupId: string): Promise<string | undefined>;
    assertFolderShareable(ctx: Context, folderId: string): Promise<void>;
    markFolderShared(ctx: Context, folderId: string, groupId: string): Promise<Folder>;
    applySharedFolderState(
        ctx: Context,
        groupId: string,
        state: SharedFolderState,
    ): Promise<Folder>;
    getDocument(ctx: Context, documentId: string): Promise<Document | undefined>;
    createDocument(
        ctx: Context,
        request: CreateDocumentRequest,
        createdBy: DocumentCreatedBy,
    ): Promise<Document>;
    writeDocument(
        ctx: Context,
        documentId: string,
        request: WriteDocumentRequest,
        expectedVersion: number,
    ): Promise<Document | undefined>;
    documentUpdates(
        ctx: Context,
        documentId: string,
        request: ListDocumentUpdatesRequest,
    ): Promise<DocumentUpdatePage | undefined>;
    /** Files one chat into a folder, or takes it back out into Unsorted with `null`. */
    setSessionFolder(
        ctx: Context,
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): Promise<InMemorySession | undefined>;
    sessionScopeMutationApplied(
        ctx: Context,
        sessionId: string,
        mutationId: string,
    ): Promise<boolean>;
    listProjects(ctx: Context): Promise<readonly Project[]>;
    listWorkspaces(ctx: Context, projectId?: string): Promise<readonly ProjectWorkspace[]>;
    registerProject(ctx: Context, request: RegisterProjectRequest): Promise<Project>;
    renameProject(
        ctx: Context,
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined>;
    queryProjectSettings(ctx: Context, cwd: string): Promise<ProjectSessionSettings | undefined>;
    renameWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<ProjectWorkspace | undefined>;
    refreshProject(ctx: Context, projectId: string): Promise<Project | undefined>;
    reorderProject(
        ctx: Context,
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<Project | undefined>;
    reorderSession(
        ctx: Context,
        sessionId: string,
        request: ReorderRequest,
    ): Promise<InMemorySession | undefined>;
    reorderWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined>;
    archiveProject(
        ctx: Context,
        projectId: string,
        expectedVersion?: number,
    ): Promise<Project | undefined>;
    unarchiveProject(ctx: Context, projectId: string): Promise<Project | undefined>;
    archiveWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined>;
    setProjectAvatar(
        ctx: Context,
        projectId: string,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined>;
    setProjectSettings(
        ctx: Context,
        projectId: string,
        settings: ProjectSettingsUpdate,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined>;
    clearProjectAvatar(ctx: Context, projectId: string): Promise<Project | undefined>;
    registerSecret(ctx: Context, request: RegisterSecretRequest): Promise<SecretSummary>;
    registerSpecialSecret(ctx: Context, request: SpecialSecretRegistration): Promise<SecretSummary>;
    resolveSpecialSecret(kind: SpecialSecretKind): NodeJS.ProcessEnv;
    refreshSessionGitCredential(
        ctx: Context,
        sessionId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<boolean>;
    /** The agents a scope covers and when each of them worked, waited, or asked. */
    timeline(ctx: Context, request: GetTimelineRequest): Promise<readonly TimelineAgent[]>;
    transferSession(
        ctx: Context,
        sessionId: string,
        request: TransferSessionRequest,
    ): Promise<TransferSessionResponse | undefined>;
    unregisterSecret(ctx: Context, secretId: string): Promise<boolean>;
    unregisterSpecialSecret(ctx: Context, kind: SpecialSecretKind): Promise<boolean>;
    updateSecret(
        ctx: Context,
        secretId: string,
        request: UpdateSecretRequest,
    ): Promise<SecretSummary | undefined>;
}
