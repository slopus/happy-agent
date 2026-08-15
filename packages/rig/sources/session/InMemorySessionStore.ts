import { createId } from "@paralleldrive/cuid2";
import type { Context } from "@steve.kite/stdlib";

import { createEventIdFactory, isLiveGlobalEvent } from "../protocol/index.js";
import { Value } from "@sinclair/typebox/value";
import type { Message } from "../agent/types.js";
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
    Folder,
    FolderItem,
    GetTimelineRequest,
    GitRepositoryFacts,
    GlobalEvent,
    ModelCatalog,
    ListDocumentUpdatesRequest,
    MoveFolderItemRequest,
    MoveFolderRequest,
    Project,
    ProjectCreator,
    ProjectSettingsUpdate,
    ProjectWorkspace,
    ReorderRequest,
    RegisterProjectRequest,
    RegisterSecretRequest,
    SecretSummary,
    SessionAgentMetadata,
    SessionSummary,
    SharedFolderState,
    SessionScope,
    SubagentSummary,
    TimelineAgent,
    TimelineScope,
    TransferSessionRequest,
    TransferSessionResponse,
    UpdateFolderRequest,
    WriteDocumentRequest,
    UpdateSecretRequest,
} from "../protocol/index.js";
import { InMemorySession, type InMemorySessionOptions } from "./InMemorySession.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import { retriedSession } from "./retriedSession.js";
import type { SessionCreationOptions, SessionStore } from "./SessionStore.js";
import { p2pInstanceIdSchema } from "../protocol/P2pIdentityProtocol.js";
import {
    SecretRegistry,
    type EnvironmentSecretRegistration,
    type SpecialSecretKind,
    type SpecialSecretRegistration,
} from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type { TX } from "../persistence/Transaction.js";
import { withDatabase } from "../persistence/databaseContext.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../persistence/database/migrateSessionDatabase.js";
import { queryRigDataEpoch } from "../persistence/database/queryRigDataEpoch.js";
import { querySessionDatabaseVersion } from "../persistence/database/querySessionDatabaseVersion.js";
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
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import { shouldPublishGlobalEvent } from "../global-event/shouldPublishGlobalEvent.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";
import {
    ProjectRemoteTerminalStore,
    type ProjectRemoteTerminalContext,
    type RemoteTerminalScope,
} from "../terminal/index.js";
import type { DurableUserInputCall } from "../user-input/index.js";
import { PresenceStore, resolvePresences } from "../presence/index.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { buildTimeline, isTimelineEventType } from "../timeline/index.js";
import { sessionOrderKeyForCreation } from "./impl/sessionOrderKeyForCreation.js";
import { timelineAgentSource } from "./impl/timelineAgentSource.js";
import { queryLiveAgentTreeUsage } from "./queryLiveAgentTreeUsage.js";
import { SlotEntryStore } from "../slots/index.js";
import { AppletStore } from "../applets/index.js";
import { WorkletStore } from "../worklets/index.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { configureSessionRequest } from "./configureSessionRequest.js";
import {
    executeSessionWorkspaceTransfer,
    scheduleSessionWorkspaceTransfer,
} from "./transferSessionWorkspace.js";
import { workspaceRunReadiness } from "./workspaceRunReadiness.js";
import { queryRigProfile } from "../persistence/profile/queryRigProfiles.js";
import { createWorkspaceReadyWaiters } from "./workspaceReadyWaiters.js";
import { withWorkerContext } from "../observability/index.js";
import {
    deferSessionTransactionCommit,
    isSessionTransactionPostCommitError,
    runSessionTransaction,
} from "./SessionTransactionContext.js";

export interface InMemorySessionStoreOptions {
    projectClone?: ProjectRepositoryOptions["cloneRemote"];
    defaultDocker?: DockerExecutionConfig;
    localInstanceId?: string;
    modelCatalog?: ModelCatalog;
    resolveModelCatalog?: (ownerInstanceId: string) => ModelCatalog;
    onWorkspaceBranchError?: (error: unknown, projectId: string, workspaceId: string) => void;
    onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
    presence?: PresenceStore;
    secrets?: readonly EnvironmentSecretRegistration[];
    homeDirectory?: string;
    gitCredentialBroker?: ProjectRepositoryOptions["gitCredentialBroker"];
    stateDirectory?: string;
    workspacesDirectory?: string;
}

type WorkspaceArchiveTeardown = (ctx: Context) => Promise<void>;

export class InMemorySessionStore implements SessionStore {
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    #modelCatalog: ModelCatalog;
    readonly localInstanceId: string;
    readonly #resolveModelCatalog: (ownerInstanceId: string) => ModelCatalog;
    #onWorkspaceCleanupError:
        | ((error: unknown, projectId: string, workspaceId: string) => void)
        | undefined;
    #projectSecretIds = new Map<string, Set<string>>();
    readonly #database: SessionDatabase;
    readonly #createPresenceEventId = createEventIdFactory();
    readonly #createTerminalEventId = createEventIdFactory();
    readonly #folders: FolderRepository;
    readonly #documents: DocumentRepository;
    readonly #projects: ProjectRepository;
    #workspaceReadyWaiters!: ReturnType<typeof createWorkspaceReadyWaiters>;
    readonly dataEpoch: string;
    readonly dataSchemaVersion: number;
    readonly globalEventQueue = new InMemoryGlobalEventQueue();
    readonly liveEvents = new LiveGlobalEventQueue();
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    readonly slots: SlotEntryStore;
    readonly applets: AppletStore;
    readonly worklets: WorkletStore;
    #secrets: SecretRegistry;
    #sessions = new Map<string, InMemorySession>();
    readonly #workspaceArchiveCleanups = new Set<Promise<unknown>>();
    readonly #workspaceTransferReservations = new Map<string, string>();
    static async open(
        ctx: Context,
        options: InMemorySessionStoreOptions = {},
    ): Promise<InMemorySessionStore> {
        const opened = await openSessionDatabase(ctx, ":memory:");
        const databaseCtx = withDatabase(ctx, opened.database);
        try {
            const localInstanceId = validOwnerInstanceId(options.localInstanceId ?? createId());
            await migrateSessionDatabase(databaseCtx, { localInstanceId });
            const dataEpoch = await queryRigDataEpoch(databaseCtx);
            const dataSchemaVersion = await querySessionDatabaseVersion(databaseCtx);
            if (dataSchemaVersion !== CURRENT_SESSION_DATABASE_VERSION) {
                throw new Error(
                    "The in-memory Rig store did not reach the current schema version.",
                );
            }
            return new InMemorySessionStore(
                ctx,
                options,
                opened,
                localInstanceId,
                dataEpoch,
                dataSchemaVersion,
            );
        } catch (error) {
            await opened.database.close(databaseCtx);
            throw error;
        }
    }

    private constructor(
        ctx: Context,
        options: InMemorySessionStoreOptions,
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
        this.applets = new AppletStore({
            database: this.#database,
            publish: (publishCtx, event) => this.#publishGlobalEvent(publishCtx, event),
        });
        this.worklets = new WorkletStore({ database: this.#database });
        this.slots = new SlotEntryStore({
            database: this.#database,
            publish: (publishCtx, event) => this.#publishGlobalEvent(publishCtx, event),
            sessionExists: (_ctx, sessionId) => this.#sessions.has(sessionId),
        });
        this.#projects = new ProjectRepository({
            afterTransactionCommit: (_ctx, callback) => this.#afterTransactionCommit(callback),
            ...(options.projectClone === undefined ? {} : { cloneRemote: options.projectClone }),
            database: this.#database,
            ...(options.gitCredentialBroker === undefined
                ? {}
                : { gitCredentialBroker: options.gitCredentialBroker }),
            localInstanceId: this.localInstanceId,
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (eventCtx, event) => this.#projectEvent(eventCtx, event),
            resolveGitSecret: (kind) => this.#secrets.resolveSpecial(kind).GH_TOKEN,
            resolveProfile: (profileId) =>
                withWorkerContext("project-profile", (workerCtx) =>
                    queryRigProfile(withDatabase(workerCtx, this.#database), profileId),
                ),
            ...(options.onWorkspaceBranchError === undefined
                ? {}
                : { onWorkspaceBranchError: options.onWorkspaceBranchError }),
            ...(options.onWorkspaceCleanupError === undefined
                ? {}
                : { onWorkspaceCleanupError: options.onWorkspaceCleanupError }),
            ...(options.stateDirectory === undefined
                ? {}
                : { stateDirectory: options.stateDirectory }),
            transaction: (transactionCtx, body) => this.#transaction(transactionCtx, body),
            ...(options.workspacesDirectory === undefined
                ? {}
                : { workspacesDirectory: options.workspacesDirectory }),
        });
        this.#folders = new FolderRepository({
            database: this.#database,
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (eventCtx, event) => this.#publishGlobalEvent(eventCtx, event),
            onFolderContextChanged: async (_eventCtx, folderIds) => {
                await this.#afterTransactionCommit(() => {
                    const affected = new Set(folderIds);
                    for (const session of this.#sessions.values()) {
                        if (session.belongsToFolderContext(affected))
                            session.folderContextChanged();
                    }
                });
            },
            onSessionsArchived: async (eventCtx, sessionIds) => {
                await this.#afterTransactionCommit(async () => {
                    await Promise.all(
                        sessionIds.flatMap((sessionId) => {
                            const session = this.#sessions.get(sessionId);
                            return session === undefined
                                ? []
                                : [session.recordFolderArchived(eventCtx)];
                        }),
                    );
                });
            },
            transaction: (transactionCtx, body) => this.#transaction(transactionCtx, body),
        });
        this.#documents = new DocumentRepository({
            database: this.#database,
            onEvent: (eventCtx, event) => this.#publishGlobalEvent(eventCtx, event),
            transaction: (transactionCtx, body) => this.#transaction(transactionCtx, body),
        });
        this.#workspaceReadyWaiters = createWorkspaceReadyWaiters((projectId, workspaceId) =>
            withWorkerContext("workspace-ready", (workerCtx) =>
                this.#projects.getWorkspace(workerCtx, projectId, workspaceId),
            ),
        );
        this.remoteTerminals = new ProjectRemoteTerminalStore({
            onChange: (_eventCtx, scope, terminals) => {
                const event = {
                    createdAt: Date.now(),
                    data: { terminals },
                    id: this.#createTerminalEventId(),
                    projectId: scope.projectId,
                    type: "remote_terminals_changed" as const,
                    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
                };
                this.globalEventQueue.publishLive(event);
                this.liveEvents.publish(event);
            },
            resolveContext: (terminalCtx, scope) => this.#remoteTerminalContext(terminalCtx, scope),
        });
        this.presence = options.presence ?? new PresenceStore({ presences: resolvePresences() });
        this.presence.onChange((state) => {
            for (const session of this.#sessions.values()) session.presenceChanged(state);
            const event = {
                createdAt: Date.now(),
                data: { presence: state },
                id: this.#createPresenceEventId(),
                type: "presence_changed" as const,
            };
            this.globalEventQueue.publishLive(event);
            this.liveEvents.publish(event);
        });
        this.#secrets = new SecretRegistry(options.secrets);
        this.#modelCatalog = this.#resolveModelCatalog(this.localInstanceId);
        this.#onWorkspaceCleanupError = options.onWorkspaceCleanupError;
        this.#defaultDocker = options.defaultDocker;
    }

    async changeEffort(
        ctx: Context,
        sessionId: string,
        request: ChangeEffortRequest,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(ctx, sessionId);
        if (session === undefined) {
            return undefined;
        }

        await session.changeEffort(ctx, request);
        return session;
    }

    async #configureWorkspaceRequest(
        ctx: Context,
        request: CreateSessionRequest,
    ): Promise<CreateSessionRequest> {
        const { docker: _docker, local: _local, ...base } = request;
        return await configureSessionRequest(base, this.#defaultDocker, () =>
            this.#projects.queryProjectSettings(ctx, request.cwd),
        );
    }

    async attachSecret(
        ctx: Context,
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        this.#secrets.reference(secretId);
        if (scope === "project") {
            const projectId = codeScope(session.snapshot().scope).projectId;
            const ids = this.#projectSecretIds.get(projectId) ?? new Set<string>();
            ids.add(secretId);
            this.#projectSecretIds.set(projectId, ids);
            for (const candidate of this.#sessions.values()) {
                if (codeScopeOrUndefined(candidate.snapshot().scope)?.projectId === projectId) {
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

    async changeServiceTier(
        ctx: Context,
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        await session.changeServiceTier(ctx, request);
        return session;
    }

    async create(
        ctx: Context,
        request: CreateSessionRequest,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
        return await this.#createSession(ctx, request, undefined, undefined, undefined, options);
    }

    async createWithId(
        ctx: Context,
        id: string,
        request: CreateSessionRequest,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
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
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = codeScope(session.snapshot().scope).projectId;
            this.#projectSecretIds.get(projectId)?.delete(secretId);
            for (const candidate of this.#sessions.values()) {
                if (codeScopeOrUndefined(candidate.snapshot().scope)?.projectId === projectId) {
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
        const session = await InMemorySession.open(ctx, {
            presence: this.presence,
            workspaceRunReadiness: (target) => workspaceRunReadiness(ctx, this.#projects, target),
            createEventId: createEventIdFactory(),
            ...(targetSessionId === undefined ? {} : { id: targetSessionId }),
            modelCatalog: this.#modelCatalogFor(state.ownerInstanceId),
            onInitialTitle: (metadata) => this.#inheritWorkspaceName(ctx, metadata),
            request: forkRequest,
            onAppendEvent: (eventCtx, event) => this.#publishGlobalEvent(eventCtx, event),
            publishLiveEvent: (_eventCtx, event) => this.liveEvents.publish(event),
            folders: this.#folders,
            slotStores: { entries: this.slots, applets: this.applets },
            ...(sourceSnapshot.scope.kind === "project" || sourceSnapshot.scope.kind === "workspace"
                ? { projectSecretIds: this.#projectSecrets(sourceSnapshot.scope.projectId) }
                : {}),
            ownerInstanceId: state.ownerInstanceId,
            ...(state.profileId === undefined ? {} : { profileId: state.profileId }),
            resolveGitAuthentication: (projectId, creator) =>
                this.#projects.gitAuthentication(projectId, creator),
            resolveProfile: (profileId) =>
                queryRigProfile(withDatabase(ctx, this.#database), profileId),
            secretRegistry: this.#secrets,
            restore: {
                ...forkState,
                ...(targetSessionId === undefined
                    ? {}
                    : {
                          agent: { ...forkState.agent, rootSessionId: targetSessionId },
                          id: targetSessionId,
                      }),
                orderKey: this.#newLastSessionOrderKey(sourceSnapshot.scope),
            },
            scope: sourceSnapshot.scope,
        });
        this.#sessions.set(session.id, session);
        await session.emitCreatedEvent(ctx);
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
        const sessionId = id ?? createId();
        let newUnsortedStorage: { created: boolean; path: string } | undefined;
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
            const profile = await queryRigProfile(withDatabase(ctx, this.#database), profileId);
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
                const project = codeScope(inherited.scope);
                const ownership = await this.#projects.resolve(
                    ctx,
                    request.cwd,
                    request.workspaceId,
                    project.projectId,
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
        try {
            if (resolved.scope.kind === "workspace") {
                this.#assertWorkspaceAcceptingSessions(resolved.scope.workspaceId);
            }
            const projectId =
                resolved.scope.kind === "project" || resolved.scope.kind === "workspace"
                    ? resolved.scope.projectId
                    : undefined;
            const session = await InMemorySession.open(ctx, {
                presence: this.presence,
                workspaceRunReadiness: (target) =>
                    workspaceRunReadiness(ctx, this.#projects, target),
                createEventId: createEventIdFactory(),
                modelCatalog: this.#modelCatalogFor(ownerInstanceId),
                onInitialTitle: (metadata) => this.#inheritWorkspaceName(ctx, metadata),
                ...(metadata !== undefined ? { metadata } : {}),
                ...(contextMessages !== undefined
                    ? { initialContextMessages: contextMessages }
                    : {}),
                id: sessionId,
                onAppendEvent: (eventCtx, event) => this.#publishGlobalEvent(eventCtx, event),
                publishLiveEvent: (_eventCtx, event) => this.liveEvents.publish(event),
                orderKey: sessionOrderKeyForCreation(metadata?.type, () =>
                    this.#newLastSessionOrderKey(resolved.scope),
                ),
                ownerInstanceId,
                ...(profileId === undefined ? {} : { profileId }),
                resolveGitAuthentication: (candidateProjectId, creator) =>
                    this.#projects.gitAuthentication(candidateProjectId, creator),
                resolveProfile: (candidateProfileId) =>
                    queryRigProfile(withDatabase(ctx, this.#database), candidateProfileId),
                ...(projectId === undefined
                    ? {}
                    : { projectSecretIds: this.#projectSecrets(projectId) }),
                request: resolved.request,
                scope: resolved.scope,
                secretRegistry: this.#secrets,
                folders: this.#folders,
                slotStores: { entries: this.slots, applets: this.applets },
            });
            this.#sessions.set(session.id, session);
            return session;
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
    }

    #modelCatalogFor(ownerInstanceId: string): ModelCatalog {
        return ownerInstanceId === this.localInstanceId
            ? this.#modelCatalog
            : this.#resolveModelCatalog(ownerInstanceId);
    }

    async #inheritWorkspaceName(
        ctx: Context,
        metadata: Parameters<NonNullable<InMemorySessionOptions["onInitialTitle"]>>[0],
    ): Promise<void> {
        const first = [...this.#sessions.values()]
            .filter((session) => {
                const identity = session.projectIdentity();
                return (
                    !session.isSubagent() &&
                    identity !== undefined &&
                    identity.projectId === metadata.projectId &&
                    identity.workspaceId === metadata.workspaceId
                );
            })
            .sort(
                (left, right) =>
                    left.summary().createdAt - right.summary().createdAt ||
                    left.id.localeCompare(right.id),
            )[0];
        if (first?.id !== metadata.sessionId) return;
        await this.#projects.inheritWorkspaceName(
            ctx,
            metadata.projectId,
            metadata.workspaceId,
            metadata.title,
        );
    }

    async get(
        ctx: Context,
        sessionId: string,
        _options: { loadAgentTree?: boolean } = {},
    ): Promise<InMemorySession | undefined> {
        return this.#sessions.get(sessionId);
    }

    async attachment(ctx: Context, sessionId: string, attachmentId: string) {
        return (await this.get(ctx, sessionId))?.attachment(attachmentId);
    }

    async findByAgentId(ctx: Context, agentId: string): Promise<InMemorySession | undefined> {
        const matches = [...this.#sessions.values()].filter(
            (session) => session.agentIdentity().agentId === agentId,
        );
        return matches.length === 1 ? matches[0] : undefined;
    }

    async list(ctx: Context, options: { limit?: number } = {}): Promise<readonly SessionSummary[]> {
        const projectOrder = new Map(
            (await this.#projects.listProjects(ctx)).map((project) => [
                project.id,
                project.orderKey,
            ]),
        );
        const workspaceOrder = new Map(
            (await this.#projects.listWorkspaces(ctx)).map((workspace) => [
                workspace.id,
                workspace.orderKey,
            ]),
        );
        const sessions = positioned(
            [...this.#sessions.values()]
                .filter((session) => !session.isSubagent())
                .map((session) => session.summary()),
        ).sort((left, right) => sortSummariesByOrder(left, right, projectOrder, workspaceOrder));
        return options.limit === undefined ? sessions : sessions.slice(0, options.limit);
    }

    async listActive(
        ctx: Context,
        options: { limit?: number } = {},
    ): Promise<readonly SessionSummary[]> {
        const sessions = (await this.list(ctx)).filter((session) => !session.archived);
        return options.limit === undefined ? sessions : sessions.slice(0, options.limit);
    }

    loadedSessions(): readonly InMemorySession[] {
        return [...this.#sessions.values()];
    }

    async listDurableUserInputs(ctx: Context): Promise<readonly DurableUserInputCall[]> {
        return [...this.#sessions.values()].flatMap(
            (session) => session.state().durableUserInputs ?? [],
        );
    }

    async listSubagents(
        ctx: Context,
        parentSessionId: string,
    ): Promise<readonly SubagentSummary[]> {
        return [...this.#sessions.values()]
            .filter((session) => {
                let ancestorId = session.agentMetadata().parentSessionId;
                while (ancestorId !== undefined) {
                    if (ancestorId === parentSessionId) return true;
                    ancestorId = this.#sessions.get(ancestorId)?.agentMetadata().parentSessionId;
                }
                return false;
            })
            .map((session) => session.subagentSummary())
            .sort((left, right) => left.createdAt - right.createdAt);
    }

    async queryAgentTreeUsage(ctx: Context, sessionId: string) {
        return queryLiveAgentTreeUsage(this.#sessions.values(), sessionId);
    }

    async listSecrets(ctx: Context): Promise<readonly SecretSummary[]> {
        return this.#secrets.references();
    }

    async timeline(ctx: Context, request: GetTimelineRequest): Promise<readonly TimelineAgent[]> {
        const sessions = [...this.#sessions.values()].filter((session) =>
            this.#inTimelineScope(session, request.scope),
        );
        const agents = sessions
            .map((session) => timelineAgentSource(session))
            .filter((agent) => (request.includeArchived ?? false) || !agent.archived);
        const covered = new Set(agents.map((agent) => agent.sessionId));
        const events = sessions
            .filter((session) => covered.has(session.id))
            .flatMap((session) =>
                session.events.all().filter((event) => isTimelineEventType(event.type)),
            );
        return buildTimeline(
            agents,
            events,
            request.since === undefined ? {} : { since: request.since },
        );
    }

    async transferSession(
        ctx: Context,
        sessionId: string,
        request: TransferSessionRequest,
    ): Promise<TransferSessionResponse | undefined> {
        return this.#executeSessionTransfer(ctx, sessionId, request.targetWorkspaceId, false);
    }

    async #executeSessionTransfer(
        ctx: Context,
        sessionId: string,
        targetWorkspaceId: string,
        scheduled: boolean,
    ): Promise<TransferSessionResponse | undefined> {
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        return executeSessionWorkspaceTransfer(ctx, {
            hasAttachedSessions: (_requestCtx, workspaceId) =>
                [...this.#sessions.values()].some((candidate) => {
                    const snapshot = candidate.snapshot();
                    return (
                        snapshot.archived !== true &&
                        snapshot.scope.kind === "workspace" &&
                        snapshot.scope.workspaceId === workspaceId
                    );
                }),
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

    #inTimelineScope(session: InMemorySession, scope: TimelineScope): boolean {
        if (scope.kind === "global") return true;
        const summary = session.summary();
        if (scope.kind === "project") {
            return (
                (summary.scope.kind === "project" || summary.scope.kind === "workspace") &&
                summary.scope.projectId === scope.projectId
            );
        }
        if (scope.kind === "workspace") {
            return (
                summary.scope.kind === "workspace" &&
                summary.scope.workspaceId === scope.workspaceId
            );
        }
        let candidateId: string | undefined = session.id;
        while (candidateId !== undefined) {
            if (candidateId === scope.sessionId) return true;
            candidateId = this.#sessions.get(candidateId)?.agentMetadata().parentSessionId;
        }
        return false;
    }

    async registerSecret(ctx: Context, request: RegisterSecretRequest): Promise<SecretSummary> {
        this.#secrets.register(request);
        return this.#secrets.reference(request.id);
    }

    async registerSpecialSecret(
        ctx: Context,
        request: SpecialSecretRegistration,
    ): Promise<SecretSummary> {
        this.#secrets.register(request);
        await this.#projects.retryRemoteProjects(ctx, request.kind);
        return this.#secrets.reference(request.kind);
    }

    resolveSpecialSecret(kind: SpecialSecretKind): NodeJS.ProcessEnv {
        return this.#secrets.resolveSpecial(kind);
    }

    async unregisterSecret(ctx: Context, secretId: string): Promise<boolean> {
        const secret = this.#secrets.references().find((candidate) => candidate.id === secretId);
        if (secret === undefined || secret.kind !== undefined) return false;
        const removed = this.#secrets.unregister(secretId);
        if (!removed) return false;
        for (const ids of this.#projectSecretIds.values()) ids.delete(secretId);
        for (const session of this.#sessions.values()) {
            await session.detachSecret(ctx, secretId, { scope: "project" });
            await session.detachSecret(ctx, secretId, { scope: "session" });
        }
        return true;
    }

    async unregisterSpecialSecret(ctx: Context, kind: SpecialSecretKind): Promise<boolean> {
        return this.#secrets.unregisterSpecial(kind);
    }

    async updateSecret(
        ctx: Context,
        secretId: string,
        request: UpdateSecretRequest,
    ): Promise<SecretSummary | undefined> {
        const updated = this.#secrets.updatedRegistration(secretId, request);
        if (updated === undefined) return undefined;
        this.#secrets.register(updated);
        return this.#secrets.reference(secretId);
    }

    async getProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        return await this.#projects.getProject(ctx, projectId);
    }

    async applyGitFacts(
        ctx: Context,
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): Promise<void> {
        await this.#projects.applyGitFacts(ctx, target, facts);
    }

    async listFolders(ctx: Context): Promise<readonly Folder[]> {
        return await this.#folders.listFolders(ctx);
    }

    async folderCatalog(ctx: Context) {
        return await this.#folders.folderCatalog(ctx);
    }

    async getFolder(ctx: Context, folderId: string): Promise<Folder | undefined> {
        return await this.#folders.getFolder(ctx, folderId);
    }

    async getFolderItem(ctx: Context, itemId: string): Promise<FolderItem | undefined> {
        return await this.#folders.getFolderItem(ctx, itemId);
    }

    async createFolderItem(
        ctx: Context,
        folderId: string,
        request: CreateFolderItemRequest,
    ): Promise<FolderItem> {
        return await this.#folders.createFolderItem(ctx, folderId, request);
    }

    async moveFolderItem(
        ctx: Context,
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion?: number,
    ): Promise<FolderItem | undefined> {
        return await this.#folders.moveFolderItem(ctx, itemId, request, expectedVersion);
    }

    async archiveFolderItem(
        ctx: Context,
        itemId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<FolderItem | undefined> {
        return await this.#folders.archiveFolderItem(ctx, itemId, expectedVersion, mutationId);
    }

    async createFolder(ctx: Context, request: CreateFolderRequest): Promise<Folder> {
        return await this.#folders.createFolder(ctx, request);
    }

    async updateFolder(
        ctx: Context,
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        return await this.#folders.updateFolder(ctx, folderId, request, expectedVersion);
    }

    async moveFolder(
        ctx: Context,
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        return await this.#folders.moveFolder(ctx, folderId, request, expectedVersion);
    }

    async archiveFolder(
        ctx: Context,
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Folder | undefined> {
        const archived = await this.#folders.archiveFolder(
            ctx,
            folderId,
            expectedVersion,
            mutationId,
        );
        if (archived === undefined) return undefined;
        const archivedFolderIds = new Set(
            (await this.#folders.listFolders(ctx))
                .filter((folder) => folder.archivedAt !== undefined)
                .map((folder) => folder.id),
        );
        for (const session of this.#sessions.values()) {
            const scope = session.snapshot().scope;
            if (scope.kind !== "folder" || !archivedFolderIds.has(scope.folderId)) continue;
            await session.recordFolderArchived(ctx).catch(rethrowDatabaseFailure);
        }
        return archived;
    }

    async sharedFolderState(ctx: Context, rootFolderId: string): Promise<SharedFolderState> {
        return await this.#folders.sharedFolderState(ctx, rootFolderId);
    }

    async sharedFolderGroup(ctx: Context, folderId: string): Promise<string | undefined> {
        return await this.#folders.sharedFolderGroup(ctx, folderId);
    }

    async sharedFolderRoot(ctx: Context, groupId: string): Promise<string | undefined> {
        return await this.#folders.sharedFolderRoot(ctx, groupId);
    }

    async assertFolderShareable(ctx: Context, folderId: string): Promise<void> {
        await this.#folders.assertFolderShareable(ctx, folderId);
    }

    async markFolderShared(ctx: Context, folderId: string, groupId: string): Promise<Folder> {
        return await this.#folders.markFolderShared(ctx, folderId, groupId);
    }

    async applySharedFolderState(
        ctx: Context,
        groupId: string,
        state: SharedFolderState,
    ): Promise<Folder> {
        return await this.#folders.applySharedFolderState(ctx, groupId, state);
    }

    async getDocument(ctx: Context, documentId: string): Promise<Document | undefined> {
        return await this.#documents.getDocument(ctx, documentId);
    }

    async createDocument(
        ctx: Context,
        request: CreateDocumentRequest,
        createdBy: DocumentCreatedBy,
    ): Promise<Document> {
        return await this.#documents.createDocument(ctx, request, createdBy);
    }

    async writeDocument(
        ctx: Context,
        documentId: string,
        request: WriteDocumentRequest,
        expectedVersion: number,
    ): Promise<Document | undefined> {
        return await this.#documents.writeDocument(ctx, documentId, request, expectedVersion);
    }

    async documentUpdates(
        ctx: Context,
        documentId: string,
        request: ListDocumentUpdatesRequest,
    ): Promise<DocumentUpdatePage | undefined> {
        return await this.#documents.documentUpdates(ctx, documentId, request);
    }

    async setSessionFolder(
        ctx: Context,
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        const session = this.#sessions.get(sessionId);
        if (session === undefined) return undefined;
        if (session.isSubagent()) throw new Error("Subagent histories cannot be moved.");
        const current = session.state();
        const scope: SessionScope =
            folderId === null ? { kind: "unsorted" } : { folderId, kind: "folder" };
        if (afterId === undefined && sameScope(current.scope, scope)) return session;
        const folder = folderId === null ? undefined : await this.#folders.getFolder(ctx, folderId);
        if (folderId !== null && (folder === undefined || folder.archivedAt !== undefined)) {
            throw new Error("That folder was not found.");
        }
        const storage =
            folderId === null
                ? this.#folders.createUnsortedSessionDirectory(ctx, sessionId)
                : {
                      created: false,
                      path: await this.#folders.activeFolderStoragePath(ctx, folderId),
                  };
        try {
            const targetItems = [...this.#sessions.values()]
                .filter((candidate) => !candidate.isSubagent())
                .map((candidate) => candidate.state())
                .filter((candidate) => sameScope(candidate.scope, scope))
                .map((candidate) => ({ id: candidate.id, orderKey: candidate.orderKey }));
            const existing = targetItems.some((candidate) => candidate.id === sessionId);
            const orderKey =
                afterId === undefined
                    ? generateKeyBetween(
                          targetItems
                              .filter((candidate) => candidate.id !== sessionId)
                              .sort((left, right) => left.orderKey.localeCompare(right.orderKey))
                              .at(-1)?.orderKey ?? null,
                          null,
                      )
                    : orderKeyAfter(
                          existing
                              ? targetItems
                              : [
                                    ...targetItems,
                                    {
                                        id: sessionId,
                                        orderKey: generateKeyBetween(
                                            targetItems
                                                .sort((left, right) =>
                                                    left.orderKey.localeCompare(right.orderKey),
                                                )
                                                .at(-1)?.orderKey ?? null,
                                            null,
                                        ),
                                    },
                                ],
                          sessionId,
                          afterId,
                      );
            await session.applyScopeMove(ctx, {
                cwd: storage.path,
                orderKey,
                scope,
                ...(scope.kind === "unsorted"
                    ? { unsortedSince: current.unsortedSince ?? Date.now() }
                    : {}),
            });
            if (mutationId !== undefined) {
                await this.#folders.rememberSessionScopeMutation(ctx, sessionId, mutationId);
            }
        } catch (error) {
            if (storage.created) {
                this.#folders.removeNewUnsortedSessionDirectory(ctx, sessionId, storage.path);
            }
            throw error;
        }
        return session;
    }

    async sessionScopeMutationApplied(
        ctx: Context,
        sessionId: string,
        mutationId: string,
    ): Promise<boolean> {
        return await this.#folders.sessionScopeMutationApplied(ctx, sessionId, mutationId);
    }

    async listProjects(ctx: Context): Promise<readonly Project[]> {
        return await this.#projects.listProjects(ctx);
    }

    registerProject(ctx: Context, request: RegisterProjectRequest): Promise<Project> {
        return this.#projects.registerProject(ctx, request);
    }

    createRemoteProject(
        ctx: Context,
        request: CreateRemoteProjectRequest,
        options?: { createdBy?: ProjectCreator; githubToken?: string; mutationId?: string },
    ): Promise<Project> {
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
        return await this.#projects.getWorkspace(ctx, projectId, workspaceId);
    }

    async listWorkspaces(ctx: Context, projectId?: string): Promise<readonly ProjectWorkspace[]> {
        return await this.#projects.listWorkspaces(ctx, projectId);
    }

    async renameProject(
        ctx: Context,
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined> {
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
        return await this.#projects.queryProjectSettings(ctx, cwd);
    }

    async setProjectSettings(
        ctx: Context,
        projectId: string,
        settings: ProjectSettingsUpdate,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined> {
        return await this.#projects.setProjectSettings(
            ctx,
            projectId,
            settings,
            expectedVersion,
            mutationId,
        );
    }

    async refreshProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        return await this.#projects.refreshProject(ctx, projectId);
    }

    async reorderProject(
        ctx: Context,
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        return await this.#projects.reorderProject(ctx, projectId, request, expectedVersion);
    }

    async reorderSession(
        ctx: Context,
        sessionId: string,
        request: ReorderRequest,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(ctx, sessionId);
        if (session === undefined) return undefined;
        if (session.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        const snapshot = session.snapshot();
        const siblings = [...this.#sessions.values()]
            .filter((candidate) => {
                if (candidate.isSubagent()) return false;
                const candidateSnapshot = candidate.snapshot();
                return sameScope(candidateSnapshot.scope, snapshot.scope);
            })
            .map((candidate) => candidate.summary());
        await session.setOrderKey(
            ctx,
            orderKeyAfter(positioned(siblings), sessionId, request.afterId),
        );
        return session;
    }

    async reorderWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
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
        return this.#projects.createWorkspace(ctx, projectId, request, undefined, options);
    }

    async refreshSessionGitCredential(
        ctx: Context,
        sessionId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<boolean> {
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

    /*
     * Archiving a project hides the whole folder: its root chats are archived, and every managed
     * workspace is archived with the sessions and worktree directory it owns.
     */
    async archiveProject(
        ctx: Context,
        projectId: string,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        let project: Project | undefined;
        let workspaces: { teardown: WorkspaceArchiveTeardown[]; workspaceId: string }[] = [];
        const workspaceIds = new Set(
            (await this.#projects.listWorkspaces(ctx, projectId)).map((workspace) => workspace.id),
        );
        const affectedSessions = [...this.#sessions.values()].filter((session) => {
            const snapshot = session.snapshot();
            return (
                (snapshot.scope.kind === "project" &&
                    snapshot.scope.projectId === projectId &&
                    !session.isSubagent()) ||
                (snapshot.scope.kind === "workspace" &&
                    workspaceIds.has(snapshot.scope.workspaceId))
            );
        });
        const checkpoints = new Map(
            affectedSessions.map(
                (session) => [session, session.captureMutationCheckpoint()] as const,
            ),
        );
        let postCommitError: unknown;
        try {
            await this.#transaction(ctx, async () => {
                project = await this.#projects.archiveProject(ctx, projectId, expectedVersion);
                if (project === undefined) return;
                for (const session of this.#sessions.values()) {
                    if (session.isSubagent()) continue;
                    const snapshot = session.snapshot();
                    if (
                        snapshot.scope.kind !== "project" ||
                        snapshot.scope.projectId !== projectId
                    ) {
                        continue;
                    }
                    await session.setArchived(ctx, true);
                }
                workspaces = (
                    await Promise.all(
                        (
                            await this.#projects.listWorkspaces(ctx, projectId)
                        ).map(async (workspace) => {
                            if (
                                workspace.status === "archived" ||
                                workspace.status === "archiving"
                            ) {
                                return undefined;
                            }
                            const archiving = await this.#projects.beginWorkspaceArchive(
                                ctx,
                                projectId,
                                workspace.id,
                            );
                            if (archiving === undefined || archiving.status === "archived") {
                                return undefined;
                            }
                            return {
                                teardown: await Promise.all(
                                    [...this.#sessions.values()]
                                        .filter((session) =>
                                            isSessionInWorkspace(session, workspace.id),
                                        )
                                        .map((session) =>
                                            session.archiveForWorkspace(ctx, workspace.id),
                                        ),
                                ),
                                workspaceId: workspace.id,
                            };
                        }),
                    )
                ).filter(
                    (
                        workspace,
                    ): workspace is {
                        teardown: WorkspaceArchiveTeardown[];
                        workspaceId: string;
                    } => workspace !== undefined,
                );
            });
        } catch (error) {
            if (isSessionTransactionPostCommitError(error)) {
                postCommitError = error;
            } else {
                for (const [session, checkpoint] of checkpoints) {
                    session.restoreMutationCheckpoint(checkpoint);
                }
                throw error;
            }
        }
        if (project === undefined) {
            if (postCommitError !== undefined) throw postCommitError;
            return undefined;
        }
        // Every logical archive write above is complete before physical terminal
        // and worktree cleanup yields, so a later unarchive can never be
        // overtaken by stale child writes from this operation.
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
            ...(postCommitError === undefined ? [] : [postCommitError]),
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

    async unarchiveProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        return await this.#projects.unarchiveProject(ctx, projectId);
    }

    async archiveWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        const workspace = await this.#projects.beginWorkspaceArchive(
            ctx,
            projectId,
            workspaceId,
            expectedVersion,
        );
        if (workspace === undefined || workspace.status === "archived") {
            return Promise.resolve(workspace);
        }
        const sessions = [...this.#sessions.values()].filter((session) =>
            isSessionInWorkspace(session, workspaceId),
        );
        const checkpoints = new Map(
            sessions.map((session) => [session, session.captureMutationCheckpoint()] as const),
        );
        const teardowns: WorkspaceArchiveTeardown[] = [];
        try {
            await this.#transaction(ctx, async () => {
                for (const session of sessions) {
                    teardowns.push(await session.archiveForWorkspace(ctx, workspaceId));
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
                for (const [session, checkpoint] of checkpoints) {
                    session.restoreMutationCheckpoint(checkpoint);
                }
            }
            throw error;
        }
        const cleanup = this.#runWorkspaceArchiveCleanup(
            projectId,
            workspaceId,
            async (cleanupCtx) => {
                const work = teardowns.map((teardown) => teardown(cleanupCtx));
                work.push(this.remoteTerminals.closeWorkspace(cleanupCtx, projectId, workspaceId));
                return await this.#completeWorkspaceArchive(
                    cleanupCtx,
                    projectId,
                    workspaceId,
                    work,
                );
            },
        );
        void cleanup.catch((error: unknown) => {
            // Residue left behind is worth a warning because a later attempt can still clear
            // it. A database that cannot answer is neither reportable nor retryable.
            if (isDatabaseFailure(error)) throw error;
            this.#onWorkspaceCleanupError?.(error, projectId, workspaceId);
        });
        return workspace;
    }

    #runWorkspaceArchiveCleanup<Result>(
        projectId: string,
        workspaceId: string | undefined,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        const cleanup = withWorkerContext(
            "workspace-archive-cleanup",
            (workerCtx) => work(withDatabase(workerCtx, this.#database)),
            { projectId, ...(workspaceId === undefined ? {} : { workspaceId }) },
        );
        this.#workspaceArchiveCleanups.add(cleanup);
        void cleanup.then(
            () => this.#workspaceArchiveCleanups.delete(cleanup),
            () => this.#workspaceArchiveCleanups.delete(cleanup),
        );
        return cleanup;
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
        return this.#projects.setAvatar(ctx, projectId, "user", bytes, expectedVersion);
    }

    async clearProjectAvatar(ctx: Context, projectId: string): Promise<Project | undefined> {
        return await this.#projects.clearAvatar(ctx, projectId);
    }

    getProjectAvatar(ctx: Context, hash: string): Promise<ProjectAvatarAsset | undefined> {
        return this.#projects.avatarAsset(ctx, hash);
    }

    async changeModel(
        ctx: Context,
        sessionId: string,
        request: ChangeModelRequest,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(ctx, sessionId);
        if (session === undefined) {
            return undefined;
        }

        await session.changeModel(ctx, request);
        return session;
    }

    #projectSecrets(projectId: string): readonly string[] {
        return [...(this.#projectSecretIds.get(projectId) ?? [])];
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
            await configureSessionRequest({ cwd }, this.#defaultDocker, () =>
                this.#projects.queryProjectSettings(ctx, cwd),
            )
        ).docker;
        return {
            cwd,
            ...(docker === undefined ? {} : { docker }),
        };
    }

    #newLastSessionOrderKey(scope: SessionScope): string {
        const candidates = [...this.#sessions.values()]
            .filter((session) => {
                if (session.isSubagent()) return false;
                const snapshot = session.snapshot();
                return sameScope(snapshot.scope, scope);
            })
            .map((session) => session.summary());
        const last = positioned(candidates)
            .sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey))
            .at(-1);
        return generateKeyBetween(last?.orderKey ?? null, null);
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

    async #projectEvent(ctx: Context, event: GlobalEvent): Promise<void> {
        await this.#publishGlobalEvent(ctx, event);
        if (event.type !== "workspace_created" && event.type !== "workspace_updated") return;
        if (event.data.workspace.status === "initializing") return;
        await this.#afterTransactionCommit(async () => {
            await this.#workspaceReadyWaiters.changed(event.projectId, event.workspaceId);
        });
    }

    async #publishGlobalEvent(ctx: Context, event: GlobalEvent): Promise<void> {
        // Every event reaches the ephemeral stream, including the transient ones
        // the durable log drops, because one subscription has to be enough.
        await this.#afterTransactionCommit(() => {
            this.liveEvents.publish(event);
        });
        if (isLiveGlobalEvent(event)) {
            await this.#afterTransactionCommit(() => {
                this.globalEventQueue.publishLive(event);
            });
            return;
        }
        if (!shouldPublishGlobalEvent(event)) return;
        await this.#afterTransactionCommit(async () => {
            const entry = await this.globalEventQueue.append(ctx, event);
            if (entry !== undefined) this.globalEventQueue.publish(entry);
        });
    }

    #transaction<T>(ctx: Context, body: (ctx: Context) => T | Promise<T>): Promise<T> {
        return runSessionTransaction(withDatabase(ctx, this.#database), body);
    }

    async close(ctx: Context): Promise<void> {
        await Promise.allSettled(this.#workspaceArchiveCleanups);
        await this.remoteTerminals.close(ctx);
        this.#workspaceReadyWaiters.close();
        await this.#projects.close(ctx);
        this.liveEvents.close();
        this.globalEventQueue.deactivate();
        await this.#database.close(withDatabase(ctx, this.#database));
    }

    #afterTransactionCommit(callback: () => void | Promise<void>): Promise<void> {
        return deferSessionTransactionCommit(callback, this.#database);
    }

    afterTransactionCommit(ctx: Context, callback: () => void | Promise<void>): Promise<void> {
        return this.#afterTransactionCommit(callback);
    }
}

function compareOrderKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function validOwnerInstanceId(value: string): string {
    if (!Value.Check(p2pInstanceIdSchema, value)) {
        throw new Error("The session owner Rig identity is invalid.");
    }
    return value;
}

/** Keeps only the sessions that have a place in a project's ordered list. */
function positioned(
    summaries: readonly SessionSummary[],
): (SessionSummary & { orderKey: string })[] {
    return summaries.filter(
        (summary): summary is SessionSummary & { orderKey: string } =>
            summary.orderKey !== undefined,
    );
}

function sortSummariesByOrder(
    left: SessionSummary & { orderKey: string },
    right: SessionSummary & { orderKey: string },
    projectOrder: ReadonlyMap<string, string>,
    workspaceOrder: ReadonlyMap<string, string>,
): number {
    const leftCode = codeScopeOrUndefined(left.scope);
    const rightCode = codeScopeOrUndefined(right.scope);
    return (
        compareOrderKeys(
            leftCode === undefined ? "" : (projectOrder.get(leftCode.projectId) ?? ""),
            rightCode === undefined ? "" : (projectOrder.get(rightCode.projectId) ?? ""),
        ) ||
        Number(leftCode?.kind === "workspace") - Number(rightCode?.kind === "workspace") ||
        compareOrderKeys(
            leftCode?.kind !== "workspace" ? "" : (workspaceOrder.get(leftCode.workspaceId) ?? ""),
            rightCode?.kind !== "workspace"
                ? ""
                : (workspaceOrder.get(rightCode.workspaceId) ?? ""),
        ) ||
        compareOrderKeys(left.orderKey, right.orderKey) ||
        compareOrderKeys(left.id, right.id)
    );
}

function codeScope(scope: SessionScope): Extract<SessionScope, { kind: "project" | "workspace" }> {
    const code = codeScopeOrUndefined(scope);
    if (code === undefined) {
        throw new Error("This operation is available only for project or workspace chats.");
    }
    return code;
}

function codeScopeOrUndefined(
    scope: SessionScope,
): Extract<SessionScope, { kind: "project" | "workspace" }> | undefined {
    return scope.kind === "project" || scope.kind === "workspace" ? scope : undefined;
}

function sameScope(left: SessionScope, right: SessionScope): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "project" && right.kind === "project") {
        return left.projectId === right.projectId;
    }
    if (left.kind === "workspace" && right.kind === "workspace") {
        return left.workspaceId === right.workspaceId;
    }
    return left.kind !== "folder" || right.kind !== "folder" || left.folderId === right.folderId;
}

function isSessionInWorkspace(session: InMemorySession, workspaceId: string): boolean {
    const scope = session.snapshot().scope;
    return scope.kind === "workspace" && scope.workspaceId === workspaceId;
}
