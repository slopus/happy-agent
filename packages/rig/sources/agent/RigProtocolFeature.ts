import { createId } from "@paralleldrive/cuid2";
import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentFeature,
    AgentFeatureScope,
} from "@slopus/happy-agent-base";
import type { SessionEvent as ProviderSessionEvent, SessionUsage } from "@slopus/happy-providers";
import type { AssistantContent, AssistantMessage, StopReason } from "@slopus/rig-execution";
import type { Context } from "@steve.kite/stdlib";

import type { AgentLoopEvent } from "./loop.js";
import type { AgentBlock, AgentMessage, Message, ToolCallBlock, UserMessage } from "./types.js";
import {
    createEventIdFactory,
    type ProtocolSession,
    type SessionEvent,
} from "../protocol/index.js";

export interface RigAgentProtocolSession {
    afterProtocolCommit(ctx: Context, callback: () => void): Promise<void>;
    readonly events: {
        append(ctx: Context, event: SessionEvent): Promise<SessionEvent>;
    };
    readonly id: string;
    projectProtocolEvent(ctx: Context, event: SessionEvent): Promise<SessionEvent>;
    projectAgentMessage(ctx: Context, runId: string, message: Message): Promise<SessionEvent>;
    projectUserMessage(
        ctx: Context,
        input: {
            delivery: "run" | "steer";
            displayText: string;
            message: UserMessage;
            mutationId?: string;
            runId: string;
        },
    ): Promise<SessionEvent>;
    publishAgentLiveEvent(ctx: Context, event: SessionEvent): void;
    snapshot(): ProtocolSession;
}

interface PendingInference {
    readonly blocks: AgentBlock[];
    readonly content: AssistantContent[];
    currentIndex?: number;
    iteration: number;
    readonly messageId: string;
    nextIndex: number;
    usage?: SessionUsage;
    readonly toolCallIndexes: Map<string, number>;
    readonly toolCalls: Map<string, ToolCallBlock>;
}

interface PendingProtocolRun {
    readonly accepted: Promise<void>;
    cancelled: boolean;
    readonly delivery: "run" | "steer";
    inference?: PendingInference;
    iteration: number;
    readonly messageId: string;
    messageConsumed: boolean;
    readonly modelId: string;
    outcome?: {
        errorMessage?: string;
        stopReason: Extract<StopReason, "aborted" | "error" | "length" | "stop" | "toolUse">;
    };
    projectionError?: unknown;
    projectedEvent?: SessionEvent;
    projectionCommitted: boolean;
    readonly projectionInput: {
        delivery: "run" | "steer";
        displayText: string;
        message: UserMessage;
        mutationId?: string;
        runId: string;
    };
    readonly providerId: string;
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
            modelId: string;
            mutationId?: string;
            providerId: string;
            runId: string;
            session: RigAgentProtocolSession;
            snapshot: ProtocolSession;
        },
    ): PendingProtocolRunRegistration {
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
            projectionCommitted: false,
            projectionInput: {
                delivery: input.delivery,
                displayText: input.displayText,
                message: input.message,
                ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
                runId: input.runId,
            },
            resolveAccepted,
            resolveProjected,
            started: false,
            tail: Promise.resolve(),
            terminalProjected: false,
        };
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

    hasPending(agentId: string, runId?: string): boolean {
        return (
            this.#pending
                .get(agentId)
                ?.some((run) => !run.cancelled && (runId === undefined || run.runId === runId)) ??
            false
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
            blocks: [],
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
        _accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        const run = this.#pending
            .get(scope.agent.id)
            ?.find((candidate) => !candidate.cancelled && !candidate.messageConsumed);
        if (run === undefined) return;
        run.messageConsumed = true;
        try {
            run.projectedEvent = await run.session.projectUserMessage(ctx, run.projectionInput);
        } catch (error) {
            run.messageConsumed = false;
            throw error;
        }
    };

    readonly messageAccepted = async (
        ctx: Context,
        scope: AgentFeatureScope,
        _accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        const run = this.#pending
            .get(scope.agent.id)
            ?.find(
                (candidate) =>
                    !candidate.cancelled &&
                    candidate.messageConsumed &&
                    !candidate.projectionCommitted &&
                    candidate.projectedEvent !== undefined,
            );
        if (run?.projectedEvent === undefined) return;
        run.projectionCommitted = true;
        this.#active.set(scope.agent.id, run);
        run.resolveProjected(run.projectedEvent);
        run.resolveAccepted();
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

    readonly onEvent = (
        ctx: Context,
        scope: AgentFeatureScope,
        event: ProviderSessionEvent,
    ): void => {
        const run = this.#activeRun(scope.agent.id);
        const inference = run?.inference;
        if (run === undefined || inference === undefined || run.cancelled) return;

        if (event.type === "token_usage") {
            inference.usage = event.usage;
            return;
        }
        if (event.type === "done") {
            if (event.state === "error") {
                run.outcome = { errorMessage: event.message, stopReason: "error" };
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

    readonly onEventTransact = (
        _ctx: Context,
        scope: AgentFeatureScope,
        event: AgentBasePersistedEvent,
    ): void => {
        const inference = this.#activeRun(scope.agent.id)?.inference;
        if (inference === undefined) return;
        inference.blocks.push(toAgentBlock(event, inference));
    };

    readonly afterInferenceTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        result: AgentBaseInference,
    ): Promise<void> => {
        const run = this.#activeRun(scope.agent.id);
        const inference = run?.inference;
        if (run === undefined || inference === undefined || run.cancelled) return;
        if (inference.blocks.length > 0) {
            const message: AgentMessage = {
                blocks: inference.blocks,
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
            await run.session.projectAgentMessage(ctx, run.runId, {
                blocks: [{ text: result.errorMessage, type: "text" }],
                id: createId(),
                outcome: "failed",
                providerId: run.providerId,
                requestedModelId: run.modelId,
                role: "error",
            });
        }
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
        const terminalRuns = new Map<string, PendingProtocolRun>();
        for (const run of pending) {
            if (!run.cancelled) terminalRuns.set(run.runId, run);
        }
        for (const run of terminalRuns.values()) {
            run.terminalEvent ??= this.#terminalEvent(run);
            await this.#append(ctx, run, run.terminalEvent);
            await run.session.afterProtocolCommit(ctx, () => {
                run.terminalProjected = true;
            });
        }
    };

    readonly afterAgentSettled = async (ctx: Context, scope: AgentFeatureScope): Promise<void> => {
        const pending = this.#pending.get(scope.agent.id) ?? [];
        const terminalRuns = new Map<string, PendingProtocolRun>();
        for (const run of pending) {
            if (!run.cancelled) terminalRuns.set(run.runId, run);
        }
        for (const run of terminalRuns.values()) {
            if (run.terminalProjected) continue;
            run.terminalEvent ??= this.#terminalEvent(run);
            await this.#append(ctx, run, run.terminalEvent);
        }
        this.#pending.delete(scope.agent.id);
        this.#active.delete(scope.agent.id);
    };

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

function partial(inference: PendingInference, run: PendingProtocolRun): AssistantMessage {
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

function toAgentBlock(event: AgentBasePersistedEvent, inference: PendingInference): AgentBlock {
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
): Extract<AssistantContent, { type: "toolCall" }> {
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
        return JSON.parse(value);
    } catch {
        return value;
    }
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
