/**
 * Messages and runs: what the user sends, and the work the agent does in response.
 *
 * One message shape carries the whole conversation — history, send acceptances,
 * and events all speak it.
 */

import { type Static, Type } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    Nullable,
    timestampSchema,
    type Cuid2,
    type EventCursor,
    type MessageMode,
    type Timestamp,
} from "./common.js";
import type { UsageBreakdown } from "./usage.js";

/** One read the exploration performed: a listing, a file read, or a search. */
export const explorationOperationSchema = Type.Union([
    Type.Object({ kind: Type.Literal("list"), target: Type.String() }),
    Type.Object({ kind: Type.Literal("read"), name: Type.String() }),
    Type.Object({
        command: Type.String(),
        kind: Type.Literal("search"),
        path: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
    }),
]);

/** One read the exploration performed: a listing, a file read, or a search. */
export type ExplorationOperation = Static<typeof explorationOperationSchema>;

/** Reading around the codebase: listings, file reads, and searches. */
export const explorationPresentationSchema = Type.Object({
    operations: Type.Array(explorationOperationSchema),
    type: Type.Literal("exploration"),
});

/** Reading around the codebase: listings, file reads, and searches. */
export type ExplorationPresentation = Static<typeof explorationPresentationSchema>;

/** A shell command; `output` arrives on completion. */
export const execCommandPresentationSchema = Type.Object({
    command: Type.String(),
    output: Type.Optional(Nullable(Type.String())),
    /** Set when the command kept running and became a background terminal. */
    terminalId: Type.Optional(Nullable(cuid2Schema)),
    type: Type.Literal("exec_command"),
});

/** A shell command; `output` arrives on completion. */
export type ExecCommandPresentation = Static<typeof execCommandPresentationSchema>;

/** Input typed into an existing background terminal. */
export const backgroundTerminalInteractionPresentationSchema = Type.Object({
    /** What the terminal is running. */
    command: Type.String(),
    /** What was typed into it. */
    input: Type.String(),
    terminalId: cuid2Schema,
    type: Type.Literal("background_terminal_interaction"),
});

/** Input typed into an existing background terminal. */
export type BackgroundTerminalInteractionPresentation = Static<
    typeof backgroundTerminalInteractionPresentationSchema
>;

/** One line of a hunk. */
export const fileDiffLineSchema = Type.Object({
    kind: Type.Union([Type.Literal("context"), Type.Literal("add"), Type.Literal("delete")]),
    text: Type.String(),
});

/** One line of a hunk. */
export type FileDiffLine = Static<typeof fileDiffLineSchema>;

/** A contiguous run of diff lines, numbered against both sides. */
export const fileDiffHunkSchema = Type.Object({
    lines: Type.Array(fileDiffLineSchema),
    newStart: Type.Integer({ minimum: 0 }),
    oldStart: Type.Integer({ minimum: 0 }),
});

/** A contiguous run of diff lines, numbered against both sides. */
export type FileDiffHunk = Static<typeof fileDiffHunkSchema>;

/** One file's changes inside a diff presentation. */
export const fileDiffSchema = Type.Object({
    added: Type.Integer({ minimum: 0 }),
    deleted: Type.Integer({ minimum: 0 }),
    hunks: Type.Array(fileDiffHunkSchema),
    kind: Type.Union([Type.Literal("add"), Type.Literal("delete"), Type.Literal("update")]),
    /** For syntax highlighting, when the daemon could name the language. */
    language: Type.Optional(Type.String()),
    /** How many lines this file's hunks left out. */
    omittedLines: Type.Optional(Type.Integer({ minimum: 0 })),
    path: Type.String(),
});

/** One file's changes inside a diff presentation. */
export type FileDiff = Static<typeof fileDiffSchema>;

/** File changes, one or many files per call. */
export const fileDiffPresentationSchema = Type.Object({
    files: Type.Array(fileDiffSchema),
    /** How many files the call changed but the presentation left out. */
    omittedFiles: Type.Optional(Type.Integer({ minimum: 0 })),
    type: Type.Literal("file_diff"),
});

/** File changes, one or many files per call. */
export type FileDiffPresentation = Static<typeof fileDiffPresentationSchema>;

/** One source a search drew from. */
export const searchSourceSchema = Type.Object({ title: Type.String(), url: Type.String() });

/** One source a search drew from. */
export type SearchSource = Static<typeof searchSourceSchema>;

/** A web or X search; `sources` arrives on completion. */
export const searchPresentationSchema = Type.Object({
    query: Type.String(),
    sources: Type.Optional(Type.Array(searchSourceSchema)),
    target: Type.Union([Type.Literal("web"), Type.Literal("x")]),
    type: Type.Literal("search"),
});

/** A web or X search; `sources` arrives on completion. */
export type SearchPresentation = Static<typeof searchPresentationSchema>;

/** Every display-ready tool-call presentation the client understands. */
export const toolPresentationSchema = Type.Union([
    explorationPresentationSchema,
    execCommandPresentationSchema,
    backgroundTerminalInteractionPresentationSchema,
    fileDiffPresentationSchema,
    searchPresentationSchema,
]);

/** Every display-ready tool-call presentation the client understands. */
export type ToolPresentation = Static<typeof toolPresentationSchema>;

/** What is in a message, in order. */
export type MessageBlock =
    | TextBlock
    | ImageBlock
    | ReasoningBlock
    | ToolCallBlock
    | CompactionBlock;

/** Stable provenance carried with a message without exposing internal module metadata. */
export interface MessageMetadata {
    /** The provider that produced this message, when it came from inference. */
    providerId?: string;
    /** The model that produced this message, when it came from inference. */
    modelId?: string;
    /** The agent that sent this system-generated message, when one identified itself. */
    senderAgentId?: Cuid2;
}

/** Plain text. */
export interface TextBlock {
    type: "text";
    text: string;
}

/** An image travelling inline with the message. */
export interface ImageBlock {
    type: "image";
    mimeType: string;
    /** Base64 image bytes, travelling inline. */
    data: string;
}

/** The model's thinking summary, when the provider surfaces one. */
export interface ReasoningBlock {
    type: "reasoning";
    text: string;
}

/** Risk assigned by the automatic permission reviewer. */
export type ToolPermissionRisk = "low" | "medium" | "high" | "critical";

/** How strongly the conversation authorized an automatically reviewed action. */
export type ToolPermissionUserAuthorization = "unknown" | "low" | "medium" | "high";

/** The bounded result of reviewing one tool call. */
export type ToolPermissionReview =
    | {
          outcome: "allowed";
          reason: string;
          risk: ToolPermissionRisk;
          userAuthorization: ToolPermissionUserAuthorization;
      }
    | {
          outcome: "denied";
          reason: string;
          risk: ToolPermissionRisk;
          userAuthorization: ToolPermissionUserAuthorization;
      }
    | {
          outcome: "unproven";
          kind: "timed_out" | "unavailable";
          reason: string;
      };

interface ToolCallBlockBase {
    type: "tool_call";
    /** Happy Agent Base's stable CUID2 identity for this invocation. */
    id: string;
    name: string;
    status: "running" | "completed" | "failed";
    /** Raw tool arguments; absent under `omitToolData`. */
    arguments?: Record<string, unknown>;
    /** Raw tool result; absent under `omitToolData` and until the call finishes. */
    result?: Record<string, unknown>;
    /** A typed rendering of what the call did, when the daemon produced one. */
    presentation?: ToolPresentation;
}

/** A tool call that did not cross the automatic-review boundary. */
export interface UnreviewedToolCallBlock extends ToolCallBlockBase {
    elevated?: never;
    review?: never;
}

/** A reviewed tool call, including whether its eventual execution used temporary Full access. */
export interface ReviewedToolCallBlock extends ToolCallBlockBase {
    elevated: boolean;
    review: ToolPermissionReview;
}

/** One tool invocation. Review metadata is present as one complete, discriminated pair. */
export type ToolCallBlock = UnreviewedToolCallBlock | ReviewedToolCallBlock;

/** What requested a context compaction. */
export const compactionTriggerSchema = Type.Union([
    Type.Literal("manual"),
    Type.Literal("automatic"),
]);
export type CompactionTrigger = Static<typeof compactionTriggerSchema>;

const compactionBlockBaseSchema = Type.Object({
    type: Type.Literal("compaction"),
    trigger: compactionTriggerSchema,
    /** Exact provider-measured input context before compaction, when available. */
    tokensBefore: Nullable(Type.Integer({ minimum: 0 })),
    startedAt: timestampSchema,
});

/** A compaction that has started but has not settled. */
export const runningCompactionBlockSchema = Type.Composite([
    compactionBlockBaseSchema,
    Type.Object({
        status: Type.Literal("running"),
        tokensAfter: Type.Null(),
        failureReason: Type.Null(),
        completedAt: Type.Null(),
    }),
]);
export type RunningCompactionBlock = Static<typeof runningCompactionBlockSchema>;

/** A successfully replaced context, optionally measured by a later inference. */
export const completedCompactionBlockSchema = Type.Composite([
    compactionBlockBaseSchema,
    Type.Object({
        status: Type.Literal("completed"),
        tokensAfter: Nullable(Type.Integer({ minimum: 0 })),
        failureReason: Type.Null(),
        completedAt: timestampSchema,
    }),
]);
export type CompletedCompactionBlock = Static<typeof completedCompactionBlockSchema>;

/** A provider failure, cancellation, or interrupted compaction. */
export const failedCompactionBlockSchema = Type.Composite([
    compactionBlockBaseSchema,
    Type.Object({
        status: Type.Literal("failed"),
        tokensAfter: Type.Null(),
        failureReason: Type.String({ minLength: 1, maxLength: 8_192 }),
        completedAt: timestampSchema,
    }),
]);
export type FailedCompactionBlock = Static<typeof failedCompactionBlockSchema>;

/** One typed context-compaction lifecycle inside a durable service message. */
export const compactionBlockSchema = Type.Union([
    runningCompactionBlockSchema,
    completedCompactionBlockSchema,
    failedCompactionBlockSchema,
]);
export type CompactionBlock = Static<typeof compactionBlockSchema>;

/** Whether a message waits behind the current run or interrupts it. */
export type MessageDelivery = "queue" | "steer";

/** A message, whoever produced it. */
export type Message = UserMessage | AgentMessage | SystemMessage | ServiceMessage;

/** Sent by a person. */
export interface UserMessage {
    id: Cuid2;
    role: "user";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
    /** `"pending"` until inference takes the message up. */
    status: "pending" | "accepted";
    delivery: MessageDelivery;
    mode: MessageMode;
    /** `null` while pending; assigned at acceptance and the handle for abort. */
    runId: Cuid2 | null;
}

/** Produced by the model: its text, reasoning, and tool calls. */
export interface AgentMessage {
    id: Cuid2;
    role: "agent";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
}

/** Content the daemon injected into the model's context, when worth showing. */
export interface SystemMessage {
    id: Cuid2;
    role: "system";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
}

/** Operational records the model never saw: compaction, aborts, housekeeping. */
export interface ServiceMessage {
    id: Cuid2;
    role: "service";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
}

/** The exact durable message shape used for one compaction attempt. */
export interface CompactionMessage extends Omit<ServiceMessage, "content"> {
    content: [CompactionBlock];
}

/** The run's outcome. */
export type RunStatus = "running" | "completed" | "aborted" | "failed";
/** Why a run ended; status is the outcome, reason is the cause. */
export type RunReason = "completed" | "steering" | "abort" | "error";

/** The work an agent did in response to a message. */
export interface Run {
    id: Cuid2;
    status: RunStatus;
    reason: RunReason | null;
    startedAt: Timestamp;
    endedAt: Timestamp | null;
    usage: UsageBreakdown;
    costUsd: number | null;
}

/** One whole history group, with its messages oldest first. */
export interface HistoryRun extends Run {
    /** Oldest first. */
    messages: Message[];
}

/** `POST /v0/agents/:agentId/send` */
export interface SendMessageRequest {
    /** Optional client-chosen identity. Reusing it returns the existing message. */
    id?: Cuid2;
    /** The message text. Required. */
    text: string;
    /** Optional rich blocks accompanying the text; image bytes travel inline. */
    content?: MessageBlock[];
    /** Defaults to `"queue"`. On an idle agent the two are identical. */
    delivery?: MessageDelivery;
    /** The model selection and permission mode this message runs with. */
    mode: MessageMode;
}

/** `POST /v0/agents/:agentId/send` */
export interface SendMessageResponse {
    message: UserMessage;
    /** The event cursor at send; streaming from it replays everything this causes. */
    cursor: EventCursor;
}

/** `GET /v0/agents/:agentId/messages` query parameters. */
export interface MessageHistoryQuery {
    /** A run ID; return runs older than it. Cannot be combined with `after`. */
    before?: Cuid2;
    /** A message ID; return the messages that came after it. */
    after?: Cuid2;
    /**
     * A lower bound counted in messages, not an upper one: a page always
     * contains whole runs and may overflow well past it.
     */
    limit?: number;
    /** Drop `arguments` and `result` from tool calls that carry a presentation. */
    omitToolData?: boolean;
}

/** `GET /v0/agents/:agentId/messages` */
export const messageHistoryResponseSchema = Type.Object({
    /** The event cursor captured before the history read. */
    cursor: eventCursorSchema,
    hasMore: Type.Boolean(),
    /** Oldest first, whole runs only. */
    runs: Type.Array(Type.Unsafe<HistoryRun>({ type: "object" })),
});

/** `GET /v0/agents/:agentId/messages` */
export type MessageHistoryResponse = Static<typeof messageHistoryResponseSchema>;
