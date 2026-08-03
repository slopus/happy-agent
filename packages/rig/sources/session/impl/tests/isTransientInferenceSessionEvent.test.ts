import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../../agent/loop.js";
import type { SessionEvent } from "../../../protocol/index.js";
import {
    isTransientInferenceSessionEvent,
    TRANSIENT_INFERENCE_EVENT_TYPES,
} from "../isTransientInferenceSessionEvent.js";

describe("isTransientInferenceSessionEvent", () => {
    it("classifies provider stream presentation events as transient", () => {
        for (const type of TRANSIENT_INFERENCE_EVENT_TYPES) {
            expect(
                isTransientInferenceSessionEvent(
                    agentEvent({ messageId: "message-1", type } as AgentLoopEvent),
                ),
            ).toBe(true);
        }
    });

    it("keeps rollback events durable so disconnected clients can recover", () => {
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    messageId: "message-1",
                    partial: {
                        api: "test",
                        content: [],
                        model: "openai/test",
                        provider: "codex",
                        role: "assistant",
                        stopReason: "stop",
                        timestamp: 1,
                        usage: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            cost: {
                                cacheRead: 0,
                                cacheWrite: 0,
                                input: 0,
                                output: 0,
                                total: 0,
                            },
                            input: 0,
                            output: 0,
                            totalTokens: 0,
                        },
                    },
                    type: "block_reset",
                }),
            ),
        ).toBe(false);
    });

    it("drops ephemeral tool progress while keeping terminal tool state durable", () => {
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    display: "halfway",
                    toolCallId: "tool-1",
                    type: "tool_execution_progress",
                }),
            ),
        ).toBe(true);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    status: "waiting",
                    toolCallId: "tool-1",
                    type: "tool_execution_status",
                }),
            ),
        ).toBe(true);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    compactionId: "compaction-1",
                    compactedMessageCount: 2,
                    elapsedMs: 25,
                    estimatedTokensAfter: 100,
                    estimatedTokensBefore: 1_000,
                    reason: "threshold",
                    type: "context_compacted",
                }),
            ),
        ).toBe(false);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    compactionId: "compaction-1",
                    estimatedTokensBefore: 1_000,
                    reason: "threshold",
                    type: "context_compaction_started",
                }),
            ),
        ).toBe(false);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    compactionId: "compaction-1",
                    elapsedMs: 25,
                    status: "completed",
                    type: "context_compaction_finished",
                }),
            ),
        ).toBe(false);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({ running: 1, type: "background_processes_changed" }),
            ),
        ).toBe(false);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    result: {
                        display: "done",
                        toolCallId: "tool-1",
                        toolName: "exec_command",
                        type: "tool_result",
                    },
                    type: "tool_execution_end",
                }),
            ),
        ).toBe(false);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({ type: "future_provider_event" } as unknown as AgentLoopEvent),
            ),
        ).toBe(false);
    });

    it("keeps a finished provider-run search durable because no message records it", () => {
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    callId: "x-1",
                    messageId: "message-1",
                    name: "x_keyword_search",
                    type: "server_toolcall_start",
                }),
            ),
        ).toBe(true);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    callId: "x-1",
                    delta: '{"query":"Cla',
                    messageId: "message-1",
                    type: "server_toolcall_delta",
                }),
            ),
        ).toBe(true);
        expect(
            isTransientInferenceSessionEvent(
                agentEvent({
                    arguments: '{"query":"Claude Code"}',
                    callId: "x-1",
                    messageId: "message-1",
                    name: "x_keyword_search",
                    type: "server_toolcall_end",
                }),
            ),
        ).toBe(false);
    });

    it("conservatively keeps null and missing agent event subtypes", () => {
        expect(isTransientInferenceSessionEvent(malformedAgentEvent({ type: null }))).toBe(false);
        expect(isTransientInferenceSessionEvent(malformedAgentEvent({}))).toBe(false);
        expect(isTransientInferenceSessionEvent(malformedAgentEvent(undefined))).toBe(false);
    });

    it("keeps non-agent session events durable", () => {
        expect(
            isTransientInferenceSessionEvent({
                createdAt: 1,
                data: { modelLocked: true, runId: "run-1", stopReason: "stop" },
                id: "event-2",
                sessionId: "session-1",
                type: "run_finished",
            }),
        ).toBe(false);
    });
});

function agentEvent(event: AgentLoopEvent): SessionEvent {
    return {
        createdAt: 1,
        data: { event, runId: "run-1" },
        id: "event-1",
        sessionId: "session-1",
        type: "agent_event",
    };
}

function malformedAgentEvent(event: unknown): SessionEvent {
    return {
        createdAt: 1,
        data: { event, runId: "run-1" },
        id: "event-1",
        sessionId: "session-1",
        type: "agent_event",
    } as unknown as SessionEvent;
}
