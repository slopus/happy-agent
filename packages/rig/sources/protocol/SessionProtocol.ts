import { Type, type Static } from "@sinclair/typebox";

import type {
    AgentCompactionResult,
    AgentLoopEvent,
    AgentSnapshot,
    ContentBlock,
} from "../agent/index.js";
import type { AgentMessage, Message, SystemMessage, UserMessage } from "../agent/types.js";
import type { Attachment } from "./Attachment.js";
import type { Model, ProviderError, ServiceTier, StopReason, Usage } from "@slopus/rig-execution";
import {
    MAX_INFERENCE_MAX_RETRIES,
    type ProviderModelCompatibilityType,
    type ProviderQuota,
    type ProviderUsage,
} from "@slopus/happy-providers";
import type { PermissionMode } from "../permissions/index.js";
import type { UserInputRequest, UserInputResponse } from "../user-input/index.js";
import type { McpServerSummary } from "../mcp/index.js";
import type { SessionTask } from "../tasks/index.js";
import type { WorkflowRun, WorkflowRunUpdate } from "../workflows/index.js";
import type { ChangeGoalStatusRequest, CreateGoalRequest, SessionGoal } from "../goals/index.js";
import type { EventId } from "./EventId.js";
import type { GitChangeSnapshot, PresenceSnapshot } from "./ProjectProtocol.js";
import type { DockerExecutionConfig } from "../execution/DockerExecutionConfig.js";
import type { SessionExecutionEnvironment } from "../execution/SessionExecutionEnvironment.js";
import type { BashSessionActivity, BashSessionSnapshot } from "../agent/context/BashContext.js";
import type {
    EnvironmentSecretRegistration,
    EnvironmentSecretUpdate,
    SecretAttachmentScope,
    SecretReference,
} from "../secrets/index.js";
import type {
    ExternalToolCall,
    ExternalToolCallResolution,
    ExternalToolDefinition,
    ResolveExternalToolCallResponse,
} from "../external-tools/index.js";
import type { DurableSkillDefinition } from "../external-skills/index.js";
import type { ScheduledMessage } from "../scheduling/index.js";
import { p2pInstanceIdSchema } from "./P2pIdentityProtocol.js";
import { p2pCredentialVisibilitySchema } from "./P2pCredentialProtocol.js";
import { rigProfileIdentitySchema } from "./ProfileProtocol.js";

export type SessionStatus =
    | "idle"
    | "queued"
    | "running"
    | "completed"
    | "aborted"
    | "suspended"
    | "error"
    | "archived";

export type SessionSummaryStatus = SessionStatus;

/**
 * The one collection a visible primary chat belongs to.
 *
 * Replacing this tagged value moves a chat atomically, so a delayed partial update cannot leave it
 * visible in two different trees.
 */
export const sessionScopeSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("project"), projectId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("workspace"),
            projectId: Type.String({ minLength: 1 }),
            workspaceId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { folderId: Type.String({ minLength: 1 }), kind: Type.Literal("folder") },
        { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal("unsorted") }, { additionalProperties: false }),
]);
export type SessionScope = Static<typeof sessionScopeSchema>;

/** Moves a visible chat within the folder tree, or back into Unsorted. */
export const moveSessionRequestSchema = Type.Object(
    {
        afterId: Type.Union([Type.String({ maxLength: 128, minLength: 1 }), Type.Null()]),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        scope: Type.Union([
            Type.Object(
                {
                    folderId: Type.String({ maxLength: 128, minLength: 1 }),
                    kind: Type.Literal("folder"),
                },
                { additionalProperties: false },
            ),
            Type.Object({ kind: Type.Literal("unsorted") }, { additionalProperties: false }),
        ]),
    },
    { additionalProperties: false },
);
export type MoveSessionRequest = Static<typeof moveSessionRequestSchema>;

/**
 * What a session is doing at this moment.
 *
 * `SessionStatus` answers whether a session is busy; this answers what the busy
 * work is, so a client can render a status line without replaying the event log
 * and tracking which streaming blocks are still open.
 */
export type SessionActivityKind =
    | "idle"
    | "queued"
    | "thinking"
    | "generating_message"
    | "generating_tool_call"
    | "reviewing_tool_call"
    | "executing_tool_call"
    | "waiting"
    | "awaiting_input"
    | "compacting"
    | "retrying"
    | "stopped"
    | "error";

export interface SessionActivityToolCall {
    startedAt: number;
    /** Latest short label the tool reported about its own progress. */
    status?: string;
    toolCallId: string;
    toolName: string;
}

export interface SessionActivityPermissionReview {
    action: string;
    startedAt: number;
    toolCallId: string;
    toolName: string;
}

export interface SessionActivityCompaction {
    compactionId: string;
    estimatedTokensBefore: number;
    reason: "context_window" | "manual" | "threshold";
    startedAt: number;
}

export interface SessionActivityRetry {
    attempt: number;
    reason: string;
}

export interface SessionActivityWait {
    dueAt: number;
    startedAt: number;
    toolCallId: string;
}

export interface SessionActivity {
    /** Ready-to-display description of the current work, such as `Running Bash`. */
    label: string;
    kind: SessionActivityKind;
    runId?: string;
    /** When the session entered this activity, in milliseconds since the epoch. */
    since: number;
    compaction?: SessionActivityCompaction;
    /** Requests the session is blocked on, including permission approvals. */
    pendingInputRequestIds?: readonly string[];
    retry?: SessionActivityRetry;
    /** Tool calls whose requested action is currently being reviewed in Auto. */
    reviewingToolCalls?: readonly SessionActivityPermissionReview[];
    wait?: SessionActivityWait;
    /** Tool calls that have started and not yet reported a result. */
    toolCalls?: readonly SessionActivityToolCall[];
}

export type SessionUnreadReason = "attention_needed" | "turn_finished";

export interface SessionTokenCount {
    /** Context window occupied after the latest inference or compaction. */
    lastContextTokens: number;
    /** Cumulative provider-reported usage across all model requests in the session. */
    totalTokens: number;
}

export interface SessionUnreadState {
    reason: SessionUnreadReason;
    since: number;
}

export type SessionTitleStatus = "idle" | "generating" | "ready" | "error";

export type { SessionExecutionEnvironment } from "../execution/SessionExecutionEnvironment.js";

export type SessionInterruptionReason = "crash" | "shutdown";

export type SessionAgentType = "primary" | "subagent";

export interface SessionAgentMetadata {
    depth: number;
    rootSessionId: string;
    type: SessionAgentType;
    description?: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    taskName?: string;
    /**
     * The session that started this visible conversation on the user's behalf. Unlike a subagent
     * parent, a delegator does not own the session: the conversation keeps its own place in the
     * session list, and the user may take it over at any time.
     */
    delegatedBySessionId?: string;
}

export interface SessionInterruption {
    interruptedAt: number;
    message: string;
    reason: SessionInterruptionReason;
    runId?: string;
}

export const providerCredentialProvenanceSchema = Type.Object(
    {
        bindingId: Type.String({ maxLength: 512, minLength: 1 }),
        ownerInstanceId: p2pInstanceIdSchema,
        ownerName: Type.String({ maxLength: 128, minLength: 1 }),
        relation: Type.Union([Type.Literal("owner"), Type.Literal("extra")]),
        sourceProviderId: Type.String({ maxLength: 256, minLength: 1 }),
        visibility: p2pCredentialVisibilitySchema,
    },
    { additionalProperties: false },
);
export type ProviderCredentialProvenance = Static<typeof providerCredentialProvenanceSchema>;

export interface ProviderModelCatalog {
    /**
     * The credential source that makes this provider available in the current
     * session. It is absent for daemon-wide catalogs that have no owner scope.
     */
    credential?: ProviderCredentialProvenance;
    disabledReason?: "not_authenticated" | "not_enabled" | "no_models";
    providerId: string;
    providerType?: ProviderModelCompatibilityType;
    models: readonly Model[];
    serviceTiers?: readonly ServiceTier[];
    /** Human-readable provider source label for owner-scoped catalogs. */
    title?: string;
}

export interface ModelCatalog {
    defaultModelId: string;
    defaultProviderId: string;
    models: readonly Model[];
    providers: readonly ProviderModelCatalog[];
}

export interface DaemonIdentity {
    version: string;
    developmentBuildId?: string;
}

export interface ReadyHealthResponse {
    catalog: ModelCatalog;
    durableGlobalEventQueue: boolean;
    healthy: true;
    identity: DaemonIdentity;
    protocolVersion: number;
    ready: true;
    status: "ready";
}

export interface StartingHealthResponse {
    healthy: true;
    identity: DaemonIdentity;
    protocolVersion: number;
    ready: false;
    status: "starting";
}

export interface ErrorHealthResponse {
    error: string;
    healthy: false;
    identity: DaemonIdentity;
    protocolVersion: number;
    ready: false;
    status: "error";
}

export type HealthResponse = ErrorHealthResponse | ReadyHealthResponse | StartingHealthResponse;

export interface ListModelsResponse {
    catalog: ModelCatalog;
}

export interface DaemonConfig {
    p2p: {
        name: string;
        primaryId?: string;
        role: "primary" | "secondary";
    };
    settings: {
        inferenceMaxRetries: number;
        durableGlobalEventQueue: boolean;
    };
}

export interface GetDaemonConfigResponse {
    config: DaemonConfig;
}

export const updateDaemonConfigRequestSchema = Type.Object(
    {
        p2p: Type.Optional(
            Type.Object(
                {
                    name: Type.String({
                        maxLength: 128,
                        minLength: 1,
                        pattern: "^[^\\u0000-\\u001f\\u007f]+$",
                    }),
                },
                { additionalProperties: false },
            ),
        ),
        settings: Type.Object(
            {
                inferenceMaxRetries: Type.Integer({
                    minimum: 0,
                    maximum: MAX_INFERENCE_MAX_RETRIES,
                }),
                durableGlobalEventQueue: Type.Boolean(),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

export type UpdateDaemonConfigRequest = Static<typeof updateDaemonConfigRequestSchema>;

export type UpdateDaemonConfigResponse = GetDaemonConfigResponse;

/**
 * The user's global AGENTS.md. Every session reads it again before each turn, so a change made
 * here reaches open sessions too. Empty text means the user has no global instructions.
 */
export interface GetGlobalInstructionsResponse {
    instructions: string;
}

export interface UpdateGlobalInstructionsRequest {
    instructions: string;
}

export type UpdateGlobalInstructionsResponse = GetGlobalInstructionsResponse;

export interface PendingSteeringMessage {
    createdAt: number;
    message: UserMessage;
    runId: string;
}

/** The turn currently occupying the session, timed from its original submission. */
export interface SessionActiveTurn {
    runId: string;
    startedAt: number;
    /** Present for a standalone manual context compaction turn. */
    kind?: "compaction";
}

export interface SessionPermissionReview {
    action: string;
    decision: "allow" | "deny";
    fullAccessGranted?: true;
    reason: string;
    risk: "low" | "medium" | "high" | "critical";
    toolCallId: string;
    userAuthorization: "unknown" | "low" | "medium" | "high";
}

export interface ProtocolSession {
    id: string;
    /** What the session is doing at this moment. */
    activity: SessionActivity;
    activeTurn?: SessionActiveTurn;
    agentId: string;
    /** Stable Rig identity whose credentials and usage this session consumes. */
    ownerInstanceId: string;
    /** Human profile whose Git identity this session uses. */
    profileId?: string;
    /** Git state of the session's directory, when it is inside a repository. */
    git?: GitChangeSnapshot;
    archived: boolean;
    /** The only project, workspace, folder, or Unsorted collection containing this chat. */
    scope: SessionScope;
    /** Present exactly when `scope` names a project or workspace. */
    projectId?: string;
    /** Present exactly when `scope` names a workspace. */
    workspaceId?: string;
    /** Present exactly when `scope` names a folder. */
    folderId?: string;
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    appendSystemPrompt?: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    providerId: string;
    permissionMode: PermissionMode;
    modelId: string;
    /** Absent for a session with no place in an ordered list, such as a subagent. */
    orderKey?: string;
    effort?: string;
    serviceTier?: ServiceTier;
    secretIds: readonly string[];
    projectSecretIds: readonly string[];
    sessionSecretIds: readonly string[];
    environment?: SessionExecutionEnvironment;
    modelLocked: boolean;
    /** The owner-scoped provider catalog used to validate and run this session. */
    modelCatalog: ModelCatalog;
    models: readonly Model[];
    status: SessionStatus;
    title?: string;
    titleError?: string;
    titleStatus: SessionTitleStatus;
    recap?: string;
    metadataUpdatedAt?: number;
    metadataRunId?: string;
    interruption?: SessionInterruption;
    lastEventId?: EventId;
    agent: SessionAgentMetadata;
    snapshot: AgentSnapshot;
    pendingUserInputs: readonly UserInputRequest[];
    permissionReviews?: readonly SessionPermissionReview[];
    pendingSteeringMessages?: readonly PendingSteeringMessage[];
    subagents?: readonly SubagentSummary[];
    shellCommands?: readonly ShellCommandState[];
    mcpServers: readonly McpServerSummary[];
    tasks: readonly SessionTask[];
    workflowsEnabled?: boolean;
    workflows?: readonly WorkflowRun[];
    goal?: SessionGoal;
    backgroundProcesses?: readonly BashSessionActivity[];
    cumulativeUsage?: Usage;
    sessionTokenCount?: SessionTokenCount;
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    pendingExternalToolCalls?: readonly ExternalToolCall[];
    scheduledMessages?: readonly ScheduledMessage[];
    systemPrompt?: string;
}

/**
 * An assistant message the model is still producing.
 *
 * Committed transcripts never contain it, so without this a client that attaches
 * mid-turn shows nothing until the message completes.
 */
export interface SessionPartialMessage {
    message: AgentMessage;
    runId: string;
}

/**
 * One turn of the transcript carried in a stream's opening frame.
 *
 * The messages alone do not say where a turn began, how it ended, or how long it
 * took, so a client given only messages has to guess. This states it, which is
 * what lets a client honour the guarantee that every turn ends in a final
 * element even for history it never watched happen.
 */
export interface SessionTranscriptTurn {
    /** Identifies the run, and is the turn identity a client renders against. */
    runId: string;
    /** Present for a standalone manual context compaction turn. */
    kind?: "compaction";
    /** Messages belonging to this turn, in order, by id. */
    messageIds: readonly string[];
    startedAt: number;
    /** Absent while the turn is still running. */
    endedAt?: number;
    /** Absent while the turn is still running. */
    outcome?: "success" | "error" | "stopped";
    errorMessage?: string;
    /** Inference segments inside this run, in start order. */
    groups?: readonly SessionTranscriptGroup[];
}

export interface SessionTranscriptGroup {
    /** The assistant message identity allocated before the first output token. */
    id: string;
    startedAt: number;
    endedAt?: number;
    outcome?: "success" | "error" | "stopped";
    reason?: "completed" | "steering" | "compaction" | "abort" | "error";
    errorMessage?: string;
}

/** A durable service row ordered independently from conversational turns. */
export interface SessionTranscriptNotice {
    createdAt: number;
    eventId: EventId;
    message: SystemMessage;
}

/**
 * The transcript window carried in a stream's opening frame.
 *
 * The window is measured in whole turns, never in messages. A turn is the unit a
 * conversation is read in, and half a turn is not a smaller answer but a broken
 * one: a tool result whose call was cut away renders as an orphan.
 */
export interface SessionTranscriptWindow {
    messages: readonly Message[];
    /** Durable occurrence time of each retained message, keyed by message ID. */
    messageCreatedAt?: Readonly<Record<string, number>>;
    /** Durable event order for messages sharing the same millisecond. */
    messageEventId?: Readonly<Record<string, EventId>>;
    /** When each steering message was actually applied to its run. */
    messageSteeredAt?: Readonly<Record<string, number>>;
    /**
     * The group each boundary message closed, keyed by message ID.
     *
     * A steering message and a compaction both head the group that follows the
     * one they closed. Which that was cannot be read from the clock, because a
     * boundary and the group it opens routinely share a millisecond.
     */
    messageBoundaryGroupId?: Readonly<Record<string, string>>;
    /** The inference group each durable error occurred in, keyed by message ID. */
    messageGroupId?: Readonly<Record<string, string>>;
    notices?: readonly SessionTranscriptNotice[];
    /** True when this bounded window omitted older service notices in its position range. */
    noticesTruncated?: boolean;
    /** Resolved permission facts for tool calls contained in this page. */
    permissionReviews?: readonly SessionPermissionReview[];
    turns: readonly SessionTranscriptTurn[];
    /** False when the conversation began before the first turn in this window. */
    complete: boolean;
}

/**
 * The first frame of a session event stream.
 *
 * It exists so attaching is a single request. A client connecting without a
 * cursor gets the session here and never issues a follow-up call; a client
 * resuming already has the transcript and gets back only the state that cannot
 * be replayed from the durable log.
 */
export interface SessionStreamHello {
    activity: SessionActivity;
    /**
     * Current facts whose intermediate events are intentionally not retained.
     * Present on resume after durable catch-up has been delivered.
     */
    current?: SessionStreamCurrentState;
    /** Complete session usage at the hello cursor; later durable events update it. */
    usage?: GetSessionUsageResponse;
    /**
     * Present only when the client attached without a cursor. Its transcript
     * holds the most recent `SESSION_STREAM_TURN_LIMIT` complete turns, so the
     * cost of attaching is bounded by recent activity rather than by the age of
     * the session.
     */
    session?: ProtocolSession;
    /** Turn boundaries and outcomes for the transcript in `session`. */
    transcript?: SessionTranscriptWindow;
    /** The assistant message currently being generated, when a run is mid-message. */
    partial?: SessionPartialMessage;
    /** The newest event id at the moment the stream opened. */
    lastEventId?: EventId;
    /** True when the client attached with a cursor and is resuming. */
    resumed: boolean;
}

/**
 * A session bootstrapped by request-response rather than by opening a stream.
 *
 * `cursor` is the position in the global live stream that this payload reflects,
 * so a client can replay everything after it and know exactly what the snapshot
 * already contains.
 */
export interface SessionStateResponse extends SessionStreamHello {
    /**
     * The transcript continues what the client holds rather than replacing it.
     *
     * Set only when the client asked to catch up from a message it already has
     * and the daemon could still page forward from there.
     */
    append?: boolean;
    cursor: EventId;
}

export interface SessionStreamCurrentState {
    draft?: string;
    draftUpdatedAt?: number;
    externalTools?: readonly ExternalToolDefinition[];
    git?: GitChangeSnapshot;
    interruption?: SessionInterruption;
    mcpServers: readonly McpServerSummary[];
    pendingExternalToolCalls?: readonly ExternalToolCall[];
    projectSecretIds?: readonly string[];
    secretIds?: readonly string[];
    sessionTokenCount?: SessionTokenCount;
    sessionSecretIds?: readonly string[];
    skills?: readonly DurableSkillDefinition[];
    scheduledMessages?: readonly ScheduledMessage[];
    titleError?: string;
    titleStatus?: SessionTitleStatus;
    workflows?: readonly WorkflowRun[];
    workflowsEnabled?: boolean;
}

/**
 * How many recent turns the stream's opening frame carries.
 *
 * A turn is delivered whole or not at all, so this bounds the window without
 * ever splitting one. The number of messages behind it varies: a turn may be a
 * single reply or a long run of tool calls, and both arrive intact.
 *
 * The snapshot already reflects every event up to `lastEventId`, so a client
 * that attaches without a cursor receives this window and nothing else; the
 * event log is never replayed on top of it.
 */
export const SESSION_STREAM_TURN_LIMIT = 20;
/** Service rows are bounded separately and never consume the conversational turn budget. */
export const SESSION_TRANSCRIPT_NOTICE_LIMIT = 50;

export interface SubagentSummary {
    activeSince?: number;
    agentId: string;
    createdAt: number;
    depth: number;
    description: string;
    elapsedMs?: number;
    id: string;
    latestText?: string;
    modelId: string;
    parentSessionId: string;
    parentToolCallId?: string;
    prompt?: string;
    status: SessionStatus;
    taskName?: string;
    totalTokens?: number;
    sessionTokenCount?: SessionTokenCount;
    updatedAt: number;
    usage?: Usage;
}

export interface SessionSummary {
    id: string;
    /** Stable Rig identity whose credentials and usage this session consumes. */
    ownerInstanceId: string;
    /** Human profile whose Git identity this session uses. */
    profileId?: string;
    archived: boolean;
    /** The only project, workspace, folder, or Unsorted collection containing this chat. */
    scope: SessionScope;
    /** Present exactly when `scope` names a project or workspace. */
    projectId?: string;
    /** Present exactly when `scope` names a workspace. */
    workspaceId?: string;
    /** Present exactly when `scope` names a folder. */
    folderId?: string;
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    providerId: string;
    modelId: string;
    /**
     * Position in the ordered list of a project's chats.
     *
     * Absent for a session that has no place in that list. A subagent belongs to
     * the session that started it, not to the sidebar, so it has no position and
     * must never be given a stand-in one.
     */
    orderKey?: string;
    permissionMode: PermissionMode;
    effort?: string;
    serviceTier?: ServiceTier;
    environment?: SessionExecutionEnvironment;
    status: SessionSummaryStatus;
    title?: string;
    titleError?: string;
    titleStatus: SessionTitleStatus;
    recap?: string;
    sessionTokenCount?: SessionTokenCount;
    metadataUpdatedAt?: number;
    metadataRunId?: string;
    createdAt: number;
    updatedAt: number;
    lastMessageAt?: number;
    /** Ordered identity of the newest session mutation/state event. */
    lastEventId?: EventId;
    /**
     * The session's current activity wait, present while the agent is inside a
     * scheduled `wait` or `wait_until`.
     *
     * Activity is live-only, so this is what tells a client connecting in the
     * middle of a long wait that the session is waiting.
     */
    wait?: SessionActivityWait;
    interruption?: SessionInterruption;
    inboxItems?: readonly {
        answers?: Readonly<Record<string, readonly string[]>>;
        createdAt: number;
        questions: UserInputRequest["questions"];
        requestId: string;
        resolvedAt?: number;
        status: "pending" | "answered";
    }[];
}

export interface CreateSessionRequest {
    apiKey?: string;
    appendSystemPrompt?: string;
    trackUnread?: boolean;
    cwd: string;
    effort?: string;
    serviceTier?: ServiceTier;
    instructions?: string;
    /** Human profile responsible for this session. Required for remote creation. */
    identity?: string;
    /** Refreshes the peer daemon's memory-only GitHub authentication for this managed project. */
    gitSecret?: { kind: "github" };
    modelId?: string;
    providerId?: string;
    permissionMode?: PermissionMode;
    secretIds?: readonly string[];
    workflowsEnabled?: boolean;
    docker?: DockerExecutionConfig;
    local?: boolean;
    /**
     * Explicit non-code destination. When absent, `cwd` resolves to a project or workspace scope.
     * Folder and Unsorted creation derive their own safe working directory.
     */
    scope?: Extract<SessionScope, { kind: "folder" | "unsorted" }>;
    workspaceId?: string;
    /** Client-chosen cuid2 identity for the session. Repeating it returns the same session. */
    id?: string;
    /** Identity to give the project when this directory is not one yet. */
    projectId?: string;
}

export const transferSessionRequestSchema = Type.Object(
    {
        targetWorkspaceId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

export type TransferSessionRequest = Static<typeof transferSessionRequestSchema>;

export interface TransferSessionResponse {
    commit: string;
    session: ProtocolSession;
    state: "succeeded";
}

export interface UpdateSessionRequest {
    appendSystemPrompt: string | null;
    mutationId?: string;
}

export interface ChangePermissionModeRequest {
    permissionMode: PermissionMode;
    mutationId?: string;
}

/**
 * Longest composer draft the daemon stores and mirrors. Drafts are held in one
 * session row and broadcast on every change, so they need an explicit bound.
 */
export const SESSION_DRAFT_MAX_LENGTH = 100_000;

/**
 * How far a client's draft timestamp may trail the daemon's clock before it is
 * treated as that old rather than older still.
 */
export const SESSION_DRAFT_MAX_CLOCK_SKEW_MS = 300_000;

export interface SetSessionDraftRequest {
    /** Draft text, or `null` to clear the draft. */
    draft: string | null;
    /** Identifies the writing client so it can ignore its own echo. */
    origin?: string;
    /**
     * When the user typed this draft, in milliseconds since the epoch. The
     * daemon keeps the newest draft, so a write created before the one already
     * stored is discarded even if it arrives later. Omitting it means now.
     */
    updatedAt?: number;
    mutationId?: string;
}

export interface AttachSecretRequest {
    secretId: string;
    scope?: SecretAttachmentScope;
}

export interface SecretSessionResponse {
    session: ProtocolSession;
}

export type RegisterSecretRequest = EnvironmentSecretRegistration;
export type UpdateSecretRequest = EnvironmentSecretUpdate;
export type SecretSummary = SecretReference;

export interface ListSecretsResponse {
    secrets: readonly SecretSummary[];
}

export interface RegisterSecretResponse {
    secret: SecretSummary;
}

export interface UpdateSecretResponse {
    secret: SecretSummary;
}

export interface UnregisterSecretResponse {
    removed: boolean;
}

export type SetGoalRequest = CreateGoalRequest & { mutationId?: string };

export type ChangeSessionGoalStatusRequest = ChangeGoalStatusRequest & { mutationId?: string };

export interface GoalSessionResponse {
    session: ProtocolSession;
}

export type AnswerUserInputRequest = UserInputResponse & { mutationId?: string };

export interface CreateSessionResponse {
    session: ProtocolSession;
}

export interface ForkSessionResponse {
    session: ProtocolSession;
}

export interface RewindSessionRequest {
    messageId: string;
}

export interface RewindSessionResponse {
    message: UserMessage;
    session: ProtocolSession;
}

export interface CompactSessionResponse {
    result: AgentCompactionResult;
    session: ProtocolSession;
}

export interface ListSessionsResponse {
    sessions: readonly SessionSummary[];
}

export type ListSessionsArchivedFilter = boolean | "all";

export interface ListSessionsOptions {
    archived?: ListSessionsArchivedFilter;
    limit?: number;
}

export interface SessionArchiveResponse {
    session: ProtocolSession;
}

export interface SessionReadResponse {
    session: ProtocolSession;
}

export interface ListSubagentsResponse {
    subagents: readonly SubagentSummary[];
}

export interface SessionUsageGroup {
    kind: "attributed";
    modelId: string;
    providerId: string;
    requestedModelId: string;
    /** Set when these tokens were spent reviewing permissions rather than answering the user. */
    role?: "permission_review";
    usage: Usage;
    responseModel?: string;
}

export interface SessionContextUsage {
    approximate: boolean;
    modelId: string;
    providerId: string;
    requestedModelId: string;
    responseModel?: string;
    totalTokens: number;
}

export interface GetSessionUsageResponse {
    currentProviderId: string;
    groups: readonly SessionUsageGroup[];
    context?: SessionContextUsage;
    quotas: readonly SessionProviderQuota[];
    sessionTokenCount: SessionTokenCount;
}

export interface GetCurrentProviderQuotaResponse {
    currentProviderId: string;
    quota?: ProviderQuota;
}

/** The latest usage reading Rig holds for every configured provider. */
export interface ListProviderUsageResponse {
    providers: readonly ProviderUsageEntry[];
}

export interface ProviderUsageEntry {
    credential?: ProviderCredentialProvenance;
    providerId: string;
    /** The last reading, or null when the provider has never answered. */
    usage: ProviderUsage | null;
    /** When Rig last finished asking, whatever the answer was. */
    checkedAt: number | null;
    /** Why the last attempt produced nothing, when it produced nothing. */
    error: string | null;
}

export interface SessionProviderQuota {
    providerId: string;
    quota: ProviderQuota;
}

export interface StopWorkflowResponse {
    workflow: WorkflowRun;
}

export interface ShutdownServerResponse {
    pid?: number;
    shuttingDown: boolean;
}

export interface StartInspectorResponse {
    inspectorUrl: string;
}

export interface StopInspectorResponse {
    stopped: boolean;
}

export interface ListExternalToolCallsResponse {
    calls: readonly ExternalToolCall[];
}

/** Structured user content accepted by the Agent Base protocol bridge. */
export const submitMessageTextSchema = Type.String({ maxLength: 262_144 });
export const submitMessageDisplayTextSchema = Type.String({ maxLength: 262_144 });
export const submitMessageIdentitySchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^[^\\u0000\\r\\n]+$",
});
export const submitContentBlockSchema = Type.Union([
    Type.Object(
        {
            text: Type.String({ maxLength: 262_144 }),
            type: Type.Literal("text"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            data: Type.String({ maxLength: 16 * 1024 * 1024 }),
            detail: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("original")])),
            mediaType: Type.String({ minLength: 1, maxLength: 256 }),
            type: Type.Literal("image"),
        },
        { additionalProperties: false },
    ),
]);
export const submitContentSchema = Type.Array(submitContentBlockSchema, { maxItems: 256 });

export interface SubmitMessageRequest {
    clientSubmissionId?: string;
    content?: readonly ContentBlock[];
    debug?: boolean;
    displayText?: string;
    interactive?: boolean;
    /** Stable human profile identity. Local unattributed messages use null. */
    identity?: string | null;
    /** Refreshes the peer daemon's memory-only GitHub authentication for this managed project. */
    gitSecret?: { kind: "github" };
    /** Replaces the external function set for this and subsequent runs when present. */
    externalTools?: readonly ExternalToolDefinition[];
    /** Replaces the integration-owned durable skill set when present. */
    skills?: readonly DurableSkillDefinition[];
    /** Replaces Rig's assembled system prompt. Null restores Rig's normal prompt. */
    systemPrompt?: string | null;
    /**
     * Reasoning effort for this and subsequent runs. Applied when this message's run starts, so
     * it never disturbs a run already in progress.
     */
    effort?: string;
    /** Model for this and subsequent runs. Applied when this message's run starts. */
    modelId?: string;
    /** Provider for `modelId`. Inferred from the model when omitted. */
    providerId?: string;
    /**
     * Fast mode for this and subsequent runs. Null turns it off; omitting it changes nothing.
     * Applied when this message's run starts.
     */
    serviceTier?: ServiceTier | null;
    text: string;
    /** Identity used to correlate the optimistic action with its stream echo. */
    mutationId?: string;
}

export const submitContextMessageRequestSchema = Type.Object(
    {
        clientSubmissionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        identity: Type.Optional(rigProfileIdentitySchema),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        text: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

export type SubmitContextMessageRequest = Static<typeof submitContextMessageRequestSchema>;

export interface BroadcastMessageRequest extends SubmitMessageRequest {
    all?: boolean;
    sessionIds?: readonly string[];
}

export interface BroadcastMessageResponse {
    submissions: readonly SubmitMessageResponse[];
}

export type ResolveExternalToolCallRequest = ExternalToolCallResolution;
export type { ResolveExternalToolCallResponse };

export interface SubmitMessageResponse {
    debugDirectory?: string;
    eventId: EventId;
    runId: string;
    sessionId: string;
}

export interface SubmitContextMessageResponse {
    delivery: "context";
    eventId: EventId;
    messageId: string;
    sessionId: string;
}

export interface CancelScheduledMessageResponse {
    cancelled: boolean;
    message?: ScheduledMessage;
}

export interface RecordSessionActivityResponse {
    recorded: true;
}

export interface SessionTerminalHeartbeatRequest {
    connectionId: string;
    focused: boolean;
    targetPid: number;
}

export interface SessionTerminalHeartbeatResponse {
    connected: true;
}

export interface DisconnectSessionTerminalResponse {
    disconnected: boolean;
}

export interface RunShellCommandRequest {
    command: string;
    commandId: string;
}

export interface RunShellCommandResult {
    command: string;
    commandId: string;
    errorMessage?: string;
    exitCode: number | null;
    output: string;
    sessionId?: number;
    timedOut: boolean;
}

export type ShellCommandState =
    | {
          command: string;
          commandId: string;
          sessionId: number;
          status: "running";
      }
    | (RunShellCommandResult & { status: "finished" });

export interface RunningShellCommandResponse {
    command: string;
    commandId: string;
    eventId: EventId;
    sessionId: number;
    status: "running";
}

export type RunShellCommandResponse =
    | RunningShellCommandResponse
    | (RunShellCommandResult & { eventId: EventId; status: "finished" });

export type ReadBackgroundProcessResponse = BashSessionSnapshot;

export interface StopBackgroundProcessResponse {
    process?: BashSessionSnapshot;
    stopped: boolean;
}

export interface SteerMessageRequest extends SubmitMessageRequest {
    clientSubmissionId?: string;
    expectedRunId?: string;
}
export interface SteerMessageResponse extends SubmitMessageResponse {
    delivery: "run" | "steer";
}

export interface ChangeModelRequest {
    effort?: string;
    modelId: string;
    providerId?: string;
    mutationId?: string;
}

export interface ChangeEffortRequest {
    effort?: string;
    mutationId?: string;
}

export interface ChangeServiceTierRequest {
    serviceTier?: ServiceTier;
    mutationId?: string;
}

export interface AbortRunResponse {
    aborted: boolean;
    continued?: boolean;
    eventId?: EventId;
    stoppedProcesses?: number;
}

export interface AbortRunOptions {
    continuePendingSteering?: boolean;
    expectedRunId?: string;
    steeringMessageIds?: readonly string[];
    mutationId?: string;
}

export type SessionEvent =
    | SessionCreatedEvent
    | SessionUpdatedEvent
    | SessionArchiveChangedEvent
    | SessionWorkspaceArchivedEvent
    | MessageSubmittedEvent
    | SteeringAppliedEvent
    | RunStartedEvent
    | AgentStreamEvent
    | AgentMessageEvent
    | SystemNoticeEvent
    | RunFinishedEvent
    | ProviderQuotaObservedEvent
    | RunErrorEvent
    | AbortRequestedEvent
    | SessionResetEvent
    | SessionRewoundEvent
    | SessionStatusChangedEvent
    | SessionTitleChangedEvent
    | SessionActivityChangedEvent
    | SessionContextChangedEvent
    | SessionGitChangedEvent
    | SessionConfigurationChangedEvent
    | PermissionModeChangedEvent
    | SessionDraftChangedEvent
    | SecretsChangedEvent
    | UserInputRequestedEvent
    | UserInputDetachedEvent
    | UserInputResolvedEvent
    | MutationAppliedEvent
    | McpServersChangedEvent
    | TasksChangedEvent
    | GoalChangedEvent
    | SubagentChangedEvent
    | SubagentsSuspendedEvent
    | WorkflowChangedEvent
    | ExternalToolCallRequestedEvent
    | ExternalToolCallResolvedEvent
    | ShellCommandStartedEvent
    | ShellCommandFinishedEvent
    | ScheduledMessageChangedEvent
    | ScheduledMessagesPrunedEvent;

export interface BaseSessionEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    sessionId: string;
    type: TType;
}

export type SessionCreatedEvent = BaseSessionEvent<"session_created", { session: ProtocolSession }>;

/**
 * A current-state refresh. `session.snapshot` never carries transcript or model-context messages;
 * those have their own bounded transcript protocol and durable message rows.
 */
export type SessionUpdatedEvent = BaseSessionEvent<
    "session_updated",
    {
        /**
         * One model-context message introduced by this state transition.
         *
         * This is deliberately singular: full model context remains daemon-owned, while
         * visible history is loaded through the bounded request-response transcript.
         */
        appendedContextMessage?: SystemMessage;
        mutationId?: string;
        session: ProtocolSession;
    }
>;

export type SessionArchiveChangedEvent = BaseSessionEvent<
    "session_archived",
    { archived: boolean; mutationId?: string }
>;

export type SessionWorkspaceArchivedEvent = BaseSessionEvent<
    "session_workspace_archived",
    { reason: "workspace_archived"; workspaceId: string }
>;

export type MessageSubmittedEvent = BaseSessionEvent<
    "message_submitted",
    {
        displayText: string;
        delivery?: "context" | "run" | "steer";
        message: UserMessage;
        mutationId?: string;
        runId: string;
        /**
         * Immutable Agent Base submission identity. Legacy session submissions omit this because
         * they predate the Agent Base protocol bridge.
         */
        submissionFingerprint?: string;
        source?: "notification";
    }
>;

export type SteeringAppliedEvent = BaseSessionEvent<
    "steering_applied",
    {
        messageIds: readonly string[];
        runId: string;
    }
>;

export type RunStartedEvent = BaseSessionEvent<
    "run_started",
    { runId: string; kind?: "compaction" }
>;

export type AgentStreamEvent = BaseSessionEvent<
    "agent_event",
    {
        event: AgentLoopEvent;
        runId: string;
    }
>;

export type AgentMessageEvent = BaseSessionEvent<
    "agent_message",
    {
        message: Message;
        runId: string;
    }
>;

/** A visible service row that has no agent-run lifecycle or model-context effect. */
export type SystemNoticeEvent = BaseSessionEvent<"system_notice", { message: SystemMessage }>;

export type RunFinishedEvent = BaseSessionEvent<
    "run_finished",
    {
        agentRunId?: string;
        /** Atomically decorates the completed turn's final message. */
        attachmentMessageId?: string;
        attachments?: readonly Attachment[];
        /** Present whenever `stopReason` is `error`, so the failure stays readable in history. */
        errorMessage?: string;
        providerError?: ProviderError;
        providerId?: string;
        requestedModelId?: string;
        modelLocked: boolean;
        runId: string;
        stopReason: StopReason;
    }
>;

/**
 * What a provider said about the account while it was already answering this
 * session. It costs no extra request, so it is the freshest thing a client can
 * be told about a quota without asking the vendor.
 */
export type ProviderQuotaObservedEvent = BaseSessionEvent<
    "provider_quota_observed",
    {
        providerId: string;
        quota: ProviderQuota;
    }
>;

export type RunErrorEvent = BaseSessionEvent<
    "run_error",
    {
        errorMessage: string;
        modelLocked: boolean;
        providerError?: ProviderError;
        providerId?: string;
        requestedModelId?: string;
        runId: string;
        startupInterruption?: true;
    }
>;

export type AbortRequestedEvent = BaseSessionEvent<
    "abort_requested",
    {
        continuePendingSteering?: true;
        mutationId?: string;
        runId?: string;
    }
>;

export type ShellCommandFinishedEvent = BaseSessionEvent<
    "shell_command_finished",
    RunShellCommandResult
>;

export type ShellCommandStartedEvent = BaseSessionEvent<
    "shell_command_started",
    {
        command: string;
        commandId: string;
        sessionId: number;
    }
>;

export type SubagentsSuspendedEvent = BaseSessionEvent<
    "subagents_suspended",
    {
        displayText: string;
    }
>;

/**
 * The session's durable lifecycle status changed.
 *
 * This is the persisted status, not the current-moment activity. A client needs
 * both: activity says what the session is doing, while status says whether it is
 * archived, suspended, failed, or simply idle.
 */
export type SessionStatusChangedEvent = BaseSessionEvent<
    "session_status_changed",
    { status: SessionStatus }
>;

export type SessionResetEvent = BaseSessionEvent<
    "session_reset",
    {
        snapshot: AgentSnapshot;
        /**
         * The transcript as it stands after the reset.
         *
         * The snapshot alone carries messages without the runs that produced
         * them, so a client rebuilding from it cannot say where one turn ended
         * and the next began. This keeps a rebuilt transcript as complete as the
         * one an attaching client is given.
         */
        transcript: SessionTranscriptWindow;
    }
>;

export type SessionRewoundEvent = BaseSessionEvent<
    "session_rewound",
    {
        messageId: string;
        snapshot: AgentSnapshot;
        /** The transcript as it stands after the rewind. See `SessionResetEvent`. */
        transcript: SessionTranscriptWindow;
    }
>;

export type SessionTitleChangedEvent = BaseSessionEvent<
    "session_title_changed",
    {
        errorMessage?: string;
        metadataRunId?: string;
        metadataUpdatedAt?: number;
        recap?: string;
        status: SessionTitleStatus;
        title?: string;
    }
>;

/**
 * The session started doing something different.
 *
 * The payload is the complete current activity rather than a description of the
 * change, so a client that just attached can render its status line from the
 * first one of these it sees.
 */
export type SessionActivityChangedEvent = BaseSessionEvent<
    "session_activity_changed",
    { activity: SessionActivity }
>;

export type ScheduledMessageChangedEvent = BaseSessionEvent<
    "scheduled_message_changed",
    { message: ScheduledMessage; mutationId?: string }
>;

export type ScheduledMessagesPrunedEvent = BaseSessionEvent<
    "scheduled_messages_pruned",
    { messageIds: readonly string[] }
>;

/**
 * How much of the context window the conversation now occupies.
 *
 * Rig recomputes this as messages land, so it is reported rather than left for a
 * client to ask about on a timer.
 */
export type SessionContextChangedEvent = BaseSessionEvent<
    "session_context_changed",
    { sessionTokenCount: SessionTokenCount }
>;

/**
 * The Git state of the directory this session runs in.
 *
 * A UI shows the branch and the changed files next to the conversation, so the
 * session stream carries them rather than making a client open the project
 * stream as well and correlate the two.
 */
export type SessionGitChangedEvent = BaseSessionEvent<
    "session_git_changed",
    { git: GitChangeSnapshot }
>;

/** Which parts of the agent configuration one change actually altered. */
export type SessionConfigurationField = "model" | "effort" | "serviceTier";

/**
 * A change to the model, reasoning effort, or fast mode.
 *
 * Several of these can move together, most often when a message carries them, so one event
 * reports everything that changed at once. `changed` names the fields the change actually
 * altered; the remaining fields describe the resulting configuration and are always present so
 * a reader never has to reconstruct them from earlier events. Conversation state does not belong
 * in this event: messages are delivered through the transcript protocol and stored once in the
 * message table.
 */
export type SessionConfigurationChangedEvent = BaseSessionEvent<
    "session_configuration_changed",
    {
        changed: readonly SessionConfigurationField[];
        effort?: string;
        modelId: string;
        providerId: string;
        serviceTier: ServiceTier | null;
        mutationId?: string;
    }
>;

export type PermissionModeChangedEvent = BaseSessionEvent<
    "permission_mode_changed",
    { mutationId?: string; permissionMode: PermissionMode }
>;

/**
 * A composer draft change. The `origin` identifies the client that wrote the
 * draft so that client can ignore the echo of its own keystrokes. `updatedAt`
 * is the daemon-clamped moment the draft was typed; clients compare it against
 * their own unsent edit so the newer message wins rather than the later write.
 */
export type SessionDraftChangedEvent = BaseSessionEvent<
    "session_draft_changed",
    { draft?: string; mutationId?: string; origin?: string; updatedAt: number }
>;

export type SecretsChangedEvent = BaseSessionEvent<
    "secrets_changed",
    {
        projectSecretIds: readonly string[];
        secretIds: readonly string[];
        sessionSecretIds: readonly string[];
        mutationId?: string;
    }
>;

export type UserInputRequestedEvent = BaseSessionEvent<"user_input_requested", UserInputRequest>;

/** Presence stopped an agent from waiting for this question; it stays open in the Inbox. */
export type UserInputDetachedEvent = BaseSessionEvent<
    "user_input_detached",
    { presenceId: string; reason: "away" | "timeout"; requestId: string }
>;

export type UserInputResolvedEvent = BaseSessionEvent<
    "user_input_resolved",
    {
        answers?: UserInputResponse["answers"];
        mutationId?: string;
        requestId: string;
        status: "answered" | "cancelled";
    }
>;

export interface GetPresenceResponse {
    presence: PresenceSnapshot;
}

export interface SetPresenceResponse {
    presence: PresenceSnapshot;
}

export type MutationAppliedEvent = BaseSessionEvent<"mutation_applied", { mutationId: string }>;

export type McpServersChangedEvent = BaseSessionEvent<
    "mcp_servers_changed",
    { servers: readonly McpServerSummary[] }
>;

export type TasksChangedEvent = BaseSessionEvent<
    "tasks_changed",
    { tasks: readonly SessionTask[] }
>;

export type GoalChangedEvent = BaseSessionEvent<
    "goal_changed",
    { goal: SessionGoal | null; mutationId?: string }
>;

export type SubagentChangedEvent = BaseSessionEvent<
    "subagent_changed",
    {
        subagent: SubagentSummary;
    }
>;

export type WorkflowChangedEvent = BaseSessionEvent<
    "workflow_changed",
    {
        update: WorkflowRunUpdate;
    }
>;

export type ExternalToolCallRequestedEvent = BaseSessionEvent<
    "external_tool_call_requested",
    { call: ExternalToolCall }
>;

export type ExternalToolCallResolvedEvent = BaseSessionEvent<
    "external_tool_call_resolved",
    { call: ExternalToolCall }
>;
