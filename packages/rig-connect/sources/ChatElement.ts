import type { ToolPresentation } from "./ToolPresentation.js";
import type {
    BackgroundProcess,
    DurableSkillDefinition,
    ExternalToolCall,
    ExternalToolDefinition,
    GitChangeSnapshot,
    McpServerSummary,
    ModelSummary,
    PendingSteeringMessage,
    PermissionReviewState,
    SessionActivity,
    Attachment,
    SessionAgentMetadata,
    SessionExecutionEnvironment,
    SessionGoal,
    SessionInterruption,
    SessionSharedMetadata,
    SessionSharePeerCapability,
    SessionShareMemberState,
    ScheduledMessage,
    SessionStatus,
    SessionTask,
    SessionTokenCount,
    SessionUsageSnapshot,
    ServiceNotice,
    ShellCommandState,
    SubagentSummary,
    Usage,
    UserInputRequest,
    WorkflowRun,
} from "./protocol.js";

/**
 * One row of a conversation.
 *
 * The chat state is a flat, time-ordered list of these. A tool call is its own
 * element rather than something nested inside the message that produced it, so a
 * consumer renders the list in order and never walks a tree.
 */
export type ChatElement =
    | UserMessageElement
    | SystemNoticeElement
    | InferenceElement
    | AgentTextElement
    | AgentAttachmentsElement
    | ThinkingElement
    | ToolCallElement
    | ProviderToolCallElement
    | CompactionElement
    | FailureElement
    | GroupEndElement;

interface BaseChatElement {
    /** Stable for the life of the element; deltas never change it. */
    id: string;
    /** Stable identity of the inference segment this element belongs to. */
    groupId: string;
    /** Daemon run that contains the group. One run may contain several groups. */
    runId: string;
    /** When the element first appeared, in milliseconds since the epoch. */
    createdAt: number;
}

/** Visible immediately after inference starts, before its first output exists. */
export interface InferenceElement extends BaseChatElement {
    kind: "inference";
    state: "waiting";
}

export interface UserMessageElement extends BaseChatElement {
    kind: "user_message";
    /** Durable source identity; consumers never need to parse the element id. */
    messageId: string;
    /** Whether this bubble is still queued to steer the active run. */
    delivery: "pending_steering" | "sent";
    /** This message is background context for the next actionable group. */
    contextOnly?: true;
    friendAuthor?: {
        displayName: string;
        grantEpoch: number;
        kind: "friend";
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    };
    /** Whether this friend's message is queued for, included in, or outside model context. */
    friendMessageContext?: "included" | "overflow" | "pending";
    /** When this message was actually applied as steering, not when it was queued. */
    steeredAt?: number;
    /** Time since the preceding steering or compaction, or since the turn began. */
    steeringElapsedMs?: number;
    /** Time since the real start of the turn, before any steering or compaction. */
    turnElapsedMs?: number;
    /** Present for workflow/subagent news injected by Rig rather than typed by the user. */
    source?: "notification";
    text: string;
    /** Images and other non-text content the user sent. */
    attachments?: readonly { data: string; mediaType: string }[];
}

/** A non-internal system message intended for the person reading the transcript. */
export interface SystemNoticeElement extends BaseChatElement {
    kind: "system_notice";
    /** Optional machine-readable detail; `text` is always the complete fallback. */
    structured?: ServiceNotice;
    text: string;
}

export interface AgentTextElement extends BaseChatElement {
    kind: "agent_text";
    text: string;
    /** False while the model is still producing this text. */
    complete: boolean;
}

/** Prepared media intent committed only when an agent turn finishes successfully. */
export interface AgentAttachmentsElement extends BaseChatElement {
    attachments: readonly Attachment[];
    kind: "agent_attachments";
    messageId: string;
}

export interface ThinkingElement extends BaseChatElement {
    kind: "thinking";
    text: string;
    complete: boolean;
}

export type ToolCallStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted";

export interface ToolCallElement extends BaseChatElement {
    kind: "tool_call";
    toolCallId: string;
    name: string;
    /** Fills in as the model streams the call; complete once `argumentsComplete`. */
    arguments: unknown;
    argumentsComplete: boolean;
    status: ToolCallStatus;
    /** Latest short label the tool reported while running. */
    progress?: string;
    /** Human-readable summary of the result. */
    result?: string;
    /**
     * What the call is doing and what it produced, in application terms.
     *
     * Narrow on `kind`. The call and its result are projected into this one
     * value, so it gains detail as the tool progresses rather than being
     * replaced by a differently shaped one.
     */
    presentation?: ToolPresentation;
    /** Automatic review progress or the complete verdict for this action. */
    permissionReview?: ToolPermissionReviewState;
    /** Set when adjacent calls were issued together, so a UI can draw one unit. */
    toolCallGroupId?: string;
}

export interface ProviderToolCallSource {
    url: string;
    title?: string;
}

/**
 * What a provider ran, in application terms. Narrow on `kind`; an unrecognized
 * provider tool still renders as itself rather than disappearing.
 */
export type ProviderToolCallPresentation =
    | {
          kind: "search";
          target: "web" | "x";
          method?: "keyword" | "semantic";
          query?: string;
          sources: readonly ProviderToolCallSource[];
      }
    | {
          /**
           * A page the provider opened and read. Its own sub-action of a hosted search — the
           * backend searches, then reads what it found — and calling that a search would report
           * work that did not happen.
           */
          kind: "page_read";
          url: string;
      }
    | {
          kind: "provider_tool";
          label: string;
      };

/**
 * A call the provider ran itself, such as Grok's hosted `x_search`.
 *
 * Deliberately not a `ToolCallElement`. Rig never executes one, so it has no
 * permission review, no result, and no execution lifecycle; treating it as an
 * ordinary call would invite a consumer to wait for a completion that cannot
 * arrive. It is evidence that the provider searched, and that is all.
 */
export interface ProviderToolCallElement extends BaseChatElement {
    kind: "provider_tool_call";
    /** Provider-owned call identity, from the `server_toolcall_*` events. */
    providerToolCallId: string;
    /** Raw provider tool name, kept for diagnostics and unknown-tool fallback. */
    name: string;
    /** The call's input, assembled as the provider streams it. */
    argumentsText: string;
    argumentsComplete: boolean;
    /**
     * `interrupted` and `failed` mean the turn ended before the provider reported the result, not
     * that the call was stopped. Nothing can stop one: it runs on the provider's own backend, so
     * these say the outcome is unknown rather than that nothing happened.
     */
    status: "running" | "completed" | "interrupted" | "failed";
    presentation: ProviderToolCallPresentation;
}

export type ToolPermissionReviewState =
    | {
          action: string;
          status: "reviewing";
          toolCallId: string;
      }
    | (PermissionReviewState & { status: "completed" });

export interface CompactionElement extends BaseChatElement {
    kind: "compaction";
    compactionId: string;
    status: "running" | "completed" | "cancelled" | "failed";
    estimatedTokensBefore: number;
    estimatedTokensAfter?: number;
    messagesCompacted?: number;
    /** Exact provider-reported context size before compaction. */
    tokensBefore?: number;
    /** Estimated until the first following inference reports its input/cache usage. */
    tokensAfter?: number;
    tokensAfterExact?: boolean;
    /** Time since the preceding steering or compaction, or since the turn began. */
    steeringElapsedMs?: number;
    /** Time since the real start of the turn, before any steering or compaction. */
    turnElapsedMs?: number;
}

/**
 * One failure inside a group, at the moment it occurred.
 *
 * A failed attempt and the failure that ends the work read as the same line, so
 * they are the same element; `outcome` is what tells them apart. Both belong to
 * the group they happened in, because they are part of the story of answering
 * that one question.
 */
export interface FailureElement extends BaseChatElement {
    kind: "failure";
    /** Whether Rig retried inference, continued after a local failure, or gave up here. */
    outcome: "retried" | "continued" | "failed";
    /** Which attempt this was. Absent for a failure that ended the group. */
    attempt?: number;
    reason: string;
}

/** Why an inference group stopped: it finished, or the user or a failure ended it. */
export type GroupEndReason = "completed" | "steering" | "compaction" | "abort" | "error";

/**
 * The last element of a group.
 *
 * Every group has exactly one, and it states how the group ended. A consumer
 * never has to infer completion from silence. A run steered or compacted part
 * way through holds several groups, and so several of these.
 */
export interface GroupEndElement extends BaseChatElement {
    kind: "group_end";
    /** Present when this group is the complete standalone manual compaction turn. */
    turnKind?: "compaction";
    outcome: "success" | "error" | "stopped";
    reason: GroupEndReason;
    /** Present when the group ended in an error. */
    errorMessage?: string;
    /** Wall-clock start of this group: the inference, or the boundary before it. */
    startedAt: number;
    /** Authoritative wall-clock completion time. */
    endedAt: number;
    /** Convenience duration derived from `startedAt` and `endedAt`. */
    elapsedMs: number;
    /**
     * Wall-clock start of the whole turn, before any steering or compaction.
     *
     * A group starts over at every boundary, so `elapsedMs` measures only the
     * stretch since the last one. This measures the turn a reader thinks of as
     * one question, and the two differ once a turn has been steered or
     * compacted. A UI shows whichever of the two fits where it is drawing.
     */
    turnStartedAt: number;
    /** Convenience duration derived from `turnStartedAt` and `endedAt`. */
    turnElapsedMs: number;
    usage?: Usage;
}

/** The inference segment currently occupying the session. */
export interface ActiveGroup {
    groupId: string;
    runId: string;
    startedAt: number;
}

/** The turn currently occupying the session. */
export interface ActiveTurn {
    runId: string;
    /** Present when this turn exists solely for a manual context compaction. */
    kind?: "compaction";
    /** Stable across every activity transition, reconnect, retry, and steering segment. */
    startedAt: number;
}

export interface SessionUsage extends SessionUsageSnapshot {
    /** Total billed tokens across every attributed model and permission reviewer. */
    totalTokens: number;
    /** Total reported US-dollar cost across every attributed usage group. */
    totalCost: number;
}

/** Live facts a UI shows next to the conversation. */
export interface SessionState {
    activity: SessionActivity;
    activeGroup?: ActiveGroup;
    activeTurn?: ActiveTurn;
    /**
     * The durable lifecycle status, as opposed to `activity`, which describes
     * only the current moment. A session list needs this to tell a suspended or
     * failed session from an idle one.
     */
    status: SessionStatus;
    /** Whether the session has been archived out of the active list. */
    archived: boolean;
    appendSystemPrompt?: string;
    sessionId: string;
    agentId?: string;
    agent?: SessionAgentMetadata;
    /** Owner-side sharing state, absent for an ordinary or replica session. */
    shared?: SessionSharedMetadata;
    lastEventId?: string;
    projectId: string;
    workspaceId?: string;
    /**
     * Position in the ordered list of the project's chats.
     *
     * Absent for a session that is not in that list. A subagent can be opened
     * and read, but it belongs to the session that started it, not the sidebar.
     */
    orderKey?: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    modelId: string;
    providerId: string;
    title?: string;
    recap?: string;
    titleError?: string;
    titleStatus: "error" | "generating" | "idle" | "ready";
    interruption?: SessionInterruption;
    /** How hard the model is asked to think, when the provider offers a choice. */
    effort?: string;
    serviceTier?: string;
    environment?: SessionExecutionEnvironment;
    secretIds: readonly string[];
    projectSecretIds: readonly string[];
    sessionSecretIds: readonly string[];
    permissionMode: string;
    /** True when the session is pinned to its model and cannot switch. */
    modelLocked: boolean;
    models: readonly ModelSummary[];
    pendingUserInputs: readonly UserInputRequest[];
    pendingSteeringMessages: readonly PendingSteeringMessage[];
    tasks: readonly SessionTask[];
    goal?: SessionGoal;
    subagents: readonly SubagentSummary[];
    backgroundProcesses: readonly BackgroundProcess[];
    shellCommands: readonly ShellCommandState[];
    systemPrompt?: string;
    mcpServers: readonly McpServerSummary[];
    workflowsEnabled: boolean;
    workflows: readonly WorkflowRun[];
    externalTools: readonly ExternalToolDefinition[];
    skills: readonly DurableSkillDefinition[];
    pendingExternalToolCalls: readonly ExternalToolCall[];
    scheduledMessages: readonly ScheduledMessage[];
    permissionReviews: readonly PermissionReviewState[];
    git?: GitChangeSnapshot;
    tokens?: SessionTokenCount;
    /** Complete usage/cost/context/quota state maintained from the same session stream. */
    usage?: SessionUsage;
    /** Whether the library currently has a live connection to the daemon. */
    connection: ConnectionState;
    /**
     * False when the conversation began before the first element in the list.
     * The opening frame carries a bounded window so attaching stays cheap on a
     * long session; a UI that scrolls back asks for the earlier messages.
     */
    transcriptComplete: boolean;
    /**
     * Opaque identity of the oldest loaded message. Pass this exact value to
     * `loadMore`; it changes when an earlier page lands and disappears at the
     * beginning of the conversation.
     */
    loadMoreToken?: string;
    /** True while the page identified by `loadMoreToken` is being fetched. */
    loadingMore: boolean;
    /** Why the last attempt to load more history failed, in words a UI can show. */
    loadMoreError?: string;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

export type MutationAction =
    | "create_workspace"
    | "archive_workspace"
    | "create_session"
    | "fork_session"
    | "send_message"
    | "send_context_message"
    | "stop_run"
    | "switch_model"
    | "set_effort"
    | "set_service_tier"
    | "set_permission_mode"
    | "set_draft"
    | "set_append_system_prompt"
    | "answer_user_input"
    | "set_goal"
    | "set_goal_status"
    | "clear_goal"
    | "compact_session"
    | "reset_session"
    | "rewind_session"
    | "attach_secret"
    | "detach_secret"
    | "run_shell_command"
    | "stop_background_process"
    | "stop_background_processes"
    | "resolve_external_tool_call"
    | "cancel_scheduled_message"
    | "record_activity"
    | "stop_workflow"
    | "set_session_archived"
    | "mark_session_read"
    | "rename_group"
    | "create_session_share"
    | "add_session_share_member"
    | "revoke_session_share_member"
    | "stop_session_share"
    | "set_session_share_friend_messages"
    | "set_session_share_tool_output"
    | "set_session_share_member_capabilities"
    | "apply_happy_cloud_command";

export interface MutationRejectedDelta {
    action: MutationAction;
    /** Ready-to-display explanation of why Rig did not accept the action. */
    message: string;
    mutationId: string;
    type: "mutation_rejected";
}

/** What changed, for a consumer that reacts to events rather than re-rendering. */
export type ChatDelta =
    | { type: "elements_changed"; elements: readonly ChatElement[] }
    | { type: "session_changed"; session: SessionState }
    | { type: "turn_started"; runId: string; startedAt: number; kind?: "compaction" }
    | {
          type: "turn_ended";
          runId: string;
          outcome: GroupEndElement["outcome"];
          startedAt: number;
          endedAt: number;
          kind?: "compaction";
      }
    | { type: "group_started"; groupId: string; runId: string; startedAt: number }
    | {
          type: "group_ended";
          groupId: string;
          runId: string;
          outcome: GroupEndElement["outcome"];
          reason: GroupEndReason;
          startedAt: number;
          endedAt: number;
          kind?: "compaction";
      }
    | { type: "compaction_started"; compactionId: string }
    | { type: "compaction_finished"; compactionId: string }
    | { type: "retry_started"; attempt: number; reason: string }
    | { type: "retry_finished" }
    | { type: "connection_changed"; connection: ConnectionState }
    | {
          type: "session_share_member_capabilities_changed";
          capabilities: readonly SessionSharePeerCapability[];
          /** Ready-to-show English, never the raw capability identifiers. */
          capabilitiesDescription: string;
          memberState: SessionShareMemberState;
          shareId: string;
          shareMemberId: string;
      }
    | MutationRejectedDelta;
