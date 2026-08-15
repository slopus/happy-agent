import type {
    SessionActivity,
    SessionActivityCompaction,
    SessionActivityPermissionReview,
    SessionActivityToolCall,
    SessionEvent,
} from "../index.js";

export const IDLE_SESSION_ACTIVITY: SessionActivity = {
    kind: "idle",
    label: "Idle",
    since: 0,
};

/**
 * Derives what a session is doing from the events it has already emitted.
 *
 * The session keeps the result on its row and reports it to attached clients, so
 * a client never has to replay streaming events and track which blocks are still
 * open to tell thinking apart from running a tool.
 *
 * Returns the previous activity unchanged when the event says nothing about the
 * current work, which lets the caller decide whether anything is worth
 * reporting by identity alone.
 */
export function sessionActivityAfterEvent(
    previous: SessionActivity,
    event: SessionEvent,
): SessionActivity {
    switch (event.type) {
        case "message_submitted":
            if (event.data.delivery === "context") return previous;
            return previous.runId === undefined
                ? { kind: "queued", label: "Queued", since: event.createdAt }
                : previous;
        case "run_started":
            return {
                kind: "thinking",
                label: "Thinking",
                runId: event.data.runId,
                since: event.createdAt,
            };
        case "run_finished":
            return finishedActivity(event.createdAt, event.data.stopReason);
        case "run_error":
            return { kind: "error", label: "Failed", since: event.createdAt };
        case "abort_requested":
            return event.data.continuePendingSteering === true
                ? previous
                : { kind: "stopped", label: "Stopped", since: event.createdAt };
        case "session_reset":
        case "session_rewound":
            return { ...IDLE_SESSION_ACTIVITY, since: event.createdAt };
        case "user_input_requested":
            return withPendingInput(previous, event.createdAt, event.data.requestId);
        case "user_input_resolved":
        case "user_input_detached":
            return withoutPendingInput(previous, event.createdAt, event.data.requestId);
        case "agent_event":
            return activityAfterAgentEvent(previous, event.createdAt, event.data.event);
        default:
            return previous;
    }
}

function activityAfterAgentEvent(
    previous: SessionActivity,
    at: number,
    event: Extract<SessionEvent, { type: "agent_event" }>["data"]["event"],
): SessionActivity {
    switch (event.type) {
        case "inference_iteration_start":
            return {
                ...withoutPermissionReviews(withoutRetry(previous)),
                kind: "thinking",
                label: "Thinking",
                since: at,
            };
        case "thinking_start":
        case "thinking_delta":
            return streaming(previous, at, "thinking", "Thinking");
        case "text_start":
        case "text_delta":
            return streaming(previous, at, "generating_message", "Writing a reply");
        case "toolcall_start":
        case "toolcall_delta":
            return streaming(previous, at, "generating_tool_call", "Preparing a tool call");
        case "retrying":
            return {
                ...previous,
                kind: "retrying",
                label: `Retrying: ${event.reason}`,
                retry: { attempt: event.attempt, reason: event.reason },
                since: at,
            };
        case "tool_execution_start":
            return withToolCall(previous, at, {
                startedAt: at,
                toolCallId: event.toolCall.id,
                toolName: event.toolCall.name,
            });
        case "permission_review_started":
            return withPermissionReview(previous, at, {
                action: event.action,
                startedAt: at,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
            });
        case "permission_review":
            return withoutPermissionReview(previous, at, event.toolCallId);
        case "tool_execution_status":
            return withToolCallStatus(previous, at, event.toolCallId, event.status);
        case "tool_execution_end":
            return withoutToolCall(previous, at, event.result.toolCallId);
        case "context_compaction_started":
            return withCompaction(previous, at, {
                compactionId: event.compactionId,
                estimatedTokensBefore: event.estimatedTokensBefore,
                reason: event.reason,
                startedAt: at,
            });
        case "context_compaction_finished":
            return withoutCompaction(previous, at, event.compactionId);
        default:
            return previous;
    }
}

function finishedActivity(at: number, stopReason: string): SessionActivity {
    if (stopReason === "aborted") return { kind: "stopped", label: "Stopped", since: at };
    if (stopReason === "error") return { kind: "error", label: "Failed", since: at };
    return { ...IDLE_SESSION_ACTIVITY, since: at };
}

/**
 * Applies a streaming phase without disturbing higher-precedence work. A tool
 * that is still executing, or a compaction still in flight, describes the
 * session better than the block the model happens to be emitting.
 */
function streaming(
    previous: SessionActivity,
    at: number,
    kind: SessionActivity["kind"],
    label: string,
): SessionActivity {
    const cleared = withoutRetry(previous);
    if (holdsPrecedenceOverStreaming(cleared)) return cleared;
    if (cleared.kind === kind) return cleared;
    return { ...cleared, kind, label, since: at };
}

function holdsPrecedenceOverStreaming(activity: SessionActivity): boolean {
    return (
        activity.compaction !== undefined ||
        activity.wait !== undefined ||
        (activity.pendingInputRequestIds?.length ?? 0) > 0 ||
        (activity.reviewingToolCalls?.length ?? 0) > 0 ||
        (activity.toolCalls?.length ?? 0) > 0
    );
}

function withPermissionReview(
    previous: SessionActivity,
    at: number,
    review: SessionActivityPermissionReview,
): SessionActivity {
    const reviewingToolCalls = [
        ...(previous.reviewingToolCalls ?? []).filter(
            (candidate) => candidate.toolCallId !== review.toolCallId,
        ),
        review,
    ];
    return resolve({ ...previous, reviewingToolCalls }, at);
}

function withoutPermissionReview(
    previous: SessionActivity,
    at: number,
    toolCallId: string,
): SessionActivity {
    const existing = previous.reviewingToolCalls ?? [];
    if (!existing.some((candidate) => candidate.toolCallId === toolCallId)) return previous;
    const reviewingToolCalls = existing.filter((candidate) => candidate.toolCallId !== toolCallId);
    return resolve({ ...previous, reviewingToolCalls }, at);
}

function withToolCall(
    previous: SessionActivity,
    at: number,
    toolCall: SessionActivityToolCall,
): SessionActivity {
    const toolCalls = [
        ...(previous.toolCalls ?? []).filter(
            (candidate) => candidate.toolCallId !== toolCall.toolCallId,
        ),
        toolCall,
    ];
    return resolve({ ...previous, toolCalls }, at);
}

function withToolCallStatus(
    previous: SessionActivity,
    at: number,
    toolCallId: string,
    status: string,
): SessionActivity {
    const existing = previous.toolCalls ?? [];
    if (!existing.some((candidate) => candidate.toolCallId === toolCallId)) return previous;
    const toolCalls = existing.map((candidate) =>
        candidate.toolCallId === toolCallId ? { ...candidate, status } : candidate,
    );
    return resolve({ ...previous, toolCalls }, at);
}

function withoutToolCall(
    previous: SessionActivity,
    at: number,
    toolCallId: string,
): SessionActivity {
    const existing = previous.toolCalls ?? [];
    if (!existing.some((candidate) => candidate.toolCallId === toolCallId)) return previous;
    const toolCalls = existing.filter((candidate) => candidate.toolCallId !== toolCallId);
    return resolve({ ...previous, toolCalls }, at);
}

function withCompaction(
    previous: SessionActivity,
    at: number,
    compaction: SessionActivityCompaction,
): SessionActivity {
    return resolve({ ...previous, compaction }, at);
}

function withoutCompaction(
    previous: SessionActivity,
    at: number,
    compactionId: string,
): SessionActivity {
    if (previous.compaction?.compactionId !== compactionId) return previous;
    const { compaction: _finished, ...rest } = previous;
    return resolve(rest, at);
}

function withPendingInput(
    previous: SessionActivity,
    at: number,
    requestId: string,
): SessionActivity {
    const existing = previous.pendingInputRequestIds ?? [];
    if (existing.includes(requestId)) return previous;
    return resolve({ ...previous, pendingInputRequestIds: [...existing, requestId] }, at);
}

function withoutPendingInput(
    previous: SessionActivity,
    at: number,
    requestId: string,
): SessionActivity {
    const existing = previous.pendingInputRequestIds ?? [];
    if (!existing.includes(requestId)) return previous;
    const pendingInputRequestIds = existing.filter((candidate) => candidate !== requestId);
    return resolve({ ...previous, pendingInputRequestIds }, at);
}

function withoutRetry(activity: SessionActivity): SessionActivity {
    if (activity.retry === undefined) return activity;
    const { retry: _retry, ...rest } = activity;
    return rest;
}

function withoutPermissionReviews(activity: SessionActivity): SessionActivity {
    if (activity.reviewingToolCalls === undefined) return activity;
    const { reviewingToolCalls: _reviewing, ...rest } = activity;
    return rest;
}

/**
 * Rebuilds the reported kind and label after the tracked work changed.
 *
 * A session that is no longer blocked on anything specific has gone back to
 * waiting on the model, so `thinking` is the honest fallback rather than the
 * phase that happened to be open before.
 */
function resolve(activity: SessionActivity, at: number): SessionActivity {
    const next = describe(activity);
    if (next.kind === activity.kind && next.label === activity.label) {
        return normalize(activity);
    }
    return normalize({ ...activity, ...next, since: at });
}

function describe(activity: SessionActivity): { kind: SessionActivity["kind"]; label: string } {
    if (activity.retry !== undefined) {
        return { kind: "retrying", label: `Retrying: ${activity.retry.reason}` };
    }
    if (activity.compaction !== undefined) {
        return { kind: "compacting", label: "Compacting the conversation" };
    }
    if ((activity.pendingInputRequestIds?.length ?? 0) > 0) {
        return { kind: "awaiting_input", label: "Waiting for an answer" };
    }
    if (activity.wait !== undefined) {
        return {
            kind: "waiting",
            label: `Waiting until ${new Date(activity.wait.dueAt).toLocaleString()}`,
        };
    }
    const reviewingToolCalls = activity.reviewingToolCalls ?? [];
    if (reviewingToolCalls.length === 1) {
        return {
            kind: "reviewing_tool_call",
            label: `Reviewing ${reviewingToolCalls[0]!.toolName}`,
        };
    }
    if (reviewingToolCalls.length > 1) {
        return {
            kind: "reviewing_tool_call",
            label: `Reviewing ${String(reviewingToolCalls.length)} tools`,
        };
    }
    const toolCalls = activity.toolCalls ?? [];
    if (toolCalls.length === 1) {
        const only = toolCalls[0]!;
        return {
            kind: "executing_tool_call",
            label:
                only.status !== undefined && only.status.length > 0
                    ? only.status
                    : `Running ${only.toolName}`,
        };
    }
    if (toolCalls.length > 1) {
        return { kind: "executing_tool_call", label: `Running ${toolCalls.length} tools` };
    }
    return { kind: "thinking", label: "Thinking" };
}

/** Drops empty collections so an unchanged activity compares equal by value. */
function normalize(activity: SessionActivity): SessionActivity {
    const normalized = { ...activity };
    if (normalized.toolCalls?.length === 0) delete normalized.toolCalls;
    if (normalized.reviewingToolCalls?.length === 0) delete normalized.reviewingToolCalls;
    if (normalized.pendingInputRequestIds?.length === 0) delete normalized.pendingInputRequestIds;
    return normalized;
}
