import type {
    AgentContext,
    AgentCompactionResult,
    AgentRunOptions,
    AgentRunResult,
    AgentSnapshot,
    ContentBlock,
    UserMessage,
} from "../agent/index.js";
import type { Context } from "@steve.kite/stdlib";
import type {
    CodingAssistantAgentBackend,
    CodingAssistantModelChoice,
    SteeringRunOptions,
} from "../app/CodingAssistantAgentBackend.js";
import type {
    AbortRunOptions,
    ModelCatalog,
    ProtocolSession,
    SessionEvent,
    RunShellCommandResponse,
    ReadBackgroundProcessResponse,
    StopBackgroundProcessResponse,
    SteerMessageResponse,
    SubmitContextMessageResponse,
} from "../protocol/index.js";
import {
    defineProvider,
    type Model,
    type Provider,
    type ProviderError,
    type ServiceTier,
    type StopReason,
} from "@slopus/rig-execution";
import type { PermissionMode } from "../permissions/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { GoalStatus, SessionGoal } from "../goals/index.js";
import { ProtocolHttpClient } from "./ProtocolHttpClient.js";
import { RemoteAgentRunError } from "./RemoteAgentRunError.js";

export interface RemoteAgentOptions {
    client: ProtocolHttpClient;
    context: AgentContext;
    debug?: boolean;
    modelCatalog?: ModelCatalog;
    session: ProtocolSession;
}

export class RemoteAgent implements CodingAssistantAgentBackend {
    readonly context: AgentContext;
    readonly id: string;

    #client: ProtocolHttpClient;
    #debug: boolean;
    #modelId: string;
    #modelCatalog: ModelCatalog | undefined;
    #models: readonly Model[];
    #providerId: string;
    #pendingSteeringMessages = new Map<string, { message: UserMessage; runId: string }>();
    #session: ProtocolSession;
    #configurationChangeQueue: Promise<void> = Promise.resolve();
    #modelChangeVersion = 0;
    #confirmedEffort: string | undefined;
    #confirmedModelId: string;
    #confirmedModels: readonly Model[];
    #confirmedProviderId: string;
    #confirmedServiceTier: ServiceTier | undefined;
    #serviceTierChangeCount = 0;
    #serviceTierIntent: ServiceTier | undefined;
    #serviceTierIntentVersion = 0;

    constructor(options: RemoteAgentOptions) {
        this.#client = options.client;
        this.#debug = options.debug === true;
        this.#session = options.session;
        this.#modelCatalog = options.modelCatalog;
        this.context = options.context;
        this.id = options.session.agentId;
        this.#modelId = options.session.modelId;
        this.#models = options.session.models;
        this.#providerId = options.session.providerId;
        this.#confirmedEffort = options.session.effort ?? options.session.snapshot.effort;
        this.#confirmedModelId = options.session.modelId;
        this.#confirmedModels = options.session.models;
        this.#confirmedProviderId = options.session.providerId;
        this.#confirmedServiceTier = sessionServiceTier(options.session);
        this.#serviceTierIntent = this.#confirmedServiceTier;
    }

    async steer(
        content: string | readonly ContentBlock[],
        options: SteeringRunOptions = {},
    ): Promise<SteerMessageResponse> {
        const displayText = options.displayText ?? contentToDisplayText(content);
        try {
            return await this.#client.steerMessage(this.#session.id, {
                ...(options.clientSubmissionId === undefined
                    ? {}
                    : { clientSubmissionId: options.clientSubmissionId }),
                ...(options.expectedRunId === undefined
                    ? {}
                    : { expectedRunId: options.expectedRunId }),
                ...(typeof content === "string" ? {} : { content }),
                ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
                text: displayText,
            });
        } catch (error) {
            if (options.clientSubmissionId !== undefined) {
                try {
                    const { events } = await this.#client.getEvents(this.#session.id);
                    const submitted = events.find(
                        (event) =>
                            event.type === "message_submitted" &&
                            event.data.message.id === options.clientSubmissionId,
                    );
                    if (
                        submitted?.type === "message_submitted" &&
                        submitted.data.delivery !== "context"
                    ) {
                        return {
                            delivery: submitted.data.delivery ?? "run",
                            eventId: submitted.id,
                            runId: submitted.data.runId,
                            sessionId: submitted.sessionId,
                        };
                    }
                } catch {
                    // Preserve the original steering error when acceptance cannot be reconciled.
                }
            }
            throw error;
        }
    }

    get canChangeModel(): boolean {
        return !this.#session.modelLocked;
    }

    get confirmedServiceTier(): ServiceTier | undefined {
        return this.#confirmedServiceTier;
    }

    get provider(): Provider {
        const serviceTiers = this.#modelCatalog?.providers.find(
            (provider) => provider.providerId === this.#providerId,
        )?.serviceTiers;
        return defineProvider({
            id: this.#providerId,
            models: this.#models,
            ...(serviceTiers === undefined ? {} : { serviceTiers }),
            stream() {
                throw new Error("RemoteAgent does not expose provider streaming locally.");
            },
        });
    }

    get model(): Model {
        const model = this.#models.find((candidate) => candidate.id === this.#modelId);
        if (model === undefined) {
            throw new Error(`Unknown remote model '${this.#modelId}'.`);
        }
        return model;
    }

    get modelChoices(): readonly CodingAssistantModelChoice[] {
        return (
            this.#modelCatalog?.providers.flatMap((provider) =>
                provider.models.map((model) => ({ model, providerId: provider.providerId })),
            ) ?? this.#models.map((model) => ({ model, providerId: this.#providerId }))
        );
    }

    get permissionMode(): PermissionMode {
        return this.#session.permissionMode;
    }

    get draft(): string {
        return this.#session.draft ?? "";
    }

    get draftUpdatedAt(): number | undefined {
        return this.#session.draftUpdatedAt;
    }

    /**
     * Store the composer draft on the daemon so the other terminals and clients
     * attached to this session show the same unsent message. `updatedAt` is when
     * the user typed it, which decides who wins when two clients disagree.
     */
    async setDraft(
        draft: string,
        options: { origin?: string; updatedAt?: number } = {},
    ): Promise<void> {
        await this.#client.setSessionDraft(this.#session.id, {
            draft: draft.length === 0 ? null : draft,
            ...(options.origin === undefined ? {} : { origin: options.origin }),
            ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
        });
    }

    get goal(): SessionGoal | undefined {
        return this.#session.goal === undefined ? undefined : { ...this.#session.goal };
    }

    get projectSecretIds(): readonly string[] {
        return [...this.#session.projectSecretIds];
    }

    get secretIds(): readonly string[] {
        return [...this.#session.secretIds];
    }

    get sessionSecretIds(): readonly string[] {
        return [...this.#session.sessionSecretIds];
    }

    async attachSecret(secretId: string, scope: SecretAttachmentScope = "session"): Promise<void> {
        const response = await this.#client.attachSecret(this.#session.id, secretId, scope);
        this.#replaceSession(response.session);
    }

    async detachSecret(secretId: string, scope: SecretAttachmentScope = "session"): Promise<void> {
        const response = await this.#client.detachSecret(this.#session.id, secretId, scope);
        this.#replaceSession(response.session);
    }

    abort(options?: AbortRunOptions) {
        return this.#client.abort(this.#session.id, options);
    }

    async stopBackgroundProcesses(): Promise<number> {
        const response = await this.#client.stopBackgroundProcesses(this.#session.id);
        return response.stoppedProcesses;
    }

    readBackgroundProcess(
        sessionId: number,
        options?: { waitMs?: number },
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        return this.#client.readBackgroundProcess(this.#session.id, sessionId, options);
    }

    stopBackgroundProcess(sessionId: number): Promise<StopBackgroundProcessResponse> {
        return this.#client.stopBackgroundProcess(this.#session.id, sessionId);
    }

    getUsage() {
        return this.#client.getSessionUsage(this.#session.id);
    }

    async setGoal(objective: string): Promise<void> {
        const response = await this.#client.setGoal(this.#session.id, { objective });
        this.#replaceSession(response.session);
    }

    async changeGoalStatus(status: GoalStatus): Promise<void> {
        const response = await this.#client.changeGoalStatus(this.#session.id, { status });
        this.#replaceSession(response.session);
    }

    async clearGoal(): Promise<void> {
        const response = await this.#client.clearGoal(this.#session.id);
        this.#replaceSession(response.session);
    }

    async compact(
        _ctx: Context,
        _signal?: AbortSignal,
        _onEvent?: AgentRunOptions["onEvent"],
    ): Promise<AgentCompactionResult> {
        const response = await this.#client.compact(this.#session.id);
        this.#replaceSession(response.session);
        return response.result;
    }

    async reset(): Promise<void> {
        const response = await this.#client.reset(this.#session.id);
        this.#replaceSession(response.session);
    }

    runShellCommand(
        command: string,
        options: { commandId: string },
    ): Promise<RunShellCommandResponse> {
        return this.#client.runShellCommand(this.#session.id, {
            command,
            commandId: options.commandId,
        });
    }

    async rewind(messageId: string): Promise<UserMessage> {
        const response = await this.#client.rewind(this.#session.id, messageId);
        this.#replaceSession(response.session);
        return response.message;
    }

    async send(
        _ctx: Context,
        content: string | readonly ContentBlock[],
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        const displayText = options.displayText ?? contentToDisplayText(content);
        const requestContent =
            typeof content === "string"
                ? options.displayText !== undefined && content !== displayText
                    ? [{ type: "text" as const, text: content }]
                    : undefined
                : content;
        const submitted = await this.#client.submitMessage(this.#session.id, {
            ...(options.clientSubmissionId === undefined
                ? {}
                : { clientSubmissionId: options.clientSubmissionId }),
            ...(requestContent === undefined ? {} : { content: requestContent }),
            ...(this.#debug ? { debug: true } : {}),
            ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
            text: displayText,
        });
        const streamController = new AbortController();
        let finished:
            | {
                  agentRunId?: string;
                  errorMessage?: string;
                  messages: AgentSnapshot["messages"];
                  providerError?: ProviderError;
                  providerId?: string;
                  requestedModelId?: string;
                  stopReason: StopReason;
              }
            | undefined;
        let failure: Error | undefined;
        let aborted = false;

        const abort = () => {
            if (aborted) return;
            aborted = true;
            void this.#client
                .abort(this.#session.id, { expectedRunId: submitted.runId })
                .catch(() => undefined);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted === true) abort();

        await this.#client.watchSessionEvents({
            after: submitted.eventId,
            sessionId: this.#session.id,
            signal: streamController.signal,
            onEvent: async (event) => {
                if (!isRunEvent(event, submitted.runId)) {
                    return;
                }

                this.applySessionEvent(event);

                if (event.type === "run_error") {
                    failure = new RemoteAgentRunError(
                        event.data.errorMessage,
                        submitted.debugDirectory,
                    );
                    streamController.abort();
                    return;
                }

                if (event.type === "run_finished") {
                    finished = {
                        ...(event.data.agentRunId !== undefined
                            ? { agentRunId: event.data.agentRunId }
                            : {}),
                        ...(event.data.errorMessage === undefined
                            ? {}
                            : { errorMessage: event.data.errorMessage }),
                        messages: this.#session.snapshot.messages,
                        ...(event.data.providerError === undefined
                            ? {}
                            : { providerError: event.data.providerError }),
                        ...(event.data.providerId === undefined
                            ? {}
                            : { providerId: event.data.providerId }),
                        ...(event.data.requestedModelId === undefined
                            ? {}
                            : { requestedModelId: event.data.requestedModelId }),
                        stopReason: event.data.stopReason,
                    };
                    streamController.abort();
                }
            },
        });

        options.signal?.removeEventListener("abort", abort);

        if (failure !== undefined) {
            throw failure;
        }
        const debug =
            submitted.debugDirectory === undefined
                ? {}
                : { debugDirectory: submitted.debugDirectory };
        const contextMessages =
            this.#session.snapshot.contextMessages ?? this.#session.snapshot.messages;
        if (finished === undefined) {
            const messages = this.#session.snapshot.messages;
            if (aborted) {
                return {
                    ...debug,
                    messages,
                    contextMessages,
                    runId: submitted.runId,
                    stopReason: "aborted",
                };
            }
            return {
                ...debug,
                errorMessage: "The remote run ended without a completion event.",
                messages,
                contextMessages,
                providerError: {
                    type: "unclassified",
                    diagnostics: {
                        attempts: 1,
                        upstreamMessage: "The remote run ended without a completion event.",
                    },
                },
                providerId: this.#providerId,
                requestedModelId: this.#modelId,
                runId: submitted.runId,
                stopReason: "error",
            };
        }

        if (finished.stopReason === "error") {
            return {
                ...debug,
                errorMessage: finished.errorMessage ?? "The model response failed.",
                messages: finished.messages,
                contextMessages,
                providerError: finished.providerError ?? {
                    type: "unclassified",
                    diagnostics: {
                        attempts: 1,
                        upstreamMessage: finished.errorMessage ?? "The model response failed.",
                    },
                },
                providerId: finished.providerId ?? this.#providerId,
                requestedModelId: finished.requestedModelId ?? this.#modelId,
                runId: finished.agentRunId ?? submitted.runId,
                stopReason: "error",
            };
        }
        return {
            ...debug,
            messages: finished.messages,
            contextMessages,
            runId: finished.agentRunId ?? submitted.runId,
            stopReason: finished.stopReason,
        };
    }

    sendContext(text: string): Promise<SubmitContextMessageResponse> {
        return this.#client.submitContextMessage(this.#session.id, { text });
    }

    setEffort(effort: string | undefined): void {
        this.#session = {
            ...this.#session,
            ...(effort !== undefined ? { effort } : {}),
            snapshot: {
                ...this.#session.snapshot,
                ...(effort !== undefined ? { effort } : {}),
            },
        };
        const request = effort !== undefined ? { effort } : {};
        void this.#client
            .changeEffort(this.#session.id, request)
            .then((response) => {
                this.#replaceSession(response.session);
            })
            .catch(() => undefined);
    }

    setModel(
        modelId: string,
        effort: string | undefined,
        providerId?: string,
    ): void | Promise<void> {
        const nextProviderId = providerId ?? this.#providerId;
        if (
            !this.canChangeModel &&
            (modelId !== this.#modelId || nextProviderId !== this.#providerId)
        ) {
            this.setEffort(effort);
            return;
        }

        const nextProvider = this.#modelCatalog?.providers.find(
            (provider) => provider.providerId === nextProviderId,
        );
        const nextModels = nextProvider?.models ?? this.#models;
        if (!nextModels.some((model) => model.id === modelId)) {
            throw new Error(`Unknown remote model '${modelId}' for provider '${nextProviderId}'.`);
        }

        const version = ++this.#modelChangeVersion;
        this.#modelId = modelId;
        this.#models = nextModels;
        this.#providerId = nextProviderId;
        const currentServiceTier = this.#session.serviceTier ?? this.#session.snapshot.serviceTier;
        const keepServiceTier =
            currentServiceTier === undefined ||
            nextProvider?.serviceTiers?.includes(currentServiceTier) === true;
        const { serviceTier: _sessionServiceTier, ...sessionWithoutServiceTier } = this.#session;
        const { serviceTier: _snapshotServiceTier, ...snapshotWithoutServiceTier } =
            this.#session.snapshot;
        this.#session = {
            ...(keepServiceTier ? this.#session : sessionWithoutServiceTier),
            ...(effort !== undefined ? { effort } : {}),
            modelId,
            models: nextModels,
            providerId: nextProviderId,
            snapshot: {
                ...(keepServiceTier ? this.#session.snapshot : snapshotWithoutServiceTier),
                ...(effort !== undefined ? { effort } : {}),
                modelId,
                providerId: nextProviderId,
            },
        };
        const operation = this.#enqueueConfigurationChange(async () => {
            try {
                const response = await this.#client.changeModel(this.#session.id, {
                    ...(effort !== undefined ? { effort } : {}),
                    modelId,
                    providerId: nextProviderId,
                });
                this.#recordConfirmedSession(response.session);
                if (version === this.#modelChangeVersion) {
                    this.#replaceSession(response.session);
                }
            } catch (error) {
                if (version === this.#modelChangeVersion) {
                    this.#restoreConfirmedModelSelection();
                }
                throw error;
            }
        });
        return operation;
    }

    setServiceTier(serviceTier: ServiceTier | undefined): Promise<void> {
        const version = ++this.#serviceTierIntentVersion;
        this.#serviceTierIntent = serviceTier;
        this.#serviceTierChangeCount += 1;
        this.#setLocalServiceTier(serviceTier);
        const request = serviceTier === undefined ? {} : { serviceTier };
        return this.#enqueueConfigurationChange(async () => {
            try {
                const response = await this.#client.changeServiceTier(this.#session.id, request);
                this.#confirmedServiceTier = sessionServiceTier(response.session);
                if (version === this.#serviceTierIntentVersion) {
                    this.#replaceSession(response.session);
                }
            } catch (error) {
                if (version === this.#serviceTierIntentVersion) {
                    this.#setLocalServiceTier(this.#confirmedServiceTier);
                }
                throw error;
            } finally {
                this.#serviceTierChangeCount -= 1;
                if (this.#serviceTierChangeCount === 0) {
                    this.#serviceTierIntent = this.#confirmedServiceTier;
                }
            }
        });
    }

    async setPermissionMode(permissionMode: PermissionMode): Promise<void> {
        const response = await this.#client.changePermissionMode(this.#session.id, {
            permissionMode,
        });
        this.#replaceSession(response.session);
    }

    snapshot(): AgentSnapshot {
        return this.#session.snapshot;
    }

    applySessionEvent(event: SessionEvent): void {
        if (event.sessionId !== this.#session.id) {
            return;
        }

        if (event.type === "session_created") {
            this.#replaceSession({ ...event.data.session, lastEventId: event.id });
            return;
        }

        if (event.type === "session_updated") {
            const current = event.data.session;
            const loaded = this.#session.snapshot;
            const contextMessages =
                event.data.appendedContextMessage === undefined
                    ? loaded.contextMessages
                    : appendUniqueMessage(
                          loaded.contextMessages ?? loaded.messages,
                          event.data.appendedContextMessage,
                      );
            this.#replaceSession({
                ...current,
                lastEventId: event.id,
                snapshot: {
                    ...current.snapshot,
                    messages: loaded.messages,
                    queue: loaded.queue,
                    tools: loaded.tools,
                    ...(contextMessages === undefined ? {} : { contextMessages }),
                    ...(loaded.instructions === undefined
                        ? {}
                        : { instructions: loaded.instructions }),
                    ...(loaded.lastRunId === undefined ? {} : { lastRunId: loaded.lastRunId }),
                    ...(current.systemPrompt === undefined
                        ? {}
                        : { systemPrompt: current.systemPrompt }),
                },
            });
            return;
        }

        this.#session = { ...this.#session, lastEventId: event.id };

        if (event.type === "session_activity_changed") {
            this.#session = { ...this.#session, activity: event.data.activity };
            return;
        }

        if (event.type === "session_archived") {
            this.#session = { ...this.#session, archived: event.data.archived };
            return;
        }

        if (event.type === "session_draft_changed") {
            const { draft, updatedAt } = event.data;
            this.#session =
                draft === undefined
                    ? { ...omitDraft(this.#session), draftUpdatedAt: updatedAt }
                    : { ...this.#session, draft, draftUpdatedAt: updatedAt };
            return;
        }

        if (event.type === "session_workspace_archived") {
            this.#pendingSteeringMessages.clear();
            this.#session = {
                ...this.#session,
                archived: true,
                modelLocked: false,
                status: "archived",
            };
            return;
        }

        if (event.type === "message_submitted") {
            if (event.data.delivery === "context") {
                this.#session = {
                    ...this.#session,
                    snapshot: {
                        ...this.#session.snapshot,
                        messages: appendUniqueMessage(
                            this.#session.snapshot.messages,
                            event.data.message,
                        ),
                    },
                };
                return;
            }
            if (event.data.delivery === "steer") {
                this.#pendingSteeringMessages.set(event.data.message.id, {
                    message: event.data.message,
                    runId: event.data.runId,
                });
                this.#session = { ...this.#session, modelLocked: true, status: "running" };
                return;
            }
            this.#session = {
                ...this.#session,
                modelLocked: true,
                status: this.#session.status === "running" ? "running" : "queued",
                snapshot: {
                    ...this.#session.snapshot,
                    messages: appendUniqueMessage(
                        this.#session.snapshot.messages,
                        event.data.message,
                    ),
                },
            };
            return;
        }

        if (event.type === "steering_applied") {
            for (const messageId of event.data.messageIds) {
                const pending = this.#pendingSteeringMessages.get(messageId);
                if (pending === undefined || pending.runId !== event.data.runId) continue;
                this.#session = {
                    ...this.#session,
                    snapshot: {
                        ...this.#session.snapshot,
                        messages: appendUniqueMessage(
                            this.#session.snapshot.messages,
                            pending.message,
                        ),
                    },
                };
                this.#pendingSteeringMessages.delete(messageId);
            }
            return;
        }

        if (event.type === "agent_message") {
            this.#session = {
                ...this.#session,
                snapshot: {
                    ...this.#session.snapshot,
                    messages: appendUniqueMessage(
                        this.#session.snapshot.messages,
                        event.data.message,
                    ),
                },
            };
            return;
        }

        if (event.type === "run_started") {
            this.#session = { ...this.#session, modelLocked: true, status: "running" };
            return;
        }

        if (event.type === "run_error") {
            this.#discardPendingSteeringMessages(event.data.runId);
            this.#session = {
                ...this.#session,
                modelLocked: event.data.modelLocked,
                status: "error",
            };
            return;
        }

        if (event.type === "run_finished") {
            this.#discardPendingSteeringMessages(event.data.runId);
            this.#session = {
                ...this.#session,
                modelLocked: event.data.modelLocked,
                status: event.data.stopReason === "aborted" ? "aborted" : "completed",
            };
            return;
        }

        if (event.type === "session_reset") {
            this.#pendingSteeringMessages.clear();
            this.#session = {
                ...this.#session,
                modelLocked: false,
                status: "idle",
            };
            this.#applyAuthoritativeSnapshot(event.data.snapshot);
            return;
        }

        if (event.type === "session_rewound") {
            this.#pendingSteeringMessages.clear();
            this.#session = {
                ...this.#session,
                modelLocked: false,
                status: "idle",
            };
            this.#applyAuthoritativeSnapshot(event.data.snapshot);
            return;
        }

        if (event.type === "session_configuration_changed") {
            this.#modelId = event.data.modelId;
            this.#providerId = event.data.providerId;
            this.#models =
                this.#modelCatalog?.providers.find(
                    (provider) => provider.providerId === this.#providerId,
                )?.models ?? this.#models;
            const { effort: _effort, serviceTier: _serviceTier, ...session } = this.#session;
            const {
                effort: _snapshotEffort,
                serviceTier: _snapshotServiceTier,
                ...snapshot
            } = this.#session.snapshot;
            this.#session = {
                ...session,
                ...(event.data.effort !== undefined ? { effort: event.data.effort } : {}),
                // Only an actual model change releases the lock; a reasoning or fast mode change
                // leaves whatever the user pinned in place.
                modelLocked: event.data.changed.includes("model")
                    ? false
                    : this.#session.modelLocked,
                modelId: event.data.modelId,
                models: this.#models,
                providerId: event.data.providerId,
            };
            // Configuration events carry only configuration. Keep the already loaded bounded
            // transcript instead of duplicating it into every durable model or effort change.
            this.#applyAuthoritativeSnapshot({
                ...snapshot,
                ...(event.data.effort === undefined ? {} : { effort: event.data.effort }),
                modelId: event.data.modelId,
                providerId: event.data.providerId,
                ...(event.data.serviceTier === null ? {} : { serviceTier: event.data.serviceTier }),
            });
            return;
        }

        if (event.type === "permission_mode_changed") {
            this.#session = {
                ...this.#session,
                permissionMode: event.data.permissionMode,
            };
            this.context.permissions?.setMode(event.data.permissionMode);
            return;
        }

        if (event.type === "secrets_changed") {
            this.#session = {
                ...this.#session,
                projectSecretIds: event.data.projectSecretIds,
                secretIds: event.data.secretIds,
                sessionSecretIds: event.data.sessionSecretIds,
            };
            return;
        }

        if (event.type === "goal_changed") {
            if (event.data.goal === null) {
                const { goal: _goal, ...session } = this.#session;
                this.#session = session;
            } else {
                this.#session = { ...this.#session, goal: { ...event.data.goal } };
            }
            return;
        }

        if (event.type === "user_input_requested") {
            this.#session = {
                ...this.#session,
                pendingUserInputs: [
                    ...this.#session.pendingUserInputs.filter(
                        (request) => request.requestId !== event.data.requestId,
                    ),
                    event.data,
                ],
            };
            return;
        }

        if (event.type === "user_input_resolved") {
            this.#session = {
                ...this.#session,
                pendingUserInputs: this.#session.pendingUserInputs.filter(
                    (request) => request.requestId !== event.data.requestId,
                ),
            };
            return;
        }

        if (event.type === "mcp_servers_changed") {
            this.#session = { ...this.#session, mcpServers: event.data.servers };
            return;
        }

        if (event.type === "tasks_changed") {
            this.#session = { ...this.#session, tasks: event.data.tasks };
            return;
        }
    }

    #replaceSession(session: ProtocolSession): void {
        if (
            session.lastEventId !== undefined &&
            this.#session.lastEventId !== undefined &&
            session.lastEventId < this.#session.lastEventId
        ) {
            return;
        }
        this.#recordConfirmedSession(session);
        this.#session = session;
        if (this.#serviceTierChangeCount > 0) {
            this.#setLocalServiceTier(this.#serviceTierIntent);
        }
        this.context.permissions?.setMode(session.permissionMode);
        this.#modelId = session.modelId;
        this.#models = session.models;
        this.#providerId = session.providerId;
    }

    #discardPendingSteeringMessages(runId: string): void {
        for (const [messageId, pending] of this.#pendingSteeringMessages) {
            if (pending.runId === runId) this.#pendingSteeringMessages.delete(messageId);
        }
    }

    #enqueueConfigurationChange(change: () => Promise<void>): Promise<void> {
        const operation = this.#configurationChangeQueue.then(change);
        this.#configurationChangeQueue = operation.catch(() => undefined);
        return operation;
    }

    #applyAuthoritativeSnapshot(snapshot: AgentSnapshot): void {
        const { serviceTier: _serviceTier, ...session } = this.#session;
        this.#session = {
            ...session,
            ...(snapshot.serviceTier === undefined ? {} : { serviceTier: snapshot.serviceTier }),
            snapshot,
        };
        this.#recordConfirmedSession(this.#session);
        if (this.#serviceTierChangeCount > 0) {
            this.#setLocalServiceTier(this.#serviceTierIntent);
        }
    }

    #recordConfirmedSession(session: ProtocolSession): void {
        this.#confirmedEffort = session.effort ?? session.snapshot.effort;
        this.#confirmedModelId = session.modelId;
        this.#confirmedModels = session.models;
        this.#confirmedProviderId = session.providerId;
        this.#confirmedServiceTier = sessionServiceTier(session);
    }

    #restoreConfirmedModelSelection(): void {
        this.#modelId = this.#confirmedModelId;
        this.#models = this.#confirmedModels;
        this.#providerId = this.#confirmedProviderId;
        const { effort: _sessionEffort, ...session } = this.#session;
        const { effort: _snapshotEffort, ...snapshot } = this.#session.snapshot;
        this.#session = {
            ...session,
            ...(this.#confirmedEffort === undefined ? {} : { effort: this.#confirmedEffort }),
            modelId: this.#confirmedModelId,
            models: this.#confirmedModels,
            providerId: this.#confirmedProviderId,
            snapshot: {
                ...snapshot,
                ...(this.#confirmedEffort === undefined ? {} : { effort: this.#confirmedEffort }),
                modelId: this.#confirmedModelId,
                providerId: this.#confirmedProviderId,
            },
        };
        this.#setLocalServiceTier(
            this.#serviceTierChangeCount > 0 ? this.#serviceTierIntent : this.#confirmedServiceTier,
        );
    }

    #setLocalServiceTier(serviceTier: ServiceTier | undefined): void {
        const { serviceTier: _sessionServiceTier, ...session } = this.#session;
        const { serviceTier: _snapshotServiceTier, ...snapshot } = this.#session.snapshot;
        this.#session = {
            ...session,
            ...(serviceTier === undefined ? {} : { serviceTier }),
            snapshot: {
                ...snapshot,
                ...(serviceTier === undefined ? {} : { serviceTier }),
            },
        };
    }
}

function omitDraft(session: ProtocolSession): ProtocolSession {
    const { draft: _draft, ...rest } = session;
    return rest;
}

function sessionServiceTier(session: ProtocolSession): ServiceTier | undefined {
    return session.serviceTier ?? session.snapshot.serviceTier;
}

function appendUniqueMessage(
    messages: AgentSnapshot["messages"],
    message: AgentSnapshot["messages"][number],
): AgentSnapshot["messages"] {
    if (messages.some((candidate) => candidate.id === message.id)) {
        return messages;
    }
    return [...messages, message];
}

function isRunEvent(event: SessionEvent, runId: string): boolean {
    if (event.type === "session_activity_changed") {
        return event.data.activity.runId === runId;
    }
    if (
        event.type !== "agent_event" &&
        event.type !== "agent_message" &&
        event.type !== "run_error" &&
        event.type !== "run_finished" &&
        event.type !== "run_started" &&
        event.type !== "steering_applied"
    ) {
        return false;
    }

    return event.data.runId === runId;
}

function contentToDisplayText(content: string | readonly ContentBlock[]): string {
    if (typeof content === "string") {
        return content;
    }

    return content
        .map((block) => (block.type === "text" ? block.text : `[image:${block.mediaType}]`))
        .join("");
}
