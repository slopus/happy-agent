import type { AgentMessage, ToolCallBlock } from "../agent/types.js";
import type { SessionEvent } from "../protocol/index.js";
import type { Usage } from "../protocol/index.js";
import type { HappySessionEnvelope, HappySessionProtocolMessage, HappyUsage } from "./types.js";

interface ActiveHappyGroup {
    id: string;
    startedAt: number;
}

/** Stateful projection of one Rig session into Happy's flat message protocol. */
export class HappyMessageMapper {
    readonly #activeGroups = new Map<string, ActiveHappyGroup>();
    readonly #appliedEventIds = new Set<string>();
    readonly #pendingCompactions = new Map<
        string,
        Extract<SessionEvent, { type: "agent_event" }>
    >();
    readonly #pendingGroupStartedAt = new Map<string, number>();
    readonly #pendingSteering = new Map<string, Map<string, SessionEvent>>();
    readonly #pendingSteeringHeaders = new Map<string, SessionEvent[]>();
    readonly #runStartedAt = new Map<string, number>();
    readonly #runsWithTerminalFailureMessage = new Set<string>();
    readonly #terminalRunIds = new Set<string>();

    map(event: SessionEvent): readonly HappySessionProtocolMessage[] {
        if (this.#appliedEventIds.has(event.id)) return [];
        this.#appliedEventIds.add(event.id);
        if (this.#appliedEventIds.size > 16_384) {
            const oldest = this.#appliedEventIds.values().next().value;
            if (oldest !== undefined) this.#appliedEventIds.delete(oldest);
        }

        if (event.type === "message_submitted") {
            this.#rememberRunStart(event.data.runId, event.createdAt);
            if (event.data.message.id.startsWith("happy:")) return [];
            if (event.data.delivery === "steer") {
                const pending = this.#pendingSteering.get(event.data.runId) ?? new Map();
                pending.set(event.data.message.id, event);
                this.#pendingSteering.set(event.data.runId, pending);
                return [];
            }
            if (event.data.message.provenance === "agent") {
                /*
                 * Buffering only pays off before agent work exists: once a group is
                 * open the notification belongs inside it, and holding it back would
                 * drop it whenever no further iteration starts.
                 */
                const active = this.#activeGroups.get(event.data.runId);
                if (active !== undefined) return [steeringMessage(event, active.id)];
                const headers = this.#pendingSteeringHeaders.get(event.data.runId) ?? [];
                headers.push(event);
                this.#pendingSteeringHeaders.set(event.data.runId, headers);
                return [];
            }
            return [userMessage(event)];
        }
        if (event.type === "run_started") {
            this.#rememberRunStart(event.data.runId, event.createdAt);
            return [];
        }
        if (event.type === "agent_event" && event.data.event.type === "inference_iteration_start") {
            if (this.#activeGroups.has(event.data.runId)) return [];
            const group = {
                id: event.data.event.messageId,
                startedAt: this.#pendingGroupStartedAt.get(event.data.runId) ?? event.createdAt,
            };
            this.#pendingGroupStartedAt.delete(event.data.runId);
            this.#activeGroups.set(event.data.runId, group);
            return [
                ...this.#takePendingGroupHeaders(event.data.runId, group.id),
                agentMessage(event, `group:${group.id}:start`, group.id, {
                    t: "turn-start",
                }),
            ];
        }
        if (
            event.type === "agent_event" &&
            event.data.event.type === "context_compaction_started"
        ) {
            this.#pendingCompactions.delete(event.data.runId);
            const output = this.#close(event, event.data.runId, "compaction", "completed");
            this.#pendingGroupStartedAt.set(event.data.runId, event.createdAt);
            return output;
        }
        if (event.type === "agent_event" && event.data.event.type === "context_compacted") {
            const group = this.#activeGroups.get(event.data.runId);
            if (group !== undefined) return mapAgentEvent(event, group.id);
            this.#pendingCompactions.set(event.data.runId, event);
            return [];
        }
        if (event.type === "steering_applied") {
            const output = this.#close(event, event.data.runId, "steering", "completed");
            const pending = this.#pendingSteering.get(event.data.runId);
            const headers = this.#pendingSteeringHeaders.get(event.data.runId) ?? [];
            for (const messageId of event.data.messageIds) {
                const submitted = pending?.get(messageId);
                if (submitted?.type === "message_submitted") headers.push(submitted);
                pending?.delete(messageId);
            }
            if (pending?.size === 0) this.#pendingSteering.delete(event.data.runId);
            if (headers.length > 0) this.#pendingSteeringHeaders.set(event.data.runId, headers);
            this.#pendingGroupStartedAt.set(event.data.runId, event.createdAt);
            return output;
        }
        if (event.type === "abort_requested" && event.data.runId !== undefined) {
            if (event.data.continuePendingSteering === true) return [];
            const output = this.#takeTerminalGroupHeaders(event.data.runId);
            output.push(...this.#close(event, event.data.runId, "abort", "cancelled"));
            this.#markRunTerminal(event.data.runId);
            return output;
        }
        if (event.type === "run_finished") {
            if (this.#terminalRunIds.has(event.data.runId)) return [];
            const status =
                event.data.stopReason === "error"
                    ? "failed"
                    : event.data.stopReason === "aborted"
                      ? "cancelled"
                      : "completed";
            const reason =
                event.data.stopReason === "error"
                    ? "error"
                    : event.data.stopReason === "aborted"
                      ? "abort"
                      : "completed";
            const group =
                event.data.stopReason === "error"
                    ? this.#ensureFailureGroup(event, event.data.runId)
                    : this.#activeGroups.get(event.data.runId);
            const output = this.#takeTerminalGroupHeaders(event.data.runId);
            if (
                event.data.stopReason === "error" &&
                group !== undefined &&
                !this.#runsWithTerminalFailureMessage.has(event.data.runId)
            ) {
                output.push(
                    failureMessage(
                        event,
                        `${event.id}:failure`,
                        group.id,
                        "failed",
                        event.data.errorMessage ?? "The model response failed.",
                    ),
                );
            }
            output.push(...this.#close(event, event.data.runId, reason, status));
            this.#markRunTerminal(event.data.runId);
            return output;
        }
        if (event.type === "run_error") {
            if (this.#terminalRunIds.has(event.data.runId)) return [];
            const group = this.#ensureFailureGroup(event, event.data.runId);
            const output = [
                ...this.#takePendingGroupHeaders(event.data.runId, group.id),
                ...(this.#runsWithTerminalFailureMessage.has(event.data.runId)
                    ? []
                    : [
                          failureMessage(
                              event,
                              `${event.id}:failure`,
                              group.id,
                              "failed",
                              event.data.errorMessage,
                          ),
                      ]),
                ...this.#close(event, event.data.runId, "error", "failed"),
            ];
            this.#markRunTerminal(event.data.runId);
            return output;
        }
        if (event.type === "agent_event") {
            const group = this.#activeGroups.get(event.data.runId);
            return group === undefined ? [] : mapAgentEvent(event, group.id);
        }
        if (event.type === "agent_message" && event.data.message.role === "agent") {
            const groupId = this.#activeGroups.get(event.data.runId)?.id ?? event.data.message.id;
            return mapAgentMessage(event, event.data.message, groupId);
        }
        if (event.type === "agent_message" && event.data.message.role === "error") {
            if (
                event.data.message.outcome === "failed" &&
                this.#terminalRunIds.has(event.data.runId)
            ) {
                return [];
            }
            const group = this.#ensureFailureGroup(event, event.data.runId);
            if (event.data.message.outcome === "failed") {
                this.#runsWithTerminalFailureMessage.add(event.data.runId);
            }
            const reason = event.data.message.blocks
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n");
            const headers = this.#takePendingGroupHeaders(event.data.runId, group.id);
            if (event.data.message.outcome === "continued") {
                return [
                    ...headers,
                    agentMessage(event, event.data.message.id, group.id, {
                        t: "service",
                        text: reason,
                    }),
                ];
            }
            return [
                ...headers,
                failureMessage(
                    event,
                    event.data.message.id,
                    group.id,
                    event.data.message.outcome,
                    reason,
                    event.data.message.attempt,
                ),
            ];
        }
        return [];
    }

    #ensureFailureGroup(event: SessionEvent, runId: string): ActiveHappyGroup {
        const active = this.#activeGroups.get(runId);
        if (active !== undefined) return active;
        const group = {
            id: runId,
            startedAt:
                this.#pendingGroupStartedAt.get(runId) ??
                this.#runStartedAt.get(runId) ??
                event.createdAt,
        };
        this.#pendingGroupStartedAt.delete(runId);
        this.#activeGroups.set(runId, group);
        return group;
    }

    #markRunTerminal(runId: string): void {
        this.#activeGroups.delete(runId);
        this.#pendingCompactions.delete(runId);
        this.#pendingGroupStartedAt.delete(runId);
        this.#pendingSteering.delete(runId);
        this.#pendingSteeringHeaders.delete(runId);
        this.#runStartedAt.delete(runId);
        this.#runsWithTerminalFailureMessage.delete(runId);
        this.#terminalRunIds.add(runId);
        if (this.#terminalRunIds.size > 16_384) {
            const oldest = this.#terminalRunIds.values().next().value;
            if (oldest !== undefined) this.#terminalRunIds.delete(oldest);
        }
    }

    #rememberRunStart(runId: string, startedAt: number): void {
        if (!this.#runStartedAt.has(runId)) this.#runStartedAt.set(runId, startedAt);
    }

    #takePendingGroupHeaders(runId: string, groupId: string): HappySessionProtocolMessage[] {
        const output = this.#takePendingCompaction(runId, groupId);
        const steering = this.#pendingSteeringHeaders.get(runId);
        if (steering === undefined) return output;
        this.#pendingSteeringHeaders.delete(runId);
        for (const event of steering) {
            if (event.type === "message_submitted") {
                output.push(steeringMessage(event, groupId));
            }
        }
        return output;
    }

    #takePendingCompaction(runId: string, groupId: string): HappySessionProtocolMessage[] {
        const pending = this.#pendingCompactions.get(runId);
        if (pending === undefined) return [];
        this.#pendingCompactions.delete(runId);
        return mapAgentEvent(pending, groupId);
    }

    /*
     * A terminal event is the last chance to deliver what the run buffered, and
     * #markRunTerminal drops the buffer, so it flushes against the open group while
     * one is still there and against the run itself otherwise.
     */
    #takeTerminalGroupHeaders(runId: string): HappySessionProtocolMessage[] {
        return this.#takePendingGroupHeaders(runId, this.#activeGroups.get(runId)?.id ?? runId);
    }

    #close(
        event: SessionEvent,
        runId: string,
        reason: "completed" | "steering" | "compaction" | "abort" | "error",
        status: "cancelled" | "completed" | "failed",
    ): HappySessionProtocolMessage[] {
        const group = this.#activeGroups.get(runId);
        if (group === undefined) return [];
        this.#activeGroups.delete(runId);
        const turnStartedAt = Math.min(
            group.startedAt,
            this.#runStartedAt.get(runId) ?? group.startedAt,
        );
        return [
            agentMessage(event, `group:${group.id}:end`, group.id, {
                elapsedMs: Math.max(0, event.createdAt - group.startedAt),
                reason,
                status,
                t: "turn-end",
                turnElapsedMs: Math.max(0, event.createdAt - turnStartedAt),
            }),
        ];
    }
}

function userMessage(
    event: Extract<SessionEvent, { type: "message_submitted" }>,
    groupId?: string,
): HappySessionProtocolMessage {
    return createMessage({
        ev: { t: "text", text: event.data.displayText },
        id: event.data.message.id,
        role: "user",
        time: event.createdAt,
        ...(groupId === undefined ? {} : { turn: groupId }),
    });
}

function steeringMessage(
    event: Extract<SessionEvent, { type: "message_submitted" }>,
    groupId: string,
): HappySessionProtocolMessage {
    if (event.data.message.provenance === "agent") {
        return agentMessage(event, event.data.message.id, groupId, {
            t: "service",
            text: event.data.displayText,
        });
    }
    return userMessage(event, groupId);
}

function failureMessage(
    event: SessionEvent,
    id: string,
    groupId: string,
    outcome: "retried" | "failed",
    reason: string,
    attempt?: number,
): HappySessionProtocolMessage {
    return agentMessage(event, id, groupId, {
        ...(attempt === undefined ? {} : { attempt }),
        outcome,
        reason,
        t: "failure",
    });
}

function mapAgentEvent(event: Extract<SessionEvent, { type: "agent_event" }>, groupId: string) {
    const streamed = event.data.event;
    if (streamed.type === "tool_execution_end") {
        return [
            agentMessage(event, `tool-result:${streamed.result.toolCallId}`, groupId, {
                call: streamed.result.toolCallId,
                t: "tool-call-end",
            }),
        ];
    }
    if (streamed.type === "context_compacted") {
        return [
            agentMessage(event, `${event.id}:compacted`, groupId, {
                t: "service",
                text: "Context compacted.",
            }),
        ];
    }
    return [];
}

function mapAgentMessage(
    event: Extract<SessionEvent, { type: "agent_message" }>,
    message: AgentMessage,
    groupId: string,
): HappySessionProtocolMessage[] {
    const output: HappySessionProtocolMessage[] = [];
    for (const [index, block] of message.blocks.entries()) {
        if (block.type === "text") {
            output.push(
                agentMessage(event, `${message.id}:text:${index}`, groupId, {
                    t: "text",
                    text: block.text,
                }),
            );
        } else if (block.type === "thinking") {
            output.push(
                agentMessage(event, `${message.id}:thinking:${index}`, groupId, {
                    t: "text",
                    text: block.thinking,
                    thinking: true,
                }),
            );
        } else if (block.type === "tool_call") {
            output.push(toolCallStartMessage(event, message.id, block, groupId));
        } else if (block.type === "tool_result") {
            output.push(
                agentMessage(event, `tool-result:${block.toolCallId}`, groupId, {
                    call: block.toolCallId,
                    t: "tool-call-end",
                }),
            );
        }
    }
    const usage = toHappyUsage(message.usage);
    if (usage !== undefined && output[0] !== undefined) output[0].content.usage = usage;
    return output;
}

function toolCallStartMessage(
    event: SessionEvent,
    messageId: string,
    toolCall: Pick<ToolCallBlock, "arguments" | "id" | "name" | "presentation">,
    runId: string,
): HappySessionProtocolMessage {
    const title = humanizeToolName(toolCall.name);
    return agentMessage(event, `${messageId}:tool:${toolCall.id}:start`, runId, {
        args: toRecord(toolCall.arguments),
        call: toolCall.id,
        description: `Running ${title}`,
        name: toolCall.name,
        ...(toolCall.presentation === undefined ? {} : { presentation: toolCall.presentation }),
        t: "tool-call-start",
        title,
    });
}

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

function toHappyUsage(usage: Usage | undefined): HappyUsage | undefined {
    if (usage === undefined) return undefined;
    return {
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
        input_tokens: usage.input,
        output_tokens: usage.output,
    };
}

function agentMessage(
    event: SessionEvent,
    id: string,
    turn: string,
    ev: HappySessionEnvelope["ev"],
): HappySessionProtocolMessage {
    return createMessage({ ev, id, role: "agent", time: event.createdAt, turn });
}

function createMessage(content: HappySessionEnvelope): HappySessionProtocolMessage {
    return {
        content,
        localId: `rig:${content.id}`,
        meta: { sentFrom: "rig" },
        role: "session",
    };
}
