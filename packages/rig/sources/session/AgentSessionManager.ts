import { createId } from "@paralleldrive/cuid2";

import {
    createSubagentInstructions,
    findLastAgentResponseText,
    type ChatHistoryRole,
    type ChatHistoryPage,
    type AgentCommunicationContext,
    type AgentCommunicationInfo,
    selectChatHistoryPage,
    type ManagedSubagent,
    type SpawnSubagentRequest,
    type SpawnSubagentResult,
    type SubagentRunStatus,
    type WaitForSubagentResult,
    type AgentTreeUsage,
} from "../agent/index.js";
import { DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS } from "../agent/context/subagentWaitTimeouts.js";
import { isCodexV2CollaborationModel } from "../agent/tools/codex/isCodexV2CollaborationModel.js";
import type {
    CreateProjectWorkspaceRequest,
    CreateSessionRequest,
    Project,
    ProjectWorkspace,
    SessionAgentMetadata,
} from "../protocol/index.js";
import type {
    AgentProject,
    AgentWorkspace,
    AgentWorkspaceSession,
    DelegatedSession,
    DelegatedSessionRequest,
    WorkspaceAgentRequest,
    AgentSessionTransferSchedule,
} from "../agent/context/WorkspaceContext.js";
import type { Message } from "../agent/types.js";
import { modelSupportsHostedCapabilities, type HostedCapability } from "@slopus/rig-execution";
import { assertGrantIsNarrowing, grantableCapabilities } from "./hostedCapabilityGrants.js";
import type { PermissionMode } from "../permissions/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import { throwIfAborted } from "../concurrency/index.js";
import { resolveSharedAgentPath } from "./impl/resolveSharedAgentPath.js";
import type { InMemorySession } from "./InMemorySession.js";

export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 8;
export const DEFAULT_MAX_ACTIVE_CODEX_V2_SUBAGENTS = 3;

export interface AgentSessionRepository {
    archiveOwnedWorkspace?(
        ownerSessionId: string,
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined>;
    createOwnedWorkspace?(
        ownerSessionId: string,
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspace | undefined>;
    createSubagent(
        request: CreateSessionRequest,
        metadata: SessionAgentMetadata,
        contextMessages?: readonly Message[],
    ): InMemorySession;
    createDelegatedSession?(
        request: CreateSessionRequest,
        metadata: SessionAgentMetadata,
        id: string,
    ): InMemorySession;
    configureWorkspaceRequest?(request: CreateSessionRequest): CreateSessionRequest;
    findByAgentId?(agentId: string): InMemorySession | undefined;
    get(sessionId: string): InMemorySession | undefined;
    listByRoot(rootSessionId: string): readonly InMemorySession[];
    listProjects?(): readonly Project[];
    registerProject?(path: string): Promise<Project>;
    listProjectWorkspaces?(projectId: string): readonly ProjectWorkspace[];
    listProjectSessions?(target: {
        projectId: string;
        workspaceId?: string;
    }): readonly AgentWorkspaceSession[];
    queryAgentTreeUsage?(sessionId: string): AgentTreeUsage | undefined;
    ownedWorkspace?(
        ownerSessionId: string,
        projectId: string,
        workspaceId: string,
    ): ProjectWorkspace | undefined;
    workspace?(projectId: string, workspaceId: string): ProjectWorkspace | undefined;
    waitForWorkspaceReady?(
        projectId: string,
        workspaceId: string,
        signal?: AbortSignal,
    ): Promise<ProjectWorkspace>;
    completeScheduledSessionTransfer?(sessionId: string, targetWorkspaceId: string): Promise<void>;
    scheduleSessionTransfer?(
        sessionId: string,
        targetWorkspaceId: string,
    ): AgentSessionTransferSchedule;
}

export interface AgentSessionManagerOptions {
    maxActive?: number;
    maxDepth?: number;
    repository: AgentSessionRepository;
    taskDrain?: TaskDrain;
}

export class AgentSessionManager {
    readonly maxActive: number;
    readonly maxDepth: number;

    readonly #repository: AgentSessionRepository;
    readonly #lastSuccessfulModelByProvider = new Map<string, string>();
    readonly #lastSuccessfulProviderByModel = new Map<string, string>();
    readonly #latestBackgroundRunBySession = new Map<string, string>();
    readonly #pendingBackgroundRuns = new Map<string, string>();
    readonly #slotReservations = new Map<string, number>();
    readonly #stoppedExplicitly = new Set<string>();
    readonly #taskDrain: TaskDrain | undefined;

    constructor(options: AgentSessionManagerOptions) {
        this.#repository = options.repository;
        this.#taskDrain = options.taskDrain;
        this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE_SUBAGENTS;
        this.maxDepth = options.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
    }

    taskSession(sessionId: string): InMemorySession | undefined {
        const session = this.#repository.get(sessionId);
        if (session === undefined) return undefined;
        return this.#repository.get(session.agentMetadata().rootSessionId) ?? session;
    }

    maxActiveFor(rootSessionId: string): number {
        const root = this.#repository.get(rootSessionId);
        return root?.isCodexV2Collaboration?.() === true
            ? Math.min(this.maxActive, DEFAULT_MAX_ACTIVE_CODEX_V2_SUBAGENTS)
            : this.maxActive;
    }

    queryAgentTreeUsage(sessionId: string): AgentTreeUsage {
        const query = this.#repository.queryAgentTreeUsage;
        if (query === undefined) {
            throw new Error("Agent tree usage is unavailable in this session.");
        }
        const usage = query(sessionId);
        if (usage === undefined) {
            throw new Error("The current session is no longer available.");
        }
        return usage;
    }

    recordChanged(child: InMemorySession): void {
        let parent = this.#parentFor(child);
        while (parent !== undefined) {
            parent.recordSubagentChanged(child.subagentSummary());
            parent = this.#parentFor(parent);
        }
    }

    recordSuccessfulProvider(modelId: string, providerId: string): void {
        this.#lastSuccessfulModelByProvider.set(providerId, modelId);
        this.#lastSuccessfulProviderByModel.set(modelId, providerId);
    }

    async createWorkspace(
        ownerSessionId: string,
        input: { baseRef?: string; name: string },
    ): Promise<ProjectWorkspace> {
        const owner = this.#repository.get(ownerSessionId);
        const create = this.#repository.createOwnedWorkspace;
        if (owner === undefined || create === undefined) {
            throw new Error("This session cannot create managed workspaces.");
        }
        if (owner.isSubagent()) {
            throw new Error("Only a primary session can create a managed workspace.");
        }
        const workspace = await create(ownerSessionId, owner.snapshot().projectId, input);
        if (workspace === undefined) throw new Error("The workspace could not be created.");
        return workspace;
    }

    async archiveWorkspace(ownerSessionId: string, workspaceId: string): Promise<ProjectWorkspace> {
        const owner = this.#repository.get(ownerSessionId);
        const archive = this.#repository.archiveOwnedWorkspace;
        if (owner === undefined || archive === undefined) {
            throw new Error("This session cannot archive managed workspaces.");
        }
        const workspace = await archive(ownerSessionId, owner.snapshot().projectId, workspaceId);
        if (workspace === undefined) {
            throw new Error("This workspace was not created by the current session.");
        }
        return workspace;
    }

    async scheduleSessionTransfer(
        sessionId: string,
        targetWorkspaceId: string,
    ): Promise<AgentSessionTransferSchedule> {
        const schedule = this.#repository.scheduleSessionTransfer;
        if (schedule === undefined) {
            throw new Error("This session cannot be transferred between workspaces.");
        }
        return schedule(sessionId, targetWorkspaceId);
    }

    async completeScheduledSessionTransfer(
        sessionId: string,
        targetWorkspaceId: string,
    ): Promise<void> {
        const complete = this.#repository.completeScheduledSessionTransfer;
        if (complete === undefined) {
            throw new Error("This session cannot be transferred between workspaces.");
        }
        await complete(sessionId, targetWorkspaceId);
    }

    listProjects(sessionId: string): readonly AgentProject[] {
        const list = this.#repository.listProjects;
        if (list === undefined) throw new Error("This session cannot list projects.");
        const currentProjectId = this.#current(sessionId).snapshot().projectId;
        return list().map((project) => ({
            current: project.id === currentProjectId,
            id: project.id,
            name: project.name,
            path: project.path,
        }));
    }

    async registerProject(sessionId: string, path: string): Promise<AgentProject> {
        const register = this.#repository.registerProject;
        if (register === undefined) throw new Error("This session cannot add projects.");
        const project = await register(path);
        return {
            current: project.id === this.#current(sessionId).snapshot().projectId,
            id: project.id,
            name: project.name,
            path: project.path,
        };
    }

    listWorkspaces(
        sessionId: string,
        projectId: string | undefined,
        options: { crossWorkspace: boolean },
    ): readonly AgentWorkspace[] {
        const list = this.#repository.listProjectWorkspaces;
        if (list === undefined) throw new Error("This session cannot list workspaces.");
        const target = this.#targetProjectId(sessionId, projectId, options);
        return list(target).map((workspace) => this.#agentWorkspace(sessionId, workspace));
    }

    listSessions(
        sessionId: string,
        target: { projectId?: string; workspaceId?: string },
        options: { crossWorkspace: boolean },
    ): readonly AgentWorkspaceSession[] {
        const list = this.#repository.listProjectSessions;
        if (list === undefined) throw new Error("This session cannot list conversations.");
        const projectId = this.#targetProjectId(sessionId, target.projectId, options);
        return list({
            projectId,
            ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
        });
    }

    /**
     * Starts a user-visible conversation in another workspace on behalf of a session.
     *
     * The new session is a primary one: it holds its own place in the session list and the user
     * may take it over. The delegator is recorded so it can be told when they do, and it talks to
     * the session afterwards through the ordinary agent messaging tools.
     */
    async delegate(
        delegatorSessionId: string,
        request: DelegatedSessionRequest,
        options: { crossWorkspace: boolean } = { crossWorkspace: true },
        signal?: AbortSignal,
    ): Promise<DelegatedSession> {
        const delegator = this.#current(delegatorSessionId);
        const create = this.#repository.createDelegatedSession;
        const resolveWorkspace = this.#repository.workspace;
        if (create === undefined || resolveWorkspace === undefined) {
            throw new Error("This session cannot start work in another workspace.");
        }
        if (delegator.isSubagent()) {
            throw new Error("Only a primary session can start work in another workspace.");
        }
        const snapshot = delegator.snapshot();
        const projectId = this.#targetProjectId(delegatorSessionId, request.projectId, options);
        let workspace = resolveWorkspace(projectId, request.workspaceId);
        if (workspace === undefined) {
            throw new Error("That workspace was not found in that project.");
        }
        workspace = await this.#workspaceReady(projectId, workspace, signal);
        if (workspace.id === snapshot.workspaceId) {
            throw new Error("That workspace is the one this session already works in.");
        }
        const sessionId = createId();
        const selection = this.#resolveSubagentSelection(delegator, request);
        const workspaceRequest = {
            ...(selection.parentRequest ?? delegator.requestForSubagent()),
            cwd: workspace.path,
            effort: request.effort,
            modelId: request.modelId,
            projectId,
            trackUnread: true,
            workspaceId: workspace.id,
            ...(selection.providerId === undefined ? {} : { providerId: selection.providerId }),
            ...(request.readOnly === true ? { permissionMode: "read_only" as const } : {}),
            ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
        };
        const delegate = create(
            this.#repository.configureWorkspaceRequest?.(workspaceRequest) ?? workspaceRequest,
            {
                delegatedBySessionId: delegatorSessionId,
                depth: 0,
                rootSessionId: sessionId,
                type: "primary",
                ...(request.title === undefined ? {} : { description: request.title }),
            },
            sessionId,
        );
        const submitted = delegate.submit({
            agentMessageTriggerTurn: true,
            provenance: "agent",
            text: request.prompt,
        });
        this.#startDelegatedRunMonitor(delegator, delegate, submitted.runId);
        return {
            agentId: delegate.agentIdentity().agentId,
            projectId,
            sessionId: delegate.id,
            title: request.title ?? "Untitled conversation",
            workspaceId: workspace.id,
            workspacePath: workspace.path,
        };
    }

    /**
     * Tells a delegator that the user has taken their delegated session over.
     *
     * The delegator keeps working, but it must not assume it is still the only voice in that
     * conversation, so it is given what the user actually said.
     */
    notifyDelegatorOfUserMessage(sessionId: string, text: string): void {
        const delegate = this.#repository.get(sessionId);
        const delegatorSessionId = delegate?.agentMetadata().delegatedBySessionId;
        if (delegate === undefined || delegatorSessionId === undefined) return;
        const delegator = this.#repository.get(delegatorSessionId);
        if (delegator === undefined || delegator.isClosing?.() === true) return;
        const title = delegate.agentIdentity().title ?? "the delegated conversation";
        try {
            delegator.deliverNotification({
                displayText: `The user replied in "${title}" themselves.`,
                text: [
                    "<delegated-session-notification>",
                    `Session: ${delegate.id}`,
                    `Agent ID: ${delegate.agentIdentity().agentId}`,
                    `Title: ${title}`,
                    "The user wrote to this delegated session directly. They are steering it now.",
                    "User message:",
                    text,
                    "</delegated-session-notification>",
                ].join("\n"),
            });
        } catch (error) {
            // Reaching the delegator is best effort; a delegator that cannot take the news must
            // not break the user's own message. A database that cannot record it still must.
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #targetProjectId(
        sessionId: string,
        projectId: string | undefined,
        options: { crossWorkspace: boolean },
    ): string {
        const currentProjectId = this.#current(sessionId).snapshot().projectId;
        if (projectId === undefined || projectId === currentProjectId) return currentProjectId;
        if (!options.crossWorkspace) {
            throw new Error(
                "Looking into another project is turned off. Ask the user to enable features.cross_workspace in their Rig configuration.",
            );
        }
        return projectId;
    }

    #agentWorkspace(sessionId: string, workspace: ProjectWorkspace): AgentWorkspace {
        const owned =
            this.#repository.ownedWorkspace?.(sessionId, workspace.projectId, workspace.id) !==
            undefined;
        return {
            archived: workspace.status === "archiving" || workspace.status === "archived",
            id: workspace.id,
            name: workspace.name,
            path: workspace.path,
            projectId: workspace.projectId,
            status: workspace.status,
            ...(owned ? { owned } : {}),
        };
    }

    #startDelegatedRunMonitor(
        delegator: InMemorySession,
        delegate: InMemorySession,
        runId: string,
    ): void {
        const monitor = async () => {
            const completion = await delegate.waitForRun(runId);
            if (delegator.isClosing?.() === true) return;
            const title = delegate.agentIdentity().title ?? "the delegated conversation";
            const output = this.#completionOutput(
                delegate,
                completion.status,
                completion.errorMessage,
            );
            delegator.deliverNotification({
                displayText: `Delegated work in "${title}" ${
                    completion.status === "completed"
                        ? "completed"
                        : completion.status === "aborted"
                          ? "was stopped"
                          : "failed"
                }.`,
                text: [
                    "<delegated-session-notification>",
                    `Session: ${delegate.id}`,
                    `Agent ID: ${delegate.agentIdentity().agentId}`,
                    `Title: ${title}`,
                    `Status: ${completion.status}`,
                    `Result: ${output}`,
                    "</delegated-session-notification>",
                ].join("\n"),
            });
        };
        const task = this.#taskDrain?.run(monitor) ?? monitor();
        void task.catch((error: unknown) => {
            if (isDatabaseFailure(error)) throw error;
        });
    }

    async spawnInWorkspace(
        parentSessionId: string,
        request: WorkspaceAgentRequest,
        signal?: AbortSignal,
    ): Promise<SpawnSubagentResult> {
        const parent = this.#current(parentSessionId);
        const resolveWorkspace = this.#repository.ownedWorkspace;
        if (parent === undefined || resolveWorkspace === undefined) {
            throw new Error("This session cannot start workspace agents.");
        }
        const projectId = parent.snapshot().projectId;
        throwIfAborted(signal);
        let workspace = resolveWorkspace(parentSessionId, projectId, request.workspaceId);
        if (workspace === undefined) {
            throw new Error("This workspace was not created by the current session.");
        }
        workspace = await this.#workspaceReady(projectId, workspace, signal);
        return this.spawn(
            parentSessionId,
            { ...request, cwd: workspace.path, workspaceId: workspace.id },
            signal,
        );
    }

    async #workspaceReady(
        projectId: string,
        workspace: ProjectWorkspace,
        signal: AbortSignal | undefined,
    ): Promise<ProjectWorkspace> {
        throwIfAborted(signal);
        if (workspace.status === "initializing") {
            const wait = this.#repository.waitForWorkspaceReady;
            if (wait === undefined) {
                throw new Error("The workspace is initializing and cannot start work yet.");
            }
            workspace = await wait(projectId, workspace.id, signal);
        }
        if (workspace.status !== "ready") {
            throw new Error(
                `The workspace is ${workspace.status.replaceAll("_", " ")} and cannot start work.`,
            );
        }
        if (workspace.presence === "missing") {
            throw new Error("The workspace directory is unavailable and cannot start work.");
        }
        return workspace;
    }

    communicationContext(sessionId: string): AgentCommunicationContext {
        const inspectedAgentIds = new Set<string>();
        return {
            info: (agentId) => {
                const info = this.#info(sessionId, agentId);
                inspectedAgentIds.add(agentId);
                return info;
            },
            me: () => this.#current(sessionId).agentIdentity(),
            send: (agentId, message) => {
                if (!inspectedAgentIds.has(agentId)) {
                    throw new Error(
                        "Call agent_info with this agent ID before sending it a message.",
                    );
                }
                return this.#sendToAgent(sessionId, agentId, message);
            },
            setReadOnly: async (agentId, readOnly) => {
                if (!inspectedAgentIds.has(agentId)) {
                    throw new Error(
                        "Call agent_info with this agent ID before changing its permission mode.",
                    );
                }
                await this.#setAgentReadOnly(sessionId, agentId, readOnly);
            },
        };
    }

    sendScheduledMessage(
        senderSessionId: string,
        targetAgentId: string,
        message: string,
        messageId: string,
    ): void {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        this.#deliverAgentMessage(sender, target, message, messageId);
    }

    async changeSubagentPermissionModes(
        parentSessionId: string,
        permissionMode: PermissionMode,
    ): Promise<void> {
        const root = this.#rootFor(parentSessionId);
        const results = await Promise.allSettled(
            this.#repository.listByRoot(root.id).map(async (session) => {
                try {
                    await session.changePermissionMode(
                        { permissionMode },
                        { updateSubagents: false },
                    );
                } catch (error) {
                    try {
                        await session.beginShutdown();
                    } catch (shutdownError) {
                        throw new AggregateError(
                            [error, shutdownError],
                            `Could not reduce permissions or stop descendant ${session.id}.`,
                        );
                    }
                    throw error;
                }
            }),
        );
        const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
            throw new AggregateError(errors, "Could not update every descendant permission mode.");
        }
    }

    followUp(
        parentSessionId: string,
        target: string,
        message: string,
        effort?: string,
        encryptedMessage?: string,
    ): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const parent = this.#current(parentSessionId);
        if (encryptedMessage !== undefined) {
            const parentTransportScope = parent?.encryptedAgentTransportScope();
            if (
                parentTransportScope === undefined ||
                parentTransportScope !== child.encryptedAgentTransportScope()
            ) {
                throw new Error(
                    "Native encrypted collaboration only works within the same compatible provider and region. Retry with `rig.followup_task` and provide the task normally.",
                );
            }
        }
        const childStatus = child.subagentSummary().status;
        if (childStatus !== "running" && childStatus !== "queued") {
            this.#assertTurnSlotAvailable(child.agentMetadata().rootSessionId);
        }
        if (childStatus === "suspended") child.clearSuspension();
        this.#stoppedExplicitly.delete(child.id);
        const childPath = this.#pathFor(child);
        const parentPath = this.#pathFor(parent);
        const submitted = child.submit({
            agentMessageTriggerTurn: true,
            ...(this.#repository.get(parentSessionId)?.activeRunDebug?.() === true
                ? { debug: true }
                : {}),
            ...(effort === undefined ? {} : { effort }),
            ...(encryptedMessage === undefined
                ? {}
                : {
                      encryptedAgentMessage: {
                          author: parentPath,
                          recipient: childPath,
                          header: agentMessageHeader(
                              parent,
                              parentPath,
                              child,
                              childPath,
                              "NEW_TASK",
                          ),
                          encryptedContent: encryptedMessage,
                      },
                      displayText: "Follow-up task",
                  }),
            provenance: "agent",
            text: message,
        });
        const childParent = this.#parentFor(child);
        this.recordChanged(child);
        this.#startBackgroundMonitor(childParent, child, submitted.runId);
        return this.#managedSubagent(child);
    }

    sendMessage(
        parentSessionId: string,
        target: string,
        message: string,
        encryptedMessage?: string,
    ): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const parent = this.#current(parentSessionId);
        if (encryptedMessage !== undefined) {
            const parentTransportScope = parent?.encryptedAgentTransportScope();
            if (
                parentTransportScope === undefined ||
                parentTransportScope !== child.encryptedAgentTransportScope()
            ) {
                throw new Error(
                    "Native encrypted collaboration only works within the same compatible provider and region.",
                );
            }
        }
        const childPath = this.#pathFor(child);
        const parentPath = this.#pathFor(parent);
        child.deliverAgentMessage({
            blocks: message.length === 0 ? [] : [{ type: "text", text: message }],
            id: crypto.randomUUID(),
            provenance: "agent",
            role: "user",
            ...(encryptedMessage === undefined
                ? {}
                : {
                      encryptedAgentMessage: {
                          author: parentPath,
                          recipient: childPath,
                          header: agentMessageHeader(
                              parent,
                              parentPath,
                              child,
                              childPath,
                              "MESSAGE",
                          ),
                          encryptedContent: encryptedMessage,
                      },
                  }),
        });
        this.recordChanged(child);
        return this.#managedSubagent(child);
    }

    async setSubagentReadOnly(
        parentSessionId: string,
        target: string,
        readOnly: boolean,
    ): Promise<ManagedSubagent> {
        const parent = this.#current(parentSessionId);
        const child = this.#resolveTarget(parentSessionId, target);
        await this.#changeChildPermissionMode(parent, child, readOnly, {
            updateSubagents: false,
        });
        this.recordChanged(child);
        return this.#managedSubagent(child);
    }

    interrupt(parentSessionId: string, target: string): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const previous = this.#managedSubagent(child);
        void this.stopDescendants(child.id);
        if (child.subagentSummary().status === "suspended") child.clearSuspension();
        void Promise.resolve(child.abort({ stopDescendants: false })).catch(rethrowDatabaseFailure);
        this.recordChanged(child);
        return previous;
    }

    inspect(parentSessionId: string, target: string): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const agent = this.#managedSubagent(child);
        if (
            agent.status === "completed" ||
            agent.status === "error" ||
            agent.status === "aborted"
        ) {
            return {
                ...agent,
                output: this.#completionOutput(
                    child,
                    agent.status,
                    agent.status === "error" ? child.lastErrorMessage() : undefined,
                ),
            };
        }
        return agent;
    }

    async pauseDescendants(parentSessionId: string): Promise<number> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return 0;
        const active = this.#activeDescendantsOf(parentSessionId).filter(
            (child) => !this.#belongsToRunningWorkflow(child, parent),
        );
        await Promise.all(
            active.map(async (child) => {
                await child.suspendByParent();
                this.recordChanged(child);
            }),
        );
        parent.recordSubagentsSuspended(active.map((child) => this.#managedSubagent(child)));
        return active.length;
    }

    async stopDescendants(parentSessionId: string): Promise<number> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return 0;
        // Workflows are independently managed background runs. Interrupting the parent can
        // cancel a wait for one, but only stopWorkflow, reset, or shutdown should stop its agents.
        const descendants = this.#descendantsOf(parentSessionId).filter(
            (child) => !this.#belongsToRunningWorkflow(child, parent),
        );
        const active = descendants.filter((child) => {
            const status = child.subagentSummary().status;
            return status === "queued" || status === "running";
        });
        const suspended = descendants.filter(
            (child) => child.subagentSummary().status === "suspended",
        );
        for (const child of suspended) {
            child.clearSuspension();
            this.recordChanged(child);
        }
        for (const child of active) this.#stoppedExplicitly.add(child.id);
        await Promise.all(
            active.map(async (child) => {
                await child.abort({ stopDescendants: false });
                this.recordChanged(child);
            }),
        );
        return active.length + suspended.length;
    }

    list(parentSessionId: string, pathPrefix?: string): readonly ManagedSubagent[] {
        const root = this.#rootFor(parentSessionId);
        const agents = this.#repository
            .listByRoot(root.id)
            .filter(
                (session) =>
                    session.isSubagent() && session.subagentSummary().status !== "archived",
            )
            .map((session) => this.#managedSubagent(session))
            .sort((left, right) => left.path.localeCompare(right.path));
        return pathPrefix === undefined
            ? agents
            : agents.filter((agent) => agent.path.startsWith(pathPrefix));
    }

    readChatHistory(
        currentSessionId: string,
        options: {
            cursor?: number;
            from?: "end" | "start";
            limit: number;
            query?: string;
            roles?: readonly ChatHistoryRole[];
            target?: string;
        },
    ): ChatHistoryPage {
        const current = this.#repository.get(currentSessionId);
        if (current === undefined) throw new Error("The current session is no longer available.");
        const root = this.#rootFor(currentSessionId);
        const sessions = [root, ...this.#repository.listByRoot(root.id)];
        const target = (() => {
            if (options.target === undefined) return current;
            const agentIdMatch = sessions.find(
                (session) => session.agentIdentity().agentId === options.target,
            );
            if (agentIdMatch !== undefined) return agentIdMatch;
            const matches = sessions.filter((session) => this.#pathFor(session) === options.target);
            if (matches.length === 0) {
                throw new Error(`Agent '${options.target}' was not found in this session tree.`);
            }
            if (matches.length > 1) {
                throw new Error(`Agent path '${options.target}' is ambiguous. Use its Agent ID.`);
            }
            return matches[0] as InMemorySession;
        })();
        const agents = sessions
            .map((session) => {
                const snapshot = session.snapshot();
                return {
                    ...(snapshot.agent.description === undefined
                        ? {}
                        : { description: snapshot.agent.description }),
                    agentId: session.agentIdentity().agentId,
                    messageCount: snapshot.snapshot.messages.length,
                    path: this.#pathFor(session),
                    status: snapshot.status,
                };
            })
            .sort((left, right) => left.path.localeCompare(right.path));
        const messages = target.snapshot().snapshot.messages;
        return {
            agent: agents.find(
                (agent) => agent.agentId === target.agentIdentity().agentId,
            ) as (typeof agents)[number],
            agents,
            ...selectChatHistoryPage(messages, options),
        };
    }

    hasActiveDescendantWork(rootSessionId: string): boolean {
        return this.#repository
            .listByRoot(rootSessionId)
            .some((session) => session.hasLocalSettlementWork());
    }

    recordDescendantSettlementActivity(rootSessionId: string): void {
        this.#repository.get(rootSessionId)?.recordDescendantActivity();
    }

    async spawn(
        parentSessionId: string,
        request: SpawnSubagentRequest,
        signal?: AbortSignal,
    ): Promise<SpawnSubagentResult> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) {
            throw new Error("The parent session is no longer available.");
        }
        if (
            request.encryptedPrompt !== undefined &&
            (parent.encryptedAgentTransportScope() === undefined ||
                request.providerId !== undefined ||
                (request.modelId !== undefined && !isCodexV2CollaborationModel(request.modelId)))
        ) {
            throw new Error(
                "Native encrypted collaboration only works within the current compatible provider and region. Use `rig.spawn_agent` and provide the task normally when selecting or crossing a model, provider, or region.",
            );
        }
        // Before anything else, because whether this agent may hand out a capability at all is a
        // question about the agent, not about the child it is trying to configure. Answering it
        // first is also what makes the refusal say so.
        const grantedCapabilities = this.#authorizeGrant(parent, request);

        const selection = this.#resolveSubagentSelection(parent, request);
        let parentRequest = selection.parentRequest;
        const childModelId = selection.modelId;
        const childProviderId = selection.providerId;

        if (
            grantedCapabilities.length > 0 &&
            childModelId !== undefined &&
            !modelSupportsHostedCapabilities(childModelId)
        ) {
            throw new Error(
                `Model '${childModelId}' cannot run ${grantedCapabilities.join(", ")}. Only Grok models execute search on the provider's backend.`,
            );
        }

        const parentMetadata = parent.agentMetadata();
        const depth = parentMetadata.depth + 1;
        if (depth > this.maxDepth) {
            throw new Error(`Subagents are limited to ${this.maxDepth} nested levels.`);
        }
        const releaseSlot = await this.#reserveSlot(
            parentMetadata.rootSessionId,
            request.waitForSlot === true,
            signal,
        );
        let child: InMemorySession;
        let submitted: ReturnType<InMemorySession["submit"]>;
        let taskName: string;
        try {
            parentRequest ??= parent.requestForSubagent();
            taskName = this.#taskName(parent, request.taskName, request.description);
            const metadata: SessionAgentMetadata = {
                depth,
                description: request.description,
                parentSessionId,
                ...(request.parentToolCallId !== undefined
                    ? { parentToolCallId: request.parentToolCallId }
                    : {}),
                rootSessionId: parentMetadata.rootSessionId,
                taskName,
                type: "subagent",
            };
            const childRequest = {
                ...parentRequest,
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
                instructions: createSubagentInstructions(
                    parentRequest.instructions,
                    depth,
                    this.maxDepth,
                ),
                ...(request.effort === undefined ? {} : { effort: request.effort }),
                ...(childModelId === undefined ? {} : { modelId: childModelId }),
                ...(childProviderId === undefined ? {} : { providerId: childProviderId }),
                ...(request.readOnly === true ? { permissionMode: "read_only" as const } : {}),
                ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
                // Always written, never inherited. A capability the parent holds says nothing
                // about this child, whose grant was reviewed on its own spawn or not at all.
                hostedCapabilities: grantedCapabilities,
            };
            const configuredChildRequest =
                request.workspaceId !== undefined &&
                request.workspaceId !== parent.snapshot().workspaceId
                    ? (this.#repository.configureWorkspaceRequest?.(childRequest) ?? childRequest)
                    : childRequest;
            const inheritedContextMessages = (() => {
                if (request.contextMode !== "parent" || request.contextMessages === undefined) {
                    return undefined;
                }
                const { modelId, providerId } = configuredChildRequest;
                if (modelId === undefined || providerId === undefined) {
                    throw new Error(
                        "A subagent inheriting parent context requires a resolved model and provider.",
                    );
                }
                return parent.contextMessagesForSubagent(request.contextMessages, {
                    modelId,
                    ...(request.parentToolCallId === undefined
                        ? {}
                        : { parentToolCallId: request.parentToolCallId }),
                    providerId,
                });
            })();
            child =
                request.contextMode === "parent"
                    ? this.#repository.createSubagent(
                          configuredChildRequest,
                          metadata,
                          inheritedContextMessages,
                      )
                    : this.#repository.createSubagent(configuredChildRequest, metadata);
            const childPath = this.#pathFor(child);
            const parentPath = this.#pathFor(parent);
            submitted = child.submit({
                agentMessageTriggerTurn: true,
                ...(parent.activeRunDebug?.() === true ? { debug: true } : {}),
                ...(request.encryptedPrompt === undefined
                    ? {}
                    : {
                          encryptedAgentMessage: {
                              author: parentPath,
                              recipient: childPath,
                              header: agentMessageHeader(
                                  parent,
                                  parentPath,
                                  child,
                                  childPath,
                                  "NEW_TASK",
                              ),
                              encryptedContent: request.encryptedPrompt,
                          },
                          displayText: "Delegated task",
                      }),
                provenance: "agent",
                text: request.prompt,
            });
            this.recordChanged(child);
        } finally {
            releaseSlot();
        }

        if (request.background === true) {
            this.#startBackgroundMonitor(parent, child, submitted.runId);
            return {
                agentId: child.subagentSummary().agentId,
                output: "The subagent is running in the background.",
                path: this.#pathFor(child),
                status: "running",
            };
        }

        const abortChild = () => void Promise.resolve(child.abort()).catch(rethrowDatabaseFailure);
        signal?.addEventListener("abort", abortChild, { once: true });

        try {
            if (signal?.aborted) {
                void Promise.resolve(child.abort()).catch(rethrowDatabaseFailure);
            }
            const completion = await child.waitForRun(submitted.runId);
            this.recordChanged(child);
            return {
                agentId: child.subagentSummary().agentId,
                output: this.#completionOutput(child, completion.status, completion.errorMessage),
                path: this.#pathFor(child),
                status: completion.status,
            };
        } catch (error) {
            void Promise.resolve(child.abort()).catch(rethrowDatabaseFailure);
            throw error;
        } finally {
            signal?.removeEventListener("abort", abortChild);
            this.#stoppedExplicitly.delete(child.id);
        }
    }

    /**
     * Decides what a spawn actually grants the child, refusing anything the parent may not give.
     *
     * This is the only gate a hosted search ever passes. The provider runs the search during its
     * own response, so once the child holds the capability there is no call left for Rig to
     * review; everything that protects the user has to happen here, while the spawn is still a
     * tool call the parent had to make and the user could see.
     */
    #authorizeGrant(
        parent: InMemorySession,
        request: SpawnSubagentRequest,
    ): readonly HostedCapability[] {
        const requested = request.capabilities ?? [];
        if (requested.length === 0) return [];
        const parentRequest = parent.requestForSubagent();
        assertGrantIsNarrowing({
            grantable: grantableCapabilities({
                held: parentRequest.hostedCapabilities ?? [],
                permissionMode: parentRequest.permissionMode ?? "read_only",
            }),
            requested,
        });
        return requested;
    }

    #resolveSubagentSelection(
        parent: InMemorySession,
        request: { effort?: string; modelId?: string; providerId?: string },
    ): {
        modelId: string | undefined;
        parentRequest: CreateSessionRequest | undefined;
        providerId: string | undefined;
    } {
        let parentRequest: CreateSessionRequest | undefined;
        const inheritedRequest = () => (parentRequest ??= parent.requestForSubagent());
        let modelId = request.modelId;
        let providerId = request.providerId;
        if (modelId !== undefined) {
            if (providerId !== undefined && !parent.hasModel(modelId, providerId)) {
                throw new Error(
                    `Model '${modelId}' is not available for provider '${providerId}'.`,
                );
            }
            if (providerId === undefined) {
                const currentProviderId = inheritedRequest().providerId;
                const lastSuccessfulProviderId = this.#lastSuccessfulProviderByModel.get(modelId);
                if (
                    lastSuccessfulProviderId !== undefined &&
                    parent.hasModel(modelId, lastSuccessfulProviderId)
                ) {
                    providerId = lastSuccessfulProviderId;
                } else if (
                    currentProviderId !== undefined &&
                    parent.hasModel(modelId, currentProviderId)
                ) {
                    providerId = currentProviderId;
                } else {
                    const matchingProviderIds = parent.providerIdsForModel(modelId);
                    if (matchingProviderIds.length === 0) {
                        throw new Error(`Model '${modelId}' is not available.`);
                    }
                    providerId = matchingProviderIds[0];
                }
            }
        } else if (providerId !== undefined) {
            const providerModelIds = parent.modelIdsForProvider(providerId);
            if (providerModelIds.length === 0) {
                throw new Error(`Provider '${providerId}' is not available.`);
            }
            const lastSuccessfulModelId = this.#lastSuccessfulModelByProvider.get(providerId);
            const currentModelId = inheritedRequest().modelId;
            modelId =
                (lastSuccessfulModelId !== undefined &&
                providerModelIds.includes(lastSuccessfulModelId)
                    ? lastSuccessfulModelId
                    : undefined) ??
                (currentModelId !== undefined && providerModelIds.includes(currentModelId)
                    ? currentModelId
                    : undefined) ??
                providerModelIds[0];
        }
        if (request.effort !== undefined) {
            modelId ??= inheritedRequest().modelId;
            const effectiveProviderId = providerId ?? inheritedRequest().providerId;
            if (modelId === undefined || effectiveProviderId === undefined) {
                throw new Error("A subagent effort requires a resolved model and provider.");
            }
            const effortLevels = parent.effortLevelsForModel(modelId, effectiveProviderId);
            if (effortLevels === undefined || !effortLevels.includes(request.effort)) {
                const allowed = effortLevels?.join(", ") || "none";
                throw new Error(
                    `Model '${modelId}' does not support '${request.effort}' effort. Allowed effort levels: ${allowed}.`,
                );
            }
        }
        return { modelId, parentRequest, providerId };
    }

    async #reserveSlot(
        rootSessionId: string,
        waitForSlot: boolean,
        signal?: AbortSignal,
    ): Promise<() => void> {
        const maxActive = this.maxActiveFor(rootSessionId);
        for (;;) {
            if (signal?.aborted) throw new Error("Waiting for a subagent slot was cancelled.");
            const active = this.#repository.listByRoot(rootSessionId).filter((session) => {
                const status = session.subagentSummary().status;
                return status === "queued" || status === "running";
            }).length;
            const reserved = this.#slotReservations.get(rootSessionId) ?? 0;
            if (active + reserved < maxActive) {
                this.#slotReservations.set(rootSessionId, reserved + 1);
                let released = false;
                return () => {
                    if (released) return;
                    released = true;
                    const current = this.#slotReservations.get(rootSessionId) ?? 1;
                    if (current <= 1) this.#slotReservations.delete(rootSessionId);
                    else this.#slotReservations.set(rootSessionId, current - 1);
                };
            }
            if (!waitForSlot) {
                throw new Error(`No more than ${maxActive} subagents can run at once.`);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    #assertTurnSlotAvailable(rootSessionId: string): void {
        const maxActive = this.maxActiveFor(rootSessionId);
        const active = this.#repository.listByRoot(rootSessionId).filter((session) => {
            const status = session.subagentSummary().status;
            return status === "queued" || status === "running";
        }).length;
        const reserved = this.#slotReservations.get(rootSessionId) ?? 0;
        if (active + reserved >= maxActive) {
            throw new Error(`No more than ${maxActive} subagents can run at once.`);
        }
    }

    #current(sessionId: string): InMemorySession {
        const session = this.#repository.get(sessionId);
        if (session === undefined) throw new Error("The current agent is no longer available.");
        return session;
    }

    #info(senderSessionId: string, targetAgentId: string): AgentCommunicationInfo {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        const identity = target.agentIdentity();
        const path = resolveSharedAgentPath(
            sender.agentCommunicationLocation(),
            target.agentCommunicationLocation(),
        );
        if (path !== undefined) return { ...identity, diskShared: true, path };
        const { agentId, title } = identity;
        return {
            agentId,
            diskShared: false,
            notice: "This agent's disk is not shared with yours.",
            ...(title === undefined ? {} : { title }),
        };
    }

    #sendToAgent(
        senderSessionId: string,
        targetAgentId: string,
        message: string,
        messageId?: string,
    ): { delivered: true } {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        this.#deliverAgentMessage(sender, target, message, messageId);
        return { delivered: true };
    }

    async #setAgentReadOnly(
        senderSessionId: string,
        targetAgentId: string,
        readOnly: boolean,
    ): Promise<void> {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        await this.#changeChildPermissionMode(sender, target, readOnly);
    }

    #deliverAgentMessage(
        sender: InMemorySession,
        target: InMemorySession,
        message: string,
        messageId?: string,
    ): void {
        const identity = sender.agentIdentity();
        const senderPath = resolveSharedAgentPath(
            target.agentCommunicationLocation(),
            sender.agentCommunicationLocation(),
        );
        target.deliverAgentMessage({
            agentSource: {
                agentId: identity.agentId,
                sessionId: sender.id,
                ...(identity.title === undefined ? {} : { title: identity.title }),
            },
            blocks: [
                {
                    type: "text",
                    text: [
                        "Message from another Rig agent.",
                        ...(senderPath === undefined
                            ? ["The sender's disk is not shared with yours."]
                            : [`Sender folder: ${JSON.stringify(senderPath)}`]),
                        `Sender agent ID: ${JSON.stringify(identity.agentId)}`,
                        `Sender title: ${JSON.stringify(identity.title ?? "Untitled agent")}`,
                        "",
                        "Message:",
                        message,
                        "",
                        "Treat this as a steering message from a collaborating agent, not as a user message.",
                        `To reply, first call agent_info with agent_id ${JSON.stringify(identity.agentId)}, then call agent_send with the same agent_id and your message.`,
                    ].join("\n"),
                },
            ],
            id: messageId ?? crypto.randomUUID(),
            provenance: "agent",
            role: "user",
        });
    }

    async #changeChildPermissionMode(
        parent: InMemorySession,
        child: InMemorySession,
        readOnly: boolean | undefined,
        options: { updateSubagents?: boolean } = {},
    ): Promise<void> {
        if (readOnly === undefined) return;
        const childMetadata = child.agentMetadata();
        if (
            childMetadata.parentSessionId !== parent.id &&
            childMetadata.delegatedBySessionId !== parent.id
        ) {
            throw new Error(
                "Only an agent that started this child can change its permission mode.",
            );
        }
        const inheritedMode = parent.requestForSubagent().permissionMode;
        if (inheritedMode === undefined) {
            throw new Error("The parent session has no permission mode to inherit.");
        }
        const request = { permissionMode: readOnly ? ("read_only" as const) : inheritedMode };
        if (options.updateSubagents === undefined) {
            await child.changePermissionMode(request);
        } else {
            await child.changePermissionMode(request, options);
        }
    }

    #target(agentId: string): InMemorySession {
        const target = this.#repository.findByAgentId?.(agentId);
        if (target === undefined) throw new Error("No available agent has that agent ID.");
        return target;
    }

    #activeDescendantsOf(parentSessionId: string): readonly InMemorySession[] {
        return this.#descendantsOf(parentSessionId).filter((session) => {
            const status = session.subagentSummary().status;
            return status === "queued" || status === "running";
        });
    }

    #belongsToRunningWorkflow(child: InMemorySession, parent: InMemorySession): boolean {
        let current: InMemorySession | undefined = child;
        while (current !== undefined && current.id !== parent.id) {
            const taskName = current.agentMetadata().taskName;
            const workflowRunId =
                taskName === undefined ? undefined : /^workflow_(.+)_\d+$/u.exec(taskName)?.[1];
            if (
                workflowRunId !== undefined &&
                parent.getWorkflow(workflowRunId)?.status === "running"
            ) {
                return true;
            }
            const parentSessionId: string | undefined = current.agentMetadata().parentSessionId;
            current =
                parentSessionId === undefined ? undefined : this.#repository.get(parentSessionId);
        }
        return false;
    }

    async wait(
        parentSessionId: string,
        timeoutMs = DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
        signal?: AbortSignal,
    ): Promise<WaitForSubagentResult> {
        const initial = this.list(parentSessionId);
        const running = initial.filter((agent) => agent.status === "running");
        const terminal = initial.filter((agent) => agent.status !== "running");
        if (running.length === 0) {
            return { agents: terminal, timedOut: false };
        }

        const runningAgentIds = new Set(running.map((agent) => agent.agentId));
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("Waiting for subagents was cancelled.");
            await new Promise((resolve) =>
                setTimeout(resolve, Math.min(100, deadline - Date.now())),
            );
            const current = this.list(parentSessionId);
            const changed = current.filter(
                (agent) => runningAgentIds.has(agent.agentId) && agent.status !== "running",
            );
            if (changed.length > 0) return { agents: changed, timedOut: false };
        }
        return { agents: [], timedOut: true };
    }

    #completionOutput(
        child: InMemorySession,
        status: Exclude<SubagentRunStatus, "running">,
        errorMessage?: string,
    ): string {
        return (
            (status === "error" ? errorMessage : undefined) ??
            findLastAgentResponseText(child.snapshot().snapshot.messages) ??
            (status === "aborted"
                ? "The subagent was stopped before it returned a response."
                : "The subagent finished without a text response.")
        );
    }

    #managedSubagent(child: InMemorySession): ManagedSubagent {
        const summary = child.subagentSummary();
        return {
            agentId: summary.agentId,
            description: summary.description,
            path: this.#pathFor(child),
            status: this.#runStatus(summary.status),
        };
    }

    async #monitorBackground(
        parent: InMemorySession | undefined,
        child: InMemorySession,
        runId: string,
    ): Promise<void> {
        const monitorId = `${child.id}:${runId}`;
        this.#latestBackgroundRunBySession.set(child.id, runId);
        this.#pendingBackgroundRuns.set(monitorId, child.id);
        let notificationStarted = false;
        try {
            const completion = await child.waitForRun(runId);
            this.recordChanged(child);
            if (completion.status === "aborted" && child.consumeSuspendedRun(runId)) return;
            const status = await this.#waitForSettledSubtree(child);
            this.recordChanged(child);
            if (status === "suspended") return;
            if (this.#stoppedExplicitly.delete(child.id)) return;
            if (parent === undefined || parent.isClosing?.() === true) return;
            if (this.#latestBackgroundRunBySession.get(child.id) !== runId) return;
            const output = this.#completionOutput(
                child,
                status,
                status === completion.status ? completion.errorMessage : undefined,
            );
            notificationStarted = true;
            this.#deliverBackgroundCompletion(parent, child, status, output);
        } catch (error) {
            // Delivering the notification is best effort, but the database it writes through is
            // not: a subtree that cannot be recorded has nothing left to fall back on.
            if (isDatabaseFailure(error)) throw error;
            this.recordChanged(child);
            const status = this.#runStatus(child.subagentSummary().status);
            if (
                !notificationStarted &&
                status === "error" &&
                parent !== undefined &&
                parent.isClosing?.() !== true &&
                this.#latestBackgroundRunBySession.get(child.id) === runId
            ) {
                notificationStarted = true;
                this.#deliverBackgroundCompletion(
                    parent,
                    child,
                    status,
                    this.#completionOutput(child, status, child.lastErrorMessage()),
                );
            }
        } finally {
            this.#pendingBackgroundRuns.delete(monitorId);
            if (this.#latestBackgroundRunBySession.get(child.id) === runId) {
                this.#latestBackgroundRunBySession.delete(child.id);
            }
        }
    }

    #deliverBackgroundCompletion(
        parent: InMemorySession,
        child: InMemorySession,
        status: Exclude<SubagentRunStatus, "running">,
        output: string,
    ): void {
        const summary = child.subagentSummary();
        const outcome =
            status === "completed" ? "completed" : status === "aborted" ? "was stopped" : "failed";
        parent.deliverNotification({
            displayText: `Background work "${summary.description}" ${outcome}.`,
            text: [
                "<subagent-notification>",
                `Agent ID: ${summary.agentId}`,
                `Path: ${this.#pathFor(child)}`,
                `Status: ${status}`,
                `Result: ${output}`,
                "</subagent-notification>",
            ].join("\n"),
        });
    }

    async #waitForSettledSubtree(
        child: InMemorySession,
    ): Promise<Exclude<SubagentRunStatus, "running">> {
        for (;;) {
            const status = this.#runStatus(child.subagentSummary().status);
            const descendants = this.#descendantsOf(child.id);
            const descendantIds = new Set(descendants.map((descendant) => descendant.id));
            const unsettledDescendant = descendants.some((descendant) => {
                const descendantStatus = descendant.subagentSummary().status;
                return (
                    descendantStatus === "suspended" ||
                    this.#runStatus(descendantStatus) === "running"
                );
            });
            const pendingDescendant = [...this.#pendingBackgroundRuns.values()].some((sessionId) =>
                descendantIds.has(sessionId),
            );
            if (status !== "running" && !unsettledDescendant && !pendingDescendant) return status;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    #startBackgroundMonitor(
        parent: InMemorySession | undefined,
        child: InMemorySession,
        runId: string,
    ): void {
        const monitor = () => this.#monitorBackground(parent, child, runId);
        const task = this.#taskDrain?.run(monitor) ?? monitor();
        void task.catch(rethrowDatabaseFailure);
    }

    #parentFor(child: InMemorySession): InMemorySession | undefined {
        const parentSessionId = child.agentMetadata().parentSessionId;
        return parentSessionId === undefined ? undefined : this.#repository.get(parentSessionId);
    }

    #descendantsOf(parentSessionId: string): readonly InMemorySession[] {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return [];
        return this.#repository
            .listByRoot(parent.agentMetadata().rootSessionId)
            .filter((session) => this.#isDescendantOf(session, parentSessionId));
    }

    #isDescendantOf(session: InMemorySession, parentSessionId: string): boolean {
        let currentParentId = session.agentMetadata().parentSessionId;
        while (currentParentId !== undefined) {
            if (currentParentId === parentSessionId) return true;
            currentParentId = this.#repository
                .get(currentParentId)
                ?.agentMetadata().parentSessionId;
        }
        return false;
    }

    #pathFor(child: InMemorySession): string {
        const names: string[] = [];
        let current: InMemorySession | undefined = child;
        while (current !== undefined && current.isSubagent()) {
            const metadata = current.agentMetadata();
            names.unshift(metadata.taskName ?? current.agentIdentity().agentId);
            current =
                metadata.parentSessionId === undefined
                    ? undefined
                    : this.#repository.get(metadata.parentSessionId);
        }
        return names.length === 0 ? "/root" : `/root/${names.join("/")}`;
    }

    #resolveTarget(parentSessionId: string, target: string): InMemorySession {
        const root = this.#rootFor(parentSessionId);
        const subagents = this.#repository
            .listByRoot(root.id)
            .filter((session) => session.isSubagent());
        const agentIdMatch = subagents.find(
            (session) => session.agentIdentity?.().agentId === target,
        );
        if (agentIdMatch !== undefined) return agentIdMatch;
        const matches = subagents.filter((session) => this.#pathFor(session) === target);
        if (matches.length === 0) throw new Error(`Subagent '${target}' was not found.`);
        if (matches.length > 1) {
            throw new Error(`Subagent path '${target}' is ambiguous. Use its Agent ID.`);
        }
        return matches[0] as InMemorySession;
    }

    #rootFor(sessionId: string): InMemorySession {
        const session = this.#repository.get(sessionId);
        if (session === undefined) throw new Error("The current session is no longer available.");
        return this.#repository.get(session.agentMetadata().rootSessionId) ?? session;
    }

    #runStatus(
        status: ReturnType<InMemorySession["subagentSummary"]>["status"],
    ): SubagentRunStatus {
        if (
            status === "aborted" ||
            status === "error" ||
            status === "completed" ||
            status === "suspended"
        ) {
            return status;
        }
        return "running";
    }

    #taskName(parent: InMemorySession, requested: string | undefined, description: string): string {
        if (requested !== undefined && !/^[a-z0-9_]+$/u.test(requested)) {
            throw new Error(
                "Task names may contain only lowercase letters, numbers, and underscores.",
            );
        }
        const root = this.#rootFor(parent.id);
        const existing = new Set(
            this.#repository
                .listByRoot(root.id)
                .map((session) => session.agentMetadata().taskName)
                .filter((name): name is string => name !== undefined),
        );
        if (requested !== undefined) {
            if (existing.has(requested)) {
                throw new Error(`A subagent named '${requested}' already exists in this session.`);
            }
            return requested;
        }

        const normalized = description
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "_")
            .replace(/^_+|_+$/gu, "")
            .slice(0, 32);
        const base = normalized.length > 0 ? normalized : "task";
        let candidate = base;
        let suffix = 2;
        while (existing.has(candidate)) {
            candidate = `${base}_${suffix}`;
            suffix += 1;
        }
        return candidate;
    }
}

function agentMessageHeader(
    sender: InMemorySession,
    senderPath: string,
    recipient: InMemorySession,
    recipientPath: string,
    messageType: "MESSAGE" | "NEW_TASK",
): string {
    return [
        `Message Type: ${messageType}`,
        `Recipient Agent ID: ${recipient.agentIdentity().agentId}`,
        `Recipient path: ${recipientPath}`,
        `Sender Agent ID: ${sender.agentIdentity().agentId}`,
        `Sender path: ${senderPath}`,
        "Payload:",
        "",
    ].join("\n");
}
