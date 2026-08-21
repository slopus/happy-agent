import type { SessionAgentType, SessionScope } from "./SessionProtocol.js";

/**
 * How much of Happy Terminal one timeline covers.
 *
 * A global timeline covers every agent Happy Terminal knows about. A project timeline
 * reaches every workspace inside it and every chat inside those, a workspace
 * timeline stops at that worktree, and a session timeline covers one chat
 * together with the subagents it started.
 *
 * A global timeline grows with everything Happy Terminal has ever run, so pair it with
 * `since` when only recent work is wanted.
 */
export type TimelineScope =
    | { kind: "global" }
    | { kind: "project"; projectId: string }
    | { kind: "session"; sessionId: string }
    | { kind: "workspace"; projectId: string; workspaceId: string };

/**
 * What an agent was doing across one stretch of wall-clock time.
 *
 * `working` is a run from the moment it started until it stopped. `waiting` is
 * the gap after a run in which the agent had nothing to do but wait for the
 * person. `asking` is an open question the agent put to the person, which
 * overlaps the run that asked it.
 */
export type TimelineSpanKind = "asking" | "waiting" | "working";

/**
 * How a span of work came to an end.
 *
 * `interrupted` means no ending was ever recorded — the daemon stopped before
 * the run did — which is the truth rather than a guess about what happened.
 */
export type TimelineSpanOutcome =
    | "aborted"
    | "answered"
    | "cancelled"
    | "completed"
    | "error"
    | "interrupted";

export interface TimelineSpan {
    /** Milliseconds since the epoch, even though a chart of these reads in minutes. */
    startedAt: number;
    /** Absent while the span is still open. */
    endedAt?: number;
    kind: TimelineSpanKind;
    /** Absent while the span is still open. */
    outcome?: TimelineSpanOutcome;
    /** The question this span is about, for an `asking` span. */
    requestId?: string;
    /** The run this span belongs to, for a `working` span. */
    runId?: string;
}

/** One agent's row in the chart, with the spans that make up its bar. */
export interface TimelineAgent {
    agentId: string;
    /** When the agent came into being, which may precede its first span. */
    createdAt: number;
    depth: number;
    /** The human-readable label to draw on the row. */
    label: string;
    modelId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    scope: SessionScope;
    providerId: string;
    sessionId: string;
    spans: readonly TimelineSpan[];
    type: SessionAgentType;
}

export interface GetTimelineRequest {
    /** Include archived chats, which are left out by default. */
    includeArchived?: boolean;
    scope: TimelineScope;
    /** Drop spans that ended before this moment, in milliseconds. */
    since?: number;
}

export interface GetTimelineResponse {
    /**
     * Flat, so the client joins the tree once rather than the daemon shaping it.
     * Ordered by when each agent was created.
     */
    agents: readonly TimelineAgent[];
    /** The live-stream position this timeline reflects. */
    cursor: string;
    scope: TimelineScope;
}
