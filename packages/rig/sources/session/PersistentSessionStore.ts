import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { getDatabaseScope, withDatabase } from "../persistence/databaseContext.js";
import { isSessionDatabaseTransaction } from "../persistence/database/SessionDatabase.js";
import { withWorkerContext } from "../observability/index.js";

import {
    createEventIdFactory,
    isLiveGlobalEvent,
    UNSORTED_SESSION_ARCHIVE_AFTER_MS,
} from "../protocol/index.js";
import type {
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
    EventId,
    Folder,
    FolderItem,
    GetTimelineRequest,
    GitChangeSnapshot,
    GitRepositoryFacts,
    GlobalEventQueueEntry,
    ModelCatalog,
    ListDocumentUpdatesRequest,
    MoveFolderItemRequest,
    MoveFolderRequest,
    Project,
    ProjectCreator,
    ProjectSettingsUpdate,
    ProjectWorkspace,
    ReorderRequest,
    GlobalEvent,
    RegisterProjectRequest,
    RegisterSecretRequest,
    SecretSummary,
    SessionEvent,
    SessionAgentMetadata,
    SessionActivityWait,
    SessionInterruption,
    SessionSummary,
    SharedFolderState,
    SessionScope,
    SessionTranscriptWindow,
    SubagentSummary,
    TimelineAgent,
    TransferSessionRequest,
    TransferSessionResponse,
    UpdateFolderRequest,
    WriteDocumentRequest,
    UpdateSecretRequest,
} from "../protocol/index.js";
import type { Message } from "../agent/types.js";
import {
    DEFAULT_WORKSPACE_FEATURES,
    InMemorySession,
    type InMemorySessionOptions,
    type InMemorySessionPersistence,
    type PersistedPendingContextMessage,
    type PersistedSessionMessage,
    type PersistedSessionState,
    type WorkspaceFeatures,
} from "./InMemorySession.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import { PersistentGlobalEventQueue } from "../global-event/PersistentGlobalEventQueue.js";
import { retriedSession } from "./retriedSession.js";
import type { SessionCreationOptions, SessionStore } from "./SessionStore.js";
import { p2pInstanceIdSchema } from "../protocol/P2pIdentityProtocol.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import { isLiveOnlySessionEvent } from "./isLiveOnlySessionEvent.js";
import {
    SecretRegistry,
    type EnvironmentSecretRegistration,
    type SpecialSecretKind,
    type SpecialSecretRegistration,
} from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { DurableUserInputCall } from "../user-input/index.js";
import type { DurableWait, ScheduledMessage } from "../scheduling/index.js";
import type { GitCommandRunner } from "../git/types.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { sharingStateReset } from "../persistence/sharing/index.js";
import { InMemoryGlobalEventQueue } from "../global-event/InMemoryGlobalEventQueue.js";
import { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";
import {
    ProjectRepository,
    type ProjectAvatarAsset,
    type ProjectRepositoryOptions,
    type ProjectSessionSettings,
} from "../project/ProjectRepository.js";
import { FolderRepository } from "../folders/FolderRepository.js";
import { DocumentRepository } from "../documents/DocumentRepository.js";
import { shouldPublishGlobalEvent } from "../global-event/shouldPublishGlobalEvent.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";
import {
    ProjectRemoteTerminalStore,
    type ProjectRemoteTerminalContext,
    type RemoteTerminalScope,
} from "../terminal/index.js";
import { SessionEventLog } from "./SessionEventLog.js";
import {
    sessionTranscriptWindow,
    transcriptRunFacts,
    type TranscriptEntry,
} from "./sessionTranscriptWindow.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../persistence/database/migrateSessionDatabase.js";
import { queryRigDataEpoch } from "../persistence/database/queryRigDataEpoch.js";
import { querySessionDatabaseVersion } from "../persistence/database/querySessionDatabaseVersion.js";
import { durableUserInputPrune } from "../persistence/session/durableUserInputPrune.js";
import { durableUserInputSave } from "../persistence/session/durableUserInputSave.js";
import { queryDurableUserInputs } from "../persistence/session/queryDurableUserInputs.js";
import { projectSecretAttach } from "../persistence/session/projectSecretAttach.js";
import { projectSecretDetach } from "../persistence/session/projectSecretDetach.js";
import { secretRegister } from "../persistence/session/secretRegister.js";
import { secretUnregister } from "../persistence/session/secretUnregister.js";
import { sessionAdvanceEventCursor } from "../persistence/session/sessionAdvanceEventCursor.js";
import { sessionAppendEvent } from "../persistence/session/sessionAppendEvent.js";
import { sessionClearMessages } from "../persistence/session/sessionClearMessages.js";
import { sessionReconcileTerminalRun } from "../persistence/session/sessionReconcileTerminalRun.js";
import { sessionRepairInterruptedTitles } from "../persistence/session/sessionRepairInterruptedTitles.js";
import { sessionRewind } from "../persistence/session/sessionRewind.js";
import { sessionSave } from "../persistence/session/sessionSave.js";
import { sessionSaveMessage } from "../persistence/session/sessionSaveMessage.js";
import { sessionSavePendingContextMessage } from "../persistence/session/sessionSavePendingContextMessage.js";
import { sessionDrainPendingContextMessages } from "../persistence/session/sessionDrainPendingContextMessages.js";
import {
    sessionPruneToolResults,
    type SessionToolResultPruneCursor,
} from "../persistence/session/sessionPruneToolResults.js";
import { sessionTransferWorkspace } from "../persistence/session/sessionTransferWorkspace.js";
import { sessionSetWorkspaceTransferState } from "../persistence/session/sessionSetWorkspaceTransferState.js";
import { queryWorkspaceHasAttachedSessions } from "../persistence/session/queryWorkspaceHasAttachedSessions.js";
import { durableWaitSave } from "../persistence/scheduling/durableWaitSave.js";
import { durableWaitPrune } from "../persistence/scheduling/durableWaitPrune.js";
import { scheduledMessageSave } from "../persistence/scheduling/scheduledMessageSave.js";
import { scheduledMessagePrune } from "../persistence/scheduling/scheduledMessagePrune.js";
import { queryNextPendingScheduledMessage } from "../persistence/scheduling/queryScheduledMessages.js";
import { queryFirstRootSessionIdForWorkspace } from "../persistence/session/queryFirstRootSessionIdForWorkspace.js";
import { queryInterruptedSessionCandidates } from "../persistence/session/queryInterruptedSessionCandidates.js";
import { queryProjectSecretIds } from "../persistence/session/queryProjectSecretIds.js";
import { queryRootSessionIdsForProject } from "../persistence/session/queryRootSessionIdsForProject.js";
import { queryWorkspaceSessions } from "../persistence/session/queryWorkspaceSessions.js";
import { queryExpiredUnsortedSessions } from "../persistence/session/queryExpiredUnsortedSessions.js";
import { querySecretRegistrations } from "../persistence/session/querySecretRegistrations.js";
import { querySessionEvents } from "../persistence/session/querySessionEvents.js";
import { querySessionHasEarlierTranscriptMessage } from "../persistence/session/querySessionHasEarlierTranscriptMessage.js";
import { querySessionHasLaterTranscriptMessage } from "../persistence/session/querySessionHasLaterTranscriptMessage.js";
import { querySessionIdByAgentId } from "../persistence/session/querySessionIdByAgentId.js";
import { queryUnarchivedSessionIdsForWorkspace } from "../persistence/session/queryUnarchivedSessionIdsForWorkspace.js";
import { querySessionOrderItems } from "../persistence/session/querySessionOrderItems.js";
import { querySessionRestore } from "../persistence/session/querySessionRestore.js";
import { querySessionSummaries } from "../persistence/session/querySessionSummaries.js";
import { querySessionTranscriptEvents } from "../persistence/session/querySessionTranscriptEvents.js";
import { querySessionTranscriptPage } from "../persistence/session/querySessionTranscriptPage.js";
import { querySessionAttachment } from "../persistence/session/querySessionAttachment.js";
import { querySessionTranscriptSince } from "../persistence/session/querySessionTranscriptSince.js";
import { querySubagentSummaries } from "../persistence/session/querySubagentSummaries.js";
import { queryTimelineAgents } from "../persistence/timeline/queryTimelineAgents.js";
import { queryTimelineEvents } from "../persistence/timeline/queryTimelineEvents.js";
import { queryAgentTreeUsage as queryPersistedAgentTreeUsage } from "../persistence/session/queryAgentTreeUsage.js";
import { queryAgentTreeSessionIds } from "../persistence/session/queryAgentTreeSessionIds.js";
import { queryLiveAgentTreeUsage } from "./queryLiveAgentTreeUsage.js";
import { buildTimeline } from "../timeline/index.js";
import { queryTerminalRunEvent } from "../persistence/session/queryTerminalRunEvent.js";
import { inTx } from "../persistence/inTx.js";
import { PresenceStore, resolvePresences } from "../presence/index.js";
import { SlotEntryStore } from "../slots/index.js";
import { AppletStore } from "../applets/index.js";
import { WorkletStore } from "../worklets/index.js";
import { querySlotScopeTargetExists } from "../persistence/slots/querySlotScopeTargetExists.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { configureSessionRequest } from "./configureSessionRequest.js";
import {
    executeSessionWorkspaceTransfer,
    scheduleSessionWorkspaceTransfer,
} from "./transferSessionWorkspace.js";
import { HappyCloudService } from "../happy-cloud/index.js";
import { workspaceRunReadiness } from "./workspaceRunReadiness.js";
import { queryRigProfile } from "../persistence/profile/queryRigProfiles.js";
import { createWorkspaceReadyWaiters } from "./workspaceReadyWaiters.js";
import {
    deferSessionTransactionCommit,
    isSessionTransactionPostCommitError,
    runSessionTransaction,
    sessionTransactionScope,
} from "./SessionTransactionContext.js";

const RESTORED_SESSION_EVENT_LIMIT = 4_096;
const RESTORED_SESSION_EVENT_BYTES = 4 * 1_024 * 1_024;
const MAX_SCHEDULE_TIMER_DELAY_MS = 2_147_000_000;
/**
 * How often the daemon looks for Unsorted chats that have run out of time. A chat has a whole day
 * to file itself, so looking once an hour puts it away close enough to the moment it expires.
 */
const UNSORTED_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/** How many Unsorted chats one sweep may put away, so a long backlog is worked through in batches. */
const UNSORTED_SWEEP_LIMIT = 100;
/** One pass drains a useful backlog without monopolizing the synchronous database. */
const UNSORTED_SWEEP_MAX_SESSIONS = 1_000;
const UNSORTED_SWEEP_MAX_MS = 250;
const TOOL_RESULT_SWEEP_BATCH_LIMIT = 10;
const TOOL_RESULT_SWEEP_MAX_SCANNED_MESSAGES = 100;
const TOOL_RESULT_SWEEP_MAX_MS = 250;
const TOOL_RESULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface PersistentSessionStoreOptions {
    databasePath: string;
    defaultDocker?: DockerExecutionConfig;
    localInstanceId?: string;
    durableGlobalEventQueue?: boolean;
    modelCatalog?: ModelCatalog;
    resolveModelCatalog?: (ownerInstanceId: string) => ModelCatalog;
    now?: () => number;
    onSessionAccess?: (session: InMemorySession) => void;
    onSessionEvent?: (
        event: SessionEvent,
        session: InMemorySession | undefined,
    ) => void | Promise<void>;
    onWorkspaceBranchError?: (error: unknown, projectId: string, workspaceId: string) => void;
    onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
    presence?: PresenceStore;
    gitCredentialBroker?: ProjectRepositoryOptions["gitCredentialBroker"];
    projectGit?: GitCommandRunner;
    projectClone?: ProjectRepositoryOptions["cloneRemote"];
    taskDrain?: TaskDrain;
    toolResultRetentionMs?: number;
    secrets?: readonly EnvironmentSecretRegistration[];
    homeDirectory?: string;
    stateDirectory?: string;
    workspacesDirectory?: string;
    workspaceFeatures?: WorkspaceFeatures;
}

type WorkspaceArchiveTeardown = (ctx: Context) => Promise<void>;

export class PersistentSessionStore implements SessionStore, InMemorySessionPersistence {
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #createPresenceEventId = createEventIdFactory();
    readonly #createSharingResetEventId = createEventIdFactory();
    readonly #createTerminalEventId = createEventIdFactory();
    #database: SessionDatabase;
    readonly dataEpoch: string;
    readonly dataSchemaVersion: number;
    #modelCatalog: ModelCatalog;
    readonly localInstanceId: string;
    readonly #resolveModelCatalog: (ownerInstanceId: string) => ModelCatalog;
    #now: () => number;
    #onSessionAccess: ((session: InMemorySession) => void) | undefined;
    #onSessionEvent:
        | ((event: SessionEvent, session: InMemorySession | undefined) => void)
        | undefined;
    #onWorkspaceCleanupError:
        | ((error: unknown, projectId: string, workspaceId: string) => void)
        | undefined;
    #globalEventQueue: GlobalEventQueue;
    #precommittedGlobalEvents = new Map<EventId, GlobalEventQueueEntry | null>();
    #folders: FolderRepository;
    #documents: DocumentRepository;
    #projects: ProjectRepository;
    #workspaceReadyWaiters!: ReturnType<typeof createWorkspaceReadyWaiters>;
    #secrets: SecretRegistry;
    readonly #workspaceFeatures: WorkspaceFeatures;
    #sessions = new Map<string, WeakRef<InMemorySession>>();
    readonly #workspaceTransferReservations = new Map<string, string>();
    #scheduledMessageTimer: ReturnType<typeof setTimeout> | undefined;
    #unsortedSweepTimer: ReturnType<typeof setInterval> | undefined;
    #unsortedSweepFollowup: ReturnType<typeof setImmediate> | undefined;
    readonly #toolResultRetentionMs: number | undefined;
    #toolResultSweepCursor: SessionToolResultPruneCursor | undefined;

    /** Shared database owner for daemon services that participate in session persistence. */
    get database(): SessionDatabase {
        return this.#database;
    }
    #toolResultSweepTimer: ReturnType<typeof setInterval> | undefined;
    #toolResultSweepFollowup: ReturnType<typeof setImmediate> | undefined;
    #toolResultSweepStopped = true;
    #sessionFinalizer = new FinalizationRegistry<{
        id: string;
        reference: WeakRef<InMemorySession>;
    }>(({ id, reference }) => {
        if (this.#sessions.get(id) === reference) this.#sessions.delete(id);
    });
    #taskDrain: TaskDrain | undefined;
    readonly liveEvents = new LiveGlobalEventQueue();
    readonly happyCloud: HappyCloudService;
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    readonly slots: SlotEntryStore;
    readonly applets: AppletStore;
    readonly worklets: WorkletStore;

    static async open(
        ctx: Context,
        options: PersistentSessionStoreOptions,
    ): Promise<PersistentSessionStore> {
        if (options.databasePath !== ":memory:") {
            await mkdir(dirname(options.databasePath), { mode: 0o700, recursive: true });
        }
        const opened = await openSessionDatabase(ctx, options.databasePath);
        const databaseCtx = withDatabase(ctx, opened.database);
        try {
            const localInstanceId = validOwnerInstanceId(options.localInstanceId ?? createId());
            await migrateSessionDatabase(databaseCtx, { localInstanceId });
            const dataEpoch = await queryRigDataEpoch(databaseCtx);
            const dataSchemaVersion = await querySessionDatabaseVersion(databaseCtx);
            if (dataSchemaVersion !== CURRENT_SESSION_DATABASE_VERSION) {
                throw new Error(
                    "The persistent Rig store did not reach the current schema version.",
                );
            }
            if (options.databasePath !== ":memory:") {
                await chmod(options.databasePath, 0o600);
            }
            const store = new PersistentSessionStore(
                databaseCtx,
                options,
                opened,
                localInstanceId,
                dataEpoch,
                dataSchemaVersion,
            );
            await store.#initialize(databaseCtx, options);
            return store;
        } catch (error) {
            await opened.database.close(databaseCtx);
            throw error;
        }
    }

    private constructor(
        ctx: Context,
        options: PersistentSessionStoreOptions,
        opened: OpenSessionDatabase,
        localInstanceId: string,
        dataEpoch: string,
        dataSchemaVersion: number,
    ) {
        this.localInstanceId = localInstanceId;
        const defaultModelCatalog = options.modelCatalog ?? createModelCatalog(ctx);
        this.#resolveModelCatalog = options.resolveModelCatalog ?? (() => defaultModelCatalog);
        this.#database = opened.database;
        this.dataEpoch = dataEpoch;
        this.dataSchemaVersion = dataSchemaVersion;
        this.presence = options.presence ?? new PresenceStore({ presences: resolvePresences() });
        this.presence.onChange((state) => {
            for (const session of this.#cachedSessions()) session.presenceChanged(state);
            const event = {
                createdAt: this.#now(),
                data: { presence: state },
                id: this.#createPresenceEventId(),
                type: "presence_changed" as const,
            };
            this.#globalEventQueue.publishLive(event);
            this.liveEvents.publish(event);
        });
        this.#secrets = new SecretRegistry();
        this.#modelCatalog = this.#resolveModelCatalog(this.localInstanceId);
        this.#defaultDocker = options.defaultDocker;
        this.#now = options.now ?? Date.now;
        this.#onSessionAccess = options.onSessionAccess;
        this.#onSessionEvent = options.onSessionEvent;
        this.#onWorkspaceCleanupError = options.onWorkspaceCleanupError;
        this.#taskDrain = options.taskDrain;
        this.#toolResultRetentionMs = options.toolResultRetentionMs;
        this.#workspaceFeatures = options.workspaceFeatures ?? DEFAULT_WORKSPACE_FEATURES;
        this.#globalEventQueue = new InMemoryGlobalEventQueue();
        this.happyCloud = new HappyCloudService({
            now: this.#now,
            persistence: this,
            publish: (requestCtx, event) => this.#publishGlobalEvent(requestCtx, event),
        });
        this.applets = new AppletStore({
            database: this.#database,
            now: this.#now,
            publish: (requestCtx, event) => this.#publishGlobalEvent(requestCtx, event),
        });
        this.worklets = new WorkletStore({ database: this.#database });
        this.slots = new SlotEntryStore({
            database: this.#database,
            now: this.#now,
            publish: (requestCtx, event) => this.#publishGlobalEvent(requestCtx, event),
            sessionExists: (requestCtx, sessionId) =>
                querySlotScopeTargetExists(requestCtx, "session", sessionId),
        });
        this.#projects = new ProjectRepository({
            afterTransactionCommit: (requestCtx, callback) =>
                this.#afterTransactionCommit(requestCtx, callback),
            ...(options.projectClone === undefined ? {} : { cloneRemote: options.projectClone }),
            database: this.#database,
            ...(options.gitCredentialBroker === undefined
                ? {}
                : { gitCredentialBroker: options.gitCredentialBroker }),
            localInstanceId: this.localInstanceId,
            ...(options.projectGit === undefined ? {} : { git: options.projectGit }),
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (requestCtx, event) => this.#projectEvent(requestCtx, event),
            resolveGitSecret: (kind) => this.#secrets.resolveSpecial(kind).GH_TOKEN,
            resolveProfile: async (profileId) =>
                await withWorkerContext("project-profile-resolve", (workerCtx) =>
                    queryRigProfile(withDatabase(workerCtx, this.#database), profileId),
                ),
            ...(options.onWorkspaceBranchError === undefined
                ? {}
                : { onWorkspaceBranchError: options.onWorkspaceBranchError }),
            ...(options.onWorkspaceCleanupError === undefined
                ? {}
                : { onWorkspaceCleanupError: options.onWorkspaceCleanupError }),
            ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
            transaction: (requestCtx, body) => this.#transaction(requestCtx, body),
            ...(options.stateDirectory !== undefined
                ? { stateDirectory: options.stateDirectory }
                : options.databasePath === ":memory:"
                  ? {}
                  : { stateDirectory: dirname(options.databasePath) }),
            ...(options.workspacesDirectory === undefined
                ? {}
                : { workspacesDirectory: options.workspacesDirectory }),
        });
        this.#folders = new FolderRepository({
            database: this.#database,
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            now: this.#now,
            onEvent: (requestCtx, event) => this.#publishGlobalEvent(requestCtx, event),
            onFolderContextChanged: async (requestCtx, folderIds) => {
                await this.#afterTransactionCommit(requestCtx, () => {
                    const affected = new Set(folderIds);
                    for (const session of this.#cachedSessions()) {
                        if (session.belongsToFolderContext(affected))
                            session.folderContextChanged();
                    }
                });
            },
            onSessionsArchived: async (requestCtx, sessionIds) => {
                await this.#afterTransactionCommit(requestCtx, async () => {
                    await Promise.all(
                        sessionIds.map(async (sessionId) => {
                            await (
                                await this.get(requestCtx, sessionId)
                            )?.recordFolderArchived(requestCtx);
                        }),
                    );
                });
            },
            transaction: (requestCtx, body) => this.#transaction(requestCtx, body),
        });
        this.#documents = new DocumentRepository({
            database: this.#database,
            now: this.#now,
            onEvent: (requestCtx, event) => this.#publishGlobalEvent(requestCtx, event),
            transaction: (requestCtx, body) => this.#transaction(requestCtx, body),
        });
        this.#workspaceReadyWaiters = createWorkspaceReadyWaiters((projectId, workspaceId) =>
            withWorkerContext("workspace-ready-query", (workerCtx) =>
                this.#projects.getWorkspace(workerCtx, projectId, workspaceId),
            ),
        );
        this.remoteTerminals = new ProjectRemoteTerminalStore({
            onChange: (requestCtx, scope, terminals) => {
                const event = {
                    createdAt: this.#now(),
                    data: { terminals },
                    id: this.#createTerminalEventId(),
                    projectId: scope.projectId,
                    type: "remote_terminals_changed" as const,
                    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
                };
                this.#globalEventQueue.publishLive(event);
                this.liveEvents.publish(event);
            },
            resolveContext: (requestCtx, scope) => this.#remoteTerminalContext(requestCtx, scope),
        });
    }

    async #initialize(ctx: Context, options: PersistentSessionStoreOptions): Promise<void> {
        await this.#loadSecretRegistrations(ctx);
        for (const secret of options.secrets ?? []) await this.registerSecret(ctx, secret);
        if (options.durableGlobalEventQueue === true) {
            this.#globalEventQueue = await PersistentGlobalEventQueue.open(ctx, this.#database);
        }
        await this.#repairInterruptedTitleGenerations(ctx);
        await this.repairInterruptedSessions(ctx, "crash");
        await this.#armScheduledMessageTimer(ctx);
        this.#armUnsortedSweepTimer();
        if (this.#toolResultRetentionMs !== undefined) this.#armToolResultSweepTimer();
        const recover = () =>
            withWorkerContext("workspace-recovery", async (ctx) =>
                this.#recoverProjectWorkspaces(withDatabase(ctx, this.#database)),
            );
        const recovery = this.#taskDrain?.run(recover) ?? recover();
        void recovery.catch((error: unknown) => {
            if (this.#database.closed) return;
            if (isDatabaseFailure(error)) throw error;
        });
    }

    async changeModel(
        ctx: Context,
        sessionId: string,
        request: ChangeModelRequest,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const session = await this.get(ctx, sessionId);
        if (session === undefined) {
            return undefined;
        }

        await session.changeModel(ctx, request);
        return session;
    }

    async attachSecret(
        ctx: Context,
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = persistentCodeScope(session.snapshot().scope).projectId;
            await projectSecretAttach(ctx, projectId, secretId);
            this.#secrets.reference(secretId);
            for (const candidate of this.#cachedSessions()) {
                const candidateScope = candidate.snapshot().scope;
                if (
                    (candidateScope.kind === "project" || candidateScope.kind === "workspace") &&
                    candidateScope.projectId === projectId
                ) {
                    await candidate.attachSecret(ctx, secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            await session.attachSecret(ctx, secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    async changeEffort(
        ctx: Context,
        sessionId: string,
        request: ChangeEffortRequest,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const session = await this.get(ctx, sessionId);
        if (session === undefined) {
            return undefined;
        }

        await session.changeEffort(ctx, request);
        return session;
    }

    async changeServiceTier(
        ctx: Context,
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        await session.changeServiceTier(ctx, request);
        return session;
    }

    async clearMessages(ctx: Context, sessionId: string): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await sessionClearMessages(ctx, sessionId);
    }

    async deleteMessagesFrom(ctx: Context, sessionId: string, position: number): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await sessionRewind(ctx, sessionId, position);
    }

    async close(ctx: Context): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        if (this.#scheduledMessageTimer !== undefined) {
            clearTimeout(this.#scheduledMessageTimer);
            this.#scheduledMessageTimer = undefined;
        }
        if (this.#unsortedSweepTimer !== undefined) {
            clearInterval(this.#unsortedSweepTimer);
            this.#unsortedSweepTimer = undefined;
        }
        if (this.#unsortedSweepFollowup !== undefined) {
            clearImmediate(this.#unsortedSweepFollowup);
            this.#unsortedSweepFollowup = undefined;
        }
        this.#stopToolResultSweep();
        await this.remoteTerminals.close(ctx);
        this.#workspaceReadyWaiters.close();
        await this.#projects.close(ctx);
        this.liveEvents.close();
        this.#globalEventQueue.deactivate();
        await this.#database.close(ctx);
    }

    async #configureWorkspaceRequest(
        ctx: Context,
        request: CreateSessionRequest,
    ): Promise<CreateSessionRequest> {
        const { docker: _docker, local: _local, ...base } = request;
        return await configureSessionRequest(
            base,
            this.#defaultDocker,
            async () => await this.#projects.queryProjectSettings(ctx, request.cwd),
        );
    }

    async create(
        ctx: Context,
        request: CreateSessionRequest,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
        ctx = withDatabase(ctx, this.#database);
        this.#assertAcceptingMutations();
        return await this.#createSession(ctx, request, undefined, undefined, undefined, options);
    }

    /**
     * Creates a session under an identity its caller chose.
     *
     * The identity is only checked for shape where a client supplies it, at the
     * protocol boundary. Rig's own integrations derive identities of their own,
     * and they reach this method directly.
     */
    async createWithId(
        ctx: Context,
        id: string,
        request: CreateSessionRequest,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
        ctx = withDatabase(ctx, this.#database);
        this.#assertAcceptingMutations();
        const existing = await this.get(ctx, id);
        if (existing !== undefined) return await retriedSession(existing, request);
        return await this.#createSession(ctx, request, undefined, undefined, id, options);
    }

    async detachSecret(
        ctx: Context,
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = persistentCodeScope(session.snapshot().scope).projectId;
            await projectSecretDetach(ctx, projectId, secretId);
            for (const candidate of this.#cachedSessions()) {
                const candidateScope = candidate.snapshot().scope;
                if (
                    (candidateScope.kind === "project" || candidateScope.kind === "workspace") &&
                    candidateScope.projectId === projectId
                ) {
                    await candidate.detachSecret(ctx, secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            await session.detachSecret(ctx, secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    async fork(
        ctx: Context,
        sessionId: string,
        targetSessionId?: string,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        this.#assertAcceptingMutations();
        if (targetSessionId !== undefined) {
            const existing = await this.get(ctx, targetSessionId);
            if (existing !== undefined) return existing;
        }
        const source = await this.get(ctx, sessionId);
        if (source === undefined) return undefined;
        const sourceSnapshot = source.snapshot();
        const folderPath =
            sourceSnapshot.scope.kind === "folder"
                ? await this.#folders.activeFolderStoragePath(ctx, sourceSnapshot.scope.folderId)
                : undefined;
        const state = source.createForkState();
        const forkState =
            folderPath === undefined
                ? state
                : (() => {
                      const { docker: _docker, ...rest } = state;
                      return { ...rest, cwd: folderPath };
                  })();
        const sourceRequest = source.requestForSubagent();
        const forkRequest =
            folderPath === undefined
                ? sourceRequest
                : (() => {
                      const { docker: _docker, ...rest } = sourceRequest;
                      return { ...rest, cwd: folderPath };
                  })();
        if (sourceSnapshot.scope.kind === "workspace") {
            this.#assertWorkspaceAcceptingSessions(sourceSnapshot.scope.workspaceId);
        }
        if (sourceSnapshot.scope.kind === "workspace") {
            const workspace = await this.#projects.getWorkspace(
                ctx,
                sourceSnapshot.scope.projectId,
                sourceSnapshot.scope.workspaceId,
            );
            if (
                workspace === undefined ||
                (
                    await workspaceRunReadiness(ctx, this.#projects, {
                        cwd: sourceSnapshot.cwd,
                        projectId: sourceSnapshot.scope.projectId,
                        workspaceId: sourceSnapshot.scope.workspaceId,
                    })
                ).state !== "ready"
            ) {
                throw new Error("A session in an unavailable workspace cannot be forked.");
            }
        }
        let session!: InMemorySession;
        await this.#transaction(ctx, async (ctx) => {
            session = await InMemorySession.open(ctx, {
                presence: this.presence,
                workspaceFeatures: this.#workspaceFeatures,
                workspaceRunReadiness: (target) =>
                    withWorkerContext("workspace-run-readiness", (workerCtx) =>
                        workspaceRunReadiness(workerCtx, this.#projects, target),
                    ),
                createEventId: createEventIdFactory(),
                deferEventNotification: (eventCtx, notify) =>
                    this.#afterTransactionCommit(eventCtx, notify),
                emitCreatedEvent: false,
                ...(targetSessionId === undefined ? {} : { id: targetSessionId }),
                modelCatalog: this.#modelCatalogFor(state.ownerInstanceId),
                now: this.#now,
                onInitialTitle: (metadata) => this.#inheritWorkspaceNameInWorker(metadata),
                onAppendEvent: (eventCtx, event) => this.#appendEvent(eventCtx, event),
                publishLiveEvent: (_eventCtx, event) => this.liveEvents.publish(event),
                persistence: this,
                folders: this.#folders,
                slotStores: { entries: this.slots, applets: this.applets },
                request: forkRequest,
                ...(sourceSnapshot.scope.kind === "project" ||
                sourceSnapshot.scope.kind === "workspace"
                    ? {
                          projectSecretIds: await this.#projectSecrets(
                              ctx,
                              sourceSnapshot.scope.projectId,
                          ),
                      }
                    : {}),
                ownerInstanceId: state.ownerInstanceId,
                ...(state.profileId === undefined ? {} : { profileId: state.profileId }),
                resolveGitAuthentication: async (projectId, creator) =>
                    await this.#projects.gitAuthentication(projectId, creator),
                resolveProfile: async (profileId) =>
                    withWorkerContext("session-profile-resolve", (workerCtx) =>
                        queryRigProfile(withDatabase(workerCtx, this.#database), profileId),
                    ),
                secretRegistry: this.#secrets,
                restore: {
                    ...forkState,
                    ...(targetSessionId === undefined
                        ? {}
                        : {
                              agent: { ...forkState.agent, rootSessionId: targetSessionId },
                              id: targetSessionId,
                          }),
                    orderKey: await this.#newLastSessionOrderKey(ctx, sourceSnapshot.scope),
                },
                scope: sourceSnapshot.scope,
                ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
            });
            await this.saveSession(ctx, session.state());
            for (const message of forkState.messages) {
                await this.upsertMessage(ctx, session.id, message);
            }
            await session.emitCreatedEvent(ctx);
        });
        this.#cacheSession(session);
        return session;
    }

    async #createSession(
        ctx: Context,
        request: CreateSessionRequest,
        metadata?: SessionAgentMetadata,
        contextMessages?: readonly Message[],
        id?: string,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
        this.#assertAcceptingMutations();
        const sessionId = id ?? createId();
        let session!: InMemorySession;
        let newUnsortedStorage: { created: boolean; path: string } | undefined;
        try {
            await this.#transaction(ctx, async (ctx) => {
                const inherited =
                    metadata?.parentSessionId === undefined
                        ? undefined
                        : (await this.get(ctx, metadata.parentSessionId))?.snapshot();
                if (metadata?.parentSessionId !== undefined && inherited === undefined) {
                    throw new Error("The parent session was not found.");
                }
                if (inherited?.status === "archived") {
                    throw new Error("An archived session cannot create a subagent.");
                }
                const ownerInstanceId =
                    inherited?.ownerInstanceId ??
                    (options.ownerInstanceId === undefined
                        ? this.localInstanceId
                        : validOwnerInstanceId(options.ownerInstanceId));
                const profileId = inherited?.profileId ?? options.profileId ?? request.identity;
                if (profileId !== undefined) {
                    const profile = await queryRigProfile(ctx, profileId);
                    if (profile?.parentInstanceId !== ownerInstanceId) {
                        throw new Error("The session profile is not owned by the session's Rig.");
                    }
                }
                const inheritedWorkspace =
                    inherited?.scope.kind === "workspace"
                        ? await this.#projects.getWorkspace(
                              ctx,
                              inherited.scope.projectId,
                              inherited.scope.workspaceId,
                          )
                        : undefined;
                if (
                    inherited?.scope.kind === "workspace" &&
                    (inheritedWorkspace === undefined ||
                        (
                            await workspaceRunReadiness(ctx, this.#projects, {
                                cwd: inherited.cwd,
                                projectId: inherited.scope.projectId,
                                workspaceId: inherited.scope.workspaceId,
                            })
                        ).state !== "ready")
                ) {
                    throw new Error("The parent session workspace is not ready and available.");
                }
                const resolved = await (async () => {
                    if (inherited === undefined) {
                        if (request.scope?.kind === "folder") {
                            return {
                                request: {
                                    ...request,
                                    cwd: await this.#folders.activeFolderStoragePath(
                                        ctx,
                                        request.scope.folderId,
                                    ),
                                },
                                scope: request.scope,
                            };
                        }
                        if (request.scope?.kind === "unsorted") {
                            newUnsortedStorage = this.#folders.createUnsortedSessionDirectory(
                                ctx,
                                sessionId,
                            );
                            return {
                                request: {
                                    ...request,
                                    cwd: newUnsortedStorage.path,
                                },
                                scope: request.scope,
                            };
                        }
                        if (request.workspaceId !== undefined) {
                            const ownership = await this.#projects.resolveSessionOwnership(
                                ctx,
                                request.cwd,
                                request.workspaceId,
                                request.projectId,
                            );
                            return {
                                ownership,
                                request,
                                scope: {
                                    kind: "workspace" as const,
                                    projectId: ownership.project.id,
                                    workspaceId: ownership.workspace?.id ?? request.workspaceId,
                                },
                            };
                        }
                        const ownership = await this.#projects.resolve(
                            ctx,
                            request.cwd,
                            undefined,
                            request.projectId,
                        );
                        return {
                            ownership,
                            request,
                            scope:
                                ownership.workspace === undefined
                                    ? { kind: "project" as const, projectId: ownership.project.id }
                                    : {
                                          kind: "workspace" as const,
                                          projectId: ownership.project.id,
                                          workspaceId: ownership.workspace.id,
                                      },
                        };
                    }
                    if (
                        request.workspaceId !== undefined &&
                        (inherited.scope.kind !== "workspace" ||
                            request.workspaceId !== inherited.scope.workspaceId)
                    ) {
                        const inheritedCode = persistentCodeScope(inherited.scope);
                        const ownership = await this.#projects.resolve(
                            ctx,
                            request.cwd,
                            request.workspaceId,
                            inheritedCode.projectId,
                        );
                        return {
                            ownership,
                            request,
                            scope: {
                                kind: "workspace" as const,
                                projectId: ownership.project.id,
                                workspaceId: ownership.workspace?.id ?? request.workspaceId,
                            },
                        };
                    }
                    if (inherited.scope.kind === "folder") {
                        const { docker: _docker, local: _local, ...inheritedRequest } = request;
                        return {
                            request: {
                                ...inheritedRequest,
                                cwd: await this.#folders.activeFolderStoragePath(
                                    ctx,
                                    inherited.scope.folderId,
                                ),
                            },
                            scope: inherited.scope,
                        };
                    }
                    return {
                        request: { ...request, cwd: inherited.cwd },
                        scope: inherited.scope,
                    };
                })();
                if (resolved.scope.kind === "workspace") {
                    this.#assertWorkspaceAcceptingSessions(resolved.scope.workspaceId);
                }
                const projectId =
                    resolved.scope.kind === "project" || resolved.scope.kind === "workspace"
                        ? resolved.scope.projectId
                        : undefined;
                const orderKey =
                    metadata?.type === "subagent"
                        ? ""
                        : await this.#newLastSessionOrderKey(ctx, resolved.scope);
                session = await InMemorySession.open(ctx, {
                    presence: this.presence,
                    workspaceFeatures: this.#workspaceFeatures,
                    workspaceRunReadiness: (target) =>
                        withWorkerContext("workspace-run-readiness", (workerCtx) =>
                            workspaceRunReadiness(workerCtx, this.#projects, target),
                        ),
                    createEventId: createEventIdFactory(),
                    deferEventNotification: (eventCtx, notify) =>
                        this.#afterTransactionCommit(eventCtx, notify),
                    emitCreatedEvent: false,
                    modelCatalog: this.#modelCatalogFor(ownerInstanceId),
                    now: this.#now,
                    onInitialTitle: (metadata) => this.#inheritWorkspaceNameInWorker(metadata),
                    ...(metadata !== undefined ? { metadata } : {}),
                    ...(contextMessages !== undefined
                        ? { initialContextMessages: contextMessages }
                        : {}),
                    id: sessionId,
                    onAppendEvent: (eventCtx, event) => this.#appendEvent(eventCtx, event),
                    publishLiveEvent: (_eventCtx, event) => this.liveEvents.publish(event),
                    orderKey,
                    ownerInstanceId,
                    ...(profileId === undefined ? {} : { profileId }),
                    resolveGitAuthentication: async (candidateProjectId, creator) =>
                        withWorkerContext("session-git-authentication", (workerCtx) =>
                            this.#projects.gitAuthentication(candidateProjectId, creator),
                        ),
                    resolveProfile: async (candidateProfileId) =>
                        withWorkerContext("session-profile-resolve", (workerCtx) =>
                            queryRigProfile(
                                withDatabase(workerCtx, this.#database),
                                candidateProfileId,
                            ),
                        ),
                    persistence: this,
                    folders: this.#folders,
                    slotStores: { entries: this.slots, applets: this.applets },
                    ...(projectId === undefined
                        ? {}
                        : { projectSecretIds: await this.#projectSecrets(ctx, projectId) }),
                    request: resolved.request,
                    scope: resolved.scope,
                    ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
                    secretRegistry: this.#secrets,
                });
                await this.saveSession(ctx, session.state());
                await session.emitCreatedEvent(ctx);
            });
        } catch (error) {
            if (newUnsortedStorage?.created === true) {
                this.#folders.removeNewUnsortedSessionDirectory(
                    ctx,
                    sessionId,
                    newUnsortedStorage.path,
                );
            }
            throw error;
        }
        this.#cacheSession(session);
        return session;
    }

    async get(
        ctx: Context,
        sessionId: string,
        options: { loadAgentTree?: boolean } = {},
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const existingReference = this.#sessions.get(sessionId);
        const existing = existingReference?.deref();
        if (existing !== undefined) {
            if (options.loadAgentTree !== false) await this.#loadAgentTree(ctx, existing);
            await this.#notifySessionAccess(ctx, existing);
            return existing;
        }
        if (existingReference !== undefined) this.#sessions.delete(sessionId);

        const session = await this.#loadSession(ctx, sessionId);
        if (session !== undefined) {
            this.#cacheSession(session);
            if (options.loadAgentTree !== false) await this.#loadAgentTree(ctx, session);
            await this.#notifySessionAccess(ctx, session);
        }
        return session;
    }

    async attachment(ctx: Context, sessionId: string, attachmentId: string) {
        ctx = withDatabase(ctx, this.#database);
        const session = await this.get(ctx, sessionId);
        return (
            session?.attachment(attachmentId) ??
            (await querySessionAttachment(ctx, sessionId, attachmentId))
        );
    }

    async findByAgentId(ctx: Context, agentId: string): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const sessionId = await querySessionIdByAgentId(ctx, agentId);
        return sessionId === undefined ? undefined : await this.get(ctx, sessionId);
    }

    get globalEventQueue(): GlobalEventQueue {
        return this.#globalEventQueue;
    }

    async setDurableGlobalEventQueue(ctx: Context, enabled: boolean): Promise<GlobalEventQueue> {
        ctx = withDatabase(ctx, this.#database);
        if (this.#globalEventQueue.durable === enabled) return this.#globalEventQueue;
        this.#globalEventQueue.deactivate();
        this.#globalEventQueue = enabled
            ? await PersistentGlobalEventQueue.open(ctx, this.#database, {
                  resetStream: true,
              })
            : new InMemoryGlobalEventQueue();
        return this.#globalEventQueue;
    }

    async insertPendingContextMessage(
        ctx: Context,
        sessionId: string,
        pending: PersistedPendingContextMessage,
    ): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await sessionSavePendingContextMessage(ctx, sessionId, pending, this.#now());
    }

    async drainPendingContextMessages(
        ctx: Context,
        sessionId: string,
        messageIds?: readonly string[],
    ): Promise<readonly PersistedPendingContextMessage[]> {
        ctx = withDatabase(ctx, this.#database);
        return await sessionDrainPendingContextMessages(ctx, sessionId, messageIds);
    }

    async list(ctx: Context, options: { limit?: number } = {}): Promise<readonly SessionSummary[]> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#listSessions(ctx, false, options);
    }

    async listActive(
        ctx: Context,
        options: { limit?: number } = {},
    ): Promise<readonly SessionSummary[]> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#listSessions(ctx, true, options);
    }

    async #listSessions(
        ctx: Context,
        activeOnly: boolean,
        options: { limit?: number },
    ): Promise<readonly SessionSummary[]> {
        const summaries = await querySessionSummaries(ctx, activeOnly, options);
        // A scheduled wait is live activity, so the stored row cannot carry it;
        // it is overlaid from the loaded sessions, the only ones that can wait.
        let waits: Map<string, SessionActivityWait> | undefined;
        for (const session of this.#cachedSessions()) {
            const wait = session.activity().wait;
            if (wait !== undefined) (waits ??= new Map()).set(session.id, wait);
        }
        const found = waits;
        if (found === undefined) return summaries;
        return summaries.map((summary) => {
            const wait = found.get(summary.id);
            return wait === undefined ? summary : { ...summary, wait };
        });
    }

    loadedSessions(): readonly InMemorySession[] {
        return this.#cachedSessions();
    }

    async listDurableUserInputs(ctx: Context): Promise<readonly DurableUserInputCall[]> {
        ctx = withDatabase(ctx, this.#database);
        return await queryDurableUserInputs(ctx);
    }

    async listSubagents(
        ctx: Context,
        parentSessionId: string,
    ): Promise<readonly SubagentSummary[]> {
        ctx = withDatabase(ctx, this.#database);
        return await querySubagentSummaries(ctx, parentSessionId);
    }

    async queryAgentTreeUsage(ctx: Context, sessionId: string) {
        ctx = withDatabase(ctx, this.#database);
        return await queryPersistedAgentTreeUsage(ctx, sessionId);
    }

    async timeline(ctx: Context, request: GetTimelineRequest): Promise<readonly TimelineAgent[]> {
        ctx = withDatabase(ctx, this.#database);
        // One consistent read: the agents and their events must describe the
        // same moment, or a run that ended between the two queries would be
        // charted as though it never stopped.
        return await inTx(ctx, "rig.sql.session.timeline", async (ctx) => {
            const agents = await queryTimelineAgents(
                ctx,
                request.scope,
                request.includeArchived ?? false,
            );
            const events = await queryTimelineEvents(
                ctx,
                agents.map((agent) => agent.sessionId),
            );
            return buildTimeline(
                agents,
                events,
                request.since === undefined ? {} : { since: request.since },
            );
        });
    }

    async listSecrets(ctx: Context): Promise<readonly SecretSummary[]> {
        ctx = withDatabase(ctx, this.#database);
        return this.#secrets.references();
    }

    async getProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.getProject(ctx, projectId);
    }

    async applyGitFacts(
        ctx: Context,
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await this.#projects.applyGitFacts(ctx, target, facts);
    }

    /**
     * Reports a Git change to the live sessions running in that directory.
     *
     * Only cached sessions are told: a session nobody is holding has no attached
     * client to inform, and reads current Git state when it is next loaded.
     */
    async applyGitSnapshot(
        ctx: Context,
        target: { projectId: string; workspaceId?: string },
        git: GitChangeSnapshot,
    ): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        for (const session of this.#cachedSessions()) {
            const identity = session.projectIdentity();
            if (identity === undefined) continue;
            if (identity.projectId !== target.projectId) continue;
            if (identity.workspaceId !== target.workspaceId) continue;
            await session.recordGitState(ctx, git);
        }
    }

    async listFolders(ctx: Context): Promise<readonly Folder[]> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.listFolders(ctx);
    }

    async folderCatalog(ctx: Context) {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.folderCatalog(ctx);
    }

    async getFolder(ctx: Context, folderId: string): Promise<Folder | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.getFolder(ctx, folderId);
    }

    async getFolderItem(ctx: Context, itemId: string): Promise<FolderItem | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.getFolderItem(ctx, itemId);
    }

    async createFolderItem(
        ctx: Context,
        folderId: string,
        request: CreateFolderItemRequest,
    ): Promise<FolderItem> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.createFolderItem(ctx, folderId, request);
    }

    async moveFolderItem(
        ctx: Context,
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion?: number,
    ): Promise<FolderItem | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.moveFolderItem(ctx, itemId, request, expectedVersion);
    }

    async archiveFolderItem(
        ctx: Context,
        itemId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<FolderItem | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.archiveFolderItem(ctx, itemId, expectedVersion, mutationId);
    }

    async createFolder(ctx: Context, request: CreateFolderRequest): Promise<Folder> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.createFolder(ctx, request);
    }

    async updateFolder(
        ctx: Context,
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.updateFolder(ctx, folderId, request, expectedVersion);
    }

    async moveFolder(
        ctx: Context,
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.moveFolder(ctx, folderId, request, expectedVersion);
    }

    async archiveFolder(
        ctx: Context,
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Folder | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.archiveFolder(ctx, folderId, expectedVersion, mutationId);
    }

    async sharedFolderState(ctx: Context, rootFolderId: string): Promise<SharedFolderState> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.sharedFolderState(ctx, rootFolderId);
    }

    async sharedFolderGroup(ctx: Context, folderId: string): Promise<string | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.sharedFolderGroup(ctx, folderId);
    }

    async sharedFolderRoot(ctx: Context, groupId: string): Promise<string | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.sharedFolderRoot(ctx, groupId);
    }

    async assertFolderShareable(ctx: Context, folderId: string): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await this.#folders.assertFolderShareable(ctx, folderId);
    }

    async markFolderShared(ctx: Context, folderId: string, groupId: string): Promise<Folder> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.markFolderShared(ctx, folderId, groupId);
    }

    async applySharedFolderState(
        ctx: Context,
        groupId: string,
        state: SharedFolderState,
    ): Promise<Folder> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.applySharedFolderState(ctx, groupId, state);
    }

    async resetSharingState(ctx: Context): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await this.#transaction(ctx, async (ctx) => {
            const now = this.#now();
            const revision = await sharingStateReset(ctx, now);
            if (revision === undefined) return;
            await this.#publishGlobalEvent(ctx, {
                createdAt: now,
                data: { revision },
                id: this.#createSharingResetEventId(),
                type: "folders_changed",
            });
        });
    }

    async getDocument(ctx: Context, documentId: string): Promise<Document | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#documents.getDocument(ctx, documentId);
    }

    async createDocument(
        ctx: Context,
        request: CreateDocumentRequest,
        createdBy: DocumentCreatedBy,
    ): Promise<Document> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#documents.createDocument(ctx, request, createdBy);
    }

    async writeDocument(
        ctx: Context,
        documentId: string,
        request: WriteDocumentRequest,
        expectedVersion: number,
    ): Promise<Document | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#documents.writeDocument(ctx, documentId, request, expectedVersion);
    }

    async documentUpdates(
        ctx: Context,
        documentId: string,
        request: ListDocumentUpdatesRequest,
    ): Promise<DocumentUpdatePage | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#documents.documentUpdates(ctx, documentId, request);
    }

    async setSessionFolder(
        ctx: Context,
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        this.#assertAcceptingMutations();
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        await session.fileIntoFolder(ctx, folderId, afterId, mutationId);
        return session;
    }

    async sessionScopeMutationApplied(
        ctx: Context,
        sessionId: string,
        mutationId: string,
    ): Promise<boolean> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#folders.sessionScopeMutationApplied(ctx, sessionId, mutationId);
    }

    async listProjects(ctx: Context): Promise<readonly Project[]> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.listProjects(ctx);
    }

    registerProject(ctx: Context, request: RegisterProjectRequest): Promise<Project> {
        ctx = withDatabase(ctx, this.#database);
        return this.#projects.registerProject(ctx, request);
    }

    createRemoteProject(
        ctx: Context,
        request: CreateRemoteProjectRequest,
        options?: { createdBy?: ProjectCreator; githubToken?: string; mutationId?: string },
    ): Promise<Project> {
        ctx = withDatabase(ctx, this.#database);
        return this.#projects.createRemoteProject(ctx, request, {
            ...options,
            createdBy: options?.createdBy ?? {
                instanceId: this.localInstanceId,
                profileId: request.identity,
            },
        });
    }

    async getWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.getWorkspace(ctx, projectId, workspaceId);
    }

    async listWorkspaces(ctx: Context, projectId?: string): Promise<readonly ProjectWorkspace[]> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.listWorkspaces(ctx, projectId);
    }

    async renameProject(
        ctx: Context,
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.renameProject(
            ctx,
            projectId,
            name,
            expectedVersion,
            mutationId,
        );
    }

    async queryProjectSettings(
        ctx: Context,
        cwd: string,
    ): Promise<ProjectSessionSettings | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.queryProjectSettings(ctx, cwd);
    }

    async setProjectSettings(
        ctx: Context,
        projectId: string,
        settings: ProjectSettingsUpdate,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.setProjectSettings(
            ctx,
            projectId,
            settings,
            expectedVersion,
            mutationId,
        );
    }

    async refreshProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.refreshProject(ctx, projectId);
    }

    async reorderProject(
        ctx: Context,
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.reorderProject(ctx, projectId, request, expectedVersion);
    }

    async reorderSession(
        ctx: Context,
        sessionId: string,
        request: ReorderRequest,
    ): Promise<InMemorySession | undefined> {
        ctx = withDatabase(ctx, this.#database);
        this.#assertAcceptingMutations();
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        if (session.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        const snapshot = session.snapshot();
        await this.#transaction(ctx, async () => {
            await session.setOrderKey(
                ctx,
                orderKeyAfter(
                    await this.#sessionOrderItems(ctx, snapshot.scope),
                    sessionId,
                    request.afterId,
                ),
            );
        });
        return session;
    }

    async reorderWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.reorderWorkspace(
            ctx,
            projectId,
            workspaceId,
            request,
            expectedVersion,
        );
    }

    async renameWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<ProjectWorkspace | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.renameWorkspace(
            ctx,
            projectId,
            workspaceId,
            name,
            expectedVersion,
            mutationId,
        );
    }

    createWorkspace(
        ctx: Context,
        projectId: string,
        request: CreateProjectWorkspaceRequest,
        options: { createdBy?: ProjectCreator; githubToken?: string } = {},
    ): Promise<ProjectWorkspace | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return this.#projects.createWorkspace(ctx, projectId, request, undefined, options);
    }

    async refreshSessionGitCredential(
        ctx: Context,
        sessionId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<boolean> {
        ctx = withDatabase(ctx, this.#database);
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return false;
        const snapshot = session.snapshot();
        if (snapshot.projectId === undefined) return false;
        const project = await this.#projects.getProject(ctx, snapshot.projectId);
        if (
            project?.remoteSource?.kind !== "github" ||
            snapshot.ownerInstanceId !== creator.instanceId ||
            snapshot.profileId !== creator.profileId
        ) {
            return false;
        }
        if (
            project.createdBy?.instanceId === creator.instanceId &&
            project.createdBy.profileId === creator.profileId
        ) {
            await this.#projects.refreshGitCredential(
                ctx,
                snapshot.projectId,
                creator,
                githubToken,
            );
        } else {
            await this.#projects.registerGitCredential(
                ctx,
                snapshot.projectId,
                creator,
                githubToken,
            );
        }
        await session.refreshGitCommandSecret(ctx);
        return true;
    }

    archiveProject(
        ctx: Context,
        projectId: string,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const archive = () => this.#archiveProject(ctx, projectId, expectedVersion);
        return this.#taskDrain?.run(archive) ?? archive();
    }

    async unarchiveProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.unarchiveProject(ctx, projectId);
    }

    /*
     * Archiving a project hides the whole folder: its root chats are archived, and every managed
     * workspace is archived with the sessions and worktree directory it owns.
     */
    async #archiveProject(
        ctx: Context,
        projectId: string,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        let project: Project | undefined;
        let archiving: string[] = [];
        const postCommitFailures: unknown[] = [];
        try {
            await this.#transaction(ctx, async () => {
                project = await this.#projects.archiveProject(ctx, projectId, expectedVersion);
                if (project === undefined) return;
                const rootSessionIds = await queryRootSessionIdsForProject(ctx, projectId);
                for (const sessionId of rootSessionIds) {
                    await (await this.get(ctx, sessionId))?.setArchived(ctx, true);
                }
                for (const workspace of await this.#projects.listWorkspaces(ctx, projectId)) {
                    if (workspace.status === "archived" || workspace.status === "archiving") {
                        continue;
                    }
                    const begun = await this.#projects.beginWorkspaceArchive(
                        ctx,
                        projectId,
                        workspace.id,
                    );
                    if (begun !== undefined && begun.status !== "archived") {
                        archiving.push(workspace.id);
                    }
                }
            });
        } catch (error) {
            if (!isSessionTransactionPostCommitError(error)) throw error;
            postCommitFailures.push(error);
        }
        if (project === undefined) {
            if (postCommitFailures.length > 0) throw postCommitFailures[0];
            return undefined;
        }
        // Every workspace is logically archived above; its sessions follow one transaction at a
        // time so no session teardown runs while the project archival holds the write lock.
        const workspaces: { teardown: WorkspaceArchiveTeardown[]; workspaceId: string }[] = [];
        for (const workspaceId of archiving) {
            try {
                workspaces.push({
                    teardown: await this.#archiveWorkspaceSessions(ctx, projectId, workspaceId),
                    workspaceId,
                });
            } catch (error) {
                if (!isSessionTransactionPostCommitError(error)) throw error;
                postCommitFailures.push(error);
                workspaces.push({ teardown: [], workspaceId });
            }
        }
        // All logical state is committed before physical cleanup yields.
        const cleanup = await this.#runWorkspaceArchiveCleanup(
            projectId,
            undefined,
            async (cleanupCtx) =>
                await Promise.allSettled([
                    this.remoteTerminals.closeProject(cleanupCtx, projectId),
                    ...workspaces.map((workspace) =>
                        this.#completeWorkspaceArchive(
                            cleanupCtx,
                            projectId,
                            workspace.workspaceId,
                            workspace.teardown.map((teardown) => teardown(cleanupCtx)),
                        ),
                    ),
                ]),
        );
        const failures = [
            ...postCommitFailures,
            ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                "Project archival committed, but its post-commit cleanup failed.",
            );
        }
        return await this.getProject(ctx, projectId);
    }

    archiveWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return this.#archiveWorkspace(ctx, projectId, workspaceId, expectedVersion);
    }

    async #archiveWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        // The workspace becomes "archiving" in its own transaction, before any session is touched.
        // That decision is what makes the rest resumable: a daemon that dies partway through finds
        // the workspace still archiving on the next start and runs the remaining sessions.
        const workspace = await this.#transaction(ctx, () =>
            this.#projects.beginWorkspaceArchive(ctx, projectId, workspaceId, expectedVersion),
        );
        if (workspace === undefined || workspace.status === "archived") {
            return Promise.resolve(workspace);
        }
        const teardowns = await this.#archiveWorkspaceSessions(ctx, projectId, workspaceId);
        const finish = () =>
            this.#runWorkspaceArchiveCleanup(projectId, workspaceId, async (cleanupCtx) => {
                const cleanup = teardowns.map((teardown) => teardown(cleanupCtx));
                cleanup.push(
                    this.remoteTerminals.closeWorkspace(cleanupCtx, projectId, workspaceId),
                );
                return await this.#completeWorkspaceArchive(
                    cleanupCtx,
                    projectId,
                    workspaceId,
                    cleanup,
                );
            });
        const background = this.#taskDrain?.run(finish) ?? finish();
        void background.catch((error: unknown) => {
            // Residue left behind is worth a warning because a later attempt can still clear it.
            // A database that cannot answer is neither reportable nor retryable.
            if (isDatabaseFailure(error)) throw error;
            this.#onWorkspaceCleanupError?.(error, projectId, workspaceId);
        });
        // Logical archival is already durable. Physical cleanup must never hold
        // the request open or make the workspace visible again.
        return Promise.resolve(workspace);
    }

    /**
     * Archives all sessions in one database transaction and starts their teardown only after that
     * transaction commits. A failure in any queued-run/event write restores every session touched
     * by the transaction, so memory cannot get ahead of SQLite.
     */
    async #archiveWorkspaceSessions(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<WorkspaceArchiveTeardown[]> {
        // Sessions cannot join a workspace that is already archiving, so this list only shrinks.
        const pending = await this.#transaction(ctx, () =>
            queryUnarchivedSessionIdsForWorkspace(ctx, workspaceId),
        );
        const touched: Array<{
            checkpoint: ReturnType<InMemorySession["captureMutationCheckpoint"]>;
            session: InMemorySession;
        }> = [];
        const teardowns: WorkspaceArchiveTeardown[] = [];
        try {
            await this.#transaction(ctx, async () => {
                for (const sessionId of pending) {
                    const session = await this.get(ctx, sessionId);
                    if (session === undefined) continue;
                    touched.push({
                        checkpoint: session.captureMutationCheckpoint(),
                        session,
                    });
                    const teardown = await session.archiveForWorkspace(ctx, workspaceId);
                    teardowns.push(teardown);
                }
            });
        } catch (error) {
            if (isSessionTransactionPostCommitError(error)) {
                const cleanup = await this.#runWorkspaceArchiveCleanup(
                    projectId,
                    workspaceId,
                    async (cleanupCtx) =>
                        await Promise.allSettled(teardowns.map((teardown) => teardown(cleanupCtx))),
                );
                const failures = cleanup.flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : [],
                );
                if (failures.length > 0) {
                    throw new AggregateError(
                        [error, ...failures],
                        "Workspace archival committed, but its post-commit work failed.",
                    );
                }
            } else {
                for (const { checkpoint, session } of touched) {
                    session.restoreMutationCheckpoint(checkpoint);
                }
            }
            throw error;
        }
        return teardowns;
    }

    #runWorkspaceArchiveCleanup<Result>(
        projectId: string,
        workspaceId: string | undefined,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return withWorkerContext(
            "workspace-archive-cleanup",
            (workerCtx) => work(withDatabase(workerCtx, this.#database)),
            { projectId, ...(workspaceId === undefined ? {} : { workspaceId }) },
        );
    }

    async #completeWorkspaceArchive(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        cleanup: readonly Promise<void>[],
    ): Promise<ProjectWorkspace | undefined> {
        const results = await Promise.allSettled(cleanup);
        for (const result of results) {
            if (result.status === "rejected") {
                if (isDatabaseFailure(result.reason)) throw result.reason;
                this.#onWorkspaceCleanupError?.(result.reason, projectId, workspaceId);
            }
        }
        return await this.#projects.removeArchivedWorkspace(ctx, projectId, workspaceId);
    }

    setProjectAvatar(
        ctx: Context,
        projectId: string,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return this.#projects.setAvatar(ctx, projectId, "user", bytes, expectedVersion);
    }

    async clearProjectAvatar(ctx: Context, projectId: string): Promise<Project | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return await this.#projects.clearAvatar(ctx, projectId);
    }

    getProjectAvatar(ctx: Context, hash: string): Promise<ProjectAvatarAsset | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return this.#projects.avatarAsset(ctx, hash);
    }

    async registerSecret(ctx: Context, request: RegisterSecretRequest): Promise<SecretSummary> {
        ctx = withDatabase(ctx, this.#database);
        const candidate = new SecretRegistry([request]);
        await secretRegister(ctx, request);
        this.#secrets.register(request);
        return candidate.reference(request.id);
    }

    async registerSpecialSecret(
        ctx: Context,
        request: SpecialSecretRegistration,
    ): Promise<SecretSummary> {
        ctx = withDatabase(ctx, this.#database);
        this.#secrets.register(request);
        await this.#projects.retryRemoteProjects(ctx, request.kind);
        return this.#secrets.reference(request.kind);
    }

    resolveSpecialSecret(kind: SpecialSecretKind): NodeJS.ProcessEnv {
        return this.#secrets.resolveSpecial(kind);
    }

    async unregisterSecret(ctx: Context, secretId: string): Promise<boolean> {
        ctx = withDatabase(ctx, this.#database);
        const secret = this.#secrets.references().find((candidate) => candidate.id === secretId);
        if (secret === undefined || secret.kind !== undefined) return false;
        await secretUnregister(ctx, secretId);
        this.#secrets.unregister(secretId);
        for (const session of this.#cachedSessions()) {
            await session.detachSecret(ctx, secretId, { scope: "project" });
            await session.detachSecret(ctx, secretId, { scope: "session" });
        }
        return true;
    }

    async unregisterSpecialSecret(ctx: Context, kind: SpecialSecretKind): Promise<boolean> {
        ctx = withDatabase(ctx, this.#database);
        return this.#secrets.unregisterSpecial(kind);
    }

    async updateSecret(
        ctx: Context,
        secretId: string,
        request: UpdateSecretRequest,
    ): Promise<SecretSummary | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const updated = this.#secrets.updatedRegistration(secretId, request);
        if (updated === undefined) return undefined;
        await secretRegister(ctx, updated);
        this.#secrets.register(updated);
        return this.#secrets.reference(secretId);
    }

    async repairInterruptedSessions(
        ctx: Context,
        reason: SessionInterruption["reason"],
    ): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        for (const { activeRunId, sessionId } of await queryInterruptedSessionCandidates(ctx)) {
            if (
                activeRunId !== undefined &&
                (await this.#reconcileTerminalRunState(ctx, sessionId, activeRunId))
            ) {
                continue;
            }
            const session = await this.get(ctx, sessionId);
            if (session === undefined) {
                continue;
            }

            const state = session.state();
            const runId = state.activeRunId;
            if (session.isSubagent() && state.status === "suspended") {
                const message =
                    "The subagent stopped working because the local server restarted before its suspended run finished.";
                await session.markSuspendedAfterRestart(ctx, message, runId);
                const parentSessionId = session.agentMetadata().parentSessionId;
                const parent =
                    parentSessionId === undefined
                        ? undefined
                        : await this.get(ctx, parentSessionId);
                if (parent !== undefined) {
                    const subagent = session.subagentSummary();
                    await parent.recordSubagentStoppedAfterRestart(
                        ctx,
                        subagent,
                        subagent.taskName ?? subagent.agentId,
                    );
                }
                continue;
            }
            await session.markInterrupted(ctx, {
                interruptedAt: this.#now(),
                message:
                    reason === "crash"
                        ? "The session was interrupted because the local server stopped before the run completed."
                        : "The session was interrupted because the local server shut down before the run completed.",
                reason,
                ...(runId !== undefined ? { runId } : {}),
            });
        }
    }

    async #reconcileTerminalRunState(
        ctx: Context,
        sessionId: string,
        runId: string,
    ): Promise<boolean> {
        const event = await queryTerminalRunEvent(ctx, sessionId, runId);
        if (event === undefined) return false;
        await sessionReconcileTerminalRun(ctx, {
            lastEventId: event.lastEventId,
            runId,
            sessionId,
            status: event.status,
            updatedAt: this.#now(),
        });
        return true;
    }

    async prepareForShutdown(ctx: Context, reason: SessionInterruption["reason"]): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        this.#taskDrain?.beginClose();
        if (this.#scheduledMessageTimer !== undefined) {
            clearTimeout(this.#scheduledMessageTimer);
            this.#scheduledMessageTimer = undefined;
        }
        if (this.#unsortedSweepTimer !== undefined) {
            clearInterval(this.#unsortedSweepTimer);
            this.#unsortedSweepTimer = undefined;
        }
        if (this.#unsortedSweepFollowup !== undefined) {
            clearImmediate(this.#unsortedSweepFollowup);
            this.#unsortedSweepFollowup = undefined;
        }
        this.#stopToolResultSweep();
        const closingSessions = new Set(this.#cachedSessions());
        const cleanup: Promise<void>[] = [
            ...[...closingSessions].map((session) => session.beginShutdown(ctx)),
            this.remoteTerminals.close(ctx),
        ];
        let repairError: unknown;
        try {
            await this.repairInterruptedSessions(ctx, reason);
        } catch (error) {
            repairError = error;
        }
        for (const session of this.#cachedSessions()) {
            if (closingSessions.has(session)) continue;
            cleanup.push(session.beginShutdown(ctx));
        }
        const cleanupResults = await Promise.allSettled(cleanup);
        await this.#taskDrain?.drain();
        const cleanupErrors = cleanupResults
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (repairError !== undefined || cleanupErrors.length > 0) {
            throw new AggregateError(
                [...(repairError === undefined ? [] : [repairError]), ...cleanupErrors],
                "The local daemon could not finish session cleanup.",
            );
        }
    }

    async saveSession(ctx: Context, state: PersistedSessionState): Promise<void> {
        if (!isSessionDatabaseTransaction(getDatabaseScope(ctx))) {
            ctx = withDatabase(ctx, this.#database);
        }
        validOwnerInstanceId(state.ownerInstanceId);
        const contextMessages =
            state.contextMessages ??
            state.messages
                .filter((message) => !message.isPartial)
                .sort((left, right) => left.position - right.position)
                .map((message) => message.message);
        await sessionSave(ctx, state, {
            contextMessages,
            now: this.#now(),
        });
    }

    async setWorkspaceTransferState(
        ctx: Context,
        input: Parameters<NonNullable<InMemorySessionPersistence["setWorkspaceTransferState"]>>[1],
    ): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await sessionSetWorkspaceTransferState(ctx, { ...input, now: this.#now() });
    }

    async transferWorkspace(
        ctx: Context,
        input: {
            contextMessages: readonly Message[];
            cwd: string;
            sessionId: string;
            state: Parameters<typeof sessionTransferWorkspace>[1]["state"];
            projectId: string;
            workspaceId: string;
        },
    ): Promise<string> {
        ctx = withDatabase(ctx, this.#database);
        const scope: SessionScope = {
            kind: "workspace",
            projectId: input.projectId,
            workspaceId: input.workspaceId,
        };
        const orderKey = await this.#newLastSessionOrderKey(ctx, scope);
        await sessionTransferWorkspace(ctx, { ...input, now: this.#now(), orderKey });
        return orderKey;
    }

    async transferSession(
        ctx: Context,
        sessionId: string,
        request: TransferSessionRequest,
    ): Promise<TransferSessionResponse | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return this.#executeSessionTransfer(ctx, sessionId, request.targetWorkspaceId, false);
    }

    async #executeSessionTransfer(
        ctx: Context,
        sessionId: string,
        targetWorkspaceId: string,
        scheduled: boolean,
    ): Promise<TransferSessionResponse | undefined> {
        ctx = withDatabase(ctx, this.#database);
        this.#assertAcceptingMutations();
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        return executeSessionWorkspaceTransfer(ctx, {
            hasAttachedSessions: async (requestCtx, workspaceId) =>
                await queryWorkspaceHasAttachedSessions(requestCtx, workspaceId),
            projects: this.#projects,
            releaseTarget: (workspaceId, ownerSessionId) =>
                this.#releaseWorkspaceTransferTarget(workspaceId, ownerSessionId),
            reserveTarget: (workspaceId, ownerSessionId) =>
                this.#reserveWorkspaceTransferTarget(workspaceId, ownerSessionId),
            scheduled,
            session,
            targetWorkspaceId,
        });
    }

    async query<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T> {
        ctx = withDatabase(ctx, this.#database);
        this.#assertOpen();
        return await operation(ctx);
    }

    transaction<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T> {
        ctx = withDatabase(ctx, this.#database);
        return this.#transaction(ctx, operation);
    }

    #assertAcceptingMutations(): void {
        if (this.#taskDrain?.closing === true) {
            throw new Error("The local daemon is shutting down.");
        }
    }

    async upsertMessage(
        ctx: Context,
        sessionId: string,
        message: PersistedSessionMessage,
    ): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await sessionSaveMessage(ctx, sessionId, message, this.#now());
    }

    async loadTranscriptPage(
        ctx: Context,
        sessionId: string,
        turnLimit: number,
        before?: string,
    ): Promise<SessionTranscriptWindow | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const requestCtx = withDatabase(ctx, ctx.tx);
        const page = await querySessionTranscriptPage(requestCtx, sessionId, turnLimit, before);
        if (page === undefined) return undefined;
        const firstPosition = page.messages[0]?.position;
        const hasEarlier =
            firstPosition !== undefined &&
            (await querySessionHasEarlierTranscriptMessage(requestCtx, sessionId, firstPosition));
        return await this.#transcriptWindowForMessages(
            requestCtx,
            sessionId,
            page.messages,
            turnLimit,
            !hasEarlier,
            page.noticesTruncated,
        );
    }

    async loadTranscriptSince(
        ctx: Context,
        sessionId: string,
        turnLimit: number,
        after: EventId,
    ): Promise<SessionTranscriptWindow | undefined> {
        ctx = withDatabase(ctx, this.#database);
        const requestCtx = withDatabase(ctx, ctx.tx);
        const range = await querySessionTranscriptSince(requestCtx, sessionId, turnLimit, after);
        if (range === undefined) return undefined;
        const lastPosition = range.messages.at(-1)?.position;
        const hasLater =
            lastPosition !== undefined &&
            (await querySessionHasLaterTranscriptMessage(requestCtx, sessionId, lastPosition));
        return await this.#transcriptWindowForMessages(
            requestCtx,
            sessionId,
            range.messages,
            turnLimit,
            !hasLater,
            range.truncated,
        );
    }

    async upsertDurableUserInput(ctx: Context, call: DurableUserInputCall): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await durableUserInputSave(ctx, call);
    }

    async upsertDurableWait(ctx: Context, wait: DurableWait): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await durableWaitSave(ctx, wait);
    }

    async upsertScheduledMessage(ctx: Context, message: ScheduledMessage): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await scheduledMessageSave(ctx, message);
    }

    async scheduledMessageChanged(ctx: Context): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await this.#afterTransactionCommit(ctx, (ctx) => this.#armScheduledMessageTimer(ctx));
    }

    async pruneDurableUserInputs(ctx: Context, sessionId: string, retain: number): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await durableUserInputPrune(ctx, sessionId, retain);
    }

    async pruneDurableWaits(ctx: Context, sessionId: string, retain: number): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        await durableWaitPrune(ctx, sessionId, retain);
    }

    async pruneScheduledMessages(
        ctx: Context,
        sessionId: string,
        retain: number,
    ): Promise<readonly string[]> {
        ctx = withDatabase(ctx, this.#database);
        return await scheduledMessagePrune(ctx, sessionId, retain);
    }

    async #armScheduledMessageTimer(ctx: Context): Promise<void> {
        if (this.#database.closed) return;
        if (this.#scheduledMessageTimer !== undefined) clearTimeout(this.#scheduledMessageTimer);
        const next = await queryNextPendingScheduledMessage(ctx);
        if (next === undefined) {
            this.#scheduledMessageTimer = undefined;
            return;
        }
        const delay = Math.min(MAX_SCHEDULE_TIMER_DELAY_MS, Math.max(0, next.dueAt - this.#now()));
        this.#scheduledMessageTimer = setTimeout(() => {
            this.#scheduledMessageTimer = undefined;
            void withWorkerContext("scheduled-message-delivery", async (ctx) =>
                this.#deliverDueScheduledMessages(withDatabase(ctx, this.#database)),
            ).catch(rethrowDatabaseFailure);
        }, delay);
    }

    /**
     * Puts away the Unsorted chats that have run out of time.
     *
     * A chat can start belonging nowhere and file itself into a folder while the user talks to it.
     * One that never does is archived a day after it began waiting, through the same archival every
     * other chat goes through, so Unsorted holds only the work somebody is still sorting. A chat
     * that never started out Unsorted, which is every chat a project or workspace holds, is not
     * swept at all.
     */
    async archiveExpiredUnsortedSessions(ctx: Context): Promise<boolean> {
        ctx = withDatabase(ctx, this.#database);
        if (this.#database.closed) return false;
        const unsortedBefore = this.#now() - UNSORTED_SESSION_ARCHIVE_AFTER_MS;
        const deadline = Date.now() + UNSORTED_SWEEP_MAX_MS;
        let archived = 0;
        while (archived < UNSORTED_SWEEP_MAX_SESSIONS && Date.now() <= deadline) {
            const expired = await queryExpiredUnsortedSessions(
                ctx,
                unsortedBefore,
                Math.min(UNSORTED_SWEEP_LIMIT, UNSORTED_SWEEP_MAX_SESSIONS - archived),
            );
            if (expired.length === 0) return false;
            for (const sessionId of expired) {
                if (this.#database.closed) return false;
                const session = await this.get(ctx, sessionId);
                if (session !== undefined) {
                    // An Unsorted root may be idle while one of its background agents is still
                    // running. Expiry is terminal for the whole retained tree, just like archiving
                    // the folder that owns one, so no hidden descendant keeps acting after the
                    // root disappears from Unsorted.
                    await session.recordFolderArchived(ctx);
                }
                archived += 1;
            }
            if (expired.length < UNSORTED_SWEEP_LIMIT) return false;
        }
        return true;
    }

    #armUnsortedSweepTimer(): void {
        // The first pass waits for the constructor to finish, the way other startup maintenance
        // does, so opening the store never blocks on working through a backlog of stale chats.
        this.#scheduleUnsortedSweep();
        this.#unsortedSweepTimer = setInterval(() => {
            void withWorkerContext("unsorted-session-sweep", async (ctx) =>
                this.#sweepUnsortedSessions(withDatabase(ctx, this.#database)),
            ).catch(rethrowDatabaseFailure);
        }, UNSORTED_SWEEP_INTERVAL_MS);
        this.#unsortedSweepTimer.unref();
    }

    async #sweepUnsortedSessions(ctx: Context): Promise<void> {
        try {
            if (await this.archiveExpiredUnsortedSessions(ctx)) this.#scheduleUnsortedSweep();
        } catch (error) {
            // Sweeping runs on its own, outside any request. A database that could not answer is
            // still fatal; one chat that refused to be put away must not take the daemon down.
            if (this.#database.closed) return;
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #scheduleUnsortedSweep(): void {
        if (this.#database.closed || this.#unsortedSweepFollowup !== undefined) return;
        this.#unsortedSweepFollowup = setImmediate(() => {
            this.#unsortedSweepFollowup = undefined;
            void withWorkerContext("unsorted-session-sweep-followup", async (ctx) =>
                this.#sweepUnsortedSessions(withDatabase(ctx, this.#database)),
            ).catch(rethrowDatabaseFailure);
        });
        this.#unsortedSweepFollowup.unref();
    }

    async pruneStaleToolResults(ctx: Context): Promise<boolean> {
        ctx = withDatabase(ctx, this.#database);
        if (this.#database.closed || this.#toolResultRetentionMs === undefined) return false;
        const before = this.#now() - this.#toolResultRetentionMs;
        const deadline = Date.now() + TOOL_RESULT_SWEEP_MAX_MS;
        let scanned = 0;
        while (scanned < TOOL_RESULT_SWEEP_MAX_SCANNED_MESSAGES && Date.now() <= deadline) {
            const page = await sessionPruneToolResults(ctx, {
                ...(this.#toolResultSweepCursor === undefined
                    ? {}
                    : { after: this.#toolResultSweepCursor }),
                before,
                limit: TOOL_RESULT_SWEEP_BATCH_LIMIT,
            });
            if (page.complete) {
                this.#toolResultSweepCursor = undefined;
                return false;
            }
            this.#toolResultSweepCursor = page.cursor;
            scanned += TOOL_RESULT_SWEEP_BATCH_LIMIT;
        }
        return true;
    }

    #armToolResultSweepTimer(): void {
        this.#toolResultSweepStopped = false;
        this.#scheduleToolResultSweep();
        this.#toolResultSweepTimer = setInterval(() => {
            void withWorkerContext("tool-result-sweep", (ctx) =>
                this.#sweepToolResults(withDatabase(ctx, this.#database)),
            ).catch(rethrowDatabaseFailure);
        }, TOOL_RESULT_SWEEP_INTERVAL_MS);
        this.#toolResultSweepTimer.unref();
    }

    async #sweepToolResults(ctx: Context): Promise<void> {
        if (this.#toolResultSweepStopped) return;
        try {
            const moreToolResults = await this.pruneStaleToolResults(ctx);
            if (moreToolResults) this.#scheduleToolResultSweep();
        } catch (error) {
            if (this.#database.closed) return;
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #scheduleToolResultSweep(): void {
        if (
            this.#toolResultSweepStopped ||
            this.#database.closed ||
            this.#toolResultSweepFollowup !== undefined
        )
            return;
        this.#toolResultSweepFollowup = setImmediate(() => {
            this.#toolResultSweepFollowup = undefined;
            void withWorkerContext("tool-result-sweep-followup", (ctx) =>
                this.#sweepToolResults(withDatabase(ctx, this.#database)),
            ).catch(rethrowDatabaseFailure);
        });
        this.#toolResultSweepFollowup.unref();
    }

    #stopToolResultSweep(): void {
        this.#toolResultSweepStopped = true;
        if (this.#toolResultSweepTimer !== undefined) {
            clearInterval(this.#toolResultSweepTimer);
            this.#toolResultSweepTimer = undefined;
        }
        if (this.#toolResultSweepFollowup !== undefined) {
            clearImmediate(this.#toolResultSweepFollowup);
            this.#toolResultSweepFollowup = undefined;
        }
    }

    async #deliverDueScheduledMessages(ctx: Context): Promise<void> {
        for (;;) {
            const next = await queryNextPendingScheduledMessage(ctx);
            if (next === undefined || next.dueAt > this.#now()) break;
            const sender = await this.get(ctx, next.senderSessionId);
            if (sender === undefined) {
                throw new Error("The sender of a scheduled message no longer exists.");
            }
            await sender.deliverScheduledMessage(ctx, next.id);
        }
        await this.#armScheduledMessageTimer(ctx);
    }

    async #appendEvent(ctx: Context, event: SessionEvent): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        if (isLiveOnlySessionEvent(event)) {
            await sessionAdvanceEventCursor(ctx, event.sessionId, event.id, this.#now());
            await this.#afterTransactionCommit(ctx, async (ctx) => {
                await this.#publishLiveStream(ctx, event);
                await this.#publishGlobalEvent(ctx, event);
                await this.#notifySessionEvent(ctx, event);
            });
            return;
        }
        const eventFacts = sessionEventFacts(event);
        const precommitted = this.#precommittedGlobalEvents.has(event.id);
        let globalEntry = this.#precommittedGlobalEvents.get(event.id) ?? undefined;
        this.#precommittedGlobalEvents.delete(event.id);
        let inserted = false;
        await this.#transaction(ctx, async (ctx) => {
            inserted =
                (await sessionAppendEvent(ctx, event, eventFacts, this.#now())) === "inserted";
            if (!precommitted && inserted && this.#globalEventQueue.durable) {
                globalEntry = await this.#globalEventQueue.append(ctx, event);
            }
        });
        // The live stream carries this event whether or not the durable log
        // keeps it, but never before the row it describes is committed.
        await this.#afterTransactionCommit(ctx, (ctx) => this.#publishLiveStream(ctx, event));
        if (this.#globalEventQueue.durable && globalEntry !== undefined) {
            const queue = this.#globalEventQueue;
            await this.#afterTransactionCommit(ctx, () => queue.publish(globalEntry!));
        } else if (
            (inserted || precommitted) &&
            !this.#globalEventQueue.durable &&
            shouldPublishGlobalEvent(event)
        ) {
            const queue = this.#globalEventQueue;
            await this.#afterTransactionCommit(ctx, async (ctx) => {
                const entry = await queue.append(ctx, event);
                if (entry !== undefined) queue.publish(entry);
            });
        }
        await this.#afterTransactionCommit(ctx, (ctx) => this.#notifySessionEvent(ctx, event));
    }

    /**
     * Puts an event on the ephemeral stream every local client follows.
     *
     * Session events arrive here through `#appendEvent`, which has already done
     * this, so only the rest are forwarded from `#publishGlobalEvent`.
     */
    async #publishLiveStream(ctx: Context, event: GlobalEvent): Promise<void> {
        const queue = this.liveEvents;
        await this.#afterTransactionCommit(ctx, () => {
            queue.publish(event);
        });
    }

    async #projectEvent(ctx: Context, event: GlobalEvent): Promise<void> {
        await this.#publishGlobalEvent(ctx, event);
        if (event.type !== "workspace_created" && event.type !== "workspace_updated") return;
        if (event.data.workspace.status === "initializing") return;
        await this.#afterTransactionCommit(ctx, async (ctx) => {
            await this.#workspaceReadyWaiters.changed(event.projectId, event.workspaceId);
        });
    }

    async #publishGlobalEvent(ctx: Context, event: GlobalEvent): Promise<void> {
        if (!("sessionId" in event)) await this.#publishLiveStream(ctx, event);
        if (isLiveGlobalEvent(event)) {
            const queue = this.#globalEventQueue;
            await this.#afterTransactionCommit(ctx, () => {
                queue.publishLive(event);
            });
            return;
        }
        if (!shouldPublishGlobalEvent(event)) return;
        const queue = this.#globalEventQueue;
        if (!queue.durable) {
            await this.#afterTransactionCommit(ctx, async (ctx) => {
                const entry = await queue.append(ctx, event);
                if (entry !== undefined) queue.publish(entry);
            });
            return;
        }
        const entry = await queue.append(ctx, event);
        if (entry !== undefined) {
            await this.#afterTransactionCommit(ctx, () => queue.publish(entry));
        }
    }

    async #notifySessionAccess(ctx: Context, session: InMemorySession): Promise<void> {
        // Observers own their own database connections. One that writes while this store still
        // holds the write lock would wait for a transaction that cannot commit until the observer
        // returns, so every notification waits for the commit.
        await this.#afterTransactionCommit(ctx, () => {
            try {
                this.#onSessionAccess?.(session);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                // External synchronization must never interrupt local session access.
            }
        });
    }

    async #notifySessionEvent(ctx: Context, event: SessionEvent): Promise<void> {
        try {
            await this.#onSessionEvent?.(event, this.#sessions.get(event.sessionId)?.deref());
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            // The event is already durable; optional observers cannot roll it back.
        }
    }

    async #loadSecretRegistrations(ctx: Context): Promise<void> {
        const loaded = await querySecretRegistrations(ctx);
        for (const registration of loaded.registrations) this.#secrets.register(registration);
        for (const variable of loaded.environmentVariables) {
            this.#secrets.rememberEnvironmentVariables(variable.secretId, [variable.name]);
        }
    }

    async #inheritWorkspaceName(
        ctx: Context,
        metadata: Parameters<NonNullable<InMemorySessionOptions["onInitialTitle"]>>[0],
    ): Promise<void> {
        const firstSessionId = await queryFirstRootSessionIdForWorkspace(
            ctx,
            metadata.projectId,
            metadata.workspaceId,
        );
        if (firstSessionId !== metadata.sessionId) return;
        await this.#projects.inheritWorkspaceName(
            ctx,
            metadata.projectId,
            metadata.workspaceId,
            metadata.title,
        );
    }

    #inheritWorkspaceNameInWorker(
        metadata: Parameters<NonNullable<InMemorySessionOptions["onInitialTitle"]>>[0],
    ): Promise<void> {
        return withWorkerContext(
            "session-initial-title",
            (workerCtx) =>
                this.#inheritWorkspaceName(withDatabase(workerCtx, this.#database), metadata),
            { sessionId: metadata.sessionId },
        );
    }

    async #loadSession(ctx: Context, sessionId: string): Promise<InMemorySession | undefined> {
        const loaded = await querySessionRestore(ctx, sessionId);
        if (loaded === undefined) return undefined;
        const ownerInstanceId = validOwnerInstanceId(loaded.restore.ownerInstanceId);
        const folderPath =
            loaded.restore.scope.kind === "folder"
                ? await this.#folders.folderStoragePath(ctx, loaded.restore.scope.folderId)
                : undefined;
        const request =
            folderPath === undefined
                ? loaded.request
                : (() => {
                      const { docker: _docker, ...request } = loaded.request;
                      return { ...request, cwd: folderPath };
                  })();
        const restore =
            folderPath === undefined
                ? loaded.restore
                : (() => {
                      const { docker: _docker, ...restore } = loaded.restore;
                      return { ...restore, cwd: folderPath };
                  })();
        const session = await InMemorySession.open(ctx, {
            presence: this.presence,
            workspaceFeatures: this.#workspaceFeatures,
            workspaceRunReadiness: (target) =>
                withWorkerContext("workspace-run-readiness", (workerCtx) =>
                    workspaceRunReadiness(workerCtx, this.#projects, target),
                ),
            createEventId: createEventIdFactory(
                loaded.lastEventId === undefined ? {} : { after: loaded.lastEventId },
            ),
            deferEventNotification: (eventCtx, notify) =>
                this.#afterTransactionCommit(eventCtx, notify),
            events: await querySessionEvents(ctx, sessionId, {
                maxBytes: RESTORED_SESSION_EVENT_BYTES,
                maxCount: RESTORED_SESSION_EVENT_LIMIT,
            }),
            ...(loaded.lastEventId === undefined ? {} : { lastEventId: loaded.lastEventId }),
            modelCatalog: this.#modelCatalogFor(ownerInstanceId),
            now: this.#now,
            onInitialTitle: (metadata) => this.#inheritWorkspaceNameInWorker(metadata),
            onAppendEvent: (eventCtx, event) => this.#appendEvent(eventCtx, event),
            publishLiveEvent: (_eventCtx, event) => this.liveEvents.publish(event),
            persistence: this,
            folders: this.#folders,
            slotStores: { entries: this.slots, applets: this.applets },
            ...(loaded.restore.scope.kind === "project" || loaded.restore.scope.kind === "workspace"
                ? {
                      projectSecretIds: await queryProjectSecretIds(
                          ctx,
                          loaded.restore.scope.projectId,
                      ),
                  }
                : {}),
            ownerInstanceId,
            resolveGitAuthentication: async (projectId, creator) =>
                await this.#projects.gitAuthentication(projectId, creator),
            resolveProfile: async (profileId) =>
                withWorkerContext("session-profile-resolve", (workerCtx) =>
                    queryRigProfile(withDatabase(workerCtx, this.#database), profileId),
                ),
            request,
            secretRegistry: this.#secrets,
            restore,
            scope: loaded.restore.scope,
            ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
        });
        const resolved = session.state();
        if (
            resolved.modelId !== restore.modelId ||
            resolved.providerId !== restore.providerId ||
            resolved.effort !== restore.effort
        ) {
            await this.saveSession(ctx, resolved);
        }
        return session;
    }

    #cacheSession(session: InMemorySession): void {
        const previous = this.#sessions.get(session.id);
        if (previous !== undefined) this.#sessionFinalizer.unregister(previous);
        const reference = new WeakRef(session);
        this.#sessions.set(session.id, reference);
        this.#sessionFinalizer.register(session, { id: session.id, reference }, reference);
    }

    #modelCatalogFor(ownerInstanceId: string): ModelCatalog {
        return ownerInstanceId === this.localInstanceId
            ? this.#modelCatalog
            : this.#resolveModelCatalog(ownerInstanceId);
    }

    #cachedSessions(): InMemorySession[] {
        const sessions: InMemorySession[] = [];
        for (const [id, reference] of this.#sessions) {
            const session = reference.deref();
            if (session === undefined) {
                this.#sessions.delete(id);
                this.#sessionFinalizer.unregister(reference);
                continue;
            }
            sessions.push(session);
        }
        return sessions;
    }

    #cachedSession(sessionId: string): InMemorySession | undefined {
        const reference = this.#sessions.get(sessionId);
        const session = reference?.deref();
        if (session === undefined && reference !== undefined) this.#sessions.delete(sessionId);
        return session;
    }

    async #loadAgentTree(ctx: Context, session: InMemorySession): Promise<void> {
        if (session.isSubagent()) return;
        for (const sessionId of await queryAgentTreeSessionIds(ctx, session.id)) {
            if (sessionId === session.id) continue;
            const cached = this.#cachedSession(sessionId);
            if (cached !== undefined) continue;
            const child = await this.#loadSession(ctx, sessionId);
            if (child !== undefined) this.#cacheSession(child);
        }
    }

    async #newLastSessionOrderKey(ctx: Context, scope: SessionScope): Promise<string> {
        const items = await this.#sessionOrderItems(ctx, scope);
        return generateKeyBetween(items.at(-1)?.orderKey ?? null, null);
    }

    #assertWorkspaceAcceptingSessions(workspaceId: string): void {
        if (this.#workspaceTransferReservations.has(workspaceId)) {
            throw new Error(
                "That workspace is receiving a session transfer and cannot start another session yet.",
            );
        }
    }

    #reserveWorkspaceTransferTarget(workspaceId: string, sessionId: string): void {
        const owner = this.#workspaceTransferReservations.get(workspaceId);
        if (owner !== undefined && owner !== sessionId) {
            throw new Error("That workspace is already reserved for another session transfer.");
        }
        this.#workspaceTransferReservations.set(workspaceId, sessionId);
    }

    #releaseWorkspaceTransferTarget(workspaceId: string, sessionId: string): void {
        if (this.#workspaceTransferReservations.get(workspaceId) === sessionId) {
            this.#workspaceTransferReservations.delete(workspaceId);
        }
    }

    async #sessionOrderItems(
        ctx: Context,
        scope: SessionScope,
    ): Promise<{ id: string; orderKey: string }[]> {
        return await querySessionOrderItems(ctx, scope);
    }

    async #transcriptWindowForMessages(
        ctx: Context,
        sessionId: string,
        messages: readonly PersistedSessionMessage[],
        turnLimit: number,
        complete: boolean,
        noticesTruncated: boolean,
    ): Promise<SessionTranscriptWindow | undefined> {
        const events = await querySessionTranscriptEvents(ctx, sessionId, messages);
        const eventLog = new SessionEventLog({
            events,
            retentionLimit: Number.MAX_SAFE_INTEGER,
        });
        const entries = messages
            .filter((entry) => !entry.isPartial)
            .map((entry): TranscriptEntry => {
                const createdAt = eventLog.messageCreatedAt(entry.message.id);
                const eventId = eventLog.messageEventId(entry.message.id);
                const steeredAt = eventLog.messageSteeredAt(entry.message.id);
                return {
                    ...(createdAt === undefined ? {} : { createdAt }),
                    ...(eventId === undefined ? {} : { eventId }),
                    message: entry.message,
                    ...(entry.runId === undefined ? {} : { runId: entry.runId }),
                    ...(steeredAt === undefined ? {} : { steeredAt }),
                };
            });
        const window = sessionTranscriptWindow(
            entries,
            transcriptRunFacts(events),
            turnLimit,
            undefined,
        );
        if (window === undefined) return undefined;
        const toolCallIds = new Set(
            window.messages.flatMap((message) =>
                message.blocks.flatMap((block) => (block.type === "tool_call" ? [block.id] : [])),
            ),
        );
        const permissionReviews = eventLog.permissionReviews(toolCallIds);
        return {
            ...window,
            complete,
            ...(noticesTruncated ? { noticesTruncated: true } : {}),
            ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
        };
    }

    /**
     * The container environment a scope's terminals run in, or `undefined`.
     *
     * The same answer `#remoteTerminalContext` computes, exposed because peer
     * access has to ask it before it will mirror a terminal to anybody: a
     * terminal with no container is a terminal that can read the owner's
     * credentials. Asking the one resolver rather than re-deriving it keeps that
     * decision from drifting away from what the terminal actually got.
     *
     * Returns `undefined` rather than throwing for a scope that cannot open a
     * terminal at all, because "no container here" is the answer that fails
     * closed either way.
     */
    async remoteTerminalDocker(
        ctx: Context,
        scope: RemoteTerminalScope,
    ): Promise<DockerExecutionConfig | undefined> {
        ctx = withDatabase(ctx, this.#database);
        try {
            return (await this.#remoteTerminalContext(ctx, scope)).docker;
        } catch {
            return undefined;
        }
    }

    async #remoteTerminalContext(
        ctx: Context,
        scope: RemoteTerminalScope,
    ): Promise<ProjectRemoteTerminalContext> {
        const project = await this.#projects.getProject(ctx, scope.projectId);
        if (project === undefined) throw new Error("Project not found.");
        if (project.archivedAt !== undefined) {
            throw new Error("Archived projects cannot open terminals.");
        }
        const workspace =
            scope.workspaceId === undefined
                ? undefined
                : await this.#projects.getWorkspace(ctx, scope.projectId, scope.workspaceId);
        if (scope.workspaceId !== undefined && workspace === undefined) {
            throw new Error("Workspace not found.");
        }
        if (
            workspace !== undefined &&
            (
                await workspaceRunReadiness(ctx, this.#projects, {
                    cwd: workspace.path,
                    projectId: workspace.projectId,
                    workspaceId: workspace.id,
                })
            ).state !== "ready"
        ) {
            throw new Error("Only ready, available workspaces can open terminals.");
        }
        const cwd = workspace?.path ?? project.path;
        const docker = (
            await configureSessionRequest(
                { cwd },
                this.#defaultDocker,
                async () => await this.#projects.queryProjectSettings(ctx, cwd),
            )
        ).docker;
        return {
            cwd,
            ...(docker === undefined ? {} : { docker }),
        };
    }

    async #projectSecrets(ctx: Context, projectId: string): Promise<readonly string[]> {
        return await queryProjectSecretIds(ctx, projectId);
    }

    async #recoverProjectWorkspaces(ctx: Context): Promise<void> {
        // Each step resumes after an await, by which point the store may have been closed. Asking a
        // connection that is already gone would fail for a reason that is not a database fault.
        if (this.#database.closed) return;
        for (const workspace of await this.#projects.listWorkspaces(ctx)) {
            if (workspace.status !== "archiving") continue;
            if (this.#database.closed) return;
            await this.#archiveWorkspace(ctx, workspace.projectId, workspace.id);
        }
        if (this.#database.closed) return;
        await this.#projects.reconcileInitializingWorkspaces(ctx);
        if (this.#database.closed) return;
        // Presence and Git facts are enrichment, so they run only after archival recovery, which is
        // user-visible correctness.
        await this.#projects.reconcileGitFacts(ctx);
    }

    async #repairInterruptedTitleGenerations(ctx: Context): Promise<void> {
        await sessionRepairInterruptedTitles(ctx, this.#now());
    }

    /**
     * Background work outlives the store that started it, so a session can still try to save after
     * shutdown closed the connection. Asking a closed connection reports that it is not open, which
     * is indistinguishable from a real fault once it escapes. Refusing here keeps a deliberate
     * shutdown from being mistaken for a database that could not answer.
     */
    #assertOpen(): void {
        if (!this.#database.closed) return;
        throw new Error("The session database is closed.");
    }

    async #transaction<T>(ctx: Context, body: (ctx: Context) => T | Promise<T>): Promise<T> {
        this.#assertOpen();
        if (isSessionDatabaseTransaction(getDatabaseScope(ctx))) return await body(ctx);
        ctx = withDatabase(ctx, this.#database);
        return await runSessionTransaction(ctx, body);
    }

    #afterTransactionCommit(
        ctx: Context,
        callback: (ctx: Context) => void | Promise<void>,
    ): Promise<void> {
        const postCommitCtx = withDatabase(ctx, this.#database);
        return deferSessionTransactionCommit(() => callback(postCommitCtx), this.#database);
    }

    afterTransactionCommit(
        ctx: Context,
        callback: (ctx: Context) => void | Promise<void>,
    ): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        return this.#afterTransactionCommit(ctx, callback);
    }
}

function sessionEventFacts(event: SessionEvent): {
    messageId?: string;
    runId?: string;
    toolCallId?: string;
} {
    const data = event.data as unknown as Record<string, unknown>;
    const message =
        typeof data.message === "object" && data.message !== null
            ? (data.message as Record<string, unknown>)
            : undefined;
    const inner =
        typeof data.event === "object" && data.event !== null
            ? (data.event as Record<string, unknown>)
            : undefined;
    return {
        ...(typeof message?.id === "string" ? { messageId: message.id } : {}),
        ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
        ...(typeof inner?.toolCallId === "string" ? { toolCallId: inner.toolCallId } : {}),
    };
}

function persistentCodeScope(
    scope: SessionScope,
): Extract<SessionScope, { kind: "project" | "workspace" }> {
    if (scope.kind === "project" || scope.kind === "workspace") return scope;
    throw new Error("This operation is available only for project or workspace chats.");
}

function validOwnerInstanceId(value: string): string {
    if (!Value.Check(p2pInstanceIdSchema, value)) {
        throw new Error("The session owner Rig identity is invalid.");
    }
    return value;
}
