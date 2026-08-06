import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import { Executor, parseHostedCapabilities } from "@slopus/rig-execution";
import { areProviderModelsCompatible, type ProviderUsage } from "@slopus/rig-providers";

import { errorToMessage } from "../errorToMessage.js";
import { toLocalDate } from "../executor/toLocalDate.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { assistantMessageToAgentMessage } from "../agent/assistantMessageToAgentMessage.js";
import { agentFolderLabel } from "../agent/agentFolderLabel.js";
import { isInternalMessage } from "../agent/isInternalMessage.js";
import { isExcludedFromModelContext } from "../agent/isExcludedFromModelContext.js";
import { findFirstUserRequestText, findLastAgentResponseText } from "../agent/index.js";
import type {
    AgentContext,
    AgentCommunicationIdentity,
    AgentLoopEvent,
    AgentCompactionResult,
    AgentRunResult,
    AgentSnapshot,
    ContentBlock,
} from "../agent/index.js";
import type { Message, SystemMessage, UserMessage } from "../agent/types.js";
import type { BashSessionExit } from "../agent/context/BashContext.js";
import { BASH_SESSION_STOP_GRACE_MS } from "../agent/context/bashSessionLimits.js";
import type { BashContext } from "../agent/context/BashContext.js";
import type { SlotContext } from "../agent/context/SlotContext.js";
import type { SlotEntryStore } from "../slots/index.js";
import type { WebappStore } from "../webapps/index.js";
import {
    createGoalContinuationPrompt,
    normalizeGoalObjective,
    type ChangeGoalStatusRequest,
    type CreateGoalRequest,
    type SessionGoal,
} from "../goals/index.js";
import type { CodingAssistantRuntime } from "../runtime/CodingAssistantRuntime.js";
import {
    createCodingAssistantAgent,
    type CreateCodingAssistantAgentOptions,
} from "../runtime/createCodingAssistantAgent.js";
import type {
    ChangeEffortRequest,
    AnswerUserInputRequest,
    AbortRunResponse,
    Attachment,
    ChangeModelRequest,
    ChangePermissionModeRequest,
    ChangeServiceTierRequest,
    SessionConfigurationField,
    CreateSessionRequest,
    EventId,
    ModelCatalog,
    ProtocolSession,
    ReadBackgroundProcessResponse,
    RewindSessionResponse,
    RunShellCommandRequest,
    RunShellCommandResponse,
    RunShellCommandResult,
    GitChangeSnapshot,
    SessionEvent,
    SessionActivity,
    SessionActiveTurn,
    SessionAgentMetadata,
    SessionPartialMessage,
    SessionPermissionReview,
    SessionProviderToolCall,
    SessionInterruption,
    SessionStatus,
    SessionSummary,
    SystemNoticePayload,
    SessionTokenCount,
    SessionUnreadState,
    ShellCommandFinishedEvent,
    StopBackgroundProcessResponse,
    SubagentSummary,
    SessionTitleStatus,
    SetSessionDraftRequest,
    SubmitMessageRequest,
    SubmitMessageResponse,
    SubmitContextMessageRequest,
    SubmitContextMessageResponse,
    SteerMessageRequest,
    SteerMessageResponse,
    UpdateSessionRequest,
    SessionTranscriptWindow,
} from "../protocol/index.js";
import {
    SESSION_DRAFT_MAX_LENGTH,
    SESSION_STREAM_TURN_LIMIT,
    SESSION_TRANSCRIPT_NOTICE_LIMIT,
} from "../protocol/index.js";

const RETAINED_SESSION_MESSAGE_LIMIT = 512;
import {
    isTranscriptNoticeEntry,
    sessionTranscriptWindow,
    type TranscriptEntry,
    type TranscriptRunFacts,
} from "./sessionTranscriptWindow.js";
import { clampSessionDraftTimestamp } from "./impl/clampSessionDraftTimestamp.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { sessionUnreadStateAfterEvent } from "./impl/sessionUnreadStateAfterEvent.js";
import { IDLE_SESSION_ACTIVITY, sessionActivityAfterEvent } from "./sessionActivityAfterEvent.js";
import { aggregateSessionTokenCount } from "./usage/aggregateSessionTokenCount.js";
import { sessionTokenCountAfterEvent } from "./usage/sessionTokenCountAfterEvent.js";
import type {
    HostedCapability,
    Model,
    ServiceTier,
    StopReason,
    Usage,
} from "@slopus/rig-execution";
import { createEncryptedAgentTransportScope } from "../executor/createEncryptedAgentTransportScope.js";
import type {
    DurableUserInputCall,
    DurableUserInputOptions,
    UserInputOutcome,
    UserInputRequest,
} from "../user-input/index.js";
import type { CancelAskResult } from "../agent/context/UserInputContext.js";
import { isOpenQuestion } from "../user-input/isOpenQuestion.js";
import type { PresenceState } from "../presence/index.js";
import {
    humanizeWorkflowName,
    serializeWorkflowValue,
    type LaunchWorkflowRequest,
    type WorkflowAgentCacheEntry,
    type WorkflowCheckpoint,
    type WorkflowRun,
    type WorkflowRunUpdate,
} from "../workflows/index.js";
import { createCodeReviewPrompt } from "../review/index.js";
import {
    createMcpTrustUserInputRequest,
    MCP_TRUST_ANSWER,
    mergeMcpTools,
    type McpServerSummary,
    type McpServerTrustRequest,
    type McpToolProvider,
} from "../mcp/index.js";
import type {
    CreateTaskRequest,
    SessionTask,
    UpdateTaskRequest,
    UpdateTaskResult,
} from "../tasks/index.js";
import { SessionTaskList } from "../tasks/index.js";
import {
    DEFAULT_PERMISSION_MODE,
    isPermissionReduction,
    parsePermissionMode,
    type PermissionMode,
} from "../permissions/index.js";
import { createSessionMetadataTranscript } from "./impl/createSessionMetadataTranscript.js";
import { generateSessionMetadata } from "./generateSessionMetadata.js";
import { createAbortRequestKey } from "./impl/createAbortRequestKey.js";
import { createGoalTitle } from "./impl/createGoalTitle.js";
import { formatBackgroundProcessExit } from "./formatBackgroundProcessExit.js";
import { formatShellCommandContext } from "./impl/formatShellCommandContext.js";
import { formatSessionTransferNotice } from "./formatSessionTransferNotice.js";
import { formatSessionTransferFailureNotice } from "./formatSessionTransferFailureNotice.js";
import type { SessionWorkspaceTransferState } from "./sessionWorkspaceTransferState.js";
import { getProviderIdForModel } from "../model-catalog/getProviderIdForModel.js";
import { getProviderIdsForModel } from "../model-catalog/getProviderIdsForModel.js";
import { resolveInitialModelSelection } from "./impl/resolveInitialModelSelection.js";
import { resolveSteeringContinuationMessageIds } from "./impl/resolveSteeringContinuationMessageIds.js";
import { SessionEventLog } from "./SessionEventLog.js";
import { isTransientInferenceSessionEvent } from "./impl/isTransientInferenceSessionEvent.js";
import { affectsSessionUsage } from "./impl/affectsSessionUsage.js";
import { providerUsageToClaudeQuota } from "../executor/providerUsageToClaudeQuota.js";
import type { AgentSessionManager } from "./AgentSessionManager.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { summarizeDockerExecution } from "../execution/index.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import {
    addUsage,
    aggregateSessionUsage,
    type SessionUsageGroup,
    type SessionUsageSummary,
    zeroUsage,
} from "./usage/index.js";
import { createRequestDebugDirectory, DebugLog } from "../debug/index.js";
import { SecretRegistry, SessionSecretContext } from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import {
    createExternalTool,
    externalToolResolutionToContent,
    replaceExternalTools,
    type ExternalToolCall,
    type ExternalToolCallResolution,
    type ExternalToolDefinition,
    type ExternalToolInstallation,
    type ResolveExternalToolCallResponse,
} from "../external-tools/index.js";
import { createErrorMessage } from "../agent/createErrorMessage.js";
import { createErrorToolResultBlock } from "../agent/createErrorToolResultBlock.js";
import { createModelSwitchHistoryMessage } from "../agent/createModelSwitchHistoryMessage.js";
import { createToolResultBlock } from "../agent/createToolResultBlock.js";
import type { AgentMessage, ErrorMessage, ToolCallBlock, ToolResultBlock } from "../agent/types.js";
import { isCodexV2CollaborationModel } from "../agent/tools/codex/isCodexV2CollaborationModel.js";
import { createDurableSkillTool, type DurableSkillDefinition } from "../external-skills/index.js";
import type {
    DurableWait,
    DurableWaitRequest,
    ScheduledMessage,
    ScheduleMessageRequest,
    WaitResult,
} from "../scheduling/index.js";

const MAX_RETAINED_EXTERNAL_TOOL_CALLS = 1_000;
const MAX_RETAINED_DURABLE_USER_INPUTS = 1_000;
const MAX_RETAINED_DURABLE_WAITS = 1_000;
const MAX_RETAINED_SETTLED_SCHEDULED_MESSAGES = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const SESSION_METADATA_TIMEOUT_MS = 30_000;
const WORKSPACE_READINESS_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

export interface PersistedSessionMessage {
    isPartial: boolean;
    message: Message;
    position: number;
    runId?: string;
}

export interface PersistedPendingContextMessage {
    anchorRunId: string;
    createdAt: number;
    message: UserMessage;
    position: number;
}

export interface FriendContextDrainLimits {
    maxBytes: number;
    maxEstimatedTokens: number;
    maxMessages: number;
}

export const DEFAULT_FRIEND_CONTEXT_DRAIN_LIMITS: FriendContextDrainLimits = {
    maxBytes: 64 * 1024,
    maxEstimatedTokens: 16_000,
    maxMessages: 32,
};

/**
 * The durable result of selecting friend context for one owner turn.
 *
 * Persistence owns the toggle check, newest-first budget selection, disposition updates, and
 * removal from the pending-context store in one transaction. Selected messages are returned in
 * chronological order. When disabled, no rows may be returned or changed.
 */
export interface FriendContextDrainResult {
    enabled: boolean;
    messages: readonly PersistedPendingContextMessage[];
    omittedCount: number;
    omittedMessageIds: readonly string[];
}

export interface PersistedQueuedRun {
    debug?: boolean;
    debugDirectory?: string;
    debugRequestContent?: readonly ContentBlock[];
    displayText: string;
    effort?: string;
    modelId?: string;
    providerId?: string;
    serviceTier?: ServiceTier | null;
    interactive?: boolean;
    kind: "goal" | "user";
    runId: string;
    text: string;
    userMessage: UserMessage;
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    systemPrompt?: string | null;
}

interface SessionSubmitMessageRequest extends SubmitMessageRequest {
    agentSource?: UserMessage["agentSource"];
    agentMessageTriggerTurn?: boolean;
    encryptedAgentMessage?: {
        author: string;
        recipient: string;
        header: string;
        encryptedContent: string;
    };
    provenance?: "agent";
}

export interface PersistedSessionState {
    activeSince?: number;
    activeRunId?: string;
    agent: SessionAgentMetadata;
    agentId: string;
    archived?: boolean;
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    appendSystemPrompt?: string;
    cwd: string;
    docker?: DockerExecutionConfig;
    draft?: string;
    draftUpdatedAt?: number;
    elapsedMs?: number;
    contextMessages?: readonly Message[];
    createdAt?: number;
    effort?: string;
    serviceTier?: ServiceTier;
    id: string;
    instructions?: string;
    goal?: SessionGoal;
    interruption?: SessionInterruption;
    lastMessageAt?: number;
    metadataRunId?: string;
    metadataUpdatedAt?: number;
    messages: readonly PersistedSessionMessage[];
    modelId: string;
    models: readonly Model[];
    orderKey: string;
    providerId: string;
    permissionMode: PermissionMode;
    permissionReviews?: readonly SessionPermissionReview[];
    pendingContextMessages?: readonly PersistedPendingContextMessage[];
    projectId?: string;
    workspaceId?: string;
    secretIds?: readonly string[];
    queuedRuns: readonly PersistedQueuedRun[];
    recap?: string;
    nextTaskId: number;
    status: SessionStatus;
    tasks: readonly SessionTask[];
    title?: string;
    titleError?: string;
    titleStatus: SessionTitleStatus;
    transcriptHasEarlier?: boolean;
    totalTokens?: number;
    lifetimeTotalTokens?: number;
    sessionTokenCount?: SessionTokenCount;
    usage?: Usage;
    usageSummary?: SessionUsageSummary;
    /** The newest session event included in `usageSummary`. */
    usageSummaryEventId?: EventId;
    tools: readonly string[];
    externalToolCalls?: readonly ExternalToolCall[];
    durableUserInputs?: readonly DurableUserInputCall[];
    durableWaits?: readonly DurableWait[];
    scheduledMessages?: readonly ScheduledMessage[];
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    systemPrompt?: string;
    workflows?: readonly PersistedWorkflowRun[];
    workflowsEnabled?: boolean;
    workspaceQueueWaiting?: boolean;
    workspaceTransfer?: SessionWorkspaceTransferState;
}

export interface PersistedWorkflowRun {
    agentCalls: readonly (WorkflowAgentCacheEntry | undefined)[];
    checkpoint?: {
        nextAgentCallIndex: number;
        phase: string;
        snapshotBase64: string;
    };
    state: WorkflowRun;
}

export interface InMemorySessionPersistence {
    acceptQueuedRun?(input: {
        event: Extract<SessionEvent, { type: "message_submitted" }>;
        message: PersistedSessionMessage;
        run: PersistedQueuedRun;
        status: "queued" | "running";
        submittedAt: number;
        workspaceQueueWaiting: boolean;
    }): void;
    clearMessages(sessionId: string): void;
    deleteMessagesFrom(sessionId: string, position: number): void;
    deleteQueuedRun(sessionId: string, runId: string): void;
    failQueuedRun?(input: {
        event: Extract<SessionEvent, { type: "run_error" }>;
        runId: string;
    }): void;
    handoffDurablePermissionToExternalTool?(
        externalCall: ExternalToolCall,
        permissionCall: DurableUserInputCall,
    ): void;
    insertQueuedRun(sessionId: string, run: PersistedQueuedRun): void;
    insertPendingContextMessage?(sessionId: string, pending: PersistedPendingContextMessage): void;
    drainPendingContextMessages?(
        sessionId: string,
        messageIds?: readonly string[],
    ): readonly PersistedPendingContextMessage[];
    drainFriendContextMessages?(input: {
        limits: FriendContextDrainLimits;
        runId: string;
        sessionId: string;
    }): FriendContextDrainResult;
    loadTranscriptPage?(
        sessionId: string,
        turnLimit: number,
        before?: string,
    ): SessionTranscriptWindow | undefined;
    loadTranscriptSince?(
        sessionId: string,
        turnLimit: number,
        after: EventId,
    ): SessionTranscriptWindow | undefined;
    pruneExternalToolCalls?(sessionId: string, retain: number): void;
    pruneDurableUserInputs?(sessionId: string, retain: number): void;
    pruneDurableWaits?(sessionId: string, retain: number): void;
    pruneScheduledMessages?(sessionId: string, retain: number): readonly string[];
    saveSession(state: PersistedSessionState): void;
    startQueuedRun?(input: {
        activeSince: number;
        event: Extract<SessionEvent, { type: "run_started" }>;
        friendLimits: FriendContextDrainLimits;
        regularMessageIds: readonly string[];
        runId: string;
    }): {
        friends: FriendContextDrainResult;
        regular: readonly PersistedPendingContextMessage[];
    };
    setWorkspaceTransferState?(input: {
        contextMessages?: readonly Message[];
        sessionId: string;
        state: SessionWorkspaceTransferState;
    }): void;
    transaction?<T>(body: () => T): T;
    transferWorkspace?(input: {
        contextMessages: readonly Message[];
        cwd: string;
        sessionId: string;
        state: SessionWorkspaceTransferState;
        workspaceId: string;
    }): void;
    upsertMessage(sessionId: string, message: PersistedSessionMessage): void;
    upsertExternalToolCall?(call: ExternalToolCall): void;
    upsertDurableUserInput?(call: DurableUserInputCall): void;
    upsertDurableWait?(wait: DurableWait): void;
    upsertScheduledMessage?(message: ScheduledMessage): void;
    scheduledMessageChanged?(): void;
}

export interface InMemorySessionOptions {
    agentManager?: AgentSessionManager;
    createEventId: () => EventId;
    createRuntime?: (options: CreateCodingAssistantAgentOptions) => CodingAssistantRuntime;
    deferEventNotification?: (notify: () => void) => void;
    emitCreatedEvent?: boolean;
    events?: readonly SessionEvent[];
    initialContextMessages?: readonly Message[];
    id?: string;
    lastEventId?: EventId;
    now?: () => number;
    onInitialTitle?: (metadata: {
        projectId: string;
        sessionId: string;
        title: string;
        workspaceId: string;
    }) => void;
    modelCatalog: ModelCatalog;
    metadata?: SessionAgentMetadata;
    mcpToolProvider?: McpToolProvider;
    onAppendEvent?: (event: SessionEvent) => void;
    orderKey?: string;
    persistence?: InMemorySessionPersistence;
    presence?: { state(): PresenceState };
    request: CreateSessionRequest;
    projectSecretIds?: readonly string[];
    projectId?: string;
    secretRegistry?: SecretRegistry;
    restore?: PersistedSessionState;
    /** The slot and webapp stores this session's agent may drive through its common tools. */
    slotStores?: SessionSlotStores;
    taskDrain?: TaskDrain;
    workspaceFeatures?: WorkspaceFeatures;
    workspaceId?: string;
    /** Durable server decision that gates every runtime and queued run for a managed workspace. */
    workspaceRunReadiness?: (target: {
        cwd: string;
        projectId: string;
        workspaceId: string;
    }) => WorkspaceRunReadiness;
}

export type WorkspaceRunReadiness =
    | { state: "ready" }
    | { retryable?: boolean; state: "waiting" }
    | { message: string; state: "failed" };

export interface SessionSlotStores {
    entries: SlotEntryStore;
    webapps: WebappStore;
}

/** Which parts of Rig's workspace API the agent in this session may use. */
export interface WorkspaceFeatures {
    crossWorkspace: boolean;
    workspaces: boolean;
}

export const DEFAULT_WORKSPACE_FEATURES: WorkspaceFeatures = {
    crossWorkspace: false,
    workspaces: true,
};

interface ActiveRun {
    controller: AbortController;
    debug: boolean;
    kind: PersistedQueuedRun["kind"];
    runId: string;
}

interface MetadataGenerationTarget {
    kind: "initial" | "refined";
    runId: string;
}

interface ExternalToolWaiter {
    reject: (error: Error) => void;
    resolve: (resolution: ExternalToolCallResolution) => void;
}

interface DurableWaitWaiter {
    reject: (error: Error) => void;
    resolve: (result: WaitResult) => void;
}

interface InternalWorkflowRun {
    agentCalls: (WorkflowAgentCacheEntry | undefined)[];
    checkpoint?: WorkflowCheckpoint;
    completion: Promise<WorkflowRun>;
    controller: AbortController;
    resolveCompletion: (run: WorkflowRun) => void;
    state: WorkflowRun;
}

const MAX_WORKFLOW_LOG_CHARS = 4_000;
const MAX_SUBAGENT_INSPECTION_TEXT_CHARS = 32_000;

interface PendingUserInput {
    durable?: DurableUserInputCall;
    onAbort?: () => void;
    /** When presence started counting down the wait for this question. */
    requestedAt: number;
    request: UserInputRequest;
    resolve: (outcome: UserInputOutcome) => void;
    signal?: AbortSignal;
}

interface PartialMessageState {
    messageId: string;
    position: number | undefined;
    runId: string;
}

interface PendingSteeringMessage {
    createdAt: number;
    message: UserMessage;
    runId: string;
}

interface PendingSteeringContinuation {
    cancelled: boolean;
    contextMessageIds: string[];
    messageIds: string[];
    ready: Promise<void>;
    resolveReady: () => void;
}

export interface SessionRunCompletion {
    errorMessage?: string;
    status: "aborted" | "completed" | "error";
}

function completionFromRunFinished(
    event: Extract<SessionEvent, { type: "run_finished" }>,
): SessionRunCompletion {
    if (event.data.stopReason === "error") {
        return {
            errorMessage: event.data.errorMessage ?? "The model response failed.",
            status: "error",
        };
    }
    return {
        status: event.data.stopReason === "aborted" ? "aborted" : "completed",
    };
}

const SUBAGENT_TOKEN_EXHAUSTED_ERROR =
    "The subagent ran out of tokens before returning a response.";

/**
 * The most of a provider's own arguments worth keeping.
 *
 * A search's payload carries its sources, which is what a client renders, but the size of it is
 * the provider's choice rather than Rig's. Keeping a bounded prefix means one unusual response
 * cannot grow the session's durable state without limit; the query, which leads the payload, is
 * never the part that gets cut.
 */
const PROVIDER_TOOL_CALL_ARGUMENTS_LIMIT = 8_192;

function boundedProviderToolCallArguments(argumentsJson: string): string {
    return argumentsJson.length <= PROVIDER_TOOL_CALL_ARGUMENTS_LIMIT
        ? argumentsJson
        : argumentsJson.slice(0, PROVIDER_TOOL_CALL_ARGUMENTS_LIMIT);
}

export class InMemorySession {
    #activeSince: number | undefined;
    readonly events: SessionEventLog;
    readonly id: string;

    #appendSystemPrompt: string | undefined;
    #archived = false;
    #activePartial: PartialMessageState | undefined;
    #activeRun: ActiveRun | undefined;
    #abortInFlight:
        | {
              continuePendingSteering: boolean;
              key: string;
              promise: Promise<AbortRunResponse>;
              runId: string | undefined;
          }
        | undefined;
    #agentManager: AgentSessionManager | undefined;
    #agentMetadata: SessionAgentMetadata;
    #agentId: string;
    #createEventId: () => EventId;
    #createdAt: number;
    #createRuntime: (options: CreateCodingAssistantAgentOptions) => CodingAssistantRuntime;
    #compactionController: AbortController | undefined;
    #compactionRunId: string | undefined;
    #contextMessages: Message[] | undefined;
    #closing = false;
    #compactionActive = false;
    #debugLogs = new Map<string, DebugLog>();
    #draft: string | undefined;
    #draftUpdatedAt: number | undefined;
    #draining: Promise<void> | undefined;
    #elapsedMs = 0;
    #effort: string | undefined;
    #serviceTier: ServiceTier | undefined;
    #goal: SessionGoal | undefined;
    #externalToolCalls = new Map<string, ExternalToolCall>();
    #durableUserInputs = new Map<string, DurableUserInputCall>();
    #durableWaits = new Map<string, DurableWait>();
    #durableWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #durableWaitWaiters = new Map<string, DurableWaitWaiter>();
    #resumingDurableToolRun = false;
    #resumeDurableToolRunAgain = false;
    #externalToolDefinitions: readonly ExternalToolDefinition[] = [];
    #durableSkillDefinitions: readonly DurableSkillDefinition[] = [];
    #externalToolInstallation: ExternalToolInstallation = {
        installed: new Set(),
        shadowed: new Map(),
    };
    #externalToolWaiters = new Map<string, ExternalToolWaiter>();
    #instructions: string | undefined;
    #interruption: SessionInterruption | undefined;
    #lastMessageAt: number | undefined;
    #lifetimeTotalTokens = 0;
    #lastSessionRunId: string | undefined;
    #metadataController: AbortController | undefined;
    #metadataInitialAttempted = false;
    #metadataRefinementAttempted = false;
    #metadataRevision = 0;
    #metadataRunId: string | undefined;
    #metadataSettlement: Promise<void> | undefined;
    #metadataUpdatedAt: number | undefined;
    #messages: PersistedSessionMessage[] = [];
    #messageIndexByPosition = new Map<number, number>();
    #transcriptRuns = new Map<string, PersistedSessionMessage[]>();
    #transcriptRunOrder: string[] = [];
    #transcriptRunIndexes = new Map<string, number>();
    #transcriptPositionRun = new Map<number, string>();
    #transcriptHasEarlier = false;
    /**
     * When each run began and how it ended.
     *
     * Kept as the events arrive so building a transcript window never rescans
     * the log, and bounded to the runs the window can reach.
     */
    #runFacts = new Map<string, TranscriptRunFacts>();
    #permissionReviews = new Map<string, SessionPermissionReview>();
    /**
     * Provider-run calls that started and have not reported back, keyed by the provider's call id.
     *
     * Only the open ones: a call that completed is already durable as its own closing event, and
     * that event is what every reader is built from. This exists so a turn that ends first can
     * write the closing event the provider never sent.
     */
    #openProviderToolCalls = new Map<
        string,
        { arguments: string; createdAt: number; messageId: string; name: string; runId: string }
    >();
    /** The status a client has already been told about. */
    #reportedStatus: SessionStatus | undefined;
    #reportingStatus = false;
    #submittedUserMessages = new Map<string, PersistedSessionMessage>();
    #mcpLoaded = false;
    #mcpServers: readonly McpServerSummary[] = [];
    #mcpToolNames = new Set<string>();
    #mcpToolProvider: McpToolProvider | undefined;
    #mcpToolRelease: (() => Promise<void>) | undefined;
    #modelCatalog: ModelCatalog;
    #modelId: string;
    #models: readonly Model[];
    #now: () => number;
    #onInitialTitle: InMemorySessionOptions["onInitialTitle"];
    #orderKey: string;
    #partialPositions = new Set<number>();
    #pendingContextMessages = new Map<string, PersistedPendingContextMessage>();
    #pendingContextSteering = new Map<string, Set<string>>();
    #pendingSteeringMessages = new Map<string, PendingSteeringMessage>();
    #pendingSteeringContinuations = new Map<string, PendingSteeringContinuation>();
    #pendingUserInputs = new Map<string, PendingUserInput>();
    #persistence: InMemorySessionPersistence | undefined;
    #presence: { state(): PresenceState } | undefined;
    #slotStores: SessionSlotStores | undefined;
    #userInputPresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #providerId: string;
    #projectId: string;
    #permissionMode: PermissionMode;
    #queue: PersistedQueuedRun[] = [];
    #recap: string | undefined;
    #request: CreateSessionRequest;
    #restoredActiveRunId: string | undefined;
    #runtime: CodingAssistantRuntime | undefined;
    #executor: Executor | undefined;
    #secrets: SessionSecretContext;
    #scheduledMessages = new Map<string, ScheduledMessage>();
    #status: SessionStatus = "idle";
    #activity: SessionActivity = IDLE_SESSION_ACTIVITY;
    #reportingActivity = false;
    #git: GitChangeSnapshot | undefined;
    #unread: SessionUnreadState | undefined;
    #suspendedRunIds = new Set<string>();
    #systemPrompt: string | undefined;
    #workspaceId: string | undefined;
    #suspendOnAbort = false;
    #shutdownCleanup: Promise<void> | undefined;
    #shellCommandCompletions = new Map<number, Promise<void>>();
    #shellHistoryRevision = 0;
    #taskList: SessionTaskList;
    #taskDrain: TaskDrain | undefined;
    #title: string | undefined;
    #titleError: string | undefined;
    #titleStatus: SessionTitleStatus = "idle";
    #totalTokens = 0;
    #sessionTokenCount: SessionTokenCount = { lastContextTokens: 0, totalTokens: 0 };
    #usage: Usage = zeroUsage();
    #usageSummaryCache: SessionUsageSummary | undefined;
    #usageSummaryRevision = 0;
    #cachedUsageSummaryRevision = -1;
    #cachedUsageEventRevision = -1;
    #ownedUsageEventRevision = 0;
    #persistedUsageBase: SessionUsageSummary | undefined;
    #usageEventsAfterBase: SessionEvent[] = [];
    #tools: readonly string[] = [];
    #workflowRuns = new Map<string, InternalWorkflowRun>();
    #workflowsEnabled: boolean;
    readonly #workspaceFeatures: WorkspaceFeatures;
    #workspaceArchived = false;
    #workspaceReleaseMetadataBarrier = false;
    #workspaceQueueWaiting = false;
    #workspaceReadinessRetryAttempt = 0;
    #workspaceReadinessRetryTimer: ReturnType<typeof setTimeout> | undefined;
    #workspaceRunReadiness: InMemorySessionOptions["workspaceRunReadiness"];
    #workspaceTransfer: SessionWorkspaceTransferState = { status: "idle" };

    constructor(options: InMemorySessionOptions) {
        this.#agentManager = options.agentManager;
        this.#workspaceFeatures = options.workspaceFeatures ?? DEFAULT_WORKSPACE_FEATURES;
        this.#workspaceRunReadiness = options.workspaceRunReadiness;
        this.#createEventId = options.createEventId;
        this.#createdAt = options.restore?.createdAt ?? (options.now ?? Date.now)();
        this.#createRuntime = options.createRuntime ?? createCodingAssistantAgent;
        this.#now = options.now ?? Date.now;
        this.#onInitialTitle = options.onInitialTitle;
        this.#mcpToolProvider = options.mcpToolProvider;
        this.#modelCatalog = options.modelCatalog;
        this.#persistence = options.persistence;
        this.#presence = options.presence;
        this.#slotStores = options.slotStores;
        this.#request = {
            ...options.request,
            trackUnread: options.restore?.trackUnread ?? options.request.trackUnread ?? false,
            ...(options.request.secretIds === undefined
                ? {}
                : { secretIds: [...options.request.secretIds] }),
            ...(options.request.docker === undefined
                ? {}
                : { docker: { ...options.request.docker } }),
        };
        this.#taskDrain = options.taskDrain;
        this.#workflowsEnabled =
            options.restore?.workflowsEnabled ?? options.request.workflowsEnabled ?? true;
        const secretRegistry = options.secretRegistry ?? new SecretRegistry();
        const secretIds = options.restore?.secretIds ?? options.request.secretIds ?? [];
        if (options.restore === undefined) {
            for (const secretId of secretIds) secretRegistry.reference(secretId);
        }
        this.#secrets = new SessionSecretContext(
            secretRegistry,
            secretIds,
            options.projectSecretIds,
        );
        this.id = options.restore?.id ?? options.id ?? createId();
        this.#agentMetadata = options.restore?.agent ??
            options.metadata ?? {
                depth: 0,
                rootSessionId: this.id,
                type: "primary",
            };
        if (this.#request.docker?.image !== undefined && this.#request.docker.name === undefined) {
            this.#request.docker = {
                ...this.#request.docker,
                name: `rig-${this.#agentMetadata.rootSessionId}`,
            };
        }
        this.#agentId = options.restore?.agentId ?? createId();
        this.#archived = options.restore?.archived === true;
        const requestedModelId =
            options.restore?.modelId ??
            options.request.modelId ??
            this.#modelCatalog.defaultModelId;
        const requestedProviderId =
            options.restore?.providerId ??
            options.request.providerId ??
            this.#modelCatalog.defaultProviderId;
        const selection = resolveInitialModelSelection(
            this.#modelCatalog,
            requestedModelId,
            requestedProviderId,
        );
        this.#modelId = selection.model.id;
        this.#providerId = selection.providerId;
        this.#permissionMode = parsePermissionMode(
            options.restore?.permissionMode ??
                options.request.permissionMode ??
                DEFAULT_PERMISSION_MODE,
        );
        this.#projectId = options.restore?.projectId ?? options.projectId ?? createId();
        this.#workspaceId = options.restore?.workspaceId ?? options.workspaceId;
        // A subagent belongs to the session that started it, not to any ordered
        // list, so it holds no position no matter what a caller or an older
        // stored row supplies. An empty key is how "no position" is stored.
        this.#orderKey = this.isSubagent()
            ? ""
            : (options.restore?.orderKey ?? options.orderKey ?? generateKeyBetween(null, null));
        this.#draft = options.restore?.draft;
        this.#draftUpdatedAt = options.restore?.draftUpdatedAt;
        this.#appendSystemPrompt =
            options.restore?.appendSystemPrompt ?? options.request.appendSystemPrompt;
        this.#systemPrompt = options.restore?.systemPrompt;
        this.#externalToolDefinitions = [...(options.restore?.externalTools ?? [])];
        this.#durableSkillDefinitions = [...(options.restore?.skills ?? [])];
        for (const call of options.restore?.externalToolCalls ?? []) {
            this.#externalToolCalls.set(call.id, cloneExternalToolCall(call));
        }
        for (const call of options.restore?.durableUserInputs ?? []) {
            this.#durableUserInputs.set(call.request.requestId, structuredClone(call));
        }
        for (const wait of options.restore?.durableWaits ?? []) {
            this.#durableWaits.set(wait.id, structuredClone(wait));
        }
        for (const message of options.restore?.scheduledMessages ?? []) {
            this.#scheduledMessages.set(message.id, structuredClone(message));
        }
        const requestedEffort = options.restore?.effort ?? options.request.effort;
        this.#effort =
            requestedEffort !== undefined &&
            selection.model.thinkingLevels.includes(requestedEffort)
                ? requestedEffort
                : selection.model.defaultThinkingLevel;
        const requestedServiceTier = options.restore?.serviceTier ?? options.request.serviceTier;
        if (
            requestedServiceTier !== undefined &&
            !this.#providerSupportsServiceTier(selection.providerId, requestedServiceTier)
        ) {
            this.#serviceTier = undefined;
        } else {
            this.#serviceTier = requestedServiceTier;
        }
        this.#instructions = options.restore?.instructions ?? options.request.instructions;
        this.#goal = options.restore?.goal === undefined ? undefined : { ...options.restore.goal };
        this.#contextMessages =
            options.restore?.contextMessages === undefined
                ? options.initialContextMessages === undefined
                    ? undefined
                    : [...options.initialContextMessages]
                : [...options.restore.contextMessages];
        this.#workspaceTransfer = options.restore?.workspaceTransfer ?? { status: "idle" };
        this.#models = this.#modelsForProvider(this.#providerId);
        this.#status = options.restore?.status ?? "idle";
        // The status a session opens in is already on the snapshot every client
        // reads, so it is recorded as reported and only later changes are
        // announced.
        this.#reportedStatus = this.#status;
        this.#workspaceArchived = this.#status === "archived";
        this.#unread =
            options.restore?.unread === undefined ? undefined : { ...options.restore.unread };
        this.#activeSince = options.restore?.activeSince;
        this.#elapsedMs = options.restore?.elapsedMs ?? 0;
        this.#lastMessageAt = options.restore?.lastMessageAt;
        this.#metadataRunId = options.restore?.metadataRunId;
        this.#metadataUpdatedAt = options.restore?.metadataUpdatedAt;
        this.#recap = options.restore?.recap;
        this.#restoredActiveRunId = options.restore?.activeRunId;
        this.#lastSessionRunId = options.restore?.activeRunId;
        this.#title = options.restore?.title ?? this.#agentMetadata.description;
        this.#titleError = options.restore?.titleError;
        this.#titleStatus =
            options.restore?.titleStatus ??
            (this.#agentMetadata.description !== undefined ? "ready" : "idle");
        this.#metadataInitialAttempted =
            this.#metadataUpdatedAt !== undefined || this.#titleStatus === "error";
        this.#metadataRefinementAttempted = this.#metadataRunId !== undefined;
        this.#totalTokens = options.restore?.totalTokens ?? 0;
        this.#taskList = new SessionTaskList(options.restore?.tasks, options.restore?.nextTaskId);
        this.#tools = options.restore?.tools ?? [];
        this.#interruption = options.restore?.interruption;
        this.#queue = [...(options.restore?.queuedRuns ?? [])];
        this.#workspaceQueueWaiting = options.restore?.workspaceQueueWaiting === true;
        this.#workspaceReleaseMetadataBarrier =
            options.restore !== undefined &&
            options.workspaceId !== undefined &&
            options.restore.activeRunId === undefined &&
            this.#queue.length > 0 &&
            this.#workspaceQueueWaiting;
        for (const pending of options.restore?.pendingContextMessages ?? []) {
            this.#pendingContextMessages.set(pending.message.id, {
                ...pending,
                message: structuredClone(pending.message),
            });
        }
        this.#messages = [...(options.restore?.messages ?? [])].sort(
            (left, right) => left.position - right.position,
        );
        this.#transcriptHasEarlier = options.restore?.transcriptHasEarlier === true;
        this.#rebuildMessagePositionIndex();
        this.#rebuildTranscriptIndex();
        this.#usage =
            options.restore?.usage === undefined
                ? this.#sumCommittedUsage()
                : structuredClone(options.restore.usage);
        this.#lifetimeTotalTokens = options.restore?.lifetimeTotalTokens ?? this.#usage.totalTokens;
        for (const persisted of options.restore?.workflows ?? []) {
            const state = cloneWorkflowRun(persisted.state);
            if (state.status === "running") {
                state.error = "The workflow was interrupted when the local server stopped.";
                state.finishedAt = this.#now();
                state.status = "stopped";
            }
            let resolveCompletion = (_run: WorkflowRun): void => undefined;
            const completion = new Promise<WorkflowRun>((resolve) => {
                resolveCompletion = resolve;
            });
            const internal: InternalWorkflowRun = {
                agentCalls: [...persisted.agentCalls],
                completion,
                controller: new AbortController(),
                resolveCompletion,
                state,
                ...(persisted.checkpoint === undefined
                    ? {}
                    : {
                          checkpoint: {
                              nextAgentCallIndex: persisted.checkpoint.nextAgentCallIndex,
                              phase: persisted.checkpoint.phase,
                              snapshot: new Uint8Array(
                                  Buffer.from(persisted.checkpoint.snapshotBase64, "base64"),
                              ),
                          },
                      }),
            };
            internal.resolveCompletion(cloneWorkflowRun(state));
            this.#workflowRuns.set(state.runId, internal);
        }
        for (const message of this.#messages) {
            if (message.isPartial) {
                this.#partialPositions.add(message.position);
            }
            if (message.message.role === "user" && message.runId !== undefined) {
                this.#submittedUserMessages.set(message.message.id, message);
            }
        }
        const eventLogOptions: ConstructorParameters<typeof SessionEventLog>[0] = {};
        if (options.deferEventNotification !== undefined) {
            eventLogOptions.deferNotification = options.deferEventNotification;
        }
        if (options.events !== undefined) eventLogOptions.events = options.events;
        if (options.lastEventId !== undefined) eventLogOptions.lastEventId = options.lastEventId;
        if (options.onAppendEvent !== undefined) eventLogOptions.onAppend = options.onAppendEvent;
        this.events = new SessionEventLog(eventLogOptions);
        this.#ownedUsageEventRevision = this.events.usageRevision();
        for (const review of options.restore?.permissionReviews ?? []) {
            this.#permissionReviews.set(review.toolCallId, { ...review });
        }
        this.#restoreUserInputPresenceTimers();
        this.#restoreDurableWaitTimers();
        this.#refreshWaitActivity(false);
        for (const event of this.events.all()) {
            this.#recordRunFacts(event);
            this.#recordPermissionReview(event);
            this.#recordProviderToolCall(event);
        }
        if (options.restore?.usage === undefined) {
            this.#usage = this.#sumCommittedUsage();
        }
        if (
            options.restore?.usageSummary === undefined ||
            options.restore.usageSummaryEventId === undefined
        ) {
            this.#sessionTokenCount = aggregateSessionTokenCount(this.events.all());
            // Restore folds the durable log once while it is already hot; opening a
            // stream later reads the cached projection instead of rescanning history.
            this.usage(this.events.all());
        } else {
            this.#persistedUsageBase = structuredClone(options.restore.usageSummary);
            this.#sessionTokenCount = structuredClone(
                options.restore.usageSummary.sessionTokenCount,
            );
            this.#usageEventsAfterBase = this.events
                .all()
                .filter(
                    (event) =>
                        event.id > (options.restore?.usageSummaryEventId ?? "") &&
                        affectsSessionUsage(event),
                );
            for (const event of this.#usageEventsAfterBase) {
                this.#sessionTokenCount =
                    sessionTokenCountAfterEvent(this.#sessionTokenCount, event) ??
                    this.#sessionTokenCount;
            }
            if (this.#usageEventsAfterBase.length === 0) {
                this.#usageSummaryCache = structuredClone(options.restore.usageSummary);
                this.#cachedUsageSummaryRevision = this.#usageSummaryRevision;
                this.#cachedUsageEventRevision = this.events.usageRevision();
            }
        }

        this.#ensureKnownModel(this.#modelId, this.#providerId);
        if (
            this.#workspaceTransfer.status === "scheduled" ||
            this.#workspaceTransfer.status === "transferring"
        ) {
            this.failWorkspaceTransfer(
                this.#workspaceTransfer.targetWorkspaceId,
                new Error(
                    "The session transfer did not happen because the local server stopped before it could finish.",
                ),
                "not_touched",
            );
        } else {
            this.#saveSession();
        }
        if (options.restore === undefined) {
            if (options.emitCreatedEvent !== false) {
                this.emitCreatedEvent();
            }
        } else {
            this.#continueGoalIfIdle();
            if (!this.isSubagent()) this.#restartMetadataSettlement();
        }
    }

    abort(
        options: {
            continuePendingSteering?: boolean;
            expectedRunId?: string;
            mutationId?: string;
            stopDescendants?: boolean;
            steeringMessageIds?: readonly string[];
        } = {},
    ): Promise<AbortRunResponse> {
        if (
            options.expectedRunId !== undefined &&
            (this.#activeRun?.runId ?? this.#restoredActiveRunId) !== options.expectedRunId
        ) {
            return Promise.resolve({ aborted: false });
        }
        const key = createAbortRequestKey(options);
        if (this.#abortInFlight !== undefined) {
            if (this.#abortInFlight.key !== key) {
                if (
                    options.continuePendingSteering !== true &&
                    this.#abortInFlight.continuePendingSteering &&
                    (options.expectedRunId === undefined ||
                        options.expectedRunId === this.#abortInFlight.runId)
                ) {
                    const continuationRunId = this.#abortInFlight.runId;
                    const activeRun = this.#activeRun;
                    if (continuationRunId === undefined || activeRun?.runId !== continuationRunId) {
                        return Promise.resolve({ aborted: false });
                    }
                    const continuation = this.#pendingSteeringContinuations.get(continuationRunId);
                    if (continuation !== undefined) {
                        continuation.cancelled = true;
                        continuation.resolveReady();
                    }
                    activeRun.controller.abort();
                    return this.#abortInFlight.promise.then(
                        ({ continued: _, ...response }) => response,
                    );
                }
                return Promise.reject(
                    new Error("An abort request with different options is already in progress."),
                );
            }
            return this.#abortInFlight.promise;
        }
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        const operation = this.#performAbort(options);
        const tracked = operation.finally(() => {
            if (this.#abortInFlight?.promise === tracked) this.#abortInFlight = undefined;
        });
        this.#abortInFlight = {
            continuePendingSteering: options.continuePendingSteering === true,
            key,
            promise: tracked,
            runId,
        };
        return tracked;
    }

    async #performAbort(options: {
        continuePendingSteering?: boolean;
        expectedRunId?: string;
        mutationId?: string;
        stopDescendants?: boolean;
        steeringMessageIds?: readonly string[];
    }): Promise<AbortRunResponse> {
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        if (options.expectedRunId !== undefined && runId !== options.expectedRunId) {
            return { aborted: false };
        }
        const continuationMessageIds =
            options.continuePendingSteering === true && runId !== undefined
                ? resolveSteeringContinuationMessageIds({
                      events: this.events.since(undefined) ?? [],
                      pendingMessageIds: new Set(
                          [...this.#pendingSteeringMessages].flatMap(([messageId, pending]) =>
                              pending.runId === runId ? [messageId] : [],
                          ),
                      ),
                      requestedMessageIds: options.steeringMessageIds,
                      runId,
                  })
                : undefined;
        const shouldContinuePendingSteering = continuationMessageIds !== undefined;
        if (
            options.continuePendingSteering === true &&
            runId !== undefined &&
            !shouldContinuePendingSteering
        ) {
            return { aborted: false };
        }
        let continuation: PendingSteeringContinuation | undefined;
        if (shouldContinuePendingSteering && runId !== undefined) {
            continuation = this.#pendingSteeringContinuations.get(runId);
            if (continuation === undefined) {
                let resolveReady = () => {};
                const ready = new Promise<void>((resolve) => {
                    resolveReady = resolve;
                });
                continuation = {
                    cancelled: false,
                    contextMessageIds: [],
                    messageIds: continuationMessageIds.filter(
                        (messageId) =>
                            this.#pendingSteeringMessages.get(messageId)?.runId === runId,
                    ),
                    ready,
                    resolveReady,
                };
                this.#pendingSteeringContinuations.set(runId, continuation);
            }
        } else if (runId !== undefined) {
            const pendingContinuation = this.#pendingSteeringContinuations.get(runId);
            if (pendingContinuation !== undefined) {
                pendingContinuation.cancelled = true;
                pendingContinuation.resolveReady();
                this.#pendingSteeringContinuations.delete(runId);
            }
        }
        const stopDescendants =
            options.stopDescendants === false
                ? Promise.resolve(0)
                : (this.#agentManager?.stopDescendants(this.id) ?? Promise.resolve(0));
        const runningProcesses = this.#activeProcessCount();
        if (this.#activeRun === undefined && this.#queue.length === 0 && runningProcesses === 0) {
            if (runId !== undefined && this.hasDurableToolRun()) {
                this.#cancelExternalToolCalls(runId);
                this.#cancelDurableUserInputs(runId);
                this.#cancelDurableWaits(runId);
                this.#restoredActiveRunId = undefined;
                this.#status = "aborted";
                const event = this.#append("abort_requested", { runId });
                await stopDescendants;
                return { aborted: true, eventId: event.id };
            }
            return { aborted: (await stopDescendants) > 0 };
        }

        if (this.#activeRun === undefined && this.#queue.length === 0) {
            const [, stoppedDescendants] = await Promise.all([
                // Nothing is running to interrupt, so this is the user asking
                // for the background work itself to stop.
                this.#killRuntimeProcesses({ includeBackground: true }),
                stopDescendants,
            ]);
            return {
                aborted: stoppedDescendants > 0,
                stoppedProcesses: runningProcesses,
            };
        }

        const interruptedMetadata = this.#metadataSettlement !== undefined;
        this.#clearMetadataSettlement();
        this.#workspaceReleaseMetadataBarrier = false;
        this.#clearWorkspaceReadinessRetry();
        this.#workspaceQueueWaiting = false;
        const discardedQueue = this.#queue;
        const queuedRunIds = discardedQueue.map((queued) => queued.runId);
        for (const queued of discardedQueue) {
            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
        }
        this.#queue = [];
        this.#pauseActiveGoal();
        if (runId !== undefined) {
            this.#cancelExternalToolCalls(runId);
            this.#cancelDurableUserInputs(runId);
            this.#cancelDurableWaits(runId);
        }
        this.#activeRun?.controller.abort();
        this.#restoredActiveRunId = undefined;
        const event = this.#append("abort_requested", {
            ...(shouldContinuePendingSteering ? { continuePendingSteering: true as const } : {}),
            ...(runId === undefined ? {} : { runId }),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        await Promise.all([
            this.#killRuntimeProcesses(),
            stopDescendants,
            ...discardedQueue.map((queued) => this.#closeDebugLog(queued)),
        ]);
        continuation?.resolveReady();
        for (const queuedRunId of queuedRunIds) {
            this.#append("run_error", {
                errorMessage: "The queued run was stopped.",
                modelLocked: this.#modelLocked(),
                runId: queuedRunId,
            });
        }
        const latestQueuedRunId = queuedRunIds.at(-1);
        if (latestQueuedRunId !== undefined && !interruptedMetadata) {
            this.#restartMetadataSettlement();
        }
        return {
            aborted: true,
            ...(shouldContinuePendingSteering && continuation?.cancelled !== true
                ? { continued: true }
                : {}),
            eventId: event.id,
            ...(runningProcesses > 0 ? { stoppedProcesses: runningProcesses } : {}),
        };
    }

    async stopBackgroundProcesses(): Promise<number> {
        const runtime = this.#runtime;
        if (runtime === undefined) return 0;
        const runningProcesses = runtime.context.bash.activeSessionCount?.() ?? 0;
        await runtime.context.bash.killAllSessions?.();
        return runningProcesses;
    }

    async readBackgroundProcess(
        sessionId: number,
        options: { waitMs?: number } = {},
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        const runtime = this.#runtime;
        if (runtime === undefined) return undefined;
        // Watching a background command must not consume output the agent has
        // not read yet, so this observer never advances the delta cursor.
        return runtime.context.bash.readSession(sessionId, { ...options, peek: true });
    }

    async stopBackgroundProcess(sessionId: number): Promise<StopBackgroundProcessResponse> {
        const runtime = this.#runtime;
        if (runtime === undefined) return { stopped: false };
        const process = await runtime.context.bash.killSession(sessionId);
        if (process === undefined) return { stopped: false };
        await this.#shellCommandCompletions.get(sessionId);
        return { process, stopped: true };
    }

    async runShellCommand(request: RunShellCommandRequest): Promise<RunShellCommandResponse> {
        this.#assertAcceptingWork();
        const command = request.command.trim();
        if (command.length === 0) throw new Error("Enter a shell command after !.");

        const historyRevision = this.#shellHistoryRevision;
        const bash = this.#ensureRuntime().context.bash;
        let sessionId: number;
        try {
            sessionId = await bash.startSession({
                command,
                maxOutputBytes: 512_000,
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            const result: RunShellCommandResult = {
                command,
                commandId: request.commandId,
                errorMessage: errorToMessage(error),
                exitCode: null,
                output: errorToMessage(error),
                timedOut: false,
            };
            const event = this.#recordShellCommandResult(result, historyRevision);
            return { ...result, eventId: event.id, status: "finished" };
        }

        // The user ran this, not a turn. Interrupting the agent must not reach
        // in and kill a command the user is watching.
        bash.detachSession?.(sessionId);
        const event = this.#append("shell_command_started", {
            command,
            commandId: request.commandId,
            sessionId,
        });
        const watch = () =>
            this.#watchShellCommand(bash, command, request.commandId, sessionId, historyRevision);
        const watching = this.#taskDrain?.run(watch) ?? watch();
        const completion = watching
            .catch((error: unknown) => {
                if (isDatabaseFailure(error)) throw error;
                this.#recordShellCommandResult(
                    {
                        command,
                        commandId: request.commandId,
                        errorMessage: errorToMessage(error),
                        exitCode: null,
                        output: errorToMessage(error),
                        sessionId,
                        timedOut: false,
                    },
                    historyRevision,
                );
            })
            .finally(() => {
                if (this.#shellCommandCompletions.get(sessionId) === completion) {
                    this.#shellCommandCompletions.delete(sessionId);
                }
            });
        this.#shellCommandCompletions.set(sessionId, completion);

        return {
            command,
            commandId: request.commandId,
            eventId: event.id,
            sessionId,
            status: "running",
        };
    }

    async #watchShellCommand(
        bash: BashContext,
        command: string,
        commandId: string,
        sessionId: number,
        historyRevision: number,
    ): Promise<void> {
        for (;;) {
            const snapshot = await bash.readSession(sessionId, {
                waitMs: 30_000,
            });
            if (snapshot === undefined) {
                throw new Error("The background terminal is no longer available.");
            }
            if (snapshot.status === "running") continue;

            this.#recordShellCommandResult(
                {
                    command,
                    commandId,
                    exitCode: snapshot.exitCode,
                    output: [snapshot.stdout, snapshot.stderr].filter(Boolean).join("\n"),
                    sessionId,
                    timedOut: snapshot.timedOut,
                },
                historyRevision,
            );
            return;
        }
    }

    #recordShellCommandResult(
        result: RunShellCommandResult,
        historyRevision: number,
    ): ShellCommandFinishedEvent {
        if (historyRevision !== this.#shellHistoryRevision) {
            return this.#append("shell_command_finished", result);
        }
        const contextMessage: UserMessage = {
            blocks: [{ type: "text", text: formatShellCommandContext(result) }],
            id: createId(),
            role: "user",
            shellCommandId: result.commandId,
        };
        const runtime = this.#runtime;
        if (runtime === undefined) {
            this.#separateModelContextFromVisibleTranscript();
            this.#contextMessages?.push(contextMessage);
        } else {
            runtime.agent.enqueueMessage(contextMessage);
        }
        this.#storeMessage(
            this.#nextMessagePosition(),
            contextMessage,
            false,
            `shell:${result.commandId}`,
        );
        this.#lastMessageAt = this.#now();

        return this.#append("shell_command_finished", result);
    }

    /**
     * Tells the model that a background command ended.
     *
     * Only the fact, never the output: whatever the command last printed is
     * still there to be read through the usual background-task tools, and
     * pushing it here would drop it into the conversation uninvited.
     */
    #notifyBackgroundProcessExit(exit: BashSessionExit): void {
        const runtime = this.#runtime;
        if (runtime === undefined) return;
        const message: SystemMessage = {
            blocks: [{ type: "text", text: formatBackgroundProcessExit(exit) }],
            id: createId(),
            internal: true,
            role: "system",
        };
        if (this.#activeRun !== undefined && runtime.agent.status === "running") {
            runtime.agent.steerMessage(message);
        } else {
            runtime.agent.enqueueMessage(message);
        }
        this.#append("agent_event", {
            event: {
                command: exit.command,
                exitCode: exit.exitCode,
                processId: exit.sessionId,
                status: exit.status,
                type: "background_process_exited",
            },
            runId: this.#activeRun?.runId ?? this.#lastSessionRunId ?? "background",
        });
    }

    async suspendByParent(): Promise<void> {
        if (!this.isSubagent()) return;
        if (this.#activeRun !== undefined) this.#suspendedRunIds.add(this.#activeRun.runId);
        this.#suspendOnAbort = true;
        await this.abort({ stopDescendants: false });
        this.#status = "suspended";
        if (this.#activeRun === undefined) this.#suspendOnAbort = false;
        this.#saveSession();
    }

    clearSuspension(): void {
        this.#suspendOnAbort = false;
        if (this.#status !== "suspended") return;
        this.#status = "aborted";
        this.#saveSession();
    }

    consumeSuspendedRun(runId: string): boolean {
        return this.#suspendedRunIds.delete(runId);
    }

    recordSubagentsSuspended(subagents: readonly { description: string; path: string }[]): void {
        if (subagents.length === 0) return;
        const count = subagents.length;
        const names = subagents.map((subagent) => subagent.description).join(", ");
        const displayText = `${count} ${count === 1 ? "subagent was" : "subagents were"} suspended: ${names}. They will remain suspended until explicitly resumed or redirected.`;
        this.#ensureRuntime().agent.enqueueMessage({
            blocks: [
                {
                    type: "text",
                    text: [
                        "<subagent-suspension>",
                        "The parent turn was interrupted. These delegated agents were suspended:",
                        ...subagents.map(
                            (subagent) => `- ${subagent.path}: ${subagent.description}`,
                        ),
                        "They will not resume automatically. Use followup_task to continue retained work, or interrupt_agent to leave work stopped.",
                        "</subagent-suspension>",
                    ].join("\n"),
                },
            ],
            id: createId(),
            role: "user",
        });
        this.#append("subagents_suspended", { displayText });
    }

    /**
     * Appends a visible service message without putting operational progress into model context.
     *
     * Notices have their own durable event and message position. They deliberately have no run
     * lifecycle, so they cannot disturb activity, unread state, or an in-flight agent group.
     */
    recordSystemNotice(
        payload: SystemNoticePayload,
        options: { settleArchived?: true } = {},
    ): void {
        if ((this.#archived && options.settleArchived !== true) || this.#workspaceArchived) return;
        const message: SystemMessage = {
            blocks: [{ text: payload.text, type: "text" }],
            context: "excluded",
            id: createId(),
            role: "system",
            ...(payload.structured === undefined ? {} : { structured: payload.structured }),
        };
        const commit = () => {
            this.#storeMessage(this.#nextMessagePosition(), message, false);
            this.#append("system_notice", { message });
        };
        if (this.#persistence?.transaction === undefined) {
            commit();
        } else {
            this.#persistence.transaction(commit);
        }
    }

    agentMetadata(): SessionAgentMetadata {
        return { ...this.#agentMetadata };
    }

    lifetimeTotalTokens(): number {
        return this.#lifetimeTotalTokens;
    }

    usage(events?: readonly SessionEvent[]): SessionUsageSummary {
        const eventRevision = this.events.usageRevision();
        if (
            this.#usageSummaryCache !== undefined &&
            this.#cachedUsageSummaryRevision === this.#usageSummaryRevision &&
            this.#cachedUsageEventRevision === eventRevision
        ) {
            return this.#usageSummaryCache;
        }
        const externallyAppended = this.#ownedUsageEventRevision !== eventRevision;
        const summary =
            this.#persistedUsageBase === undefined || externallyAppended
                ? aggregateSessionUsage(events ?? this.events.all(), {
                      type: this.#agentMetadata.type,
                  })
                : this.#mergePersistedUsage();
        this.#persistedUsageBase = summary;
        this.#usageSummaryCache = summary;
        this.#cachedUsageSummaryRevision = this.#usageSummaryRevision;
        this.#cachedUsageEventRevision = eventRevision;
        this.#ownedUsageEventRevision = eventRevision;
        return summary;
    }

    #mergePersistedUsage(): SessionUsageSummary {
        const base = this.#persistedUsageBase as SessionUsageSummary;
        const latestReset = this.#usageEventsAfterBase.findLastIndex(
            (event) => event.type === "session_reset",
        );
        if (latestReset >= 0) {
            const reset = aggregateSessionUsage(this.#usageEventsAfterBase.slice(latestReset), {
                type: this.#agentMetadata.type,
            });
            const summary = {
                ...reset,
                sessionTokenCount: { ...this.#sessionTokenCount },
            };
            this.#persistedUsageBase = summary;
            this.#usageEventsAfterBase = [];
            return summary;
        }

        const delta = aggregateSessionUsage(this.#usageEventsAfterBase, {
            type: this.#agentMetadata.type,
        });
        const groups = [...base.groups];
        for (const incoming of delta.groups) {
            const key = usageGroupKey(incoming);
            const index = groups.findIndex((known) => usageGroupKey(known) === key);
            if (index === -1) groups.push(incoming);
            else {
                const known = groups[index] as SessionUsageGroup;
                groups[index] = { ...known, usage: addUsage(known.usage, incoming.usage) };
            }
        }
        let currentContext = base.currentContext;
        for (const event of this.#usageEventsAfterBase) {
            if (
                event.type === "session_rewound" ||
                (event.type === "session_configuration_changed" &&
                    event.data.changed.includes("model"))
            ) {
                currentContext = undefined;
            } else if (
                event.type === "agent_message" &&
                event.data.message.role === "agent" &&
                event.data.message.usage !== undefined &&
                event.data.message.contextTokens !== undefined &&
                event.data.message.providerId !== undefined &&
                event.data.message.requestedModelId !== undefined
            ) {
                currentContext = {
                    approximate: false,
                    modelId:
                        event.data.message.responseModel ?? event.data.message.requestedModelId,
                    providerId: event.data.message.providerId,
                    requestedModelId: event.data.message.requestedModelId,
                    ...(event.data.message.responseModel === undefined
                        ? {}
                        : { responseModel: event.data.message.responseModel }),
                    totalTokens: event.data.message.contextTokens,
                };
            } else if (
                event.type === "agent_event" &&
                event.data.event.type === "context_compacted" &&
                currentContext !== undefined
            ) {
                currentContext = {
                    ...currentContext,
                    approximate: true,
                    totalTokens: event.data.event.estimatedTokensAfter,
                };
            }
        }
        const summary: SessionUsageSummary = {
            ...(currentContext === undefined ? {} : { currentContext }),
            groups,
            sessionTokenCount: { ...this.#sessionTokenCount },
        };
        this.#persistedUsageBase = summary;
        this.#usageEventsAfterBase = [];
        return summary;
    }

    encryptedAgentTransportScope(): string | undefined {
        const runtime = this.#ensureRuntime();
        return createEncryptedAgentTransportScope(runtime.executor, runtime.agent.model);
    }

    isCodexV2Collaboration(): boolean {
        const providerType = this.#modelCatalog.providers.find(
            (provider) => provider.providerId === this.#providerId,
        )?.providerType;
        return isCodexV2CollaborationModel(this.#modelId, providerType);
    }

    hasModel(modelId: string, providerId?: string): boolean {
        return getProviderIdForModel(this.#modelCatalog, modelId, providerId) !== undefined;
    }

    effortLevelsForModel(modelId: string, providerId: string): readonly string[] | undefined {
        return this.#modelsForProvider(providerId).find((model) => model.id === modelId)
            ?.thinkingLevels;
    }

    providerIdsForModel(modelId: string): readonly string[] {
        return getProviderIdsForModel(this.#modelCatalog, modelId);
    }

    modelIdsForProvider(providerId: string): readonly string[] {
        return this.#modelsForProvider(providerId).map((model) => model.id);
    }

    hasLocalSettlementWork(): boolean {
        return (
            this.#activeRun !== undefined ||
            this.#queue.length > 0 ||
            this.#compactionActive ||
            [...this.#workflowRuns.values()].some((run) => run.state.status === "running") ||
            (this.#runtime?.context.bash.activeSessionCount?.() ?? 0) > 0
        );
    }

    scheduleWorkspaceTransfer(targetWorkspaceId: string): {
        projectId: string;
        sourceWorkspaceId: string;
    } {
        this.#assertAcceptingWork();
        const sourceWorkspaceId = this.#workspaceTransferSource(targetWorkspaceId);
        if (this.#activeRun === undefined && this.#restoredActiveRunId === undefined) {
            throw new Error("A session transfer can only be scheduled during an active response.");
        }
        if (
            this.#compactionActive ||
            [...this.#workflowRuns.values()].some((run) => run.state.status === "running")
        ) {
            throw new Error(
                "Wait for compaction and workflow runs to finish before transferring this session.",
            );
        }
        this.#setWorkspaceTransferState({ status: "scheduled", targetWorkspaceId });
        return { projectId: this.#projectId, sourceWorkspaceId };
    }

    beginWorkspaceTransfer(
        targetWorkspaceId: string,
        options: { scheduled?: boolean } = {},
    ): { projectId: string; sourceWorkspaceId: string } {
        this.#assertAcceptingWork();
        const sourceWorkspaceId =
            options.scheduled === true
                ? this.#workspaceId
                : this.#workspaceTransferSource(targetWorkspaceId);
        if (sourceWorkspaceId === undefined) {
            throw new Error("Only a session in a managed workspace can be transferred.");
        }
        const active = this.#activeRun !== undefined || this.#restoredActiveRunId !== undefined;
        if (options.scheduled === true) {
            if (
                this.#workspaceTransfer.status !== "scheduled" ||
                this.#workspaceTransfer.targetWorkspaceId !== targetWorkspaceId
            ) {
                throw new Error("The scheduled session transfer is no longer pending.");
            }
            if (active) {
                throw new Error("The session transfer cannot start until this response finishes.");
            }
        } else if (
            active ||
            this.#queue.length > 0 ||
            this.#compactionActive ||
            [...this.#workflowRuns.values()].some((run) => run.state.status === "running")
        ) {
            throw new Error(
                "Wait for the active response to finish before transferring this session.",
            );
        }
        this.#setWorkspaceTransferState({ status: "transferring", targetWorkspaceId });
        return { projectId: this.#projectId, sourceWorkspaceId };
    }

    async completeWorkspaceTransfer(input: {
        commit: string;
        targetWorkspaceId: string;
        workspacePath: string;
    }): Promise<ProtocolSession & { workspaceId: string }> {
        if (
            this.#workspaceTransfer.status !== "transferring" ||
            this.#workspaceTransfer.targetWorkspaceId !== input.targetWorkspaceId
        ) {
            throw new Error("The session transfer is no longer active.");
        }
        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        const contextMessages = [
            ...(
                runtimeSnapshot?.contextMessages ??
                runtimeSnapshot?.messages ??
                this.#contextMessages ??
                this.#committedMessages()
            ).filter((message) => !isExcludedFromModelContext(message)),
            ...(runtimeSnapshot?.queue.map((queued) => queued.message) ?? []),
        ];
        const notice: SystemMessage = {
            blocks: [
                {
                    type: "text",
                    text: formatSessionTransferNotice({
                        commit: input.commit,
                        ...(this.#request.docker === undefined
                            ? {}
                            : { docker: this.#request.docker }),
                        workspacePath: input.workspacePath,
                    }),
                },
            ],
            id: createId(),
            internal: true,
            role: "system",
        };
        const nextContextMessages = [...contextMessages, notice];
        await this.#teardownRuntimeForWorkspaceTransfer();
        const succeeded: SessionWorkspaceTransferState = {
            status: "succeeded",
            targetWorkspaceId: input.targetWorkspaceId,
        };

        this.#persistence?.transferWorkspace?.({
            contextMessages: nextContextMessages,
            cwd: input.workspacePath,
            sessionId: this.id,
            state: succeeded,
            workspaceId: input.targetWorkspaceId,
        });

        this.#request = {
            ...this.#request,
            cwd: input.workspacePath,
            workspaceId: input.targetWorkspaceId,
        };
        this.#workspaceId = input.targetWorkspaceId;
        this.#git = undefined;
        this.#contextMessages = nextContextMessages;
        this.#workspaceTransfer = succeeded;
        this.#append("session_updated", { session: this.snapshot() });
        return { ...this.snapshot(), workspaceId: input.targetWorkspaceId };
    }

    failWorkspaceTransfer(
        targetWorkspaceId: string,
        error: unknown,
        target: Extract<
            SessionWorkspaceTransferState,
            { status: "failed" }
        >["target"] = "not_touched",
        runId?: string,
    ): void {
        if (
            this.#workspaceTransfer.status === "failed" &&
            this.#workspaceTransfer.targetWorkspaceId === targetWorkspaceId
        ) {
            if (runId !== undefined) {
                this.#append("run_error", {
                    errorMessage: `Session transfer failed: ${this.#workspaceTransfer.errorMessage}`,
                    modelLocked: this.#modelLocked(),
                    runId,
                });
            }
            return;
        }
        if (
            (this.#workspaceTransfer.status === "scheduled" ||
                this.#workspaceTransfer.status === "transferring") &&
            this.#workspaceTransfer.targetWorkspaceId === targetWorkspaceId
        ) {
            const errorMessage = errorToMessage(error);
            const notice: SystemMessage = {
                blocks: [
                    {
                        type: "text",
                        text: formatSessionTransferFailureNotice({
                            errorMessage,
                            workspacePath: this.#request.cwd,
                        }),
                    },
                ],
                id: createId(),
                internal: true,
                role: "system",
            };
            const contextMessages = [...this.#workspaceTransferContextMessages(), notice];
            this.#setWorkspaceTransferState(
                {
                    errorMessage,
                    status: "failed",
                    target,
                    targetWorkspaceId,
                },
                contextMessages,
            );
            if (this.#runtime?.agent.snapshot().status === "idle") {
                this.#runtime.agent.recordMessage(notice);
            }
            if (runId !== undefined) {
                this.#append("run_error", {
                    errorMessage: `Session transfer failed: ${errorMessage}`,
                    modelLocked: this.#modelLocked(),
                    runId,
                });
            } else {
                this.#append("session_updated", { session: this.snapshot() });
            }
        }
    }

    workspaceTransferState(): SessionWorkspaceTransferState {
        return this.#workspaceTransfer;
    }

    changeModel(request: ChangeModelRequest): ProtocolSession {
        // Resolving the provider before the idle guard keeps an unknown model reported as an
        // unknown model rather than as a busy session.
        this.#resolveProviderForModel(request.modelId, request.providerId);
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error("Wait for the active response to finish before changing models.");
        }
        return this.#applyConfiguration(
            {
                ...(request.effort === undefined ? {} : { effort: request.effort }),
                modelId: request.modelId,
                ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            },
            request.mutationId === undefined ? {} : { mutationId: request.mutationId },
        );
    }

    changeEffort(request: ChangeEffortRequest): ProtocolSession {
        return this.#applyConfiguration(
            {
                effort: request.effort ?? this.#selectedModel().defaultThinkingLevel,
            },
            request.mutationId === undefined ? {} : { mutationId: request.mutationId },
        );
    }

    changeServiceTier(request: ChangeServiceTierRequest): ProtocolSession {
        return this.#applyConfiguration(
            { serviceTier: request.serviceTier ?? null },
            request.mutationId === undefined ? {} : { mutationId: request.mutationId },
        );
    }

    /**
     * Applies a model, reasoning effort, or fast mode change and reports it as one event.
     *
     * Every path that changes the agent's configuration goes through here, so a change that moves
     * several fields at once is a single event rather than a burst that readers would have to
     * reassemble. `changed` names only the fields whose values actually moved.
     *
     * `excludeRunId` omits one run's already-stored message from the summarized history an
     * incompatible model switch builds. A message that is about to be sent to the new model must
     * not also be folded into the summary of what the old model saw.
     */
    #applyConfiguration(
        change: {
            effort?: string;
            modelId?: string;
            providerId?: string;
            serviceTier?: ServiceTier | null;
        },
        options: { excludeRunId?: string; mutationId?: string } = {},
    ): ProtocolSession {
        const changed: SessionConfigurationField[] = [];
        const previousEffort = this.#effort;
        const previousServiceTier = this.#serviceTier;

        // Everything this change asks for is checked against the configuration it would produce
        // before any of it is applied, so a rejected change leaves the session as it was rather
        // than half switched.
        const targetProviderId =
            change.modelId === undefined
                ? this.#providerId
                : this.#resolveProviderForModel(change.modelId, change.providerId);
        const targetModel =
            change.modelId === undefined
                ? this.#selectedModel()
                : this.#ensureKnownModel(change.modelId, targetProviderId);
        if (change.effort !== undefined) {
            this.#assertSupportedEffortForModel(change.effort, targetModel);
        }
        if (
            change.serviceTier !== undefined &&
            change.serviceTier !== null &&
            !this.#providerSupportsServiceTier(targetProviderId, change.serviceTier)
        ) {
            throw new Error(`Provider '${targetProviderId}' does not support fast inference.`);
        }

        if (
            change.modelId !== undefined &&
            (targetModel.id !== this.#modelId || targetProviderId !== this.#providerId)
        ) {
            this.#switchModel(targetModel, targetProviderId, options);
            changed.push("model");
        }

        // An explicit effort always applies. A model switch otherwise resets effort to whatever
        // the new model considers normal, because the old level may not exist on it.
        const effort =
            change.effort ??
            (changed.includes("model") ? this.#selectedModel().defaultThinkingLevel : undefined);
        if (effort !== undefined) {
            this.#assertSupportedEffort(effort);
            this.#effort = effort;
            this.#runtime?.agent.setEffort(effort);
        }

        if (change.serviceTier !== undefined) {
            this.#serviceTier = change.serviceTier ?? undefined;
        } else if (
            this.#serviceTier !== undefined &&
            !this.#providerSupportsServiceTier(this.#providerId, this.#serviceTier)
        ) {
            // Switching to a provider without fast inference silently turns it off, which readers
            // still have to be told about so their view of the session stays true.
            this.#serviceTier = undefined;
        }
        this.#runtime?.agent.setServiceTier(this.#serviceTier);

        if (this.#effort !== previousEffort) changed.push("effort");
        if (this.#serviceTier !== previousServiceTier) changed.push("serviceTier");
        if (changed.includes("model")) this.#totalTokens = 0;

        this.#interruption = undefined;
        this.#append("session_configuration_changed", {
            changed,
            ...(this.#effort === undefined ? {} : { effort: this.#effort }),
            modelId: this.#modelId,
            providerId: this.#providerId,
            serviceTier: this.#serviceTier ?? null,
            snapshot: this.#agentSnapshot(),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        return this.snapshot();
    }

    #resolveProviderForModel(modelId: string, providerId?: string): string {
        const resolved =
            (providerId !== undefined
                ? getProviderIdForModel(this.#modelCatalog, modelId, providerId)
                : getProviderIdForModel(this.#modelCatalog, modelId, this.#providerId)) ??
            (providerId === undefined
                ? getProviderIdForModel(this.#modelCatalog, modelId)
                : undefined);
        if (resolved === undefined) {
            const providerDescription =
                providerId !== undefined ? ` for provider '${providerId}'` : "";
            throw new Error(`Unknown model '${modelId}'${providerDescription}.`);
        }
        return resolved;
    }

    #switchModel(model: Model, providerId: string, options: { excludeRunId?: string }): void {
        const compatible = this.#modelsAreCompatible(model, providerId);
        if (compatible) {
            this.#syncContextMessages();
        } else {
            // A message already stored for a run that has not reached the model yet belongs to
            // the new model, not to the summary of what the old one saw.
            const visibleMessages = this.#committedMessagesExcludingRun(options.excludeRunId);
            this.#contextMessages =
                visibleMessages.length === 0
                    ? // Undefined means "the context is the visible transcript", which would put
                      // the excluded message back and send it to the model twice. When a message
                      // was excluded, an empty context is what is actually true.
                      options.excludeRunId === undefined
                        ? undefined
                        : []
                    : [this.#createModelHandoffHistoryMessage(model, providerId, visibleMessages)];
        }
        const runtime = this.#runtime;
        const reusableExecutor =
            runtime?.executor instanceof Executor ? runtime.executor : undefined;
        if (compatible && reusableExecutor !== undefined) {
            reusableExecutor.selectProvider(providerId);
            // Effort is settled by the caller once the new model is known, so it is not guessed
            // here; the agent falls back to the new model's default until then.
            runtime!.agent.setModel(model.id, undefined);
        } else {
            void this.#killRuntimeProcesses({ includeBackground: true });
            this.#releaseMcpToolLease();
            if (reusableExecutor === undefined) {
                void runtime?.agent.close();
                this.#executor = undefined;
            } else {
                this.#executor = reusableExecutor;
                void reusableExecutor.reset({ modelId: model.id, providerId });
            }
            this.#runtime = undefined;
            this.#mcpLoaded = false;
            this.#mcpServers = [];
            this.#mcpToolNames.clear();
            this.#tools = [];
        }
        this.#modelId = model.id;
        this.#providerId = providerId;
        this.#models = this.#modelsForProvider(providerId);
    }

    #modelsAreCompatible(model: Model, providerId: string): boolean {
        return areProviderModelsCompatible(
            {
                modelId: this.#modelId,
                providerId: this.#providerId,
                providerType:
                    this.#modelCatalog.providers.find(
                        (provider) => provider.providerId === this.#providerId,
                    )?.providerType ?? "gym",
            },
            {
                modelId: model.id,
                providerId,
                providerType:
                    this.#modelCatalog.providers.find(
                        (provider) => provider.providerId === providerId,
                    )?.providerType ?? "gym",
            },
        );
    }

    #createModelHandoffHistoryMessage(
        model: Model,
        providerId: string,
        messages: readonly Message[],
    ): SystemMessage {
        return createModelSwitchHistoryMessage({
            canReadAgentHistory: this.#agentManager !== undefined,
            fromModel: this.#selectedModel(),
            fromProviderId: this.#providerId,
            id: createId(),
            messages,
            subagentCount: this.#agentManager?.list(this.id).length ?? 0,
            toModel: model,
            toProviderId: providerId,
        });
    }

    createForkState(): PersistedSessionState {
        this.#assertAcceptingWork();
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be forked.");
        }
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error("Wait for the active response to finish before forking this session.");
        }

        this.#syncContextMessages();
        const state = this.state();
        const id = createId();
        const {
            activeRunId: _activeRunId,
            archived: _archived,
            goal: _goal,
            interruption: _interruption,
            title: _title,
            titleError: _titleError,
            metadataRunId: _metadataRunId,
            metadataUpdatedAt: _metadataUpdatedAt,
            recap: _recap,
            durableWaits: _durableWaits,
            scheduledMessages: _scheduledMessages,
            workflows: _workflows,
            ...rest
        } = state;
        const title = state.title === undefined ? undefined : `${state.title} (fork)`;
        return {
            ...rest,
            agent: { depth: 0, rootSessionId: id, type: "primary" },
            agentId: createId(),
            archived: false,
            id,
            lastMessageAt: this.#now(),
            lifetimeTotalTokens: 0,
            messages: state.messages.map((message) => ({ ...message })),
            nextTaskId: 1,
            queuedRuns: [],
            secretIds: [],
            status: "idle",
            tasks: [],
            titleStatus: title === undefined ? "idle" : "ready",
            tools: [],
            workflows: [],
            workspaceTransfer: { status: "idle" },
            ...(title !== undefined ? { title } : {}),
        };
    }

    update(request: UpdateSessionRequest): ProtocolSession {
        this.#appendSystemPrompt = request.appendSystemPrompt ?? undefined;
        this.#runtime?.agent.setAppendSystemPrompt(this.#appendSystemPrompt);
        this.#interruption = undefined;
        this.#append("session_updated", {
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            session: this.snapshot(),
        });
        return this.snapshot();
    }

    /**
     * Republish this session because its share's capabilities changed.
     *
     * The snapshot itself carries no share state — sharing is joined in at the
     * HTTP boundary, which is where the owner's share is known — so this exists
     * to make the stream emit at all. The decorating layer attaches the current
     * share to the event, and an attached client learns that somebody's access
     * changed without polling for it.
     *
     * This is what keeps the "somebody is watching" disclosure honest while a
     * session is running rather than only at the moment a client attaches.
     */
    noteShareCapabilitiesChanged(): void {
        this.#append("session_updated", { session: this.snapshot() });
    }

    setOrderKey(orderKey: string): ProtocolSession {
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        if (this.#orderKey === orderKey) return this.snapshot();
        this.#orderKey = orderKey;
        this.#append("session_updated", { session: this.snapshot() });
        return this.snapshot();
    }

    /**
     * Store the composer draft and mirror it to every other attached client.
     * The draft belongs to the clients: Rig keeps the latest text so a restarted
     * terminal or a newly attached client can pick the message back up, and does
     * not otherwise interpret it.
     */
    setDraft(request: SetSessionDraftRequest): ProtocolSession {
        const draft =
            request.draft === null || request.draft.length === 0 ? undefined : request.draft;
        if (draft !== undefined && draft.length > SESSION_DRAFT_MAX_LENGTH) {
            throw new Error("The draft is too long to sync.");
        }
        const updatedAt = clampSessionDraftTimestamp(request.updatedAt, this.#now());
        // The newest message wins, not the last one to arrive. A draft typed
        // before the one already stored is discarded even when a slow client
        // delivers it afterwards.
        if (this.#draftUpdatedAt !== undefined && updatedAt < this.#draftUpdatedAt) {
            return this.snapshot();
        }
        if (this.#draft === draft) return this.snapshot();
        this.#draft = draft;
        this.#draftUpdatedAt = updatedAt;
        this.#append("session_draft_changed", {
            ...(draft === undefined ? {} : { draft }),
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            ...(request.origin === undefined ? {} : { origin: request.origin }),
            updatedAt,
        });
        return this.snapshot();
    }

    /**
     * Project and workspace identity without building a protocol snapshot. Observers on hot paths
     * need only these two fields, and `snapshot()` walks every message to produce them.
     */
    projectIdentity(): { projectId: string; workspaceId?: string } {
        return {
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
        };
    }

    setArchived(archived: boolean, mutationId?: string): ProtocolSession {
        if (!archived && this.#workspaceArchived) {
            throw new Error("A session archived with its workspace cannot be restored.");
        }
        if (this.#archived === archived) return this.snapshot();
        this.#archived = archived;
        // An archived session is put away, so nothing of it should keep running.
        if (archived) void this.#killRuntimeProcesses({ includeBackground: true });
        this.#append("session_archived", {
            archived,
            ...(mutationId === undefined ? {} : { mutationId }),
        });
        return this.snapshot();
    }

    async changePermissionMode(
        request: ChangePermissionModeRequest,
        options: { updateSubagents?: boolean } = {},
    ): Promise<ProtocolSession> {
        const permissionMode = parsePermissionMode(request.permissionMode);
        const runtime = this.#runtime;
        const previousPermissionMode = this.#permissionMode;
        const permissionChanged = previousPermissionMode !== permissionMode;
        this.#permissionMode = permissionMode;
        runtime?.context.permissions?.setMode(permissionMode);
        try {
            this.#append("permission_mode_changed", {
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                permissionMode,
            });
        } catch (error) {
            if (isPermissionReduction(previousPermissionMode, permissionMode)) {
                try {
                    await this.beginShutdown();
                } catch (shutdownError) {
                    throw new AggregateError(
                        [error, shutdownError],
                        "Could not persist the permission reduction or fully stop the session.",
                    );
                }
                throw error;
            }
            this.#permissionMode = previousPermissionMode;
            runtime?.context.permissions?.setMode(previousPermissionMode);
            throw error;
        }
        const running = this.#reapableProcessCount();
        const descendantChange =
            !this.isSubagent() &&
            options.updateSubagents !== false &&
            isPermissionReduction(previousPermissionMode, permissionMode)
                ? (this.#agentManager?.changeSubagentPermissionModes(this.id, permissionMode) ??
                  Promise.resolve())
                : Promise.resolve();
        const localProcessShutdown = (async () => {
            if (running === 0 || !isPermissionReduction(previousPermissionMode, permissionMode)) {
                return;
            }
            await this.#killRuntimeProcesses({ includeBackground: true });
            const runId = this.#activeRun?.runId ?? this.#lastSessionRunId ?? "background";
            this.#append("agent_event", {
                event: { type: "background_processes_stopped", count: running },
                runId,
            });
        })();
        const transitionResults = await Promise.allSettled([
            descendantChange,
            localProcessShutdown,
        ]);
        const transitionErrors = transitionResults.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        if (permissionChanged) {
            try {
                this.#removeMcpTools(runtime);
            } catch (error) {
                transitionErrors.push(error);
            }
        }
        if (transitionErrors.length === 1) {
            throw transitionErrors[0];
        }
        if (transitionErrors.length > 1) {
            throw new AggregateError(
                transitionErrors,
                "Could not fully apply the permission mode change.",
            );
        }
        if (
            permissionChanged &&
            runtime !== undefined &&
            permissionMode !== "auto" &&
            permissionMode !== "full_access"
        ) {
            await this.#ensureMcpTools(runtime);
        }
        return this.snapshot();
    }

    attachSecret(
        secretId: string,
        options: { mutationId?: string; scope?: SecretAttachmentScope } = {},
    ): ProtocolSession {
        const scope = options.scope ?? "session";
        this.#secrets.attach(secretId, scope);
        this.#append("secrets_changed", {
            ...this.#secretAttachmentData(),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        return this.snapshot();
    }

    detachSecret(
        secretId: string,
        options: { mutationId?: string; scope?: SecretAttachmentScope } = {},
    ): ProtocolSession {
        const scope = options.scope ?? "session";
        if (!this.#secrets.detach(secretId, scope)) return this.snapshot();
        this.#append("secrets_changed", {
            ...this.#secretAttachmentData(),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        return this.snapshot();
    }

    setGoal(request: CreateGoalRequest, mutationId?: string): SessionGoal {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        if (this.#goal !== undefined && this.#goal.status !== "complete") {
            throw new Error(
                "This session already has an unfinished goal. Complete or clear it before starting another.",
            );
        }

        const now = this.#now();
        this.#goal = {
            createdAt: now,
            objective: normalizeGoalObjective(request.objective),
            status: "active",
            updatedAt: now,
        };
        this.#lastMessageAt = now;
        this.#append("goal_changed", {
            goal: { ...this.#goal },
            ...(mutationId === undefined ? {} : { mutationId }),
        });
        if (this.#titleStatus === "idle") {
            this.#title = createGoalTitle(this.#goal.objective);
            this.#titleStatus = "ready";
            this.#append("session_title_changed", {
                status: this.#titleStatus,
                title: this.#title,
            });
        }
        this.#continueGoalIfIdle();
        return { ...this.#goal };
    }

    changeGoalStatus(
        request: ChangeGoalStatusRequest,
        options: { mutationId?: string; stopActiveGoalRun?: boolean } = {},
    ): SessionGoal {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        if (this.#goal === undefined) {
            throw new Error("This session does not have a goal.");
        }
        if (request.status === "active" && this.#goal.status === "complete") {
            throw new Error("A completed goal cannot be resumed. Start a new goal instead.");
        }

        this.#goal = { ...this.#goal, status: request.status, updatedAt: this.#now() };
        this.#append("goal_changed", {
            goal: { ...this.#goal },
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        if (request.status === "active") {
            this.#continueGoalIfIdle();
        } else if (options.stopActiveGoalRun !== false) {
            void this.#agentManager?.pauseDescendants(this.id);
            this.#discardQueuedGoalRuns();
            if (this.#activeRun?.kind === "goal") {
                this.#activeRun.controller.abort();
                void this.#killRuntimeProcesses();
            }
        }
        return { ...this.#goal };
    }

    clearGoal(mutationId?: string): boolean {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        if (this.#goal === undefined) return false;

        this.#goal = undefined;
        void this.#agentManager?.stopDescendants(this.id);
        this.#discardQueuedGoalRuns();
        if (this.#activeRun?.kind === "goal") {
            this.#activeRun.controller.abort();
            void this.#killRuntimeProcesses();
        }
        this.#append("goal_changed", {
            goal: null,
            ...(mutationId === undefined ? {} : { mutationId }),
        });
        return true;
    }

    goal(): SessionGoal | undefined {
        return this.#goal === undefined ? undefined : { ...this.#goal };
    }

    scheduledMessages(): readonly ScheduledMessage[] {
        return [...this.#scheduledMessages.values()]
            .sort((left, right) => left.createdAt - right.createdAt)
            .map((message) => structuredClone(message));
    }

    scheduleMessage(request: ScheduleMessageRequest): ScheduledMessage {
        if (this.isSubagent()) {
            throw new Error("Subagents cannot schedule messages.");
        }
        if (!Number.isFinite(request.dueAt)) {
            throw new Error("The scheduled date must be finite.");
        }
        if (request.targetAgentId.trim().length === 0) {
            throw new Error("Provide the target Agent ID.");
        }
        if (request.message.trim().length === 0) {
            throw new Error("Provide a message to schedule.");
        }
        const now = this.#now();
        const scheduled: ScheduledMessage = {
            createdAt: now,
            dueAt: Math.max(now, request.dueAt),
            id: createId(),
            message: request.message,
            senderSessionId: this.id,
            status: "pending",
            targetAgentId: request.targetAgentId,
            updatedAt: now,
        };
        this.#persistence?.upsertScheduledMessage?.(scheduled);
        this.#scheduledMessages.set(scheduled.id, scheduled);
        this.#append("scheduled_message_changed", {
            message: structuredClone(scheduled),
        });
        this.#pruneScheduledMessages();
        this.#persistence?.scheduledMessageChanged?.();
        return structuredClone(scheduled);
    }

    cancelScheduledMessage(
        messageId: string,
        mutationId?: string,
    ): { cancelled: boolean; message?: ScheduledMessage } {
        const current = this.#scheduledMessages.get(messageId);
        if (current === undefined) return { cancelled: false };
        if (current.status !== "pending") {
            return { cancelled: false, message: structuredClone(current) };
        }
        const next: ScheduledMessage = {
            ...current,
            status: "cancelled",
            updatedAt: this.#now(),
        };
        this.#persistence?.upsertScheduledMessage?.(next);
        this.#scheduledMessages.set(next.id, next);
        this.#append("scheduled_message_changed", {
            message: structuredClone(next),
            ...(mutationId === undefined ? {} : { mutationId }),
        });
        this.#pruneScheduledMessages();
        this.#persistence?.scheduledMessageChanged?.();
        return { cancelled: true, message: structuredClone(next) };
    }

    deliverScheduledMessage(messageId: string): ScheduledMessage | undefined {
        const current = this.#scheduledMessages.get(messageId);
        if (current === undefined || current.status !== "pending") {
            return current === undefined ? undefined : structuredClone(current);
        }
        let delivered = false;
        let failure: string | undefined;
        try {
            this.#agentManager?.sendScheduledMessage(
                this.id,
                current.targetAgentId,
                current.message,
                current.id,
            );
            delivered = this.#agentManager !== undefined;
            if (!delivered) failure = "Cross-agent messaging is unavailable in this session.";
        } catch (error) {
            failure = errorToMessage(error);
        }
        const now = this.#now();
        const next: ScheduledMessage = {
            ...current,
            ...(delivered ? { deliveredAt: now } : { failure: failure ?? "Delivery failed." }),
            status: delivered ? "delivered" : "undelivered",
            updatedAt: now,
        };
        this.#persistence?.upsertScheduledMessage?.(next);
        this.#scheduledMessages.set(next.id, next);
        this.#append("scheduled_message_changed", { message: structuredClone(next) });
        this.#pruneScheduledMessages();
        this.#persistence?.scheduledMessageChanged?.();
        return structuredClone(next);
    }

    requestUserInput(
        request: UserInputRequest,
        options: { durable?: DurableUserInputOptions; signal?: AbortSignal } = {},
    ): Promise<UserInputOutcome> {
        if (this.isSubagent()) {
            throw new Error("Only the primary session can ask the user a question.");
        }
        if (this.#pendingUserInputs.has(request.requestId)) {
            throw new Error("A user input request with this identifier is already pending.");
        }
        if (isSignalAborted(options.signal)) {
            return Promise.reject(new Error("The user input request was cancelled."));
        }

        let durable: DurableUserInputCall | undefined;
        let createdDurable = false;
        if (options.durable !== undefined) {
            const runId = this.#activeRun?.runId;
            if (runId === undefined) {
                throw new Error("Durable interactive user input requires an active run.");
            }
            const existing = this.#durableUserInputs.get(request.requestId);
            if (existing !== undefined) {
                if (
                    existing.runId !== runId ||
                    existing.batchId !== options.durable.batchId ||
                    existing.toolCallId !== options.durable.toolCallId
                ) {
                    throw new Error(
                        "The durable user input identity does not match its pending request.",
                    );
                }
                if (existing.response !== undefined) {
                    return Promise.resolve({
                        status: "answered" as const,
                        ...structuredClone(existing.response),
                    });
                }
                durable = existing;
            } else {
                durable = {
                    batchId: options.durable.batchId,
                    consumed: false,
                    createdAt: this.#now(),
                    kind: options.durable.kind,
                    ...(options.durable.permission === undefined
                        ? {}
                        : { permission: { ...options.durable.permission } }),
                    ...(options.durable.providerToolCallId === undefined
                        ? {}
                        : { providerToolCallId: options.durable.providerToolCallId }),
                    request: structuredClone(request),
                    runId,
                    sessionId: this.id,
                    status: "pending",
                    toolArguments: structuredClone(options.durable.toolArguments),
                    toolCallId: options.durable.toolCallId,
                    toolCallIndex: options.durable.toolCallIndex,
                    toolName: options.durable.toolName,
                };
                this.#durableUserInputs.set(request.requestId, durable);
                this.#persistence?.upsertDurableUserInput?.(durable);
                createdDurable = true;
            }
        }

        const requestedAt = this.#now();
        const response = new Promise<UserInputOutcome>((resolve, reject) => {
            const pending: PendingUserInput = {
                request,
                requestedAt,
                resolve,
                ...(durable === undefined ? {} : { durable }),
            };
            if (options.signal !== undefined) pending.signal = options.signal;
            const onAbort = () => {
                if (this.#pendingUserInputs.get(request.requestId) !== pending) return;
                this.#pendingUserInputs.delete(request.requestId);
                this.#clearUserInputPresenceTimer(request.requestId);
                if (pending.durable === undefined) {
                    this.#append("user_input_resolved", {
                        requestId: request.requestId,
                        status: "cancelled",
                    });
                } else if (!this.#closing && pending.durable.status === "pending") {
                    this.#cancelDurableUserInput(pending.durable);
                }
                reject(new Error("The user input request was cancelled."));
            };
            pending.onAbort = onAbort;
            options.signal?.addEventListener("abort", onAbort, { once: true });
            this.#pendingUserInputs.set(request.requestId, pending);
        });
        if (durable === undefined || createdDurable) {
            this.#append("user_input_requested", request);
        }
        if (isSignalAborted(options.signal)) {
            this.#pendingUserInputs.get(request.requestId)?.onAbort?.();
        }
        this.#applyPresenceToUserInput(request.requestId, options.durable?.kind);
        return response;
    }

    /** Applies a daemon-wide presence change to this agent and anything awaiting the user. */
    presenceChanged(state: PresenceState): void {
        const runtime = this.#runtime;
        if (runtime !== undefined) {
            const message: SystemMessage = {
                blocks: [{ type: "text", text: modelPresenceInstruction(state, true) }],
                id: createId(),
                internal: true,
                role: "system",
            };
            if (this.#activeRun !== undefined && runtime.agent.status === "running") {
                runtime.agent.steerMessage(message);
            } else {
                runtime.agent.enqueueMessage(message);
            }
        }
        for (const pending of [...this.#pendingUserInputs.values()]) {
            this.#applyPresenceToUserInput(pending.request.requestId, pending.durable?.kind, state);
        }
        for (const call of this.#durableUserInputs.values()) {
            if (
                this.#pendingUserInputs.has(call.request.requestId) ||
                call.kind !== "question" ||
                call.consumed ||
                call.status !== "pending"
            ) {
                continue;
            }
            this.#applyPresenceToRestoredUserInput(call, state);
        }
    }

    /**
     * Questions follow the user's presence: Online waits indefinitely, Away never waits, and a
     * custom state waits for however long it allows. When presence ends the wait the question
     * keeps its place in the Inbox and only stops blocking the agent.
     */
    #applyPresenceToUserInput(
        requestId: string,
        kind: DurableUserInputCall["kind"] | undefined,
        currentState?: PresenceState,
    ): void {
        if (kind !== "question") return;
        if (!this.#pendingUserInputs.has(requestId)) return;
        this.#clearUserInputPresenceTimer(requestId);
        const state = currentState ?? this.#presence?.state();
        if (state === undefined) return;
        const answerWaitMs = state.presence.answerWaitMs;
        const durable = this.#pendingUserInputs.get(requestId)?.durable;
        if (answerWaitMs === null) {
            if (durable?.answerDueAt !== undefined || durable?.answerWaitStartedAt !== undefined) {
                delete durable.answerDueAt;
                delete durable.answerWaitStartedAt;
                this.#persistence?.upsertDurableUserInput?.(durable);
            }
            return;
        }
        const startedAt = this.#now();
        const dueAt = startedAt + Math.max(0, answerWaitMs);
        if (durable !== undefined) {
            durable.answerDueAt = dueAt;
            durable.answerWaitStartedAt = startedAt;
            this.#persistence?.upsertDurableUserInput?.(durable);
        }
        if (answerWaitMs <= 0) {
            this.#detachUserInput(requestId, "away", state);
            return;
        }
        this.#armUserInputPresenceTimer(requestId, dueAt, state);
    }

    #armUserInputPresenceTimer(
        requestId: string,
        dueAt: number,
        state: PresenceState,
        reason: "away" | "timeout" = "timeout",
    ): void {
        const timer = setTimeout(
            () => {
                if (this.#userInputPresenceTimers.get(requestId) !== timer) return;
                this.#userInputPresenceTimers.delete(requestId);
                if (dueAt > this.#now()) {
                    this.#armUserInputPresenceTimer(requestId, dueAt, state, reason);
                    return;
                }
                const currentState = this.#presence?.state() ?? state;
                if (this.#pendingUserInputs.has(requestId)) {
                    this.#detachUserInput(requestId, reason, currentState);
                } else {
                    this.#detachRestoredUserInput(requestId, reason, currentState);
                }
            },
            Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - this.#now())),
        );
        timer.unref?.();
        this.#userInputPresenceTimers.set(requestId, timer);
    }

    #restoreUserInputPresenceTimers(): void {
        const state = this.#presence?.state();
        if (state === undefined || state.presence.answerWaitMs === null) return;
        for (const call of this.#durableUserInputs.values()) {
            if (
                call.kind !== "question" ||
                call.consumed ||
                call.status !== "pending" ||
                call.detachedAt !== undefined
            ) {
                continue;
            }
            const startedAt = call.answerWaitStartedAt ?? this.#now();
            const dueAt = call.answerDueAt ?? startedAt + Math.max(0, state.presence.answerWaitMs);
            if (call.answerDueAt === undefined || call.answerWaitStartedAt === undefined) {
                call.answerDueAt = dueAt;
                call.answerWaitStartedAt = startedAt;
                this.#persistence?.upsertDurableUserInput?.(call);
            }
            this.#armUserInputPresenceTimer(
                call.request.requestId,
                dueAt,
                state,
                state.presence.answerWaitMs <= 0 ? "away" : "timeout",
            );
        }
    }

    #applyPresenceToRestoredUserInput(call: DurableUserInputCall, state: PresenceState): void {
        this.#clearUserInputPresenceTimer(call.request.requestId);
        const answerWaitMs = state.presence.answerWaitMs;
        if (answerWaitMs === null) {
            delete call.answerDueAt;
            delete call.answerWaitStartedAt;
            this.#persistence?.upsertDurableUserInput?.(call);
            return;
        }
        const startedAt = this.#now();
        const dueAt = startedAt + Math.max(0, answerWaitMs);
        call.answerDueAt = dueAt;
        call.answerWaitStartedAt = startedAt;
        this.#persistence?.upsertDurableUserInput?.(call);
        this.#armUserInputPresenceTimer(
            call.request.requestId,
            dueAt,
            state,
            answerWaitMs <= 0 ? "away" : "timeout",
        );
    }

    #detachRestoredUserInput(
        requestId: string,
        reason: "away" | "timeout",
        state: PresenceState,
    ): void {
        const call = this.#durableUserInputs.get(requestId);
        if (
            call === undefined ||
            call.kind !== "question" ||
            call.consumed ||
            call.status !== "pending"
        ) {
            return;
        }
        const outcome = {
            askId: requestId,
            ...(state.changesAt === undefined ? {} : { changesAt: state.changesAt }),
            presence: state.presence,
            reason,
            status: "unanswered" as const,
            waitedMs: Math.max(0, this.#now() - (call.answerWaitStartedAt ?? call.createdAt)),
        };
        const runtime = this.#ensureRuntime();
        const tool = runtime.agent.tools.find((candidate) => candidate.name === call.toolName);
        call.result =
            tool?.resolveUnansweredUserInput === undefined
                ? createErrorToolResultBlock(
                      {
                          id: call.toolCallId,
                          name: call.toolName,
                          ...(call.providerToolCallId === undefined
                              ? {}
                              : { providerToolCallId: call.providerToolCallId }),
                      },
                      `Tool '${call.toolName}' could not restore its unanswered question.`,
                      { kind: "execution_failed" },
                  )
                : createToolResultBlock(
                      tool,
                      call.toolArguments,
                      tool.resolveUnansweredUserInput(outcome, call.toolArguments as never),
                      call.toolCallId,
                      undefined,
                      call.providerToolCallId,
                  );
        call.detachedAt = this.#now();
        call.status = "completed";
        this.#persistence?.upsertDurableUserInput?.(call);
        this.#append("user_input_detached", {
            presenceId: state.presence.id,
            reason,
            requestId,
        });
        this.resumeDurableToolRun();
    }

    #detachUserInput(requestId: string, reason: "away" | "timeout", state: PresenceState): void {
        const pending = this.#pendingUserInputs.get(requestId);
        if (pending === undefined) return;
        this.#clearUserInputPresenceTimer(requestId);
        this.#pendingUserInputs.delete(requestId);
        if (pending.onAbort !== undefined) {
            pending.signal?.removeEventListener("abort", pending.onAbort);
        }
        const durable = pending.durable;
        if (durable !== undefined && durable.status === "pending") {
            // The run no longer waits for this answer, so a restart must not replay it.
            durable.consumed = true;
            durable.detachedAt = this.#now();
            this.#persistence?.upsertDurableUserInput?.(durable);
        }
        this.#append("user_input_detached", { presenceId: state.presence.id, reason, requestId });
        pending.resolve({
            askId: requestId,
            ...(state.changesAt === undefined ? {} : { changesAt: state.changesAt }),
            presence: state.presence,
            reason,
            status: "unanswered",
            waitedMs: Math.max(0, this.#now() - pending.requestedAt),
        });
    }

    #clearUserInputPresenceTimer(requestId: string): void {
        const timer = this.#userInputPresenceTimers.get(requestId);
        if (timer === undefined) return;
        clearTimeout(timer);
        this.#userInputPresenceTimers.delete(requestId);
    }

    /** Withdraws a question the agent no longer needs an answer to. */
    cancelUserInput(requestId: string): CancelAskResult {
        const durable = this.#durableUserInputs.get(requestId);
        if (durable === undefined) {
            return { cancelled: false, reason: "There is no question with that id." };
        }
        if (!isOpenQuestion(durable)) {
            return {
                cancelled: false,
                reason:
                    durable.status === "cancelled"
                        ? "That question was already withdrawn."
                        : "The user already answered that question.",
            };
        }
        this.#clearUserInputPresenceTimer(requestId);
        this.#cancelDurableUserInput(durable);
        this.#pruneDurableUserInputs();
        return { cancelled: true };
    }

    answerUserInput(
        requestId: string,
        response: AnswerUserInputRequest,
    ): ProtocolSession | undefined {
        const pending = this.#pendingUserInputs.get(requestId);
        const durable = this.#durableUserInputs.get(requestId);
        if (pending === undefined && durable === undefined) return undefined;

        if (durable?.response !== undefined) {
            if (!isDeepStrictEqual(durable.response, response)) {
                throw new Error("This question already has a different answer.");
            }
            return this.snapshot();
        }

        const request = pending?.request ?? durable?.request;
        if (request === undefined) return undefined;

        const responseAnswers = (response as { answers?: unknown } | null)?.answers;
        if (
            responseAnswers === null ||
            typeof responseAnswers !== "object" ||
            Array.isArray(responseAnswers)
        ) {
            throw new Error("Choose an answer for every question before continuing.");
        }

        const answers: Record<string, readonly string[]> = {};
        for (const question of request.questions) {
            const selected = (responseAnswers as Record<string, unknown>)[question.id];
            if (
                question.required === false &&
                (selected === undefined || (Array.isArray(selected) && selected.length === 0))
            ) {
                continue;
            }
            if (
                !Array.isArray(selected) ||
                selected.length === 0 ||
                selected.some((answer) => typeof answer !== "string" || answer.trim() === "")
            ) {
                throw new Error(`Answer the ${question.header} question before continuing.`);
            }
            if (!question.multiSelect && selected.length > 1) {
                throw new Error(`Choose one answer for the ${question.header} question.`);
            }
            answers[question.id] = [...selected];
        }

        this.#clearUserInputPresenceTimer(requestId);
        if (pending !== undefined) {
            this.#pendingUserInputs.delete(requestId);
            if (pending.onAbort !== undefined) {
                pending.signal?.removeEventListener("abort", pending.onAbort);
            }
        }
        const normalizedResponse = { answers };
        const detached = durable?.detachedAt !== undefined;
        if (durable !== undefined) {
            durable.response = structuredClone(normalizedResponse);
            durable.resolvedAt = this.#now();
            durable.status = "answered";
            this.#persistence?.upsertDurableUserInput?.(durable);
        }
        this.#append("user_input_resolved", {
            answers,
            ...(response.mutationId === undefined ? {} : { mutationId: response.mutationId }),
            requestId,
            status: "answered",
        });
        if (pending !== undefined) {
            pending.resolve({ status: "answered", ...normalizedResponse });
        } else if (detached && durable !== undefined) {
            // Nothing is waiting for this answer any more, so it arrives as a late notice instead.
            this.#deliverDetachedAnswer(durable, answers);
        } else if (durable !== undefined) {
            this.resumeDurableToolRun();
        }
        return this.snapshot();
    }

    /**
     * Tells the agent about an answer that arrived after presence had already released the run.
     * The agent asked the question, so the late answer belongs in the conversation.
     */
    #deliverDetachedAnswer(
        call: DurableUserInputCall,
        answers: Readonly<Record<string, readonly string[]>>,
    ): void {
        const lines = call.request.questions.map((question) => {
            const answer = answers[question.id];
            return answer === undefined || answer.length === 0
                ? `${question.question} — no answer.`
                : `${question.question} — ${answer.join(", ")}`;
        });
        const message: SystemMessage = {
            blocks: [
                {
                    type: "text",
                    text: `The user has now answered the question you asked earlier.\n${lines.join("\n")}`,
                },
            ],
            id: createId(),
            internal: true,
            role: "system",
        };
        const runtime = this.#runtime;
        if (runtime === undefined) {
            this.#separateModelContextFromVisibleTranscript();
            this.#contextMessages?.push(message);
            return;
        }
        if (this.#activeRun !== undefined && runtime.agent.status === "running") {
            runtime.agent.steerMessage(message);
        } else {
            runtime.agent.enqueueMessage(message);
        }
    }

    markUserInputExecuting(requestId: string): void {
        const durable = this.#durableUserInputs.get(requestId);
        if (durable === undefined || durable.status !== "answered") return;
        durable.status = "executing";
        this.#persistence?.upsertDurableUserInput?.(durable);
    }

    createTask(request: CreateTaskRequest): SessionTask {
        const task = this.#taskList.create(request);
        this.#recordTasksChanged();
        return task;
    }

    getTask(taskId: string): SessionTask | undefined {
        return this.#taskList.get(taskId);
    }

    listTasks(): readonly SessionTask[] {
        return this.#taskList.list();
    }

    updateTask(taskId: string, request: UpdateTaskRequest): UpdateTaskResult {
        const result = this.#taskList.update(taskId, request);
        if (result.success && result.updatedFields.length > 0) this.#recordTasksChanged();
        return result;
    }

    getWorkflow(runId: string): WorkflowRun | undefined {
        const run = this.#workflowRuns.get(runId)?.state;
        return run === undefined ? undefined : cloneWorkflowRun(run);
    }

    listWorkflows(): readonly WorkflowRun[] {
        return [...this.#workflowRuns.values()]
            .map((run) => cloneWorkflowRun(run.state))
            .sort((left, right) => right.startedAt - left.startedAt);
    }

    async waitForWorkflow(runId: string, signal?: AbortSignal): Promise<WorkflowRun | undefined> {
        const internal = this.#workflowRuns.get(runId);
        if (internal === undefined) return undefined;
        if (internal.state.status !== "running") return cloneWorkflowRun(internal.state);
        if (signal?.aborted === true) throw new Error("Waiting for the workflow was cancelled.");

        return await new Promise<WorkflowRun>((resolve, reject) => {
            let settled = false;
            const finish = (run: WorkflowRun) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", abort);
                resolve(run);
            };
            const abort = () => {
                if (settled) return;
                settled = true;
                reject(new Error("Waiting for the workflow was cancelled."));
            };
            signal?.addEventListener("abort", abort, { once: true });
            void internal.completion.then(finish);
        });
    }

    launchWorkflow(request: LaunchWorkflowRequest): WorkflowRun {
        this.#assertAcceptingWork();
        if (!this.#workflowsEnabled) {
            throw new Error("Workflows are disabled for this session.");
        }
        const resumed =
            request.resumeFromRunId === undefined
                ? undefined
                : this.#workflowRuns.get(request.resumeFromRunId);
        if (request.resumeFromRunId !== undefined && resumed === undefined) {
            throw new Error("The workflow run to resume was not found in this session.");
        }
        if (resumed?.state.status === "running") {
            throw new Error("Stop the previous workflow run before resuming it.");
        }
        const resumeCheckpoint =
            resumed?.state.code === request.code ? resumed.checkpoint : undefined;

        const runId = createId();
        const controller = new AbortController();
        let resolveCompletion = (_run: WorkflowRun): void => undefined;
        const completion = new Promise<WorkflowRun>((resolve) => {
            resolveCompletion = resolve;
        });
        const state: WorkflowRun = {
            agentCount: 0,
            code: request.code,
            description: request.description,
            logs: [],
            name: request.name,
            runId,
            startedAt: this.#now(),
            status: "running",
            taskId: `workflow:${runId}`,
        };
        const internal: InternalWorkflowRun = {
            agentCalls: [],
            completion,
            controller,
            resolveCompletion,
            state,
        };
        this.#workflowRuns.set(runId, internal);
        this.#recordWorkflowUpdate({
            agentCount: state.agentCount,
            code: request.code,
            description: state.description,
            name: state.name,
            runId,
            startedAt: state.startedAt,
            status: state.status,
            taskId: state.taskId,
        });
        const execute = () =>
            request
                .execute({
                    onAgentCall: () => {
                        state.agentCount += 1;
                        this.#recordWorkflowUpdate({ agentCount: state.agentCount, runId });
                    },
                    onAgentResult: (index, result) => {
                        internal.agentCalls[index] = result;
                        this.#saveSession();
                    },
                    onCheckpoint: (checkpoint) => {
                        internal.checkpoint = checkpoint;
                        this.#saveSession();
                    },
                    onLog: (message) => {
                        const trimmed = message.trim();
                        if (trimmed.length === 0) return;
                        const logs = state.logs as string[];
                        logs.push(
                            trimmed.length <= MAX_WORKFLOW_LOG_CHARS
                                ? trimmed
                                : `${trimmed.slice(0, MAX_WORKFLOW_LOG_CHARS)}…`,
                        );
                        if (logs.length > 200) logs.shift();
                        const log = logs.at(-1);
                        const phase = /^Phase:\s*(.+)$/u.exec(log ?? "")?.[1]?.trim();
                        if (phase !== undefined && phase.length > 0) state.phase = phase;
                        if (log !== undefined) {
                            this.#recordWorkflowUpdate({
                                log,
                                ...(state.phase === undefined ? {} : { phase: state.phase }),
                                runId,
                            });
                        }
                    },
                    resumeAgentCalls: resumed?.agentCalls ?? [],
                    ...(resumeCheckpoint === undefined ? {} : { resumeCheckpoint }),
                    runId,
                    signal: controller.signal,
                })
                .then((result) => {
                    if (this.#workflowRuns.get(runId) !== internal) return;
                    internal.agentCalls = [...result.agentCalls];
                    state.output = result.output;
                    state.finishedAt = this.#now();
                    state.status = "completed";
                    this.#recordWorkflowUpdate({
                        finishedAt: state.finishedAt,
                        output: state.output,
                        runId,
                        status: state.status,
                    });
                })
                .catch((error: unknown) => {
                    if (isDatabaseFailure(error)) throw error;
                    if (this.#workflowRuns.get(runId) !== internal) return;
                    if (state.status !== "stopped") {
                        state.error = errorToMessage(error);
                        state.finishedAt = this.#now();
                        state.status = "error";
                        this.#recordWorkflowUpdate({
                            error: state.error,
                            finishedAt: state.finishedAt,
                            runId,
                            status: state.status,
                        });
                    }
                })
                .finally(() => {
                    if (this.#workflowRuns.get(runId) !== internal) return;
                    internal.resolveCompletion(cloneWorkflowRun(state));
                    if (this.#closing) return;
                    const statusText =
                        state.status === "completed"
                            ? "completed"
                            : state.status === "stopped"
                              ? "was stopped"
                              : "failed";
                    const resultText =
                        state.status === "completed"
                            ? serializeWorkflowValue(state.output)
                            : (state.error ?? "The workflow did not return a result.");
                    this.deliverNotification({
                        displayText: `Workflow ${humanizeWorkflowName(state.name)} ${statusText}.`,
                        text: [
                            "<workflow-notification>",
                            `Workflow: ${state.name}`,
                            `Run ID: ${state.runId}`,
                            `Status: ${state.status}`,
                            `Agents: ${state.agentCount}`,
                            `Result: ${resultText}`,
                            ...(state.logs.length === 0
                                ? []
                                : ["Progress:", ...state.logs.map((log) => `- ${log}`)]),
                            "</workflow-notification>",
                        ].join("\n"),
                    });
                });
        const execution = this.#taskDrain?.run(execute) ?? execute();
        void execution.catch(rethrowDatabaseFailure);
        return cloneWorkflowRun(state);
    }

    stopWorkflow(runId: string): WorkflowRun | undefined {
        const run = this.#workflowRuns.get(runId);
        if (run === undefined) return undefined;
        if (run.state.status === "running") {
            run.state.status = "stopped";
            run.state.error = "The workflow was stopped.";
            run.state.finishedAt = this.#now();
            run.controller.abort();
            this.#recordWorkflowUpdate({
                error: run.state.error,
                finishedAt: run.state.finishedAt,
                runId,
                status: run.state.status,
            });
        }
        return cloneWorkflowRun(run.state);
    }

    emitCreatedEvent(): void {
        this.#append("session_created", { session: this.snapshot() });
    }

    beginShutdown(): Promise<void> {
        if (this.#shutdownCleanup !== undefined) return this.#shutdownCleanup;
        this.#closing = true;
        this.#clearWorkspaceReadinessRetry();
        for (const timer of this.#durableWaitTimers.values()) clearTimeout(timer);
        this.#durableWaitTimers.clear();
        for (const timer of this.#userInputPresenceTimers.values()) clearTimeout(timer);
        this.#userInputPresenceTimers.clear();
        this.#releaseMcpToolLease();
        this.#clearMetadataSettlement();
        for (const workflow of this.#workflowRuns.values()) {
            if (workflow.state.status === "running") this.stopWorkflow(workflow.state.runId);
        }
        const activeRun = this.#activeRun;
        if (activeRun !== undefined && this.hasDurableToolRun() && !this.#workspaceArchived) {
            this.#restoredActiveRunId = activeRun.runId;
            this.#activeRun = undefined;
            this.#status = "running";
        }
        activeRun?.controller.abort();
        this.#compactionController?.abort();
        this.#shutdownCleanup = Promise.all([
            this.#killRuntimeProcesses({ forceAfterMs: 5_000, includeBackground: true }),
            this.#runtime?.agent.close() ?? Promise.resolve(),
        ]).then(() => undefined);
        return this.#shutdownCleanup;
    }

    /**
     * Records the archival and hands back the teardown it still owes. Aborting a run, closing a
     * runtime, and killing processes are not database work, so the caller runs them once the
     * archival has committed rather than while it holds the write lock.
     */
    archiveForWorkspace(workspaceId: string): () => Promise<void> {
        if (this.#workspaceArchived) {
            return () => this.#shutdownCleanup ?? Promise.resolve();
        }
        const activeRun = this.#activeRun;
        const runIds = new Set([
            ...(activeRun === undefined ? [] : [activeRun.runId]),
            ...(this.#restoredActiveRunId === undefined ? [] : [this.#restoredActiveRunId]),
            ...this.#queue.map((run) => run.runId),
        ]);
        for (const runId of runIds) {
            this.#cancelExternalToolCalls(runId);
            this.#cancelDurableUserInputs(runId);
            this.#cancelDurableWaits(runId);
        }
        const queuedRuns = this.#queue;
        for (const run of queuedRuns) this.#persistence?.deleteQueuedRun(this.id, run.runId);
        this.#queue = [];
        for (const run of queuedRuns) {
            this.#append("run_error", {
                errorMessage:
                    "The queued run could not start because its managed workspace was archived.",
                modelLocked: false,
                runId: run.runId,
            });
        }
        this.#finishElapsedInterval();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#pendingSteeringMessages.clear();
        this.#pendingSteeringContinuations.clear();
        this.#suspendedRunIds.clear();
        this.#suspendOnAbort = false;
        this.#pauseActiveGoal();
        this.#status = "archived";
        this.#archived = true;
        this.#append("session_workspace_archived", {
            reason: "workspace_archived",
            workspaceId,
        });
        this.#workspaceArchived = true;
        return () => {
            activeRun?.controller.abort();
            return this.beginShutdown();
        };
    }

    isClosing(): boolean {
        return this.#closing;
    }

    markInterrupted(interruption: SessionInterruption): void {
        this.#finishElapsedInterval();
        this.#interruption = interruption;
        this.#status = "error";
        this.#activeRun?.controller.abort();
        if (!this.#closing) void this.#killRuntimeProcesses();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#pendingSteeringMessages.clear();
        this.#suspendedRunIds.clear();
        this.#pauseActiveGoal();
        const interruptedRunIds = [
            ...(interruption.runId !== undefined ? [interruption.runId] : []),
            ...this.#queue.map((queued) => queued.runId),
        ];
        const discardedQueue = this.#queue;
        this.#queue = [];
        void Promise.all(discardedQueue.map((queued) => this.#closeDebugLog(queued)));
        const persistInterruption = () => {
            for (const queued of discardedQueue) {
                this.#persistence?.deleteQueuedRun(this.id, queued.runId);
            }
            const uniqueRunIds = new Set(interruptedRunIds);
            for (const runId of uniqueRunIds) {
                this.#recordInterruptedToolResults(runId, interruption.message);
                this.#append("run_error", {
                    errorMessage: interruption.message,
                    modelLocked: this.#modelLocked(),
                    runId,
                    startupInterruption: true,
                });
            }
            if (uniqueRunIds.size > 0) this.#restartMetadataSettlement();
            this.#saveSession();
        };
        if (this.#persistence?.transaction === undefined) persistInterruption();
        else this.#persistence.transaction(persistInterruption);
    }

    #recordInterruptedToolResults(runId: string, message: string): void {
        const answeredToolCallIds = new Set<string>();
        for (const candidate of [
            ...this.#messages.map((entry) => entry.message),
            ...(this.#contextMessages ?? []),
        ]) {
            if (candidate.role !== "agent") continue;
            for (const block of candidate.blocks) {
                if (block.type === "tool_result") answeredToolCallIds.add(block.toolCallId);
            }
        }

        const unansweredToolCalls = new Map<string, ToolCallBlock>();
        for (const entry of this.#messages) {
            if (entry.isPartial || entry.runId !== runId || entry.message.role !== "agent") {
                continue;
            }
            for (const block of entry.message.blocks) {
                if (block.type !== "tool_call" || answeredToolCallIds.has(block.id)) continue;
                unansweredToolCalls.set(block.id, block);
            }
        }
        if (unansweredToolCalls.size === 0) return;

        const resultMessage: AgentMessage = {
            blocks: [...unansweredToolCalls.values()].map((toolCall) =>
                createErrorToolResultBlock(toolCall, message, { kind: "interrupted" }),
            ),
            id: createId(),
            role: "agent",
        };
        this.#separateModelContextFromVisibleTranscript();
        this.#contextMessages?.push(resultMessage);
        this.#commitAgentMessage(runId, resultMessage);
    }

    markSuspendedAfterRestart(message: string, runId?: string): void {
        if (!this.isSubagent() || this.#status !== "suspended") {
            throw new Error("Only a suspended subagent can be repaired as resumable.");
        }
        this.#finishElapsedInterval();
        this.#activeRun?.controller.abort();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#suspendOnAbort = false;
        for (const queued of this.#queue) {
            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
        }
        this.#queue = [];
        if (runId !== undefined) {
            this.#append("run_error", {
                errorMessage: message,
                modelLocked: this.#modelLocked(),
                runId,
                startupInterruption: true,
            });
        }
        this.#status = "suspended";
        this.#saveSession();
    }

    recordSubagentStoppedAfterRestart(subagent: SubagentSummary, path: string): void {
        const runId = `restart:${subagent.id}`;
        const displayText = `Background work "${subagent.description}" stopped when the local server restarted.`;
        const message: UserMessage = {
            blocks: [
                {
                    type: "text",
                    text: [
                        "<subagent-notification>",
                        `Agent ID: ${subagent.agentId}`,
                        `Path: ${path}`,
                        "Status: suspended",
                        "Result: The subagent stopped working when the local server restarted. It remains suspended and will not resume automatically.",
                        `Use followup_task with target ${JSON.stringify(subagent.agentId)} to continue it, or interrupt_agent to leave it stopped.`,
                        "</subagent-notification>",
                    ].join("\n"),
                },
            ],
            id: createId(),
            role: "user",
        };
        this.#separateModelContextFromVisibleTranscript();
        this.#storeMessage(this.#nextMessagePosition(), message, false, runId);
        this.#contextMessages?.push(message);
        this.#lastMessageAt = this.#now();
        this.#append("message_submitted", {
            displayText,
            message,
            runId,
            source: "notification",
        });
        this.#saveSession();
    }

    async reset(): Promise<ProtocolSession> {
        this.#shellHistoryRevision += 1;
        this.#clearMetadataSettlement();
        this.#invalidateSessionMetadata();
        await this.#agentManager?.stopDescendants(this.id);
        const activeRunId = this.#activeRun?.runId;
        await this.abort({ stopDescendants: false });
        await Promise.allSettled(this.#shellCommandCompletions.values());
        if (activeRunId !== undefined) await this.waitForRun(activeRunId);
        await this.#draining?.catch(rethrowDatabaseFailure);
        const workflowRuns = [...this.#workflowRuns.values()];
        for (const run of workflowRuns) {
            if (run.state.status === "running") this.stopWorkflow(run.state.runId);
        }
        await Promise.all(workflowRuns.map((run) => run.completion));
        this.#workflowRuns.clear();
        // Aborting spares background work, but a reset throws away the
        // conversation that knew its task ids. Nothing would ever read or stop
        // those commands again, so they go with the history that started them.
        await this.#killRuntimeProcesses({ includeBackground: true });
        this.#runtime?.context.attachments?.discard();
        await this.#ensureRuntime().agent.reset();
        this.#status = "idle";
        this.#interruption = undefined;
        this.#restoredActiveRunId = undefined;
        this.#lastSessionRunId = undefined;
        this.#messages = [];
        this.#rebuildMessagePositionIndex();
        this.#rebuildTranscriptIndex();
        this.#totalTokens = 0;
        this.#usage = zeroUsage();
        this.#submittedUserMessages.clear();
        this.#contextMessages = undefined;
        this.#partialPositions.clear();
        this.#activePartial = undefined;
        this.#pendingContextMessages.clear();
        this.#pendingContextSteering.clear();
        this.#pendingSteeringMessages.clear();
        this.#suspendedRunIds.clear();
        const hadTasks = this.#taskList.reset();
        const hadGoal = this.#goal !== undefined;
        this.#goal = undefined;
        const commitReset = () => {
            this.#persistence?.clearMessages(this.id);
            if (hadTasks) this.#recordTasksChanged();
            if (hadGoal) this.#append("goal_changed", { goal: null });
            this.#append("session_reset", {
                snapshot: this.#agentSnapshot(),
                transcript: this.transcriptWindow(),
            });
        };
        if (this.#persistence?.transaction === undefined) commitReset();
        else this.#persistence.transaction(commitReset);
        return this.snapshot();
    }

    rewind(messageId: string): RewindSessionResponse {
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be rewound.");
        }
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error(
                "Wait for the active response to finish before rewinding this session.",
            );
        }

        const target = this.#messages.find(
            (entry) => !entry.isPartial && entry.message.id === messageId,
        );
        if (target === undefined || target.message.role !== "user") {
            throw new Error("The selected user message is no longer available.");
        }

        this.#shellHistoryRevision += 1;
        void this.#killRuntimeProcesses({ includeBackground: true });
        this.#releaseMcpToolLease();
        void this.#runtime?.agent.close();
        this.#runtime = undefined;
        this.#mcpLoaded = false;
        this.#mcpServers = [];
        this.#mcpToolNames.clear();
        this.#tools = [];
        this.#messages = this.#messages.filter((entry) => entry.position < target.position);
        this.#pendingContextMessages = new Map(
            [...this.#pendingContextMessages].filter(
                ([, pending]) => pending.position < target.position,
            ),
        );
        this.#pendingContextSteering.clear();
        this.#rebuildMessagePositionIndex();
        this.#rebuildTranscriptIndex();
        this.#retainPermissionReviewsForMessages(this.#messages.map((entry) => entry.message));
        this.#submittedUserMessages = new Map(
            this.#messages.flatMap((entry) =>
                entry.message.role === "user" && entry.runId !== undefined
                    ? [[entry.message.id, entry] as const]
                    : [],
            ),
        );
        this.#invalidateSessionMetadata();
        this.#contextMessages = undefined;
        this.#partialPositions = new Set(
            [...this.#partialPositions].filter((position) => position < target.position),
        );
        this.#activePartial = undefined;
        this.#interruption = undefined;
        this.#lastSessionRunId = undefined;
        this.#restoredActiveRunId = undefined;
        this.#status = "idle";
        this.#totalTokens = 0;
        this.#lastMessageAt = this.#now();
        const commitRewind = () => {
            this.#persistence?.deleteMessagesFrom(this.id, target.position);
            this.#append("session_rewound", {
                messageId,
                snapshot: this.#agentSnapshot(),
                transcript: this.transcriptWindow(),
            });
        };
        if (this.#persistence?.transaction === undefined) commitRewind();
        else this.#persistence.transaction(commitRewind);
        this.#restartMetadataSettlement();
        return { message: target.message, session: this.snapshot() };
    }

    async compact(signal?: AbortSignal): Promise<AgentCompactionResult> {
        this.#assertAcceptingWork();
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error("Wait for the active response to finish before compacting.");
        }

        const controller = new AbortController();
        this.#compactionController = controller;
        const compactSignal =
            signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
        const previousStatus = this.#status;
        const compactionRunId = createId();
        this.#compactionRunId = compactionRunId;
        this.#compactionActive = true;
        this.#status = "running";
        this.#append("run_started", { kind: "compaction", runId: compactionRunId });
        this.#restartMetadataSettlement();
        this.#saveSession();
        try {
            const result = await this.#ensureRuntime().agent.compact(
                compactSignal,
                (event) => this.#appendCompactionAgentEvent(compactionRunId, event),
                (message) => this.#appendAgentMessage(compactionRunId, message),
            );
            this.#syncContextMessages();
            this.#append("run_finished", {
                modelLocked: this.#modelLocked(),
                runId: compactionRunId,
                stopReason: "stop",
            });
            return result;
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (compactSignal.aborted) {
                this.#append("run_finished", {
                    modelLocked: this.#modelLocked(),
                    runId: compactionRunId,
                    stopReason: "aborted",
                });
            } else {
                const errorMessage = errorToMessage(error);
                this.#appendDurableError(compactionRunId, errorMessage, this.#runtime);
                this.#syncContextMessages();
                this.#append("run_error", {
                    errorMessage,
                    modelLocked: this.#modelLocked(),
                    runId: compactionRunId,
                });
            }
            throw error;
        } finally {
            this.#compactionActive = false;
            if (this.#compactionRunId === compactionRunId) this.#compactionRunId = undefined;
            if (this.#compactionController === controller) this.#compactionController = undefined;
            if (!this.#closing) {
                this.#status = previousStatus;
                this.#restartMetadataSettlement();
                this.#saveSession();
            }
        }
    }

    isSubagent(): boolean {
        return this.#agentMetadata.type === "subagent";
    }

    markRead(): boolean {
        if (this.isSubagent() || this.#unread === undefined) return false;
        this.#unread = undefined;
        this.#append("session_updated", { session: this.snapshot() });
        return true;
    }

    recordSubagentChanged(subagent: SubagentSummary): void {
        this.#append("subagent_changed", { subagent });
        this.#restartMetadataSettlement();
    }

    recordDescendantActivity(): void {
        this.#restartMetadataSettlement();
    }

    recordUserActivity(): void {
        this.#restartMetadataSettlement();
    }

    recordMutationApplied(mutationId: string | undefined): void {
        if (mutationId !== undefined) this.#append("mutation_applied", { mutationId });
    }

    requestForSubagent(): CreateSessionRequest {
        return {
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            cwd: this.#request.cwd,
            trackUnread: false,
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
            modelId: this.#modelId,
            providerId: this.#providerId,
            ...(this.#request.apiKey !== undefined ? { apiKey: this.#request.apiKey } : {}),
            permissionMode: this.#permissionMode,
            // The subagent creation path overrides this continuation grant before creating a child.
            workflowsEnabled: this.#workflowsEnabled,
            ...(this.#request.docker === undefined ? {} : { docker: this.#request.docker }),
        };
    }

    /** Preserves native checkpoints only when the child can replay the parent's provider format. */
    contextMessagesForSubagent(
        contextMessages: readonly Message[],
        target: { modelId: string; parentToolCallId?: string; providerId: string },
    ): readonly Message[] {
        const targetModel = this.#ensureKnownModel(target.modelId, target.providerId);
        if (this.#modelsAreCompatible(targetModel, target.providerId)) return contextMessages;
        const selectedMessages = messagesBeforeToolCall(contextMessages, target.parentToolCallId);
        const sourceMessages = selectedMessages.some((message) => message.role === "compaction")
            ? messagesBeforeToolCall(this.#committedMessages(), target.parentToolCallId)
            : selectedMessages;
        return sourceMessages.length === 0
            ? []
            : [
                  this.#createModelHandoffHistoryMessage(
                      targetModel,
                      target.providerId,
                      sourceMessages,
                  ),
              ];
    }

    activeRunDebug(): boolean {
        return this.#activeRun?.debug === true;
    }

    agentIdentity(): AgentCommunicationIdentity {
        const folderPath = this.#request.docker?.workingDirectory ?? this.#request.cwd;
        return {
            agentId: this.#agentId,
            folder: agentFolderLabel(folderPath),
            ...(this.#title === undefined ? {} : { title: this.#title }),
        };
    }

    agentCommunicationLocation(): {
        cwd: string;
        docker?: DockerExecutionConfig;
        sessionId: string;
    } {
        return {
            cwd: this.#request.cwd,
            ...(this.#request.docker === undefined ? {} : { docker: this.#request.docker }),
            sessionId: this.id,
        };
    }

    attachment(id: string): Attachment | undefined {
        const message = this.#messages.findLast(
            (entry) =>
                !entry.isPartial &&
                entry.message.role === "agent" &&
                entry.message.internal !== true &&
                entry.message.attachments?.some((attachment) => attachment.id === id) === true,
        )?.message;
        if (message?.role !== "agent") return undefined;
        const attachment = message.attachments?.find((candidate) => candidate.id === id);
        return attachment === undefined ? undefined : structuredClone(attachment);
    }

    externalControlContext(): AgentContext {
        return this.#ensureRuntime().context;
    }

    runsInDocker(): boolean {
        return this.#request.docker !== undefined;
    }

    /** What the session is doing at this moment. */
    activity(): SessionActivity {
        return structuredClone(this.#activity);
    }

    /**
     * The most recent turns of the transcript, cut on turn boundaries.
     *
     * This is what a client attaching without a cursor receives, so the cost of
     * opening a stream follows recent activity rather than the age of the
     * session.
     */
    transcriptWindow(turnLimit: number = SESSION_STREAM_TURN_LIMIT): SessionTranscriptWindow {
        // No anchor is given, so the newest turns always exist to return.
        return this.transcriptPage(turnLimit) as SessionTranscriptWindow;
    }

    /**
     * The turns immediately before `before`, or the newest turns without it.
     *
     * Undefined when the anchor is a run the transcript no longer has, which a
     * caller has to tell apart from an empty page: one means the conversation
     * moved under them, the other that they have reached the beginning.
     */
    transcriptPage(
        turnLimit: number = SESSION_STREAM_TURN_LIMIT,
        before?: string,
    ): SessionTranscriptWindow | undefined {
        const earlierCount =
            before === undefined
                ? this.#transcriptRunOrder.length
                : this.#transcriptRunIndexes.get(before);
        if (earlierCount === undefined || (earlierCount === 0 && this.#transcriptHasEarlier)) {
            return this.#persistence?.loadTranscriptPage?.(this.id, turnLimit, before);
        }
        const first = Math.max(0, earlierCount - turnLimit);
        const keptRunIds = this.#transcriptRunOrder.slice(first, earlierCount);
        const turnMessages = keptRunIds.flatMap((runId) => this.#transcriptRuns.get(runId) ?? []);
        const lowerPosition =
            first === 0 && !this.#transcriptHasEarlier ? 0 : (turnMessages[0]?.position ?? 0);
        const upperPosition =
            before === undefined
                ? Number.POSITIVE_INFINITY
                : (this.#transcriptRuns.get(before)?.[0]?.position ?? Number.POSITIVE_INFINITY);
        const noticeSlice = this.#transcriptNoticeMessages(lowerPosition, upperPosition);
        const keptMessages = [...turnMessages, ...noticeSlice.messages].sort(
            (left, right) => left.position - right.position,
        );
        if (
            this.#persistence?.loadTranscriptPage !== undefined &&
            (keptRunIds.some((runId) => !this.#runFacts.has(runId)) ||
                keptMessages.some(
                    (entry) =>
                        this.events.messageCreatedAt(entry.message.id) === undefined ||
                        this.events.messageEventId(entry.message.id) === undefined,
                ))
        ) {
            return this.#persistence.loadTranscriptPage(this.id, turnLimit, before);
        }
        const entries = this.#transcriptEntries(keptMessages);
        const window = sessionTranscriptWindow(entries, this.#runFacts, keptRunIds.length);
        const toolCallIds = new Set(
            entries.flatMap((entry) =>
                entry.message.blocks.flatMap((block) =>
                    block.type === "tool_call" ? [block.id] : [],
                ),
            ),
        );
        const permissionReviews = [...toolCallIds].flatMap((toolCallId) => {
            const review = this.#permissionReviews.get(toolCallId);
            return review === undefined ? [] : [review];
        });
        const providerToolCalls = this.events.providerToolCalls(new Set(keptRunIds));
        return window === undefined
            ? undefined
            : {
                  ...window,
                  complete: !this.#transcriptHasEarlier && keptRunIds.length === earlierCount,
                  ...(noticeSlice.truncated ? { noticesTruncated: true } : {}),
                  ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
                  ...(providerToolCalls.length === 0 ? {} : { providerToolCalls }),
              };
    }

    /**
     * The turns from the one holding `after` through the newest.
     *
     * This is how a client catches up when it missed events: it says which
     * message it last holds, and receives everything from there on. The unit is
     * a whole turn, including the turn that contains the anchor, because a gap
     * can begin in the middle of one — the client replaces those turns outright
     * rather than trying to stitch a half-turn onto a half-turn.
     *
     * Undefined when the anchor is older than what is retained, which means the
     * client has to start again from a bootstrap rather than page forward.
     */
    transcriptSince(
        after: EventId,
        turnLimit: number = SESSION_STREAM_TURN_LIMIT,
    ): SessionTranscriptWindow | undefined {
        // Persistent sessions can page from anchors older than the bounded
        // in-memory window. Ask storage first so a months-old client position
        // cannot turn into an undetected hole between held and recent turns.
        if (this.#persistence?.loadTranscriptSince !== undefined) {
            return this.#persistence.loadTranscriptSince(this.id, turnLimit, after);
        }
        const runIds = this.#transcriptRunOrder;
        const eventIdOf = (runId: string): EventId | undefined => {
            const messages = this.#transcriptRuns.get(runId) ?? [];
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                const id = this.events.messageEventId(messages[index]!.message.id);
                if (id !== undefined) return id;
            }
            return undefined;
        };

        // The first turn whose newest message is at or after the anchor. Turns
        // are ordered, so everything from here on is what the client is missing.
        let first = runIds.length;
        for (let index = 0; index < runIds.length; index += 1) {
            const newest = eventIdOf(runIds[index]!);
            if (newest !== undefined && newest >= after) {
                first = index;
                break;
            }
        }
        const noticeMessagesAtOrAfter = this.#messages.filter(
            (entry) =>
                isTranscriptNoticeEntry(entry) &&
                (this.events.messageEventId(entry.message.id) ?? "") >= after,
        );
        // Nothing at or after the anchor: the client is already current.
        if (first === runIds.length && noticeMessagesAtOrAfter.length === 0) {
            return { complete: true, messages: [], turns: [] };
        }
        const exactAnchor = this.#messages.find(
            (entry) => this.events.messageEventId(entry.message.id) === after,
        );
        // The anchor predates everything retained, so paging forward from it
        // would silently skip whatever was trimmed in between.
        if (first === 0 && this.#transcriptHasEarlier && exactAnchor === undefined) {
            return undefined;
        }

        const keptRunIds = runIds.slice(first, first + turnLimit);
        const firstRunPosition =
            keptRunIds.length === 0
                ? undefined
                : this.#transcriptRuns.get(keptRunIds[0]!)?.[0]?.position;
        const anchorPosition =
            exactAnchor?.runId === undefined
                ? exactAnchor?.position
                : exactAnchor === undefined
                  ? undefined
                  : this.#transcriptRuns.get(exactAnchor.runId)?.[0]?.position;
        const firstNoticePosition = noticeMessagesAtOrAfter[0]?.position;
        const lowerPosition = Math.min(
            anchorPosition ?? Number.POSITIVE_INFINITY,
            firstRunPosition ?? Number.POSITIVE_INFINITY,
            firstNoticePosition ?? Number.POSITIVE_INFINITY,
        );
        const nextRunId = runIds[first + keptRunIds.length];
        const upperPosition =
            nextRunId === undefined
                ? Number.POSITIVE_INFINITY
                : (this.#transcriptRuns.get(nextRunId)?.[0]?.position ?? Number.POSITIVE_INFINITY);
        const turnMessages = keptRunIds.flatMap((runId) => this.#transcriptRuns.get(runId) ?? []);
        const noticeSlice = this.#transcriptNoticeMessages(
            Number.isFinite(lowerPosition) ? lowerPosition : 0,
            upperPosition,
        );
        const keptMessages = [...turnMessages, ...noticeSlice.messages].sort(
            (left, right) => left.position - right.position,
        );
        if (
            keptRunIds.some((runId) => !this.#runFacts.has(runId)) ||
            keptMessages.some(
                (entry) =>
                    this.events.messageCreatedAt(entry.message.id) === undefined ||
                    this.events.messageEventId(entry.message.id) === undefined,
            )
        ) {
            return undefined;
        }

        const entries = this.#transcriptEntries(keptMessages);
        const window = sessionTranscriptWindow(entries, this.#runFacts, keptRunIds.length);
        if (window === undefined) return undefined;
        const toolCallIds = new Set(
            entries.flatMap((entry) =>
                entry.message.blocks.flatMap((block) =>
                    block.type === "tool_call" ? [block.id] : [],
                ),
            ),
        );
        const permissionReviews = [...toolCallIds].flatMap((toolCallId) => {
            const review = this.#permissionReviews.get(toolCallId);
            return review === undefined ? [] : [review];
        });
        const providerToolCalls = this.events.providerToolCalls(new Set(keptRunIds));
        return {
            ...window,
            // Whether this page reaches the newest turn, so a client knows if it
            // must ask again to finish catching up.
            complete: first + keptRunIds.length === runIds.length,
            ...(noticeSlice.truncated ? { noticesTruncated: true } : {}),
            ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
            ...(providerToolCalls.length === 0 ? {} : { providerToolCalls }),
        };
    }

    /**
     * Records the Git state of the session's directory and reports it to
     * attached clients.
     *
     * The snapshot is versioned by the tracker, so an older or repeated delivery
     * is dropped rather than published as news.
     */
    recordGitState(git: GitChangeSnapshot): void {
        // Versions are monotonic only within one daemon generation, so a snapshot
        // from a different generation always wins.
        if (
            this.#git !== undefined &&
            this.#git.generation === git.generation &&
            this.#git.version >= git.version
        ) {
            return;
        }
        this.#git = git;
        this.#append("session_git_changed", { git });
    }

    /**
     * The assistant message currently being generated, if any.
     *
     * Committed transcripts exclude partial messages, so this is the only way a
     * client attaching mid-turn can render the text already produced.
     */
    partialMessage(): SessionPartialMessage | undefined {
        const active = this.#activePartial;
        if (active?.position === undefined) return undefined;
        const entry = this.#messages.find(
            (candidate) => candidate.isPartial && candidate.position === active.position,
        );
        if (entry === undefined || entry.message.role !== "agent") return undefined;
        return { message: structuredClone(entry.message), runId: active.runId };
    }

    #activeTurn(): SessionActiveTurn | undefined {
        const runId =
            this.#activeRun?.runId ??
            this.#restoredActiveRunId ??
            this.#compactionRunId ??
            this.#queue.at(0)?.runId;
        if (runId === undefined) return undefined;
        const facts = this.#runFacts.get(runId);
        return facts === undefined
            ? undefined
            : {
                  runId,
                  startedAt: facts.startedAt,
                  ...(facts.kind === undefined ? {} : { kind: facts.kind }),
              };
    }

    snapshot(): ProtocolSession {
        const snapshot = this.#agentSnapshot();
        const lastEventId = this.events.lastEventId();
        const activeTurn = this.#activeTurn();
        return {
            id: this.id,
            activity: this.activity(),
            ...(activeTurn === undefined ? {} : { activeTurn }),
            agentId: this.#agentId,
            ...(this.#git === undefined ? {} : { git: structuredClone(this.#git) }),
            archived: this.#archived,
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
            trackUnread: this.#request.trackUnread === true,
            ...(this.#unread === undefined ? {} : { unread: { ...this.#unread } }),
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            cwd: this.#request.cwd,
            ...(this.#draft === undefined ? {} : { draft: this.#draft }),
            ...(this.#draftUpdatedAt === undefined ? {} : { draftUpdatedAt: this.#draftUpdatedAt }),
            environment: summarizeDockerExecution(this.#request.docker),
            providerId: this.#providerId,
            permissionMode: this.#permissionMode,
            modelId: this.#modelId,
            ...(this.#orderKey === "" ? {} : { orderKey: this.#orderKey }),
            modelLocked: this.#modelLocked(),
            models: this.#models,
            projectSecretIds: this.#secrets.projectIds(),
            secretIds: this.#secrets.ids(),
            sessionSecretIds: this.#secrets.sessionIds(),
            status: this.#status,
            snapshot,
            titleStatus: this.#titleStatus,
            ...(this.#recap !== undefined ? { recap: this.#recap } : {}),
            ...(this.#metadataUpdatedAt !== undefined
                ? { metadataUpdatedAt: this.#metadataUpdatedAt }
                : {}),
            ...(this.#metadataRunId !== undefined ? { metadataRunId: this.#metadataRunId } : {}),
            agent: this.agentMetadata(),
            pendingUserInputs: [
                ...new Map(
                    [
                        ...[...this.#pendingUserInputs.values()].map((pending) => pending.request),
                        ...[...this.#durableUserInputs.values()]
                            .filter((call) => call.status === "pending")
                            .map((call) => call.request),
                    ].map((request) => [request.requestId, request]),
                ).values(),
            ],
            permissionReviews: [...this.#permissionReviews.values()],
            pendingSteeringMessages: [...this.#pendingSteeringMessages.values()].map((pending) => ({
                createdAt: pending.createdAt,
                message: structuredClone(pending.message),
                runId: pending.runId,
            })),
            mcpServers: this.#mcpServers,
            tasks: this.listTasks(),
            workflowsEnabled: this.#workflowsEnabled,
            workflows: this.listWorkflows(),
            backgroundProcesses: this.#runtime?.context.bash.activeSessions?.() ?? [],
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            ...(this.#usage.totalTokens === 0
                ? {}
                : { cumulativeUsage: structuredClone(this.#usage) }),
            externalTools: this.#externalToolDefinitions.map((definition) => ({ ...definition })),
            skills: this.#durableSkillDefinitions.map((definition) => ({ ...definition })),
            pendingExternalToolCalls: this.externalToolCalls({ status: "pending" }),
            scheduledMessages: this.scheduledMessages(),
            ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
            ...(this.#goal !== undefined ? { goal: { ...this.#goal } } : {}),
            ...(snapshot.effort !== undefined ? { effort: snapshot.effort } : {}),
            ...(snapshot.serviceTier !== undefined ? { serviceTier: snapshot.serviceTier } : {}),
            ...(this.#title !== undefined ? { title: this.#title } : {}),
            ...(this.#titleError !== undefined ? { titleError: this.#titleError } : {}),
            ...(this.#interruption !== undefined ? { interruption: this.#interruption } : {}),
            ...(lastEventId !== undefined ? { lastEventId } : {}),
        };
    }

    summary(): SessionSummary {
        const lastEventId = this.events.lastEventId();
        return {
            id: this.id,
            archived: this.#archived,
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
            trackUnread: this.#request.trackUnread === true,
            ...(this.#unread === undefined ? {} : { unread: { ...this.#unread } }),
            cwd: this.#request.cwd,
            ...(this.#draft === undefined ? {} : { draft: this.#draft }),
            ...(this.#draftUpdatedAt === undefined ? {} : { draftUpdatedAt: this.#draftUpdatedAt }),
            environment: summarizeDockerExecution(this.#request.docker),
            providerId: this.#providerId,
            permissionMode: this.#permissionMode,
            modelId: this.#modelId,
            ...(this.#orderKey === "" ? {} : { orderKey: this.#orderKey }),
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            status: this.#status,
            titleStatus: this.#titleStatus,
            ...(this.#recap !== undefined ? { recap: this.#recap } : {}),
            sessionTokenCount: { ...this.#sessionTokenCount },
            ...(this.#metadataUpdatedAt !== undefined
                ? { metadataUpdatedAt: this.#metadataUpdatedAt }
                : {}),
            ...(this.#metadataRunId !== undefined ? { metadataRunId: this.#metadataRunId } : {}),
            createdAt: this.#createdAt,
            updatedAt: this.events.lastCreatedAt() ?? this.#now(),
            ...(this.#lastMessageAt !== undefined ? { lastMessageAt: this.#lastMessageAt } : {}),
            ...(lastEventId === undefined ? {} : { lastEventId }),
            ...(this.#activity.wait === undefined ? {} : { wait: { ...this.#activity.wait } }),
            ...(this.#title !== undefined ? { title: this.#title } : {}),
            ...(this.#titleError !== undefined ? { titleError: this.#titleError } : {}),
            ...(this.#interruption !== undefined ? { interruption: this.#interruption } : {}),
            inboxItems: [...this.#durableUserInputs.values()]
                .filter((call) => isOpenQuestion(call) || call.response !== undefined)
                .map((call) => ({
                    ...(call.response === undefined ? {} : { answers: call.response.answers }),
                    createdAt: call.createdAt,
                    questions: call.request.questions,
                    requestId: call.request.requestId,
                    ...(call.resolvedAt === undefined ? {} : { resolvedAt: call.resolvedAt }),
                    status:
                        call.response === undefined ? ("pending" as const) : ("answered" as const),
                })),
        };
    }

    state(): PersistedSessionState {
        const activeRunId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        const pendingContextIds = new Set(this.#pendingContextMessages.keys());
        const contextMessages = (
            runtimeSnapshot === undefined
                ? (this.#contextMessages ?? this.#committedMessages()).filter(
                      (message) => !isExcludedFromModelContext(message),
                  )
                : [
                      ...(runtimeSnapshot.contextMessages ?? runtimeSnapshot.messages).filter(
                          (message) => !isExcludedFromModelContext(message),
                      ),
                      ...runtimeSnapshot.queue.map((queued) => queued.message),
                  ]
        ).filter((message) => !pendingContextIds.has(message.id));
        const usageSummary = structuredClone(this.usage());
        const usageSummaryEventId = this.events.lastEventId();
        const state: PersistedSessionState = {
            ...(this.#activeSince === undefined ? {} : { activeSince: this.#activeSince }),
            agent: this.agentMetadata(),
            agentId: this.#agentId,
            archived: this.#archived,
            trackUnread: this.#request.trackUnread === true,
            ...(this.#unread === undefined ? {} : { unread: { ...this.#unread } }),
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            cwd: this.#request.cwd,
            ...(this.#draft === undefined ? {} : { draft: this.#draft }),
            ...(this.#draftUpdatedAt === undefined ? {} : { draftUpdatedAt: this.#draftUpdatedAt }),
            elapsedMs: this.#elapsedMs,
            ...(this.#request.docker === undefined ? {} : { docker: this.#request.docker }),
            contextMessages: [...contextMessages],
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            id: this.id,
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
            ...(this.#goal !== undefined ? { goal: { ...this.#goal } } : {}),
            ...(this.#interruption !== undefined ? { interruption: this.#interruption } : {}),
            ...(this.#lastMessageAt !== undefined ? { lastMessageAt: this.#lastMessageAt } : {}),
            ...(this.#metadataRunId !== undefined ? { metadataRunId: this.#metadataRunId } : {}),
            ...(this.#metadataUpdatedAt !== undefined
                ? { metadataUpdatedAt: this.#metadataUpdatedAt }
                : {}),
            messages: [...this.#messages],
            modelId: this.#modelId,
            models: this.#models,
            orderKey: this.#orderKey,
            providerId: this.#providerId,
            permissionMode: this.#permissionMode,
            permissionReviews: [...this.#permissionReviews.values()],
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
            workspaceTransfer: structuredClone(this.#workspaceTransfer),
            workspaceQueueWaiting: this.#workspaceQueueWaiting,
            secretIds: this.#secrets.sessionIds(),
            queuedRuns: [...this.#queue],
            pendingContextMessages: [...this.#pendingContextMessages.values()].map((pending) => ({
                ...pending,
                message: structuredClone(pending.message),
            })),
            ...(this.#recap !== undefined ? { recap: this.#recap } : {}),
            nextTaskId: this.#taskList.nextId,
            status: this.#status,
            tasks: this.listTasks(),
            ...(this.#title !== undefined ? { title: this.#title } : {}),
            ...(this.#titleError !== undefined ? { titleError: this.#titleError } : {}),
            titleStatus: this.#titleStatus,
            totalTokens: this.#totalTokens,
            lifetimeTotalTokens: this.#lifetimeTotalTokens,
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            usage: structuredClone(this.#usage),
            usageSummary,
            ...(usageSummaryEventId === undefined ? {} : { usageSummaryEventId }),
            tools: this.#tools,
            externalToolCalls: this.externalToolCalls(),
            durableUserInputs: [...this.#durableUserInputs.values()].map((call) =>
                structuredClone(call),
            ),
            durableWaits: [...this.#durableWaits.values()].map((wait) => structuredClone(wait)),
            scheduledMessages: this.scheduledMessages(),
            externalTools: this.#externalToolDefinitions.map((definition) => ({ ...definition })),
            skills: this.#durableSkillDefinitions.map((definition) => ({ ...definition })),
            ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
            workflowsEnabled: this.#workflowsEnabled,
            workflows: [...this.#workflowRuns.values()].map((run) => ({
                agentCalls: [...run.agentCalls],
                ...(run.checkpoint === undefined
                    ? {}
                    : {
                          checkpoint: {
                              nextAgentCallIndex: run.checkpoint.nextAgentCallIndex,
                              phase: run.checkpoint.phase,
                              snapshotBase64: Buffer.from(run.checkpoint.snapshot).toString(
                                  "base64",
                              ),
                          },
                      }),
                state: cloneWorkflowRun(run.state),
            })),
        };
        if (activeRunId !== undefined) {
            state.activeRunId = activeRunId;
        }
        return state;
    }

    submitContext(request: SubmitContextMessageRequest): SubmitContextMessageResponse {
        this.#assertAcceptingWork();
        if (request.clientSubmissionId !== undefined) {
            const existing = this.events.messageSubmission(request.clientSubmissionId);
            if (existing?.data.delivery === "context") {
                return {
                    delivery: "context",
                    eventId: existing.id,
                    messageId: existing.data.message.id,
                    sessionId: this.id,
                };
            }
        }

        const apply = (): SubmitContextMessageResponse => {
            this.setArchived(false);
            const messageId = request.clientSubmissionId ?? createId();
            const anchorRunId = `context:${messageId}`;
            const createdAt = this.#now();
            const position = this.#nextMessagePosition();
            const message: UserMessage = {
                blocks: [{ text: request.text, type: "text" }],
                contextOnly: true,
                id: messageId,
                role: "user",
            };
            const pending: PersistedPendingContextMessage = {
                anchorRunId,
                createdAt,
                message,
                position,
            };
            this.#separateModelContextFromVisibleTranscript();
            this.#storeMessage(position, message, false, anchorRunId);
            this.#persistence?.insertPendingContextMessage?.(this.id, pending);
            this.#pendingContextMessages.set(messageId, pending);
            this.#lastMessageAt = createdAt;
            const event = this.#append("message_submitted", {
                delivery: "context",
                displayText: request.text,
                message,
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                runId: anchorRunId,
            });
            return {
                delivery: "context",
                eventId: event.id,
                messageId,
                sessionId: this.id,
            };
        };
        return this.#persistence?.transaction === undefined
            ? apply()
            : this.#persistence.transaction(apply);
    }

    /**
     * Records authenticated friend context without turning it into owner activity.
     *
     * Arrival is durable and visible immediately, but it neither starts nor wakes a run, steers
     * active inference, interrupts waits, nor changes owner-derived timing and metadata facts.
     */
    deliverFriendMessage(
        message: UserMessage & {
            contextOnly: true;
            friendAuthor: NonNullable<UserMessage["friendAuthor"]>;
        },
    ): void {
        this.#assertAcceptingWork();
        if (this.events.messageSubmission(message.id) !== undefined) return;
        const apply = () => {
            const createdAt = this.#now();
            const anchorRunId = `friend:${message.id}`;
            const position = this.#nextMessagePosition();
            const stored = structuredClone(message);
            const pending: PersistedPendingContextMessage = {
                anchorRunId,
                createdAt,
                message: stored,
                position,
            };
            this.#storeMessage(position, stored, false, anchorRunId);
            this.#persistence?.insertPendingContextMessage?.(this.id, pending);
            this.#pendingContextMessages.set(stored.id, pending);
            this.#append("message_submitted", {
                delivery: "context",
                displayText: textOfContentBlocks(stored.blocks),
                message: stored,
                runId: anchorRunId,
            });
        };
        if (this.#persistence?.transaction === undefined) apply();
        else this.#persistence.transaction(apply);
    }

    /** Applies the in-memory half after sharing persistence committed the message atomically. */
    applyPersistedFriendMessage(
        message: UserMessage & {
            contextOnly: true;
            friendAuthor: NonNullable<UserMessage["friendAuthor"]>;
        },
        persisted: {
            createdAt: number;
            event: Extract<SessionEvent, { type: "message_submitted" }>;
            overflowedMessageIds: readonly string[];
            position: number;
        },
    ): void {
        this.#assertAcceptingWork();
        if (this.events.messageSubmission(message.id) !== undefined) return;
        const anchorRunId = `friend:${message.id}`;
        const stored = structuredClone(message);
        const pending: PersistedPendingContextMessage = {
            anchorRunId,
            createdAt: persisted.createdAt,
            message: stored,
            position: persisted.position,
        };
        for (const messageId of persisted.overflowedMessageIds) {
            this.#pendingContextMessages.delete(messageId);
        }
        this.#storeMessage(persisted.position, stored, false, anchorRunId, false);
        this.#pendingContextMessages.set(stored.id, pending);
        this.#appendDurableEvent(persisted.event);
    }

    /**
     * Removes already-included friend context without changing the visible transcript.
     *
     * The durable sharing toggle is owned by the caller's persistence operation. This method is
     * the in-memory/cache half and is intentionally safe only between turns.
     */
    setFriendMessagesInModel(enabled: boolean): void {
        if (enabled) return;
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error(
                "Wait for the active response and queued messages before excluding friend context.",
            );
        }
        this.#excludeFriendModelContext();
        this.#saveSession();
    }

    #excludeFriendModelContext(): void {
        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        const current =
            runtimeSnapshot?.contextMessages ??
            runtimeSnapshot?.messages ??
            this.#contextMessages ??
            this.#committedMessages().filter((message) => !isExcludedFromModelContext(message));
        const filtered = current.filter((message) => !isFriendModelContext(message));
        this.#contextMessages = [...filtered];
        this.#runtime?.agent.replaceContextMessages(filtered);
    }

    submit(
        request: SessionSubmitMessageRequest,
        options: { source?: "notification" } = {},
    ): SubmitMessageResponse {
        this.#assertAcceptingWork();
        this.#assertConfigurationCanApply(request);
        if (request.clientSubmissionId !== undefined) {
            const existingEvent = this.events.messageSubmission(request.clientSubmissionId);
            if (existingEvent !== undefined && existingEvent.data.delivery !== "context") {
                return {
                    eventId: existingEvent.id,
                    runId: existingEvent.data.runId,
                    sessionId: this.id,
                };
            }
            const existingMessage = this.#submittedUserMessages.get(request.clientSubmissionId);
            if (existingMessage?.message.role === "user" && existingMessage.runId !== undefined) {
                const recoveredEvent = this.#append("message_submitted", {
                    delivery: "run",
                    displayText: request.displayText ?? request.text,
                    message: existingMessage.message,
                    runId: existingMessage.runId,
                    ...(options.source === undefined ? {} : { source: options.source }),
                });
                return {
                    eventId: recoveredEvent.id,
                    runId: existingMessage.runId,
                    sessionId: this.id,
                };
            }
        }
        this.#interruptDurableWaits();
        if (options.source === undefined && request.provenance !== "agent") {
            this.setArchived(false);
        }
        const runId = createId();
        const createdAt = this.#now();
        const displayText = request.displayText ?? request.text;
        const blocks: readonly ContentBlock[] = request.content ?? [
            { type: "text", text: createCodeReviewPrompt(request.text) ?? request.text },
        ];
        const userMessage: UserMessage = {
            role: "user",
            id: request.clientSubmissionId ?? createId(),
            blocks,
            ...(request.agentSource === undefined ? {} : { agentSource: request.agentSource }),
            ...(options.source === "notification" || request.provenance === "agent"
                ? { provenance: "agent" as const }
                : {}),
            ...(request.encryptedAgentMessage === undefined
                ? {}
                : { encryptedAgentMessage: request.encryptedAgentMessage }),
            ...(request.agentMessageTriggerTurn === undefined
                ? {}
                : { agentMessageTriggerTurn: request.agentMessageTriggerTurn }),
        };
        const visibleMessage: UserMessage = {
            role: "user",
            id: userMessage.id,
            ...(request.agentSource === undefined ? {} : { agentSource: request.agentSource }),
            ...(options.source === "notification" || request.provenance === "agent"
                ? { provenance: "agent" as const }
                : {}),
            blocks: blocks.some((block) => block.type === "image")
                ? blocks
                : displayText.length > 0
                  ? [{ type: "text", text: displayText }]
                  : [],
        };
        const queued: PersistedQueuedRun = {
            ...(request.debug === true
                ? {
                      debug: true,
                      debugDirectory: createRequestDebugDirectory(
                          this.#request.cwd,
                          runId,
                          createdAt,
                      ),
                      debugRequestContent: userMessage.blocks,
                  }
                : {}),
            displayText,
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
            ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
            ...(request.interactive === undefined ? {} : { interactive: request.interactive }),
            kind: "user",
            runId,
            text: request.text,
            userMessage,
            ...(request.externalTools === undefined
                ? {}
                : {
                      externalTools: request.externalTools.map((definition) => ({ ...definition })),
                  }),
            ...(request.skills === undefined
                ? {}
                : { skills: request.skills.map((definition) => ({ ...definition })) }),
            ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
        };
        const messagePosition = this.#nextMessagePosition();
        const messageEntry: PersistedSessionMessage = {
            isPartial: false,
            message: visibleMessage,
            position: messagePosition,
            runId,
        };
        const event = this.#createEvent("message_submitted", {
            delivery: "run",
            displayText,
            message: visibleMessage,
            runId,
            ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            ...(options.source === undefined ? {} : { source: options.source }),
        });
        const submittedAt = createdAt;
        const workspaceQueueWaiting =
            this.#workspaceQueueWaiting || this.#currentWorkspaceRunReadiness().state === "waiting";
        const acceptedAtomically = this.#persistence?.acceptQueuedRun !== undefined;
        this.#persistence?.acceptQueuedRun?.({
            event,
            message: messageEntry,
            run: queued,
            status: this.#activeRun === undefined ? "queued" : "running",
            submittedAt,
            workspaceQueueWaiting,
        });

        this.#interruption = undefined;
        this.#workspaceQueueWaiting = workspaceQueueWaiting;
        this.#queue.push(queued);
        if (!acceptedAtomically) this.#persistence?.insertQueuedRun(this.id, queued);
        this.#status = this.#activeRun === undefined ? "queued" : "running";
        this.#lastMessageAt = submittedAt;
        this.#separateModelContextFromVisibleTranscript();
        this.#storeMessage(messagePosition, visibleMessage, false, runId, !acceptedAtomically);
        this.#commitEvent(event);
        this.#startDrainQueue();
        this.#restartMetadataSettlement();
        if (options.source === undefined && request.provenance !== "agent") {
            this.#reportUserInterventionToDelegator(displayText);
        }
        return {
            ...(queued.debugDirectory === undefined
                ? {}
                : { debugDirectory: queued.debugDirectory }),
            eventId: event.id,
            runId,
            sessionId: this.id,
        };
    }

    /**
     * Tells whichever session delegated this conversation that the user is speaking here now.
     *
     * A delegated session belongs to the user, not to the agent that started it, so the delegator
     * has to learn when they take it over instead of continuing to assume it is alone.
     */
    #reportUserInterventionToDelegator(text: string): void {
        if (this.#agentMetadata.delegatedBySessionId === undefined) return;
        this.#agentManager?.notifyDelegatorOfUserMessage(this.id, text);
    }

    steer(request: SteerMessageRequest): SteerMessageResponse {
        this.#assertAcceptingWork();
        if (request.clientSubmissionId !== undefined) {
            const existingEvent = this.events.messageSubmission(request.clientSubmissionId);
            if (existingEvent !== undefined && existingEvent.data.delivery !== "context") {
                return {
                    delivery: existingEvent.data.delivery ?? "run",
                    eventId: existingEvent.id,
                    runId: existingEvent.data.runId,
                    sessionId: this.id,
                };
            }
        }
        const activeRun = this.#activeRun;
        if (
            activeRun === undefined ||
            (request.expectedRunId !== undefined && activeRun.runId !== request.expectedRunId)
        ) {
            return { ...this.submit(request), delivery: "run" };
        }
        this.#interruptDurableWaits();
        // Presence alone decides this, not whether the value differs from the current one, so the
        // rule does not quietly depend on what the session happens to be set to right now.
        if (
            request.externalTools !== undefined ||
            request.skills !== undefined ||
            request.systemPrompt !== undefined ||
            request.effort !== undefined ||
            request.modelId !== undefined ||
            request.providerId !== undefined ||
            request.serviceTier !== undefined
        ) {
            throw new Error(
                "The model, reasoning effort, fast mode, external functions, durable skills, and the system prompt can only be changed by submitting a message, which runs once the current response finishes.",
            );
        }
        this.setArchived(false);
        const displayText = request.displayText ?? request.text;
        const blocks: readonly ContentBlock[] = request.content ?? [
            { type: "text", text: request.text },
        ];
        const userMessage: UserMessage = {
            role: "user",
            id: request.clientSubmissionId ?? createId(),
            blocks,
        };

        const agent = this.#ensureRuntime().agent;
        const continuation = this.#pendingSteeringContinuations.get(activeRun.runId);
        if (continuation !== undefined && !continuation.cancelled) {
            const pendingContext = this.#reservePendingContextForSteering(activeRun.runId);
            for (const pending of pendingContext) {
                agent.enqueueMessage(pending.message);
                if (!continuation.contextMessageIds.includes(pending.message.id)) {
                    continuation.contextMessageIds.push(pending.message.id);
                }
            }
            agent.enqueueMessage(userMessage);
            this.#storeMessage(this.#nextMessagePosition(), userMessage, false, activeRun.runId);
            this.#interruption = undefined;
            this.#lastMessageAt = this.#now();
            const event = this.#append("message_submitted", {
                delivery: "steer",
                displayText,
                message: userMessage,
                runId: activeRun.runId,
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
            });
            this.#rememberSteeringContinuationMessage(continuation, userMessage.id);
            this.#restartMetadataSettlement();
            this.#reportUserInterventionToDelegator(displayText);
            return {
                delivery: "steer",
                eventId: event.id,
                runId: activeRun.runId,
                sessionId: this.id,
            };
        }
        const pending = agent.status === "running";
        if (pending) {
            for (const context of this.#reservePendingContextForSteering(activeRun.runId)) {
                agent.steerMessage(context.message);
            }
            this.#pendingSteeringMessages.set(userMessage.id, {
                createdAt: this.#now(),
                message: userMessage,
                runId: activeRun.runId,
            });
            agent.steerMessage(userMessage);
        } else {
            const context = this.#drainPendingContextMessages();
            for (const pendingContext of context) {
                agent.enqueueMessage(pendingContext.message);
            }
            agent.enqueueMessage(userMessage);
            this.#storeMessage(this.#nextMessagePosition(), userMessage, false, activeRun.runId);
        }
        this.#interruption = undefined;
        this.#lastMessageAt = this.#now();
        const event = this.#append("message_submitted", {
            delivery: "steer",
            displayText,
            message: userMessage,
            runId: activeRun.runId,
        });
        if (!pending) {
            this.#append("steering_applied", {
                messageIds: [userMessage.id],
                runId: activeRun.runId,
            });
        }
        this.#restartMetadataSettlement();
        this.#reportUserInterventionToDelegator(displayText);
        return {
            delivery: "steer",
            eventId: event.id,
            runId: activeRun.runId,
            sessionId: this.id,
        };
    }

    deliverNotification(
        request: SubmitMessageRequest,
    ): SubmitMessageResponse | SteerMessageResponse {
        this.#assertAcceptingWork();
        this.#interruptDurableWaits();
        if (this.#activeRun === undefined) {
            return this.submit(request, { source: "notification" });
        }

        const activeRun = this.#activeRun;
        const displayText = request.displayText ?? request.text;
        const userMessage: UserMessage = {
            blocks: request.content ?? [{ type: "text", text: request.text }],
            id: createId(),
            provenance: "agent",
            role: "user",
        };
        const visibleMessage: UserMessage = {
            blocks: displayText.length > 0 ? [{ type: "text", text: displayText }] : [],
            id: userMessage.id,
            provenance: "agent",
            role: "user",
        };
        const agent = this.#ensureRuntime().agent;

        const pending = agent.status === "running";
        if (pending) {
            this.#pendingSteeringMessages.set(userMessage.id, {
                createdAt: this.#now(),
                message: visibleMessage,
                runId: activeRun.runId,
            });
            agent.steerMessage(userMessage);
        } else {
            agent.enqueueMessage(userMessage);
            this.#storeMessage(this.#nextMessagePosition(), visibleMessage, false, activeRun.runId);
        }
        this.#interruption = undefined;
        const event = this.#append("message_submitted", {
            delivery: "steer",
            displayText,
            message: visibleMessage,
            runId: activeRun.runId,
            source: "notification",
        });
        if (!pending) {
            this.#append("steering_applied", {
                messageIds: [userMessage.id],
                runId: activeRun.runId,
            });
        }
        return {
            delivery: "steer",
            eventId: event.id,
            runId: activeRun.runId,
            sessionId: this.id,
        };
    }

    deliverAgentMessage(message: UserMessage): void {
        this.#assertAcceptingWork();
        if (this.events.messageSubmission(message.id) !== undefined) return;
        this.#interruptDurableWaits();
        const agent = this.#ensureRuntime().agent;
        const activeRun = this.#activeRun;
        const displayText = message.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
        if (activeRun !== undefined && agent.status === "running") {
            this.#pendingSteeringMessages.set(message.id, {
                createdAt: this.#now(),
                message,
                runId: activeRun.runId,
            });
            agent.steerMessage(message);
            this.#lastMessageAt = this.#now();
            this.#append("message_submitted", {
                delivery: "steer",
                displayText,
                message,
                runId: activeRun.runId,
            });
            return;
        }
        this.submit({
            ...(message.agentSource === undefined ? {} : { agentSource: message.agentSource }),
            agentMessageTriggerTurn: true,
            clientSubmissionId: message.id,
            content: message.blocks,
            displayText,
            ...(message.encryptedAgentMessage === undefined
                ? {}
                : { encryptedAgentMessage: message.encryptedAgentMessage }),
            provenance: "agent",
            text: displayText,
        });
    }

    subagentSummary(): SubagentSummary {
        if (
            this.#agentMetadata.type !== "subagent" ||
            this.#agentMetadata.parentSessionId === undefined
        ) {
            throw new Error("Only subagent sessions have subagent summaries.");
        }

        const messages = this.#committedMessages();
        const latestText = limitInspectionText(findLastAgentResponseText(messages));
        const prompt = limitInspectionText(findFirstUserRequestText(messages));
        return {
            ...(this.#activeSince === undefined ? {} : { activeSince: this.#activeSince }),
            agentId: this.#agentId,
            createdAt: this.#createdAt,
            depth: this.#agentMetadata.depth,
            description: this.#agentMetadata.description ?? "Delegated task",
            elapsedMs: this.#elapsedMs,
            id: this.id,
            ...(latestText === undefined ? {} : { latestText }),
            modelId: this.#modelId,
            parentSessionId: this.#agentMetadata.parentSessionId,
            ...(this.#agentMetadata.parentToolCallId !== undefined
                ? { parentToolCallId: this.#agentMetadata.parentToolCallId }
                : {}),
            ...(prompt === undefined ? {} : { prompt }),
            status: this.#status,
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            ...(this.#agentMetadata.taskName !== undefined
                ? { taskName: this.#agentMetadata.taskName }
                : {}),
            totalTokens: this.#totalTokens,
            updatedAt: this.events.lastCreatedAt() ?? this.#now(),
            ...(this.#usage.totalTokens === 0 ? {} : { usage: structuredClone(this.#usage) }),
        };
    }

    lastErrorMessage(): string | undefined {
        const events = this.events.since(undefined) ?? [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event?.type === "run_error") return event.data.errorMessage;
        }
        return undefined;
    }

    waitForRun(runId: string): Promise<SessionRunCompletion> {
        const completed = this.#completionForRun(runId);
        if (completed !== undefined) {
            return Promise.resolve(completed);
        }

        return new Promise((resolve) => {
            const unsubscribe = this.events.subscribe((event) => {
                if (
                    (event.type !== "run_finished" && event.type !== "run_error") ||
                    event.data.runId !== runId
                ) {
                    return;
                }
                unsubscribe();
                resolve(
                    event.type === "run_error"
                        ? { errorMessage: event.data.errorMessage, status: "error" }
                        : completionFromRunFinished(event),
                );
            });
        });
    }

    externalToolCalls(options: { status?: ExternalToolCall["status"] } = {}): ExternalToolCall[] {
        return [...this.#externalToolCalls.values()]
            .filter((call) => options.status === undefined || call.status === options.status)
            .sort(
                (left, right) =>
                    left.createdAt - right.createdAt || left.toolCallIndex - right.toolCallIndex,
            )
            .map(cloneExternalToolCall);
    }

    async waitDurably(request: DurableWaitRequest, signal?: AbortSignal): Promise<WaitResult> {
        const runId = this.#activeRun?.runId;
        if (runId === undefined) throw new Error("The durable wait has no active run.");
        const existing = [...this.#durableWaits.values()].find(
            (wait) =>
                wait.runId === runId &&
                wait.batchId === request.batchId &&
                wait.toolCallId === request.toolCallId,
        );
        if (existing?.result !== undefined) return structuredClone(existing.result);
        const wait: DurableWait = existing ?? {
            arguments: structuredClone(request.arguments),
            batchId: request.batchId,
            consumed: false,
            createdAt: this.#now(),
            dueAt: request.dueAt,
            id: createId(),
            kind: request.kind,
            ...(request.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: request.providerToolCallId }),
            runId,
            sessionId: this.id,
            status: "waiting",
            toolCallId: request.toolCallId,
            toolCallIndex: request.toolCallIndex,
            toolName: request.toolName,
        };
        if (existing === undefined) {
            this.#persistence?.upsertDurableWait?.(wait);
            this.#durableWaits.set(wait.id, wait);
            this.#armDurableWait(wait);
            this.#refreshWaitActivity();
        }
        if (wait.dueAt <= this.#now()) {
            const settled = this.#settleDurableWait(wait, false);
            if (settled !== undefined) return settled;
        }
        return new Promise<WaitResult>((resolve, reject) => {
            let waiter: DurableWaitWaiter;
            const abort = () => {
                if (this.#durableWaitWaiters.get(wait.id) !== waiter) return;
                this.#durableWaitWaiters.delete(wait.id);
                reject(new Error("The durable wait was interrupted."));
            };
            waiter = {
                reject: (error) => {
                    signal?.removeEventListener("abort", abort);
                    reject(error);
                },
                resolve: (result) => {
                    signal?.removeEventListener("abort", abort);
                    resolve(structuredClone(result));
                },
            };
            this.#durableWaitWaiters.set(wait.id, waiter);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted === true) abort();
        });
    }

    hasDurableToolRun(): boolean {
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        if (runId === undefined) return false;
        const calls = [
            ...[...this.#externalToolCalls.values()]
                .filter((call) => call.runId === runId && call.status !== "cancelled")
                .map((call) => ({ consumed: call.consumed, toolCallId: call.toolCallId })),
            ...[...this.#durableUserInputs.values()]
                .filter((call) => call.runId === runId && call.status !== "cancelled")
                .map((call) => ({ consumed: call.consumed, toolCallId: call.toolCallId })),
            ...[...this.#durableWaits.values()]
                .filter((wait) => wait.runId === runId && wait.status !== "cancelled")
                .map((wait) => ({ consumed: wait.consumed, toolCallId: wait.toolCallId })),
        ];
        if (calls.length === 0) return false;
        if (calls.some((call) => !call.consumed)) return true;
        const resultIds = new Set(calls.map((call) => call.toolCallId));
        const resultPosition = this.#messages.reduce(
            (latest, entry) =>
                entry.message.role === "agent" &&
                entry.message.blocks.some(
                    (block) => block.type === "tool_result" && resultIds.has(block.toolCallId),
                )
                    ? Math.max(latest, entry.position)
                    : latest,
            -1,
        );
        return (
            resultPosition >= 0 &&
            !this.#messages.some(
                (entry) => entry.runId === runId && entry.position > resultPosition,
            )
        );
    }

    resumeDurableToolRun(): void {
        if (this.#workspaceArchived) return;
        if (this.#resumingDurableToolRun) {
            this.#resumeDurableToolRunAgain = true;
            return;
        }
        this.#resumingDurableToolRun = true;
        this.#resumeDurableToolRunAgain = false;
        void this.#resumeDurableToolRun()
            .catch(rethrowDatabaseFailure)
            .finally(() => {
                this.#resumingDurableToolRun = false;
                if (this.#resumeDurableToolRunAgain) {
                    this.resumeDurableToolRun();
                } else if (
                    this.#queue.length > 0 &&
                    (this.#restoredActiveRunId === undefined || !this.hasDurableToolRun())
                ) {
                    this.#startDrainQueue();
                }
            });
    }

    async #resumeDurableToolRun(): Promise<void> {
        if (this.#workspaceArchived || this.#closing || this.#activeRun !== undefined) return;
        const runId = this.#restoredActiveRunId;
        if (runId === undefined || !this.hasDurableToolRun()) return;
        this.#reconcileExternalToolConsumption(runId);
        this.#reconcileDurableUserInputConsumption(runId);
        this.#reconcileDurableWaitConsumption(runId);
        while (true) {
            const call = [...this.#durableUserInputs.values()].find(
                (candidate) =>
                    candidate.runId === runId &&
                    !candidate.consumed &&
                    (candidate.status === "answered" || candidate.status === "executing"),
            );
            if (call === undefined) break;
            if (call.status === "executing") {
                call.result = createErrorToolResultBlock(
                    { id: call.toolCallId, name: call.toolName },
                    `Tool '${call.toolName}' was interrupted after approval and was not replayed.`,
                    { kind: "interrupted" },
                );
                call.status = "completed";
                call.resolvedAt = this.#now();
                this.#persistence?.upsertDurableUserInput?.(call);
            } else if (call.status === "answered") {
                await this.#resumeAnsweredDurableUserInput(call);
                if (this.#activeRun !== undefined) return;
            }
        }
        const unconsumed = [
            ...[...this.#externalToolCalls.values()]
                .filter(
                    (call) => call.runId === runId && !call.consumed && call.status !== "cancelled",
                )
                .map((call) => ({
                    batchId: call.batchId,
                    call,
                    createdAt: call.createdAt,
                    kind: "external" as const,
                    pending: call.status === "pending",
                    toolCallIndex: call.toolCallIndex,
                })),
            ...[...this.#durableUserInputs.values()]
                .filter(
                    (call) => call.runId === runId && !call.consumed && call.status !== "cancelled",
                )
                .map((call) => ({
                    batchId: call.batchId,
                    call,
                    createdAt: call.createdAt,
                    kind: "user_input" as const,
                    pending: call.status !== "completed",
                    toolCallIndex: call.toolCallIndex,
                })),
            ...[...this.#durableWaits.values()]
                .filter(
                    (wait) => wait.runId === runId && !wait.consumed && wait.status !== "cancelled",
                )
                .map((wait) => ({
                    batchId: wait.batchId,
                    call: wait,
                    createdAt: wait.createdAt,
                    kind: "wait" as const,
                    pending: wait.status === "waiting",
                    toolCallIndex: wait.toolCallIndex,
                })),
        ].sort(
            (left, right) =>
                left.createdAt - right.createdAt || left.toolCallIndex - right.toolCallIndex,
        );
        if (unconsumed.length > 0) {
            const batchId = unconsumed[0]?.batchId;
            const batch = unconsumed.filter((call) => call.batchId === batchId);
            if (batch.some((entry) => entry.pending)) return;
            const resultMessage: AgentMessage = {
                blocks: batch
                    .sort((left, right) => left.toolCallIndex - right.toolCallIndex)
                    .map((entry) => {
                        if (entry.kind === "external") {
                            return this.#externalToolResultBlock(entry.call);
                        }
                        if (entry.kind === "wait") {
                            if (entry.call.resultBlock === undefined) {
                                throw new Error("A durable wait has no tool result.");
                            }
                            return structuredClone(entry.call.resultBlock);
                        }
                        if (entry.call.result === undefined) {
                            throw new Error("A durable user input has no tool result.");
                        }
                        return structuredClone(entry.call.result);
                    }),
                id: createId(),
                role: "agent",
            };
            this.#storeMessage(this.#nextMessagePosition(), resultMessage, false, runId);
            for (const entry of batch) {
                entry.call.consumed = true;
                if (entry.kind === "external") {
                    this.#persistence?.upsertExternalToolCall?.(entry.call);
                } else if (entry.kind === "user_input") {
                    this.#persistence?.upsertDurableUserInput?.(entry.call);
                } else {
                    this.#persistence?.upsertDurableWait?.(entry.call);
                }
            }
            this.#pruneExternalToolCalls();
            this.#pruneDurableUserInputs();
            this.#pruneDurableWaits();
            this.#append("agent_message", { message: resultMessage, runId });
        }
        this.#contextMessages = undefined;
        // The runtime is being discarded, so nothing could ever read or stop
        // its background commands again.
        void this.#killRuntimeProcesses({ includeBackground: true });
        void this.#runtime?.agent.close();
        this.#runtime = undefined;
        const continuation = () => this.#continueDurableToolRun(runId);
        const running = this.#taskDrain?.run(continuation) ?? continuation();
        await running;
    }

    resolveExternalToolCall(
        callId: string,
        resolution: ExternalToolCallResolution,
    ): ResolveExternalToolCallResponse | undefined {
        const call = this.#externalToolCalls.get(callId);
        if (call === undefined) return undefined;
        if (call.resolution !== undefined) {
            if (!isDeepStrictEqual(call.resolution, resolution)) {
                throw new Error("This external function call already has a different result.");
            }
            return { accepted: false, call: cloneExternalToolCall(call) };
        }
        if (call.status !== "pending") {
            throw new Error("This external function call is no longer waiting for a result.");
        }
        if (
            call.skill !== undefined &&
            resolution.status === "completed" &&
            (resolution.content !== undefined || typeof resolution.output !== "string")
        ) {
            throw new Error(
                "A durable skill result must provide the complete SKILL.md as text output.",
            );
        }
        call.resolution = cloneExternalResolution(resolution);
        call.resolvedAt = this.#now();
        call.status = resolution.status;
        this.#persistence?.upsertExternalToolCall?.(call);
        this.#append("external_tool_call_resolved", { call: cloneExternalToolCall(call) });
        const waiter = this.#externalToolWaiters.get(call.id);
        if (waiter !== undefined) {
            this.#externalToolWaiters.delete(call.id);
            waiter.resolve(cloneExternalResolution(resolution));
        } else {
            this.resumeDurableToolRun();
        }
        return { accepted: true, call: cloneExternalToolCall(call) };
    }

    async #invokeExternalTool(
        definition: ExternalToolDefinition,
        request: {
            arguments: unknown;
            batchId: string;
            providerToolCallId?: string;
            toolCallId: string;
            toolCallIndex: number;
        },
        signal?: AbortSignal,
        skill?: DurableSkillDefinition,
    ): Promise<ExternalToolCallResolution> {
        const runId = this.#activeRun?.runId;
        if (runId === undefined) throw new Error("The external function has no active run.");
        const existing = [...this.#externalToolCalls.values()].find(
            (call) =>
                call.runId === runId &&
                call.batchId === request.batchId &&
                call.toolCallId === request.toolCallId,
        );
        if (existing?.resolution !== undefined) return cloneExternalResolution(existing.resolution);
        const call: ExternalToolCall = existing ?? {
            arguments: request.arguments,
            batchId: request.batchId,
            consumed: false,
            createdAt: this.#now(),
            definition: { ...definition },
            id: createId(),
            runId,
            sessionId: this.id,
            status: "pending",
            ...(request.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: request.providerToolCallId }),
            toolCallId: request.toolCallId,
            toolCallIndex: request.toolCallIndex,
            ...(skill === undefined ? {} : { skill: { ...skill } }),
        };
        if (existing === undefined) {
            this.#externalToolCalls.set(call.id, call);
            this.#persistence?.upsertExternalToolCall?.(call);
            this.#append("external_tool_call_requested", { call: cloneExternalToolCall(call) });
        }
        this.#pruneDurableUserInputs();
        return new Promise<ExternalToolCallResolution>((resolve, reject) => {
            let waiter: ExternalToolWaiter;
            const abort = () => {
                if (this.#externalToolWaiters.get(call.id) !== waiter) return;
                this.#externalToolWaiters.delete(call.id);
                reject(new Error(`External function ${definition.name} was interrupted.`));
            };
            waiter = {
                reject: (error) => {
                    signal?.removeEventListener("abort", abort);
                    reject(error);
                },
                resolve: (resolution) => {
                    signal?.removeEventListener("abort", abort);
                    resolve(resolution);
                },
            };
            this.#externalToolWaiters.set(call.id, waiter);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted === true) abort();
        });
    }

    #externalToolResultBlock(call: ExternalToolCall): ToolResultBlock {
        const resolution = call.resolution;
        if (resolution === undefined) {
            throw new Error(`External function ${call.definition.name} has no result.`);
        }
        const failed = resolution.status === "failed";
        const display =
            call.skill === undefined
                ? `External function ${call.definition.name} ${failed ? "failed" : "completed"}`
                : `Skill ${call.skill.name} ${failed ? "could not be read" : "read"}`;
        return {
            display,
            ...(failed
                ? {
                      failure: {
                          kind: "execution_failed" as const,
                          message: resolution.error.message,
                      },
                      isError: true,
                  }
                : {}),
            rendered: externalToolResolutionToContent(resolution),
            ...(call.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: call.providerToolCallId }),
            toolCallId: call.toolCallId,
            toolName: call.definition.name,
            type: "tool_result",
        };
    }

    #reconcileExternalToolConsumption(runId: string): void {
        const consumedToolCallIds = new Set(
            this.#messages.flatMap((entry) =>
                entry.message.role !== "agent"
                    ? []
                    : entry.message.blocks.flatMap((block) =>
                          block.type === "tool_result" ? [block.toolCallId] : [],
                      ),
            ),
        );
        for (const call of this.#externalToolCalls.values()) {
            if (
                call.runId !== runId ||
                call.consumed ||
                !consumedToolCallIds.has(call.toolCallId)
            ) {
                continue;
            }
            call.consumed = true;
            this.#persistence?.upsertExternalToolCall?.(call);
        }
        this.#pruneExternalToolCalls();
    }

    async #resumeAnsweredDurableUserInput(call: DurableUserInputCall): Promise<void> {
        const response = call.response;
        if (response === undefined || call.status !== "answered") return;
        const runtime = this.#ensureRuntime();
        const tool = runtime.agent.tools.find((candidate) => candidate.name === call.toolName);
        if (tool?.resolveUserInput === undefined) {
            call.result = createErrorToolResultBlock(
                {
                    id: call.toolCallId,
                    name: call.toolName,
                    ...(call.providerToolCallId === undefined
                        ? {}
                        : { providerToolCallId: call.providerToolCallId }),
                },
                `Tool '${call.toolName}' cannot restore its durable user answer.`,
                { kind: "execution_failed" },
            );
        } else {
            const result = tool.resolveUserInput(response, call.toolArguments as never);
            call.result = createToolResultBlock(
                tool,
                call.toolArguments,
                result,
                call.toolCallId,
                undefined,
                call.providerToolCallId,
            );
        }
        call.status = "completed";
        this.#persistence?.upsertDurableUserInput?.(call);
    }

    #reconcileDurableUserInputConsumption(runId: string): void {
        const consumedToolCallIds = new Set(
            this.#messages.flatMap((entry) =>
                entry.message.role !== "agent"
                    ? []
                    : entry.message.blocks.flatMap((block) =>
                          block.type === "tool_result" ? [block.toolCallId] : [],
                      ),
            ),
        );
        for (const call of this.#durableUserInputs.values()) {
            if (
                call.runId !== runId ||
                call.consumed ||
                !consumedToolCallIds.has(call.toolCallId)
            ) {
                continue;
            }
            call.consumed = true;
            this.#persistence?.upsertDurableUserInput?.(call);
        }
        this.#pruneDurableUserInputs();
    }

    #reconcileDurableWaitConsumption(runId: string): void {
        const consumedToolCallIds = new Set(
            this.#messages.flatMap((entry) =>
                entry.message.role !== "agent"
                    ? []
                    : entry.message.blocks.flatMap((block) =>
                          block.type === "tool_result" ? [block.toolCallId] : [],
                      ),
            ),
        );
        for (const current of this.#durableWaits.values()) {
            if (
                current.runId !== runId ||
                current.consumed ||
                !consumedToolCallIds.has(current.toolCallId)
            ) {
                continue;
            }
            const next = { ...current, consumed: true };
            this.#persistence?.upsertDurableWait?.(next);
            this.#durableWaits.set(next.id, next);
        }
        this.#pruneDurableWaits();
    }

    #cancelDurableUserInput(call: DurableUserInputCall): void {
        // A detached question is consumed by its run but still open to the user, so it can be
        // withdrawn.
        if (call.status === "cancelled" || (call.consumed && !isOpenQuestion(call))) return;
        call.status = "cancelled";
        call.resolvedAt = this.#now();
        this.#persistence?.upsertDurableUserInput?.(call);
        this.#append("user_input_resolved", {
            requestId: call.request.requestId,
            status: "cancelled",
        });
    }

    #cancelDurableUserInputs(runId: string): void {
        for (const call of this.#durableUserInputs.values()) {
            if (call.runId === runId && !call.consumed) this.#cancelDurableUserInput(call);
        }
        this.#pruneDurableUserInputs();
    }

    #restoreDurableWaitTimers(): void {
        for (const wait of this.#durableWaits.values()) {
            if (wait.status === "waiting") this.#armDurableWait(wait);
        }
    }

    #armDurableWait(wait: DurableWait): void {
        const previous = this.#durableWaitTimers.get(wait.id);
        if (previous !== undefined) clearTimeout(previous);
        const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, wait.dueAt - this.#now()));
        const timer = setTimeout(() => {
            if (this.#durableWaitTimers.get(wait.id) !== timer) return;
            this.#durableWaitTimers.delete(wait.id);
            const current = this.#durableWaits.get(wait.id);
            if (current === undefined || current.status !== "waiting") return;
            if (current.dueAt > this.#now()) {
                this.#armDurableWait(current);
                return;
            }
            this.#settleDurableWait(current, false);
        }, delay);
        this.#durableWaitTimers.set(wait.id, timer);
    }

    #settleDurableWait(wait: DurableWait, interrupted: boolean): WaitResult | undefined {
        const current = this.#durableWaits.get(wait.id);
        if (current === undefined || current.status !== "waiting") return current?.result;
        const endedAt = this.#now();
        const result: WaitResult = {
            dueAt: current.dueAt,
            elapsedSeconds: Math.max(0, endedAt - current.createdAt) / 1_000,
            endedAt,
            interrupted,
            reason: interrupted ? "message_received" : "completed",
            startedAt: current.createdAt,
        };
        const next: DurableWait = {
            ...current,
            result,
            resultBlock: durableWaitResultBlock(current, result),
            status: interrupted ? "interrupted" : "completed",
        };
        this.#persistence?.upsertDurableWait?.(next);
        this.#durableWaits.set(next.id, next);
        const timer = this.#durableWaitTimers.get(next.id);
        if (timer !== undefined) clearTimeout(timer);
        this.#durableWaitTimers.delete(next.id);
        this.#refreshWaitActivity();
        const waiter = this.#durableWaitWaiters.get(next.id);
        if (waiter === undefined) {
            this.resumeDurableToolRun();
        } else {
            this.#durableWaitWaiters.delete(next.id);
            waiter.resolve(result);
        }
        return result;
    }

    #interruptDurableWaits(): void {
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        if (runId === undefined) return;
        for (const wait of this.#durableWaits.values()) {
            if (wait.runId === runId && wait.status === "waiting") {
                this.#settleDurableWait(wait, true);
            }
        }
    }

    #cancelDurableWaits(runId: string): void {
        for (const current of this.#durableWaits.values()) {
            if (current.runId !== runId || current.status !== "waiting") continue;
            const next: DurableWait = { ...current, status: "cancelled" };
            this.#persistence?.upsertDurableWait?.(next);
            this.#durableWaits.set(next.id, next);
            const timer = this.#durableWaitTimers.get(next.id);
            if (timer !== undefined) clearTimeout(timer);
            this.#durableWaitTimers.delete(next.id);
            const waiter = this.#durableWaitWaiters.get(next.id);
            if (waiter !== undefined) {
                this.#durableWaitWaiters.delete(next.id);
                waiter.reject(new Error("The durable wait was cancelled."));
            }
        }
        this.#refreshWaitActivity();
        this.#pruneDurableWaits();
    }

    #refreshWaitActivity(publish = true): void {
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        const waiting = [...this.#durableWaits.values()]
            .filter((wait) => wait.runId === runId && wait.status === "waiting")
            .sort((left, right) => left.dueAt - right.dueAt)[0];
        if (waiting === undefined && this.#activity.wait === undefined) return;
        const { wait: _previousWait, ...base } = this.#activity;
        const next: SessionActivity =
            waiting === undefined
                ? (base.reviewingToolCalls?.length ?? 0) > 0
                    ? {
                          ...base,
                          kind: "reviewing_tool_call",
                          label:
                              base.reviewingToolCalls?.length === 1
                                  ? `Reviewing ${base.reviewingToolCalls[0]?.toolName ?? "tool"}`
                                  : `Reviewing ${String(base.reviewingToolCalls?.length ?? 0)} tools`,
                          since: this.#now(),
                      }
                    : (base.toolCalls?.length ?? 0) > 0
                      ? {
                            ...base,
                            kind: "executing_tool_call",
                            label:
                                base.toolCalls?.length === 1
                                    ? `Running ${base.toolCalls[0]?.toolName ?? "tool"}`
                                    : `Running ${String(base.toolCalls?.length ?? 0)} tools`,
                            since: this.#now(),
                        }
                      : { ...base, kind: "thinking", label: "Thinking", since: this.#now() }
                : {
                      ...base,
                      kind: "waiting",
                      label: `Waiting until ${new Date(waiting.dueAt).toLocaleString()}`,
                      runId: waiting.runId,
                      since: waiting.createdAt,
                      wait: {
                          dueAt: waiting.dueAt,
                          startedAt: waiting.createdAt,
                          toolCallId: waiting.toolCallId,
                      },
                  };
        this.#activity = next;
        if (!publish) return;
        this.#reportingActivity = true;
        try {
            this.#append("session_activity_changed", { activity: next });
        } finally {
            this.#reportingActivity = false;
        }
    }

    #pruneDurableUserInputs(): void {
        const eligible = [...this.#durableUserInputs.values()]
            // A question presence detached is consumed but still open, so it must survive pruning.
            .filter(
                (call) => call.status === "cancelled" || (call.consumed && !isOpenQuestion(call)),
            )
            .sort(
                (left, right) =>
                    (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt) ||
                    right.toolCallIndex - left.toolCallIndex,
            );
        for (const call of eligible.slice(MAX_RETAINED_DURABLE_USER_INPUTS)) {
            this.#durableUserInputs.delete(call.request.requestId);
        }
        this.#persistence?.pruneDurableUserInputs?.(this.id, MAX_RETAINED_DURABLE_USER_INPUTS);
    }

    #pruneDurableWaits(): void {
        const eligible = [...this.#durableWaits.values()]
            .filter((wait) => wait.status === "cancelled" || wait.consumed)
            .sort(
                (left, right) =>
                    (right.result?.endedAt ?? right.createdAt) -
                        (left.result?.endedAt ?? left.createdAt) ||
                    right.toolCallIndex - left.toolCallIndex,
            );
        this.#persistence?.pruneDurableWaits?.(this.id, MAX_RETAINED_DURABLE_WAITS);
        for (const wait of eligible.slice(MAX_RETAINED_DURABLE_WAITS)) {
            this.#durableWaits.delete(wait.id);
        }
    }

    #pruneScheduledMessages(): void {
        const prune = (): void => {
            const removed =
                this.#persistence?.pruneScheduledMessages?.(
                    this.id,
                    MAX_RETAINED_SETTLED_SCHEDULED_MESSAGES,
                ) ??
                [...this.#scheduledMessages.values()]
                    .filter(
                        (message) =>
                            message.status === "cancelled" || message.status === "delivered",
                    )
                    .sort(
                        (left, right) =>
                            right.updatedAt - left.updatedAt ||
                            right.createdAt - left.createdAt ||
                            right.id.localeCompare(left.id),
                    )
                    .slice(MAX_RETAINED_SETTLED_SCHEDULED_MESSAGES)
                    .map((message) => message.id);
            if (removed.length === 0) return;
            for (const messageId of removed) this.#scheduledMessages.delete(messageId);
            this.#append("scheduled_messages_pruned", { messageIds: removed });
        };
        if (this.#persistence?.transaction === undefined) {
            prune();
            return;
        }
        this.#persistence.transaction(prune);
    }

    #cancelExternalToolCalls(runId: string): void {
        for (const call of this.#externalToolCalls.values()) {
            if (call.runId !== runId || call.status !== "pending") continue;
            call.status = "cancelled";
            call.resolvedAt = this.#now();
            this.#persistence?.upsertExternalToolCall?.(call);
            this.#append("external_tool_call_resolved", { call: cloneExternalToolCall(call) });
            const waiter = this.#externalToolWaiters.get(call.id);
            if (waiter !== undefined) {
                this.#externalToolWaiters.delete(call.id);
                waiter.reject(
                    new Error(`External function ${call.definition.name} was cancelled.`),
                );
            }
        }
        this.#pruneExternalToolCalls();
    }

    #pruneExternalToolCalls(): void {
        const eligible = [...this.#externalToolCalls.values()]
            .filter((call) => call.status === "cancelled" || call.consumed)
            .sort(
                (left, right) =>
                    (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt) ||
                    right.toolCallIndex - left.toolCallIndex,
            );
        for (const call of eligible.slice(MAX_RETAINED_EXTERNAL_TOOL_CALLS)) {
            this.#externalToolCalls.delete(call.id);
        }
        this.#persistence?.pruneExternalToolCalls?.(this.id, MAX_RETAINED_EXTERNAL_TOOL_CALLS);
    }

    async #continueDurableToolRun(runId: string): Promise<void> {
        if (this.#activeRun !== undefined || this.#closing) return;
        const controller = new AbortController();
        this.#activeRun = { controller, debug: false, kind: "user", runId };
        this.#restoredActiveRunId = undefined;
        this.#status = "running";
        this.#activeSince ??= this.#now();
        let runtime: CodingAssistantRuntime | undefined;
        try {
            runtime = this.#ensureRuntime();
            const result = await runtime.agent.run({
                signal: controller.signal,
                onEvent: (event) => this.#appendAgentEvent(runId, event),
                onMessage: (message) => this.#appendAgentMessage(runId, message),
            });
            if (this.#activeRun?.runId !== runId) return;
            this.#appendRunFinished(runId, result);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            runtime?.context.attachments?.discard();
            if (this.#activeRun?.runId !== runId) return;
            const errorMessage = errorToMessage(error);
            this.#appendDurableError(runId, errorMessage, runtime);
            if (!this.#workspaceArchived) this.#status = "error";
            this.#finishElapsedInterval();
            this.#activeRun = undefined;
            this.#append("run_error", {
                errorMessage,
                modelLocked: this.#modelLocked(),
                runId,
            });
        } finally {
            if (this.#activeRun?.runId === runId) this.#activeRun = undefined;
            this.#syncContextMessages();
            await this.#completePendingWorkspaceTransfer(runId);
            this.#saveSession();
        }
    }

    #agentSnapshot(): AgentSnapshot {
        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        const contextMessages = runtimeSnapshot?.contextMessages ?? this.#contextMessages;
        const visibleContextMessages = contextMessages?.filter(
            (message) => !isInternalMessage(message),
        );
        const visibleMessages = this.#committedMessages().filter(
            (message) => !isInternalMessage(message),
        );
        return {
            id: this.#agentId,
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            providerId: this.#providerId,
            modelId: this.#modelId,
            status: this.#agentStatus(),
            messages: this.#committedMessages(),
            queue: runtimeSnapshot?.queue ?? [],
            tools: this.#tools,
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            ...(visibleContextMessages !== undefined &&
            (contextMessages?.some(isInternalMessage) === true ||
                !isDeepStrictEqual(visibleContextMessages, visibleMessages))
                ? {
                      contextMessages: visibleContextMessages,
                  }
                : {}),
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
            ...(runtimeSnapshot?.lastRunId !== undefined
                ? { lastRunId: runtimeSnapshot.lastRunId }
                : {}),
        };
    }

    #agentStatus(): AgentSnapshot["status"] {
        if (this.#status === "running") {
            return "running";
        }
        if (this.#status === "aborted") {
            return "aborted";
        }
        return "idle";
    }

    #recordTasksChanged(): void {
        this.#append("tasks_changed", { tasks: this.listTasks() });
    }

    async #ensureMcpTools(
        runtime: CodingAssistantRuntime,
        signal?: AbortSignal,
        interactive = true,
    ): Promise<void> {
        if (
            this.#mcpLoaded &&
            this.#permissionMode !== "auto" &&
            this.#permissionMode !== "full_access"
        ) {
            return;
        }
        if (this.#mcpToolProvider === undefined) {
            this.#mcpLoaded = true;
            return;
        }

        const permissionMode = this.#permissionMode;
        const mcpLoadOptions =
            !this.isSubagent() &&
            interactive &&
            (permissionMode === "auto" || permissionMode === "full_access")
                ? {
                      requestTrust: (request: McpServerTrustRequest) =>
                          this.#requestMcpTrust(request, signal),
                  }
                : {};
        const loaded = await this.#mcpToolProvider.load(
            this.#request.cwd,
            permissionMode,
            mcpLoadOptions,
        );
        if (this.#permissionMode !== permissionMode) {
            await loaded.release?.().catch(() => undefined);
            return;
        }
        const previousRelease = this.#mcpToolRelease;
        try {
            const baseTools = runtime.agent.tools.filter(
                (tool) => !this.#mcpToolNames.has(tool.name),
            );
            const baseToolNames = new Set(baseTools.map((tool) => tool.name));
            const merged = mergeMcpTools(baseTools, loaded);
            runtime.agent.setTools(merged.tools);
            this.#mcpToolNames = new Set(
                merged.tools
                    .filter((tool) => !baseToolNames.has(tool.name))
                    .map((tool) => tool.name),
            );
            this.#tools = runtime.agent.tools.map((tool) => tool.name);
            const serversChanged =
                JSON.stringify(this.#mcpServers) !== JSON.stringify(merged.servers);
            this.#mcpServers = merged.servers;
            this.#mcpLoaded = true;
            this.#mcpToolRelease = loaded.release;
            if (serversChanged && merged.servers.length > 0) {
                this.#append("mcp_servers_changed", { servers: merged.servers });
            }
        } catch (error) {
            await loaded.release?.().catch(() => undefined);
            throw error;
        }
        await previousRelease?.().catch(() => undefined);
    }

    async #requestMcpTrust(request: McpServerTrustRequest, signal?: AbortSignal): Promise<boolean> {
        const outcome = await this.requestUserInput(
            createMcpTrustUserInputRequest(request),
            signal === undefined ? {} : { signal },
        );
        return (
            outcome.status === "answered" &&
            outcome.answers.mcp_trust?.includes(MCP_TRUST_ANSWER) === true
        );
    }

    #removeMcpTools(runtime: CodingAssistantRuntime | undefined): void {
        if (runtime !== undefined && this.#mcpToolNames.size > 0) {
            runtime.agent.setTools(
                runtime.agent.tools.filter((tool) => !this.#mcpToolNames.has(tool.name)),
            );
            this.#tools = runtime.agent.tools.map((tool) => tool.name);
        }
        this.#mcpLoaded = false;
        this.#mcpServers = [];
        this.#mcpToolNames.clear();
        this.#releaseMcpToolLease();
        this.#append("mcp_servers_changed", { servers: [] });
    }

    #releaseMcpToolLease(): void {
        const release = this.#mcpToolRelease;
        this.#mcpToolRelease = undefined;
        void release?.().catch(() => undefined);
    }

    #append<TType extends SessionEvent["type"]>(
        type: TType,
        data: Extract<SessionEvent, { type: TType }>["data"],
    ): Extract<SessionEvent, { type: TType }> {
        return this.#commitEvent({
            createdAt: this.#now(),
            data,
            id: this.#createEventId(),
            sessionId: this.id,
            type,
        } as Extract<SessionEvent, { type: TType }>);
    }

    #createEvent<TType extends SessionEvent["type"]>(
        type: TType,
        data: Extract<SessionEvent, { type: TType }>["data"],
    ): Extract<SessionEvent, { type: TType }> {
        return {
            createdAt: this.#now(),
            data,
            id: this.#createEventId(),
            sessionId: this.id,
            type,
        } as Extract<SessionEvent, { type: TType }>;
    }

    #commitEvent<TEvent extends SessionEvent>(event: TEvent): TEvent {
        if (this.#workspaceArchived) return event;
        const append = (): TEvent => {
            this.#appendDurableEvent(event);
            return event;
        };
        return this.#persistence?.transaction === undefined
            ? append()
            : this.#persistence.transaction(append);
    }

    /**
     * Records what a provider said about the account while it was answering
     * this session. It cost no extra request, so it is the freshest quota a
     * client can be shown.
     */
    #recordObservedProviderUsage(usage: ProviderUsage): void {
        this.#append("provider_quota_observed", {
            providerId: usage.providerId,
            quota: providerUsageToClaudeQuota(usage, this.#now()),
        });
    }

    #appendDurableEvent(event: SessionEvent): void {
        if (!this.isSubagent() && this.#request.trackUnread === true) {
            this.#unread = sessionUnreadStateAfterEvent(this.#unread, event);
        }
        const previousSessionTokenCount = this.#sessionTokenCount;
        this.#sessionTokenCount =
            sessionTokenCountAfterEvent(this.#sessionTokenCount, event) ??
            previousSessionTokenCount;
        try {
            this.events.append(event);
        } catch (error) {
            this.#sessionTokenCount = previousSessionTokenCount;
            throw error;
        }
        if (affectsSessionUsage(event)) {
            this.#usageSummaryRevision += 1;
            if (this.#persistedUsageBase !== undefined) this.#usageEventsAfterBase.push(event);
            this.#ownedUsageEventRevision = this.events.usageRevision();
        }
        if (!isTransientInferenceSessionEvent(event)) this.#saveSession();
        this.#recordRunFacts(event);
        this.#recordPermissionReview(event);
        this.#recordProviderToolCall(event);
        this.#reportContextSize(previousSessionTokenCount);
        this.#reportActivity(event);
    }

    /**
     * Publishes current context or cumulative usage when either changes.
     *
     * Rig already recomputes both on every event, so reporting them costs
     * nothing and saves every client a polling loop.
     */
    #reportContextSize(previous: SessionTokenCount): void {
        if (this.#reportingActivity) return;
        if (
            this.#sessionTokenCount.lastContextTokens === previous.lastContextTokens &&
            this.#sessionTokenCount.totalTokens === previous.totalTokens
        ) {
            return;
        }
        this.#reportingActivity = true;
        try {
            this.#append("session_context_changed", {
                sessionTokenCount: { ...this.#sessionTokenCount },
            });
        } finally {
            this.#reportingActivity = false;
        }
    }

    /**
     * Publishes the session's current activity when the event just appended
     * changed it.
     *
     * The activity event is derived from other events, so it is appended after
     * the event that caused it and never feeds back into the derivation.
     */
    #recordRunFacts(event: SessionEvent): void {
        if (event.type === "message_submitted" && event.data.delivery === "run") {
            if (!this.#runFacts.has(event.data.runId)) {
                this.#runFacts.set(event.data.runId, { startedAt: event.createdAt });
            }
            return;
        }
        if (event.type === "run_started") {
            const known = this.#runFacts.get(event.data.runId);
            this.#runFacts.set(event.data.runId, {
                ...(known ?? { startedAt: event.createdAt }),
                ...(event.data.kind === undefined ? {} : { kind: event.data.kind }),
            });
            this.#forgetUnreachableRunFacts();
            return;
        }
        if (event.type === "agent_event" && event.data.event.type === "inference_iteration_start") {
            const facts = this.#runFacts.get(event.data.runId) ?? {
                startedAt: event.createdAt,
            };
            // A run reaches the model once per tool-call iteration, and all of
            // that is one thing the user asked for. The group already open keeps
            // going; only steering, an abort, or the end of the run closes it.
            if ((facts.groups ?? []).some((group) => group.endedAt === undefined)) {
                this.#runFacts.set(event.data.runId, facts);
                return;
            }
            this.#runFacts.set(event.data.runId, {
                ...facts,
                groups: [
                    ...(facts.groups ?? []),
                    { id: event.data.event.messageId, startedAt: event.createdAt },
                ],
            });
            return;
        }
        if (event.type === "steering_applied") {
            // Which group a steering message heads cannot be read from the
            // clock, so the group it closed is recorded against it.
            const closedGroupId = this.#openRunGroupId(event.data.runId);
            this.#closeRunGroup(event.data.runId, event.createdAt, "steering", "success");
            this.#rememberBoundary(event.data.runId, closedGroupId, event.data.messageIds);
            return;
        }
        if (
            event.type === "agent_event" &&
            event.data.event.type === "context_compaction_started"
        ) {
            // Compaction is a boundary like steering: what came before it is
            // finished work, and what follows it is a new stretch. The
            // compaction itself is durable history as a message, so only the
            // boundary is recorded here.
            const closedGroupId = this.#openRunGroupId(event.data.runId);
            this.#closeRunGroup(event.data.runId, event.createdAt, "compaction", "success");
            this.#rememberBoundary(event.data.runId, closedGroupId, [
                event.data.event.compactionId,
            ]);
            return;
        }
        if (event.type === "agent_message" && event.data.message.role === "error") {
            const groupId = this.#openRunGroupId(event.data.runId);
            const facts = this.#runFacts.get(event.data.runId);
            if (groupId !== undefined && facts !== undefined) {
                this.#runFacts.set(event.data.runId, {
                    ...facts,
                    messageGroupIds: {
                        ...facts.messageGroupIds,
                        [event.data.message.id]: groupId,
                    },
                });
            }
            return;
        }
        if (event.type === "run_finished") {
            this.#closeRunGroup(
                event.data.runId,
                event.createdAt,
                event.data.stopReason === "error"
                    ? "error"
                    : event.data.stopReason === "aborted"
                      ? "abort"
                      : "completed",
                event.data.stopReason === "error"
                    ? "error"
                    : event.data.stopReason === "aborted"
                      ? "stopped"
                      : "success",
                event.data.errorMessage,
            );
            const started = this.#runFacts.get(event.data.runId);
            this.#runFacts.set(event.data.runId, {
                ...(started ?? { startedAt: event.createdAt }),
                endedAt: event.createdAt,
                outcome:
                    event.data.stopReason === "error"
                        ? "error"
                        : event.data.stopReason === "aborted"
                          ? "stopped"
                          : "success",
                ...(event.data.errorMessage === undefined
                    ? {}
                    : { errorMessage: event.data.errorMessage }),
            });
            return;
        }
        if (event.type === "run_error") {
            this.#closeRunGroup(
                event.data.runId,
                event.createdAt,
                "error",
                "error",
                event.data.errorMessage,
            );
            const started = this.#runFacts.get(event.data.runId);
            this.#runFacts.set(event.data.runId, {
                ...(started ?? { startedAt: event.createdAt }),
                endedAt: event.createdAt,
                errorMessage: event.data.errorMessage,
                outcome: "error",
            });
        }
    }

    /** The group open for a run, which is what a retry or compaction sits in. */
    #openRunGroupId(runId: string): string | undefined {
        return this.#runFacts.get(runId)?.groups?.findLast((group) => group.endedAt === undefined)
            ?.id;
    }

    /** Ties the messages that made a boundary to the group they closed. */
    #rememberBoundary(
        runId: string,
        closedGroupId: string | undefined,
        messageIds: readonly string[],
    ): void {
        const facts = this.#runFacts.get(runId);
        if (closedGroupId === undefined || facts === undefined) return;
        this.#runFacts.set(runId, {
            ...facts,
            boundaryGroupIds: {
                ...facts.boundaryGroupIds,
                ...Object.fromEntries(messageIds.map((messageId) => [messageId, closedGroupId])),
            },
        });
    }

    #closeRunGroup(
        runId: string,
        endedAt: number,
        reason: "completed" | "steering" | "compaction" | "abort" | "error",
        outcome: "success" | "error" | "stopped",
        errorMessage?: string,
    ): void {
        const facts = this.#runFacts.get(runId);
        const openIndex =
            facts?.groups?.findLastIndex((group) => group.endedAt === undefined) ?? -1;
        if (facts === undefined || openIndex < 0) return;
        this.#runFacts.set(runId, {
            ...facts,
            groups: (facts.groups ?? []).map((group, index) =>
                index === openIndex
                    ? {
                          ...group,
                          endedAt,
                          outcome,
                          reason,
                          ...(errorMessage === undefined ? {} : { errorMessage }),
                      }
                    : group,
            ),
        });
    }

    #recordPermissionReview(event: SessionEvent): void {
        if (event.type === "session_reset") {
            this.#permissionReviews.clear();
            return;
        }
        if (event.type === "session_rewound") {
            this.#retainPermissionReviewsForMessages(event.data.snapshot.messages);
            return;
        }
        if (event.type !== "agent_event") return;
        if (event.data.event.type === "temporary_full_access_started") {
            const review = event.data.event;
            this.#permissionReviews.set(review.toolCallId, {
                action: review.action,
                decision: "allow",
                fullAccessGranted: true,
                reason: review.reason,
                risk: review.risk,
                toolCallId: review.toolCallId,
                userAuthorization: review.userAuthorization,
            });
            return;
        }
        if (event.data.event.type !== "permission_review") return;
        const review = event.data.event;
        this.#permissionReviews.set(review.toolCallId, {
            action: review.action,
            decision: review.decision,
            reason: review.reason,
            risk: review.risk,
            toolCallId: review.toolCallId,
            userAuthorization: review.userAuthorization,
        });
    }

    /**
     * Keeps a durable record of a call the provider ran itself.
     *
     * A call is written down the moment it starts, not when it completes, because a turn that
     * ends first is exactly the case worth keeping: the search already reached the provider's
     * backend and cannot be recalled, so silence would be the one wrong answer. Its completion
     * later overwrites the record with the provider's own final arguments.
     */
    #recordProviderToolCall(event: SessionEvent): void {
        if (event.type === "session_reset") {
            this.#openProviderToolCalls.clear();
            return;
        }
        if (event.type !== "agent_event") return;
        const inner = event.data.event;
        if (
            inner.type !== "server_toolcall_start" &&
            inner.type !== "server_toolcall_delta" &&
            inner.type !== "server_toolcall_end"
        ) {
            return;
        }
        if (inner.callId.length === 0) return;
        if (inner.type === "server_toolcall_end") {
            this.#openProviderToolCalls.delete(inner.callId);
            return;
        }
        const open = this.#openProviderToolCalls.get(inner.callId);
        if (inner.type === "server_toolcall_delta") {
            // The streamed arguments are the only subject an interrupted call will ever have.
            if (open === undefined) return;
            open.arguments = boundedProviderToolCallArguments(open.arguments + inner.delta);
            return;
        }
        const runId = event.data.runId;
        if (typeof runId !== "string" || runId.length === 0) return;
        this.#openProviderToolCalls.set(inner.callId, {
            arguments: "",
            createdAt: event.createdAt,
            messageId: inner.messageId,
            name: inner.name,
            runId,
        });
    }

    /**
     * Closes every provider-run call the ended run left open.
     *
     * The provider never sent a closing event because Rig stopped reading before it could. That
     * silence is the one thing the transcript must not repeat: the search already reached the
     * provider's backend, out of Rig's reach, so the closing event is written here instead —
     * durable, like any other, and marked for what it is.
     */
    #closeOpenProviderToolCalls(runId: string): void {
        for (const [callId, open] of [...this.#openProviderToolCalls]) {
            if (open.runId !== runId) continue;
            this.#openProviderToolCalls.delete(callId);
            this.#append("agent_event", {
                event: {
                    arguments: open.arguments,
                    callId,
                    incomplete: true,
                    messageId: open.messageId,
                    name: open.name,
                    type: "server_toolcall_end",
                },
                runId,
            });
        }
    }

    #retainPermissionReviewsForMessages(messages: readonly Message[]): void {
        const retainedToolCallIds = new Set(
            messages.flatMap((message) =>
                message.blocks.flatMap((block) => (block.type === "tool_call" ? [block.id] : [])),
            ),
        );
        for (const toolCallId of this.#permissionReviews.keys()) {
            if (!retainedToolCallIds.has(toolCallId)) this.#permissionReviews.delete(toolCallId);
        }
    }

    /**
     * Drops facts for runs no transcript window can still show.
     *
     * Without this the map is the one structure that grows for the lifetime of
     * a session, which is exactly the unbounded growth the window exists to
     * avoid. A margin above the window keeps a resuming client covered.
     */
    #forgetUnreachableRunFacts(): void {
        const retained = SESSION_STREAM_TURN_LIMIT * 4;
        if (this.#runFacts.size <= retained) return;
        const live = new Set(this.#messages.map((entry) => entry.runId));
        for (const runId of [...this.#runFacts.keys()].slice(0, this.#runFacts.size - retained)) {
            if (!live.has(runId)) this.#runFacts.delete(runId);
        }
    }

    #reportActivity(event: SessionEvent): void {
        if (this.#reportingActivity || event.type === "session_activity_changed") return;
        const activity = sessionActivityAfterEvent(this.#activity, event);
        if (activity === this.#activity) return;
        this.#activity = activity;
        this.#reportingActivity = true;
        try {
            this.#append("session_activity_changed", { activity });
        } finally {
            this.#reportingActivity = false;
        }
    }

    #recordWorkflowUpdate(update: WorkflowRunUpdate): void {
        this.#append("workflow_changed", { update });
        this.#restartMetadataSettlement();
    }

    #secretAttachmentData(): {
        projectSecretIds: readonly string[];
        secretIds: readonly string[];
        sessionSecretIds: readonly string[];
    } {
        return {
            projectSecretIds: this.#secrets.projectIds(),
            secretIds: this.#secrets.ids(),
            sessionSecretIds: this.#secrets.sessionIds(),
        };
    }

    #appendAgentEvent(runId: string, event: AgentLoopEvent): void {
        if (this.#workspaceArchived) return;
        if (this.#activeRun?.runId !== runId) {
            return;
        }

        if (event.type === "steering_applied") {
            let drainedContext: readonly PersistedPendingContextMessage[] = [];
            const persist = () => {
                const reservedContext = this.#pendingContextSteering.get(runId);
                const contextMessageIds = event.messageIds.filter(
                    (messageId) => reservedContext?.has(messageId) === true,
                );

                const visibleMessageIds: string[] = [];
                for (const messageId of event.messageIds) {
                    const pending = this.#pendingSteeringMessages.get(messageId);
                    if (pending === undefined || pending.runId !== runId) continue;
                    this.#storeMessage(this.#nextMessagePosition(), pending.message, false, runId);
                    this.#pendingSteeringMessages.delete(messageId);
                    visibleMessageIds.push(messageId);
                }
                if (visibleMessageIds.length > 0) {
                    const continuation = this.#pendingSteeringContinuations.get(runId);
                    if (continuation === undefined) {
                        this.#append("steering_applied", { messageIds: visibleMessageIds, runId });
                    } else if (!continuation.cancelled) {
                        for (const messageId of visibleMessageIds) {
                            this.#rememberSteeringContinuationMessage(continuation, messageId);
                        }
                    }
                }
                drainedContext = this.#persistPendingContextDrain(contextMessageIds);
            };
            if (this.#persistence?.transaction === undefined) persist();
            else this.#persistence.transaction(persist);
            this.#applyPendingContextDrain(drainedContext);
            const reservedContext = this.#pendingContextSteering.get(runId);
            for (const pending of drainedContext) reservedContext?.delete(pending.message.id);
            if (reservedContext?.size === 0) this.#pendingContextSteering.delete(runId);
            return;
        }

        if (event.type === "inference_iteration_start") {
            this.#activePartial = {
                messageId: event.messageId,
                position: undefined,
                runId,
            };
        } else if (event.type === "context_compacted") {
            this.#totalTokens = event.estimatedTokensAfter;
        } else if ("partial" in event) {
            this.#storePartialMessage(runId, event.messageId, event.partial);
        }

        const previousUsage = this.#usage;
        const previousLifetimeTotalTokens = this.#lifetimeTotalTokens;
        if (event.type === "permission_review" && event.transcript !== undefined) {
            this.#setCommittedUsage(addUsage(this.#usage, event.transcript.usage));
        }
        // A call the provider finished carries its sources, and how many it returns is the
        // provider's choice rather than Rig's. The interrupted case was already bounded; this is
        // the ordinary one, which is every completed search and therefore the one that decides
        // whether an unusual response can grow durable state without limit.
        const durable: AgentLoopEvent =
            event.type === "server_toolcall_end"
                ? { ...event, arguments: boundedProviderToolCallArguments(event.arguments) }
                : event;
        try {
            this.#append("agent_event", { event: durable, runId });
        } catch (error) {
            this.#usage = previousUsage;
            this.#lifetimeTotalTokens = previousLifetimeTotalTokens;
            throw error;
        }
        if (event.type === "context_compacted" && this.isSubagent()) {
            this.#agentManager?.recordChanged(this);
        }
    }

    #appendCompactionAgentEvent(runId: string, event: AgentLoopEvent): void {
        if (this.#workspaceArchived) return;
        if (!this.#compactionActive) return;
        if (event.type === "context_compacted") this.#totalTokens = event.estimatedTokensAfter;
        this.#append("agent_event", { event, runId });
    }

    #appendAgentMessage(runId: string, message: Message): void {
        if (this.#workspaceArchived) return;
        if (
            this.#activeRun?.runId !== runId &&
            !(
                this.#compactionActive &&
                this.#compactionRunId === runId &&
                (message.role === "compaction" || message.role === "error")
            )
        ) {
            return;
        }
        if (this.#persistence?.transaction !== undefined) {
            this.#persistence.transaction(() => this.#commitAgentMessage(runId, message));
            return;
        }
        this.#commitAgentMessage(runId, message);
    }

    #commitAgentMessage(runId: string, message: Message): void {
        const existingMessage = this.#messages.find(
            (candidate) => !candidate.isPartial && candidate.message.id === message.id,
        );
        const previousUsage =
            existingMessage?.message.role === "agent" ||
            existingMessage?.message.role === "compaction"
                ? existingMessage.message.usage
                : undefined;
        const incomingUsage =
            message.role === "agent" || message.role === "compaction" ? message.usage : undefined;
        const eventMessage =
            previousUsage !== undefined && incomingUsage !== undefined
                ? withoutUsage(message)
                : message;
        if (
            message.role === "compaction" &&
            message.usage === undefined &&
            existingMessage?.message.role === "compaction" &&
            existingMessage.message.usage !== undefined
        ) {
            message = { ...message, usage: existingMessage.message.usage };
        }
        const existingPosition = existingMessage?.position;
        const partialPosition =
            message.role === "agent" && this.#activePartial?.runId === runId
                ? this.#activePartial.position
                : undefined;
        this.#storeMessage(
            existingPosition ?? partialPosition ?? this.#nextMessagePosition(),
            message,
            false,
            runId,
        );
        if (message.role === "compaction") {
            this.#contextMessages = this.#contextMessages?.map((contextMessage) =>
                contextMessage.id === message.id ? message : contextMessage,
            );
            this.#totalTokens = message.statistics.after.tokens;
        }
        if (message.role === "agent") {
            const resultIds = new Set(
                message.blocks.flatMap((block) =>
                    block.type === "tool_result" ? [block.toolCallId] : [],
                ),
            );
            for (const call of this.#externalToolCalls.values()) {
                if (call.runId !== runId || !resultIds.has(call.toolCallId)) continue;
                call.consumed = true;
                this.#persistence?.upsertExternalToolCall?.(call);
            }
            for (const call of this.#durableUserInputs.values()) {
                if (call.runId !== runId || !resultIds.has(call.toolCallId)) continue;
                const result = message.blocks.find(
                    (block): block is ToolResultBlock =>
                        block.type === "tool_result" && block.toolCallId === call.toolCallId,
                );
                if (result !== undefined) call.result = structuredClone(result);
                call.status = "completed";
                call.consumed = true;
                call.resolvedAt ??= this.#now();
                this.#persistence?.upsertDurableUserInput?.(call);
            }
            for (const current of this.#durableWaits.values()) {
                if (current.runId !== runId || !resultIds.has(current.toolCallId)) continue;
                const resultBlock = message.blocks.find(
                    (block): block is ToolResultBlock =>
                        block.type === "tool_result" && block.toolCallId === current.toolCallId,
                );
                const next: DurableWait = {
                    ...current,
                    consumed: true,
                    ...(resultBlock === undefined
                        ? {}
                        : { resultBlock: structuredClone(resultBlock) }),
                };
                this.#persistence?.upsertDurableWait?.(next);
                this.#durableWaits.set(next.id, next);
            }
            this.#pruneExternalToolCalls();
            this.#pruneDurableUserInputs();
            this.#pruneDurableWaits();
        }
        if (partialPosition !== undefined) {
            this.#activePartial = undefined;
        }
        if (
            message.role === "agent" &&
            message.usage !== undefined &&
            message.contextTokens !== undefined
        ) {
            this.#totalTokens = message.contextTokens;
        }
        const nextUsage =
            message.role === "agent" || message.role === "compaction" ? message.usage : undefined;
        if (!isDeepStrictEqual(previousUsage, nextUsage)) {
            this.#setCommittedUsage(replaceUsage(this.#usage, previousUsage, nextUsage));
        }
        this.#append("agent_message", { message: eventMessage, runId });
        if (this.isSubagent()) this.#agentManager?.recordChanged(this);
    }

    #sumCommittedUsage(): Usage {
        const messageUsage = this.#messages.reduce(
            (total, persisted) =>
                !persisted.isPartial &&
                (persisted.message.role === "agent" || persisted.message.role === "compaction") &&
                persisted.message.usage !== undefined
                    ? addUsage(total, persisted.message.usage)
                    : total,
            zeroUsage(),
        );
        return (this.events?.all() ?? []).reduce(
            (total, event) =>
                event.type === "agent_event" &&
                event.data.event.type === "permission_review" &&
                event.data.event.transcript !== undefined
                    ? addUsage(total, event.data.event.transcript.usage)
                    : total,
            messageUsage,
        );
    }

    #setCommittedUsage(usage: Usage): void {
        this.#lifetimeTotalTokens = Math.max(
            0,
            this.#lifetimeTotalTokens + usage.totalTokens - this.#usage.totalTokens,
        );
        this.#usage = usage;
    }

    #appendRunFinished(runId: string, result: AgentRunResult): SessionRunCompletion["status"] {
        if (this.#persistence?.transaction !== undefined) {
            return this.#persistence.transaction(() => this.#commitRunFinished(runId, result));
        }
        return this.#commitRunFinished(runId, result);
    }

    #commitRunFinished(runId: string, result: AgentRunResult): SessionRunCompletion["status"] {
        const stopReason: StopReason = result.stopReason;
        // Before anything else about how the run ended: a provider-run call cannot outlive the
        // response that started it, and the provider will not be sending its closing event now.
        this.#closeOpenProviderToolCalls(runId);
        if (result.stopReason === "error") {
            this.#appendDurableError(runId, result.errorMessage, this.#runtime, {
                providerError: result.providerError,
                providerId: result.providerId,
                requestedModelId: result.requestedModelId,
            });
        }
        const responseText = findLastAgentResponseText(
            this.#messages.filter((entry) => entry.runId === runId).map((entry) => entry.message),
        );
        const providerFailed = this.isSubagent() && stopReason === "error";
        const tokenExhausted =
            this.isSubagent() &&
            stopReason !== "aborted" &&
            stopReason !== "error" &&
            responseText === undefined;
        const subagentFailed = providerFailed || tokenExhausted;
        const attachmentContext = this.#runtime?.context.attachments;
        let attachmentCompletion:
            | {
                  attachmentMessageId: string;
                  attachments: NonNullable<AgentMessage["attachments"]>;
              }
            | undefined;
        if (subagentFailed || stopReason === "aborted" || stopReason === "error") {
            attachmentContext?.discard();
        } else if ((attachmentContext?.pending().length ?? 0) > 0) {
            const target = this.#messages.findLast(
                (entry) =>
                    entry.runId === runId &&
                    !entry.isPartial &&
                    entry.message.role === "agent" &&
                    entry.message.internal !== true,
            );
            if (target?.message.role === "agent") {
                const attachments = attachmentContext?.takePending() ?? [];
                const message: AgentMessage = {
                    ...target.message,
                    attachments: [...(target.message.attachments ?? []), ...attachments],
                };
                this.#storeMessage(target.position, message, false, runId);
                attachmentCompletion = {
                    attachmentMessageId: message.id,
                    attachments: message.attachments ?? [],
                };
            } else {
                attachmentContext?.discard();
            }
        }
        if (!this.#workspaceArchived) {
            this.#status = subagentFailed
                ? "error"
                : stopReason === "aborted"
                  ? this.#suspendOnAbort
                      ? "suspended"
                      : "aborted"
                  : "completed";
        }
        this.#finishElapsedInterval();
        this.#suspendOnAbort = false;
        this.#activePartial = undefined;
        if (this.#activeRun?.runId === runId) {
            this.#activeRun = undefined;
        }
        this.#discardPendingSteeringMessages(runId);
        if (subagentFailed) {
            this.#pauseActiveGoal();
            this.#append("run_error", {
                errorMessage: providerFailed
                    ? (result.errorMessage ?? "The model response failed.")
                    : SUBAGENT_TOKEN_EXHAUSTED_ERROR,
                modelLocked: this.#modelLocked(),
                ...(result.stopReason !== "error"
                    ? {}
                    : {
                          providerError: result.providerError,
                          providerId: result.providerId,
                          requestedModelId: result.requestedModelId,
                      }),
                runId,
            });
            this.#restartMetadataSettlement();
            this.#agentManager?.recordChanged(this);
            this.#trimRetainedMessages();
            return "error";
        }
        this.#append("run_finished", {
            agentRunId: result.runId,
            ...attachmentCompletion,
            ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
            ...(result.stopReason !== "error"
                ? {}
                : {
                      providerError: result.providerError,
                      providerId: result.providerId,
                      requestedModelId: result.requestedModelId,
                  }),
            modelLocked: this.#modelLocked(),
            runId,
            stopReason,
        });
        if (stopReason !== "aborted" && stopReason !== "error") {
            this.#agentManager?.recordSuccessfulProvider?.(this.#modelId, this.#providerId);
        }
        this.#restartMetadataSettlement();
        if (this.isSubagent()) this.#agentManager?.recordChanged(this);
        this.#trimRetainedMessages();
        return stopReason === "aborted"
            ? "aborted"
            : stopReason === "error"
              ? "error"
              : "completed";
    }

    #appendDurableError(
        runId: string,
        reason: string,
        runtime: CodingAssistantRuntime | undefined,
        diagnostics?: Pick<ErrorMessage, "providerError" | "providerId" | "requestedModelId">,
    ): void {
        const exists = this.#messages.some(
            (entry) =>
                entry.runId === runId &&
                entry.message.role === "error" &&
                entry.message.outcome === "failed" &&
                entry.message.blocks.some(
                    (block) => block.type === "text" && block.text === reason,
                ),
        );
        if (exists) return;
        const message: ErrorMessage = createErrorMessage(
            createId(),
            reason,
            "failed",
            undefined,
            undefined,
            diagnostics,
        );
        if (runtime === undefined) this.#contextMessages?.push(message);
        else runtime.agent.recordMessage(message);
        this.#appendAgentMessage(runId, message);
    }

    /** The slot and webapp surface handed to this session's tools, with this session as author. */
    #slotContext(): SlotContext {
        const stores = this.#slotStores;
        if (stores === undefined) {
            throw new Error("Slots are unavailable in this session.");
        }
        return {
            createEntry: (request) =>
                stores.entries.create({
                    ...request,
                    author: { type: "agent", sessionId: this.id },
                }),
            createWebapp: (request, sourceFileSystem) =>
                stores.webapps.create({ ...request, authorSessionId: this.id }, sourceFileSystem),
            listEntries: (filter) => stores.entries.list(filter),
            listWebapps: () => stores.webapps.list(),
            removeEntry: (id) => stores.entries.remove(id),
            revertWebapp: (name, request) => stores.webapps.revert(name, request),
            updateEntry: (id, request) => stores.entries.update(id, request),
            updateWebapp: (name, request, sourceFileSystem) =>
                stores.webapps.update(name, request, sourceFileSystem),
        };
    }

    #finishElapsedInterval(): void {
        if (this.#activeSince === undefined) return;
        this.#elapsedMs += Math.max(0, this.#now() - this.#activeSince);
        this.#activeSince = undefined;
    }

    #committedMessages(): Message[] {
        return this.#messages
            .filter((message) => !message.isPartial)
            .sort((left, right) => left.position - right.position)
            .map((message) => message.message);
    }

    #discardPendingSteeringMessages(runId: string): void {
        for (const [messageId, pending] of this.#pendingSteeringMessages) {
            if (pending.runId === runId) this.#pendingSteeringMessages.delete(messageId);
        }
    }

    #ensureKnownModel(modelId: string, providerId: string): Model {
        const model = this.#modelsForProvider(providerId).find(
            (candidate) => candidate.id === modelId,
        );
        if (model === undefined) {
            throw new Error(`Unknown model '${modelId}' for provider '${providerId}'.`);
        }
        return model;
    }

    #ensureRuntime(): CodingAssistantRuntime {
        if (this.#runtime !== undefined) {
            return this.#runtime;
        }
        const readiness = this.#currentWorkspaceRunReadiness();
        if (readiness.state !== "ready") {
            throw new Error(
                readiness.state === "waiting"
                    ? "The managed workspace is still initializing."
                    : readiness.message,
            );
        }

        const agentManager = this.#agentManager;
        const appendSystemPrompt = [
            this.#appendSystemPrompt,
            this.#presence === undefined
                ? undefined
                : modelPresenceInstruction(this.#presence.state(), false),
        ]
            .filter((value): value is string => value !== undefined && value.length > 0)
            .join("\n\n");
        const options: CreateCodingAssistantAgentOptions = {
            agentId: this.#agentId,
            attachmentScope: {
                projectId: this.#projectId,
                sessionId: this.id,
                ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
            },
            ...(agentManager === undefined
                ? {}
                : {
                      agentCommunication: agentManager.communicationContext(this.id),
                  }),
            ...(appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt }),
            cwd: this.#request.cwd,
            ...(this.#executor === undefined ? {} : { executor: this.#executor }),
            ...(agentManager === undefined
                ? {}
                : {
                      agentTreeUsage: {
                          read: () => agentManager.queryAgentTreeUsage(this.id),
                      },
                      chatHistory: {
                          read: (historyOptions) =>
                              agentManager.readChatHistory(this.id, historyOptions),
                      },
                  }),
            messages:
                this.#contextMessages ??
                this.#committedMessages().filter((message) => !isExcludedFromModelContext(message)),
            isSubagent: this.isSubagent(),
            modelId: this.#modelId,
            permissionMode: this.#permissionMode,
            // The starting mode above builds this runtime's context. This is the live one, asked
            // for rather than captured, because an executor built here outlives the context: a
            // switch to an incompatible model keeps the executor and replaces the context, and
            // every later mode change lands on the replacement.
            resolvePermissionMode: () => this.#permissionMode,
            providerId: this.#providerId,
            secrets: this.#secrets,
            scheduling: {
                now: () => this.#now(),
                scheduleMessage: (request) => this.scheduleMessage(request),
                wait: (request, signal) => this.waitDurably(request, signal),
            },
            userInput: {
                cancel: (askId) => this.cancelUserInput(askId),
                markExecuting: (requestId) => this.markUserInputExecuting(requestId),
                request: (request, requestOptions) =>
                    this.requestUserInput(request, requestOptions),
            },
            ...(this.#slotStores === undefined ? {} : { slots: this.#slotContext() }),
            sessionId: this.#agentMetadata.rootSessionId,
            startDate: toLocalDate(this.events.firstMessageCreatedAt() ?? this.#createdAt),
            ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
            ...(this.#durableSkillDefinitions.length === 0
                ? {}
                : { durableSkills: this.#durableSkillDefinitions }),
            tasks: {
                create: (request) => this.#taskSession().createTask(request),
                get: (taskId) => this.#taskSession().getTask(taskId),
                list: () => this.#taskSession().listTasks(),
                update: (taskId, request) => this.#taskSession().updateTask(taskId, request),
            },
        };
        if (this.#workflowsEnabled) {
            options.workflowsEnabled = true;
            options.workflows = {
                get: (runId) => this.getWorkflow(runId),
                launch: (request) => this.launchWorkflow(request),
                stop: (runId) => this.stopWorkflow(runId),
                wait: (runId, signal) => this.waitForWorkflow(runId, signal),
            };
        } else {
            options.workflowsEnabled = false;
        }
        if (!this.isSubagent()) {
            options.goals = {
                create: (request) => this.setGoal(request),
                get: () => this.goal(),
                update: (status) => this.changeGoalStatus({ status }, { stopActiveGoalRun: false }),
            };
        }
        if (this.#contextMessages !== undefined) {
            options.contextMessages = this.#contextMessages;
        }
        options.onAccountUsage = (usage) => this.#recordObservedProviderUsage(usage);
        if (this.#effort !== undefined) options.effort = this.#effort;
        if (this.#serviceTier !== undefined) options.serviceTier = this.#serviceTier;
        if (this.#instructions !== undefined) options.instructions = this.#instructions;
        if (this.#request.apiKey !== undefined) options.apiKey = this.#request.apiKey;
        if (this.#request.docker !== undefined) options.docker = this.#request.docker;
        if (agentManager !== undefined) {
            options.subagents = {
                availableModels: this.#modelCatalog.providers.flatMap((provider) =>
                    provider.models.map((model) => ({
                        defaultEffort: model.defaultThinkingLevel,
                        effortLevels: model.thinkingLevels,
                        id: model.id,
                        name: model.name,
                        providerId: provider.providerId,
                    })),
                ),
                canSpawn: this.#agentMetadata.depth < agentManager.maxDepth,
                depth: this.#agentMetadata.depth,
                disabledProviders: this.#modelCatalog.providers.flatMap((provider) =>
                    provider.disabledReason === undefined
                        ? []
                        : [{ id: provider.providerId, reason: provider.disabledReason }],
                ),
                encryptedMessages: false,
                followUp: (target, message, effort, encryptedMessage) =>
                    agentManager.followUp(this.id, target, message, effort, encryptedMessage),
                inspect: (target) => agentManager.inspect(this.id, target),
                interrupt: (target) => agentManager.interrupt(this.id, target),
                list: (pathPrefix) => agentManager.list(this.id, pathPrefix),
                maxActive:
                    (agentManager.maxActiveFor?.(this.#agentMetadata.rootSessionId) ??
                        agentManager.maxActive) + 1,
                maxDepth: agentManager.maxDepth,
                sendMessage: (target, message, encryptedMessage) =>
                    agentManager.sendMessage(this.id, target, message, encryptedMessage),
                setReadOnly: (target, readOnly) =>
                    agentManager.setSubagentReadOnly(this.id, target, readOnly),
                spawn: (request, signal) => agentManager.spawn(this.id, request, signal),
                wait: (timeoutMs, signal) => agentManager.wait(this.id, timeoutMs, signal),
            };
            if (!this.isSubagent() && this.#workspaceFeatures.workspaces) {
                const crossWorkspace = this.#workspaceFeatures.crossWorkspace;
                const workspaceResult = (workspace: {
                    id: string;
                    name: string;
                    path: string;
                    projectId: string;
                    status: "initializing" | "ready" | "failed" | "archiving" | "archived";
                }) => ({
                    archived: workspace.status === "archiving" || workspace.status === "archived",
                    id: workspace.id,
                    name: workspace.name,
                    path: workspace.path,
                    projectId: workspace.projectId,
                    status: workspace.status,
                    owned: true,
                });
                options.workspaces = {
                    addProject: (path) => agentManager.registerProject(this.id, path),
                    archive: async (workspaceId) =>
                        workspaceResult(await agentManager.archiveWorkspace(this.id, workspaceId)),
                    create: async (input) =>
                        workspaceResult(await agentManager.createWorkspace(this.id, input)),
                    crossWorkspace,
                    delegate: (request, signal) =>
                        agentManager.delegate(this.id, request, { crossWorkspace }, signal),
                    listProjects: () => agentManager.listProjects(this.id),
                    listSessions: (target) =>
                        agentManager.listSessions(this.id, target, { crossWorkspace }),
                    listWorkspaces: (projectId) =>
                        agentManager.listWorkspaces(this.id, projectId, { crossWorkspace }),
                    spawn: (request, signal) =>
                        agentManager.spawnInWorkspace(this.id, request, signal),
                    transfer: (targetWorkspaceId) =>
                        agentManager.scheduleSessionTransfer(this.id, targetWorkspaceId),
                };
            }
        }
        const runtime = this.#createRuntime(options);
        if (runtime.context.subagents !== undefined) {
            runtime.context.subagents.encryptedMessages =
                createEncryptedAgentTransportScope(runtime.executor, runtime.agent.model) !==
                undefined;
        }
        this.#externalToolInstallation = { installed: new Set(), shadowed: new Map() };
        this.#installExternalTools(runtime);
        let previousBackgroundCount = runtime.context.bash.activeSessionCount?.() ?? 0;
        runtime.context.bash.setActiveSessionCountListener?.((running) => {
            const runId = this.#activeRun?.runId ?? this.#lastSessionRunId ?? "background";
            this.#append("agent_event", {
                event: {
                    type: "background_processes_changed",
                    processes: runtime.context.bash.activeSessions?.() ?? [],
                    running,
                },
                runId,
            });
            if (running === previousBackgroundCount) return;
            previousBackgroundCount = running;
            this.#restartMetadataSettlement();
        });
        runtime.context.bash.setSessionExitListener?.((exit) => {
            // A replaced runtime keeps its own bash context alive long enough
            // to finish dying. Its leftovers are not this session's news.
            if (this.#runtime !== runtime) return;
            this.#notifyBackgroundProcessExit(exit);
        });
        const snapshot = runtime.agent.snapshot();
        this.#runtime = runtime;
        this.#agentId = snapshot.id;
        this.#appendSystemPrompt = snapshot.appendSystemPrompt;
        this.#providerId = runtime.executor.id;
        this.#modelId = snapshot.modelId;
        this.#effort = snapshot.effort;
        this.#serviceTier = snapshot.serviceTier;
        this.#instructions = snapshot.instructions;
        this.#systemPrompt = snapshot.systemPrompt;
        this.#models = this.#modelsForProvider(this.#providerId);
        this.#tools = snapshot.tools;
        this.#saveSession();
        return runtime;
    }

    #applyIntegrationConfiguration(queued: PersistedQueuedRun): void {
        let changed = false;
        if (Object.prototype.hasOwnProperty.call(queued, "systemPrompt")) {
            this.#systemPrompt = queued.systemPrompt ?? undefined;
            this.#runtime?.agent.setSystemPrompt(this.#systemPrompt);
            changed = true;
        }
        if (queued.externalTools !== undefined) {
            this.#externalToolDefinitions = queued.externalTools.map((definition) => ({
                ...definition,
            }));
            if (this.#runtime !== undefined) this.#installExternalTools(this.#runtime);
            changed = true;
        }
        if (queued.skills !== undefined) {
            this.#durableSkillDefinitions = queued.skills.map((definition) => ({ ...definition }));
            this.#runtime?.agent.setDurableSkills(this.#durableSkillDefinitions);
            if (this.#runtime !== undefined) this.#installExternalTools(this.#runtime);
            changed = true;
        }
        if (changed) this.#append("session_updated", { session: this.snapshot() });
        else this.#saveSession();
    }

    #installExternalTools(runtime: CodingAssistantRuntime): void {
        const externalTools = this.#externalToolDefinitions.map((definition) =>
            createExternalTool({
                definition,
                invoke: (request, signal) => this.#invokeExternalTool(definition, request, signal),
            }),
        );
        if (this.#durableSkillDefinitions.length > 0) {
            externalTools.push(
                createDurableSkillTool({
                    skills: this.#durableSkillDefinitions,
                    invoke: (skill, request, signal) =>
                        this.#invokeExternalTool(
                            {
                                description: `Read the complete SKILL.md for ${skill.name}.`,
                                label: "Read skill",
                                name: "read_skill",
                                parameters: {
                                    additionalProperties: false,
                                    properties: { name: { type: "string" } },
                                    required: ["name"],
                                    type: "object",
                                },
                            },
                            request,
                            signal,
                            skill,
                        ),
                }),
            );
        }
        const replacement = replaceExternalTools(
            runtime.agent.tools,
            externalTools,
            this.#externalToolInstallation,
        );
        runtime.agent.setTools(replacement.tools);
        this.#externalToolInstallation = replacement.installation;
        this.#tools = runtime.agent.tools.map((tool) => tool.name);
    }

    #taskSession(): InMemorySession {
        return this.#agentManager?.taskSession(this.id) ?? this;
    }

    #activeProcessCount(): number {
        const runtime = this.#runtime;
        const nativeProcesses = runtime?.processManager.activeCount() ?? 0;
        return this.#request.docker === undefined
            ? nativeProcesses
            : nativeProcesses + (runtime?.context.bash.activeSessionCount?.() ?? 0);
    }

    /**
     * Everything a shutdown would still have to take down.
     *
     * A command like `nohup server &` settles the moment its launcher exits,
     * so counting live commands alone reports nothing while the server it
     * started is very much still running under a process group we retained.
     */
    #reapableProcessCount(): number {
        const runtime = this.#runtime;
        const nativeProcesses = runtime?.processManager.reapableCount() ?? 0;
        return this.#request.docker === undefined
            ? nativeProcesses
            : nativeProcesses + (runtime?.context.bash.activeSessionCount?.() ?? 0);
    }

    /**
     * Stops the session's processes.
     *
     * Work the agent deliberately left running in the background is spared
     * unless this session is going away for good.
     */
    async #killRuntimeProcesses(
        options: { forceAfterMs?: number; includeBackground?: boolean } = {},
    ): Promise<void> {
        const runtime = this.#runtime;
        if (runtime === undefined) return;
        const forceAfterMs = options.forceAfterMs ?? BASH_SESSION_STOP_GRACE_MS;
        const includeBackground = options.includeBackground ?? false;
        // The bash context is asked first, and on purpose. Asking it claims the
        // outcome of every command it holds, so a command that dies during the
        // process manager's grace period cannot announce its own death to a
        // model we are in the middle of tearing down.
        const sessions = includeBackground
            ? (runtime.context.bash.killAllSessions?.() ?? Promise.resolve(0))
            : Promise.resolve(0);
        await Promise.all([
            runtime.processManager.killAll({
                forceAfterMs,
                includeDetached: includeBackground,
            }),
            sessions,
        ]);
    }

    #drainPendingContextMessages(
        messageIds?: readonly string[],
    ): readonly PersistedPendingContextMessage[] {
        const persist = () => this.#persistPendingContextDrain(messageIds);
        const selected =
            this.#persistence?.transaction === undefined
                ? persist()
                : this.#persistence.transaction(persist);
        this.#applyPendingContextDrain(selected);
        return selected;
    }

    #persistPendingContextDrain(
        messageIds?: readonly string[],
    ): readonly PersistedPendingContextMessage[] {
        const selectedIds =
            messageIds ??
            [...this.#pendingContextMessages.values()]
                .filter((pending) => pending.message.friendAuthor === undefined)
                .map((pending) => pending.message.id);
        return (
            this.#persistence?.drainPendingContextMessages?.(this.id, selectedIds) ??
            [...this.#pendingContextMessages.values()].filter((pending) =>
                selectedIds.includes(pending.message.id),
            )
        );
    }

    #applyPendingContextDrain(selected: readonly PersistedPendingContextMessage[]): void {
        if (selected.length === 0) return;
        this.#separateModelContextFromVisibleTranscript();
        const known = new Set(this.#contextMessages?.map((message) => message.id) ?? []);
        for (const pending of selected) {
            this.#pendingContextMessages.delete(pending.message.id);
            if (!known.has(pending.message.id)) {
                this.#contextMessages?.push(pending.message);
                known.add(pending.message.id);
            }
        }
    }

    async #drainQueue(): Promise<void> {
        for (;;) {
            const queued = this.#queue[0];
            if (queued === undefined) {
                this.#clearWorkspaceReadinessRetry();
                this.#workspaceQueueWaiting = false;
                if (this.#status === "queued" || this.#status === "running") {
                    this.#status = "idle";
                }
                this.#saveSession();
                return;
            }

            let readiness = this.#currentWorkspaceRunReadiness();
            if (readiness.state === "waiting") {
                const retry =
                    readiness.retryable === true
                        ? this.#scheduleWorkspaceReadinessRetry()
                        : "not_retryable";
                if (retry !== "exhausted") {
                    this.#workspaceQueueWaiting = true;
                    this.#status = "queued";
                    this.#saveSession();
                    return;
                }
                readiness = {
                    message:
                        "The queued run could not start because Rig could not confirm that its managed workspace directory was available after repeated attempts.",
                    state: "failed",
                };
            }
            this.#clearWorkspaceReadinessRetry();
            this.#workspaceQueueWaiting = false;
            if (readiness.state === "failed") {
                const failedEvent = this.#createEvent("run_error", {
                    errorMessage: readiness.message,
                    modelLocked: this.#modelLocked(),
                    runId: queued.runId,
                });
                const failedAtomically = this.#persistence?.failQueuedRun !== undefined;
                this.#persistence?.failQueuedRun?.({
                    event: failedEvent,
                    runId: queued.runId,
                });
                if (!failedAtomically) {
                    this.#persistence?.deleteQueuedRun(this.id, queued.runId);
                }
                this.#queue.shift();
                this.#status = "error";
                this.#commitEvent(failedEvent);
                await this.#closeDebugLog(queued);
                continue;
            }

            if (this.#workspaceReleaseMetadataBarrier) {
                // First-message naming is part of the workspace preparation barrier. Once an
                // initializing checkout becomes ready, finish any available metadata inference
                // before the real agent starts so naming cannot race work inside the folder.
                await this.#restartMetadataSettlement();
                if (this.#currentWorkspaceRunReadiness().state !== "ready") continue;
                if (this.#queue[0]?.runId !== queued.runId) continue;
                this.#workspaceReleaseMetadataBarrier = false;
            }

            const startedEvent = this.#createEvent("run_started", { runId: queued.runId });
            const activeSince = this.#activeSince ?? startedEvent.createdAt;
            const beginLegacy = () => {
                this.#persistence?.deleteQueuedRun(this.id, queued.runId);
                const regular = this.#persistPendingContextDrain();
                const friends = this.#persistence?.drainFriendContextMessages?.({
                    limits: { ...DEFAULT_FRIEND_CONTEXT_DRAIN_LIMITS },
                    runId: queued.runId,
                    sessionId: this.id,
                }) ?? {
                    enabled: false,
                    messages: [],
                    omittedCount: 0,
                    omittedMessageIds: [],
                };
                if (
                    !friends.enabled &&
                    (friends.messages.length > 0 ||
                        friends.omittedCount > 0 ||
                        friends.omittedMessageIds.length > 0)
                ) {
                    throw new Error("Disabled friend context drain returned selected messages.");
                }
                if (friends.omittedCount !== friends.omittedMessageIds.length) {
                    throw new Error("Friend context drain returned an inconsistent omitted count.");
                }
                return { friends, regular };
            };
            const drained =
                this.#persistence?.startQueuedRun?.({
                    activeSince,
                    event: startedEvent,
                    friendLimits: { ...DEFAULT_FRIEND_CONTEXT_DRAIN_LIMITS },
                    regularMessageIds: [...this.#pendingContextMessages.values()].flatMap(
                        (pending) =>
                            pending.message.friendAuthor === undefined ? [pending.message.id] : [],
                    ),
                    runId: queued.runId,
                }) ??
                (this.#persistence?.transaction === undefined
                    ? beginLegacy()
                    : this.#persistence.transaction(beginLegacy));
            // The durable toggle is read inside the drain transaction. Filtering here is the
            // final provider boundary, so a toggle made while a turn was active still prevents
            // friend-authored context from entering every later provider request.
            if (!drained.friends.enabled) this.#excludeFriendModelContext();
            this.#applyPendingContextDrain(drained.regular);
            this.#applyPendingContextDrain(drained.friends.messages);
            for (const messageId of drained.friends.omittedMessageIds) {
                this.#pendingContextMessages.delete(messageId);
            }
            const contextMessages = [
                ...drained.regular,
                ...drained.friends.messages,
                ...(drained.friends.omittedCount === 0
                    ? []
                    : [
                          friendContextOmission(
                              queued.runId,
                              drained.friends.omittedCount,
                              this.#now(),
                          ),
                      ]),
            ];
            if (drained.friends.omittedCount > 0) {
                this.#separateModelContextFromVisibleTranscript();
                this.#contextMessages?.push(contextMessages.at(-1)!.message);
            }
            this.#queue.shift();
            await this.#runQueued(queued, contextMessages, startedEvent, activeSince);
        }
    }

    #saveSession(): void {
        if (this.#workspaceArchived) this.#status = "archived";
        this.#persistence?.saveSession(this.state());
        this.#reportStatus();
    }

    /**
     * Announces a change to the durable lifecycle status.
     *
     * The status is assigned from many places and was only ever persisted, so a
     * client could not tell that a session had gone idle, been suspended, or
     * failed without asking for the whole session again. Reporting it from the
     * one point every change passes through keeps the stream self-describing
     * without threading an event through each assignment.
     */
    #reportStatus(): void {
        if (this.#reportingStatus || this.#status === this.#reportedStatus) return;
        this.#reportedStatus = this.#status;
        this.#reportingStatus = true;
        try {
            this.#append("session_status_changed", { status: this.#status });
        } finally {
            this.#reportingStatus = false;
        }
    }

    #separateModelContextFromVisibleTranscript(): void {
        if (this.#contextMessages !== undefined) return;

        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        const pendingContextIds = new Set(this.#pendingContextMessages.keys());
        this.#contextMessages = (
            runtimeSnapshot?.contextMessages ??
            runtimeSnapshot?.messages ??
            this.#committedMessages()
        ).filter(
            (message) => !isExcludedFromModelContext(message) && !pendingContextIds.has(message.id),
        );
    }

    #completionForRun(runId: string): SessionRunCompletion | undefined {
        const events = this.events.since(undefined) ?? [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (
                event === undefined ||
                (event.type !== "run_finished" && event.type !== "run_error") ||
                event.data.runId !== runId
            ) {
                continue;
            }
            if (event.type === "run_error") {
                return { errorMessage: event.data.errorMessage, status: "error" };
            }
            return completionFromRunFinished(event);
        }
        return undefined;
    }

    #modelLocked(): boolean {
        return this.#activeRun !== undefined || this.#queue.length > 0;
    }

    #selectedModel(): Model {
        const model = this.#models.find((candidate) => candidate.id === this.#modelId);
        if (model === undefined) {
            throw new Error(`Unknown model '${this.#modelId}' for provider '${this.#providerId}'.`);
        }
        return model;
    }

    #modelsForProvider(providerId: string): readonly Model[] {
        return (
            this.#modelCatalog.providers.find((provider) => provider.providerId === providerId)
                ?.models ?? []
        );
    }

    #providerSupportsServiceTier(providerId: string, serviceTier: ServiceTier): boolean {
        return (
            this.#modelCatalog.providers
                .find((provider) => provider.providerId === providerId)
                ?.serviceTiers?.includes(serviceTier) === true
        );
    }

    #clearMetadataSettlement(): void {
        this.#metadataRevision += 1;
        this.#metadataController?.abort();
        this.#metadataController = undefined;
        if (this.#titleStatus === "generating") {
            this.#titleStatus = this.#title === undefined ? "idle" : "ready";
            this.#titleError = undefined;
            this.#saveSession();
        }
    }

    #invalidateSessionMetadata(): void {
        this.#clearMetadataSettlement();
        this.#metadataInitialAttempted = false;
        this.#metadataRefinementAttempted = false;
        this.#metadataRunId = undefined;
        this.#metadataUpdatedAt = undefined;
        this.#recap = undefined;
        this.#title = this.#agentMetadata.description;
        this.#titleError = undefined;
        this.#titleStatus = this.#title === undefined ? "idle" : "ready";
    }

    #restartMetadataSettlement(): Promise<void> | undefined {
        if (this.#closing || this.#taskDrain?.closing === true) return undefined;
        if (this.isSubagent()) {
            this.#agentManager?.recordDescendantSettlementActivity(
                this.#agentMetadata.rootSessionId,
            );
            return undefined;
        }
        if (this.#metadataController !== undefined) {
            return this.#metadataSettlement;
        }
        const target = this.#metadataGenerationTarget();
        if (target === undefined) return undefined;
        if (target.kind === "initial") this.#metadataInitialAttempted = true;
        else this.#metadataRefinementAttempted = true;
        const revision = this.#metadataRevision;
        const settle = () => this.#settleMetadata(revision, target);
        const settlement = this.#taskDrain?.run(settle) ?? settle();
        const tracked = settlement.finally(() => {
            if (this.#metadataSettlement === tracked) this.#metadataSettlement = undefined;
        });
        this.#metadataSettlement = tracked;
        void tracked.catch(rethrowDatabaseFailure);
        return tracked;
    }

    #metadataGenerationTarget(): MetadataGenerationTarget | undefined {
        if (this.#metadataRunId !== undefined || this.#titleStatus === "error") return undefined;
        if (this.#currentWorkspaceRunReadiness().state !== "ready") return undefined;
        const submittedRunIds = new Set(
            (this.events.since(undefined) ?? []).flatMap((event) =>
                event.type === "message_submitted" ? [event.data.runId] : [],
            ),
        );
        const realUsers = this.#messages.filter(
            (entry) =>
                !entry.isPartial &&
                entry.runId !== undefined &&
                submittedRunIds.has(entry.runId) &&
                entry.message.role === "user" &&
                entry.message.provenance !== "agent",
        );
        const first = realUsers[0];
        if (first?.runId === undefined) return undefined;
        if (!this.#metadataInitialAttempted) {
            return { kind: "initial", runId: first.runId };
        }
        if (this.#metadataRefinementAttempted) return undefined;
        const second = realUsers[1];
        if (second?.runId !== undefined) {
            return { kind: "refined", runId: second.runId };
        }
        const firstResponse = findLastAgentResponseText(
            this.#messages
                .filter(
                    (entry) =>
                        !entry.isPartial &&
                        entry.runId === first.runId &&
                        entry.message.role === "agent",
                )
                .map((entry) => entry.message),
        );
        return firstResponse === undefined ? undefined : { kind: "refined", runId: first.runId };
    }

    async #settleMetadata(revision: number, target: MetadataGenerationTarget): Promise<void> {
        const transcript = createSessionMetadataTranscript(
            this.#messages,
            this.events.since(undefined) ?? [],
            target.kind === "initial" ? { initial: true } : {},
        );
        if (revision !== this.#metadataRevision || transcript === undefined || this.#closing) {
            return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => {
            if (this.#metadataController === controller) this.#clearMetadataSettlement();
        }, SESSION_METADATA_TIMEOUT_MS);
        timeout.unref();
        let completed = false;
        this.#metadataController = controller;
        this.#titleStatus = "generating";
        this.#titleError = undefined;
        this.#append("session_title_changed", { status: this.#titleStatus });
        try {
            const metadata = await generateSessionMetadata({
                ...(this.#title === undefined ? {} : { currentTitle: this.#title }),
                modelId: this.#modelId,
                now: this.#now,
                provider: this.#ensureRuntime().executor,
                sessionId: this.id,
                signal: controller.signal,
                startDate: toLocalDate(this.events.firstMessageCreatedAt() ?? this.#createdAt),
                transcript,
            });
            if (controller.signal.aborted || revision !== this.#metadataRevision || this.#closing) {
                return;
            }
            const metadataUpdatedAt = this.#now();
            this.#title = metadata.title;
            this.#recap = metadata.recap;
            this.#metadataRunId = target.kind === "refined" ? target.runId : undefined;
            this.#metadataUpdatedAt = metadataUpdatedAt;
            this.#titleStatus = "ready";
            this.#titleError = undefined;
            this.#append("session_title_changed", {
                ...(this.#metadataRunId === undefined
                    ? {}
                    : { metadataRunId: this.#metadataRunId }),
                metadataUpdatedAt,
                recap: metadata.recap,
                status: this.#titleStatus,
                title: metadata.title,
            });
            if (target.kind === "initial" && this.#workspaceId !== undefined) {
                try {
                    this.#onInitialTitle?.({
                        projectId: this.#projectId,
                        sessionId: this.id,
                        title: metadata.title,
                        workspaceId: this.#workspaceId,
                    });
                } catch (error) {
                    if (isDatabaseFailure(error)) throw error;
                    // Workspace title inheritance is optional enrichment and cannot fail the chat.
                }
            }
            completed = true;
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (controller.signal.aborted || revision !== this.#metadataRevision) return;
            this.#titleStatus = "error";
            this.#titleError = errorToMessage(error);
            this.#append("session_title_changed", {
                errorMessage: this.#titleError,
                status: this.#titleStatus,
            });
        } finally {
            clearTimeout(timeout);
            if (this.#metadataController === controller) this.#metadataController = undefined;
            if (completed) queueMicrotask(() => this.#restartMetadataSettlement());
        }
    }

    async #runQueued(
        queued: PersistedQueuedRun,
        pendingContext: readonly PersistedPendingContextMessage[] = [],
        startedEvent = this.#createEvent("run_started", { runId: queued.runId }),
        activeSince = this.#activeSince ?? startedEvent.createdAt,
    ): Promise<void> {
        let controller = new AbortController();
        const debugLog = this.#debugLogFor(queued);
        this.#activeRun = {
            controller,
            debug: queued.debug === true,
            kind: queued.kind,
            runId: queued.runId,
        };
        this.#lastSessionRunId = queued.runId;
        this.#restoredActiveRunId = undefined;
        this.#status = "running";
        this.#activeSince = activeSince;
        this.#commitEvent(startedEvent);
        if (this.isSubagent()) this.#agentManager?.recordChanged(this);

        let runtime: CodingAssistantRuntime | undefined;
        try {
            // The configuration applies before anything can await, so a run leaves the queue and
            // takes effect in one step. Nothing else can observe a started run still describing
            // itself with the configuration it is replacing.
            if (
                queued.effort !== undefined ||
                queued.modelId !== undefined ||
                queued.serviceTier !== undefined
            ) {
                // The message and the configuration it carried arrive together, so the run this
                // starts is the first one the new configuration applies to.
                this.#applyConfiguration(
                    {
                        ...(queued.effort === undefined ? {} : { effort: queued.effort }),
                        ...(queued.modelId === undefined ? {} : { modelId: queued.modelId }),
                        ...(queued.providerId === undefined
                            ? {}
                            : { providerId: queued.providerId }),
                        ...(queued.serviceTier === undefined
                            ? {}
                            : { serviceTier: queued.serviceTier }),
                    },
                    { excludeRunId: queued.runId },
                );
            }
            this.#applyIntegrationConfiguration(queued);
            await debugLog?.record("request", {
                agent: this.agentMetadata(),
                displayText: queued.displayText,
                modelId: this.#modelId,
                permissionMode: this.#permissionMode,
                providerId: this.#providerId,
                request: {
                    ...(queued.debugRequestContent === undefined
                        ? {}
                        : { content: queued.debugRequestContent }),
                    text: queued.text,
                },
                runId: queued.runId,
                sessionId: this.id,
            });
            await debugLog?.record("run-started", {
                runId: queued.runId,
                sessionId: this.id,
            });
            runtime = this.#ensureRuntime();
            await this.#ensureMcpTools(runtime, controller.signal, queued.interactive !== false);
            const runtimeSnapshot = runtime.agent.snapshot();
            const runtimeMessageIds = new Set(
                [
                    ...(runtimeSnapshot.contextMessages ?? runtimeSnapshot.messages),
                    ...runtimeSnapshot.queue.map((entry) => entry.message),
                ].map((message) => message.id),
            );
            for (const pending of pendingContext) {
                if (!runtimeMessageIds.has(pending.message.id)) {
                    runtime.agent.enqueueMessage(pending.message);
                }
            }
            runtime.agent.enqueueMessage(queued.userMessage);
            if (this.#contextMessages !== undefined) {
                this.#contextMessages = [...this.#contextMessages, queued.userMessage];
                this.#saveSession();
            }
            for (;;) {
                const result = await runtime.agent.run({
                    ...(debugLog === undefined ? {} : { debug: debugLog }),
                    signal: controller.signal,
                    onEvent: async (event) => {
                        this.#appendAgentEvent(queued.runId, event);
                        await debugLog?.record("agent-event", { event, runId: queued.runId });
                    },
                    onMessage: async (message) => {
                        this.#appendAgentMessage(queued.runId, message);
                        await debugLog?.record("agent-message", { message, runId: queued.runId });
                    },
                });
                if (this.#activeRun?.runId !== queued.runId) {
                    return;
                }
                await debugLog?.record("run-finished", {
                    agentRunId: result.runId,
                    runId: queued.runId,
                    stopReason: result.stopReason,
                });

                const continuation = this.#pendingSteeringContinuations.get(queued.runId);
                if (result.stopReason === "aborted" && continuation !== undefined) {
                    await continuation.ready;
                    if (
                        !continuation.cancelled &&
                        this.#pendingSteeringContinuations.get(queued.runId) === continuation &&
                        this.#activeRun?.runId === queued.runId
                    ) {
                        const persistContinuation = () => {
                            if (continuation.messageIds.length > 0) {
                                this.#append("steering_applied", {
                                    messageIds: [...continuation.messageIds],
                                    runId: queued.runId,
                                });
                            }
                            return this.#persistPendingContextDrain(continuation.contextMessageIds);
                        };
                        const drainedContext =
                            this.#persistence?.transaction === undefined
                                ? persistContinuation()
                                : this.#persistence.transaction(persistContinuation);
                        this.#applyPendingContextDrain(drainedContext);
                        this.#pendingSteeringContinuations.delete(queued.runId);
                        this.#pendingContextSteering.delete(queued.runId);
                        controller = new AbortController();
                        this.#activeRun = {
                            controller,
                            debug: queued.debug === true,
                            kind: queued.kind,
                            runId: queued.runId,
                        };
                        this.#activePartial = undefined;
                        continue;
                    }
                    this.#pendingSteeringContinuations.delete(queued.runId);
                }

                const completionStatus = this.#appendRunFinished(queued.runId, result);
                if (completionStatus === "completed" && result.stopReason !== "error") {
                    this.#continueGoalIfIdle();
                }
                break;
            }
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            runtime?.context.attachments?.discard();
            if (this.#activeRun?.runId !== queued.runId) {
                return;
            }
            const errorMessage = errorToMessage(error);
            this.#appendDurableError(queued.runId, errorMessage, runtime);
            if (!this.#workspaceArchived) {
                this.#status =
                    controller.signal.aborted && this.#suspendOnAbort ? "suspended" : "error";
            }
            this.#finishElapsedInterval();
            this.#suspendOnAbort = false;
            this.#activePartial = undefined;
            this.#discardPendingSteeringMessages(queued.runId);
            this.#pauseActiveGoal();
            if (this.#activeRun?.runId === queued.runId) {
                this.#activeRun = undefined;
            }
            await debugLog
                ?.record("run-error", { error, runId: queued.runId, sessionId: this.id })
                .catch(() => undefined);
            this.#append("run_error", {
                errorMessage,
                modelLocked: this.#modelLocked(),
                runId: queued.runId,
            });
            this.#restartMetadataSettlement();
            if (this.isSubagent()) this.#agentManager?.recordChanged(this);
        } finally {
            this.#pendingSteeringContinuations.delete(queued.runId);
            this.#pendingContextSteering.delete(queued.runId);
            if (this.#activeRun?.runId === queued.runId) {
                this.#activeRun = undefined;
            }
            if (this.#restoredActiveRunId === queued.runId && this.hasDurableToolRun()) {
                this.#contextMessages = undefined;
                // Same here: a discarded runtime leaves its commands
                // unreachable, so they go with it.
                void this.#killRuntimeProcesses({ includeBackground: true });
                void this.#runtime?.agent.close();
                this.#runtime = undefined;
            } else {
                this.#syncContextMessages();
                await this.#completePendingWorkspaceTransfer(queued.runId);
            }
            this.#saveSession();
            await this.#closeDebugLog(queued);
        }
    }

    #reservePendingContextForSteering(runId: string): readonly PersistedPendingContextMessage[] {
        const reserved = this.#pendingContextSteering.get(runId) ?? new Set<string>();
        this.#pendingContextSteering.set(runId, reserved);
        const selected = [...this.#pendingContextMessages.values()].filter(
            (pending) =>
                pending.message.friendAuthor === undefined && !reserved.has(pending.message.id),
        );
        for (const pending of selected) reserved.add(pending.message.id);
        return selected;
    }

    #rememberSteeringContinuationMessage(
        continuation: PendingSteeringContinuation,
        messageId: string,
    ): void {
        if (!continuation.messageIds.includes(messageId)) {
            continuation.messageIds.push(messageId);
        }
    }

    async #closeDebugLog(queued: PersistedQueuedRun): Promise<void> {
        const debugLog = this.#debugLogs.get(queued.runId);
        if (debugLog === undefined) return;
        await debugLog.flush().catch(() => undefined);
        if (this.#debugLogs.get(queued.runId) === debugLog) {
            this.#debugLogs.delete(queued.runId);
        }
    }

    #debugLogFor(queued: PersistedQueuedRun): DebugLog | undefined {
        if (queued.debug !== true || queued.debugDirectory === undefined) return undefined;
        const existing = this.#debugLogs.get(queued.runId);
        if (existing !== undefined) return existing;
        const created = new DebugLog({ directory: queued.debugDirectory, now: this.#now });
        this.#debugLogs.set(queued.runId, created);
        return created;
    }

    #syncContextMessages(): void {
        const snapshot = this.#runtime?.agent.snapshot();
        if (snapshot !== undefined) {
            this.#contextMessages = [...(snapshot.contextMessages ?? snapshot.messages)];
        }
    }

    #startDrainQueue(): void {
        if (this.#draining !== undefined || this.#resumingDurableToolRun) return;
        if (this.#restoredActiveRunId !== undefined && this.hasDurableToolRun()) {
            this.resumeDurableToolRun();
            return;
        }

        const drain = () => this.#drainQueue();
        const draining = this.#taskDrain?.run(drain) ?? drain();
        this.#draining = draining.finally(() => {
            this.#draining = undefined;
        });
        void this.#draining.then(() => {
            if (this.#queue.length > 0 && !this.#workspaceQueueWaiting) this.#startDrainQueue();
        }, rethrowDatabaseFailure);
    }

    /**
     * Continues the durable queue after the workspace's ordinary realtime lifecycle changed.
     *
     * The queue itself remains the source of truth. This notification only re-evaluates its
     * durable workspace gate, so duplicate workspace events are harmless.
     */
    workspaceReadinessChanged(): void {
        if (this.#queue.length === 0 || this.#closing) return;
        this.#clearWorkspaceReadinessRetry();
        if (this.#workspaceQueueWaiting) this.#workspaceReleaseMetadataBarrier = true;
        this.#workspaceQueueWaiting = false;
        this.#startDrainQueue();
    }

    #scheduleWorkspaceReadinessRetry(): "closing" | "exhausted" | "scheduled" {
        if (this.#workspaceReadinessRetryTimer !== undefined) return "scheduled";
        if (this.#closing) return "closing";
        if (this.#workspaceReadinessRetryAttempt >= WORKSPACE_READINESS_RETRY_DELAYS_MS.length) {
            return "exhausted";
        }
        const delay =
            WORKSPACE_READINESS_RETRY_DELAYS_MS[this.#workspaceReadinessRetryAttempt] ??
            WORKSPACE_READINESS_RETRY_DELAYS_MS.at(-1)!;
        this.#workspaceReadinessRetryAttempt += 1;
        const timer = setTimeout(() => {
            if (this.#workspaceReadinessRetryTimer !== timer) return;
            this.#workspaceReadinessRetryTimer = undefined;
            this.#workspaceQueueWaiting = false;
            this.#startDrainQueue();
        }, delay);
        timer.unref();
        this.#workspaceReadinessRetryTimer = timer;
        return "scheduled";
    }

    #clearWorkspaceReadinessRetry(): void {
        if (this.#workspaceReadinessRetryTimer !== undefined) {
            clearTimeout(this.#workspaceReadinessRetryTimer);
            this.#workspaceReadinessRetryTimer = undefined;
        }
        this.#workspaceReadinessRetryAttempt = 0;
    }

    #currentWorkspaceRunReadiness(): WorkspaceRunReadiness {
        if (this.#workspaceId === undefined) return { state: "ready" };
        return (
            this.#workspaceRunReadiness?.({
                cwd: this.#request.cwd,
                projectId: this.#projectId,
                workspaceId: this.#workspaceId,
            }) ?? { state: "ready" }
        );
    }

    #assertAcceptingWork(): void {
        if (this.#workspaceArchived) {
            throw new Error("This session was archived with its workspace.");
        }
        if (this.#closing || this.#taskDrain?.closing === true) {
            throw new Error("The local daemon is shutting down.");
        }
        if (this.#workspaceTransfer.status === "transferring") {
            throw new Error("This session is being transferred to another workspace.");
        }
    }

    #setWorkspaceTransferState(
        state: SessionWorkspaceTransferState,
        contextMessages?: readonly Message[],
    ): void {
        this.#persistence?.setWorkspaceTransferState?.({
            ...(contextMessages === undefined ? {} : { contextMessages }),
            sessionId: this.id,
            state,
        });
        this.#workspaceTransfer = state;
        if (contextMessages !== undefined) this.#contextMessages = [...contextMessages];
    }

    #workspaceTransferContextMessages(): readonly Message[] {
        const snapshot = this.#runtime?.agent.snapshot();
        return [
            ...(
                snapshot?.contextMessages ??
                snapshot?.messages ??
                this.#contextMessages ??
                this.#committedMessages()
            ).filter((message) => !isExcludedFromModelContext(message)),
            ...(snapshot?.queue.map((queued) => queued.message) ?? []),
        ];
    }

    async #teardownRuntimeForWorkspaceTransfer(): Promise<void> {
        const runtime = this.#runtime;
        await this.#killRuntimeProcesses({ includeBackground: true });
        const release = this.#mcpToolRelease;
        this.#mcpToolRelease = undefined;
        this.#mcpLoaded = false;
        this.#mcpServers = [];
        this.#mcpToolNames.clear();
        this.#tools = [];
        try {
            await release?.().catch(() => undefined);
            await runtime?.agent.close();
        } finally {
            if (this.#runtime === runtime) this.#runtime = undefined;
        }
    }

    async #completePendingWorkspaceTransfer(runId: string): Promise<void> {
        if (this.#workspaceTransfer.status !== "scheduled") return;
        const targetWorkspaceId = this.#workspaceTransfer.targetWorkspaceId;
        try {
            const manager = this.#agentManager;
            if (manager === undefined) {
                throw new Error("This session cannot be transferred between workspaces.");
            }
            await manager.completeScheduledSessionTransfer(this.id, targetWorkspaceId);
        } catch (error) {
            this.failWorkspaceTransfer(targetWorkspaceId, error, "not_touched", runId);
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #workspaceTransferSource(targetWorkspaceId: string): string {
        if (this.isSubagent()) {
            throw new Error("Subagent sessions cannot be transferred between workspaces.");
        }
        if (
            this.#workspaceTransfer.status === "scheduled" ||
            this.#workspaceTransfer.status === "transferring"
        ) {
            throw new Error("This session already has a workspace transfer in progress.");
        }
        const sourceWorkspaceId = this.#workspaceId;
        if (sourceWorkspaceId === undefined) {
            throw new Error("Only a session in a managed workspace can be transferred.");
        }
        if (sourceWorkspaceId === targetWorkspaceId) {
            throw new Error("Choose a different workspace for the session transfer.");
        }
        return sourceWorkspaceId;
    }

    #assertSupportedEffort(effort: string): void {
        this.#assertSupportedEffortForModel(effort, this.#selectedModel());
    }

    /**
     * Rejects a message whose configuration could never apply, so the caller learns immediately
     * rather than discovering it when the run finally starts.
     *
     * Effort is checked against the model this message will actually run on, which is the one it
     * carries, or the one an earlier queued message already selected, not necessarily the model
     * selected right now. This cannot be perfectly airtight, because a queued run can outlive a
     * restart that changes the catalog, so applying it later stays fallible too.
     */
    #assertConfigurationCanApply(request: SessionSubmitMessageRequest): void {
        const pendingModel = [...this.#queue]
            .reverse()
            .find((queued) => queued.modelId !== undefined);
        const modelId = request.modelId ?? pendingModel?.modelId;
        const providerId =
            request.modelId === undefined ? pendingModel?.providerId : request.providerId;
        const model =
            modelId === undefined
                ? this.#selectedModel()
                : this.#ensureKnownModel(
                      modelId,
                      this.#resolveProviderForModel(modelId, providerId),
                  );
        if (request.effort !== undefined) {
            this.#assertSupportedEffortForModel(request.effort, model);
        }
        if (
            request.serviceTier !== undefined &&
            request.serviceTier !== null &&
            !this.#providerSupportsServiceTier(
                modelId === undefined
                    ? this.#providerId
                    : this.#resolveProviderForModel(modelId, providerId),
                request.serviceTier,
            )
        ) {
            throw new Error("That provider does not support fast inference.");
        }
    }

    #assertSupportedEffortForModel(effort: string, model: Model): void {
        if (!model.thinkingLevels.includes(effort)) {
            throw new Error(`Model '${model.id}' does not support '${effort}' reasoning.`);
        }
    }

    /**
     * The committed transcript, optionally without one run's messages. A run that has been queued
     * but not yet sent has already stored its message, and that message belongs to whatever model
     * is about to receive it rather than to the history of the model being replaced.
     */
    #committedMessagesExcludingRun(runId: string | undefined): Message[] {
        return this.#messages
            .filter(
                (message) => !message.isPartial && (runId === undefined || message.runId !== runId),
            )
            .sort((left, right) => left.position - right.position)
            .map((message) => message.message);
    }

    #continueGoalIfIdle(): void {
        if (
            this.#closing ||
            this.#taskDrain?.closing === true ||
            this.isSubagent() ||
            this.#goal?.status !== "active" ||
            this.#restoredActiveRunId !== undefined ||
            this.#status === "running" ||
            this.#activeRun !== undefined ||
            this.#queue.length > 0
        ) {
            return;
        }

        const runId = createId();
        const text = createGoalContinuationPrompt(this.#goal);
        const userMessage: UserMessage = {
            blocks: [{ type: "text", text }],
            id: createId(),
            role: "user",
        };
        const queued: PersistedQueuedRun = {
            displayText: "Continuing active goal",
            kind: "goal",
            runId,
            text,
            userMessage,
        };
        this.#queue.push(queued);
        this.#persistence?.insertQueuedRun(this.id, queued);
        this.#status = "queued";
        this.#saveSession();
        this.#startDrainQueue();
    }

    #discardQueuedGoalRuns(): void {
        const discardedQueue = this.#queue.filter((queued) => queued.kind === "goal");
        if (discardedQueue.length === 0) return;

        this.#queue = this.#queue.filter((queued) => queued.kind !== "goal");
        for (const queued of discardedQueue) {
            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
        }
        void Promise.all(discardedQueue.map((queued) => this.#closeDebugLog(queued)));
        if (this.#activeRun === undefined && this.#queue.length === 0) this.#status = "idle";
        this.#saveSession();
    }

    #pauseActiveGoal(): void {
        if (this.#goal?.status !== "active") return;
        this.#goal = { ...this.#goal, status: "paused", updatedAt: this.#now() };
        this.#append("goal_changed", { goal: { ...this.#goal } });
    }

    #rebuildTranscriptIndex(): void {
        this.#transcriptRuns.clear();
        this.#transcriptRunOrder = [];
        this.#transcriptRunIndexes.clear();
        this.#transcriptPositionRun.clear();
        for (const entry of this.#messages) this.#indexTranscriptMessage(entry, true);
        this.#reindexTranscriptRuns();
    }

    #rebuildMessagePositionIndex(from = 0): void {
        if (from === 0) this.#messageIndexByPosition.clear();
        for (let index = from; index < this.#messages.length; index += 1) {
            const entry = this.#messages[index];
            if (entry !== undefined) this.#messageIndexByPosition.set(entry.position, index);
        }
    }

    #nextMessagePosition(): number {
        return (this.#messages.at(-1)?.position ?? -1) + 1;
    }

    #trimRetainedMessages(): void {
        if (this.#messages.length <= RETAINED_SESSION_MESSAGE_LIMIT) return;
        const retainedRuns = new Set<string>();
        let retainedMessages = 0;
        for (let index = this.#transcriptRunOrder.length - 1; index >= 0; index -= 1) {
            const runId = this.#transcriptRunOrder[index];
            if (runId === undefined) continue;
            retainedRuns.add(runId);
            retainedMessages += this.#transcriptRuns.get(runId)?.length ?? 0;
            if (retainedMessages >= RETAINED_SESSION_MESSAGE_LIMIT) break;
        }
        const removed = this.#messages.filter((entry) => {
            const runId = entry.runId ?? `orphan:${entry.message.id}`;
            return !retainedRuns.has(runId);
        });
        if (removed.length === 0) return;
        this.#messages = this.#messages.filter((entry) => {
            const runId = entry.runId ?? `orphan:${entry.message.id}`;
            return retainedRuns.has(runId);
        });
        for (const entry of removed) {
            if (entry.message.role === "user") {
                this.#submittedUserMessages.delete(entry.message.id);
            }
            for (const block of entry.message.blocks) {
                if (block.type === "tool_call") this.#permissionReviews.delete(block.id);
            }
        }
        this.#transcriptHasEarlier = true;
        this.#rebuildMessagePositionIndex();
        this.#rebuildTranscriptIndex();
    }

    #indexTranscriptMessage(entry: PersistedSessionMessage, rebuilding = false): void {
        let orderChanged = false;
        const previousRunId = this.#transcriptPositionRun.get(entry.position);
        if (previousRunId !== undefined) {
            const remaining = (this.#transcriptRuns.get(previousRunId) ?? []).filter(
                (known) => known.position !== entry.position,
            );
            if (remaining.length === 0) {
                this.#transcriptRuns.delete(previousRunId);
                const removedIndex = this.#transcriptRunIndexes.get(previousRunId);
                if (removedIndex !== undefined) {
                    this.#transcriptRunOrder.splice(removedIndex, 1);
                    this.#transcriptRunIndexes.delete(previousRunId);
                }
                orderChanged = true;
            } else {
                this.#transcriptRuns.set(previousRunId, remaining);
            }
            this.#transcriptPositionRun.delete(entry.position);
        }
        if (entry.isPartial || entry.message.internal === true) {
            if (!rebuilding && orderChanged) this.#reindexTranscriptRuns();
            return;
        }
        if (isTranscriptNoticeEntry(entry)) {
            if (!rebuilding && orderChanged) this.#reindexTranscriptRuns();
            return;
        }

        const runId = entry.runId ?? `orphan:${entry.message.id}`;
        const known = this.#transcriptRuns.get(runId);
        if (known === undefined) {
            orderChanged = true;
            this.#transcriptRuns.set(runId, [entry]);
            if (rebuilding) {
                this.#transcriptRunOrder.push(runId);
            } else {
                const lastRunId = this.#transcriptRunOrder.at(-1);
                const append =
                    lastRunId === undefined ||
                    (this.#transcriptRuns.get(lastRunId)?.[0]?.position ??
                        Number.MAX_SAFE_INTEGER) <= entry.position;
                const insertion = append
                    ? -1
                    : this.#transcriptRunOrder.findIndex(
                          (otherRunId) =>
                              (this.#transcriptRuns.get(otherRunId)?.[0]?.position ??
                                  Number.MAX_SAFE_INTEGER) > entry.position,
                      );
                if (insertion === -1) {
                    this.#transcriptRunOrder.push(runId);
                    this.#transcriptRunIndexes.set(runId, this.#transcriptRunOrder.length - 1);
                    orderChanged = false;
                } else {
                    this.#transcriptRunOrder.splice(insertion, 0, runId);
                    this.#reindexTranscriptRuns(insertion);
                    orderChanged = false;
                }
            }
        } else {
            known.push(entry);
            known.sort((left, right) => left.position - right.position);
        }
        this.#transcriptPositionRun.set(entry.position, runId);
        if (!rebuilding && orderChanged) this.#reindexTranscriptRuns();
    }

    #reindexTranscriptRuns(from = 0): void {
        if (from === 0) this.#transcriptRunIndexes.clear();
        for (let index = from; index < this.#transcriptRunOrder.length; index += 1) {
            const runId = this.#transcriptRunOrder[index];
            if (runId !== undefined) this.#transcriptRunIndexes.set(runId, index);
        }
    }

    #transcriptNoticeMessages(
        lowerPosition: number,
        upperPosition: number,
    ): { messages: readonly PersistedSessionMessage[]; truncated: boolean } {
        const matches = this.#messages.filter(
            (entry) =>
                isTranscriptNoticeEntry(entry) &&
                entry.position >= lowerPosition &&
                entry.position < upperPosition,
        );
        return {
            messages: matches.slice(-SESSION_TRANSCRIPT_NOTICE_LIMIT),
            truncated: matches.length > SESSION_TRANSCRIPT_NOTICE_LIMIT,
        };
    }

    #transcriptEntries(messages: readonly PersistedSessionMessage[]): TranscriptEntry[] {
        return messages.map((entry): TranscriptEntry => {
            const createdAt = this.events.messageCreatedAt(entry.message.id);
            const eventId = this.events.messageEventId(entry.message.id);
            const steeredAt = this.events.messageSteeredAt(entry.message.id);
            return {
                ...(createdAt === undefined ? {} : { createdAt }),
                ...(eventId === undefined ? {} : { eventId }),
                message: entry.message,
                ...(entry.runId === undefined ? {} : { runId: entry.runId }),
                ...(steeredAt === undefined ? {} : { steeredAt }),
            };
        });
    }

    #storeMessage(
        position: number,
        message: Message,
        isPartial: boolean,
        runId?: string,
        persist = true,
    ): void {
        const replacedIndex = this.#messageIndexByPosition.get(position);
        const replaced = replacedIndex === undefined ? undefined : this.#messages[replacedIndex];
        if (replaced?.message.role === "user") {
            this.#submittedUserMessages.delete(replaced.message.id);
        }
        const entry: PersistedSessionMessage = {
            isPartial,
            message,
            position,
            ...(runId === undefined ? {} : { runId }),
        };
        if (replacedIndex !== undefined) {
            this.#messages[replacedIndex] = entry;
        } else {
            const last = this.#messages.at(-1);
            if (last === undefined || last.position < position) {
                this.#messageIndexByPosition.set(position, this.#messages.length);
                this.#messages.push(entry);
            } else {
                let low = 0;
                let high = this.#messages.length;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    if ((this.#messages[middle]?.position ?? position) < position) low = middle + 1;
                    else high = middle;
                }
                this.#messages.splice(low, 0, entry);
                this.#rebuildMessagePositionIndex(low);
            }
        }
        this.#indexTranscriptMessage(entry);
        if (isPartial) {
            this.#partialPositions.add(position);
        } else {
            this.#partialPositions.delete(position);
        }
        if (message.role === "user") this.#submittedUserMessages.set(message.id, entry);
        if (persist) this.#persistence?.upsertMessage(this.id, entry);
    }

    #storePartialMessage(
        runId: string,
        messageId: string,
        partial: Parameters<typeof assistantMessageToAgentMessage>[0],
    ): void {
        const activePartial =
            this.#activePartial?.runId === runId && this.#activePartial.messageId === messageId
                ? this.#activePartial
                : {
                      messageId,
                      position: undefined,
                      runId,
                  };
        const position = activePartial.position ?? this.#nextMessagePosition();
        this.#activePartial = {
            ...activePartial,
            position,
        };
        const message = assistantMessageToAgentMessage(partial, activePartial.messageId, {
            providerId: this.#providerId,
            requestedModelId: this.#modelId,
        });
        this.#storeMessage(position, message, true, runId);
    }
}

function messagesBeforeToolCall(
    messages: readonly Message[],
    toolCallId: string | undefined,
): readonly Message[] {
    if (toolCallId === undefined) return messages;
    const currentToolCallIndex = messages.findLastIndex(
        (message) =>
            message.role === "agent" &&
            message.blocks.some((block) => block.type === "tool_call" && block.id === toolCallId),
    );
    return currentToolCallIndex === -1 ? messages : messages.slice(0, currentToolCallIndex);
}

function cloneWorkflowRun(run: WorkflowRun): WorkflowRun {
    return {
        ...run,
        logs: [...run.logs],
    };
}

function textOfContentBlocks(blocks: readonly ContentBlock[]): string {
    return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function friendContextOmission(
    runId: string,
    omittedCount: number,
    createdAt: number,
): PersistedPendingContextMessage {
    const message: UserMessage = {
        blocks: [
            {
                text: `${String(omittedCount)} older friend message${omittedCount === 1 ? " was" : "s were"} omitted from this turn because the bounded friend-context budget keeps the newest messages.`,
                type: "text",
            },
        ],
        contextOnly: true,
        id: `friend-context-omitted:${runId}`,
        internal: true,
        role: "user",
    };
    return {
        anchorRunId: runId,
        createdAt,
        message,
        position: -1,
    };
}

function isFriendModelContext(message: Message): boolean {
    return (
        (message.role === "user" && message.friendAuthor !== undefined) ||
        message.id.startsWith("friend-context-omitted:")
    );
}

function modelPresenceInstruction(state: PresenceState, changed: boolean): string {
    const presence = state.presence;
    const lines = [
        changed
            ? `The user's presence changed to ${presence.title} ${presence.emoji}.`
            : `The user's current presence is ${presence.title} ${presence.emoji}.`,
        presence.prompt.trim(),
    ];
    if (state.changesAt !== undefined) {
        lines.push(
            `This presence is scheduled to change at ${new Date(state.changesAt).toISOString()}.`,
        );
    }
    lines.push("Follow these presence instructions until Rig tells you they changed.");
    return lines.filter((line) => line.length > 0).join(" ");
}

function usageGroupKey(group: SessionUsageGroup): string {
    const { usage: _usage, ...identity } = group;
    return JSON.stringify(identity);
}

function withoutUsage(message: Message): Message {
    if (message.role !== "agent" && message.role !== "compaction") return message;
    const { usage: _usage, ...without } = message;
    return without;
}

function replaceUsage(total: Usage, previous: Usage | undefined, next: Usage | undefined): Usage {
    const withoutPrevious =
        previous === undefined
            ? total
            : {
                  cacheRead: Math.max(0, total.cacheRead - previous.cacheRead),
                  cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite),
                  cost: {
                      cacheRead: Math.max(0, total.cost.cacheRead - previous.cost.cacheRead),
                      cacheWrite: Math.max(0, total.cost.cacheWrite - previous.cost.cacheWrite),
                      input: Math.max(0, total.cost.input - previous.cost.input),
                      output: Math.max(0, total.cost.output - previous.cost.output),
                      total: Math.max(0, total.cost.total - previous.cost.total),
                  },
                  input: Math.max(0, total.input - previous.input),
                  output: Math.max(0, total.output - previous.output),
                  totalTokens: Math.max(0, total.totalTokens - previous.totalTokens),
                  ...(total.reasoning === undefined
                      ? {}
                      : {
                            reasoning: Math.max(0, total.reasoning - (previous.reasoning ?? 0)),
                        }),
              };
    return next === undefined ? withoutPrevious : addUsage(withoutPrevious, next);
}

function cloneExternalToolCall(call: ExternalToolCall): ExternalToolCall {
    return {
        ...call,
        definition: { ...call.definition, parameters: { ...call.definition.parameters } },
        ...(call.skill === undefined ? {} : { skill: { ...call.skill } }),
        ...(call.resolution === undefined
            ? {}
            : { resolution: cloneExternalResolution(call.resolution) }),
    };
}

function cloneExternalResolution(
    resolution: ExternalToolCallResolution,
): ExternalToolCallResolution {
    if (resolution.status === "failed") {
        return { status: "failed", error: { ...resolution.error } };
    }
    return {
        status: "completed",
        ...(resolution.content === undefined
            ? {}
            : { content: resolution.content.map((block) => ({ ...block })) }),
        ...(Object.prototype.hasOwnProperty.call(resolution, "output")
            ? { output: resolution.output }
            : {}),
    };
}

function durableWaitResultBlock(wait: DurableWait, result: WaitResult): ToolResultBlock {
    const elapsed = Number.isInteger(result.elapsedSeconds)
        ? String(result.elapsedSeconds)
        : result.elapsedSeconds.toFixed(3).replace(/0+$/u, "");
    return {
        display: result.interrupted
            ? `Wait interrupted after ${elapsed} seconds`
            : `Waited ${elapsed} seconds`,
        rendered: [
            {
                type: "text",
                text: result.interrupted
                    ? `The wait ended early because a new message arrived after ${elapsed} seconds.`
                    : `The wait completed after ${elapsed} seconds.`,
            },
        ],
        ...(wait.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: wait.providerToolCallId }),
        toolCallId: wait.toolCallId,
        toolName: wait.toolName,
        type: "tool_result",
    };
}

function limitInspectionText(text: string | undefined): string | undefined {
    if (text === undefined || text.length <= MAX_SUBAGENT_INSPECTION_TEXT_CHARS) return text;
    return `${text.slice(0, MAX_SUBAGENT_INSPECTION_TEXT_CHARS - 1)}…`;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}
