import { release } from "node:os";

import {
    areProviderModelsCompatible,
    ClaudeProvider,
    type ClaudeAuxiliaryQueryRequest,
    type ClaudeAuxiliaryQueryResponse,
    type BaseProvider,
    type BaseSession,
    type SessionCompaction,
    type SessionContext,
    type SessionMessage,
    type SessionModelConfiguration,
} from "@slopus/rig-providers";

import type { ExecutorEvent } from "@/ExecutorEvent.js";
import type { HostedCapability } from "@/HostedCapability.js";
import type {
    ExecutorModelProfile,
    ExecutorRunRequest,
    ExecutorSelection,
} from "@/ExecutorModelProfile.js";
import type { ExecutorProvider } from "@/ExecutorProvider.js";
import { DEFAULT_IDENTITY, type Identity } from "@/Identity.js";
import {
    createExecutorInferenceStream,
    toRigProviderSessionTools,
} from "@/createExecutorInferenceStream.js";
import { filterProviderCompatibleSessionTools } from "@/filterProviderCompatibleSessionTools.js";
import { reviewerModelForProvider } from "@/reviewerModelForProvider.js";
import { runProviderAuxiliaryText } from "@/runProviderAuxiliaryText.js";
import { toSessionMessages } from "@/toSessionMessages.js";
import type { ExecutorEnvironment } from "@/prompts/ExecutorEnvironment.js";
import { assembleSystemPrompt } from "@/prompts/assembleSystemPrompt.js";
import type {
    AssistantMessage,
    CompactionResult,
    Context,
    InferenceStream,
    Model,
    ProfileProviderType,
    ProfilePromptContext,
    ServiceTier,
    StreamOptions,
} from "@/types.js";

export class Executor {
    readonly environment: ExecutorEnvironment;
    readonly identity: Identity;
    readonly providers: readonly ExecutorProvider[];
    readonly profiles: readonly ExecutorModelProfile[];
    private selectedProviderId: string;
    private active:
        | {
              contextInstructions: string | undefined;
              context: SessionContext;
              profile: ExecutorModelProfile;
              session: BaseSession;
              systemPrompt: string | undefined;
              toolsKey: string;
          }
        | undefined;
    private readonly profilesByKey = new Map<string, ExecutorModelProfile>();
    private readonly providersById = new Map<string, ExecutorProvider>();
    private readonly nativeProviders = new Map<string, Promise<BaseProvider>>();
    private inferencePending: Promise<void> = Promise.resolve();
    private sessionResolutionPending: Promise<void> = Promise.resolve();
    private sessionSequence = 0;
    private forceClosed = false;

    constructor(
        providers: readonly ExecutorProvider[],
        options: { environment?: ExecutorEnvironment; identity?: Identity } = {},
    ) {
        this.environment = options.environment ?? {
            osVersion: release(),
            platform: process.platform,
            primaryWorkingDirectory: process.cwd(),
            shell: process.env.SHELL ?? "",
        };
        this.identity = { ...(options.identity ?? DEFAULT_IDENTITY) };
        this.providers = [...providers];
        for (const provider of providers) {
            if (this.providersById.has(provider.id)) {
                throw new Error(`Executor provider '${provider.id}' is configured more than once.`);
            }
            this.providersById.set(provider.id, provider);
            for (const profile of provider.profiles) {
                if (profile.providerId !== provider.id) {
                    throw new Error(
                        `Model '${profile.id}' belongs to '${profile.providerId}', not '${provider.id}'.`,
                    );
                }
                const key = selectionKey(profile);
                if (this.profilesByKey.has(key)) {
                    throw new Error(
                        `Executor model '${profile.id}' is configured more than once for '${provider.id}'.`,
                    );
                }
                this.profilesByKey.set(key, profile);
            }
        }
        this.profiles = [...this.profilesByKey.values()];
        const primary = providers[0];
        if (primary === undefined) throw new Error("Executor requires at least one provider.");
        this.selectedProviderId = primary.id;
    }

    get id(): string {
        return this.selectedProviderId;
    }

    get models(): readonly Model[] {
        return this.selectedProvider.profiles
            .filter((profile) => profile.hidden !== true)
            .map((profile) => profile.model);
    }

    /** What the selected definition would declare on a request built right now. */
    hostedCapabilitiesForRequest(): readonly HostedCapability[] {
        return this.selectedProvider.hostedCapabilitiesForRequest?.() ?? [];
    }

    get reviewerModel(): Model | undefined {
        return reviewerModelForProvider(this.selectedProvider.profiles);
    }

    get serviceTiers(): readonly ServiceTier[] | undefined {
        return this.selectedProvider.serviceTiers;
    }

    get type(): ProfileProviderType {
        const type = this.selectedProvider.profiles[0]?.providerType;
        if (type === undefined || type === "gym") {
            throw new Error(
                `Executor provider '${this.selectedProviderId}' has no concrete coding-model type.`,
            );
        }
        return type;
    }

    get extendProfilePromptContext():
        | ((context: ProfilePromptContext) => ProfilePromptContext | Promise<ProfilePromptContext>)
        | undefined {
        return this.selectedProvider.extendProfilePromptContext;
    }

    get hasActiveSession(): boolean {
        return this.active !== undefined;
    }

    /**
     * An independent executor over the same providers, credentials, and models.
     *
     * An executor owns one provider session and serializes every inference through it, which is
     * right for the conversation it runs and wrong for work that merely happens alongside it.
     * Titles and permission reviews are their own conversations: they must not reset the session's
     * cached prefix, wait behind its turn, or fail it. They get their own executor instead, with
     * its own session identity so no cache prefix is shared.
     *
     * The provider definitions are borrowed, not owned: their credentials, clients and quota
     * caches belong to this executor, and closing the isolate must leave them running. Only the
     * sessions the isolate opens are its own to tear down.
     */
    isolate(label: string): Executor {
        const isolated = new Executor(
            this.providers.map((provider) => {
                // Each definition decides what it is willing to lend; a capability it runs on its
                // own backend does not travel into work the person never asked for.
                const { destroy: _destroy, ...lent } = provider.isolated?.() ?? provider;
                return { ...lent, sessionId: `${provider.sessionId ?? provider.id}:${label}` };
            }),
            { environment: this.environment, identity: this.identity },
        );
        isolated.selectProvider(this.selectedProviderId);
        return isolated;
    }

    selectProvider(providerId: string): void {
        if (!this.providersById.has(providerId)) {
            throw new Error(`Executor provider '${providerId}' is not configured.`);
        }
        this.selectedProviderId = providerId;
    }

    async systemPrompt(
        selection: ExecutorSelection,
        contextInstructions?: string,
        systemPrompt?: string,
    ): Promise<string> {
        return assembleSystemPrompt({
            ...(contextInstructions === undefined ? {} : { contextInstructions }),
            environment: this.environment,
            identity: this.identity,
            profile: this.profile(selection),
            profiles: this.profiles,
            ...(systemPrompt === undefined ? {} : { systemPrompt }),
        });
    }

    stream(model: Model, context: Context, streamOptions?: StreamOptions): InferenceStream {
        const selection = { modelId: model.id, providerId: this.id };
        this.profile(selection);
        return createExecutorInferenceStream({
            context,
            executor: this,
            model,
            providerId: selection.providerId,
            ...(streamOptions === undefined ? {} : { streamOptions }),
        });
    }

    async runClaudeAuxiliaryQuery(
        model: Model,
        request: ClaudeAuxiliaryQueryRequest,
    ): Promise<ClaudeAuxiliaryQueryResponse> {
        const releaseInference = await this.acquireInference();
        try {
            const profile = this.profile({ modelId: model.id, providerId: this.id });
            const native = await this.resolveNative(this.selectedProvider, profile);
            if (!(native instanceof ClaudeProvider)) {
                if ((request.tools?.length ?? 0) > 0) {
                    throw new Error(
                        `The selected provider '${this.id}' does not support Claude web search.`,
                    );
                }
                return runProviderAuxiliaryText({
                    model: profile.id,
                    native,
                    request,
                });
            }
            return native.runAuxiliaryQuery(profile.id, request);
        } finally {
            releaseInference();
        }
    }

    async *run(request: ExecutorRunRequest): AsyncGenerator<ExecutorEvent> {
        const releaseInference = await this.acquireInference();
        try {
            if (this.forceClosed) throw new Error("The executor is closed.");
            const profile = this.profile(request.selection);
            const resolution = await this.serializeSessionResolution(async () => {
                if (
                    this.active !== undefined &&
                    !areProviderModelsCompatible(
                        toCompatibilitySelection(this.active.profile),
                        toCompatibilitySelection(profile),
                    )
                ) {
                    return {
                        type: "reset_required" as const,
                        current: toSelection(this.active.profile),
                        requested: request.selection,
                        message: `Reset the executor before switching from '${this.active.profile.id}' to incompatible model '${profile.id}'.`,
                    };
                }

                const tools = request.tools ?? [];
                const instructions = assembleSystemPrompt({
                    ...(request.contextInstructions === undefined
                        ? {}
                        : { contextInstructions: request.contextInstructions }),
                    environment: this.environment,
                    identity: this.identity,
                    profile,
                    profiles: this.profiles,
                    ...(request.systemPrompt === undefined
                        ? {}
                        : { systemPrompt: request.systemPrompt }),
                });
                const context = { ...request.context, instructions };
                const active = await this.resolveSession(
                    profile,
                    context,
                    request.contextInstructions,
                    request.systemPrompt,
                    tools,
                );
                active.context = context;
                return active;
            });
            if ("type" in resolution) {
                yield resolution;
                return;
            }

            yield* resolution.session.run({
                ...(request.abort === undefined ? {} : { abort: request.abort }),
                context: { messages: request.context.messages },
                ...(request.effort === undefined ? {} : { effort: request.effort }),
                model: profile.id,
                ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
                ...(request.structuredOutput === undefined
                    ? {}
                    : { structuredOutput: request.structuredOutput }),
            });
        } finally {
            releaseInference();
        }
    }

    async compact(options: {
        context: Context;
        inputTokens?: number;
        instructions?: string;
        model: Model;
        signal?: AbortSignal;
    }): Promise<CompactionResult> {
        const releaseInference = await this.acquireInference();
        try {
            const sourceContext = options.context;
            const profile = this.profile({ modelId: options.model.id, providerId: this.id });
            const active = await this.serializeSessionResolution(async () => {
                if (
                    this.active !== undefined &&
                    areProviderModelsCompatible(
                        toCompatibilitySelection(this.active.profile),
                        toCompatibilitySelection(profile),
                    )
                ) {
                    this.active.profile = profile;
                    return this.active;
                }
                const contextInstructions = sourceContext.systemPrompt ?? "";
                const systemPrompt = sourceContext.systemPromptOverride;
                const tools = toRigProviderSessionTools(sourceContext.tools ?? [], {
                    lockCodexCollaboration:
                        profile.providerType === "codex" && profile.id.startsWith("openai/"),
                });
                const instructions = assembleSystemPrompt({
                    contextInstructions,
                    environment: this.environment,
                    identity: this.identity,
                    profile,
                    profiles: this.profiles,
                    ...(systemPrompt === undefined ? {} : { systemPrompt }),
                });
                const context: SessionContext = {
                    instructions,
                    messages: toSessionMessages(sourceContext.messages),
                };
                const resolved = await this.resolveSession(
                    profile,
                    context,
                    contextInstructions,
                    systemPrompt,
                    tools,
                );
                resolved.context = context;
                return resolved;
            });
            const result = await active.session.compact({
                context: { messages: toSessionMessages(options.context.messages) },
                ...(options.inputTokens === undefined ? {} : { inputTokens: options.inputTokens }),
                ...(options.instructions === undefined
                    ? {}
                    : { instructions: options.instructions }),
                model: profile.id,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            return toExecutionCompactionResult(result, sourceContext);
        } finally {
            releaseInference();
        }
    }

    async reset(selection?: ExecutorSelection): Promise<void> {
        if (selection !== undefined) this.profile(selection);
        const releaseInference = await this.acquireInference();
        try {
            await this.serializeSessionResolution(async () => {
                const active = this.active;
                this.active = undefined;
                if (active !== undefined) await active.session.destroy();
            });
        } finally {
            releaseInference();
        }
    }

    async destroy(): Promise<void> {
        try {
            await this.reset();
        } finally {
            await Promise.all(
                [...this.providersById.values()].map((provider) => provider.destroy?.()),
            );
        }
    }

    async close(): Promise<void> {
        await this.destroy();
    }

    /**
     * Tears down this executor's active provider session without entering its inference queue.
     *
     * Normal reset/close serialization protects conversational state. An isolated bounded query
     * has no future conversational state to preserve, and waiting behind an inference that ignored
     * abort would make its deadline ineffective.
     */
    forceClose(): Promise<void> | void {
        this.forceClosed = true;
        const active = this.active;
        this.active = undefined;
        return active?.session.destroy();
    }

    private profile(selection: ExecutorSelection): ExecutorModelProfile {
        const profile = this.profilesByKey.get(selectionKey(selection));
        if (profile === undefined) {
            throw new Error(
                `Executor model '${selection.modelId}' is not available for provider '${selection.providerId}'.`,
            );
        }
        return profile;
    }

    private async resolveSession(
        profile: ExecutorModelProfile,
        context: SessionContext,
        contextInstructions: string | undefined,
        systemPrompt: string | undefined,
        tools: readonly import("@slopus/rig-providers").SessionTool[],
    ) {
        if (this.forceClosed) throw new Error("The executor is closed.");
        const providerTools = filterProviderCompatibleSessionTools(tools);
        const toolsKey = JSON.stringify(providerTools);
        const provider = this.providersById.get(profile.providerId)!;
        if (
            this.active !== undefined &&
            this.active.profile.providerId === profile.providerId &&
            nativeKey(provider, this.active.profile) === nativeKey(provider, profile) &&
            this.active.contextInstructions === contextInstructions &&
            this.active.systemPrompt === systemPrompt &&
            this.active.toolsKey === toolsKey
        ) {
            this.active.profile = profile;
            return this.active;
        }
        const previous = this.active;
        this.active = undefined;
        if (previous !== undefined) await previous.session.destroy();
        const modelConfigurations: Record<string, SessionModelConfiguration> = {};
        for (const candidate of provider.profiles) {
            const instructions = assembleSystemPrompt({
                ...(contextInstructions === undefined ? {} : { contextInstructions }),
                environment: this.environment,
                identity: this.identity,
                profile: candidate,
                profiles: this.profiles,
                ...(systemPrompt === undefined ? {} : { systemPrompt }),
            });
            // Sessions receive configuration only. The conversation history is owned by the
            // caller and arrives complete with every run, never at session creation.
            modelConfigurations[candidate.id] = { instructions, tools: providerTools };
        }
        const sequence = ++this.sessionSequence;
        const sessionId =
            provider.sessionId === undefined
                ? `executor-${String(sequence)}`
                : sequence === 1
                  ? provider.sessionId
                  : `${provider.sessionId}-reset-${String(sequence)}`;
        const native = await this.resolveNative(provider, profile);
        const session = await native.session(sessionId, {
            instructions: context.instructions,
            modelConfigurations,
            tools: providerTools,
        });
        const resolved = {
            context,
            contextInstructions,
            profile,
            session,
            systemPrompt,
            toolsKey,
        };
        if (this.forceClosed) {
            await session.destroy();
            throw new Error("The executor is closed.");
        }
        return (this.active = resolved);
    }

    private async serializeSessionResolution<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.sessionResolutionPending;
        let release!: () => void;
        this.sessionResolutionPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private async acquireInference(): Promise<() => void> {
        const previous = this.inferencePending;
        let release!: () => void;
        this.inferencePending = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        return release;
    }

    private resolveNative(
        provider: ExecutorProvider,
        profile: ExecutorModelProfile,
    ): Promise<BaseProvider> {
        const key = `${provider.id}\0${nativeKey(provider, profile)}`;
        const existing = this.nativeProviders.get(key);
        if (existing !== undefined) return existing;
        const pending =
            typeof provider.native === "function"
                ? provider.native(profile)
                : Promise.resolve(provider.native);
        this.nativeProviders.set(key, pending);
        void pending.catch(() => {
            if (this.nativeProviders.get(key) === pending) {
                this.nativeProviders.delete(key);
            }
        });
        return pending;
    }

    private get selectedProvider(): ExecutorProvider {
        return this.providersById.get(this.selectedProviderId)!;
    }
}

function nativeKey(provider: ExecutorProvider, profile: ExecutorModelProfile): string {
    return provider.nativeKey?.(profile) ?? provider.id;
}

function selectionKey(selection: ExecutorSelection | ExecutorModelProfile): string {
    const modelId = "modelId" in selection ? selection.modelId : selection.id;
    return `${selection.providerId}\0${modelId}`;
}

function toSelection(profile: ExecutorModelProfile): ExecutorSelection {
    return { modelId: profile.id, providerId: profile.providerId };
}

function toCompatibilitySelection(profile: ExecutorModelProfile) {
    return {
        modelId: profile.id,
        providerId: profile.providerId,
        providerType: profile.providerType,
    };
}

function toExecutionCompactionResult(
    result: SessionCompaction,
    sourceContext: Context,
): CompactionResult {
    const context = {
        ...sourceContext,
        messages: result.context.messages.map((message) =>
            sessionMessageToExecutionMessage(message, latestTimestamp(sourceContext.messages)),
        ),
    };
    if (result.status !== "completed") return { ...result, context };
    return {
        status: "completed",
        context,
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        ...(result.compaction === undefined
            ? {}
            : {
                  compaction: {
                      role: "compaction",
                      content: result.compaction.content,
                      encryptedContent: result.compaction.encryptedContent,
                      ...(result.compaction.vendor === undefined
                          ? {}
                          : { vendor: result.compaction.vendor }),
                      timestamp: latestTimestamp(sourceContext.messages),
                  },
              }),
        usage: result.usage,
    };
}

function sessionMessageToExecutionMessage(
    message: SessionMessage,
    timestamp: number,
): Context["messages"][number] {
    if (message.role === "system") {
        return {
            role: "system",
            content:
                typeof message.content === "string" ? message.content : message.content.join("\n"),
            timestamp,
        };
    }
    if (message.role === "compaction") {
        return {
            role: "compaction",
            content: message.content,
            encryptedContent: message.encryptedContent,
            ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
            timestamp,
        };
    }
    if (message.role === "agent") {
        return {
            role: "user",
            content: "",
            encryptedAgentMessage: {
                author: message.author,
                recipient: message.recipient,
                header: message.header,
                encryptedContent: message.encryptedContent,
            },
            ...(message.agentMessageTriggerTurn === undefined
                ? {}
                : { agentMessageTriggerTurn: message.agentMessageTriggerTurn }),
            timestamp,
        };
    }
    if (message.role === "user") {
        return {
            role: "user",
            content:
                message.input === undefined
                    ? message.content
                    : message.input.map((part) =>
                          part.type === "text"
                              ? { type: "text" as const, text: part.text }
                              : {
                                    type: "image" as const,
                                    data: part.data,
                                    mimeType: part.mimeType,
                                },
                      ),
            timestamp,
        };
    }
    if (message.role === "tool") {
        return {
            role: "toolResult",
            toolCallId: message.callId,
            providerToolCallId: message.callId,
            toolName: "",
            content: message.input?.map((part) =>
                part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                          type: "image" as const,
                          data: part.data,
                          mimeType: part.mimeType,
                      },
            ) ?? [{ type: "text", text: message.content }],
            isError: message.isError === true,
            ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
            sessionMessage: message,
            timestamp,
        };
    }
    const assistant: AssistantMessage = {
        role: "assistant",
        content: [
            ...(message.reasoning ?? []).map((reasoning) => ({
                type: "thinking" as const,
                thinking: reasoning.text,
                ...(reasoning.signature === undefined ? {} : { encrypted: reasoning.signature }),
                ...(reasoning.redacted === undefined ? {} : { redacted: reasoning.redacted }),
            })),
            ...(message.content.length === 0
                ? []
                : [{ type: "text" as const, text: message.content }]),
            ...(message.toolCalls ?? []).map((call) => ({
                type: "toolCall" as const,
                id: call.callId,
                providerToolCallId: call.callId,
                name: call.name,
                ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
                arguments: parseCompactionToolArguments(call.arguments),
                ...(call.incomplete === undefined ? {} : { incomplete: call.incomplete }),
                ...(call.vendor === undefined ? {} : { vendor: call.vendor }),
            })),
        ],
        api: "compaction",
        provider: "compaction",
        model: "compaction",
        ...(message.responseItems === undefined ? {} : { responseItems: message.responseItems }),
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        sessionMessage: message,
        timestamp,
    };
    return assistant;
}

function parseCompactionToolArguments(argumentsJson: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(argumentsJson) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { input: argumentsJson };
    } catch {
        return { input: argumentsJson };
    }
}

function latestTimestamp(messages: readonly Context["messages"][number][]): number {
    if (messages.length === 0) return Date.now();
    return messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0);
}
