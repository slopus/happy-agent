import { createId } from "@paralleldrive/cuid2";
import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentFeature,
    AgentFeatureScope,
    AgentMessageMetadata,
} from "@slopus/happy-agent-base";
import type { SessionEvent as ProviderSessionEvent, SessionUsage } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type {
    AgentEventAssistantContent,
    AgentEventAssistantMessage,
    AgentLoopEvent,
} from "./AgentLoopEvent.js";
import type { AgentMessage, Message, ToolCallBlock, UserMessage } from "./types.js";
import type { StopReason } from "../protocol/InferenceProtocol.js";
import {
    createEventIdFactory,
    protocolAgentBlockSchema,
    protocolAgentBlockWithinBounds,
    protocolErrorMessageSchema,
    protocolJsonSchema,
    protocolJsonWithinByteLimit,
    rigMessageMetadataEnvelopeSchema,
    type ProtocolSession,
    type SessionEvent,
} from "../protocol/index.js";

/**
 * The effective host-side selection projected into Rig's protocol session.
 *
 * Agent Base applies selection values when a queued message is consumed. The
 * protocol projection records the host's promised "this and subsequent runs"
 * selection immediately, without reaching into the legacy runtime.
 */
export interface RigAgentConfiguration {
    readonly effort?: string;
    readonly modelId: string;
    readonly mutationId?: string;
    readonly permissionMode: string;
    readonly providerId: string;
    readonly serviceTier?: "fast";
}

export interface RigAgentProtocolSession {
    afterProtocolCommit(ctx: Context, callback: () => void | Promise<void>): Promise<void>;
    readonly events: {
        append(ctx: Context, event: SessionEvent): Promise<SessionEvent>;
        messageSubmission?(
            messageId: string,
        ): Extract<SessionEvent, { type: "message_submitted" }> | undefined;
    };
    readonly id: string;
    projectProtocolEvent(ctx: Context, event: SessionEvent): Promise<SessionEvent>;
    projectAgentMessage(ctx: Context, runId: string, message: Message): Promise<SessionEvent>;
    projectAgentConfiguration(
        ctx: Context,
        configuration: RigAgentConfiguration,
    ): Promise<ProtocolSession>;
    projectUserMessage(
        ctx: Context,
        input: {
            delivery: "run" | "steer";
            displayText: string;
            message: UserMessage;
            mutationId?: string;
            runId: string;
            submissionFingerprint?: string;
        },
    ): Promise<Extract<SessionEvent, { type: "message_submitted" }>>;
    publishAgentLiveEvent(ctx: Context, event: SessionEvent): void;
    snapshot(): ProtocolSession;
}

interface PendingInference {
    readonly content: AgentEventAssistantContent[];
    currentIndex?: number;
    iteration: number;
    readonly messageId: string;
    nextIndex: number;
    usage?: SessionUsage;
    readonly toolCallIndexes: Map<string, number>;
    readonly toolCalls: Map<string, ToolCallBlock>;
}

const pendingBlocksSchema = Type.Array(protocolAgentBlockSchema, { maxItems: 2_048 });
const runIdSchema = Type.String({ maxLength: 256, minLength: 1 });
type PendingAgentBlock = Static<typeof protocolAgentBlockSchema>;
const acceptedMetadataSchema = rigMessageMetadataEnvelopeSchema;

const PENDING_BLOCKS_KEY = "pending_blocks";
const MESSAGE_PROJECTION_KEY_PREFIX = "message_projection.";

interface PendingProtocolRun {
    readonly accepted: Promise<void>;
    cancelled: boolean;
    readonly delivery: "run" | "steer";
    inference?: PendingInference;
    iteration: number;
    readonly messageId: string;
    readonly metadata?: AgentMessageMetadata;
    messageConsumed: boolean;
    messageNotified: boolean;
    readonly modelId: string;
    outcome?: {
        errorMessage?: string;
        stopReason: Extract<StopReason, "aborted" | "error" | "length" | "stop" | "toolUse">;
    };
    projectionError?: unknown;
    projectedEvent?: SessionEvent;
    readonly projectionInput: {
        delivery: "run" | "steer";
        displayText: string;
        message: UserMessage;
        mutationId?: string;
        runId: string;
        submissionFingerprint?: string;
    };
    readonly projection: Promise<SessionEvent>;
    readonly recordProjection:
        | ((
              ctx: Context,
              event: Extract<SessionEvent, { type: "message_submitted" }>,
          ) => Promise<void>)
        | undefined;
    readonly providerId: string;
    readonly recordAccepted: ((ctx: Context) => Promise<void>) | undefined;
    readonly recordSettled: ((ctx: Context, runId: string) => Promise<void>) | undefined;
    readonly resolveAccepted: () => void;
    readonly resolveProjected: (event: SessionEvent) => void;
    readonly runId: string;
    readonly session: RigAgentProtocolSession;
    readonly snapshot: ProtocolSession;
    started: boolean;
    tail: Promise<void>;
    terminalEvent?: Extract<SessionEvent, { type: "run_error" | "run_finished" }>;
    terminalProjected: boolean;
}

export interface PendingProtocolRunRegistration {
    cancel(): void;
    projected(): Promise<SessionEvent>;
}

/**
 * Projects Agent Base's provider stream into Rig's stable session protocol.
 *
 * Agent Base owns the conversation and inference lifecycle. This feature owns only the external
 * projection: live inference events, durable transcript messages, and the terminal run boundary.
 */
export class RigProtocolFeature implements AgentFeature {
    readonly name = "rig-protocol";
    readonly #nextEventId = createEventIdFactory();
    readonly #active = new Map<string, PendingProtocolRun>();
    readonly #pending = new Map<string, PendingProtocolRun[]>();

    register(
        agentId: string,
        input: {
            delivery: "run" | "steer";
            displayText: string;
            messageId: string;
            message: UserMessage;
            metadata?: AgentMessageMetadata;
            modelId: string;
            mutationId?: string;
            projectedEvent?: Extract<SessionEvent, { type: "message_submitted" }>;
            providerId: string;
            runId: string;
            recordProjection?: (
                ctx: Context,
                event: Extract<SessionEvent, { type: "message_submitted" }>,
            ) => Promise<void>;
            recordAccepted?: (ctx: Context) => Promise<void>;
            recordSettled?: (ctx: Context, runId: string) => Promise<void>;
            session: RigAgentProtocolSession;
            snapshot: ProtocolSession;
            submissionFingerprint?: string;
        },
    ): PendingProtocolRunRegistration {
        const existing = this.#pending
            .get(agentId)
            ?.find((candidate) => !candidate.cancelled && candidate.messageId === input.messageId);
        if (existing !== undefined) {
            return {
                cancel: () => {
                    existing.cancelled = true;
                    existing.resolveAccepted();
                },
                projected: () => existing.projection,
            };
        }
        let resolveAccepted!: () => void;
        const accepted = new Promise<void>((resolve) => {
            resolveAccepted = resolve;
        });
        let resolveProjected!: (event: SessionEvent) => void;
        const projected = new Promise<SessionEvent>((resolve) => {
            resolveProjected = resolve;
        });
        const pending: PendingProtocolRun = {
            ...input,
            accepted,
            cancelled: false,
            iteration: 0,
            messageConsumed: false,
            messageNotified: false,
            projectionInput: {
                delivery: input.delivery,
                displayText: input.displayText,
                message: input.message,
                ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
                runId: input.runId,
                ...(input.submissionFingerprint === undefined
                    ? {}
                    : { submissionFingerprint: input.submissionFingerprint }),
            },
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            projection: projected,
            recordProjection: input.recordProjection,
            recordAccepted: input.recordAccepted,
            recordSettled: input.recordSettled,
            resolveAccepted,
            resolveProjected,
            ...(input.projectedEvent === undefined ? {} : { projectedEvent: input.projectedEvent }),
            started: input.projectedEvent !== undefined,
            tail: Promise.resolve(),
            terminalProjected: false,
        };
        if (input.projectedEvent !== undefined) {
            pending.messageConsumed = true;
            pending.messageNotified = true;
            resolveAccepted();
            resolveProjected(input.projectedEvent);
            this.#active.set(agentId, pending);
        }
        const runs = this.#pending.get(agentId);
        if (runs === undefined) this.#pending.set(agentId, [pending]);
        else runs.push(pending);
        return {
            cancel: () => {
                pending.cancelled = true;
                resolveAccepted();
            },
            projected: () => projected,
        };
    }

    hasPending(agentId: string, runId?: string, messageId?: string): boolean {
        return (
            this.#pending
                .get(agentId)
                ?.some(
                    (run) =>
                        !run.cancelled &&
                        (runId === undefined || run.runId === runId) &&
                        (messageId === undefined || run.messageId === messageId),
                ) ?? false
        );
    }

    readonly beforeInference = async (ctx: Context, scope: AgentFeatureScope): Promise<void> => {
        const run = this.#activeRun(scope.agent.id);
        if (run === undefined) return;
        await run.accepted;
        if (run.cancelled) return;
        if (!run.started) {
            const existingStarted =
                this.#pending
                    .get(scope.agent.id)
                    ?.some(
                        (candidate) =>
                            candidate !== run && candidate.runId === run.runId && candidate.started,
                    ) === true;
            run.started = true;
            if (!existingStarted) {
                this.#enqueue(run, () =>
                    this.#append(ctx, run, {
                        createdAt: Date.now(),
                        data: { runId: run.runId },
                        id: this.#nextEventId(),
                        sessionId: run.session.id,
                        type: "run_started",
                    }),
                );
            }
        }
        const inference: PendingInference = {
            content: [],
            iteration: ++run.iteration,
            messageId: createId(),
            nextIndex: 0,
            toolCallIndexes: new Map(),
            toolCalls: new Map(),
        };
        run.inference = inference;
        this.#enqueueAgentEvent(ctx, run, {
            iteration: inference.iteration,
            messageId: inference.messageId,
            type: "inference_iteration_start",
        });
        await this.#drain(run);
    };

    readonly messageAcceptedTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        const run = this.#pending
            .get(scope.agent.id)
            ?.find(
                (candidate) =>
                    !candidate.cancelled &&
                    candidate.messageId === accepted.id &&
                    !candidate.messageConsumed,
            );
        if (run === undefined) return;
        validateAcceptedMetadata(run, accepted);
        const key = messageProjectionKey(run.messageId);
        const staged = await scope.runKV.read(ctx, key);
        if (Value.Check(runIdSchema, staged) && staged === run.runId) return;
        await scope.runKV.write(ctx, key, run.runId);
        await run.recordAccepted?.(ctx);
        const event = await run.session.projectUserMessage(ctx, run.projectionInput);
        await run.recordProjection?.(ctx, event);
        await run.session.afterProtocolCommit(ctx, () => {
            if (run.cancelled || run.messageConsumed) {
                return;
            }
            run.messageConsumed = true;
            run.projectedEvent = event;
            this.#active.set(scope.agent.id, run);
            run.resolveProjected(event);
            run.resolveAccepted();
        });
    };

    readonly messageAccepted = async (
        ctx: Context,
        scope: AgentFeatureScope,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        const run = this.#pending
            .get(scope.agent.id)
            ?.find(
                (candidate) =>
                    !candidate.cancelled &&
                    candidate.messageId === accepted.id &&
                    candidate.messageConsumed &&
                    !candidate.messageNotified &&
                    candidate.projectedEvent !== undefined,
            );
        if (run?.projectedEvent === undefined) return;
        run.messageNotified = true;
        this.#active.set(scope.agent.id, run);
        if (run.cancelled || run.delivery !== "steer") return;
        this.#enqueue(run, () =>
            this.#append(ctx, run, {
                createdAt: Date.now(),
                data: { messageIds: [run.messageId], runId: run.runId },
                id: this.#nextEventId(),
                sessionId: run.session.id,
                type: "steering_applied",
            }),
        );
        await this.#drain(run);
    };

    readonly onEvent = async (
        ctx: Context,
        scope: AgentFeatureScope,
        event: ProviderSessionEvent,
    ): Promise<void> => {
        const run = this.#activeRun(scope.agent.id);
        const inference = run?.inference;
        if (run === undefined || inference === undefined || run.cancelled) return;

        if (event.type === "token_usage") {
            inference.usage = event.usage;
            return;
        }
        if (event.type === "done") {
            if (event.state === "error") {
                run.outcome = {
                    errorMessage: Value.Check(protocolErrorMessageSchema, event.message)
                        ? event.message
                        : "The model response failed.",
                    stopReason: "error",
                };
            } else {
                run.outcome = {
                    stopReason:
                        event.state === "cancelled"
                            ? "aborted"
                            : event.state === "length"
                              ? "length"
                              : event.state === "tool_call"
                                ? "toolUse"
                                : "stop",
                };
            }
            return;
        }

        const mapped = mapLiveEvent(event, inference, run);
        if (mapped !== undefined) this.#publishAgentEvent(ctx, run, mapped);
    };

    readonly onEventTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        event: AgentBasePersistedEvent,
    ): Promise<void> => {
        const inference = this.#activeRun(scope.agent.id)?.inference;
        if (inference === undefined) return;
        const blocks = await readPendingBlocks(ctx, scope);
        const block = toAgentBlock(event, inference);
        if (!protocolAgentBlockWithinBounds(block)) {
            throw new Error("Rig protocol received an unbounded persisted agent block.");
        }
        const next = [...blocks, block];
        if (!Value.Check(pendingBlocksSchema, next) || !protocolJsonWithinByteLimit(next)) {
            throw new Error("Rig protocol pending agent blocks exceed their persistence bound.");
        }
        await scope.runKV.write(ctx, PENDING_BLOCKS_KEY, next);
    };

    readonly afterInferenceTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        result: AgentBaseInference,
    ): Promise<void> => {
        const run = this.#activeRun(scope.agent.id);
        const inference = run?.inference;
        if (run === undefined || inference === undefined || run.cancelled) return;
        const blocks = await readPendingBlocks(ctx, scope);
        if (blocks.length > 0) {
            const message: AgentMessage = {
                blocks,
                ...(result.tokens === undefined
                    ? {}
                    : { contextTokens: result.tokens.input + result.tokens.output }),
                id: inference.messageId,
                providerId: run.providerId,
                requestedModelId: run.modelId,
                role: "agent",
                usage: toRigUsage(inference.usage, result),
            };
            await run.session.projectAgentMessage(ctx, run.runId, message);
        }
        if (result.errorMessage !== undefined) {
            const errorText = Value.Check(protocolErrorMessageSchema, result.errorMessage)
                ? result.errorMessage
                : "The model response failed.";
            const errorMessage: Message = {
                blocks: [{ text: errorText, type: "text" }],
                id: createId(),
                outcome: "failed",
                providerId: run.providerId,
                requestedModelId: run.modelId,
                role: "error",
            };
            await run.session.projectAgentMessage(ctx, run.runId, errorMessage);
        }
        await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
    };

    readonly afterInference = async (
        _ctx: Context,
        scope: AgentFeatureScope,
        _result: AgentBaseInference,
    ): Promise<void> => {
        const run = this.#activeRun(scope.agent.id);
        if (run === undefined || run.cancelled) return;
        await this.#drain(run);
        delete run.inference;
    };

    readonly afterAgentSettledTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<void> => {
        const pending = this.#pending.get(scope.agent.id);
        if (pending === undefined) return;
        const terminalRuns = new Map<string, PendingProtocolRun[]>();
        for (const run of pending) {
            if (run.cancelled) continue;
            const runs = terminalRuns.get(run.runId);
            if (runs === undefined) terminalRuns.set(run.runId, [run]);
            else runs.push(run);
        }
        for (const runs of terminalRuns.values()) {
            // A steer can be accepted into the original run before settlement. The final accepted
            // candidate owns the terminal provider/model metadata and snapshot.
            const run = runs.at(-1);
            if (run === undefined) continue;
            const terminalEvent = run.terminalEvent ?? this.#terminalEvent(run);
            for (const candidate of runs) candidate.terminalEvent = terminalEvent;
            await run.recordSettled?.(ctx, run.runId);
            await this.#append(ctx, run, terminalEvent);
            await run.session.afterProtocolCommit(ctx, () => {
                for (const candidate of runs) candidate.terminalProjected = true;
            });
        }
    };

    readonly afterAgentSettled = async (_ctx: Context, scope: AgentFeatureScope): Promise<void> => {
        const pending = this.#pending.get(scope.agent.id) ?? [];
        const remaining = pending.filter((run) => !run.cancelled && !run.terminalProjected);
        if (remaining.length === 0) {
            this.#pending.delete(scope.agent.id);
            this.#active.delete(scope.agent.id);
            return;
        }
        this.#pending.set(scope.agent.id, remaining);
        this.#active.set(scope.agent.id, remaining[remaining.length - 1]!);
    };

    /** Wait for a submission's projection when a retry races its first request. */
    async projected(
        agentId: string,
        runId: string,
        messageId?: string,
    ): Promise<Extract<SessionEvent, { type: "message_submitted" }> | undefined> {
        const run = this.#pending
            .get(agentId)
            ?.find(
                (candidate) =>
                    candidate.runId === runId &&
                    (messageId === undefined || candidate.messageId === messageId),
            );
        if (run === undefined || run.cancelled) return undefined;
        const event = await run.projection;
        return event.type === "message_submitted" ? event : undefined;
    }

    #activeRun(agentId: string): PendingProtocolRun | undefined {
        return (
            this.#active.get(agentId) ?? this.#pending.get(agentId)?.find((run) => !run.cancelled)
        );
    }

    #enqueueAgentEvent(ctx: Context, run: PendingProtocolRun, event: AgentLoopEvent): void {
        this.#enqueue(run, () =>
            this.#append(ctx, run, {
                createdAt: Date.now(),
                data: { event, runId: run.runId },
                id: this.#nextEventId(),
                sessionId: run.session.id,
                type: "agent_event",
            }),
        );
    }

    #enqueue(run: PendingProtocolRun, operation: () => Promise<unknown>): void {
        const next = run.tail.then(async () => {
            await operation();
        });
        run.tail = next.catch((error: unknown) => {
            run.projectionError ??= error;
        });
    }

    async #drain(run: PendingProtocolRun): Promise<void> {
        await run.tail;
        if (run.projectionError !== undefined) throw run.projectionError;
    }

    async #append(ctx: Context, run: PendingProtocolRun, event: SessionEvent): Promise<void> {
        await run.session.projectProtocolEvent(ctx, event);
    }

    #publishAgentEvent(ctx: Context, run: PendingProtocolRun, event: AgentLoopEvent): void {
        run.session.publishAgentLiveEvent(ctx, {
            createdAt: Date.now(),
            data: { event, runId: run.runId },
            id: this.#nextEventId(),
            sessionId: run.session.id,
            type: "agent_event",
        });
    }

    #terminalEvent(
        run: PendingProtocolRun,
    ): Extract<SessionEvent, { type: "run_error" | "run_finished" }> {
        const outcome = run.outcome ?? { stopReason: "stop" as const };
        if (outcome.stopReason === "error") {
            return {
                createdAt: Date.now(),
                data: {
                    errorMessage: outcome.errorMessage ?? "The model response failed.",
                    modelLocked: run.snapshot.modelLocked,
                    providerId: run.providerId,
                    requestedModelId: run.modelId,
                    runId: run.runId,
                },
                id: this.#nextEventId(),
                sessionId: run.session.id,
                type: "run_error",
            };
        }
        return {
            createdAt: Date.now(),
            data: {
                modelLocked: run.snapshot.modelLocked,
                providerId: run.providerId,
                requestedModelId: run.modelId,
                runId: run.runId,
                stopReason: outcome.stopReason,
            },
            id: this.#nextEventId(),
            sessionId: run.session.id,
            type: "run_finished",
        };
    }
}

function mapLiveEvent(
    event: Exclude<ProviderSessionEvent, { type: "done" } | { type: "token_usage" }>,
    inference: PendingInference,
    run: PendingProtocolRun,
): AgentLoopEvent | undefined {
    const messageId = inference.messageId;
    if (event.type === "text_start") {
        const contentIndex = inference.nextIndex++;
        inference.currentIndex = contentIndex;
        inference.content[contentIndex] = { type: "text", text: "" };
        return { contentIndex, messageId, partial: partial(inference, run), type: "text_start" };
    }
    if (event.type === "text_delta") {
        const contentIndex = inference.currentIndex;
        if (contentIndex === undefined) return undefined;
        const current = inference.content[contentIndex];
        if (current?.type !== "text") return undefined;
        inference.content[contentIndex] = { ...current, text: current.text + event.delta };
        return {
            contentIndex,
            delta: event.delta,
            messageId,
            partial: partial(inference, run),
            type: "text_delta",
        };
    }
    if (event.type === "text_end") {
        const contentIndex = inference.currentIndex;
        if (contentIndex === undefined) return undefined;
        const current = inference.content[contentIndex];
        if (current?.type !== "text") return undefined;
        delete inference.currentIndex;
        return {
            content: current.text,
            contentIndex,
            messageId,
            partial: partial(inference, run),
            type: "text_end",
        };
    }
    if (event.type === "reasoning_start") {
        const contentIndex = inference.nextIndex++;
        inference.currentIndex = contentIndex;
        inference.content[contentIndex] = { type: "thinking", thinking: "" };
        return {
            contentIndex,
            messageId,
            partial: partial(inference, run),
            type: "thinking_start",
        };
    }
    if (event.type === "reasoning_delta") {
        const contentIndex = inference.currentIndex;
        if (contentIndex === undefined) return undefined;
        const current = inference.content[contentIndex];
        if (current?.type !== "thinking") return undefined;
        inference.content[contentIndex] = {
            ...current,
            thinking: current.thinking + event.delta,
        };
        return {
            contentIndex,
            delta: event.delta,
            messageId,
            partial: partial(inference, run),
            type: "thinking_delta",
        };
    }
    if (event.type === "reasoning_end") {
        const contentIndex = inference.currentIndex;
        if (contentIndex === undefined) return undefined;
        const current = inference.content[contentIndex];
        if (current?.type !== "thinking") return undefined;
        delete inference.currentIndex;
        return {
            content: current.thinking,
            contentIndex,
            messageId,
            partial: partial(inference, run),
            type: "thinking_end",
        };
    }
    if (event.type === "toolcall_start") {
        const contentIndex = inference.nextIndex++;
        const id = createId();
        const toolCall: ToolCallBlock = {
            arguments: {},
            id,
            name: event.name,
            ...(event.namespace === undefined ? {} : { namespace: event.namespace }),
            providerToolCallId: event.callId,
            type: "tool_call",
            ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
        };
        inference.toolCallIndexes.set(event.callId, contentIndex);
        inference.toolCalls.set(event.callId, toolCall);
        inference.content[contentIndex] = toAssistantToolCall(toolCall);
        return {
            contentIndex,
            messageId,
            partial: partial(inference, run),
            type: "toolcall_start",
        };
    }
    if (event.type === "toolcall_delta") {
        const contentIndex = inference.toolCallIndexes.get(event.callId);
        if (contentIndex === undefined) return undefined;
        return {
            contentIndex,
            delta: event.delta,
            messageId,
            partial: partial(inference, run),
            type: "toolcall_delta",
        };
    }
    if (event.type === "toolcall_end") {
        const contentIndex = inference.toolCallIndexes.get(event.callId);
        const current = inference.toolCalls.get(event.callId);
        if (contentIndex === undefined || current === undefined) return undefined;
        const toolCall: ToolCallBlock = {
            ...current,
            arguments: parseArguments(event.arguments),
            ...(event.incomplete === true ? { incomplete: true } : {}),
        };
        inference.toolCalls.set(event.callId, toolCall);
        inference.content[contentIndex] = toAssistantToolCall(toolCall);
        return {
            contentIndex,
            messageId,
            partial: partial(inference, run),
            toolCall: toAssistantToolCall(toolCall),
            type: "toolcall_end",
        };
    }
    if (event.type === "retrying") {
        return {
            attempt: event.attempt,
            messageId,
            reason: event.reason,
            type: "retrying",
        };
    }
    if (event.type === "block_reset") {
        inference.content.splice(0);
        delete inference.currentIndex;
        inference.nextIndex = 0;
        inference.toolCallIndexes.clear();
        inference.toolCalls.clear();
        return { messageId, partial: partial(inference, run), type: "block_reset" };
    }
    if (event.type === "block_start" || event.type === "block_stop") {
        return { messageId, type: event.type };
    }
    return undefined;
}

async function readPendingBlocks(
    ctx: Context,
    scope: AgentFeatureScope,
): Promise<readonly PendingAgentBlock[]> {
    const value = await scope.runKV.read(ctx, PENDING_BLOCKS_KEY);
    if (value === undefined) return [];
    if (!Value.Check(pendingBlocksSchema, value) || !protocolJsonWithinByteLimit(value)) {
        throw new Error("Rig protocol found invalid pending agent blocks.");
    }
    return value;
}

function messageProjectionKey(messageId: string): string {
    return `${MESSAGE_PROJECTION_KEY_PREFIX}${messageId}`;
}

function validateAcceptedMetadata(
    run: PendingProtocolRun,
    accepted: AgentBaseAcceptedMessage,
): void {
    if (accepted.metadata === undefined) return;
    if (!Value.Check(acceptedMetadataSchema, accepted.metadata)) {
        throw new Error("Rig protocol received invalid Agent Base message metadata.");
    }
    const metadata = accepted.metadata.rig;
    if (
        metadata.messageId !== run.messageId ||
        metadata.runId !== run.runId ||
        metadata.sessionId !== run.session.id ||
        metadata.delivery !== run.delivery
    ) {
        throw new Error("Rig protocol received metadata for a different message.");
    }
}

function partial(inference: PendingInference, run: PendingProtocolRun): AgentEventAssistantMessage {
    return {
        api: run.providerId,
        content: [...inference.content],
        model: run.modelId,
        provider: run.providerId,
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: zeroUsage(),
    };
}

function toAgentBlock(
    event: AgentBasePersistedEvent,
    inference: PendingInference,
): PendingAgentBlock {
    if (event.type === "text_end") return { text: event.block.text, type: "text" };
    if (event.type === "reasoning_end") {
        return {
            thinking: event.block.text ?? "",
            type: "thinking",
            ...(event.block.reasoning === undefined ? {} : { encrypted: event.block.reasoning }),
            ...(event.block.text === undefined ? { redacted: true } : {}),
        };
    }
    const known = inference.toolCalls.get(event.callId);
    return {
        arguments: parseArguments(event.block.arguments),
        id: known?.id ?? createId(),
        name: event.block.name,
        ...(event.block.namespace === undefined ? {} : { namespace: event.block.namespace }),
        providerToolCallId: event.block.callId,
        type: "tool_call",
        ...(event.block.incomplete === true ? { incomplete: true } : {}),
        ...(event.block.vendor === undefined ? {} : { vendor: event.block.vendor }),
    };
}

function toAssistantToolCall(
    toolCall: ToolCallBlock,
): Extract<AgentEventAssistantContent, { type: "toolCall" }> {
    return {
        arguments:
            typeof toolCall.arguments === "object" &&
            toolCall.arguments !== null &&
            !Array.isArray(toolCall.arguments)
                ? (toolCall.arguments as Record<string, unknown>)
                : { value: toolCall.arguments },
        id: toolCall.id,
        name: toolCall.name,
        ...(toolCall.namespace === undefined ? {} : { namespace: toolCall.namespace }),
        ...(toolCall.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: toolCall.providerToolCallId }),
        type: "toolCall",
        ...(toolCall.incomplete === true ? { incomplete: true } : {}),
        ...(toolCall.vendor === undefined ? {} : { vendor: toolCall.vendor }),
    };
}

function parseArguments(value: string): unknown {
    try {
        const parsed: unknown = JSON.parse(value);
        if (Value.Check(protocolJsonSchema, parsed) && protocolJsonWithinByteLimit(parsed)) {
            return parsed;
        }
    } catch {
        // Keep malformed provider JSON as a bounded string so the protocol can still explain it.
    }
    if (Value.Check(protocolJsonSchema, value) && protocolJsonWithinByteLimit(value)) return value;
    throw new Error("Rig protocol received tool arguments outside its persistence bound.");
}

function toRigUsage(usage: SessionUsage | undefined, inference: AgentBaseInference) {
    const input = usage?.input ?? inference.tokens?.input ?? 0;
    const output = usage?.output ?? inference.tokens?.output ?? 0;
    return {
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input,
        output,
        totalTokens: usage?.totalTokens ?? input + output,
    };
}

function zeroUsage() {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
    };
}
