import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { AgentEvent } from "../events/index.js";
import type { HistoryMessage } from "../history/index.js";
import type {
    HappySessionEnvelope,
    HappySessionEvent,
    HappySessionProtocolMessage,
    HappyUsage,
} from "./HappyProtocol.js";

/** How many event ids are remembered so a replayed event is not shown twice. */
const MAX_REMEMBERED_EVENTS = 16_384;

const acceptedMessageSchema = Type.Object(
    {
        id: Type.String({ minLength: 1 }),
        kind: Type.String({ minLength: 1 }),
        runId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true },
);

const providerEventSchema = Type.Object(
    {
        event: Type.Object({ type: Type.String() }, { additionalProperties: true }),
        recovered: Type.Optional(Type.Boolean()),
        rigEvent: Type.Optional(
            Type.Object({ type: Type.String() }, { additionalProperties: true }),
        ),
        runId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true },
);

const streamedTextSchema = Type.Object(
    { content: Type.Optional(Type.String()) },
    { additionalProperties: true },
);

const retryingSchema = Type.Object(
    { attempt: Type.Number(), reason: Type.String() },
    { additionalProperties: true },
);

const toolStartSchema = Type.Object(
    {
        rigEvent: Type.Object(
            {
                toolCall: Type.Object(
                    {
                        arguments: Type.Optional(Type.Unknown()),
                        id: Type.String({ minLength: 1 }),
                        name: Type.Optional(Type.String()),
                    },
                    { additionalProperties: true },
                ),
                type: Type.Literal("tool_execution_start"),
            },
            { additionalProperties: true },
        ),
        runId: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const toolEndSchema = Type.Object(
    {
        rigEvent: Type.Object(
            {
                result: Type.Object(
                    { toolCallId: Type.String({ minLength: 1 }) },
                    { additionalProperties: true },
                ),
                type: Type.Literal("tool_execution_end"),
            },
            { additionalProperties: true },
        ),
        runId: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const inferenceSchema = Type.Object(
    {
        errorMessage: Type.Optional(Type.String()),
        runId: Type.String({ minLength: 1 }),
        state: Type.Optional(Type.String()),
        tokens: Type.Optional(
            Type.Object(
                { input: Type.Number(), output: Type.Number() },
                { additionalProperties: true },
            ),
        ),
    },
    { additionalProperties: true },
);

const settlementSchema = Type.Object(
    {
        error: Type.Optional(Type.String()),
        errorMessage: Type.Optional(Type.String()),
        runId: Type.String({ minLength: 1 }),
        stopReason: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const loopSchema = Type.Object(
    { runId: Type.String({ minLength: 1 }) },
    { additionalProperties: true },
);

interface ActiveTurn {
    readonly id: string;
    readonly startedAt: number;
}

/**
 * Turns one agent's durable event journal into the flat stream of messages Happy shows.
 *
 * Happy renders a conversation as turns: a turn opens, things happen inside it,
 * and it ends with how it ended and how long it took. Happy Agent's journal says the
 * same thing in its own words, and this is the translation, one event at a time
 * and in order.
 *
 * One mapper belongs to one agent. It remembers only what an in-flight turn
 * needs, so a restart resumes mid-conversation without replaying anything: the
 * outbox, not this, is what makes delivery durable.
 */
export class HappyMessageMapper {
    readonly #appliedEventIds = new Set<string>();
    readonly #runStartedAt = new Map<string, number>();
    #activeTurn: ActiveTurn | undefined;
    #usage: HappyUsage | undefined;

    /** Translates one journal event, or answers nothing when it says nothing to Happy. */
    map(
        event: AgentEvent,
        acceptedMessage?: HistoryMessage,
    ): readonly HappySessionProtocolMessage[] {
        if (this.#appliedEventIds.has(event.id)) return [];
        this.#remember(event.id);

        if (event.type === "message.accepted") return this.#mapAccepted(event, acceptedMessage);
        if (event.type === "loop.started") return this.#mapLoopStarted(event);
        if (event.type === "provider.event") return this.#mapProviderEvent(event);
        if (event.type === "tool.started" || event.type === "tool.completed") {
            return this.#mapTool(event);
        }
        if (event.type === "inference.completed") return this.#mapInference(event);
        if (event.type === "loop.settled") return this.#mapSettled(event);
        return [];
    }

    #mapAccepted(
        event: AgentEvent,
        message: HistoryMessage | undefined,
    ): readonly HappySessionProtocolMessage[] {
        if (!Value.Check(acceptedMessageSchema, event.payload)) return [];
        const accepted = event.payload;
        this.#rememberRunStart(accepted.runId, event.occurredAt);
        if (message?.recordId !== accepted.id) return [];
        // The phone already shows a message it sent; the typed History marker prevents its echo.
        if (message.remoteMessageId !== undefined || message.hideFromUser === true) return [];
        const text = message.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();
        if (text.length === 0) return [];
        // A message arriving mid-turn is the person interrupting; the turn ends here.
        const interrupted = this.#closeTurn(event, accepted.runId, "completed", "steering");
        if (message.role === "user") {
            return [
                ...interrupted,
                this.#createMessage({
                    ev: { t: "text", text },
                    id: accepted.id,
                    role: "user",
                    time: event.occurredAt,
                }),
            ];
        }
        // Anything the runtime or another agent said belongs to the agent's side.
        return [...interrupted, this.#agentMessage(event, accepted.id, { t: "service", text })];
    }

    #mapLoopStarted(event: AgentEvent): readonly HappySessionProtocolMessage[] {
        if (Value.Check(loopSchema, event.payload)) {
            this.#rememberRunStart(event.payload.runId, event.occurredAt);
        }
        return [];
    }

    #mapProviderEvent(event: AgentEvent): readonly HappySessionProtocolMessage[] {
        if (!Value.Check(providerEventSchema, event.payload)) return [];
        const payload = event.payload;
        // A recovered stream is Happy Agent repairing its own state, not the model speaking.
        if (payload.recovered === true) return [];
        const streamed = payload.event.type;
        if (streamed === "block_start") {
            return this.#openTurn(event, payload.runId);
        }
        if (streamed === "text_end" || streamed === "reasoning_end") {
            if (!Value.Check(streamedTextSchema, payload.rigEvent)) return [];
            const text = payload.rigEvent.content ?? "";
            if (text.length === 0) return [];
            return [
                this.#agentMessage(event, `${event.id}:text`, {
                    t: "text",
                    text,
                    ...(streamed === "reasoning_end" ? { thinking: true } : {}),
                }),
            ];
        }
        if (streamed === "retrying") {
            if (!Value.Check(retryingSchema, payload.event)) return [];
            return [
                this.#agentMessage(event, `${event.id}:retry`, {
                    attempt: payload.event.attempt,
                    outcome: "retried",
                    reason: payload.event.reason,
                    t: "failure",
                }),
            ];
        }
        // A server tool settles inside the response, so its call arrives here.
        return this.#mapTool(event);
    }

    #mapTool(event: AgentEvent): readonly HappySessionProtocolMessage[] {
        if (Value.Check(toolStartSchema, event.payload)) {
            const call = event.payload.rigEvent.toolCall;
            const title = humanizeToolName(call.name ?? "tool");
            return [
                this.#agentMessage(event, `tool-call:${call.id}`, {
                    args: toRecord(call.arguments),
                    call: call.id,
                    description: `Running ${title}`,
                    name: call.name ?? "tool",
                    t: "tool-call-start",
                    title,
                }),
            ];
        }
        if (Value.Check(toolEndSchema, event.payload)) {
            const callId = event.payload.rigEvent.result.toolCallId;
            return [
                this.#agentMessage(event, `tool-result:${callId}`, {
                    call: callId,
                    t: "tool-call-end",
                }),
            ];
        }
        return [];
    }

    #mapInference(event: AgentEvent): readonly HappySessionProtocolMessage[] {
        if (!Value.Check(inferenceSchema, event.payload)) return [];
        const inference = event.payload;
        if (inference.tokens !== undefined) {
            // One Happy turn covers a whole run, so its cost is every response in it.
            this.#usage = {
                input_tokens: (this.#usage?.input_tokens ?? 0) + inference.tokens.input,
                output_tokens: (this.#usage?.output_tokens ?? 0) + inference.tokens.output,
            };
        }
        return [];
    }

    #mapSettled(event: AgentEvent): readonly HappySessionProtocolMessage[] {
        if (!Value.Check(settlementSchema, event.payload)) return [];
        const settlement = event.payload;
        const failed = settlement.stopReason === "error";
        const failureText = settlement.error ?? settlement.errorMessage;
        const output: HappySessionProtocolMessage[] = [];
        if (failed) {
            output.push(
                this.#agentMessage(event, `${event.id}:failure`, {
                    outcome: "failed",
                    reason: failureText ?? "The model response failed.",
                    t: "failure",
                }),
            );
        }
        const status =
            settlement.stopReason === "aborted" ? "cancelled" : failed ? "failed" : "completed";
        output.push(
            ...this.#closeTurn(
                event,
                settlement.runId,
                status,
                status === "cancelled" ? "abort" : status === "failed" ? "error" : "completed",
            ),
        );
        this.#runStartedAt.delete(settlement.runId);
        return output;
    }

    #openTurn(event: AgentEvent, runId: string): readonly HappySessionProtocolMessage[] {
        if (this.#activeTurn !== undefined) return [];
        this.#rememberRunStart(runId, event.occurredAt);
        this.#activeTurn = { id: event.id, startedAt: event.occurredAt };
        return [this.#agentMessage(event, `turn:${event.id}:start`, { t: "turn-start" })];
    }

    #closeTurn(
        event: AgentEvent,
        runId: string,
        status: "cancelled" | "completed" | "failed",
        reason: "abort" | "completed" | "error" | "steering",
    ): HappySessionProtocolMessage[] {
        const turn = this.#activeTurn;
        if (turn === undefined) return [];
        this.#activeTurn = undefined;
        const usage = this.#usage;
        this.#usage = undefined;
        const runStartedAt = this.#runStartedAt.get(runId) ?? turn.startedAt;
        return [
            this.#createMessage({
                ev: {
                    elapsedMs: Math.max(0, event.occurredAt - turn.startedAt),
                    reason,
                    status,
                    t: "turn-end",
                    turnElapsedMs: Math.max(
                        0,
                        event.occurredAt - Math.min(runStartedAt, turn.startedAt),
                    ),
                },
                id: `turn:${turn.id}:end`,
                role: "agent",
                time: event.occurredAt,
                turn: turn.id,
                ...(usage === undefined ? {} : { usage }),
            }),
        ];
    }

    #agentMessage(
        event: AgentEvent,
        id: string,
        ev: HappySessionEvent,
    ): HappySessionProtocolMessage {
        return this.#createMessage({
            ev,
            id,
            role: "agent",
            time: event.occurredAt,
            ...(this.#activeTurn === undefined ? {} : { turn: this.#activeTurn.id }),
        });
    }

    #createMessage(content: HappySessionEnvelope): HappySessionProtocolMessage {
        return {
            content,
            localId: `rig:${content.id}`,
            meta: { sentFrom: "rig" },
            role: "session",
        };
    }

    #rememberRunStart(runId: string, startedAt: number): void {
        if (!this.#runStartedAt.has(runId)) this.#runStartedAt.set(runId, startedAt);
        while (this.#runStartedAt.size > 64) {
            const oldest = this.#runStartedAt.keys().next().value;
            if (oldest === undefined) break;
            this.#runStartedAt.delete(oldest);
        }
    }

    #remember(eventId: string): void {
        this.#appliedEventIds.add(eventId);
        while (this.#appliedEventIds.size > MAX_REMEMBERED_EVENTS) {
            const oldest = this.#appliedEventIds.values().next().value;
            if (oldest === undefined) break;
            this.#appliedEventIds.delete(oldest);
        }
    }
}

/** Turns a tool's identifier into the words a person reads on the phone. */
function humanizeToolName(value: string): string {
    const spaced = value
        .replaceAll(/[_-]+/gu, " ")
        .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
        .trim();
    return spaced.length === 0
        ? "Tool"
        : spaced
              .split(/\s+/u)
              .map((part) => part[0]!.toUpperCase() + part.slice(1))
              .join(" ");
}

function toRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };
}
