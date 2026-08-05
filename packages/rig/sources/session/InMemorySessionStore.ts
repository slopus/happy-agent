import { createEventIdFactory, isLiveGlobalEvent } from "../protocol/index.js";
import type { Message } from "../agent/types.js";
import type {
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateProjectWorkspaceRequest,
    CreateSessionRequest,
    GetTimelineRequest,
    GitRepositoryFacts,
    ModelCatalog,
    Project,
    ProjectSettingsUpdate,
    ProjectWorkspace,
    ReorderRequest,
    RegisterProjectRequest,
    RegisterSecretRequest,
    SecretSummary,
    SessionAgentMetadata,
    SessionSummary,
    SubagentSummary,
    TimelineAgent,
    TimelineScope,
    TransferSessionRequest,
    TransferSessionResponse,
} from "../protocol/index.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import {
    subagentMaxDepthFromEnvironment,
    subagentModelPolicyFromEnvironment,
} from "./subagentModelPolicy.js";
import { InMemorySession, type InMemorySessionOptions } from "./InMemorySession.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import { retriedSession } from "./retriedSession.js";
import type { SessionStore } from "./SessionStore.js";
import type { McpToolProvider } from "../mcp/index.js";
import { SecretRegistry, type SecretRegistration } from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { ExternalToolCall } from "../external-tools/index.js";
import { inTx } from "../persistence/inTx.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import type { TX } from "../persistence/Transaction.js";
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
    type ProjectSessionSettings,
} from "../project/ProjectRepository.js";
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
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { buildTimeline, isTimelineEventType } from "../timeline/index.js";
import { sessionOrderKeyForCreation } from "./impl/sessionOrderKeyForCreation.js";
import { timelineAgentSource } from "./impl/timelineAgentSource.js";
import { queryLiveAgentTreeUsage } from "./queryLiveAgentTreeUsage.js";
import { SlotEntryStore } from "../slots/index.js";
import { WebappStore } from "../webapps/index.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { configureSessionRequest } from "./configureSessionRequest.js";
import {
    executeSessionWorkspaceTransfer,
    scheduleSessionWorkspaceTransfer,
} from "./transferSessionWorkspace.js";
import { workspaceRunReadiness } from "./workspaceRunReadiness.js";
import { createWorkspaceReadyWaiters } from "./workspaceReadyWaiters.js";

export interface InMemorySessionStoreOptions {
    createRuntime?: InMemorySessionOptions["createRuntime"];
    defaultDocker?: DockerExecutionConfig;
    mcpToolProvider?: McpToolProvider;
    modelCatalog?: ModelCatalog;
    onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
    presence?: PresenceStore;
    secrets?: readonly SecretRegistration[];
    homeDirectory?: string;
    stateDirectory?: string;
    workspacesDirectory?: string;
}

export class InMemorySessionStore implements SessionStore {
    #agentManager: AgentSessionManager;
    #createRuntime: InMemorySessionOptions["createRuntime"];
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    #modelCatalog: ModelCatalog;
    #mcpToolProvider: McpToolProvider | undefined;
    #onWorkspaceCleanupError:
        | ((error: unknown, projectId: string, workspaceId: string) => void)
        | undefined;
    #projectSecretIds = new Map<string, Set<string>>();
    readonly #client: ReturnType<typeof openSessionDatabase>["client"];
    readonly #database: SessionDatabase;
    readonly #createPresenceEventId = createEventIdFactory();
    readonly #createTerminalEventId = createEventIdFactory();
    readonly #projects: ProjectRepository;
    #workspaceReadyWaiters!: ReturnType<typeof createWorkspaceReadyWaiters>;
    readonly dataEpoch: string;
    readonly dataSchemaVersion: number;
    readonly globalEventQueue = new InMemoryGlobalEventQueue();
    readonly liveEvents = new LiveGlobalEventQueue();
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    readonly slots: SlotEntryStore;
    readonly webapps: WebappStore;
    #secrets: SecretRegistry;
    #sessions = new Map<string, InMemorySession>();
    readonly #workspaceTransferReservations = new Map<string, string>();
    #activeTransaction: TX | undefined;
    #transactionCommitCallbacks: (() => void)[] | undefined;

    constructor(options: InMemorySessionStoreOptions = {}) {
        const opened = openSessionDatabase(":memory:");
        this.#client = opened.client;
        this.#database = opened.database;
        migrateSessionDatabase(this.#database);
        this.dataEpoch = queryRigDataEpoch(this.#database);
        this.dataSchemaVersion = querySessionDatabaseVersion(this.#database);
        if (this.dataSchemaVersion !== CURRENT_SESSION_DATABASE_VERSION) {
            throw new Error("The in-memory Rig store did not reach the current schema version.");
        }
        this.webapps = new WebappStore({
            publish: (event) => this.#publishGlobalEvent(event),
            tx: () => this.#activeTransaction ?? this.#database,
        });
        this.slots = new SlotEntryStore({
            publish: (event) => this.#publishGlobalEvent(event),
            sessionExists: (sessionId) => this.#sessions.has(sessionId),
            tx: () => this.#activeTransaction ?? this.#database,
            webapp: (name) => this.webapps.get(name),
        });
        this.#projects = new ProjectRepository({
            database: this.#database,
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (event) => this.#projectEvent(event),
            ...(options.onWorkspaceCleanupError === undefined
                ? {}
                : { onWorkspaceCleanupError: options.onWorkspaceCleanupError }),
            ...(options.stateDirectory === undefined
                ? {}
                : { stateDirectory: options.stateDirectory }),
            transaction: (body) => this.#transaction(body),
            ...(options.workspacesDirectory === undefined
                ? {}
                : { workspacesDirectory: options.workspacesDirectory }),
        });
        this.#workspaceReadyWaiters = createWorkspaceReadyWaiters((projectId, workspaceId) =>
            this.#projects.getWorkspace(projectId, workspaceId),
        );
        this.remoteTerminals = new ProjectRemoteTerminalStore({
            onChange: (scope, terminals) => {
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
            resolveContext: (scope) => this.#remoteTerminalContext(scope),
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
        this.#modelCatalog = options.modelCatalog ?? createModelCatalog();
        this.#onWorkspaceCleanupError = options.onWorkspaceCleanupError;
        this.#createRuntime = options.createRuntime;
        this.#defaultDocker = options.defaultDocker;
        this.#mcpToolProvider = options.mcpToolProvider;
        const maxSubagentDepth = subagentMaxDepthFromEnvironment();
        this.#agentManager = new AgentSessionManager({
            repository: {
                archiveOwnedWorkspace: async (ownerSessionId, projectId, workspaceId) =>
                    this.#projects.getOwnedWorkspace(ownerSessionId, projectId, workspaceId) ===
                    undefined
                        ? undefined
                        : this.archiveWorkspace(projectId, workspaceId),
                createOwnedWorkspace: (ownerSessionId, projectId, request) =>
                    this.#projects.createWorkspace(projectId, request, ownerSessionId),
                configureWorkspaceRequest: (request) => this.#configureWorkspaceRequest(request),
                createSubagent: (request, metadata, contextMessages) =>
                    this.#createSession(request, metadata, contextMessages),
                findByAgentId: (agentId) => this.findByAgentId(agentId),
                get: (sessionId) => this.get(sessionId),
                listByRoot: (rootSessionId) =>
                    [...this.#sessions.values()].filter(
                        (session) =>
                            session.agentMetadata().rootSessionId === rootSessionId &&
                            session.isSubagent(),
                    ),
                registerProject: (path) => this.#projects.registerProject({ path }),
                queryAgentTreeUsage: (sessionId) => this.queryAgentTreeUsage(sessionId),
                ownedWorkspace: (ownerSessionId, projectId, workspaceId) =>
                    this.#projects.getOwnedWorkspace(ownerSessionId, projectId, workspaceId),
                waitForWorkspaceReady: (projectId, workspaceId, signal) =>
                    this.#workspaceReadyWaiters.wait(projectId, workspaceId, signal),
                completeScheduledSessionTransfer: async (sessionId, targetWorkspaceId) => {
                    const result = await this.#executeSessionTransfer(
                        sessionId,
                        targetWorkspaceId,
                        true,
                    );
                    if (result === undefined) {
                        throw new Error("The session is no longer available.");
                    }
                },
                scheduleSessionTransfer: (sessionId, targetWorkspaceId) => {
                    const session = this.get(sessionId);
                    if (session === undefined) {
                        throw new Error("The session is no longer available.");
                    }
                    return scheduleSessionWorkspaceTransfer({
                        hasAttachedSessions: (workspaceId) =>
                            [...this.#sessions.values()].some((candidate) => {
                                const snapshot = candidate.snapshot();
                                return (
                                    snapshot.archived !== true &&
                                    snapshot.workspaceId === workspaceId
                                );
                            }),
                        projects: this.#projects,
                        releaseTarget: (workspaceId, ownerSessionId) =>
                            this.#releaseWorkspaceTransferTarget(workspaceId, ownerSessionId),
                        reserveTarget: (workspaceId, ownerSessionId) =>
                            this.#reserveWorkspaceTransferTarget(workspaceId, ownerSessionId),
                        session,
                        targetWorkspaceId,
                    });
                },
            },
            ...(maxSubagentDepth === undefined ? {} : { maxDepth: maxSubagentDepth }),
            subagentModelPolicy: subagentModelPolicyFromEnvironment(),
        });
    }

    changeEffort(sessionId: string, request: ChangeEffortRequest): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        session.changeEffort(request);
        return session;
    }

    #configureWorkspaceRequest(request: CreateSessionRequest): CreateSessionRequest {
        const { docker: _docker, local: _local, ...base } = request;
        return configureSessionRequest(base, this.#defaultDocker, () =>
            this.#projects.queryProjectSettings(request.cwd),
        );
    }

    attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        this.#secrets.reference(secretId);
        if (scope === "project") {
            const projectId = session.snapshot().projectId;
            const ids = this.#projectSecretIds.get(projectId) ?? new Set<string>();
            ids.add(secretId);
            this.#projectSecretIds.set(projectId, ids);
            for (const candidate of this.#sessions.values()) {
                if (candidate.snapshot().projectId === projectId) {
                    candidate.attachSecret(secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            session.attachSecret(secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    changeServiceTier(
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        session.changeServiceTier(request);
        return session;
    }

    create(request: CreateSessionRequest): InMemorySession {
        return this.#createSession(request);
    }

    createWithId(id: string, request: CreateSessionRequest): InMemorySession {
        const existing = this.get(id);
        if (existing !== undefined) return retriedSession(existing, request);
        return this.#createSession(request, undefined, undefined, id);
    }

    detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = session.snapshot().projectId;
            this.#projectSecretIds.get(projectId)?.delete(secretId);
            for (const candidate of this.#sessions.values()) {
                if (candidate.snapshot().projectId === projectId) {
                    candidate.detachSecret(secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            session.detachSecret(secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    fork(sessionId: string, targetSessionId?: string): InMemorySession | undefined {
        if (targetSessionId !== undefined) {
            const existing = this.get(targetSessionId);
            if (existing !== undefined) return existing;
        }
        const source = this.get(sessionId);
        if (source === undefined) return undefined;
        const state = source.createForkState();
        const sourceSnapshot = source.snapshot();
        if (sourceSnapshot.workspaceId !== undefined) {
            this.#assertWorkspaceAcceptingSessions(sourceSnapshot.workspaceId);
        }
        if (sourceSnapshot.workspaceId !== undefined) {
            const workspace = this.#projects.getWorkspace(
                sourceSnapshot.projectId,
                sourceSnapshot.workspaceId,
            );
            if (
                workspace === undefined ||
                workspaceRunReadiness(this.#projects, {
                    cwd: sourceSnapshot.cwd,
                    projectId: sourceSnapshot.projectId,
                    workspaceId: sourceSnapshot.workspaceId,
                }).state !== "ready"
            ) {
                throw new Error("A session in an unavailable workspace cannot be forked.");
            }
        }
        const session = new InMemorySession({
            presence: this.presence,
            agentManager: this.#agentManager,
            workspaceRunReadiness: (target) => workspaceRunReadiness(this.#projects, target),
            createEventId: createEventIdFactory(),
            ...(targetSessionId === undefined ? {} : { id: targetSessionId }),
            ...(this.#createRuntime === undefined ? {} : { createRuntime: this.#createRuntime }),
            modelCatalog: this.#modelCatalog,
            onInitialTitle: (metadata) => this.#inheritWorkspaceTitle(metadata),
            ...(this.#mcpToolProvider !== undefined
                ? { mcpToolProvider: this.#mcpToolProvider }
                : {}),
            request: source.requestForSubagent(),
            onAppendEvent: (event) => this.#publishGlobalEvent(event),
            slotStores: { entries: this.slots, webapps: this.webapps },
            projectId: sourceSnapshot.projectId,
            projectSecretIds: this.#projectSecrets(sourceSnapshot.projectId),
            secretRegistry: this.#secrets,
            restore: {
                ...state,
                ...(targetSessionId === undefined
                    ? {}
                    : {
                          agent: { ...state.agent, rootSessionId: targetSessionId },
                          id: targetSessionId,
                      }),
                orderKey: this.#newLastSessionOrderKey(
                    sourceSnapshot.projectId,
                    sourceSnapshot.workspaceId,
                ),
            },
            ...(sourceSnapshot.workspaceId === undefined
                ? {}
                : { workspaceId: sourceSnapshot.workspaceId }),
        });
        this.#sessions.set(session.id, session);
        session.emitCreatedEvent();
        return session;
    }

    #createSession(
        request: CreateSessionRequest,
        metadata?: SessionAgentMetadata,
        contextMessages?: readonly Message[],
        id?: string,
    ): InMemorySession {
        const inherited =
            metadata?.parentSessionId === undefined
                ? undefined
                : this.get(metadata.parentSessionId)?.snapshot();
        if (metadata?.parentSessionId !== undefined && inherited === undefined) {
            throw new Error("The parent session was not found.");
        }
        if (inherited?.status === "archived") {
            throw new Error("An archived session cannot create a subagent.");
        }
        const inheritedWorkspace =
            inherited?.workspaceId === undefined
                ? undefined
                : this.#projects.getWorkspace(inherited.projectId, inherited.workspaceId);
        if (
            inherited?.workspaceId !== undefined &&
            (inheritedWorkspace === undefined ||
                workspaceRunReadiness(this.#projects, {
                    cwd: inherited.cwd,
                    projectId: inherited.projectId,
                    workspaceId: inherited.workspaceId,
                }).state !== "ready")
        ) {
            throw new Error("The parent session workspace is not ready and available.");
        }
        const ownership = (() => {
            if (inherited === undefined) {
                if (request.workspaceId !== undefined) {
                    return this.#projects.resolveSessionOwnership(
                        request.cwd,
                        request.workspaceId,
                        request.projectId,
                    );
                }
                return this.#projects.resolve(request.cwd, undefined, request.projectId);
            }
            if (
                request.workspaceId !== undefined &&
                request.workspaceId !== inherited.workspaceId
            ) {
                return this.#projects.resolve(
                    request.cwd,
                    request.workspaceId,
                    inherited.projectId,
                );
            }
            const project = this.#projects.getProject(inherited.projectId);
            if (project === undefined) {
                throw new Error("The parent session project was not found.");
            }
            return {
                project,
                ...(inheritedWorkspace === undefined ? {} : { workspace: inheritedWorkspace }),
            };
        })();
        if (ownership.workspace !== undefined) {
            this.#assertWorkspaceAcceptingSessions(ownership.workspace.id);
        }
        const session = new InMemorySession({
            presence: this.presence,
            agentManager: this.#agentManager,
            workspaceRunReadiness: (target) => workspaceRunReadiness(this.#projects, target),
            createEventId: createEventIdFactory(),
            ...(this.#createRuntime === undefined ? {} : { createRuntime: this.#createRuntime }),
            modelCatalog: this.#modelCatalog,
            onInitialTitle: (metadata) => this.#inheritWorkspaceTitle(metadata),
            ...(this.#mcpToolProvider !== undefined
                ? { mcpToolProvider: this.#mcpToolProvider }
                : {}),
            ...(metadata !== undefined ? { metadata } : {}),
            ...(contextMessages !== undefined ? { initialContextMessages: contextMessages } : {}),
            ...(id === undefined ? {} : { id }),
            onAppendEvent: (event) => this.#publishGlobalEvent(event),
            orderKey: sessionOrderKeyForCreation(metadata?.type, () =>
                this.#newLastSessionOrderKey(ownership.project.id, ownership.workspace?.id),
            ),
            projectId: ownership.project.id,
            projectSecretIds: this.#projectSecrets(ownership.project.id),
            request,
            secretRegistry: this.#secrets,
            slotStores: { entries: this.slots, webapps: this.webapps },
            ...(ownership.workspace === undefined ? {} : { workspaceId: ownership.workspace.id }),
        });
        this.#sessions.set(session.id, session);
        return session;
    }

    #inheritWorkspaceTitle(
        metadata: Parameters<NonNullable<InMemorySessionOptions["onInitialTitle"]>>[0],
    ): void {
        const first = [...this.#sessions.values()]
            .filter((session) => {
                const identity = session.projectIdentity();
                return (
                    !session.isSubagent() &&
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
        this.#projects.inheritWorkspaceTitle(
            metadata.projectId,
            metadata.workspaceId,
            metadata.title,
        );
    }

    get(sessionId: string): InMemorySession | undefined {
        return this.#sessions.get(sessionId);
    }

    attachment(sessionId: string, attachmentId: string) {
        return this.get(sessionId)?.attachment(attachmentId);
    }

    findByAgentId(agentId: string): InMemorySession | undefined {
        const matches = [...this.#sessions.values()].filter(
            (session) => session.agentIdentity().agentId === agentId,
        );
        return matches.length === 1 ? matches[0] : undefined;
    }

    list(options: { limit?: number } = {}): readonly SessionSummary[] {
        const projectOrder = new Map(
            this.#projects.listProjects().map((project) => [project.id, project.orderKey]),
        );
        const workspaceOrder = new Map(
            this.#projects.listWorkspaces().map((workspace) => [workspace.id, workspace.orderKey]),
        );
        const sessions = positioned(
            [...this.#sessions.values()]
                .filter((session) => !session.isSubagent())
                .map((session) => session.summary()),
        ).sort((left, right) => sortSummariesByOrder(left, right, projectOrder, workspaceOrder));
        return options.limit === undefined ? sessions : sessions.slice(0, options.limit);
    }

    listActive(options: { limit?: number } = {}): readonly SessionSummary[] {
        const sessions = this.list().filter((session) => !session.archived);
        return options.limit === undefined ? sessions : sessions.slice(0, options.limit);
    }

    loadedSessions(): readonly InMemorySession[] {
        return [...this.#sessions.values()];
    }

    listExternalToolCalls(
        options: { limit?: number; status?: ExternalToolCall["status"] } = {},
    ): readonly ExternalToolCall[] {
        return [...this.#sessions.values()]
            .flatMap((session) =>
                session.externalToolCalls(
                    options.status === undefined ? {} : { status: options.status },
                ),
            )
            .sort((left, right) => left.createdAt - right.createdAt)
            .slice(0, options.limit ?? 100);
    }

    listDurableUserInputs(): readonly DurableUserInputCall[] {
        return [...this.#sessions.values()].flatMap(
            (session) => session.state().durableUserInputs ?? [],
        );
    }

    listSubagents(parentSessionId: string): readonly SubagentSummary[] {
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

    queryAgentTreeUsage(sessionId: string) {
        return queryLiveAgentTreeUsage(this.#sessions.values(), sessionId);
    }

    listSecrets(): readonly SecretSummary[] {
        return this.#secrets.references();
    }

    timeline(request: GetTimelineRequest): readonly TimelineAgent[] {
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
        return buildTimeline(agents, events, {
            ...(request.since === undefined ? {} : { since: request.since }),
        });
    }

    async transferSession(
        sessionId: string,
        request: TransferSessionRequest,
    ): Promise<TransferSessionResponse | undefined> {
        return this.#executeSessionTransfer(sessionId, request.targetWorkspaceId, false);
    }

    async #executeSessionTransfer(
        sessionId: string,
        targetWorkspaceId: string,
        scheduled: boolean,
    ): Promise<TransferSessionResponse | undefined> {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        return executeSessionWorkspaceTransfer({
            hasAttachedSessions: (workspaceId) =>
                [...this.#sessions.values()].some((candidate) => {
                    const snapshot = candidate.snapshot();
                    return snapshot.archived !== true && snapshot.workspaceId === workspaceId;
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
        if (scope.kind === "project") return summary.projectId === scope.projectId;
        if (scope.kind === "workspace") return summary.workspaceId === scope.workspaceId;
        let candidateId: string | undefined = session.id;
        while (candidateId !== undefined) {
            if (candidateId === scope.sessionId) return true;
            candidateId = this.#sessions.get(candidateId)?.agentMetadata().parentSessionId;
        }
        return false;
    }

    registerSecret(request: RegisterSecretRequest): SecretSummary {
        this.#secrets.register(request);
        return this.#secrets.reference(request.id);
    }

    unregisterSecret(secretId: string): boolean {
        const removed = this.#secrets.unregister(secretId);
        if (!removed) return false;
        for (const ids of this.#projectSecretIds.values()) ids.delete(secretId);
        for (const session of this.#sessions.values()) {
            session.detachSecret(secretId, { scope: "project" });
            session.detachSecret(secretId, { scope: "session" });
        }
        return true;
    }

    getProject(projectId: string): Project | undefined {
        return this.#projects.getProject(projectId);
    }

    applyGitFacts(
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): void {
        this.#projects.applyGitFacts(target, facts);
    }

    listProjects(): readonly Project[] {
        return this.#projects.listProjects();
    }

    registerProject(request: RegisterProjectRequest): Promise<Project> {
        return this.#projects.registerProject(request);
    }

    getWorkspace(projectId: string, workspaceId: string): ProjectWorkspace | undefined {
        return this.#projects.getWorkspace(projectId, workspaceId);
    }

    listWorkspaces(projectId?: string): readonly ProjectWorkspace[] {
        return this.#projects.listWorkspaces(projectId);
    }

    renameProject(
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Project | undefined {
        return this.#projects.renameProject(projectId, name, expectedVersion, mutationId);
    }

    queryProjectSettings(cwd: string): ProjectSessionSettings | undefined {
        return this.#projects.queryProjectSettings(cwd);
    }

    setProjectSettings(
        projectId: string,
        settings: ProjectSettingsUpdate,
        expectedVersion?: number,
        mutationId?: string,
    ): Project | undefined {
        return this.#projects.setProjectSettings(projectId, settings, expectedVersion, mutationId);
    }

    refreshProject(projectId: string): Project | undefined {
        return this.#projects.refreshProject(projectId);
    }

    reorderProject(
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Project | undefined {
        return this.#projects.reorderProject(projectId, request, expectedVersion);
    }

    reorderSession(sessionId: string, request: ReorderRequest): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        if (session.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        const snapshot = session.snapshot();
        const siblings = [...this.#sessions.values()]
            .filter((candidate) => {
                if (candidate.isSubagent()) return false;
                const candidateSnapshot = candidate.snapshot();
                return (
                    candidateSnapshot.projectId === snapshot.projectId &&
                    candidateSnapshot.workspaceId === snapshot.workspaceId
                );
            })
            .map((candidate) => candidate.summary());
        session.setOrderKey(orderKeyAfter(positioned(siblings), sessionId, request.afterId));
        return session;
    }

    reorderWorkspace(
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): ProjectWorkspace | undefined {
        return this.#projects.reorderWorkspace(projectId, workspaceId, request, expectedVersion);
    }

    renameWorkspace(
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): ProjectWorkspace | undefined {
        return this.#projects.renameWorkspace(
            projectId,
            workspaceId,
            name,
            expectedVersion,
            mutationId,
        );
    }

    createWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspace | undefined> {
        return this.#projects.createWorkspace(projectId, request);
    }

    /*
     * Archiving a project hides the whole folder: its root chats are archived, and every managed
     * workspace is archived with the sessions and worktree directory it owns.
     */
    async archiveProject(
        projectId: string,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        let project: Project | undefined;
        let workspaces: { cleanup: Promise<void>[]; workspaceId: string }[] = [];
        this.#transaction(() => {
            project = this.#projects.archiveProject(projectId, expectedVersion);
            if (project === undefined) return;
            for (const session of this.#sessions.values()) {
                if (session.isSubagent()) continue;
                const snapshot = session.snapshot();
                if (snapshot.projectId !== projectId || snapshot.workspaceId !== undefined) {
                    continue;
                }
                session.setArchived(true);
            }
            workspaces = this.#projects.listWorkspaces(projectId).flatMap((workspace) => {
                if (workspace.status === "archived" || workspace.status === "archiving") return [];
                const archiving = this.#projects.beginWorkspaceArchive(projectId, workspace.id);
                if (archiving === undefined || archiving.status === "archived") return [];
                return [
                    {
                        cleanup: [...this.#sessions.values()]
                            .filter((session) => session.snapshot().workspaceId === workspace.id)
                            .map((session) => session.archiveForWorkspace(workspace.id)()),
                        workspaceId: workspace.id,
                    },
                ];
            });
        });
        if (project === undefined) return undefined;
        // Every logical archive write above is complete before physical terminal
        // and worktree cleanup yields, so a later unarchive can never be
        // overtaken by stale child writes from this operation.
        await this.remoteTerminals.closeProject(projectId);
        for (const workspace of workspaces) {
            await this.#completeWorkspaceArchive(
                projectId,
                workspace.workspaceId,
                workspace.cleanup,
            );
        }
        return this.getProject(projectId);
    }

    unarchiveProject(projectId: string): Project | undefined {
        return this.#projects.unarchiveProject(projectId);
    }

    archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        const workspace = this.#projects.beginWorkspaceArchive(
            projectId,
            workspaceId,
            expectedVersion,
        );
        if (workspace === undefined || workspace.status === "archived") {
            return Promise.resolve(workspace);
        }
        const cleanup = [...this.#sessions.values()]
            .filter((session) => session.snapshot().workspaceId === workspaceId)
            .map((session) => session.archiveForWorkspace(workspaceId)());
        cleanup.push(this.remoteTerminals.closeWorkspace(projectId, workspaceId));
        void this.#completeWorkspaceArchive(projectId, workspaceId, cleanup).catch(
            (error: unknown) => {
                // Residue left behind is worth a warning because a later attempt can still clear
                // it. A database that cannot answer is neither reportable nor retryable.
                if (isDatabaseFailure(error)) throw error;
                this.#onWorkspaceCleanupError?.(error, projectId, workspaceId);
            },
        );
        return Promise.resolve(workspace);
    }

    async #completeWorkspaceArchive(
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
        return this.#projects.removeArchivedWorkspace(projectId, workspaceId);
    }

    setProjectAvatar(
        projectId: string,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        return this.#projects.setAvatar(projectId, "user", bytes, expectedVersion);
    }

    clearProjectAvatar(projectId: string): Project | undefined {
        return this.#projects.clearAvatar(projectId);
    }

    getProjectAvatar(hash: string): Promise<ProjectAvatarAsset | undefined> {
        return this.#projects.avatarAsset(hash);
    }

    changeModel(sessionId: string, request: ChangeModelRequest): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        session.changeModel(request);
        return session;
    }

    #projectSecrets(projectId: string): readonly string[] {
        return [...(this.#projectSecretIds.get(projectId) ?? [])];
    }

    #remoteTerminalContext(scope: RemoteTerminalScope): ProjectRemoteTerminalContext {
        const project = this.#projects.getProject(scope.projectId);
        if (project === undefined) throw new Error("Project not found.");
        if (project.archivedAt !== undefined) {
            throw new Error("Archived projects cannot open terminals.");
        }
        const workspace =
            scope.workspaceId === undefined
                ? undefined
                : this.#projects.getWorkspace(scope.projectId, scope.workspaceId);
        if (scope.workspaceId !== undefined && workspace === undefined) {
            throw new Error("Workspace not found.");
        }
        if (
            workspace !== undefined &&
            workspaceRunReadiness(this.#projects, {
                cwd: workspace.path,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
            }).state !== "ready"
        ) {
            throw new Error("Only ready, available workspaces can open terminals.");
        }
        const cwd = workspace?.path ?? project.path;
        const docker = configureSessionRequest({ cwd }, this.#defaultDocker, () =>
            this.#projects.queryProjectSettings(cwd),
        ).docker;
        return {
            cwd,
            ...(docker === undefined ? {} : { docker }),
        };
    }

    #newLastSessionOrderKey(projectId: string, workspaceId: string | undefined): string {
        const candidates = [...this.#sessions.values()]
            .filter((session) => {
                if (session.isSubagent()) return false;
                const snapshot = session.snapshot();
                return snapshot.projectId === projectId && snapshot.workspaceId === workspaceId;
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

    #projectEvent(event: Parameters<GlobalEventQueue["append"]>[0]): void {
        this.#publishGlobalEvent(event);
        if (event.type !== "workspace_created" && event.type !== "workspace_updated") return;
        if (event.data.workspace.status === "initializing") return;
        this.#afterTransactionCommit(() => {
            this.#workspaceReadyWaiters.changed(event.projectId, event.workspaceId);
            for (const session of this.#sessions.values()) {
                const state = session.state();
                if (
                    state.workspaceId === event.workspaceId &&
                    state.workspaceQueueWaiting === true
                ) {
                    session.workspaceReadinessChanged();
                }
            }
        });
    }

    #publishGlobalEvent(event: Parameters<GlobalEventQueue["append"]>[0]): void {
        // Every event reaches the ephemeral stream, including the transient ones
        // the durable log drops, because one subscription has to be enough.
        this.#afterTransactionCommit(() => this.liveEvents.publish(event));
        if (isLiveGlobalEvent(event)) {
            this.#afterTransactionCommit(() => {
                this.globalEventQueue.publishLive(event);
            });
            return;
        }
        if (!shouldPublishGlobalEvent(event)) return;
        this.#afterTransactionCommit(() => {
            const entry = this.globalEventQueue.append(event);
            if (entry !== undefined) this.globalEventQueue.publish(entry);
        });
    }

    #transaction<T>(body: (tx: TX) => T): T {
        if (this.#activeTransaction !== undefined) return body(this.#activeTransaction);
        this.#transactionCommitCallbacks = [];
        try {
            const value = inTx(this.#database, (tx) => {
                this.#activeTransaction = tx;
                try {
                    return body(tx);
                } finally {
                    this.#activeTransaction = undefined;
                }
            });
            const callbacks = this.#transactionCommitCallbacks;
            this.#transactionCommitCallbacks = undefined;
            for (const callback of callbacks) {
                try {
                    callback();
                } catch (error) {
                    if (isDatabaseFailure(error)) throw error;
                    // The project transaction already committed; observers are best effort.
                }
            }
            return value;
        } catch (error) {
            this.#activeTransaction = undefined;
            this.#transactionCommitCallbacks = undefined;
            throw error;
        }
    }

    close(): void {
        void this.remoteTerminals.close();
        this.#workspaceReadyWaiters.close();
        this.#projects.close();
        this.liveEvents.close();
        this.globalEventQueue.deactivate();
        this.#client.close();
    }

    #afterTransactionCommit(callback: () => void): void {
        if (this.#client.inTransaction) {
            this.#transactionCommitCallbacks?.push(callback);
            return;
        }
        callback();
    }
}

function compareOrderKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
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
    return (
        compareOrderKeys(
            projectOrder.get(left.projectId) ?? "",
            projectOrder.get(right.projectId) ?? "",
        ) ||
        Number(left.workspaceId !== undefined) - Number(right.workspaceId !== undefined) ||
        compareOrderKeys(
            left.workspaceId === undefined ? "" : (workspaceOrder.get(left.workspaceId) ?? ""),
            right.workspaceId === undefined ? "" : (workspaceOrder.get(right.workspaceId) ?? ""),
        ) ||
        compareOrderKeys(left.orderKey, right.orderKey) ||
        compareOrderKeys(left.id, right.id)
    );
}
