import { createId } from "@paralleldrive/cuid2";
import type { Context } from "@steve.kite/stdlib";

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
import { isCodexEncryptedAgentTransportModel } from "../executor/isCodexEncryptedAgentTransportModel.js";
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
import type { PermissionMode } from "../permissions/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import { throwIfAborted } from "../concurrency/index.js";
import { withWorkerContext } from "../observability/index.js";
import { resolveSharedAgentPath } from "./impl/resolveSharedAgentPath.js";
import type { InMemorySession } from "./InMemorySession.js";

export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 8;

export interface AgentSessionRepository {
    archiveOwnedWorkspace?(
        ctx: Context,
        ownerSessionId: string,
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined>;
    createOwnedWorkspace?(
        ctx: Context,
        ownerSessionId: string,
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspace | undefined>;
    createSubagent(
        ctx: Context,
        request: CreateSessionRequest,
        metadata: SessionAgentMetadata,
        contextMessages?: readonly Message[],
    ): Promise<InMemorySession>;
    createDelegatedSession?(
        ctx: Context,
        request: CreateSessionRequest,
        metadata: SessionAgentMetadata,
        id: string,
    ): Promise<InMemorySession>;
    configureWorkspaceRequest?(
        ctx: Context,
        request: CreateSessionRequest,
    ): Promise<CreateSessionRequest>;
    findByAgentId?(agentId: string): InMemorySession | undefined;
    get(sessionId: string): InMemorySession | undefined;
    listByRoot(rootSessionId: string): readonly InMemorySession[];
    listProjects?(ctx: Context): Promise<readonly Project[]>;
    registerProject?(ctx: Context, path: string): Promise<Project>;
    listProjectWorkspaces?(ctx: Context, projectId: string): Promise<readonly ProjectWorkspace[]>;
    listProjectSessions?(
        ctx: Context,
        target: {
            projectId: string;
            workspaceId?: string;
        },
    ): Promise<readonly AgentWorkspaceSession[]>;
    queryAgentTreeUsage?(sessionId: string): AgentTreeUsage | undefined;
    ownedWorkspace?(
        ctx: Context,
        ownerSessionId: string,
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined>;
    workspace?(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined>;
    waitForWorkspaceReady?(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        signal?: AbortSignal,
    ): Promise<ProjectWorkspace>;
    completeScheduledSessionTransfer?(
        ctx: Context,
        sessionId: string,
        targetWorkspaceId: string,
    ): Promise<void>;
    scheduleSessionTransfer?(
        ctx: Context,
        sessionId: string,
        targetWorkspaceId: string,
    ): Promise<AgentSessionTransferSchedule>;
}

export interface AgentSessionManagerOptions {
    localInstanceId?: string;
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
    readonly #retainedTrees = new WeakMap<InMemorySession, Map<string, InMemorySession>>();
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
        void rootSessionId;
        return this.maxActive;
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
        this.retainLoadedSubagent(child);
        let parent = this.#parentFor(child);
        while (parent !== undefined) {
            parent.recordSubagentChanged(child.subagentSummary());
            parent = this.#parentFor(parent);
        }
    }

    /**
     * Keep reusable descendants alive for exactly as long as their loaded root session. Persistent
     * stores otherwise cache sessions weakly, which can make a stopped child disappear between an
     * abort and the model's next follow-up tool call.
     */
    retainLoadedSubagent(child: InMemorySession): void {
        if (!child.isSubagent()) return;
        const root = this.#repository.get(child.agentMetadata().rootSessionId);
        if (root === undefined) return;
        let retained = this.#retainedTrees.get(root);
        if (retained === undefined) {
            retained = new Map();
            this.#retainedTrees.set(root, retained);
        }
        retained.set(child.id, child);
    }

    recordSuccessfulProvider(modelId: string, providerId: string): void {
        this.#lastSuccessfulModelByProvider.set(providerId, modelId);
        this.#lastSuccessfulProviderByModel.set(modelId, providerId);
    }

    async createWorkspace(
        ctx: Context,
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
        // An agent describes the work when it asks for a workspace, so that name stands rather
        // than being replaced by whatever the first chat inside it ends up called.
        const workspace = await create(ctx, ownerSessionId, codeSessionIdentity(owner).projectId, {
            ...input,
            nameConfigured: true,
        });
        if (workspace === undefined) throw new Error("The workspace could not be created.");
        return workspace;
    }

    async archiveWorkspace(
        ctx: Context,
        ownerSessionId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace> {
        const owner = this.#repository.get(ownerSessionId);
        const archive = this.#repository.archiveOwnedWorkspace;
        if (owner === undefined || archive === undefined) {
            throw new Error("This session cannot archive managed workspaces.");
        }
        const workspace = await archive(
            ctx,
            ownerSessionId,
            codeSessionIdentity(owner).projectId,
            workspaceId,
        );
        if (workspace === undefined) {
            throw new Error("This workspace was not created by the current session.");
        }
        return workspace;
    }

    async scheduleSessionTransfer(
        ctx: Context,
        sessionId: string,
        targetWorkspaceId: string,
    ): Promise<AgentSessionTransferSchedule> {
        const schedule = this.#repository.scheduleSessionTransfer;
        if (schedule === undefined) {
            throw new Error("This session cannot be transferred between workspaces.");
        }
        return schedule(ctx, sessionId, targetWorkspaceId);
    }

    async completeScheduledSessionTransfer(
        ctx: Context,
        sessionId: string,
        targetWorkspaceId: string,
    ): Promise<void> {
        const complete = this.#repository.completeScheduledSessionTransfer;
        if (complete === undefined) {
            throw new Error("This session cannot be transferred between workspaces.");
        }
        await complete(ctx, sessionId, targetWorkspaceId);
    }

    async listProjects(ctx: Context, sessionId: string): Promise<readonly AgentProject[]> {
        const list = this.#repository.listProjects;
        if (list === undefined) throw new Error("This session cannot list projects.");
        const currentProjectId = codeSessionIdentity(this.#current(sessionId)).projectId;
        return (await list(ctx)).map((project) => ({
            current: project.id === currentProjectId,
            id: project.id,
            name: project.name,
            path: project.path,
        }));
    }

    async registerProject(ctx: Context, sessionId: string, path: string): Promise<AgentProject> {
        const register = this.#repository.registerProject;
        if (register === undefined) throw new Error("This session cannot add projects.");
        const project = await register(ctx, path);
        return {
            current: project.id === codeSessionIdentity(this.#current(sessionId)).projectId,
            id: project.id,
            name: project.name,
            path: project.path,
        };
    }

    async listWorkspaces(
        ctx: Context,
        sessionId: string,
        projectId: string | undefined,
        options: { crossWorkspace: boolean },
    ): Promise<readonly AgentWorkspace[]> {
        const list = this.#repository.listProjectWorkspaces;
        if (list === undefined) throw new Error("This session cannot list workspaces.");
        const target = this.#targetProjectId(sessionId, projectId, options);
        return await Promise.all(
            (await list(ctx, target)).map((workspace) =>
                this.#agentWorkspace(ctx, sessionId, workspace),
            ),
        );
    }

    async listSessions(
        ctx: Context,
        sessionId: string,
        target: { projectId?: string; workspaceId?: string },
        options: { crossWorkspace: boolean },
    ): Promise<readonly AgentWorkspaceSession[]> {
        const list = this.#repository.listProjectSessions;
        if (list === undefined) throw new Error("This session cannot list conversations.");
        const projectId = this.#targetProjectId(sessionId, target.projectId, options);
        return await list(ctx, {
            projectId,
            ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
        });
    }

    /**
     * Starts a user-visible conversation in another workspace on behalf of a session.
     *
     * The new session is a primary one: it holds its own place in the session list and the user
     * may take it over. The delegator is recorded so completion can flow back and it can talk to
     * the session afterwards through the ordinary agent messaging tools.
     */
    async delegate(
        ctx: Context,
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
        let workspace = await resolveWorkspace(ctx, projectId, request.workspaceId);
        if (workspace === undefined) {
            throw new Error("That workspace was not found in that project.");
        }
        workspace = await this.#workspaceReady(ctx, projectId, workspace, signal);
        if (snapshot.scope.kind === "workspace" && workspace.id === snapshot.scope.workspaceId) {
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
        const delegate = await create(
            ctx,
            (await this.#repository.configureWorkspaceRequest?.(ctx, workspaceRequest)) ??
                workspaceRequest,
            {
                delegatedBySessionId: delegatorSessionId,
                depth: 0,
                rootSessionId: sessionId,
                type: "primary",
                ...(request.title === undefined ? {} : { description: request.title }),
            },
            sessionId,
        );
        const submitted = await delegate.submit(ctx, {
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

    #targetProjectId(
        sessionId: string,
        projectId: string | undefined,
        options: { crossWorkspace: boolean },
    ): string {
        const currentProjectId = codeSessionIdentity(this.#current(sessionId)).projectId;
        if (projectId === undefined || projectId === currentProjectId) return currentProjectId;
        if (!options.crossWorkspace) {
            throw new Error(
                "Looking into another project is turned off. Ask the user to enable features.cross_workspace in their Rig configuration.",
            );
        }
        return projectId;
    }

    async #agentWorkspace(
        ctx: Context,
        sessionId: string,
        workspace: ProjectWorkspace,
    ): Promise<AgentWorkspace> {
        const owned =
            (await this.#repository.ownedWorkspace?.(
                ctx,
                sessionId,
                workspace.projectId,
                workspace.id,
            )) !== undefined;
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
        const monitor = () =>
            withWorkerContext("delegated-run-monitor", async (ctx) => {
                const completion = await delegate.waitForRun(ctx, runId);
                if (delegator.isClosing?.() === true) return;
                const title = delegate.agentIdentity().title ?? "the delegated conversation";
                const output = this.#completionOutput(
                    delegate,
                    completion.status,
                    completion.errorMessage,
                );
                delegator.deliverNotification(ctx, {
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
            });
        const task = this.#taskDrain?.run(monitor) ?? monitor();
        void task.catch((error: unknown) => {
            if (isDatabaseFailure(error)) throw error;
        });
    }

    async spawnInWorkspace(
        ctx: Context,
        parentSessionId: string,
        request: WorkspaceAgentRequest,
        signal?: AbortSignal,
    ): Promise<SpawnSubagentResult> {
        const parent = this.#current(parentSessionId);
        const resolveWorkspace = this.#repository.ownedWorkspace;
        if (parent === undefined || resolveWorkspace === undefined) {
            throw new Error("This session cannot start workspace agents.");
        }
        const projectId = codeSessionIdentity(parent).projectId;
        throwIfAborted(signal);
        let workspace = await resolveWorkspace(
            ctx,
            parentSessionId,
            projectId,
            request.workspaceId,
        );
        if (workspace === undefined) {
            throw new Error("This workspace was not created by the current session.");
        }
        workspace = await this.#workspaceReady(ctx, projectId, workspace, signal);
        return this.spawn(
            ctx,
            parentSessionId,
            { ...request, cwd: workspace.path, workspaceId: workspace.id },
            signal,
        );
    }

    async #workspaceReady(
        ctx: Context,
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
            workspace = await wait(ctx, projectId, workspace.id, signal);
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

    communicationContext(ctx: Context, sessionId: string): AgentCommunicationContext {
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
                    throw new Error("Inspect this agent before sending it a message.");
                }
                return this.#sendToAgent(ctx, sessionId, agentId, message);
            },
            setReadOnly: async (agentId, readOnly) => {
                if (!inspectedAgentIds.has(agentId)) {
                    throw new Error("Inspect this agent before changing its permission mode.");
                }
                await this.#setAgentReadOnly(ctx, sessionId, agentId, readOnly);
            },
        };
    }

    sendScheduledMessage(
        ctx: Context,
        senderSessionId: string,
        targetAgentId: string,
        message: string,
        messageId: string,
    ): void {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        this.#deliverAgentMessage(ctx, sender, target, message, messageId);
    }

    assertCanScheduleMessage(senderSessionId: string, targetAgentId: string): void {
        void senderSessionId;
        void targetAgentId;
    }

    async changeSubagentPermissionModes(
        ctx: Context,
        parentSessionId: string,
        permissionMode: PermissionMode,
    ): Promise<void> {
        const root = this.#rootFor(parentSessionId);
        const results = await Promise.allSettled(
            this.#repository.listByRoot(root.id).map(async (session) => {
                try {
                    await session.changePermissionMode(
                        ctx,
                        { permissionMode },
                        { updateSubagents: false },
                    );
                } catch (error) {
                    try {
                        await session.beginShutdown(ctx);
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

    async followUp(
        ctx: Context,
        parentSessionId: string,
        target: string,
        message: string,
        effort?: string,
        encryptedMessage?: string,
    ): Promise<ManagedSubagent> {
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
        const childStatus = child.subagentSummary().status;
        if (childStatus === "archived") {
            throw new Error("That subagent was retired with its previous execution context.");
        }
        if (childStatus !== "running" && childStatus !== "queued") {
            this.#assertTurnSlotAvailable(child.agentMetadata().rootSessionId);
        }
        if (childStatus === "suspended") await child.clearSuspension(ctx);
        this.#stoppedExplicitly.delete(child.id);
        const childPath = this.#pathFor(child);
        const parentPath = this.#pathFor(parent);
        const submitted = await child.submit(ctx, {
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
        ctx: Context,
        senderSessionId: string,
        target: string,
        message: string,
        encryptedMessage?: string,
    ): ManagedSubagent {
        const sender = this.#current(senderSessionId);
        const recipient = this.#resolveMessageTarget(sender, target);
        if (encryptedMessage !== undefined) {
            const senderTransportScope = sender.encryptedAgentTransportScope();
            if (
                senderTransportScope === undefined ||
                senderTransportScope !== recipient.encryptedAgentTransportScope()
            ) {
                throw new Error(
                    "Native encrypted collaboration only works within the same compatible provider and region.",
                );
            }
        }
        const senderPath = this.#pathFor(sender);
        const recipientPath = this.#pathFor(recipient);
        recipient.deliverAgentMessage(ctx, {
            blocks: message.length === 0 ? [] : [{ type: "text", text: message }],
            id: crypto.randomUUID(),
            provenance: "agent",
            role: "user",
            ...(encryptedMessage === undefined
                ? {}
                : {
                      encryptedAgentMessage: {
                          author: senderPath,
                          recipient: recipientPath,
                          header: agentMessageHeader(
                              sender,
                              senderPath,
                              recipient,
                              recipientPath,
                              "MESSAGE",
                          ),
                          encryptedContent: encryptedMessage,
                      },
                  }),
        });
        this.recordChanged(recipient);
        return this.#managedMessageTarget(recipient);
    }

    async setSubagentReadOnly(
        ctx: Context,
        parentSessionId: string,
        target: string,
        readOnly: boolean,
    ): Promise<ManagedSubagent> {
        const parent = this.#current(parentSessionId);
        const child = this.#resolveTarget(parentSessionId, target);
        await this.#changeChildPermissionMode(ctx, parent, child, readOnly, {
            updateSubagents: false,
        });
        this.recordChanged(child);
        return this.#managedSubagent(child);
    }

    async interrupt(
        ctx: Context,
        parentSessionId: string,
        target: string,
    ): Promise<ManagedSubagent> {
        const child = this.#resolveTarget(parentSessionId, target);
        const previous = this.#managedSubagent(child);
        await this.stopDescendants(ctx, child.id);
        if (child.subagentSummary().status === "suspended") await child.clearSuspension(ctx);
        await child.abort(ctx, { stopDescendants: false });
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

    async pauseDescendants(ctx: Context, parentSessionId: string): Promise<number> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return 0;
        const active = this.#activeDescendantsOf(parentSessionId).filter(
            (child) => !this.#belongsToRunningWorkflow(child, parent),
        );
        await Promise.all(
            active.map(async (child) => {
                await child.suspendByParent(ctx);
                this.recordChanged(child);
            }),
        );
        await parent.recordSubagentsSuspended(
            ctx,
            active.map((child) => this.#managedSubagent(child)),
        );
        return active.length;
    }

    async stopDescendants(ctx: Context, parentSessionId: string): Promise<number> {
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
            await child.clearSuspension(ctx);
            this.recordChanged(child);
        }
        for (const child of active) this.#stoppedExplicitly.add(child.id);
        await Promise.all(
            active.map(async (child) => {
                await child.abort(ctx, { stopDescendants: false });
                this.recordChanged(child);
            }),
        );
        return active.length + suspended.length;
    }

    /**
     * Stops the whole retained tree before its root adopts a different execution context.
     *
     * Workflow children are included here: unlike an ordinary parent interruption, changing cwd,
     * secrets, and filesystem permissions makes every old descendant context unsafe to retain.
     */
    async stopDescendantsForContextChange(ctx: Context, parentSessionId: string): Promise<number> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return 0;
        const descendants = this.#descendantsOf(parentSessionId);
        for (const child of descendants) this.#stoppedExplicitly.add(child.id);
        await Promise.all(
            descendants.map(async (child) => {
                await child.retireForContextChange(ctx);
                this.recordChanged(child);
            }),
        );
        const root = this.#rootFor(parentSessionId);
        const retained = this.#retainedTrees.get(root);
        for (const child of descendants) retained?.delete(child.id);
        return descendants.length;
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
        ctx: Context,
        parentSessionId: string,
        request: SpawnSubagentRequest,
        signal?: AbortSignal,
    ): Promise<SpawnSubagentResult> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) {
            throw new Error("The parent session is no longer available.");
        }
        const selection = this.#resolveSubagentSelection(parent, request);
        let parentRequest = selection.parentRequest;
        const childModelId = selection.modelId;
        const childProviderId = selection.providerId;

        // Both checks below judge the child that will actually be built, not the one that was
        // asked for. A spawn naming only a model resolves its provider from recent successful
        // routing, so a request that looks compatible before resolution can still land elsewhere.
        // The parent's own request is read only when a check actually runs, because a spawn that
        // asks for neither has to stay refusable on depth and capacity alone — those answers come
        // from the tree, and asking the parent to describe itself first would make them depend on
        // a parent that has nothing to describe yet.
        const resolveEffectiveChild = () => {
            parentRequest ??= parent.requestForSubagent();
            return {
                modelId: childModelId ?? parentRequest.modelId,
                providerId: childProviderId ?? parentRequest.providerId,
            };
        };

        if (request.encryptedPrompt !== undefined) {
            const { modelId: effectiveModelId, providerId: effectiveProviderId } =
                resolveEffectiveChild();
            // A scope is the provider that issued it — `createEncryptedAgentTransportScope`
            // returns that provider's own id — so equal ids mean the same provider and therefore
            // the same type. That leaves only the model's transport compatibility to check. This
            // Luna cannot initiate encrypted collaboration but can receive an encrypted agent
            // message as a child. If the scope ever regains structure this comparison silently
            // refuses every native spawn, which is what the two-account test beside this one is
            // for.
            const parentScope = parent.encryptedAgentTransportScope();
            if (
                parentScope === undefined ||
                effectiveProviderId !== parentScope ||
                effectiveModelId === undefined ||
                !isCodexEncryptedAgentTransportModel(effectiveModelId)
            ) {
                throw new Error(
                    "Native encrypted collaboration only works within the current compatible provider and region.",
                );
            }
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
        let submitted: Awaited<ReturnType<InMemorySession["submit"]>>;
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
            };
            const parentScope = parent.snapshot().scope;
            const configuredChildRequest =
                request.workspaceId !== undefined &&
                (parentScope.kind !== "workspace" ||
                    request.workspaceId !== parentScope.workspaceId)
                    ? ((await this.#repository.configureWorkspaceRequest?.(ctx, childRequest)) ??
                      childRequest)
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
                    ? await this.#repository.createSubagent(
                          ctx,
                          configuredChildRequest,
                          metadata,
                          inheritedContextMessages,
                      )
                    : await this.#repository.createSubagent(ctx, configuredChildRequest, metadata);
            const childPath = this.#pathFor(child);
            const parentPath = this.#pathFor(parent);
            submitted = await child.submit(ctx, {
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

        const abortChild = () =>
            void Promise.resolve(child.abort(ctx)).catch(rethrowDatabaseFailure);
        signal?.addEventListener("abort", abortChild, { once: true });

        try {
            if (signal?.aborted) {
                void Promise.resolve(child.abort(ctx)).catch(rethrowDatabaseFailure);
            }
            const completion = await child.waitForRun(ctx, submitted.runId);
            this.recordChanged(child);
            return {
                agentId: child.subagentSummary().agentId,
                output: this.#completionOutput(child, completion.status, completion.errorMessage),
                path: this.#pathFor(child),
                status: completion.status,
            };
        } catch (error) {
            void Promise.resolve(child.abort(ctx)).catch(rethrowDatabaseFailure);
            throw error;
        } finally {
            signal?.removeEventListener("abort", abortChild);
            this.#stoppedExplicitly.delete(child.id);
        }
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
        ctx: Context,
        senderSessionId: string,
        targetAgentId: string,
        message: string,
        messageId?: string,
    ): { delivered: true } {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        this.#deliverAgentMessage(ctx, sender, target, message, messageId);
        return { delivered: true };
    }

    async #setAgentReadOnly(
        ctx: Context,
        senderSessionId: string,
        targetAgentId: string,
        readOnly: boolean,
    ): Promise<void> {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        await this.#changeChildPermissionMode(ctx, sender, target, readOnly);
    }

    #deliverAgentMessage(
        ctx: Context,
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
        target.deliverAgentMessage(ctx, {
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
                    ].join("\n"),
                },
            ],
            id: messageId ?? crypto.randomUUID(),
            provenance: "agent",
            role: "user",
        });
    }

    async #changeChildPermissionMode(
        ctx: Context,
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
            await child.changePermissionMode(ctx, request);
        } else {
            await child.changePermissionMode(ctx, request, options);
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

    #managedMessageTarget(target: InMemorySession): ManagedSubagent {
        if (target.isSubagent()) return this.#managedSubagent(target);
        const identity = target.agentIdentity();
        return {
            agentId: identity.agentId,
            description: identity.title ?? "Parent agent",
            path: this.#pathFor(target),
            status: "running",
        };
    }

    async #monitorBackground(
        ctx: Context,
        parent: InMemorySession | undefined,
        child: InMemorySession,
        runId: string,
    ): Promise<void> {
        const monitorId = `${child.id}:${runId}`;
        this.#latestBackgroundRunBySession.set(child.id, runId);
        this.#pendingBackgroundRuns.set(monitorId, child.id);
        let notificationStarted = false;
        try {
            const completion = await child.waitForRun(ctx, runId);
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
            this.#deliverBackgroundCompletion(ctx, parent, child, status, output);
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
                    ctx,
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
        ctx: Context,
        parent: InMemorySession,
        child: InMemorySession,
        status: Exclude<SubagentRunStatus, "running">,
        output: string,
    ): void {
        const summary = child.subagentSummary();
        const outcome =
            status === "completed" ? "completed" : status === "aborted" ? "was stopped" : "failed";
        parent.deliverNotification(ctx, {
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
        const monitor = () =>
            withWorkerContext("subagent-background-monitor", (ctx) =>
                this.#monitorBackground(ctx, parent, child, runId),
            );
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
        const matches = subagents.filter(
            (session) =>
                this.#pathFor(session) === target ||
                (target.includes("/") === false && session.agentMetadata().taskName === target),
        );
        if (matches.length === 0) throw new Error(`Subagent '${target}' was not found.`);
        if (matches.length > 1) {
            throw new Error(`Subagent target '${target}' is ambiguous. Use its Agent ID.`);
        }
        return matches[0] as InMemorySession;
    }

    #resolveMessageTarget(sender: InMemorySession, target: string): InMemorySession {
        const directParent = this.#parentFor(sender);
        if (
            directParent !== undefined &&
            (directParent.agentIdentity().agentId === target ||
                this.#pathFor(directParent) === target)
        ) {
            return directParent;
        }
        return this.#resolveTarget(sender.id, target);
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

function codeSessionIdentity(session: InMemorySession): {
    projectId: string;
    workspaceId?: string;
} {
    const scope = session.snapshot().scope;
    if (scope.kind === "project") return { projectId: scope.projectId };
    if (scope.kind === "workspace") {
        return { projectId: scope.projectId, workspaceId: scope.workspaceId };
    }
    throw new Error("This operation is available only in a project or workspace chat.");
}
