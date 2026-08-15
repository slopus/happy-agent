import { createHash } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import {
    AgentKV,
    AgentStorage,
    AgentSystemLocal,
    type Agent,
    type AgentModel,
    type AgentMessageMetadata,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import {
    HistoryFeature,
    ModelSwitchFeature,
    SystemPromptFeature,
} from "@slopus/happy-agent-features";
import type { SessionReasoningEffort, SessionUserMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { SessionDatabase } from "../persistence/database/SessionDatabase.js";
import { withDatabase } from "../persistence/databaseContext.js";
import { runSessionTransaction } from "../session/SessionTransactionContext.js";
import {
    markAgentMessageSubmissionConsumed,
    markAgentMessageSubmissionsSettled,
    pruneAgentMessageSubmissions,
    queryAgentBaseOwedAgentIds,
    queryAgentMessageMarker,
    queryAgentMessageSubmission,
    queryAgentMessageSubmissions,
    recordAgentMessageSubmission,
    type AgentMessageSubmission,
} from "../persistence/agent/agentMessageSubmission.js";
import { querySessionMessageSubmission } from "../persistence/session/querySessionMessageSubmission.js";
import {
    createEventIdFactory,
    agentAcceptedContentSchema,
    agentSubmissionInputSchema,
    agentSubmissionMessageSchema,
    rigMessageMetadataEnvelopeSchema,
    rigMessageMetadataSchema,
    submissionFingerprintSchema,
    type RigMessageMetadata,
    type AgentSubmissionInput,
    type AgentSubmissionMessage,
    type RigMessageMetadataEnvelope,
    type AbortRunOptions,
    type AbortRunResponse,
    type ChangeEffortRequest,
    type ChangeModelRequest,
    type ChangePermissionModeRequest,
    type ChangeServiceTierRequest,
    type ProtocolSession,
    type SessionEvent,
    type SteerMessageRequest,
    type SteerMessageResponse,
    type SubmitMessageRequest,
    type SubmitMessageResponse,
    submitContentBlockSchema,
    submitContentSchema,
} from "../protocol/index.js";
import type { AgentCompactionResult } from "./AgentContracts.js";
import type { ConfigProviders } from "../config/types.js";
import type { ModelCatalog } from "../protocol/index.js";
import { createAgentRuntimeConfig } from "./createAgentRuntimeConfig.js";
import { RigHistoryStore } from "./RigHistoryStore.js";
import {
    RigProtocolFeature,
    type RigAgentConfiguration,
    type RigAgentProtocolSession,
} from "./RigProtocolFeature.js";
import { SqliteAgentPersistence } from "./persistence/SqliteAgentPersistence.js";
import type { ContentBlock, UserMessage } from "./types.js";

const SYSTEM_AGENT_ID = "$system";

const submitMessageCoreSchema = Type.Object(
    {
        clientSubmissionId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        displayText: Type.Optional(Type.String({ maxLength: 262_144 })),
        effort: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        modelId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        providerId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        text: Type.String({ maxLength: 262_144 }),
    },
    { additionalProperties: true },
);

export class RigAgentService {
    readonly #bridge: RigProtocolFeature;
    readonly #models: readonly AgentModel[];
    readonly #system: AgentSystemLocal;
    readonly #database: SessionDatabase;
    readonly #nextEventId = createEventIdFactory();

    static async open(
        ctx: Context,
        options: {
            database: SessionDatabase;
            env?: NodeJS.ProcessEnv;
            modelCatalog: ModelCatalog;
            providers: ConfigProviders;
            resolveInferenceMaxRetries?: () => number;
            resolveSession?: (
                ctx: Context,
                sessionId: string,
            ) => Promise<RigAgentProtocolSession | undefined>;
        },
    ): Promise<RigAgentService> {
        let lockHandedToSystem = false;
        try {
            const systemPersistence = new SqliteAgentPersistence(options.database, SYSTEM_AGENT_ID);
            const storage = new AgentStorage({
                acquireLock: async () => {
                    if (lockHandedToSystem) {
                        throw new Error("The agent database lock is already owned.");
                    }
                    lockHandedToSystem = true;
                    return {
                        release: async () => {
                            lockHandedToSystem = false;
                        },
                    };
                },
                kv: new AgentKV(systemPersistence, "system."),
                persistence: (agentId) => new SqliteAgentPersistence(options.database, agentId),
            });
            const runtime = createAgentRuntimeConfig({
                catalog: options.modelCatalog,
                env: options.env ?? process.env,
                providers: options.providers,
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
            });
            const bridge = new RigProtocolFeature();
            if (options.resolveSession !== undefined) {
                await restoreProtocolRuns(
                    withDatabase(ctx, options.database),
                    bridge,
                    options.resolveSession,
                    options.database,
                );
            }
            const history = new HistoryFeature({
                store: new RigHistoryStore(options.database),
            });
            const modelSwitch = new ModelSwitchFeature({
                history,
                historyTool: "read_agent_history",
            });
            const systemPrompt = new SystemPromptFeature();
            // The bridge is deliberately last: every configurable feature must finish its
            // transactional projection before the protocol event and terminal callbacks can be
            // staged.
            const system = await AgentSystemLocal.create(
                withDatabase(ctx, options.database),
                storage,
                {
                    features: [systemPrompt, history, modelSwitch, bridge],
                    models: runtime.models,
                    provider: runtime.defaultProvider,
                    providers: runtime.providers,
                },
            );
            return new RigAgentService(bridge, runtime.models, system, options.database);
        } catch (error) {
            throw error;
        }
    }

    private constructor(
        bridge: RigProtocolFeature,
        models: readonly AgentModel[],
        system: AgentSystemLocal,
        database: SessionDatabase,
    ) {
        this.#bridge = bridge;
        this.#models = models;
        this.#system = system;
        this.#database = database;
    }

    async submit(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: SubmitMessageRequest,
    ): Promise<SubmitMessageResponse> {
        return await this.#dispatch(ctx, session, request, "run");
    }

    async steer(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: SteerMessageRequest,
    ): Promise<SteerMessageResponse> {
        const agentId = stableAgentId(session.id);
        if (
            request.expectedRunId !== undefined &&
            !this.#bridge.hasPending(agentId, request.expectedRunId)
        ) {
            throw new Error(
                `Cannot steer run '${request.expectedRunId}': the run is no longer active.`,
            );
        }
        const delivery = request.expectedRunId === undefined ? "run" : "steer";
        const result = await this.#dispatch(ctx, session, request, delivery);
        return {
            ...result,
            delivery,
        } as SteerMessageResponse;
    }

    async deliverMessage(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: SubmitMessageRequest,
    ): Promise<SubmitMessageResponse | SteerMessageResponse> {
        const delivery = this.#bridge.hasPending(stableAgentId(session.id)) ? "steer" : "run";
        return await this.#dispatch(ctx, session, request, delivery);
    }

    async compact(ctx: Context, session: RigAgentProtocolSession): Promise<AgentCompactionResult> {
        const agent = await this.#agent(ctx, session.id);
        await this.#system.compact(ctx, agent.id, { await: true });
        // Agent Base deliberately exposes no provider-specific compaction statistics. Keep the
        // established protocol shape while reporting only what this host can prove.
        return {
            compacted: false,
            compactedMessageCount: 0,
            estimatedTokensAfter: 0,
            estimatedTokensBefore: 0,
            retainedMessageCount: 0,
        };
    }

    async changeModel(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: ChangeModelRequest,
    ): Promise<ProtocolSession> {
        const current = session.snapshot();
        const model = request.modelId;
        const provider = this.#resolveProvider(model, request.providerId, current.providerId);
        const selected = this.#selectedModel(provider, model);
        const normalizedEffort =
            request.effort === undefined && current.effort === undefined
                ? undefined
                : normalizeRequestedEffort(request.effort ?? current.effort!);
        if (normalizedEffort !== undefined) this.#assertSupportedEffort(selected, normalizedEffort);
        const serviceTier = current.serviceTier;
        this.#assertSupportedServiceTier(selected, serviceTier);
        return await this.#projectConfiguration(ctx, session, {
            ...(normalizedEffort === undefined ? {} : { effort: normalizedEffort }),
            modelId: model,
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            permissionMode: current.permissionMode,
            providerId: provider,
            ...(serviceTier === undefined ? {} : { serviceTier }),
        });
    }

    async changeEffort(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: ChangeEffortRequest,
    ): Promise<ProtocolSession> {
        const current = session.snapshot();
        const selected = this.#selectedModel(current.providerId, current.modelId);
        const normalizedEffort = normalizeRequestedEffort(request.effort ?? selected.defaultEffort);
        this.#assertSupportedEffort(selected, normalizedEffort);
        return await this.#projectConfiguration(ctx, session, {
            effort: normalizedEffort,
            modelId: current.modelId,
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            permissionMode: current.permissionMode,
            providerId: current.providerId,
            ...(current.serviceTier === undefined ? {} : { serviceTier: current.serviceTier }),
        });
    }

    async changeServiceTier(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: ChangeServiceTierRequest,
    ): Promise<ProtocolSession> {
        const current = session.snapshot();
        const selected = this.#selectedModel(current.providerId, current.modelId);
        if (request.serviceTier === undefined) {
            throw new Error(
                "The service tier clear option is unavailable for Agent Base sessions.",
            );
        }
        this.#assertSupportedServiceTier(selected, request.serviceTier);
        return await this.#projectConfiguration(ctx, session, {
            ...(current.effort === undefined ? {} : { effort: current.effort }),
            modelId: current.modelId,
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            permissionMode: current.permissionMode,
            providerId: current.providerId,
            serviceTier: request.serviceTier,
        });
    }

    async changePermissionMode(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: ChangePermissionModeRequest,
    ): Promise<ProtocolSession> {
        const current = session.snapshot();
        return await this.#projectConfiguration(ctx, session, {
            ...(current.effort === undefined ? {} : { effort: current.effort }),
            modelId: current.modelId,
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            permissionMode: request.permissionMode,
            providerId: current.providerId,
            ...(current.serviceTier === undefined ? {} : { serviceTier: current.serviceTier }),
        });
    }

    async #projectConfiguration(
        ctx: Context,
        session: RigAgentProtocolSession,
        configuration: RigAgentConfiguration,
    ): Promise<ProtocolSession> {
        return await runSessionTransaction(
            withDatabase(ctx, this.#database),
            async (txCtx) => await session.projectAgentConfiguration(txCtx, configuration),
        );
    }

    #resolveProvider(modelId: string, requested: string | undefined, current: string): string {
        const preferred = requested ?? current;
        if (this.#models.some((model) => model.id === modelId && model.providerId === preferred)) {
            return preferred;
        }
        const inferred = this.#models.find((model) => model.id === modelId)?.providerId;
        if (inferred === undefined) {
            throw new Error(`Model '${modelId}' is not available from the selected provider.`);
        }
        if (requested !== undefined && inferred !== requested) {
            throw new Error(`Model '${modelId}' is not available from provider '${requested}'.`);
        }
        return inferred;
    }

    #selectedModel(providerId: string, modelId: string): AgentModel {
        const model = this.#models.find(
            (candidate) => candidate.providerId === providerId && candidate.id === modelId,
        );
        if (model === undefined) {
            throw new Error(`Model '${modelId}' is not available from provider '${providerId}'.`);
        }
        return model;
    }

    #assertSupportedEffort(model: AgentModel, effort: SessionReasoningEffort): void {
        if (!model.effortLevels.includes(effort)) {
            throw new Error(
                `Model '${model.id}' does not support the '${effort}' reasoning effort.`,
            );
        }
    }

    #assertSupportedServiceTier(model: AgentModel, serviceTier: "fast" | undefined): void {
        if (serviceTier !== undefined && !model.serviceTiers?.includes("priority")) {
            throw new Error(`Provider '${model.providerId}' does not support fast inference.`);
        }
    }

    async #dispatch(
        ctx: Context,
        session: RigAgentProtocolSession,
        request: SubmitMessageRequest,
        delivery: "run" | "steer",
    ): Promise<SubmitMessageResponse | SteerMessageResponse> {
        const databaseCtx = withDatabase(ctx, this.#database);
        const snapshot = session.snapshot();
        if (!Value.Check(submitMessageCoreSchema, request)) {
            throw new Error(
                "The message submission contains invalid or oversized text or identity.",
            );
        }
        assertAgentSubmissionOptionsSupported(request);
        const messageId = stableMessageId(request.clientSubmissionId ?? createId());
        const runId =
            delivery === "steer"
                ? ((request as SteerMessageRequest).expectedRunId ?? `run-${messageId}`)
                : `run-${messageId}`;
        const displayText = request.displayText ?? request.text;
        const content = normalizeRequestContent(request);
        const options = messageOptions(this.#models, snapshot, request);
        const { protocolServiceTier, ...agentOptions } = options;
        const hasSelectionOverride =
            request.modelId !== undefined ||
            request.providerId !== undefined ||
            request.effort !== undefined ||
            request.serviceTier !== undefined;
        const message: AgentSubmissionMessage = {
            blocks: content.map((block) =>
                block.type === "image"
                    ? {
                          data: block.data,
                          mediaType: block.mediaType,
                          type: "image" as const,
                      }
                    : { text: block.text, type: "text" as const },
            ),
            id: messageId,
            identity: request.identity ?? null,
            role: "user" as const,
        };
        const agentMessage: AgentSubmissionInput = {
            content: content.map((block) =>
                block.type === "image"
                    ? { data: block.data, mimeType: block.mediaType, type: "image" as const }
                    : { text: block.text, type: "text" as const },
            ),
            role: "user",
        };
        let dispatchSnapshot = snapshot;
        let metadata!: RigMessageMetadataEnvelope;
        let fingerprint!: string;
        const result = await runSessionTransaction(databaseCtx, async (txCtx) => {
            const agent = await this.#agent(txCtx, session.id);
            if (hasSelectionOverride) {
                dispatchSnapshot = await session.projectAgentConfiguration(txCtx, {
                    ...(agentOptions.effort === undefined ? {} : { effort: agentOptions.effort }),
                    modelId: agentOptions.model,
                    ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                    permissionMode: snapshot.permissionMode,
                    providerId: agentOptions.provider,
                    ...(protocolServiceTier === undefined
                        ? {}
                        : { serviceTier: protocolServiceTier }),
                });
            }
            metadata = rigMessageMetadata({
                ...(request.clientSubmissionId === undefined
                    ? {}
                    : { clientSubmissionId: request.clientSubmissionId }),
                delivery,
                displayText,
                ...(dispatchSnapshot.effort === undefined
                    ? {}
                    : { effort: dispatchSnapshot.effort }),
                identity: request.identity ?? null,
                messageId,
                modelId: dispatchSnapshot.modelId,
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                permissionMode: dispatchSnapshot.permissionMode,
                providerId: dispatchSnapshot.providerId,
                runId,
                sessionId: session.id,
                ...(dispatchSnapshot.serviceTier === undefined
                    ? {}
                    : { serviceTier: dispatchSnapshot.serviceTier }),
                text: request.text,
                content,
            });
            const expectedMetadata = readRigMessageMetadata(metadata);
            if (expectedMetadata === undefined) {
                throw new Error("Rig protocol generated invalid message metadata.");
            }
            fingerprint = submissionFingerprint(expectedMetadata);
            const persisted = await queryAgentMessageSubmission(txCtx, agent.id, messageId);
            if (persisted !== undefined) {
                assertPersistedSubmissionMatches(persisted, expectedMetadata);
                const durableEvent =
                    session.events.messageSubmission?.(messageId) ??
                    (await querySessionMessageSubmission(txCtx, session.id, messageId));
                if (durableEvent !== undefined) {
                    assertSubmissionMatches(durableEvent, {
                        content,
                        delivery,
                        displayText,
                        identity: request.identity ?? null,
                        messageId,
                        runId,
                        sessionId: session.id,
                        submissionFingerprint: fingerprint,
                    });
                    return { submitted: durableEvent };
                }
                if (persisted.status !== "queued") {
                    return {
                        submitted: await session.projectUserMessage(txCtx, {
                            delivery,
                            displayText,
                            message,
                            ...(request.mutationId === undefined
                                ? {}
                                : { mutationId: request.mutationId }),
                            runId,
                            submissionFingerprint: fingerprint,
                        }),
                    };
                }
            } else {
                if (await queryAgentMessageMarker(txCtx, agent.id, messageId)) {
                    throw new Error(
                        `Message identity '${messageId}' was already accepted, but its immutable Rig submission receipt is unavailable.`,
                    );
                }
                const retainedEvent =
                    session.events.messageSubmission?.(messageId) ??
                    (await querySessionMessageSubmission(txCtx, session.id, messageId));
                if (retainedEvent !== undefined) {
                    assertSubmissionMatches(retainedEvent, {
                        content,
                        delivery,
                        displayText,
                        identity: request.identity ?? null,
                        messageId,
                        runId,
                        sessionId: session.id,
                        submissionFingerprint: fingerprint,
                        requireFingerprint: true,
                    });
                    return { submitted: retainedEvent };
                }
            }
            const persistedPending =
                persisted !== undefined && this.#bridge.hasPending(agent.id, runId, messageId);
            const protocolRun = this.#bridge.register(agent.id, {
                delivery,
                displayText,
                messageId,
                message,
                metadata,
                modelId: dispatchSnapshot.modelId,
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                providerId: dispatchSnapshot.providerId,
                recordAccepted: (acceptedCtx) =>
                    markAgentMessageSubmissionConsumed(acceptedCtx, agent.id, messageId),
                recordSettled: (settledCtx, settledRunId) =>
                    markAgentMessageSubmissionsSettled(settledCtx, agent.id, settledRunId).then(
                        () => pruneAgentMessageSubmissions(settledCtx, agent.id),
                    ),
                runId,
                session,
                snapshot: dispatchSnapshot,
                submissionFingerprint: fingerprint,
            });
            if (persisted !== undefined) {
                if (!persistedPending) agent.start();
                return { protocolRun };
            }
            try {
                await recordAgentMessageSubmission(txCtx, {
                    agentId: agent.id,
                    createdAtMs: Date.now(),
                    delivery,
                    fingerprint,
                    input: agentMessage,
                    message,
                    messageId,
                    metadata,
                    runId,
                    sessionId: session.id,
                });
                if (delivery === "steer") {
                    await this.#system.steer(txCtx, agent.id, agentMessage, {
                        ...agentOptions,
                        id: messageId,
                        metadata,
                        await: true,
                    });
                } else {
                    await this.#system.send(txCtx, agent.id, agentMessage, {
                        ...agentOptions,
                        id: messageId,
                        metadata,
                        await: true,
                    });
                }
            } catch (error) {
                protocolRun.cancel();
                throw error;
            }
            return { protocolRun };
        });
        if ("submitted" in result) {
            return {
                ...(delivery === "steer" ? { delivery } : {}),
                eventId: result.submitted.id,
                runId: result.submitted.data.runId,
                sessionId: session.id,
            } as SubmitMessageResponse | SteerMessageResponse;
        }
        const submitted = await result.protocolRun.projected();
        return {
            ...(delivery === "steer" ? { delivery } : {}),
            eventId: submitted.id,
            runId,
            sessionId: session.id,
        };
    }

    async abort(
        ctx: Context,
        session: RigAgentProtocolSession,
        options: AbortRunOptions = {},
    ): Promise<AbortRunResponse> {
        const agentId = stableAgentId(session.id);
        if ((await this.#system.config(ctx, agentId)) === undefined) {
            return { aborted: false };
        }
        if (!this.#bridge.hasPending(agentId, options.expectedRunId)) {
            return { aborted: false };
        }
        await this.#system.abort(ctx, agentId);
        const event = await session.events.append(ctx, {
            createdAt: Date.now(),
            data: {
                ...(options.continuePendingSteering === true
                    ? { continuePendingSteering: true as const }
                    : {}),
                ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
                ...(options.expectedRunId === undefined ? {} : { runId: options.expectedRunId }),
            },
            id: this.#nextEventId(),
            sessionId: session.id,
            type: "abort_requested",
        });
        return {
            aborted: true,
            ...(options.continuePendingSteering === true ? { continued: true } : {}),
            eventId: event.id,
        };
    }

    async close(ctx: Context): Promise<void> {
        await this.#system.close(ctx);
    }

    async #agent(ctx: Context, sessionId: string): Promise<Agent> {
        const agentId = stableAgentId(sessionId);
        const existing = await this.#system.config(ctx, agentId);
        if (existing !== undefined) return await this.#system.resolve(ctx, agentId);
        return await this.#system.create(
            ctx,
            { metadata: { rigSessionId: sessionId } },
            { id: agentId },
        );
    }
}

/**
 * Agent Base does not have a durable contract for these legacy per-message options. Reject them
 * before allocating an identity or opening a transaction so callers never receive a receipt for
 * work the runtime could not honor.
 */
export function assertAgentSubmissionOptionsSupported(request: SubmitMessageRequest): void {
    if (request.serviceTier === null) {
        throw new Error(
            "The service tier clear option ('serviceTier: null') is unavailable for Agent Base submissions. Agent Base 0.0.6 cannot clear a prior fast mode.",
        );
    }
    const unsupported =
        request.systemPrompt !== undefined
            ? ["custom system prompt", "systemPrompt"]
            : request.debug !== undefined
              ? ["debug logging", "debug"]
              : request.interactive !== undefined
                ? ["interactive mode", "interactive"]
                : undefined;
    if (unsupported === undefined) return;
    throw new Error(
        `The ${unsupported[0]} option ('${unsupported[1]}') is unavailable for Agent Base submissions.`,
    );
}

function messageOptions(
    models: readonly AgentModel[],
    session: ProtocolSession,
    request: SubmitMessageRequest,
) {
    const model = request.modelId ?? session.modelId;
    const provider =
        request.providerId ??
        (models.some(
            (candidate) => candidate.providerId === session.providerId && candidate.id === model,
        )
            ? session.providerId
            : models.find((candidate) => candidate.id === model)?.providerId);
    const selected = models.find(
        (candidate) => candidate.providerId === provider && candidate.id === model,
    );
    if (provider === undefined || selected === undefined) {
        throw new Error(`Model '${model}' is not available from the selected provider.`);
    }
    const requestedEffort = request.effort ?? session.effort;
    const effort =
        requestedEffort === undefined ? undefined : normalizeRequestedEffort(requestedEffort);
    if (effort !== undefined && !selected.effortLevels.includes(effort)) {
        throw new Error(`Model '${model}' does not support the '${effort}' reasoning effort.`);
    }
    const protocolServiceTier =
        request.serviceTier === null ? undefined : (request.serviceTier ?? session.serviceTier);
    if (protocolServiceTier !== undefined && !selected.serviceTiers?.includes("priority")) {
        throw new Error(`Provider '${provider}' does not support fast inference.`);
    }
    return {
        model,
        permissionMode: session.permissionMode as AgentPermissionMode,
        provider,
        ...(effort === undefined ? {} : { effort }),
        ...(protocolServiceTier === "fast" ? { serviceTier: "priority" as const } : {}),
        ...(protocolServiceTier === undefined ? {} : { protocolServiceTier }),
    };
}

function normalizeRequestedEffort(value: string): SessionReasoningEffort {
    if (value === "ultra") return "max";
    if (
        value === "off" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh" ||
        value === "max"
    ) {
        return value;
    }
    throw new Error(
        `The reasoning effort '${value}' is not supported by Agent Base. Choose a supported effort for the selected model.`,
    );
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
}

type StoredSessionUserMessage = AgentSubmissionInput;

function rigMessageMetadata(input: {
    clientSubmissionId?: string;
    content: readonly ContentBlock[];
    delivery: "run" | "steer";
    displayText: string;
    effort?: string;
    identity: string | null;
    messageId: string;
    modelId: string;
    mutationId?: string;
    permissionMode: string;
    providerId: string;
    runId: string;
    sessionId: string;
    serviceTier?: "fast" | "off";
    text: string;
}): RigMessageMetadataEnvelope {
    const value: RigMessageMetadata = {
        ...(input.clientSubmissionId === undefined
            ? {}
            : { clientSubmissionId: input.clientSubmissionId }),
        content: input.content.map((block) => ({ ...block })),
        delivery: input.delivery,
        displayText: input.displayText,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        identity: input.identity,
        messageId: input.messageId,
        modelId: input.modelId,
        ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
        permissionMode: input.permissionMode,
        providerId: input.providerId,
        runId: input.runId,
        sessionId: input.sessionId,
        ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
        text: input.text,
    };
    if (!Value.Check(rigMessageMetadataSchema, value)) {
        throw new Error("Rig message metadata is invalid or exceeds its persistence bounds.");
    }
    return { rig: value };
}

function readRigMessageMetadata(value: unknown): RigMessageMetadata | undefined {
    if (!Value.Check(rigMessageMetadataEnvelopeSchema, value)) return undefined;
    return value.rig;
}

function stableMessageId(identity: string): string {
    if (/^[a-z][a-z0-9]{1,31}$/.test(identity)) return identity;
    return `c${createHash("sha256").update(identity).digest("hex").slice(0, 31)}`;
}

function stableAgentId(sessionId: string): string {
    return /^[a-z][a-z0-9]{1,31}$/.test(sessionId)
        ? sessionId
        : stableMessageId(`agent:${sessionId}`);
}

function normalizeRequestContent(request: SubmitMessageRequest): readonly ContentBlock[] {
    const content = request.content ?? [{ text: request.text, type: "text" as const }];
    if (!Value.Check(submitContentSchema, content)) {
        throw new Error(
            "Message content is invalid or contains an unsupported block; only text and image blocks are supported.",
        );
    }
    if (content.some((block) => block.type === "image" && block.detail !== undefined)) {
        throw new Error(
            "Image detail is not supported by Agent Base 0.0.6; omit detail and retry the image.",
        );
    }
    const accepted = content.map((block) =>
        block.type === "image"
            ? { data: block.data, mediaType: block.mediaType, type: "image" as const }
            : { text: block.text, type: "text" as const },
    );
    if (!Value.Check(agentAcceptedContentSchema, accepted)) {
        throw new Error("Message content exceeds the Agent Base persistence bounds.");
    }
    return accepted;
}

function assertSubmissionMatches(
    event: Extract<SessionEvent, { type: "message_submitted" }>,
    expected: {
        content: readonly ContentBlock[];
        delivery: "run" | "steer";
        displayText: string;
        identity: string | null;
        messageId: string;
        runId: string;
        sessionId: string;
        submissionFingerprint: string;
        requireFingerprint?: boolean;
    },
): void {
    const actualDelivery = event.data.delivery ?? "run";
    const actualText = event.data.displayText;
    const actualIdentity = event.data.message.identity ?? null;
    const actualFingerprint = event.data.submissionFingerprint;
    if (
        event.sessionId !== expected.sessionId ||
        event.data.message.id !== expected.messageId ||
        event.data.runId !== expected.runId ||
        actualDelivery !== expected.delivery ||
        actualText !== expected.displayText ||
        actualIdentity !== expected.identity ||
        stableJson(event.data.message.blocks) !== stableJson(expected.content) ||
        (actualFingerprint !== undefined &&
            !Value.Check(submissionFingerprintSchema, actualFingerprint)) ||
        (expected.requireFingerprint
            ? actualFingerprint !== expected.submissionFingerprint
            : actualFingerprint !== undefined &&
              actualFingerprint !== expected.submissionFingerprint)
    ) {
        throw new Error(
            `Message identity '${expected.messageId}' was already used for a different submission.`,
        );
    }
}

function assertPersistedSubmissionMatches(
    actual: AgentMessageSubmission,
    expected: RigMessageMetadata,
): void {
    const metadata = readRigMessageMetadata(actual.metadata);
    if (metadata !== undefined) {
        const message = readStoredUserMessage(actual.message, actual.messageId);
        const agentMessage = readStoredSessionUserMessage(actual.input);
        assertRestoreEnvelope(actual, metadata, message, agentMessage);
    }
    if (
        metadata === undefined ||
        actual.fingerprint !== submissionFingerprint(expected) ||
        submissionFingerprint(metadata) !== submissionFingerprint(expected) ||
        actual.agentId.length === 0 ||
        actual.messageId !== expected.messageId ||
        actual.runId !== expected.runId ||
        actual.sessionId !== expected.sessionId ||
        actual.delivery !== expected.delivery
    ) {
        throw new Error(
            `Message identity '${expected.messageId}' was already used for a different submission.`,
        );
    }
}

async function restoreProtocolRuns(
    ctx: Context,
    bridge: RigProtocolFeature,
    resolveSession: (
        ctx: Context,
        sessionId: string,
    ) => Promise<RigAgentProtocolSession | undefined>,
    database: SessionDatabase,
): Promise<void> {
    let afterAgentId: string | undefined;
    for (;;) {
        const agentIds = await queryAgentBaseOwedAgentIds(ctx, {
            limit: 256,
            ...(afterAgentId === undefined ? {} : { afterAgentId }),
        });
        if (agentIds.length === 0) return;
        for (const agentId of agentIds) {
            let afterCreatedAtMs: number | undefined;
            let afterMessageId: string | undefined;
            let restored = 0;
            for (;;) {
                const page = await queryAgentMessageSubmissions(ctx, {
                    agentId,
                    limit: 256,
                    ...(afterCreatedAtMs === undefined || afterMessageId === undefined
                        ? {}
                        : { afterCreatedAtMs, afterMessageId }),
                });
                if (page.messages.length === 0 && restored === 0) {
                    throw new Error(
                        `Agent '${agentId}' owes work but has no indexed Rig message submission receipts.`,
                    );
                }
                for (const candidate of page.messages) {
                    const metadata = readRigMessageMetadata(candidate.metadata);
                    if (metadata === undefined) {
                        throw new Error(
                            `Agent message '${candidate.messageId}' has missing or invalid Rig metadata.`,
                        );
                    }
                    const message = readStoredUserMessage(candidate.message, candidate.messageId);
                    const agentMessage = readStoredSessionUserMessage(candidate.input);
                    assertRestoreEnvelope(candidate, metadata, message, agentMessage);
                    const session = await resolveSession(ctx, metadata.sessionId);
                    if (session === undefined) {
                        throw new Error(
                            `The session '${metadata.sessionId}' for owed Agent message '${candidate.messageId}' could not be restored.`,
                        );
                    }
                    let projectedEvent =
                        session.events.messageSubmission?.(candidate.messageId) ??
                        (await querySessionMessageSubmission(ctx, session.id, candidate.messageId));
                    if (projectedEvent !== undefined) {
                        assertSubmissionMatches(projectedEvent, {
                            content: metadata.content,
                            delivery: metadata.delivery,
                            displayText: metadata.displayText,
                            identity: metadata.identity,
                            messageId: candidate.messageId,
                            runId: metadata.runId,
                            sessionId: session.id,
                            submissionFingerprint: submissionFingerprint(metadata),
                        });
                    } else if (candidate.status !== "queued") {
                        projectedEvent = await runSessionTransaction(
                            withDatabase(ctx, database),
                            async (txCtx) =>
                                await session.projectUserMessage(txCtx, {
                                    delivery: metadata.delivery,
                                    displayText: metadata.displayText,
                                    message,
                                    ...(metadata.mutationId === undefined
                                        ? {}
                                        : { mutationId: metadata.mutationId }),
                                    runId: metadata.runId,
                                    submissionFingerprint: submissionFingerprint(metadata),
                                }),
                        );
                    }
                    const snapshot = session.snapshot();
                    bridge.register(agentId, {
                        delivery: metadata.delivery,
                        displayText: metadata.displayText,
                        messageId: candidate.messageId,
                        message,
                        metadata: { rig: metadata },
                        modelId: metadata.modelId,
                        ...(metadata.mutationId === undefined
                            ? {}
                            : { mutationId: metadata.mutationId }),
                        ...(projectedEvent === undefined ? {} : { projectedEvent }),
                        providerId: metadata.providerId,
                        recordAccepted: (acceptedCtx) =>
                            markAgentMessageSubmissionConsumed(
                                acceptedCtx,
                                agentId,
                                candidate.messageId,
                            ),
                        recordSettled: (settledCtx, runId) =>
                            markAgentMessageSubmissionsSettled(settledCtx, agentId, runId).then(
                                () => pruneAgentMessageSubmissions(settledCtx, agentId),
                            ),
                        runId: metadata.runId,
                        session,
                        snapshot,
                        submissionFingerprint: submissionFingerprint(metadata),
                    });
                    restored += 1;
                }
                if (
                    page.messages.length < 256 ||
                    page.nextCreatedAtMs === undefined ||
                    page.nextMessageId === undefined
                ) {
                    break;
                }
                afterCreatedAtMs = page.nextCreatedAtMs;
                afterMessageId = page.nextMessageId;
            }
        }
        if (agentIds.length < 256) return;
        afterAgentId = agentIds.at(-1);
        if (afterAgentId === undefined) return;
    }
}

function submissionFingerprint(metadata: RigMessageMetadata): string {
    const fingerprint = createHash("sha256").update(stableJson(metadata)).digest("hex");
    if (!Value.Check(submissionFingerprintSchema, fingerprint)) {
        throw new Error("Rig generated an invalid submission fingerprint.");
    }
    return fingerprint;
}

function readStoredUserMessage(value: unknown, messageId: string): UserMessage {
    if (!Value.Check(agentSubmissionMessageSchema, value)) {
        throw new Error(`Agent message '${messageId}' has invalid projected user content.`);
    }
    return value as UserMessage;
}

function readStoredSessionUserMessage(value: unknown): StoredSessionUserMessage {
    if (!Value.Check(agentSubmissionInputSchema, value)) {
        throw new Error("An Agent submission receipt has invalid provider input content.");
    }
    return value as StoredSessionUserMessage;
}

function assertRestoreEnvelope(
    submission: AgentMessageSubmission,
    metadata: RigMessageMetadata,
    message: UserMessage,
    agentMessage: StoredSessionUserMessage,
): void {
    const expectedMessage: UserMessage = {
        blocks: metadata.content.map((block) => ({ ...block })),
        id: metadata.messageId,
        identity: metadata.identity,
        role: "user",
    };
    const expectedInput = toStoredSessionUserMessage(metadata.content);
    if (
        submission.agentId.length === 0 ||
        submission.messageId !== metadata.messageId ||
        submission.runId !== metadata.runId ||
        submission.sessionId !== metadata.sessionId ||
        submission.delivery !== metadata.delivery ||
        submission.fingerprint !== submissionFingerprint(metadata) ||
        stableJson(message) !== stableJson(expectedMessage) ||
        stableJson(agentMessage) !== stableJson(expectedInput)
    ) {
        throw new Error(
            `Agent message '${submission.messageId}' has inconsistent persisted identity or content.`,
        );
    }
}

function toStoredSessionUserMessage(content: readonly ContentBlock[]): StoredSessionUserMessage {
    return {
        content: content.map((block) =>
            block.type === "image"
                ? { data: block.data, mimeType: block.mediaType, type: "image" as const }
                : { text: block.text, type: "text" as const },
        ),
        role: "user",
    };
}
