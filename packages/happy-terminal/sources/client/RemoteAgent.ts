import type { Context } from "@steve.kite/stdlib";
import { applyMessageDelta } from "@slopus/happy-agent-client";
import type {
    Agent as ApiAgent,
    AgentBootstrapResponse,
    AgentDraftSnapshot,
    DaemonConfig,
    HappyAgentClient,
    HappyAgentEvent,
    Message as ApiMessage,
    MessageBlock as ApiMessageBlock,
    MessageHistoryResponse,
    MessageMode,
    Run,
    ToolCallBlock as ApiToolCallBlock,
    UsageBreakdown,
    UserMessage as ApiUserMessage,
} from "@slopus/happy-agent-client";

import type {
    AgentCompactionResult,
    AgentLoopEvent,
    AgentSnapshot,
    ContentBlock,
    Message,
    Model,
    PermissionMode,
    ServiceTier,
    StopReason,
    ToolCallBlock,
    ToolResultBlock,
    Usage,
} from "../protocol/index.js";
import type {
    AgentRunOptions,
    AgentRunResult,
    CodingAssistantAgentBackend,
    CodingAssistantClientProvider,
    CodingAssistantModelChoice,
    SteeringRunOptions,
} from "../app/CodingAssistantAgentBackend.js";
import type {
    AbortRunOptions,
    AbortRunResponse,
    GetSessionUsageResponse,
    ReadBackgroundProcessResponse,
    RunShellCommandResponse,
    SessionProviderQuota,
    SteerMessageResponse,
    StopBackgroundProcessResponse,
} from "../protocol/index.js";
import { fetchProviderQuotas } from "./fetchProviderQuotas.js";
import { RemoteAgentRunError } from "./RemoteAgentRunError.js";
import type { HappyAgentEventHub } from "./HappyAgentEventHub.js";

export interface RemoteAgentOptions {
    agent: ApiAgent;
    bootstrap: AgentBootstrapResponse;
    client: HappyAgentClient;
    config: DaemonConfig;
    events: HappyAgentEventHub;
    history: MessageHistoryResponse;
}

interface PendingSelection {
    effort?: string;
    modelId?: string;
    permissionMode?: PermissionMode;
    providerId?: string;
    serviceTier?: ServiceTier | null;
}

/**
 * The TUI's agent backend over the public Happy Agent API.
 *
 * This class projects public message blocks into Happy Terminal's renderer vocabulary, but
 * it never reconstructs or calls the removed session protocol. Runs, messages,
 * steering, compaction, drafts, questions, and processes all go through the
 * durable `HappyAgentClient` instance supplied by the daemon connection.
 */
export class RemoteAgent implements CodingAssistantAgentBackend {
    readonly id: string;

    #agent: ApiAgent;
    readonly #client: HappyAgentClient;
    #config: DaemonConfig;
    readonly #events: HappyAgentEventHub;
    #history: MessageHistoryResponse;
    #draft: AgentDraftSnapshot;
    #lastMode: MessageMode | null;
    #pending: ApiUserMessage[];
    readonly #messages = new Map<string, ApiMessage>();
    readonly #messageEventResults = new Map<string, ApiMessage | typeof MESSAGE_DELETED>();
    readonly #messageDeltaAppends = new Map<string, string>();
    /** The streamed assistant message of each run, so a finished run can decorate it. */
    readonly #assistantMessageIdsByRunId = new Map<string, string>();
    /** The service record of each run, so a failed run can surface its error report. */
    readonly #serviceMessageIdsByRunId = new Map<string, string>();
    #lastRunFailure: { runId: string; text: string } | undefined;
    /** One account-quota probe per provider; quota is a courtesy and never re-fires. */
    readonly #quotaProbes = new Map<string, Promise<readonly SessionProviderQuota[]>>();
    /** True while a send() carrying an onEvent callback owns loop-event delivery. */
    #sendOwnsLoopEvents = false;
    #resyncing: Promise<AgentSnapshot> | undefined;
    #selection: PendingSelection | undefined;
    #contextTokens: number | undefined;

    constructor(options: RemoteAgentOptions) {
        this.#agent = options.agent;
        this.#client = options.client;
        this.#config = options.config;
        this.#events = options.events;
        this.#history = options.history;
        this.#draft = structuredClone(options.bootstrap.draft);
        this.#lastMode = options.bootstrap.mode;
        this.#pending = structuredClone(options.bootstrap.pending);
        this.#contextTokens = options.bootstrap.context?.contextTokens;
        this.id = options.agent.id;
        for (const run of options.history.runs) {
            for (const message of run.messages) this.#messages.set(message.id, message);
        }
        for (const message of this.#pending) this.#messages.set(message.id, message);
    }

    get canChangeModel(): boolean {
        return true;
    }

    get confirmedServiceTier(): ServiceTier | undefined {
        return this.#currentMode().serviceTier === null ? undefined : "fast";
    }

    get provider(): CodingAssistantClientProvider {
        const providerId = this.#currentMode().providerId;
        const provider = this.#config.providers[providerId];
        return {
            id: providerId,
            models: this.#modelsForProvider(providerId),
            ...(provider?.models.some(
                (reference) =>
                    reference.enabled &&
                    (
                        reference.serviceTiers ??
                        this.#config.models[reference.id]?.serviceTiers ??
                        []
                    ).length > 0,
            )
                ? { serviceTiers: ["fast" as const] }
                : {}),
        };
    }

    get model(): Model {
        const mode = this.#currentMode();
        const model = this.#modelsForProvider(mode.providerId).find(
            (candidate) => candidate.id === mode.modelId,
        );
        if (model === undefined) {
            throw new Error(`Unknown model '${mode.modelId}' for provider '${mode.providerId}'.`);
        }
        return model;
    }

    get modelChoices(): readonly CodingAssistantModelChoice[] {
        return Object.entries(this.#config.providers).flatMap(([providerId, provider]) =>
            provider.enabled
                ? this.#modelsForProvider(providerId).map((model) => ({ model, providerId }))
                : [],
        );
    }

    get permissionMode(): PermissionMode {
        return this.#currentMode().permissionMode;
    }

    get draft(): string {
        return this.#draft.value?.text ?? "";
    }

    get draftUpdatedAt(): number | undefined {
        return this.#draft.updatedAt ?? undefined;
    }

    async setDraft(
        draft: string,
        options: { origin?: string; updatedAt?: number } = {},
    ): Promise<void> {
        const mode = this.#currentMode();
        const response = await this.#client.saveAgentDraft(this.id, {
            draft:
                draft.length === 0
                    ? null
                    : {
                          effort: mode.effort,
                          modelId: mode.modelId,
                          permissionMode: mode.permissionMode,
                          providerId: mode.providerId,
                          serviceTier: mode.serviceTier,
                          text: draft,
                      },
            ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
            ...(options.origin === undefined ? {} : { mutationId: options.origin }),
        });
        this.#draft = structuredClone(response.draft);
    }

    async abort(options: AbortRunOptions = {}): Promise<AbortRunResponse> {
        const response = await this.#client.abortAgent(this.id, {
            ...(options.expectedRunId === undefined
                ? {}
                : { expectedRunId: options.expectedRunId }),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        this.#agent = response.agent;
        return { aborted: true, eventId: response.cursor };
    }

    async stopBackgroundProcesses(): Promise<number> {
        const activity = await this.#client.getAgentActivity(this.id);
        const running = activity.processes.filter((process) => process.status === "running");
        await Promise.all(running.map((process) => this.#client.stopProcess(this.id, process.id)));
        return running.length;
    }

    readBackgroundProcess(
        _sessionId: number,
        _options?: { waitMs?: number },
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        // The public process API deliberately exposes lifecycle, not output.
        return Promise.resolve(undefined);
    }

    stopBackgroundProcess(_sessionId: number): Promise<StopBackgroundProcessResponse> {
        // Public process IDs are CUID2 strings; the old numeric terminal handle
        // is not fabricated or guessed.
        return Promise.resolve({ stopped: false });
    }

    /**
     * The current provider's account quota, probed at most once per provider. Happy Terminal signs in
     * through the system coding assistants, so the terminal asks the vendor with this machine's
     * own credentials rather than adding a daemon surface for it.
     */
    providerQuotas(): Promise<readonly SessionProviderQuota[]> {
        const providerId = this.#currentMode().providerId;
        let probe = this.#quotaProbes.get(providerId);
        if (probe === undefined) {
            probe = fetchProviderQuotas(providerId, this.#config.providers[providerId]?.type);
            this.#quotaProbes.set(providerId, probe);
        }
        return probe;
    }

    async getUsage(): Promise<GetSessionUsageResponse> {
        const response = await this.#client.getAgentUsage(this.id);
        const groups = Object.entries(response.usage).flatMap(([providerId, models]) =>
            Object.entries(models).map(([modelId, usage]) => ({
                kind: "attributed" as const,
                modelId,
                providerId,
                requestedModelId: modelId,
                usage: {
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                        total: 0,
                    },
                    input: usage.input,
                    output: usage.output,
                    totalTokens: usage.input + usage.output,
                },
            })),
        );
        return {
            currentProviderId: this.#currentMode().providerId,
            groups,
            ...(response.context === null
                ? {}
                : {
                      context: {
                          approximate: response.context.approximate,
                          modelId: response.context.modelId ?? this.#currentMode().modelId,
                          providerId: response.context.providerId,
                          requestedModelId: response.context.modelId ?? this.#currentMode().modelId,
                          totalTokens: response.context.contextTokens,
                      },
                  }),
            quotas: await this.providerQuotas(),
        };
    }

    async compact(
        _ctx: Context,
        _signal?: AbortSignal,
        _onEvent?: AgentRunOptions["onEvent"],
    ): Promise<AgentCompactionResult> {
        const response = await this.#client.compactAgent(this.id);
        this.#agent = response.agent;
        return {
            compacted: true,
            compactedMessageCount: 0,
            estimatedTokensAfter: 0,
            estimatedTokensBefore: 0,
            retainedMessageCount: this.#snapshotMessages().length,
        };
    }

    reset(): Promise<void> {
        return Promise.reject(
            new Error("The Happy Agent API does not expose transcript reset or rewind."),
        );
    }

    runShellCommand(
        _command: string,
        _options: { commandId: string },
    ): Promise<RunShellCommandResponse> {
        return Promise.reject(
            new Error(
                "Direct shell composer commands are not part of the Happy Agent API. Send the command to the agent instead.",
            ),
        );
    }

    async steer(
        content: string | readonly ContentBlock[],
        options: SteeringRunOptions = {},
    ): Promise<void | SteerMessageResponse> {
        const selection = this.#selection;
        const submitted = await this.#client.sendMessage(this.id, {
            ...toSendBody(content, options.displayText, this.#messageMode(selection)),
            delivery: "steer",
            ...(options.clientSubmissionId === undefined ? {} : { id: options.clientSubmissionId }),
        });
        this.#lastMode = submitted.message.mode;
        this.#clearSelection(selection);
    }

    async send(
        _ctx: Context,
        content: string | readonly ContentBlock[],
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        const selection = this.#selection;
        const projectsEvents = options.onEvent !== undefined || options.onMessage !== undefined;
        this.#sendOwnsLoopEvents = options.onEvent !== undefined;
        const submitted = await this.#client
            .sendMessage(this.id, {
                ...toSendBody(content, options.displayText, this.#messageMode(selection)),
                delivery: "queue",
                ...(options.clientSubmissionId === undefined
                    ? {}
                    : { id: options.clientSubmissionId }),
            })
            .catch((error: unknown) => {
                this.#sendOwnsLoopEvents = false;
                throw error;
            });
        this.#clearSelection(selection);
        this.#lastMode = submitted.message.mode;

        let activeRunId = submitted.message.runId;
        let terminalRun: Run | undefined;
        let aborted = false;
        const streamController = new AbortController();
        const abort = () => {
            aborted = true;
            void this.#client
                .abortAgent(this.id, activeRunId === null ? {} : { expectedRunId: activeRunId })
                .catch(() => undefined);
            streamController.abort();
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted === true) abort();

        try {
            await this.#events.follow({
                after: submitted.cursor,
                signal: streamController.signal,
                onGap: async () => {
                    await this.resync();
                    const recovered = this.#history.runs.find((run) =>
                        run.messages.some((message) => message.id === submitted.message.id),
                    );
                    if (recovered === undefined) return;
                    activeRunId = recovered.id;
                    if (recovered.status !== "running") {
                        terminalRun = recovered;
                        streamController.abort();
                    }
                },
                onEvent: async (event) => {
                    if (!belongsToAgent(event, this.id)) return false;
                    this.#applyResourceEvent(event);
                    if (projectsEvents) await this.#forwardMessageEvent(event, options);

                    if (
                        event.type === "run.started" &&
                        event.payload.acceptedMessageIds.includes(submitted.message.id)
                    ) {
                        activeRunId = event.payload.run.id;
                    } else if (
                        event.type === "run.boundary" &&
                        activeRunId === event.payload.finishedRun.id
                    ) {
                        // Steering is one user-visible continuation. Keep consuming
                        // the atomic successor instead of leaving its output without
                        // an owner in the terminal.
                        activeRunId = event.payload.startedRun.id;
                    } else if (
                        event.type === "run.finished" &&
                        activeRunId === event.payload.run.id
                    ) {
                        terminalRun = event.payload.run;
                        return true;
                    }
                    return false;
                },
            });
        } catch (error) {
            if (!aborted) throw error;
        } finally {
            this.#sendOwnsLoopEvents = false;
            options.signal?.removeEventListener("abort", abort);
            streamController.abort();
        }

        await this.#refresh();
        const snapshot = this.snapshot();
        const runId = terminalRun?.id ?? activeRunId ?? submitted.message.id;
        const stopReason = aborted ? "aborted" : toStopReason(terminalRun);
        if (terminalRun?.status === "failed") {
            const captured =
                this.#lastRunFailure?.runId === terminalRun.id
                    ? this.#lastRunFailure.text
                    : undefined;
            throw new RemoteAgentRunError(
                captured ??
                    failedRunMessage(this.#history, terminalRun.id) ??
                    "The remote run failed.",
            );
        }
        return {
            contextMessages: snapshot.messages,
            messages: snapshot.messages,
            runId,
            stopReason,
        };
    }

    setEffort(effort: string | undefined): void {
        if (effort === undefined) return;
        this.#selection = { ...this.#selection, effort };
    }

    setModel(modelId: string, effort: string | undefined, providerId?: string): void {
        const resolvedProviderId = providerId ?? this.#currentMode().providerId;
        const model = this.#modelsForProvider(resolvedProviderId).find(
            (candidate) => candidate.id === modelId,
        );
        if (model === undefined) {
            throw new Error(`Unknown model '${modelId}' for provider '${resolvedProviderId}'.`);
        }
        // Switching models must not strand an effort the new model cannot run: a carried-over
        // effort usually belongs to the previous model, so an unsupported one falls back to the
        // new model's own default.
        const carried = effort ?? this.#currentMode().effort;
        this.#selection = {
            ...this.#selection,
            effort: model.thinkingLevels.includes(carried) ? carried : model.defaultThinkingLevel,
            modelId,
            providerId: resolvedProviderId,
        };
    }

    setServiceTier(serviceTier: ServiceTier | undefined): void {
        this.#selection = { ...this.#selection, serviceTier: serviceTier ?? null };
    }

    setPermissionMode(permissionMode: PermissionMode): Promise<void> {
        this.#selection = { ...this.#selection, permissionMode };
        return Promise.resolve();
    }

    snapshot(): AgentSnapshot {
        const mode = this.#currentMode();
        return {
            effort: mode.effort,
            id: this.id,
            messages: this.#snapshotMessages(),
            modelId: mode.modelId,
            providerId: mode.providerId,
            queue: this.#pending.map((message) => ({
                id: message.id,
                message: toTerminalMessage(message),
            })),
            ...(mode.serviceTier === null ? {} : { serviceTier: "fast" }),
            status: this.#agent.status === "idle" ? "idle" : "running",
            tools: [],
        };
    }

    /** Reloads the authoritative agent and transcript after an event-stream gap. */
    async resync(): Promise<AgentSnapshot> {
        if (this.#resyncing !== undefined) return await this.#resyncing;
        const resyncing = Promise.all([this.#refresh(), this.reconcileModelCatalog()]).then(() =>
            this.snapshot(),
        );
        this.#resyncing = resyncing;
        try {
            return await resyncing;
        } finally {
            if (this.#resyncing === resyncing) this.#resyncing = undefined;
        }
    }

    /** Replaces the model/provider catalog after the daemon announces a config change. */
    async reconcileModelCatalog(): Promise<void> {
        this.#config = (await this.#client.getConfig()).config;
    }

    /** Applies one global API event and returns a renderable message when it carried one. */
    applyEvent(event: HappyAgentEvent): Message | undefined {
        if (!belongsToAgent(event, this.id)) return undefined;
        this.#applyResourceEvent(event);
        this.#applyBootstrapEvent(event);
        if (event.type === "agent.context.updated") {
            this.#contextTokens = event.payload.context?.contextTokens;
            return undefined;
        }
        if (event.type === "run.finished") {
            if (event.payload.run.status === "failed") {
                // A failed run's service record is its error report, rendered as one.
                const serviceId = this.#serviceMessageIdsByRunId.get(event.payload.run.id);
                this.#serviceMessageIdsByRunId.delete(event.payload.run.id);
                this.#assistantMessageIdsByRunId.delete(event.payload.run.id);
                const service = serviceId === undefined ? undefined : this.#messages.get(serviceId);
                const report = service === undefined ? undefined : toRunErrorMessage(service);
                const block = report?.blocks[0];
                if (block?.type === "text") {
                    this.#lastRunFailure = { runId: event.payload.run.id, text: block.text };
                }
                return report;
            }
            // The protocol carries usage on the run; the TUI accounts it on the run's
            // assistant message, so the finished run decorates that message once.
            const messageId = this.#assistantMessageIdsByRunId.get(event.payload.run.id);
            this.#assistantMessageIdsByRunId.delete(event.payload.run.id);
            this.#serviceMessageIdsByRunId.delete(event.payload.run.id);
            const cached = messageId === undefined ? undefined : this.#messages.get(messageId);
            const usage = flattenRunUsage(event.payload.run.usage);
            if (cached === undefined || usage === undefined) return undefined;
            const projected = toTerminalMessage(cached);
            if (projected.role !== "agent") return undefined;
            return {
                ...projected,
                usage,
                ...(this.#contextTokens === undefined
                    ? {}
                    : { contextTokens: this.#contextTokens }),
            };
        }
        const message = this.#projectMessageEvent(event);
        if (message !== undefined && message !== MESSAGE_DELETED && event.type !== "message.delta")
            return toTerminalMessage(message);
        return undefined;
    }

    /**
     * Projects streaming and reset API events into Happy Terminal's live inference vocabulary. A send that
     * carries its own onEvent callback receives loop events there instead, so this global path
     * stays silent for it rather than delivering every event twice.
     */
    applyLoopEvent(event: HappyAgentEvent): AgentLoopEvent | undefined {
        if (this.#sendOwnsLoopEvents) return undefined;
        return this.#projectLoopEvent(event);
    }

    #projectLoopEvent(event: HappyAgentEvent): AgentLoopEvent | undefined {
        if (!belongsToAgent(event, this.id)) return undefined;
        const message = this.#projectMessageEvent(event);
        if (event.type === "message.deleted") return { type: "block_reset" };
        if (
            event.type !== "message.delta" ||
            message === undefined ||
            message === MESSAGE_DELETED
        ) {
            return undefined;
        }
        const block = message.content[event.payload.blockIndex];
        const append = this.#messageDeltaAppends.get(event.cursor);
        if (append === undefined || append.length === 0) return undefined;
        if (block?.type === "reasoning") {
            return {
                type: "thinking_delta",
                contentIndex: event.payload.blockIndex,
                delta: append,
            };
        }
        if (block?.type === "text") {
            return { type: "text_delta", delta: append };
        }
        return undefined;
    }

    #modelsForProvider(providerId: string): readonly Model[] {
        const provider = this.#config.providers[providerId];
        if (provider === undefined) return [];
        return provider.models.flatMap((reference) => {
            const definition = this.#config.models[reference.id];
            if (!reference.enabled || definition === undefined) return [];
            return [
                {
                    defaultThinkingLevel: definition.defaultEffort,
                    ...(definition.contextWindow === null
                        ? {}
                        : { contextWindow: definition.contextWindow }),
                    id: reference.id,
                    name: definition.name,
                    thinkingLevels: definition.efforts,
                },
            ];
        });
    }

    #currentMode(): MessageMode {
        const base = this.#lastMode ?? this.#config.defaults;
        const previousServiceTier = this.#lastMode?.serviceTier ?? null;
        return {
            effort: this.#selection?.effort ?? base.effort,
            modelId: this.#selection?.modelId ?? base.modelId,
            permissionMode: this.#selection?.permissionMode ?? base.permissionMode,
            providerId: this.#selection?.providerId ?? base.providerId,
            serviceTier:
                this.#selection?.serviceTier === undefined
                    ? previousServiceTier
                    : this.#selection.serviceTier === null
                      ? null
                      : preferredServiceTier(
                            this.#config,
                            this.#selection?.providerId ?? base.providerId,
                            this.#selection?.modelId ?? base.modelId,
                        ),
        };
    }

    #messageMode(selection: PendingSelection | undefined): MessageMode {
        const current = this.#currentMode();
        if (selection === undefined) return current;
        return {
            effort: selection.effort ?? current.effort,
            modelId: selection.modelId ?? current.modelId,
            permissionMode: selection.permissionMode ?? current.permissionMode,
            providerId: selection.providerId ?? current.providerId,
            serviceTier:
                selection.serviceTier === undefined
                    ? current.serviceTier
                    : selection.serviceTier === null
                      ? null
                      : preferredServiceTier(
                            this.#config,
                            selection.providerId ?? current.providerId,
                            selection.modelId ?? current.modelId,
                        ),
        };
    }

    #clearSelection(selection: PendingSelection | undefined): void {
        if (selection !== undefined && this.#selection === selection) this.#selection = undefined;
    }

    #snapshotMessages(): Message[] {
        return this.#history.runs.flatMap((run) =>
            run.messages.map((message) =>
                run.status === "failed" && message.role === "service"
                    ? (toRunErrorMessage(message) ?? toTerminalMessage(message))
                    : toTerminalMessage(message),
            ),
        );
    }

    async #refresh(): Promise<void> {
        const [agent, bootstrap, history] = await Promise.all([
            this.#client.getAgent(this.id),
            this.#client.getAgentBootstrap(this.id),
            this.#client.getMessages(this.id, { limit: 50 }),
        ]);
        this.#agent = agent.agent;
        this.#draft = structuredClone(bootstrap.draft);
        this.#lastMode = bootstrap.mode;
        this.#pending = structuredClone(bootstrap.pending);
        this.#contextTokens = bootstrap.context?.contextTokens;
        this.#history = history;
        this.#messages.clear();
        this.#messageEventResults.clear();
        this.#messageDeltaAppends.clear();
        for (const run of history.runs) {
            for (const message of run.messages) this.#messages.set(message.id, message);
        }
        for (const message of this.#pending) this.#messages.set(message.id, message);
    }

    #applyBootstrapEvent(event: HappyAgentEvent): void {
        if (event.type === "agent.draft.updated") {
            this.#draft = structuredClone(event.payload.draft);
            return;
        }
        if (event.type === "message.created" && event.payload.message.role === "user") {
            this.#lastMode = event.payload.message.mode;
            if (event.payload.message.status === "pending") {
                this.#pending = [
                    ...this.#pending.filter((message) => message.id !== event.payload.message.id),
                    structuredClone(event.payload.message),
                ];
            }
            return;
        }
        const accepted =
            event.type === "run.started" || event.type === "run.boundary"
                ? new Set(event.payload.acceptedMessageIds)
                : undefined;
        if (accepted === undefined || accepted.size === 0) return;
        this.#pending = this.#pending.filter((message) => !accepted.has(message.id));
    }

    #applyResourceEvent(event: HappyAgentEvent): void {
        if (event.type !== "agent.updated" || event.payload.agentId !== this.id) return;
        this.#agent = {
            ...this.#agent,
            ...event.payload.changes,
            version: event.payload.version,
        };
    }

    async #forwardMessageEvent(event: HappyAgentEvent, options: AgentRunOptions): Promise<void> {
        const message = this.applyEvent(event);
        const loopEvent = this.#projectLoopEvent(event);
        if (loopEvent !== undefined) await options.onEvent?.(loopEvent);
        if (message?.role === "agent" || message?.role === "error") {
            await options.onMessage?.(message);
        }
    }

    #projectMessageEvent(event: HappyAgentEvent): ApiMessage | typeof MESSAGE_DELETED | undefined {
        const cached = this.#messageEventResults.get(event.cursor);
        if (cached !== undefined) return cached;
        let result: ApiMessage | typeof MESSAGE_DELETED | undefined;
        if (event.type === "message.created" || event.type === "message.updated") {
            result = structuredClone(event.payload.message);
            this.#messages.set(result.id, result);
            if (result.role === "agent" && event.payload.runId !== null) {
                this.#assistantMessageIdsByRunId.set(event.payload.runId, result.id);
            }
            if (result.role === "service" && event.payload.runId !== null) {
                this.#serviceMessageIdsByRunId.set(event.payload.runId, result.id);
            }
        } else if (event.type === "message.delta") {
            const current = this.#messages.get(event.payload.messageId);
            const application = applyMessageDelta(current, event.payload);
            if (application.kind === "reconcile") {
                this.#messageDeltaAppends.set(event.cursor, "");
                void this.resync().catch(() => undefined);
            } else {
                result = application.message;
                this.#messageDeltaAppends.set(event.cursor, application.append);
                this.#messages.set(result.id, result);
            }
        } else if (event.type === "message.deleted") {
            this.#messages.delete(event.payload.messageId);
            result = MESSAGE_DELETED;
        }
        if (result !== undefined) {
            this.#messageEventResults.set(event.cursor, result);
            if (this.#messageEventResults.size > 512) {
                const oldest = this.#messageEventResults.keys().next().value as string | undefined;
                if (oldest !== undefined) {
                    this.#messageEventResults.delete(oldest);
                    this.#messageDeltaAppends.delete(oldest);
                }
            }
        }
        return result;
    }
}

const MESSAGE_DELETED = Symbol("message-deleted");

function toSendBody(
    content: string | readonly ContentBlock[],
    displayText: string | undefined,
    mode: MessageMode,
): {
    content?: ApiMessageBlock[];
    mode: MessageMode;
    text: string;
} {
    if (typeof content === "string") {
        return { mode, text: displayText ?? content };
    }
    return {
        content: content.map((block) =>
            block.type === "text"
                ? { text: block.text, type: "text" as const }
                : {
                      data: block.data,
                      mimeType: block.mediaType,
                      type: "image" as const,
                  },
        ),
        mode,
        text:
            displayText ??
            content
                .map((block) => (block.type === "text" ? block.text : `[image:${block.mediaType}]`))
                .join(""),
    };
}

/** Sums a run's per-provider usage into the flat shape the TUI accounts with. */
function flattenRunUsage(usage: UsageBreakdown): Usage | undefined {
    const total: Usage = {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
    };
    let observed = false;
    for (const models of Object.values(usage)) {
        for (const counts of Object.values(models)) {
            observed = true;
            total.input += counts.input;
            total.output += counts.output;
            total.cacheRead += counts.cacheRead;
            total.cacheWrite += counts.cacheWrite;
        }
    }
    if (!observed) return undefined;
    total.totalTokens = total.input + total.output;
    return total;
}

/** A failed run's service record rendered as the error it reports, or nothing when empty. */
function toRunErrorMessage(message: ApiMessage): Message | undefined {
    const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
    if (text.length === 0) return undefined;
    return {
        blocks: [{ text, type: "text" }],
        id: message.id,
        outcome: "failed",
        role: "error",
    };
}

function toTerminalMessage(message: ApiMessage): Message {
    if (message.role === "user") {
        return {
            blocks: message.content.flatMap(toTerminalContentBlock),
            id: message.id,
            role: "user",
        };
    }
    if (message.role === "agent") {
        return {
            blocks: message.content.flatMap((block, index) =>
                toTerminalAgentBlocks(message.id, block, index),
            ),
            id: message.id,
            ...(message.metadata.providerId === undefined
                ? {}
                : { providerId: message.metadata.providerId }),
            ...(message.metadata.modelId === undefined
                ? {}
                : { requestedModelId: message.metadata.modelId }),
            role: "agent",
        };
    }
    if (message.role === "service") {
        if (message.content.some((block) => block.type === "compaction")) {
            return {
                blocks: [],
                id: message.id,
                role: "system",
            };
        }
        return {
            blocks: message.content.flatMap(toTerminalContentBlock),
            id: message.id,
            outcome: "failed",
            role: "error",
        };
    }
    return {
        blocks: message.content.flatMap(toTerminalContentBlock),
        id: message.id,
        role: "system",
    };
}

function toTerminalContentBlock(block: ApiMessageBlock): ContentBlock[] {
    if (block.type === "text") return [{ text: block.text, type: "text" }];
    if (block.type === "image") {
        return [{ data: block.data, mediaType: block.mimeType, type: "image" }];
    }
    if (block.type === "reasoning") return [{ text: block.text, type: "text" }];
    return [];
}

function toTerminalAgentBlocks(
    messageId: string,
    block: ApiMessageBlock,
    index: number,
): (ContentBlock | { thinking: string; type: "thinking" } | ToolCallBlock | ToolResultBlock)[] {
    if (block.type === "text") return [{ text: block.text, type: "text" }];
    if (block.type === "image") {
        return [{ data: block.data, mediaType: block.mimeType, type: "image" }];
    }
    if (block.type === "reasoning") return [{ thinking: block.text, type: "thinking" }];
    if (block.type === "compaction") return [];
    const toolCallId = `${messageId}:tool:${String(index)}`;
    const callPresentation = toToolCallPresentation(block);
    const call: ToolCallBlock = {
        arguments: block.arguments ?? {},
        id: toolCallId,
        name: block.name,
        ...(callPresentation === undefined ? {} : { presentation: callPresentation }),
        ...(block.review === undefined
            ? {}
            : { toolPermission: { elevated: block.elevated, review: block.review } }),
        type: "tool_call",
    };
    if (block.status === "running") return [call];
    const resultPresentation = toToolResultPresentation(block);
    const result: ToolResultBlock = {
        display: toolResultText(block),
        ...(block.status === "failed"
            ? { failure: { kind: "execution_failed" as const }, isError: true }
            : {}),
        ...(resultPresentation === undefined ? {} : { presentation: resultPresentation }),
        rendered: [],
        toolCallId,
        toolName: block.name,
        type: "tool_result",
    };
    return [call, result];
}

function toToolCallPresentation(
    block: ApiToolCallBlock,
): ToolCallBlock["presentation"] | undefined {
    const presentation = block.presentation;
    if (presentation?.type === "exploration") {
        return { operations: presentation.operations, type: "exploration" };
    }
    if (presentation?.type === "exec_command") {
        return { command: presentation.command, type: "exec_command" };
    }
    if (presentation?.type === "search") {
        return { query: presentation.query, target: presentation.target, type: "search" };
    }
    return undefined;
}

function toToolResultPresentation(
    block: ApiToolCallBlock,
): ToolResultBlock["presentation"] | undefined {
    const presentation = block.presentation;
    if (presentation?.type === "exploration") {
        return { operations: presentation.operations, type: "exploration" };
    }
    if (presentation?.type === "exec_command") {
        return {
            command: presentation.command,
            output: presentation.output ?? toolResultText(block),
            type: "exec_command",
        };
    }
    if (presentation?.type === "background_terminal_interaction") {
        // Happy Terminal's old renderer used numeric process handles. Do not invent one
        // from the public CUID2; render the command as an ordinary result.
        return {
            command: presentation.command,
            output: presentation.input,
            type: "exec_command",
        };
    }
    if (presentation?.type === "file_diff") {
        return {
            files: presentation.files,
            ...(presentation.omittedFiles === undefined
                ? {}
                : { omittedFiles: presentation.omittedFiles }),
            type: "file_diff",
        };
    }
    if (presentation?.type === "search") {
        return {
            query: presentation.query,
            sources: presentation.sources ?? [],
            target: presentation.target,
            type: "search",
        };
    }
    return undefined;
}

function toolResultText(block: ApiToolCallBlock): string {
    const output = block.result?.output;
    if (typeof output === "string") return output;
    if (block.result === undefined) return block.status === "failed" ? "Tool failed." : "";
    return JSON.stringify(block.result);
}

function belongsToAgent(event: HappyAgentEvent, agentId: string): boolean {
    const payload = event.payload as { agentId?: unknown; agent?: { id?: unknown } };
    return payload.agentId === agentId || payload.agent?.id === agentId;
}

function failedRunMessage(history: MessageHistoryResponse, runId: string): string | undefined {
    const run = history.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return undefined;
    for (const message of run.messages.toReversed()) {
        if (message.role !== "service") continue;
        const text = message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();
        if (text.length > 0) return text;
    }
    return undefined;
}

function toStopReason(run: Run | undefined): StopReason {
    if (run === undefined) return "error";
    if (run.reason === "abort" || run.reason === "steering") return "aborted";
    if (run.reason === "error" || run.status === "failed") return "error";
    return "stop";
}

function preferredServiceTier(
    config: DaemonConfig,
    providerId: string,
    modelId: string,
): string | null {
    const reference = config.providers[providerId]?.models.find((model) => model.id === modelId);
    return (reference?.serviceTiers ?? config.models[modelId]?.serviceTiers ?? [])[0] ?? null;
}
