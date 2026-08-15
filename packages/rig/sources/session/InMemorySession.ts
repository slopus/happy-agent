import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import { areProviderModelsCompatible, type ProviderUsage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { withWorkerContext } from "../observability/index.js";

import { errorToMessage } from "../errorToMessage.js";
import { toLocalDate } from "./toLocalDate.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { agentFolderLabel } from "../agent/impl/agentFolderLabel.js";
import { isInternalMessage } from "../agent/impl/isInternalMessage.js";
import { isExcludedFromModelContext } from "../agent/impl/isExcludedFromModelContext.js";
import type {
    AgentContext,
    AgentCommunicationIdentity,
    AgentSnapshot,
    ContentBlock,
} from "../agent/index.js";
import { createDockerAgentContext, createNodeAgentContext } from "../agent/index.js";
import {
    findFirstUserRequestText,
    findLastAgentResponseText,
} from "../agent/index.js";
import type { Message, SystemMessage, UserMessage } from "../agent/types.js";
import type { BashSessionExit } from "../agent/context/BashContext.js";
import { BASH_SESSION_STOP_GRACE_MS } from "../agent/context/bashSessionLimits.js";
import type { BashContext } from "../agent/context/BashContext.js";
import type { FolderContext } from "../agent/context/FolderContext.js";
import type { SlotContext } from "../agent/context/SlotContext.js";
import { FolderError, type FolderRepository } from "../folders/FolderRepository.js";
import type { SessionScopeMove } from "../persistence/session/sessionMoveScope.js";
import type { SlotEntryStore } from "../slots/index.js";
import type { AppletStore } from "../applets/index.js";
import {
    createGoalContinuationPrompt,
    normalizeGoalObjective,
    type ChangeGoalStatusRequest,
    type CreateGoalRequest,
    type SessionGoal,
} from "../goals/index.js";
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
    Folder,
    ModelCatalog,
    ProtocolSession,
    RigProfile,
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
    SessionInterruption,
    SessionStatus,
    SessionScope,
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
    submitMessageDisplayTextSchema,
    submissionFingerprintSchema,
} from "../protocol/index.js";

const RETAINED_SESSION_MESSAGE_LIMIT = 512;
const sessionCommitStorage = new AsyncLocalStorage<object>();
const REMOVED_RUNTIME_REFRESH = Symbol("removed-runtime-refresh");

export interface SessionEventCommitCheckpoint {
    readonly activePartial: PartialMessageState | undefined;
    readonly activeRun: ActiveRun | undefined;
    readonly activeSince: number | undefined;
    readonly appendSystemPrompt: string | undefined;
    readonly activity: SessionActivity;
    readonly archived: boolean;
    readonly cachedUsageEventRevision: number;
    readonly cachedUsageSummaryRevision: number;
    readonly eventLog: SessionEventLogCheckpoint;
    readonly draft: string | undefined;
    readonly draftUpdatedAt: number | undefined;
    readonly elapsedMs: number;
    readonly durableUserInputs: ReadonlyMap<string, DurableUserInputCall>;
    readonly durableWaits: ReadonlyMap<string, DurableWait>;
    readonly goal: SessionGoal | undefined;
    readonly interruption: SessionInterruption | undefined;
    readonly lastMessageAt: number | undefined;
    readonly metadataFailures: number;
    readonly metadataInitialAttempted: boolean;
    readonly metadataNamed: boolean;
    readonly metadataNamingAttempted: boolean;
    readonly metadataRefinementAttempted: boolean;
    readonly metadataRunId: string | undefined;
    readonly metadataUpdatedAt: number | undefined;
    readonly ownedUsageEventRevision: number;
    readonly orderKey: string;
    readonly pendingSteeringContinuations: ReadonlyMap<string, PendingSteeringContinuation>;
    readonly pendingSteeringMessages: ReadonlyMap<string, PendingSteeringMessage>;
    readonly permissionReviews: ReadonlyMap<string, SessionPermissionReview>;
    readonly restoredActiveRunId: string | undefined;
    readonly reportedStatus: SessionStatus | undefined;
    readonly reportingActivity: boolean;
    readonly reportingStatus: boolean;
    readonly runFacts: ReadonlyMap<string, TranscriptRunFacts>;
    readonly sessionTokenCount: SessionTokenCount;
    readonly status: SessionStatus;
    readonly suspendedRunIds: ReadonlySet<string>;
    readonly suspendOnAbort: boolean;
    readonly recap: string | undefined;
    readonly title: string | undefined;
    readonly titleError: string | undefined;
    readonly titleStatus: SessionTitleStatus;
    readonly unread: SessionUnreadState | undefined;
    readonly usageEventsAfterBase: readonly SessionEvent[];
    readonly usageSummaryCache: SessionUsageSummary | undefined;
    readonly usageSummaryRevision: number;
    readonly workspaceArchived: boolean;
}
import {
    isTranscriptNoticeEntry,
    sessionTranscriptWindow,
    type TranscriptEntry,
    type TranscriptRunFacts,
} from "./sessionTranscriptWindow.js";
import { clampSessionDraftTimestamp } from "./impl/clampSessionDraftTimestamp.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { sessionUnreadStateAfterEvent } from "./impl/sessionUnreadStateAfterEvent.js";
import { gitIdentityEnvironment } from "../profiles/gitIdentityEnvironment.js";
import type { GitCommandAuthentication } from "../git/GitCredentialBroker.js";
import { PROJECT_GIT_SECRET_ID, projectGitCommandSecret } from "../git/projectGitCommandSecret.js";
import { IDLE_SESSION_ACTIVITY, sessionActivityAfterEvent } from "./sessionActivityAfterEvent.js";
import { aggregateSessionTokenCount } from "./usage/aggregateSessionTokenCount.js";
import { sessionTokenCountAfterEvent } from "./usage/sessionTokenCountAfterEvent.js";
import type { Model, ServiceTier, StopReason, Usage } from "../protocol/index.js";
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
import type { McpServerSummary } from "../mcp/index.js";
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
import {
    SessionEventLog,
    type SessionEventAppendHook,
    type SessionEventLogCheckpoint,
    type SessionEventNotificationScheduler,
} from "./SessionEventLog.js";
import { isSessionTransactionPostCommitError } from "./SessionTransactionContext.js";
import { isTransientInferenceSessionEvent } from "./impl/isTransientInferenceSessionEvent.js";
import { affectsSessionUsage } from "./impl/affectsSessionUsage.js";
import { providerUsageToClaudeQuota } from "../provider-services/providerUsageToClaudeQuota.js";
import { asyncLock, isAsyncLockReentryError, type AsyncLock } from "../concurrency/index.js";
import { getDatabaseScope } from "../persistence/databaseContext.js";
import { isSessionDatabaseTransaction } from "../persistence/database/SessionDatabase.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { summarizeDockerExecution } from "../execution/index.js";
import { NativeProcessManager } from "../processes/index.js";
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
import { createErrorMessage } from "../agent/impl/createErrorMessage.js";
import type { AgentMessage, ErrorMessage, ToolCallBlock, ToolResultBlock } from "../agent/types.js";
import type { RigAgentConfiguration } from "../agent/RigProtocolFeature.js";
import type {
    DurableWait,
    DurableWaitRequest,
    ScheduledMessage,
    ScheduleMessageRequest,
    WaitResult,
} from "../scheduling/index.js";

const MAX_RETAINED_DURABLE_USER_INPUTS = 1_000;
const MAX_RETAINED_DURABLE_WAITS = 1_000;
const MAX_RETAINED_SETTLED_SCHEDULED_MESSAGES = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const SESSION_METADATA_TIMEOUT_MS = 30_000;
/** How many failed attempts to name a chat are made before leaving it unnamed for good. */
const SESSION_METADATA_MAX_FAILURES = 3;
const WORKSPACE_READINESS_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const rigAgentConfigurationSchema = Type.Object(
    {
        effort: Type.Optional(Type.String({ maxLength: 32, minLength: 1 })),
        modelId: Type.String({ maxLength: 256, minLength: 1 }),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        permissionMode: Type.Union([
            Type.Literal("auto"),
            Type.Literal("full_access"),
            Type.Literal("read_only"),
            Type.Literal("workspace_write"),
        ]),
        providerId: Type.String({ maxLength: 256, minLength: 1 }),
        serviceTier: Type.Optional(Type.Literal("fast")),
    },
    { additionalProperties: false },
);

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
    /** Stable Rig identity whose credentials and usage this session consumes. */
    ownerInstanceId: string;
    profileId?: string;
    archived?: boolean;
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    appendSystemPrompt?: string;
    cwd: string;
    /** Durable credential identity; absent only in synthetic pre-binding restore fixtures. */
    credentialBindingId?: string;
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
    scope: SessionScope;
    unsortedSince?: number;
    secretIds?: readonly string[];
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
    durableUserInputs?: readonly DurableUserInputCall[];
    durableWaits?: readonly DurableWait[];
    scheduledMessages?: readonly ScheduledMessage[];
    systemPrompt?: string;
    workflows?: readonly PersistedWorkflowRun[];
    workflowsEnabled?: boolean;
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
    /**
     * Runs cleanup immediately outside a transaction, or after the enclosing transaction commits.
     * Runtime/process teardown must not happen while a session archive is still rollbackable.
     */
    afterTransactionCommit?(
        ctx: Context,
        callback: (ctx: Context) => void | Promise<void>,
    ): Promise<void>;
    clearMessages(ctx: Context, sessionId: string): Promise<void>;
    deleteMessagesFrom(ctx: Context, sessionId: string, position: number): Promise<void>;
    insertPendingContextMessage?(
        ctx: Context,
        sessionId: string,
        pending: PersistedPendingContextMessage,
    ): Promise<void>;
    drainPendingContextMessages?(
        ctx: Context,
        sessionId: string,
        messageIds?: readonly string[],
    ): Promise<readonly PersistedPendingContextMessage[]>;
    loadTranscriptPage?(
        ctx: Context,
        sessionId: string,
        turnLimit: number,
        before?: string,
    ): Promise<SessionTranscriptWindow | undefined>;
    loadTranscriptSince?(
        ctx: Context,
        sessionId: string,
        turnLimit: number,
        after: EventId,
    ): Promise<SessionTranscriptWindow | undefined>;
    pruneDurableUserInputs?(ctx: Context, sessionId: string, retain: number): Promise<void>;
    pruneDurableWaits?(ctx: Context, sessionId: string, retain: number): Promise<void>;
    pruneScheduledMessages?(
        ctx: Context,
        sessionId: string,
        retain: number,
    ): Promise<readonly string[]>;
    saveSession(ctx: Context, state: PersistedSessionState): Promise<void>;
    setWorkspaceTransferState?(
        ctx: Context,
        input: {
            contextMessages?: readonly Message[];
            sessionId: string;
            state: SessionWorkspaceTransferState;
        },
    ): Promise<void>;
    transaction?<T>(ctx: Context, body: (ctx: Context) => T | Promise<T>): Promise<T>;
    transferWorkspace?(
        ctx: Context,
        input: {
            contextMessages: readonly Message[];
            cwd: string;
            sessionId: string;
            state: SessionWorkspaceTransferState;
            projectId: string;
            workspaceId: string;
        },
    ): Promise<string>;
    upsertMessage(ctx: Context, sessionId: string, message: PersistedSessionMessage): Promise<void>;
    upsertDurableUserInput?(ctx: Context, call: DurableUserInputCall): Promise<void>;
    upsertDurableWait?(ctx: Context, wait: DurableWait): Promise<void>;
    upsertScheduledMessage?(ctx: Context, message: ScheduledMessage): Promise<void>;
    scheduledMessageChanged?(ctx: Context): Promise<void>;
}

export interface InMemorySessionOptions {
    createEventId: () => EventId;
    deferEventNotification?: SessionEventNotificationScheduler;
    emitCreatedEvent?: boolean;
    events?: readonly SessionEvent[];
    /** The folder tree this session's agent may read, rearrange, and file this chat into. */
    folders?: FolderRepository;
    initialContextMessages?: readonly Message[];
    id?: string;
    lastEventId?: EventId;
    now?: () => number;
    onInitialTitle?: (metadata: {
        projectId: string;
        sessionId: string;
        title: string;
        workspaceId: string;
    }) => void | Promise<void>;
    publishLiveEvent?: (ctx: Context, event: SessionEvent) => void;
    modelCatalog: ModelCatalog;
    /** Stable Rig identity whose credentials and usage this session consumes. */
    ownerInstanceId?: string;
    profileId?: string;
    resolveGitAuthentication?: (
        projectId: string,
        creator: { instanceId: string; profileId: string },
    ) => GitCommandAuthentication | undefined | Promise<GitCommandAuthentication | undefined>;
    resolveProfile?: (
        profileId: string,
    ) => RigProfile | undefined | Promise<RigProfile | undefined>;
    metadata?: SessionAgentMetadata;
    onAppendEvent?: SessionEventAppendHook;
    orderKey?: string;
    persistence?: InMemorySessionPersistence;
    presence?: { state(): PresenceState };
    request: CreateSessionRequest;
    projectSecretIds?: readonly string[];
    scope?: SessionScope;
    secretRegistry?: SecretRegistry;
    restore?: PersistedSessionState;
    /** The slot and applet stores this session's agent may drive through its common tools. */
    slotStores?: SessionSlotStores;
    taskDrain?: TaskDrain;
    workspaceFeatures?: WorkspaceFeatures;
    /** Durable server decision that gates every runtime and queued run for a managed workspace. */
    workspaceRunReadiness?: (target: {
        cwd: string;
        projectId: string;
        workspaceId: string;
    }) => WorkspaceRunReadiness | Promise<WorkspaceRunReadiness>;
}

export type WorkspaceRunReadiness =
    | { state: "ready" }
    | { retryable?: boolean; state: "waiting" }
    | { message: string; state: "failed" };

export interface SessionSlotStores {
    entries: SlotEntryStore;
    applets: AppletStore;
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
    kind: "goal" | "user";
    runId: string;
}

interface MetadataGenerationTarget {
    kind: "initial" | "refined";
    runId: string;
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
    reject: (error: Error) => void;
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

interface StagedProtocolProjectionOperation {
    readonly event: SessionEvent;
    readonly message?: PersistedSessionMessage;
}

interface StagedProtocolProjection {
    readonly operations: StagedProtocolProjectionOperation[];
    nextPosition: number;
    scheduled: boolean;
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

export class InMemorySession {
    #activeSince: number | undefined;
    readonly events: SessionEventLog;
    readonly id: string;

    get ownerInstanceId(): string {
        return this.#ownerInstanceId;
    }

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
    #agentMetadata: SessionAgentMetadata;
    #agentId: string;
    readonly #ownerInstanceId: string;
    readonly #profileId: string | undefined;
    readonly #resolveGitAuthentication:
        | ((
              projectId: string,
              creator: { instanceId: string; profileId: string },
          ) => GitCommandAuthentication | undefined | Promise<GitCommandAuthentication | undefined>)
        | undefined;
    readonly #resolveProfile:
        | ((profileId: string) => RigProfile | undefined | Promise<RigProfile | undefined>)
        | undefined;
    #createEventId: () => EventId;
    #createdAt: number;
    #compactionRunId: string | undefined;
    #contextMessages: Message[] | undefined;
    #credentialBindingId: string;
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
    #durableUserInputs = new Map<string, DurableUserInputCall>();
    #durableWaits = new Map<string, DurableWait>();
    #durableWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #durableWaitWaiters = new Map<string, DurableWaitWaiter>();
    #resumingDurableToolRun = false;
    #folders: FolderRepository | undefined;
    #instructions: string | undefined;
    #interruption: SessionInterruption | undefined;
    #lastMessageAt: number | undefined;
    #lifetimeTotalTokens = 0;
    #lastSessionRunId: string | undefined;
    #metadataController: AbortController | undefined;
    #metadataFailures = 0;
    #metadataInitialAttempted = false;
    #metadataNamed = false;
    #metadataNamingAttempted = false;
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
    /** The status a client has already been told about. */
    #reportedStatus: SessionStatus | undefined;
    #reportingStatus = false;
    #submittedUserMessages = new Map<string, PersistedSessionMessage>();
    #mcpServers: readonly McpServerSummary[] = [];
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
    #onAppendEvent: SessionEventAppendHook | undefined;
    readonly #stagedProtocolProjections = new WeakMap<object, StagedProtocolProjection>();
    #presence: { state(): PresenceState } | undefined;
    #publishLiveEvent: InMemorySessionOptions["publishLiveEvent"];
    #slotStores: SessionSlotStores | undefined;
    #userInputPresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #providerId: string;
    #scope: SessionScope;
    #unsortedSince: number | undefined;
    #scopeRuntimeRefreshPending = false;
    #scopeRuntimeRefresh: Promise<void> | undefined;
    #permissionMode: PermissionMode;
    #recap: string | undefined;
    #request: CreateSessionRequest;
    #restoredActiveRunId: string | undefined;
    #executionContext: AgentContext | undefined;
    #processManager: NativeProcessManager | undefined;
    #secrets: SessionSecretContext;
    #scheduledMessages = new Map<string, ScheduledMessage>();
    #status: SessionStatus = "idle";
    #activity: SessionActivity = IDLE_SESSION_ACTIVITY;
    #reportingActivity = false;
    #git: GitChangeSnapshot | undefined;
    #unread: SessionUnreadState | undefined;
    #suspendedRunIds = new Set<string>();
    #systemPrompt: string | undefined;
    #suspendOnAbort = false;
    #shutdownCleanup: Promise<void> | undefined;
    #ready: Promise<void> = Promise.resolve();
    readonly #commitEventLock: AsyncLock = asyncLock({ reentry: "block" });
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
    #workspaceRunReadiness: InMemorySessionOptions["workspaceRunReadiness"];
    #workspaceTransfer: SessionWorkspaceTransferState = { status: "idle" };

    static async open(ctx: Context, options: InMemorySessionOptions): Promise<InMemorySession> {
        const session = new InMemorySession(ctx, options);
        await session.#ready;
        return session;
    }

    static async create(ctx: Context, options: InMemorySessionOptions): Promise<InMemorySession> {
        return await InMemorySession.open(ctx, options);
    }

    async ready(): Promise<void> {
        await this.#ready;
    }

    constructor(ctx: Context, options: InMemorySessionOptions) {
        this.#workspaceFeatures = options.workspaceFeatures ?? DEFAULT_WORKSPACE_FEATURES;
        this.#workspaceRunReadiness = options.workspaceRunReadiness;
        this.#createEventId = options.createEventId;
        this.#createdAt = options.restore?.createdAt ?? (options.now ?? Date.now)();
        this.#now = options.now ?? Date.now;
        this.#onInitialTitle = options.onInitialTitle;
        this.#modelCatalog = options.modelCatalog;
        this.#persistence = options.persistence;
        this.#onAppendEvent = options.onAppendEvent;
        this.#presence = options.presence;
        this.#publishLiveEvent = options.publishLiveEvent;
        this.#slotStores = options.slotStores;
        this.#folders = options.folders;
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
            for (const secretId of secretIds) {
                const reference = secretRegistry.reference(secretId);
                if (reference.availableToModel === false) {
                    throw new Error(
                        `Secret '${secretId}' is managed by Rig and cannot be attached to agent commands.`,
                    );
                }
            }
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
        this.#ownerInstanceId =
            options.restore?.ownerInstanceId ?? options.ownerInstanceId ?? createId();
        this.#profileId = options.restore?.profileId ?? options.profileId;
        this.#resolveGitAuthentication = options.resolveGitAuthentication;
        this.#resolveProfile = options.resolveProfile;
        this.#archived = options.restore?.archived === true;
        const restoredBindingProvider = options.restore?.credentialBindingId
            ? this.#modelCatalog.providers.find(
                  (provider) =>
                      (provider.credential?.bindingId ??
                          `${this.#ownerInstanceId}:${provider.providerId}`) ===
                      options.restore!.credentialBindingId,
              )
            : undefined;
        const restoredBindingMissing =
            options.restore?.credentialBindingId !== undefined &&
            restoredBindingProvider === undefined;
        const requestedModelId = restoredBindingMissing
            ? this.#modelCatalog.defaultModelId
            : (options.restore?.modelId ??
              options.request.modelId ??
              this.#modelCatalog.defaultModelId);
        const requestedProviderId =
            restoredBindingProvider?.providerId ??
            (restoredBindingMissing
                ? this.#modelCatalog.defaultProviderId
                : (options.restore?.providerId ??
                  options.request.providerId ??
                  this.#modelCatalog.defaultProviderId));
        const selection = resolveInitialModelSelection(
            this.#modelCatalog,
            requestedModelId,
            requestedProviderId,
        );
        this.#modelId = selection.model.id;
        this.#providerId = selection.providerId;
        this.#credentialBindingId =
            options.restore?.credentialBindingId ?? this.#providerBindingId(selection.providerId);
        this.#permissionMode = parsePermissionMode(
            options.restore?.permissionMode ??
                options.request.permissionMode ??
                DEFAULT_PERMISSION_MODE,
        );
        this.#scope =
            options.restore?.scope ??
            options.scope ??
            ({ kind: "project", projectId: createId() } as const);
        this.#unsortedSince =
            this.#scope.kind === "unsorted"
                ? (options.restore?.unsortedSince ?? this.#createdAt)
                : undefined;
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
        this.#metadataInitialAttempted = this.#metadataUpdatedAt !== undefined;
        this.#metadataNamed = this.#metadataUpdatedAt !== undefined;
        this.#metadataNamingAttempted = this.#metadataUpdatedAt !== undefined;
        this.#metadataRefinementAttempted = this.#metadataRunId !== undefined;
        // The attempts a chat gets belong to the session that spends them. A restored chat whose
        // naming already failed keeps that outcome instead of asking the provider again every time
        // it is loaded.
        if (this.#titleStatus === "error") this.#metadataFailures = SESSION_METADATA_MAX_FAILURES;
        this.#totalTokens = options.restore?.totalTokens ?? 0;
        this.#taskList = new SessionTaskList(options.restore?.tasks, options.restore?.nextTaskId);
        this.#tools = options.restore?.tools ?? [];
        this.#interruption = options.restore?.interruption;
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
        this.#restoreDurableWaitTimers();
        void this.#refreshWaitActivity(ctx, false).catch(rethrowDatabaseFailure);
        for (const event of this.events.all()) {
            this.#recordRunFacts(event);
            this.#recordPermissionReview(event);
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
        this.#ready = (async () => {
            await this.#restoreUserInputPresenceTimers(ctx);
            if (
                this.#workspaceTransfer.status === "scheduled" ||
                this.#workspaceTransfer.status === "transferring"
            ) {
                await this.failWorkspaceTransfer(
                    ctx,
                    this.#workspaceTransfer.targetWorkspaceId,
                    new Error(
                        "The session transfer did not happen because the local server stopped before it could finish.",
                    ),
                    "not_touched",
                );
            } else if (options.restore === undefined) {
                await this.#saveSession(ctx);
            }
            if (options.restore === undefined) {
                if (options.emitCreatedEvent !== false) {
                    await this.emitCreatedEvent(ctx);
                }
            } else {
                await this.#continueGoalIfIdle(ctx);
                if (!this.isSubagent()) await this.#restartMetadataSettlement();
            }
        })();
    }

    abort(
        _ctx: Context,
        _options: {
            continuePendingSteering?: boolean;
            expectedRunId?: string;
            mutationId?: string;
            stopDescendants?: boolean;
            steeringMessageIds?: readonly string[];
        } = {},
    ): Promise<AbortRunResponse> {
        return Promise.reject(new Error("Agent abort is owned by Agent Base."));
    }

    async stopBackgroundProcesses(ctx: Context): Promise<number> {
        const executionContext = this.#executionContext;
        if (executionContext === undefined) return 0;
        const runningProcesses = executionContext.bash.activeSessionCount?.() ?? 0;
        await executionContext.bash.killAllSessions?.();
        return runningProcesses;
    }

    async readBackgroundProcess(
        ctx: Context,
        sessionId: number,
        options: { waitMs?: number } = {},
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        const executionContext = this.#executionContext;
        if (executionContext === undefined) return undefined;
        // Watching a background command must not consume output the agent has
        // not read yet, so this observer never advances the delta cursor.
        return executionContext.bash.readSession(sessionId, { ...options, peek: true });
    }

    async stopBackgroundProcess(
        ctx: Context,
        sessionId: number,
    ): Promise<StopBackgroundProcessResponse> {
        const executionContext = this.#executionContext;
        if (executionContext === undefined) return { stopped: false };
        const process = await executionContext.bash.killSession(sessionId);
        if (process === undefined) return { stopped: false };
        await this.#shellCommandCompletions.get(sessionId);
        return { process, stopped: true };
    }

    async runShellCommand(
        ctx: Context,
        request: RunShellCommandRequest,
    ): Promise<RunShellCommandResponse> {
        this.#assertAcceptingWork();
        const command = request.command.trim();
        if (command.length === 0) throw new Error("Enter a shell command after !.");

        const historyRevision = this.#shellHistoryRevision;
        const bash = (await this.#ensureExecutionContext(ctx)).bash;
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
            const event = await this.#recordShellCommandResult(ctx, result, historyRevision);
            return { ...result, eventId: event.id, status: "finished" };
        }

        // The user ran this, not a turn. Interrupting the agent must not reach
        // in and kill a command the user is watching.
        bash.detachSession?.(sessionId);
        const event = await this.#append(ctx, "shell_command_started", {
            command,
            commandId: request.commandId,
            sessionId,
        });
        const watch = () =>
            withWorkerContext(
                "shell-command-watch",
                (workerCtx) =>
                    this.#watchShellCommand(
                        workerCtx,
                        bash,
                        command,
                        request.commandId,
                        sessionId,
                        historyRevision,
                    ),
                { sessionId: this.id },
            );
        const watching = this.#taskDrain?.run(watch) ?? watch();
        const completion = watching
            .catch(async (error: unknown) => {
                if (isDatabaseFailure(error)) throw error;
                await withWorkerContext("shell-command-failure", (workerCtx) =>
                    this.#recordShellCommandResult(
                        workerCtx,
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
                    ),
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
        ctx: Context,
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

            await this.#recordShellCommandResult(
                ctx,
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

    async #recordShellCommandResult(
        ctx: Context,
        result: RunShellCommandResult,
        historyRevision: number,
    ): Promise<ShellCommandFinishedEvent> {
        if (historyRevision !== this.#shellHistoryRevision) {
            return await this.#append(ctx, "shell_command_finished", result);
        }
        const contextMessage: UserMessage = {
            blocks: [{ type: "text", text: formatShellCommandContext(result) }],
            id: createId(),
            role: "user",
            shellCommandId: result.commandId,
        };
        this.#separateModelContextFromVisibleTranscript();
        this.#contextMessages?.push(contextMessage);
        await this.#storeMessage(
            ctx,
            this.#nextMessagePosition(),
            contextMessage,
            false,
            `shell:${result.commandId}`,
        );
        this.#lastMessageAt = this.#now();

        return await this.#append(ctx, "shell_command_finished", result);
    }

    /**
     * Tells the model that a background command ended.
     *
     * Only the fact, never the output: whatever the command last printed is
     * still there to be read through the usual background-task tools, and
     * pushing it here would drop it into the conversation uninvited.
     */
    async #notifyBackgroundProcessExit(ctx: Context, exit: BashSessionExit): Promise<void> {
        if (this.#executionContext === undefined) return;
        const message: SystemMessage = {
            blocks: [{ type: "text", text: formatBackgroundProcessExit(exit) }],
            id: createId(),
            internal: true,
            role: "system",
        };
        await this.#append(ctx, "agent_event", {
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

    async suspendByParent(ctx: Context): Promise<void> {
        if (!this.isSubagent()) return;
        if (this.#activeRun !== undefined) this.#suspendedRunIds.add(this.#activeRun.runId);
        this.#suspendOnAbort = true;
        await this.abort(ctx, { stopDescendants: false });
        this.#status = "suspended";
        if (this.#activeRun === undefined) this.#suspendOnAbort = false;
        await this.#saveSession(ctx);
    }

    async clearSuspension(ctx: Context): Promise<void> {
        this.#suspendOnAbort = false;
        if (this.#status !== "suspended") return;
        this.#status = "aborted";
        await this.#saveSession(ctx);
    }

    consumeSuspendedRun(runId: string): boolean {
        return this.#suspendedRunIds.delete(runId);
    }

    async recordSubagentsSuspended(
        ctx: Context,
        subagents: readonly { description: string; path: string }[],
    ): Promise<void> {
        if (subagents.length === 0) return;
        const count = subagents.length;
        const names = subagents.map((subagent) => subagent.description).join(", ");
        const displayText = `${count} ${count === 1 ? "subagent was" : "subagents were"} suspended: ${names}. They will remain suspended until explicitly resumed or redirected.`;
        this.#separateModelContextFromVisibleTranscript();
        this.#contextMessages?.push({
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
        await this.#append(ctx, "subagents_suspended", { displayText });
    }

    /**
     * Appends a visible service message without putting operational progress into model context.
     *
     * Notices have their own durable event and message position. They deliberately have no run
     * lifecycle, so they cannot disturb activity, unread state, or an in-flight agent group.
     */
    async recordSystemNotice(
        ctx: Context,
        payload: SystemNoticePayload,
        options: { settleArchived?: true } = {},
    ): Promise<void> {
        if ((this.#archived && options.settleArchived !== true) || this.#workspaceArchived) {
            return Promise.resolve();
        }
        const message: SystemMessage = {
            blocks: [{ text: payload.text, type: "text" }],
            context: "excluded",
            id: createId(),
            role: "system",
            ...(payload.structured === undefined ? {} : { structured: payload.structured }),
        };
        const commit = async (ctx: Context) => {
            await this.#storeMessage(ctx, this.#nextMessagePosition(), message, false);
            await this.#append(ctx, "system_notice", { message });
        };
        return this.#persistence?.transaction === undefined
            ? await commit(ctx)
            : await this.#persistence.transaction(ctx, commit).then(() => undefined);
    }

    agentMetadata(): SessionAgentMetadata {
        return { ...this.#agentMetadata };
    }

    isArchived(): boolean {
        return this.#archived;
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
        return undefined;
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
            this.#compactionActive ||
            [...this.#workflowRuns.values()].some((run) => run.state.status === "running") ||
            (this.#executionContext?.bash.activeSessionCount?.() ?? 0) > 0
        );
    }

    async scheduleWorkspaceTransfer(
        ctx: Context,
        targetWorkspaceId: string,
    ): Promise<{
        projectId: string;
        sourceWorkspaceId: string;
    }> {
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
        await this.#setWorkspaceTransferState(ctx, { status: "scheduled", targetWorkspaceId });
        return { projectId: this.#projectScope().projectId, sourceWorkspaceId };
    }

    async beginWorkspaceTransfer(
        ctx: Context,
        targetWorkspaceId: string,
        options: { scheduled?: boolean } = {},
    ): Promise<{ projectId: string; sourceWorkspaceId: string }> {
        this.#assertAcceptingWork();
        const sourceWorkspaceId =
            options.scheduled === true
                ? this.#workspaceScope()?.workspaceId
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
            this.#compactionActive ||
            [...this.#workflowRuns.values()].some((run) => run.state.status === "running")
        ) {
            throw new Error(
                "Wait for the active response to finish before transferring this session.",
            );
        }
        await this.#setWorkspaceTransferState(ctx, { status: "transferring", targetWorkspaceId });
        return { projectId: this.#projectScope().projectId, sourceWorkspaceId };
    }

    async completeWorkspaceTransfer(
        ctx: Context,
        input: {
            commit: string;
            targetWorkspaceId: string;
            workspacePath: string;
        },
    ): Promise<ProtocolSession> {
        if (
            this.#workspaceTransfer.status !== "transferring" ||
            this.#workspaceTransfer.targetWorkspaceId !== input.targetWorkspaceId
        ) {
            throw new Error("The session transfer is no longer active.");
        }
        const contextMessages = [
            ...(
                this.#contextMessages ??
                this.#committedMessages()
            ).filter((message) => !isExcludedFromModelContext(message)),
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
        await this.#teardownRuntimeForWorkspaceTransfer(ctx);
        const succeeded: SessionWorkspaceTransferState = {
            status: "succeeded",
            targetWorkspaceId: input.targetWorkspaceId,
        };

        const projectId = this.#projectScope().projectId;
        const orderKey = await this.#persistence?.transferWorkspace?.(ctx, {
            contextMessages: nextContextMessages,
            cwd: input.workspacePath,
            projectId,
            sessionId: this.id,
            state: succeeded,
            workspaceId: input.targetWorkspaceId,
        });

        this.#request = {
            ...this.#request,
            cwd: input.workspacePath,
            workspaceId: input.targetWorkspaceId,
        };
        this.#scope = {
            kind: "workspace",
            projectId,
            workspaceId: input.targetWorkspaceId,
        };
        if (orderKey !== undefined) this.#orderKey = orderKey;
        this.#git = undefined;
        this.#contextMessages = nextContextMessages;
        this.#workspaceTransfer = succeeded;
        await this.#append(ctx, "session_updated", {
            appendedContextMessage: notice,
            session: this.clientSnapshot(),
        });
        return this.snapshot();
    }

    async failWorkspaceTransfer(
        ctx: Context,
        targetWorkspaceId: string,
        error: unknown,
        target: Extract<
            SessionWorkspaceTransferState,
            { status: "failed" }
        >["target"] = "not_touched",
        runId?: string,
    ): Promise<void> {
        if (
            this.#workspaceTransfer.status === "failed" &&
            this.#workspaceTransfer.targetWorkspaceId === targetWorkspaceId
        ) {
            if (runId !== undefined) {
                await this.#append(ctx, "run_error", {
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
            await this.#setWorkspaceTransferState(
                ctx,
                {
                    errorMessage,
                    status: "failed",
                    target,
                    targetWorkspaceId,
                },
                contextMessages,
            );
            if (runId !== undefined) {
                await this.#append(ctx, "run_error", {
                    errorMessage: `Session transfer failed: ${errorMessage}`,
                    modelLocked: this.#modelLocked(),
                    runId,
                });
            } else {
                await this.#append(ctx, "session_updated", { session: this.clientSnapshot() });
            }
        }
    }

    workspaceTransferState(): SessionWorkspaceTransferState {
        return this.#workspaceTransfer;
    }

    async changeModel(ctx: Context, request: ChangeModelRequest): Promise<ProtocolSession> {
        // Resolving the provider before the idle guard keeps an unknown model reported as an
        // unknown model rather than as a busy session.
        this.#resolveProviderForModel(request.modelId, request.providerId);
        if (this.#activeRun !== undefined) {
            throw new Error("Wait for the active response to finish before changing models.");
        }
        return await this.#applyConfiguration(
            ctx,
            {
                ...(request.effort === undefined ? {} : { effort: request.effort }),
                modelId: request.modelId,
                ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            },
            request.mutationId === undefined ? {} : { mutationId: request.mutationId },
        );
    }

    async changeEffort(ctx: Context, request: ChangeEffortRequest): Promise<ProtocolSession> {
        return await this.#applyConfiguration(
            ctx,
            {
                effort: request.effort ?? this.#selectedModel().defaultThinkingLevel,
            },
            request.mutationId === undefined ? {} : { mutationId: request.mutationId },
        );
    }

    async changeServiceTier(
        ctx: Context,
        request: ChangeServiceTierRequest,
    ): Promise<ProtocolSession> {
        return await this.#applyConfiguration(
            ctx,
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
    async #applyConfiguration(
        ctx: Context,
        change: {
            effort?: string;
            modelId?: string;
            providerId?: string;
            serviceTier?: ServiceTier | null;
        },
        options: { excludeRunId?: string; mutationId?: string } = {},
    ): Promise<ProtocolSession> {
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
            await this.#switchModel(ctx, targetModel, targetProviderId, options);
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

        if (this.#effort !== previousEffort) changed.push("effort");
        if (this.#serviceTier !== previousServiceTier) changed.push("serviceTier");
        if (changed.includes("model")) this.#totalTokens = 0;

        this.#interruption = undefined;
        await this.#append(ctx, "session_configuration_changed", {
            changed,
            ...(this.#effort === undefined ? {} : { effort: this.#effort }),
            modelId: this.#modelId,
            providerId: this.#providerId,
            serviceTier: this.#serviceTier ?? null,
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

    async #switchModel(
        ctx: Context,
        model: Model,
        providerId: string,
        options: { excludeRunId?: string },
    ): Promise<void> {
        const compatible = this.#modelsAreCompatible(model, providerId);
        if (compatible) {
            this.#contextMessages ??= this.#committedMessages();
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
                    : visibleMessages;
        }
        if (!compatible) {
            this.#mcpServers = [];
            this.#tools = [];
        }
        this.#modelId = model.id;
        this.#providerId = providerId;
        this.#credentialBindingId = this.#providerBindingId(providerId);
        this.#models = this.#modelsForProvider(providerId);
    }

    /**
     * Replaces the inference scope after its credential registry changes.
     *
     * Credential revisions are an authorization boundary. A runtime or executor created from an
     * older revision must never survive a rotation, visibility change, or revocation.
     */
    async refreshInferenceScope(ctx: Context, modelCatalog: ModelCatalog): Promise<void> {
        await this.#applyInferenceScopeRefresh(ctx, modelCatalog);
    }

    async #applyInferenceScopeRefresh(ctx: Context, modelCatalog: ModelCatalog): Promise<void> {
        const catalogChanged = JSON.stringify(this.#modelCatalog) !== JSON.stringify(modelCatalog);
        const credentialBindingId = this.#credentialBindingId;
        this.#mcpServers = [];
        this.#tools = [];
        this.#modelCatalog = modelCatalog;

        const reboundProvider = modelCatalog.providers.find(
            (provider) =>
                this.#providerBindingId(provider.providerId) === credentialBindingId &&
                provider.models.some((model) => model.id === this.#modelId),
        );
        if (reboundProvider === undefined) {
            await this.#applyConfiguration(ctx, {
                modelId: modelCatalog.defaultModelId,
                providerId: modelCatalog.defaultProviderId,
            });
        } else if (reboundProvider.providerId !== this.#providerId) {
            await this.#applyConfiguration(ctx, {
                modelId: this.#modelId,
                providerId: reboundProvider.providerId,
            });
        } else {
            this.#models = this.#modelsForProvider(this.#providerId);
            if (catalogChanged) {
                await this.#append(ctx, "session_updated", { session: this.clientSnapshot() });
            }
        }
    }

    #providerBindingId(providerId: string): string {
        return (
            this.#modelCatalog.providers.find((provider) => provider.providerId === providerId)
                ?.credential?.bindingId ?? `${this.#ownerInstanceId}:${providerId}`
        );
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

    createForkState(): PersistedSessionState {
        this.#assertAcceptingWork();
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be forked.");
        }
        if (this.#activeRun !== undefined) {
            throw new Error("Wait for the active response to finish before forking this session.");
        }

        this.#contextMessages ??= this.#committedMessages();
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

    async update(ctx: Context, request: UpdateSessionRequest): Promise<ProtocolSession> {
        return await this.#runSessionMutation(ctx, async (ctx) => {
            this.#appendSystemPrompt = request.appendSystemPrompt ?? undefined;
            this.#interruption = undefined;
            await this.#append(ctx, "session_updated", {
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                session: this.clientSnapshot(),
            });
            return this.snapshot();
        });
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
    async noteShareCapabilitiesChanged(ctx: Context): Promise<void> {
        await this.#append(ctx, "session_updated", { session: this.clientSnapshot() });
    }

    async setOrderKey(ctx: Context, orderKey: string): Promise<ProtocolSession> {
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        return await this.#runSessionMutation(ctx, async (ctx) => {
            if (this.#orderKey === orderKey) return this.snapshot();
            this.#orderKey = orderKey;
            await this.#append(ctx, "session_updated", { session: this.clientSnapshot() });
            return this.snapshot();
        });
    }

    /**
     * Store the composer draft and mirror it to every other attached client.
     * The draft belongs to the clients: Rig keeps the latest text so a restarted
     * terminal or a newly attached client can pick the message back up, and does
     * not otherwise interpret it.
     */
    async setDraft(ctx: Context, request: SetSessionDraftRequest): Promise<ProtocolSession> {
        const draft =
            request.draft === null || request.draft.length === 0 ? undefined : request.draft;
        if (draft !== undefined && draft.length > SESSION_DRAFT_MAX_LENGTH) {
            throw new Error("The draft is too long to sync.");
        }
        const updatedAt = clampSessionDraftTimestamp(request.updatedAt, this.#now());
        // The newest message wins, not the last one to arrive. A draft typed
        // before the one already stored is discarded even when a slow client
        // delivers it afterwards.
        return await this.#runSessionMutation(ctx, async (ctx) => {
            if (this.#draftUpdatedAt !== undefined && updatedAt < this.#draftUpdatedAt) {
                return this.snapshot();
            }
            if (this.#draft === draft) return this.snapshot();
            this.#draft = draft;
            this.#draftUpdatedAt = updatedAt;
            await this.#append(ctx, "session_draft_changed", {
                ...(draft === undefined ? {} : { draft }),
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                ...(request.origin === undefined ? {} : { origin: request.origin }),
                updatedAt,
            });
            return this.snapshot();
        });
    }

    /**
     * Project and workspace identity without building a protocol snapshot. Observers on hot paths
     * need only these two fields, and `snapshot()` walks every message to produce them.
     */
    projectIdentity(): { projectId: string; workspaceId?: string } | undefined {
        if (this.#scope.kind === "project") return { projectId: this.#scope.projectId };
        if (this.#scope.kind === "workspace") {
            return { projectId: this.#scope.projectId, workspaceId: this.#scope.workspaceId };
        }
        return undefined;
    }

    /**
     * Files this chat into a folder, or returns it to Unsorted with `null`.
     *
     * The folder tree stores which chat sits where, so the row is written there first and the
     * session only carries what was already accepted. A chat with no folder is Unsorted and is put
     * away on its own once it has been there long enough.
     */
    async fileIntoFolder(
        ctx: Context,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): Promise<Folder | undefined> {
        const folders = this.#folderRepository();
        if (afterId === undefined && folderId === null && this.#scope.kind === "unsorted") {
            return undefined;
        }
        const filed = folderId === null ? undefined : await folders.getFolder(ctx, folderId);
        if (
            folderId !== null &&
            afterId === undefined &&
            this.#scope.kind === "folder" &&
            this.#scope.folderId === folderId
        ) {
            return filed;
        }
        if (this.#persistence === undefined) {
            if (folderId !== null && (filed === undefined || filed.archivedAt !== undefined)) {
                throw new FolderError("folder_not_found", "That folder was not found.");
            }
            const storage =
                folderId === null
                    ? folders.createUnsortedSessionDirectory(ctx, this.id)
                    : {
                          created: false,
                          path: await folders.activeFolderStoragePath(ctx, folderId),
                      };
            try {
                await this.applyScopeMove(ctx, {
                    cwd: storage.path,
                    orderKey: generateKeyBetween(null, null),
                    scope: folderId === null ? { kind: "unsorted" } : { folderId, kind: "folder" },
                    ...(folderId === null
                        ? { unsortedSince: this.#unsortedSince ?? this.#now() }
                        : {}),
                });
            } catch (error) {
                if (storage.created) {
                    folders.removeNewUnsortedSessionDirectory(ctx, this.id, storage.path);
                }
                throw error;
            }
            return filed;
        }
        const moved = await folders.setSessionFolder(ctx, this.id, folderId, afterId, mutationId);
        await this.applyScopeMove(ctx, moved);
        return filed;
    }

    /** Applies a scope transition already committed by the owning store. */
    async applyScopeMove(ctx: Context, moved: SessionScopeMove): Promise<void> {
        const executionContextChanged =
            this.#request.cwd !== moved.cwd || !isDeepStrictEqual(this.#scope, moved.scope);
        this.#scope = moved.scope;
        this.#unsortedSince = moved.unsortedSince;
        this.#orderKey = moved.orderKey;
        if (executionContextChanged) {
            const { docker: _docker, local: _local, ...request } = this.#request;
            this.#request = { ...request, cwd: moved.cwd };
            for (const secretId of this.#secrets.projectIds()) {
                this.#secrets.detach(secretId, "project");
            }
            this.#scopeRuntimeRefreshPending = this.#executionContext !== undefined;
            if (this.#scopeRuntimeRefreshPending && this.#activeRun === undefined) {
                this.#startScopeRuntimeRefresh();
            }
        }
        await this.#append(ctx, "session_updated", { session: this.clientSnapshot() });
    }

    /** Retires a runtime whose trusted folder metadata or virtual ancestry changed. */
    folderContextChanged(): void {
        if (this.#scope.kind !== "folder" || this.#executionContext === undefined) return;
        this.#scopeRuntimeRefreshPending = true;
        if (this.#activeRun === undefined) this.#startScopeRuntimeRefresh();
    }

    /** Whether this session currently executes inside one of the supplied virtual folders. */
    belongsToFolderContext(folderIds: ReadonlySet<string>): boolean {
        return this.#scope.kind === "folder" && folderIds.has(this.#scope.folderId);
    }

    /** Retires this chat and its complete retained tree after its folder was archived. */
    recordFolderArchived(ctx: Context): Promise<void> {
        const own = this.retireForContextChange(ctx);
        return own;
    }

    /**
     * Permanently retires a saved agent whose old execution context must never be resumed.
     *
     * The state transition happens synchronously before cleanup yields, so another caller cannot
     * restart this session between the authority change and process teardown.
     */
    async retireForContextChange(ctx: Context): Promise<void> {
        if (this.#workspaceArchived) return this.beginShutdown(ctx);
        const activeRun = this.#activeRun;
        const runIds = new Set([
            ...(activeRun === undefined ? [] : [activeRun.runId]),
            ...(this.#restoredActiveRunId === undefined ? [] : [this.#restoredActiveRunId]),
        ]);
        for (const runId of runIds) {
            await this.#cancelDurableUserInputs(ctx, runId);
            await this.#cancelDurableWaits(ctx, runId);
        }
        this.#finishElapsedInterval();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#pendingSteeringMessages.clear();
        this.#pendingSteeringContinuations.clear();
        this.#suspendedRunIds.clear();
        this.#suspendOnAbort = false;
        await this.#pauseActiveGoal(ctx);
        this.#status = "archived";
        this.#archived = true;
        await this.#append(ctx, "session_archived", { archived: true });
        this.#workspaceArchived = true;
        activeRun?.controller.abort();
        await this.beginShutdown(ctx);
    }

    async setArchived(
        ctx: Context,
        archived: boolean,
        mutationId?: string,
    ): Promise<ProtocolSession> {
        return await this.#runSessionMutation(ctx, async (ctx) => {
            if (!archived && this.#workspaceArchived) {
                throw new Error("A session archived with its workspace cannot be restored.");
            }
            if (this.#archived === archived) return this.snapshot();
            this.#archived = archived;
            await this.#append(ctx, "session_archived", {
                archived,
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            // The durable archive event and session snapshot have committed before runtime
            // processes are stopped. A rejected persistence write therefore leaves execution
            // untouched, while a successful archive cannot keep running work alive.
            if (archived) {
                const teardown = async () => {
                    this.#activeRun?.controller.abort();
                    await this.#killExecutionProcesses(ctx, { includeBackground: true });
                };
                if (this.#persistence?.afterTransactionCommit === undefined) {
                    await teardown();
                } else {
                    await this.#persistence.afterTransactionCommit(ctx, teardown);
                }
            }
            return this.snapshot();
        });
    }

    async changePermissionMode(
        ctx: Context,
        request: ChangePermissionModeRequest,
        options: { updateSubagents?: boolean } = {},
    ): Promise<ProtocolSession> {
        const permissionMode = parsePermissionMode(request.permissionMode);
        const permissions = this.#executionContext?.permissions;
        const previousPermissionMode = this.#permissionMode;
        this.#permissionMode = permissionMode;
        permissions?.setMode(permissionMode);
        try {
            await this.#append(ctx, "permission_mode_changed", {
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                permissionMode,
            });
        } catch (error) {
            if (isPermissionReduction(previousPermissionMode, permissionMode)) {
                try {
                    await this.beginShutdown(ctx);
                } catch (shutdownError) {
                    throw new AggregateError(
                        [error, shutdownError],
                        "Could not persist the permission reduction or fully stop the session.",
                    );
                }
                throw error;
            }
            this.#permissionMode = previousPermissionMode;
            permissions?.setMode(previousPermissionMode);
            throw error;
        }
        const running = this.#reapableProcessCount();
        const descendantChange = Promise.resolve();
        const localProcessShutdown = (async () => {
            if (running === 0 || !isPermissionReduction(previousPermissionMode, permissionMode)) {
                return;
            }
            await this.#killExecutionProcesses(ctx, { includeBackground: true });
            const runId = this.#activeRun?.runId ?? this.#lastSessionRunId ?? "background";
            await this.#append(ctx, "agent_event", {
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
        if (transitionErrors.length === 1) {
            throw transitionErrors[0];
        }
        if (transitionErrors.length > 1) {
            throw new AggregateError(
                transitionErrors,
                "Could not fully apply the permission mode change.",
            );
        }
        return this.snapshot();
    }

    async attachSecret(
        ctx: Context,
        secretId: string,
        options: { mutationId?: string; scope?: SecretAttachmentScope } = {},
    ): Promise<ProtocolSession> {
        const scope = options.scope ?? "session";
        this.#secrets.attach(secretId, scope);
        await this.#append(ctx, "secrets_changed", {
            ...this.#secretAttachmentData(),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        return this.snapshot();
    }

    async detachSecret(
        ctx: Context,
        secretId: string,
        options: { mutationId?: string; scope?: SecretAttachmentScope } = {},
    ): Promise<ProtocolSession> {
        const scope = options.scope ?? "session";
        if (!this.#secrets.detach(secretId, scope)) return this.snapshot();
        await this.#append(ctx, "secrets_changed", {
            ...this.#secretAttachmentData(),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        return this.snapshot();
    }

    async setGoal(
        ctx: Context,
        request: CreateGoalRequest,
        mutationId?: string,
    ): Promise<SessionGoal> {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        const goal = await this.#runSessionMutation(ctx, async (ctx) => {
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
            await this.#append(ctx, "goal_changed", {
                goal: { ...this.#goal },
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            if (this.#titleStatus === "idle") {
                this.#title = createGoalTitle(this.#goal.objective);
                this.#titleStatus = "ready";
                await this.#append(ctx, "session_title_changed", {
                    status: this.#titleStatus,
                    title: this.#title,
                });
            }
            await this.#continueGoalIfIdle(ctx);
            return { ...this.#goal };
        });
        return goal;
    }

    async changeGoalStatus(
        ctx: Context,
        request: ChangeGoalStatusRequest,
        options: { mutationId?: string; stopActiveGoalRun?: boolean } = {},
    ): Promise<SessionGoal> {
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
        await this.#append(ctx, "goal_changed", {
            goal: { ...this.#goal },
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        if (request.status === "active") {
            await this.#continueGoalIfIdle(ctx);
        } else if (options.stopActiveGoalRun !== false) {
            await this.#discardQueuedGoalRuns(ctx);
            if (this.#activeRun?.kind === "goal") {
                this.#activeRun.controller.abort();
                void this.#killExecutionProcesses(ctx);
            }
        }
        return { ...this.#goal };
    }

    async clearGoal(ctx: Context, mutationId?: string): Promise<boolean> {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        if (this.#goal === undefined) return false;

        this.#goal = undefined;
        await this.#discardQueuedGoalRuns(ctx);
        if (this.#activeRun?.kind === "goal") {
            this.#activeRun.controller.abort();
            void this.#killExecutionProcesses(ctx);
        }
        await this.#append(ctx, "goal_changed", {
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

    async scheduleMessage(
        ctx: Context,
        request: ScheduleMessageRequest,
    ): Promise<ScheduledMessage> {
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
        await this.#persistence?.upsertScheduledMessage?.(ctx, scheduled);
        this.#scheduledMessages.set(scheduled.id, scheduled);
        await this.#append(ctx, "scheduled_message_changed", {
            message: structuredClone(scheduled),
        });
        await this.#pruneScheduledMessages(ctx);
        await this.#persistence?.scheduledMessageChanged?.(ctx);
        return structuredClone(scheduled);
    }

    async cancelScheduledMessage(
        ctx: Context,
        messageId: string,
        mutationId?: string,
    ): Promise<{ cancelled: boolean; message?: ScheduledMessage }> {
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
        await this.#persistence?.upsertScheduledMessage?.(ctx, next);
        this.#scheduledMessages.set(next.id, next);
        await this.#append(ctx, "scheduled_message_changed", {
            message: structuredClone(next),
            ...(mutationId === undefined ? {} : { mutationId }),
        });
        await this.#pruneScheduledMessages(ctx);
        await this.#persistence?.scheduledMessageChanged?.(ctx);
        return { cancelled: true, message: structuredClone(next) };
    }

    async deliverScheduledMessage(
        ctx: Context,
        messageId: string,
    ): Promise<ScheduledMessage | undefined> {
        const current = this.#scheduledMessages.get(messageId);
        if (current === undefined || current.status !== "pending") {
            return current === undefined ? undefined : structuredClone(current);
        }
        const delivered = false;
        const failure = "Scheduled agent messages are owned by Agent Base.";
        const now = this.#now();
        const next: ScheduledMessage = {
            ...current,
            ...(delivered ? { deliveredAt: now } : { failure: failure ?? "Delivery failed." }),
            status: delivered ? "delivered" : "undelivered",
            updatedAt: now,
        };
        await this.#persistence?.upsertScheduledMessage?.(ctx, next);
        this.#scheduledMessages.set(next.id, next);
        await this.#append(ctx, "scheduled_message_changed", { message: structuredClone(next) });
        await this.#pruneScheduledMessages(ctx);
        await this.#persistence?.scheduledMessageChanged?.(ctx);
        return structuredClone(next);
    }

    async requestUserInput(
        ctx: Context,
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
                await this.#persistence?.upsertDurableUserInput?.(ctx, durable);
                createdDurable = true;
            }
        }

        const requestedAt = this.#now();
        let pendingInput!: PendingUserInput;
        const response = new Promise<UserInputOutcome>((resolve, reject) => {
            pendingInput = {
                request,
                requestedAt,
                reject,
                resolve,
                ...(durable === undefined ? {} : { durable }),
            };
            if (options.signal !== undefined) pendingInput.signal = options.signal;
            const onAbort = () => {
                void withWorkerContext(
                    "user-input-abort",
                    (workerCtx) => this.#abortPendingUserInput(workerCtx, pendingInput),
                    { sessionId: this.id },
                ).catch((error: unknown) => {
                    pendingInput.reject(
                        error instanceof Error ? error : new Error(errorToMessage(error)),
                    );
                });
            };
            pendingInput.onAbort = onAbort;
            options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        try {
            if (durable === undefined || createdDurable) {
                await this.#append(ctx, "user_input_requested", request);
            }
        } catch (error) {
            options.signal?.removeEventListener("abort", pendingInput.onAbort!);
            throw error;
        }
        if (durable !== undefined && createdDurable) {
            this.#durableUserInputs.set(request.requestId, durable);
        }
        this.#pendingUserInputs.set(request.requestId, pendingInput);
        if (isSignalAborted(options.signal)) {
            await this.#abortPendingUserInput(ctx, pendingInput).catch((error: unknown) => {
                pendingInput.reject(
                    error instanceof Error ? error : new Error(errorToMessage(error)),
                );
            });
        }
        void this.#applyPresenceToUserInput(ctx, request.requestId, options.durable?.kind).catch(
            rethrowDatabaseFailure,
        );
        return response;
    }

    async #abortPendingUserInput(ctx: Context, pendingInput: PendingUserInput): Promise<void> {
        const requestId = pendingInput.request.requestId;
        if (this.#pendingUserInputs.get(requestId) !== pendingInput) return;
        if (pendingInput.durable === undefined) {
            await this.#append(ctx, "user_input_resolved", {
                requestId,
                status: "cancelled",
            });
        } else if (!this.#closing && pendingInput.durable.status === "pending") {
            await this.#cancelDurableUserInput(ctx, pendingInput.durable);
        }
        if (this.#pendingUserInputs.get(requestId) !== pendingInput) return;
        this.#pendingUserInputs.delete(requestId);
        this.#clearUserInputPresenceTimer(requestId);
        pendingInput.signal?.removeEventListener("abort", pendingInput.onAbort!);
        pendingInput.reject(new Error("The user input request was cancelled."));
    }

    /** Applies a daemon-wide presence change to this agent and anything awaiting the user. */
    presenceChanged(state: PresenceState): void {
        for (const pending of [...this.#pendingUserInputs.values()]) {
            void withWorkerContext(
                "user-input-presence",
                (workerCtx) =>
                    this.#applyPresenceToUserInput(
                        workerCtx,
                        pending.request.requestId,
                        pending.durable?.kind,
                        state,
                    ),
                { sessionId: this.id },
            ).catch(rethrowDatabaseFailure);
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
            void withWorkerContext(
                "user-input-presence",
                (workerCtx) => this.#applyPresenceToRestoredUserInput(workerCtx, call, state),
                { sessionId: this.id },
            ).catch(rethrowDatabaseFailure);
        }
    }

    /**
     * Questions follow the user's presence: Online waits indefinitely, Away never waits, and a
     * custom state waits for however long it allows. When presence ends the wait the question
     * keeps its place in the Inbox and only stops blocking the agent.
     */
    async #applyPresenceToUserInput(
        ctx: Context,
        requestId: string,
        kind: DurableUserInputCall["kind"] | undefined,
        currentState?: PresenceState,
    ): Promise<void> {
        if (kind !== "question") return;
        if (!this.#pendingUserInputs.has(requestId)) return;
        this.#clearUserInputPresenceTimer(requestId);
        const state = currentState ?? this.#presence?.state();
        if (state === undefined) return;
        const answerWaitMs = state.presence.answerWaitMs;
        const durable = this.#pendingUserInputs.get(requestId)?.durable;
        if (answerWaitMs === null) {
            if (durable?.answerDueAt !== undefined || durable?.answerWaitStartedAt !== undefined) {
                const nextDurable = { ...durable };
                delete nextDurable.answerDueAt;
                delete nextDurable.answerWaitStartedAt;
                await this.#persistence?.upsertDurableUserInput?.(ctx, nextDurable);
                Object.assign(durable, nextDurable);
            }
            return;
        }
        const startedAt = this.#now();
        const dueAt = startedAt + Math.max(0, answerWaitMs);
        if (durable !== undefined) {
            const nextDurable = {
                ...durable,
                answerDueAt: dueAt,
                answerWaitStartedAt: startedAt,
            };
            await this.#persistence?.upsertDurableUserInput?.(ctx, nextDurable);
            Object.assign(durable, nextDurable);
        }
        if (answerWaitMs <= 0) {
            await this.#detachUserInput(ctx, requestId, "away", state);
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
                    void withWorkerContext(
                        "user-input-presence-timeout",
                        (workerCtx) =>
                            this.#detachUserInput(workerCtx, requestId, reason, currentState),
                        { sessionId: this.id },
                    ).catch(rethrowDatabaseFailure);
                } else {
                    void withWorkerContext(
                        "user-input-presence-timeout",
                        (workerCtx) =>
                            this.#detachRestoredUserInput(
                                workerCtx,
                                requestId,
                                reason,
                                currentState,
                            ),
                        { sessionId: this.id },
                    ).catch(rethrowDatabaseFailure);
                }
            },
            Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - this.#now())),
        );
        timer.unref?.();
        this.#userInputPresenceTimers.set(requestId, timer);
    }

    async #restoreUserInputPresenceTimers(ctx: Context): Promise<void> {
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
                const nextCall = {
                    ...call,
                    answerDueAt: dueAt,
                    answerWaitStartedAt: startedAt,
                };
                await this.#persistence?.upsertDurableUserInput?.(ctx, nextCall);
                Object.assign(call, nextCall);
            }
            this.#armUserInputPresenceTimer(
                call.request.requestId,
                dueAt,
                state,
                state.presence.answerWaitMs <= 0 ? "away" : "timeout",
            );
        }
    }

    async #applyPresenceToRestoredUserInput(
        ctx: Context,
        call: DurableUserInputCall,
        state: PresenceState,
    ): Promise<void> {
        this.#clearUserInputPresenceTimer(call.request.requestId);
        const answerWaitMs = state.presence.answerWaitMs;
        if (answerWaitMs === null) {
            const nextCall = { ...call };
            delete nextCall.answerDueAt;
            delete nextCall.answerWaitStartedAt;
            await this.#persistence?.upsertDurableUserInput?.(ctx, nextCall);
            Object.assign(call, nextCall);
            return;
        }
        const startedAt = this.#now();
        const dueAt = startedAt + Math.max(0, answerWaitMs);
        const nextCall = {
            ...call,
            answerDueAt: dueAt,
            answerWaitStartedAt: startedAt,
        };
        await this.#persistence?.upsertDurableUserInput?.(ctx, nextCall);
        Object.assign(call, nextCall);
        this.#armUserInputPresenceTimer(
            call.request.requestId,
            dueAt,
            state,
            answerWaitMs <= 0 ? "away" : "timeout",
        );
    }

    async #detachRestoredUserInput(
        ctx: Context,
        requestId: string,
        reason: "away" | "timeout",
        state: PresenceState,
    ): Promise<void> {
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
        const message = `Tool '${call.toolName}' is now owned by Agent Base.`;
        const result: ToolResultBlock = {
            display: message,
            failure: { kind: "execution_failed", message },
            isError: true,
            ...(call.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: call.providerToolCallId }),
            rendered: [{ text: message, type: "text" }],
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            type: "tool_result",
        };
        const nextCall = {
            ...call,
            detachedAt: this.#now(),
            result,
            status: "completed" as const,
        };
        await this.#persistence?.upsertDurableUserInput?.(ctx, nextCall);
        Object.assign(call, nextCall);
        await this.#append(ctx, "user_input_detached", {
            presenceId: state.presence.id,
            reason,
            requestId,
        });
    }

    async #detachUserInput(
        ctx: Context,
        requestId: string,
        reason: "away" | "timeout",
        state: PresenceState,
    ): Promise<void> {
        const pending = this.#pendingUserInputs.get(requestId);
        if (pending === undefined) return;
        this.#clearUserInputPresenceTimer(requestId);
        const durable = pending.durable;
        if (durable !== undefined && durable.status === "pending") {
            // The run no longer waits for this answer, so a restart must not replay it.
            const nextDurable = {
                ...durable,
                consumed: true,
                detachedAt: this.#now(),
            };
            await this.#persistence?.upsertDurableUserInput?.(ctx, nextDurable);
            Object.assign(durable, nextDurable);
        }
        await this.#append(ctx, "user_input_detached", {
            presenceId: state.presence.id,
            reason,
            requestId,
        });
        this.#pendingUserInputs.delete(requestId);
        if (pending.onAbort !== undefined) {
            pending.signal?.removeEventListener("abort", pending.onAbort);
        }
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
    async cancelUserInput(ctx: Context, requestId: string): Promise<CancelAskResult> {
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
        await this.#cancelDurableUserInput(ctx, durable);
        await this.#pruneDurableUserInputs(ctx);
        return { cancelled: true };
    }

    async answerUserInput(
        ctx: Context,
        requestId: string,
        response: AnswerUserInputRequest,
    ): Promise<ProtocolSession | undefined> {
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
        const normalizedResponse = { answers };
        const detached = durable?.detachedAt !== undefined;
        if (durable !== undefined) {
            const nextDurable = {
                ...durable,
                response: structuredClone(normalizedResponse),
                resolvedAt: this.#now(),
                status: "answered" as const,
            };
            await this.#persistence?.upsertDurableUserInput?.(ctx, nextDurable);
            Object.assign(durable, nextDurable);
        }
        await this.#append(ctx, "user_input_resolved", {
            answers,
            ...(response.mutationId === undefined ? {} : { mutationId: response.mutationId }),
            requestId,
            status: "answered",
        });
        if (pending !== undefined) {
            this.#pendingUserInputs.delete(requestId);
            if (pending.onAbort !== undefined) {
                pending.signal?.removeEventListener("abort", pending.onAbort);
            }
            pending.resolve({ status: "answered", ...normalizedResponse });
        } else if (detached && durable !== undefined) {
            // Nothing is waiting for this answer any more, so it arrives as a late notice instead.
            await this.#deliverDetachedAnswer(durable, answers);
        }
        return this.snapshot();
    }

    /**
     * Tells the agent about an answer that arrived after presence had already released the run.
     * The agent asked the question, so the late answer belongs in the conversation.
     */
    async #deliverDetachedAnswer(
        call: DurableUserInputCall,
        answers: Readonly<Record<string, readonly string[]>>,
    ): Promise<void> {
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
        this.#separateModelContextFromVisibleTranscript();
        this.#contextMessages?.push(message);
    }

    async markUserInputExecuting(ctx: Context, requestId: string): Promise<void> {
        const durable = this.#durableUserInputs.get(requestId);
        if (durable === undefined || durable.status !== "answered") return;
        const nextDurable = { ...durable, status: "executing" as const };
        await this.#persistence?.upsertDurableUserInput?.(ctx, nextDurable);
        Object.assign(durable, nextDurable);
    }

    createTask(ctx: Context, request: CreateTaskRequest): SessionTask {
        const task = this.#taskList.create(request);
        this.#recordTasksChanged(ctx);
        return task;
    }

    getTask(taskId: string): SessionTask | undefined {
        return this.#taskList.get(taskId);
    }

    listTasks(): readonly SessionTask[] {
        return this.#taskList.list();
    }

    updateTask(ctx: Context, taskId: string, request: UpdateTaskRequest): UpdateTaskResult {
        const result = this.#taskList.update(taskId, request);
        if (result.success && result.updatedFields.length > 0) this.#recordTasksChanged(ctx);
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

    async waitForWorkflow(
        ctx: Context,
        runId: string,
        signal?: AbortSignal,
    ): Promise<WorkflowRun | undefined> {
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

    launchWorkflow(ctx: Context, request: LaunchWorkflowRequest): WorkflowRun {
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
            withWorkerContext(
                "workflow",
                (workflowCtx) =>
                    request
                        .execute({
                            onAgentCall: () => {
                                state.agentCount += 1;
                                this.#recordWorkflowUpdate({ agentCount: state.agentCount, runId });
                            },
                            onAgentResult: async (index, result) => {
                                internal.agentCalls[index] = result;
                                await this.#saveSession(ctx);
                            },
                            onCheckpoint: async (checkpoint) => {
                                internal.checkpoint = checkpoint;
                                await this.#saveSession(ctx);
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
                                        ...(state.phase === undefined
                                            ? {}
                                            : { phase: state.phase }),
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
                        .finally(async () => {
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
                            await this.deliverNotification(workflowCtx, {
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
                        }),
                { runId, sessionId: this.id },
            );
        const execution = this.#taskDrain?.run(execute) ?? execute();
        void execution.catch(rethrowDatabaseFailure);
        return cloneWorkflowRun(state);
    }

    stopWorkflow(ctx: Context, runId: string): WorkflowRun | undefined {
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

    async emitCreatedEvent(ctx: Context): Promise<void> {
        await this.#append(ctx, "session_created", { session: this.snapshot() });
    }

    beginShutdown(ctx: Context): Promise<void> {
        if (this.#shutdownCleanup !== undefined) return this.#shutdownCleanup;
        this.#closing = true;
        for (const timer of this.#durableWaitTimers.values()) clearTimeout(timer);
        this.#durableWaitTimers.clear();
        for (const timer of this.#userInputPresenceTimers.values()) clearTimeout(timer);
        this.#userInputPresenceTimers.clear();
        const metadataCleanup = this.#clearMetadataSettlement(ctx);
        for (const workflow of this.#workflowRuns.values()) {
            if (workflow.state.status === "running") this.stopWorkflow(ctx, workflow.state.runId);
        }
        const activeRun = this.#activeRun;
        activeRun?.controller.abort();
        this.#shutdownCleanup = Promise.all([
            metadataCleanup,
            this.#killExecutionProcesses(ctx, { forceAfterMs: 5_000, includeBackground: true }),
        ]).then(() => undefined);
        return this.#shutdownCleanup;
    }

    /**
     * Records the archival and hands back the teardown it still owes. Aborting a run, closing a
     * runtime, and killing processes are not database work, so the caller runs them once the
     * archival has committed rather than while it holds the write lock.
     */
    async archiveForWorkspace(
        ctx: Context,
        workspaceId: string,
    ): Promise<(cleanupCtx: Context) => Promise<void>> {
        return await this.#runSessionMutation(ctx, (ctx) =>
            this.#archiveForWorkspaceMutation(ctx, workspaceId),
        );
    }

    async #archiveForWorkspaceMutation(
        ctx: Context,
        workspaceId: string,
    ): Promise<(cleanupCtx: Context) => Promise<void>> {
        if (this.#workspaceArchived) {
            return (_cleanupCtx) => this.#shutdownCleanup ?? Promise.resolve();
        }
        const activeRun = this.#activeRun;
        const runIds = new Set([
            ...(activeRun === undefined ? [] : [activeRun.runId]),
            ...(this.#restoredActiveRunId === undefined ? [] : [this.#restoredActiveRunId]),
        ]);
        for (const runId of runIds) {
            await Promise.all([
                this.#cancelDurableUserInputs(ctx, runId),
                this.#cancelDurableWaits(ctx, runId),
            ]);
        }
        this.#finishElapsedInterval();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#pendingSteeringMessages.clear();
        this.#pendingSteeringContinuations.clear();
        this.#suspendedRunIds.clear();
        this.#suspendOnAbort = false;
        await this.#pauseActiveGoal(ctx);
        this.#status = "archived";
        this.#archived = true;
        await this.#append(ctx, "session_workspace_archived", {
            reason: "workspace_archived",
            workspaceId,
        });
        this.#workspaceArchived = true;
        return (cleanupCtx) => {
            activeRun?.controller.abort();
            return this.beginShutdown(cleanupCtx);
        };
    }

    isClosing(): boolean {
        return this.#closing;
    }

    async markInterrupted(ctx: Context, interruption: SessionInterruption): Promise<void> {
        this.#finishElapsedInterval();
        this.#interruption = interruption;
        this.#status = "error";
        this.#activeRun?.controller.abort();
        if (!this.#closing) void this.#killExecutionProcesses(ctx);
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#pendingSteeringMessages.clear();
        this.#suspendedRunIds.clear();
        await this.#pauseActiveGoal(ctx);
        const interruptedRunIds =
            interruption.runId === undefined ? [] : [interruption.runId];
        const persistInterruption = async (ctx: Context) => {
            const uniqueRunIds = new Set(interruptedRunIds);
            for (const runId of uniqueRunIds) {
                await this.#commitStoppedPartialMessages(ctx, runId);
                await this.#append(ctx, "run_error", {
                    errorMessage: interruption.message,
                    modelLocked: this.#modelLocked(),
                    runId,
                    startupInterruption: true,
                });
            }
            if (uniqueRunIds.size > 0) this.#restartMetadataSettlement();
            await this.#saveSession(ctx);
        };
        if (this.#persistence?.transaction === undefined) await persistInterruption(ctx);
        else await this.#persistence.transaction(ctx, persistInterruption);
        // Keep the overlay attachable until the same visible row has become
        // immutable history. Clearing it before the durable handoff leaves a
        // fresh client with neither representation while interruption commits.
        this.#activePartial = undefined;
    }

    /**
     * Makes output the user already saw part of the immutable transcript before
     * a stopped run is closed. Partial rows normally belong only to the live
     * overlay, but an abort or daemon interruption may never receive a provider
     * final message to replace them.
     */
    async #commitStoppedPartialMessages(ctx: Context, runId: string): Promise<void> {
        const partials = this.#messages.filter(
            (entry) =>
                entry.isPartial &&
                entry.runId === runId &&
                entry.message.role === "agent" &&
                entry.message.blocks.length > 0,
        );
        for (const entry of partials) {
            await this.#storeMessage(ctx, entry.position, entry.message, false, runId);
            await this.#append(ctx, "agent_message", { message: entry.message, runId });
        }
    }

    async markSuspendedAfterRestart(ctx: Context, message: string, runId?: string): Promise<void> {
        if (!this.isSubagent() || this.#status !== "suspended") {
            throw new Error("Only a suspended subagent can be repaired as resumable.");
        }
        this.#finishElapsedInterval();
        this.#activeRun?.controller.abort();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#suspendOnAbort = false;
        if (runId !== undefined) {
            await this.#append(ctx, "run_error", {
                errorMessage: message,
                modelLocked: this.#modelLocked(),
                runId,
                startupInterruption: true,
            });
        }
        this.#status = "suspended";
        await this.#saveSession(ctx);
    }

    async recordSubagentStoppedAfterRestart(
        ctx: Context,
        subagent: SubagentSummary,
        path: string,
    ): Promise<void> {
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
        await this.#storeMessage(ctx, this.#nextMessagePosition(), message, false, runId);
        this.#contextMessages?.push(message);
        this.#lastMessageAt = this.#now();
        await this.#append(ctx, "message_submitted", {
            displayText,
            message,
            runId,
            source: "notification",
        });
        await this.#saveSession(ctx);
    }

    async reset(ctx: Context): Promise<ProtocolSession> {
        this.#shellHistoryRevision += 1;
        await this.#clearMetadataSettlement(ctx);
        const activeRunId = this.#activeRun?.runId;
        await this.abort(ctx, { stopDescendants: false });
        await Promise.allSettled(this.#shellCommandCompletions.values());
        if (activeRunId !== undefined) await this.waitForRun(ctx, activeRunId);
        await this.#draining?.catch(rethrowDatabaseFailure);
        const workflowRuns = [...this.#workflowRuns.values()];
        for (const run of workflowRuns) {
            if (run.state.status === "running") this.stopWorkflow(ctx, run.state.runId);
        }
        await Promise.all(workflowRuns.map((run) => run.completion));
        this.#workflowRuns.clear();
        // A reset throws away the conversation that knew its task ids. Make
        // sure no commands remain even when there was no active run to abort.
        await this.#killExecutionProcesses(ctx, { includeBackground: true });
        this.#executionContext = undefined;
        this.#processManager = undefined;
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
        const commitReset = async (ctx: Context) => {
            await this.#persistence?.clearMessages(ctx, this.id);
            if (hadTasks) this.#recordTasksChanged(ctx);
            if (hadGoal) await this.#append(ctx, "goal_changed", { goal: null });
            await this.#append(ctx, "session_reset", {
                snapshot: this.#agentSnapshot(),
                transcript: await this.transcriptWindow(ctx),
            });
        };
        if (this.#persistence?.transaction === undefined) await commitReset(ctx);
        else await this.#persistence.transaction(ctx, commitReset);
        return this.snapshot();
    }

    async rewind(ctx: Context, messageId: string): Promise<RewindSessionResponse> {
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be rewound.");
        }
        if (this.#activeRun !== undefined) {
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
        // Naming in flight is reading a transcript that is about to lose turns, and closing the
        // runtime below would fail its request. Cancelling first keeps that from counting against
        // the chat as a naming failure.
        await this.#clearMetadataSettlement(ctx);
        void this.#killExecutionProcesses(ctx, { includeBackground: true });
        this.#executionContext = undefined;
        this.#processManager = undefined;
        this.#mcpServers = [];
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
        const commitRewind = async (ctx: Context) => {
            await this.#persistence?.deleteMessagesFrom(ctx, this.id, target.position);
            await this.#append(ctx, "session_rewound", {
                messageId,
                snapshot: this.#agentSnapshot(),
                transcript: await this.transcriptWindow(ctx),
            });
        };
        if (this.#persistence?.transaction === undefined) await commitRewind(ctx);
        else await this.#persistence.transaction(ctx, commitRewind);
        this.#restartMetadataSettlement();
        return { message: target.message, session: this.snapshot() };
    }

    isSubagent(): boolean {
        return this.#agentMetadata.type === "subagent";
    }

    async markRead(ctx: Context): Promise<boolean> {
        if (this.isSubagent() || this.#unread === undefined) return false;
        return await this.#runSessionMutation(ctx, async (ctx) => {
            if (this.isSubagent() || this.#unread === undefined) return false;
            this.#unread = undefined;
            await this.#append(ctx, "session_updated", { session: this.clientSnapshot() });
            return true;
        });
    }

    recordSubagentChanged(subagent: SubagentSummary): void {
        void withWorkerContext(
            "subagent-changed",
            (workerCtx) =>
                this.#afterTransactionCommit(workerCtx, async () => {
                    await this.#append(workerCtx, "subagent_changed", { subagent });
                    this.#restartMetadataSettlement();
                }),
            { sessionId: this.id },
        ).catch(rethrowDatabaseFailure);
    }

    recordDescendantActivity(): void {
        this.#restartMetadataSettlement();
    }

    recordUserActivity(): void {
        this.#restartMetadataSettlement();
    }

    async recordMutationApplied(ctx: Context, mutationId: string | undefined): Promise<void> {
        if (mutationId !== undefined) await this.#append(ctx, "mutation_applied", { mutationId });
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
        return sourceMessages;
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

    async externalControlContext(ctx: Context): Promise<AgentContext> {
        return await this.#ensureExecutionContext(ctx);
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
    async transcriptWindow(
        ctx: Context,
        turnLimit: number = SESSION_STREAM_TURN_LIMIT,
    ): Promise<SessionTranscriptWindow> {
        // No anchor is given, so the newest turns always exist to return.
        return (await this.transcriptPage(ctx, turnLimit)) as SessionTranscriptWindow;
    }

    /**
     * The turns immediately before `before`, or the newest turns without it.
     *
     * Undefined when the anchor is a run the transcript no longer has, which a
     * caller has to tell apart from an empty page: one means the conversation
     * moved under them, the other that they have reached the beginning.
     */
    async transcriptPage(
        ctx: Context,
        turnLimit: number = SESSION_STREAM_TURN_LIMIT,
        before?: string,
    ): Promise<SessionTranscriptWindow | undefined> {
        const earlierCount =
            before === undefined
                ? this.#transcriptRunOrder.length
                : this.#transcriptRunIndexes.get(before);
        if (earlierCount === undefined || (earlierCount === 0 && this.#transcriptHasEarlier)) {
            return await this.#persistence?.loadTranscriptPage?.(ctx, this.id, turnLimit, before);
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
            return await this.#persistence.loadTranscriptPage(ctx, this.id, turnLimit, before);
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
        return window === undefined
            ? undefined
            : {
                  ...window,
                  complete: !this.#transcriptHasEarlier && keptRunIds.length === earlierCount,
                  ...(noticeSlice.truncated ? { noticesTruncated: true } : {}),
                  ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
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
    async transcriptSince(
        ctx: Context,
        after: EventId,
        turnLimit: number = SESSION_STREAM_TURN_LIMIT,
    ): Promise<SessionTranscriptWindow | undefined> {
        // Persistent sessions can page from anchors older than the bounded
        // in-memory window. Ask storage first so a months-old client position
        // cannot turn into an undetected hole between held and recent turns.
        if (this.#persistence?.loadTranscriptSince !== undefined) {
            return await this.#persistence.loadTranscriptSince(ctx, this.id, turnLimit, after);
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
        return {
            ...window,
            // Whether this page reaches the newest turn, so a client knows if it
            // must ask again to finish catching up.
            complete: first + keptRunIds.length === runIds.length,
            ...(noticeSlice.truncated ? { noticesTruncated: true } : {}),
            ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
        };
    }

    /**
     * Records the Git state of the session's directory and reports it to
     * attached clients.
     *
     * The snapshot is versioned by the tracker, so an older or repeated delivery
     * is dropped rather than published as news.
     */
    async recordGitState(ctx: Context, git: GitChangeSnapshot): Promise<void> {
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
        await this.#append(ctx, "session_git_changed", { git });
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
            this.#compactionRunId;
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

    async refreshGitCommandSecret(ctx: Context): Promise<void> {
        await this.#syncGitCommandSecret();
    }

    snapshot(): ProtocolSession {
        return this.#protocolSnapshot(this.#agentSnapshot());
    }

    /**
     * Current client-visible state without model context or historical messages.
     *
     * Conversation history is delivered by the bounded transcript window. Keeping
     * this projection independent from `snapshot()` prevents opening a large chat
     * from walking the complete model transcript merely to throw it away.
     */
    clientSnapshot(options: { includeTools?: boolean } = {}): ProtocolSession {
        return this.#protocolSnapshot({
            id: this.#agentId,
            providerId: this.#providerId,
            modelId: this.#modelId,
            status: this.#agentStatus(),
            messages: [],
            queue: [],
            tools: options.includeTools === true ? this.#tools : [],
            ...(this.#effort === undefined ? {} : { effort: this.#effort }),
            ...(this.#serviceTier === undefined ? {} : { serviceTier: this.#serviceTier }),
        });
    }

    #protocolSnapshotForAgentConfiguration(input: {
        effort?: string;
        modelId: string;
        models: readonly Model[];
        permissionMode: PermissionMode;
        providerId: string;
        serviceTier?: ServiceTier;
    }): ProtocolSession {
        const agentSnapshot = this.#agentSnapshot();
        const targetAgentSnapshot: AgentSnapshot = {
            ...agentSnapshot,
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
            modelId: input.modelId,
            providerId: input.providerId,
        };
        const target = this.#protocolSnapshot(targetAgentSnapshot);
        return {
            ...target,
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
            modelId: input.modelId,
            models: input.models,
            permissionMode: input.permissionMode,
            providerId: input.providerId,
            snapshot: targetAgentSnapshot,
        };
    }

    #applyProjectedAgentConfiguration(
        configuration: RigAgentConfiguration,
        permissionMode: PermissionMode,
        modelChanged: boolean,
    ): void {
        this.#providerId = configuration.providerId;
        this.#modelId = configuration.modelId;
        this.#models = this.#modelsForProvider(configuration.providerId);
        this.#credentialBindingId = this.#providerBindingId(configuration.providerId);
        this.#effort = configuration.effort;
        this.#serviceTier = configuration.serviceTier;
        this.#permissionMode = permissionMode;
        this.#interruption = undefined;
        if (modelChanged) this.#totalTokens = 0;
    }

    #protocolSnapshot(snapshot: AgentSnapshot): ProtocolSession {
        const lastEventId = this.events.lastEventId();
        const activeTurn = this.#activeTurn();
        return {
            id: this.id,
            activity: this.activity(),
            ...(activeTurn === undefined ? {} : { activeTurn }),
            agentId: this.#agentId,
            ownerInstanceId: this.#ownerInstanceId,
            ...(this.#profileId === undefined ? {} : { profileId: this.#profileId }),
            ...(this.#git === undefined ? {} : { git: structuredClone(this.#git) }),
            archived: this.#archived,
            scope: { ...this.#scope },
            ...scopeConvenienceFields(this.#scope),
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
            modelCatalog: this.#modelCatalog,
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
            backgroundProcesses: this.#executionContext?.bash.activeSessions?.() ?? [],
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            ...(this.#usage.totalTokens === 0
                ? {}
                : { cumulativeUsage: structuredClone(this.#usage) }),
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
            ownerInstanceId: this.#ownerInstanceId,
            ...(this.#profileId === undefined ? {} : { profileId: this.#profileId }),
            scope: { ...this.#scope },
            ...scopeConvenienceFields(this.#scope),
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
        const pendingContextIds = new Set(this.#pendingContextMessages.keys());
        const contextMessages = (this.#contextMessages ?? this.#committedMessages())
            .filter((message) => !isExcludedFromModelContext(message))
            .filter((message) => !pendingContextIds.has(message.id));
        const usageSummary = structuredClone(this.usage());
        const usageSummaryEventId = this.events.lastEventId();
        const state: PersistedSessionState = {
            ...(this.#activeSince === undefined ? {} : { activeSince: this.#activeSince }),
            agent: this.agentMetadata(),
            agentId: this.#agentId,
            credentialBindingId: this.#credentialBindingId,
            ownerInstanceId: this.#ownerInstanceId,
            ...(this.#profileId === undefined ? {} : { profileId: this.#profileId }),
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
            scope: { ...this.#scope },
            ...(this.#unsortedSince === undefined ? {} : { unsortedSince: this.#unsortedSince }),
            workspaceTransfer: structuredClone(this.#workspaceTransfer),
            secretIds: this.#secrets.sessionIds(),
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
            durableUserInputs: [...this.#durableUserInputs.values()].map((call) =>
                structuredClone(call),
            ),
            durableWaits: [...this.#durableWaits.values()].map((wait) => structuredClone(wait)),
            scheduledMessages: this.scheduledMessages(),
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

    async submitContext(
        ctx: Context,
        request: SubmitContextMessageRequest,
    ): Promise<SubmitContextMessageResponse> {
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

        const apply = async (ctx: Context): Promise<SubmitContextMessageResponse> => {
            await this.setArchived(ctx, false);
            const messageId = request.clientSubmissionId ?? createId();
            const anchorRunId = `context:${messageId}`;
            const createdAt = this.#now();
            const position = this.#nextMessagePosition();
            const message: UserMessage = {
                blocks: [{ text: request.text, type: "text" }],
                contextOnly: true,
                id: messageId,
                identity: request.identity ?? null,
                role: "user",
            };
            const pending: PersistedPendingContextMessage = {
                anchorRunId,
                createdAt,
                message,
                position,
            };
            this.#separateModelContextFromVisibleTranscript();
            await this.#storeMessage(ctx, position, message, false, anchorRunId);
            await this.#persistence?.insertPendingContextMessage?.(ctx, this.id, pending);
            this.#pendingContextMessages.set(messageId, pending);
            this.#lastMessageAt = createdAt;
            const event = await this.#append(ctx, "message_submitted", {
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
            ? await apply(ctx)
            : await this.#persistence.transaction(ctx, apply);
    }

    async submit(
        _ctx: Context,
        _request: SessionSubmitMessageRequest,
        _options: { source?: "notification" } = {},
    ): Promise<SubmitMessageResponse> {
        throw new Error("Agent messages are owned by Agent Base.");
    }

    async steer(
        _ctx: Context,
        _request: SteerMessageRequest,
    ): Promise<SteerMessageResponse> {
        throw new Error("Agent steering is owned by Agent Base.");
    }

    async deliverNotification(
        _ctx: Context,
        _request: SubmitMessageRequest,
    ): Promise<SubmitMessageResponse | SteerMessageResponse> {
        throw new Error("Agent notifications are owned by Agent Base.");
    }

    async deliverAgentMessage(_ctx: Context, _message: UserMessage): Promise<void> {
        throw new Error("Agent messages are owned by Agent Base.");
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

    async waitForRun(ctx: Context, runId: string): Promise<SessionRunCompletion> {
        const completed = this.#completionForRun(runId);
        const completion =
            completed ??
            (await new Promise<SessionRunCompletion>((resolve) => {
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
            }));
        let ownsCommitLock = false;
        try {
            await ctx.span("rig.session.wait_for_run_commit", (waitCtx) =>
                this.#commitEventLock.runInLock(waitCtx, async () => {}),
            );
        } catch (error) {
            if (!isAsyncLockReentryError(error)) throw error;
            ownsCommitLock = true;
        }
        // A waiter called from the commit callback is already at the terminal boundary. Waiting
        // for its own queue drain would recurse through the same work and stall permanently.
        if (ownsCommitLock) return completion;
        const draining = this.#draining;
        if (draining !== undefined) await draining;
        return completion;
    }

    async waitDurably(
        ctx: Context,
        request: DurableWaitRequest,
        signal?: AbortSignal,
    ): Promise<WaitResult> {
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
            await this.#persistence?.upsertDurableWait?.(ctx, wait);
            this.#durableWaits.set(wait.id, wait);
            this.#armDurableWait(wait);
            await this.#refreshWaitActivity(ctx);
        }
        if (wait.dueAt <= this.#now()) {
            const settled = await this.#settleDurableWait(ctx, wait, false);
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

    async #cancelDurableUserInput(ctx: Context, call: DurableUserInputCall): Promise<void> {
        // A detached question is consumed by its run but still open to the user, so it can be
        // withdrawn.
        if (call.status === "cancelled" || (call.consumed && !isOpenQuestion(call))) return;
        const nextCall = { ...call, resolvedAt: this.#now(), status: "cancelled" as const };
        await this.#persistence?.upsertDurableUserInput?.(ctx, nextCall);
        Object.assign(call, nextCall);
        await this.#append(ctx, "user_input_resolved", {
            requestId: call.request.requestId,
            status: "cancelled",
        });
    }

    async #cancelDurableUserInputs(ctx: Context, runId: string): Promise<void> {
        for (const call of this.#durableUserInputs.values()) {
            if (call.runId === runId && !call.consumed)
                await this.#cancelDurableUserInput(ctx, call);
        }
        await this.#pruneDurableUserInputs(ctx);
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
            void withWorkerContext(
                "durable-wait-timer",
                (workerCtx) => this.#settleDurableWait(workerCtx, current, false),
                { sessionId: this.id },
            ).catch(rethrowDatabaseFailure);
        }, delay);
        this.#durableWaitTimers.set(wait.id, timer);
    }

    async #settleDurableWait(
        ctx: Context,
        wait: DurableWait,
        interrupted: boolean,
    ): Promise<WaitResult | undefined> {
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
        await this.#persistence?.upsertDurableWait?.(ctx, next);
        this.#durableWaits.set(next.id, next);
        const timer = this.#durableWaitTimers.get(next.id);
        if (timer !== undefined) clearTimeout(timer);
        this.#durableWaitTimers.delete(next.id);
        await this.#refreshWaitActivity(ctx);
        const waiter = this.#durableWaitWaiters.get(next.id);
        if (waiter !== undefined) {
            this.#durableWaitWaiters.delete(next.id);
            waiter.resolve(result);
        }
        return result;
    }

    async #interruptDurableWaits(ctx: Context): Promise<void> {
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        if (runId === undefined) return;
        for (const wait of this.#durableWaits.values()) {
            if (wait.runId === runId && wait.status === "waiting") {
                await this.#settleDurableWait(ctx, wait, true);
            }
        }
    }

    async #cancelDurableWaits(ctx: Context, runId: string): Promise<void> {
        for (const current of this.#durableWaits.values()) {
            if (current.runId !== runId || current.status !== "waiting") continue;
            const next: DurableWait = { ...current, status: "cancelled" };
            await this.#persistence?.upsertDurableWait?.(ctx, next);
            this.#durableWaits.set(next.id, next);
            const timer = this.#durableWaitTimers.get(next.id);
            if (timer !== undefined) clearTimeout(timer);
            this.#durableWaitTimers.delete(next.id);
            const waiter = this.#durableWaitWaiters.get(next.id);
            if (waiter !== undefined) {
                await this.#afterTransactionCommit(ctx, () => {
                    if (this.#durableWaitWaiters.get(next.id) !== waiter) return;
                    this.#durableWaitWaiters.delete(next.id);
                    waiter.reject(new Error("The durable wait was cancelled."));
                });
            }
        }
        await this.#refreshWaitActivity(ctx);
        await this.#pruneDurableWaits(ctx);
    }

    async #refreshWaitActivity(ctx: Context, publish = true): Promise<void> {
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
            await this.#append(ctx, "session_activity_changed", { activity: next });
        } finally {
            this.#reportingActivity = false;
        }
    }

    async #pruneDurableUserInputs(ctx: Context): Promise<void> {
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
        await this.#persistence?.pruneDurableUserInputs?.(
            ctx,
            this.id,
            MAX_RETAINED_DURABLE_USER_INPUTS,
        );
        for (const call of eligible.slice(MAX_RETAINED_DURABLE_USER_INPUTS)) {
            this.#durableUserInputs.delete(call.request.requestId);
        }
    }

    async #pruneDurableWaits(ctx: Context): Promise<void> {
        const eligible = [...this.#durableWaits.values()]
            .filter((wait) => wait.status === "cancelled" || wait.consumed)
            .sort(
                (left, right) =>
                    (right.result?.endedAt ?? right.createdAt) -
                        (left.result?.endedAt ?? left.createdAt) ||
                    right.toolCallIndex - left.toolCallIndex,
            );
        await this.#persistence?.pruneDurableWaits?.(ctx, this.id, MAX_RETAINED_DURABLE_WAITS);
        for (const wait of eligible.slice(MAX_RETAINED_DURABLE_WAITS)) {
            this.#durableWaits.delete(wait.id);
        }
    }

    async #pruneScheduledMessages(ctx: Context): Promise<void> {
        const prune = async (ctx: Context): Promise<void> => {
            const removed = await (this.#persistence?.pruneScheduledMessages?.(
                ctx,
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
                    .map((message) => message.id));
            if (removed.length === 0) return;
            for (const messageId of removed) this.#scheduledMessages.delete(messageId);
            await this.#append(ctx, "scheduled_messages_pruned", { messageIds: removed });
        };
        if (this.#persistence?.transaction === undefined) {
            await prune(ctx);
            return;
        }
        await this.#persistence.transaction(ctx, prune);
    }

    #agentSnapshot(): AgentSnapshot {
        const contextMessages = this.#contextMessages;
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
            queue: [],
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
            ...(this.#lastSessionRunId === undefined ? {} : { lastRunId: this.#lastSessionRunId }),
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

    #recordTasksChanged(ctx: Context): void {
        void this.#append(ctx, "tasks_changed", { tasks: this.listTasks() }).catch(
            rethrowDatabaseFailure,
        );
    }

    async #append<TType extends SessionEvent["type"]>(
        ctx: Context,
        type: TType,
        data: Extract<SessionEvent, { type: TType }>["data"],
    ): Promise<Extract<SessionEvent, { type: TType }>> {
        return await this.#commitEvent(ctx, {
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

    async #commitEvent<TEvent extends SessionEvent>(ctx: Context, event: TEvent): Promise<TEvent> {
        if (this.#workspaceArchived) return event;
        return await this.#runSessionMutation(ctx, async (ctx) => {
            await this.#appendDurableEvent(ctx, event);
            return event;
        });
    }

    async #runSessionMutation<T>(ctx: Context, body: (ctx: Context) => Promise<T>): Promise<T> {
        const inTransaction = sessionCommitStorage.getStore() === this;
        const run = async (runCtx: Context): Promise<T> => {
            const checkpoint = this.#captureEventCommitCheckpoint();
            try {
                return await body(runCtx);
            } catch (error) {
                this.#restoreEventCommitCheckpoint(checkpoint);
                throw error;
            }
        };
        if (inTransaction) return await run(ctx);
        const runInCommitLock = (lockCtx: Context): Promise<T> => {
            return this.#commitEventLock.runInLock(lockCtx, (ownedCtx) =>
                sessionCommitStorage.run(this, () => run(ownedCtx)),
            );
        };
        if (this.#persistence?.transaction === undefined) return await runInCommitLock(ctx);

        // The session lock protects only the transaction's in-memory and SQL mutation. The
        // transaction wrapper commits and runs observers after this callback returns, so
        // cross-session notifications never execute while this session still owns its lock.
        return await this.#persistence.transaction(ctx, runInCommitLock);
    }

    #captureEventCommitCheckpoint(): SessionEventCommitCheckpoint {
        return {
            activePartial:
                this.#activePartial === undefined
                    ? undefined
                    : structuredClone(this.#activePartial),
            activeRun: this.#activeRun,
            activeSince: this.#activeSince,
            appendSystemPrompt: this.#appendSystemPrompt,
            activity: structuredClone(this.#activity),
            archived: this.#archived,
            cachedUsageEventRevision: this.#cachedUsageEventRevision,
            cachedUsageSummaryRevision: this.#cachedUsageSummaryRevision,
            eventLog: this.events.checkpoint(),
            draft: this.#draft,
            draftUpdatedAt: this.#draftUpdatedAt,
            elapsedMs: this.#elapsedMs,
            durableUserInputs: new Map(
                [...this.#durableUserInputs].map(([id, call]) => [id, structuredClone(call)]),
            ),
            durableWaits: new Map(
                [...this.#durableWaits].map(([id, wait]) => [id, structuredClone(wait)]),
            ),
            goal: this.#goal === undefined ? undefined : { ...this.#goal },
            interruption:
                this.#interruption === undefined ? undefined : structuredClone(this.#interruption),
            lastMessageAt: this.#lastMessageAt,
            ownedUsageEventRevision: this.#ownedUsageEventRevision,
            permissionReviews: new Map(
                [...this.#permissionReviews].map(([id, review]) => [id, structuredClone(review)]),
            ),
            restoredActiveRunId: this.#restoredActiveRunId,
            reportedStatus: this.#reportedStatus,
            reportingActivity: this.#reportingActivity,
            reportingStatus: this.#reportingStatus,
            runFacts: new Map(
                [...this.#runFacts].map(([id, facts]) => [id, structuredClone(facts)]),
            ),
            metadataFailures: this.#metadataFailures,
            metadataInitialAttempted: this.#metadataInitialAttempted,
            metadataNamed: this.#metadataNamed,
            metadataNamingAttempted: this.#metadataNamingAttempted,
            metadataRefinementAttempted: this.#metadataRefinementAttempted,
            metadataRunId: this.#metadataRunId,
            metadataUpdatedAt: this.#metadataUpdatedAt,
            orderKey: this.#orderKey,
            pendingSteeringContinuations: new Map(
                [...this.#pendingSteeringContinuations].map(([id, continuation]) => [
                    id,
                    continuation,
                ]),
            ),
            pendingSteeringMessages: new Map(
                [...this.#pendingSteeringMessages].map(([id, message]) => [
                    id,
                    structuredClone(message),
                ]),
            ),
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            status: this.#status,
            suspendedRunIds: new Set(this.#suspendedRunIds),
            suspendOnAbort: this.#suspendOnAbort,
            recap: this.#recap,
            title: this.#title,
            titleError: this.#titleError,
            titleStatus: this.#titleStatus,
            unread: this.#unread === undefined ? undefined : { ...this.#unread },
            usageEventsAfterBase: [...this.#usageEventsAfterBase],
            usageSummaryCache:
                this.#usageSummaryCache === undefined
                    ? undefined
                    : structuredClone(this.#usageSummaryCache),
            usageSummaryRevision: this.#usageSummaryRevision,
            workspaceArchived: this.#workspaceArchived,
        };
    }

    captureMutationCheckpoint(): SessionEventCommitCheckpoint {
        return this.#captureEventCommitCheckpoint();
    }

    restoreMutationCheckpoint(checkpoint: SessionEventCommitCheckpoint): void {
        this.#restoreEventCommitCheckpoint(checkpoint);
    }

    #restoreEventCommitCheckpoint(checkpoint: SessionEventCommitCheckpoint): void {
        this.events.restore(checkpoint.eventLog);
        this.#activePartial =
            checkpoint.activePartial === undefined
                ? undefined
                : structuredClone(checkpoint.activePartial);
        this.#activeRun = checkpoint.activeRun;
        this.#activeSince = checkpoint.activeSince;
        this.#appendSystemPrompt = checkpoint.appendSystemPrompt;
        this.#activity = structuredClone(checkpoint.activity);
        this.#archived = checkpoint.archived;
        this.#cachedUsageEventRevision = checkpoint.cachedUsageEventRevision;
        this.#cachedUsageSummaryRevision = checkpoint.cachedUsageSummaryRevision;
        this.#ownedUsageEventRevision = checkpoint.ownedUsageEventRevision;
        this.#draft = checkpoint.draft;
        this.#draftUpdatedAt = checkpoint.draftUpdatedAt;
        this.#elapsedMs = checkpoint.elapsedMs;
        this.#durableUserInputs = new Map(
            [...checkpoint.durableUserInputs].map(([id, call]) => [id, structuredClone(call)]),
        );
        this.#durableWaits = new Map(
            [...checkpoint.durableWaits].map(([id, wait]) => [id, structuredClone(wait)]),
        );
        this.#goal = checkpoint.goal === undefined ? undefined : { ...checkpoint.goal };
        this.#interruption =
            checkpoint.interruption === undefined
                ? undefined
                : structuredClone(checkpoint.interruption);
        this.#lastMessageAt = checkpoint.lastMessageAt;
        this.#permissionReviews = new Map(
            [...checkpoint.permissionReviews].map(([id, review]) => [id, structuredClone(review)]),
        );
        this.#restoredActiveRunId = checkpoint.restoredActiveRunId;
        this.#reportedStatus = checkpoint.reportedStatus;
        this.#reportingActivity = checkpoint.reportingActivity;
        this.#reportingStatus = checkpoint.reportingStatus;
        this.#runFacts = new Map(
            [...checkpoint.runFacts].map(([id, facts]) => [id, structuredClone(facts)]),
        );
        this.#metadataFailures = checkpoint.metadataFailures;
        this.#metadataInitialAttempted = checkpoint.metadataInitialAttempted;
        this.#metadataNamed = checkpoint.metadataNamed;
        this.#metadataNamingAttempted = checkpoint.metadataNamingAttempted;
        this.#metadataRefinementAttempted = checkpoint.metadataRefinementAttempted;
        this.#metadataRunId = checkpoint.metadataRunId;
        this.#metadataUpdatedAt = checkpoint.metadataUpdatedAt;
        this.#orderKey = checkpoint.orderKey;
        this.#pendingSteeringContinuations = new Map(checkpoint.pendingSteeringContinuations);
        this.#pendingSteeringMessages = new Map(
            [...checkpoint.pendingSteeringMessages].map(([id, message]) => [
                id,
                structuredClone(message),
            ]),
        );
        this.#sessionTokenCount = structuredClone(checkpoint.sessionTokenCount);
        this.#status = checkpoint.status;
        this.#suspendedRunIds = new Set(checkpoint.suspendedRunIds);
        this.#suspendOnAbort = checkpoint.suspendOnAbort;
        this.#recap = checkpoint.recap;
        this.#title = checkpoint.title;
        this.#titleError = checkpoint.titleError;
        this.#titleStatus = checkpoint.titleStatus;
        this.#unread = checkpoint.unread === undefined ? undefined : { ...checkpoint.unread };
        this.#usageEventsAfterBase = [...checkpoint.usageEventsAfterBase];
        this.#usageSummaryCache =
            checkpoint.usageSummaryCache === undefined
                ? undefined
                : structuredClone(checkpoint.usageSummaryCache);
        this.#usageSummaryRevision = checkpoint.usageSummaryRevision;
        this.#workspaceArchived = checkpoint.workspaceArchived;
        for (const timer of this.#durableWaitTimers.values()) clearTimeout(timer);
        this.#durableWaitTimers.clear();
        this.#restoreDurableWaitTimers();
    }

    async #afterTransactionCommit(
        ctx: Context,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ): Promise<void> {
        if (this.#persistence?.afterTransactionCommit === undefined) {
            await callback(ctx);
            return;
        }
        await this.#persistence.afterTransactionCommit(ctx, callback);
    }

    /**
     * Records what a provider said about the account while it was answering
     * this session. It cost no extra request, so it is the freshest quota a
     * client can be shown.
     */
    #recordObservedProviderUsage(usage: ProviderUsage): void {
        void withWorkerContext(
            "provider-usage-observed",
            (workerCtx) =>
                this.#append(workerCtx, "provider_quota_observed", {
                    providerId: usage.providerId,
                    quota: providerUsageToClaudeQuota(usage, this.#now()),
                }),
            { sessionId: this.id },
        ).catch(rethrowDatabaseFailure);
    }

    async #appendDurableEvent(ctx: Context, event: SessionEvent, persist = true): Promise<void> {
        const previousSessionTokenCount = this.#sessionTokenCount;
        // Terminal-event subscribers may synchronously read the transcript. Project facts before
        // publishing so waitForRun and transcriptWindow observe one completion boundary.
        this.#recordRunFacts(event);
        if (persist) await this.events.append(ctx, event);
        else await this.events.appendProjected(ctx, event);
        if (!this.isSubagent() && this.#request.trackUnread === true) {
            this.#unread = sessionUnreadStateAfterEvent(this.#unread, event);
        }
        this.#sessionTokenCount =
            sessionTokenCountAfterEvent(this.#sessionTokenCount, event) ??
            previousSessionTokenCount;
        if (affectsSessionUsage(event)) {
            this.#usageSummaryRevision += 1;
            if (this.#persistedUsageBase !== undefined) this.#usageEventsAfterBase.push(event);
            this.#ownedUsageEventRevision = this.events.usageRevision();
        }
        if (!isTransientInferenceSessionEvent(event)) await this.#saveSession(ctx);
        this.#recordPermissionReview(event);
        await this.#reportContextSize(ctx, previousSessionTokenCount);
        await this.#reportActivity(ctx, event);
    }

    /**
     * Publishes current context or cumulative usage when either changes.
     *
     * Rig already recomputes both on every event, so reporting them costs
     * nothing and saves every client a polling loop.
     */
    async #reportContextSize(ctx: Context, previous: SessionTokenCount): Promise<void> {
        if (this.#reportingActivity) return;
        if (
            this.#sessionTokenCount.lastContextTokens === previous.lastContextTokens &&
            this.#sessionTokenCount.totalTokens === previous.totalTokens
        ) {
            return;
        }
        this.#reportingActivity = true;
        try {
            await this.#append(ctx, "session_context_changed", {
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

    async #reportActivity(ctx: Context, event: SessionEvent): Promise<void> {
        if (this.#reportingActivity || event.type === "session_activity_changed") return;
        const previousActivity = this.#activity;
        const activity = sessionActivityAfterEvent(previousActivity, event);
        if (activity === previousActivity) return;
        this.#reportingActivity = true;
        try {
            await this.#append(ctx, "session_activity_changed", { activity });
            if (this.#activity === previousActivity) this.#activity = activity;
        } finally {
            this.#reportingActivity = false;
        }
    }

    #recordWorkflowUpdate(update: WorkflowRunUpdate): void {
        void withWorkerContext(
            "workflow-update",
            async (workerCtx) => {
                await this.#append(workerCtx, "workflow_changed", { update });
                this.#restartMetadataSettlement();
            },
            { sessionId: this.id },
        ).catch(rethrowDatabaseFailure);
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

    /** The folder tree handed to this session's tools, with this chat as the one being filed. */
    async #folderContext(ctx: Context): Promise<FolderContext> {
        const folders = this.#folderRepository();
        return {
            create: async (request) => await folders.createFolder(ctx, request),
            list: async () => await folders.listFolders(ctx),
            move: async (folderId, request) =>
                requireFolder(await folders.moveFolder(ctx, folderId, request)),
            setCurrentChatFolder: async (folderId) => await this.fileIntoFolder(ctx, folderId),
            update: async (folderId, request) =>
                requireFolder(await folders.updateFolder(ctx, folderId, request)),
        };
    }

    #folderRepository(): FolderRepository {
        const folders = this.#folders;
        if (folders === undefined) {
            throw new Error("Folders are unavailable in this session.");
        }
        return folders;
    }

    async #folderScopeInstruction(ctx: Context): Promise<string | undefined> {
        if (this.#scope.kind === "unsorted") {
            return [
                "This chat is currently in Unsorted.",
                `Its private physical working directory is ${JSON.stringify(this.#request.cwd)}.`,
                "File it into a suitable folder once its purpose is clear.",
            ].join("\n");
        }
        if (this.#scope.kind !== "folder") return undefined;
        const folders = await this.#folderRepository().listFolders(ctx);
        const byId = new Map(folders.map((folder) => [folder.id, folder]));
        const current = byId.get(this.#scope.folderId);
        if (current === undefined) throw new Error("This chat's folder is no longer available.");
        const physicalPath = await this.#folderRepository().activeFolderStoragePath(
            ctx,
            current.id,
        );
        const ancestry: string[] = [];
        const seen = new Set<string>();
        let cursor: Folder | undefined = current;
        while (cursor !== undefined && !seen.has(cursor.id)) {
            ancestry.unshift(cursor.name);
            seen.add(cursor.id);
            cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
        }
        return [
            `This chat belongs to the virtual folder ${JSON.stringify(ancestry.join(" / "))}.`,
            `Its physical working directory is ${JSON.stringify(physicalPath)}.`,
            ...(current.description === undefined
                ? []
                : [`Folder description: ${current.description}`]),
            ...(current.rules === undefined ? [] : [`Folder rules:\n${current.rules}`]),
        ].join("\n");
    }

    /** The slot and applet surface handed to this session's tools, with this session as author. */
    #slotContext(ctx: Context): SlotContext {
        const stores = this.#slotStores;
        if (stores === undefined) {
            throw new Error("Slots are unavailable in this session.");
        }
        return {
            createEntry: (request) =>
                stores.entries.create(ctx, {
                    ...request,
                    author: { type: "agent", sessionId: this.id },
                }),
            createApplet: (request, sourceFileSystem) =>
                stores.applets.create(
                    ctx,
                    { ...request, authorSessionId: this.id },
                    sourceFileSystem,
                ),
            listEntries: (filter) => stores.entries.list(ctx, filter),
            listApplets: () => stores.applets.list(ctx),
            removeEntry: (id) => stores.entries.remove(ctx, id),
            revertApplet: (name, request) => stores.applets.revert(ctx, name, request),
            updateEntry: (id, request) => stores.entries.update(ctx, id, request),
            updateApplet: (name, request, sourceFileSystem) =>
                stores.applets.update(ctx, name, request, sourceFileSystem),
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

    async #ensureExecutionContext(ctx: Context): Promise<AgentContext> {
        if (this.#executionContext !== undefined) return this.#executionContext;
        const readiness = await this.#currentWorkspaceRunReadiness();
        if (readiness.state !== "ready") {
            throw new Error(
                readiness.state === "waiting"
                    ? "The managed workspace is still initializing."
                    : readiness.message,
            );
        }

        const profile =
            this.#profileId === undefined
                ? undefined
                : await this.#resolveProfile?.(this.#profileId);
        if (this.#profileId !== undefined && profile === undefined) {
            throw new Error("The session's human profile is unavailable.");
        }
        await this.#syncGitCommandSecret();
        const processManager = new NativeProcessManager();
        const shellEnvironment =
            profile === undefined ? process.env : { ...process.env, ...gitIdentityEnvironment(profile) };
        const executionContext =
            this.#request.docker === undefined
                ? createNodeAgentContext(ctx, {
                      cwd: this.#request.cwd,
                      environment: shellEnvironment,
                      permissionMode: this.#permissionMode,
                      processManager,
                      secrets: this.#secrets,
                  })
                : createDockerAgentContext({
                      docker: this.#request.docker,
                      environment:
                          profile === undefined ? {} : { ...gitIdentityEnvironment(profile) },
                      permissionMode: this.#permissionMode,
                      secrets: this.#secrets,
                      sessionId: this.#agentMetadata.rootSessionId,
                  });
        let previousBackgroundCount = executionContext.bash.activeSessionCount?.() ?? 0;
        executionContext.bash.setActiveSessionCountListener?.((running) => {
            const runId = this.#activeRun?.runId ?? this.#lastSessionRunId ?? "background";
            void withWorkerContext(
                "background-process-count-change",
                (workerCtx) =>
                    this.#append(workerCtx, "agent_event", {
                        event: {
                            type: "background_processes_changed",
                            processes: executionContext.bash.activeSessions?.() ?? [],
                            running,
                        },
                        runId,
                    }),
                { sessionId: this.id },
            ).catch(rethrowDatabaseFailure);
            if (running === previousBackgroundCount) return;
            previousBackgroundCount = running;
        });
        executionContext.bash.setSessionExitListener?.((exit) => {
            if (this.#executionContext !== executionContext) return;
            return withWorkerContext(
                "background-process-exit",
                (workerCtx) => this.#notifyBackgroundProcessExit(workerCtx, exit),
                { sessionId: this.id },
            ).catch(rethrowDatabaseFailure);
        });
        this.#processManager = processManager;
        this.#executionContext = executionContext;
        return executionContext;
    }

    async #syncGitCommandSecret(): Promise<void> {
        const projectId = this.projectIdentity()?.projectId;
        const gitAuthentication =
            projectId === undefined || this.#profileId === undefined
                ? undefined
                : await this.#resolveGitAuthentication?.(projectId, {
                      instanceId: this.#ownerInstanceId,
                      profileId: this.#profileId,
                  });
        this.#secrets.removeRuntimeSecret(PROJECT_GIT_SECRET_ID);
        if (gitAuthentication !== undefined) {
            this.#secrets.setRuntimeSecret(projectGitCommandSecret(gitAuthentication));
        }
    }

    #activeProcessCount(): number {
        const nativeProcesses = this.#processManager?.activeCount() ?? 0;
        return this.#request.docker === undefined
            ? nativeProcesses
            : nativeProcesses + (this.#executionContext?.bash.activeSessionCount?.() ?? 0);
    }

    /**
     * Everything a shutdown would still have to take down.
     *
     * A command like `nohup server &` settles the moment its launcher exits,
     * so counting live commands alone reports nothing while the server it
     * started is very much still running under a process group we retained.
     */
    #reapableProcessCount(): number {
        const nativeProcesses = this.#processManager?.reapableCount() ?? 0;
        return this.#request.docker === undefined
            ? nativeProcesses
            : nativeProcesses + (this.#executionContext?.bash.activeSessionCount?.() ?? 0);
    }

    /**
     * Stops the session's processes.
     *
     * Work the agent deliberately left running in the background is spared
     * unless the caller explicitly includes it.
     */
    async #killExecutionProcesses(
        ctx: Context,
        options: { forceAfterMs?: number; includeBackground?: boolean } = {},
    ): Promise<void> {
        const executionContext = this.#executionContext;
        const processManager = this.#processManager;
        if (executionContext === undefined && processManager === undefined) return;
        const forceAfterMs = options.forceAfterMs ?? BASH_SESSION_STOP_GRACE_MS;
        const includeBackground = options.includeBackground ?? false;
        // The bash context is asked first, and on purpose. Asking it claims the
        // outcome of every command it holds, so a command that dies during the
        // process manager's grace period cannot announce its own death to a
        // model we are in the middle of tearing down.
        const sessions = includeBackground
            ? (executionContext?.bash.killAllSessions?.() ?? Promise.resolve(0))
            : Promise.resolve(0);
        await Promise.all([
            processManager?.killAll(ctx, { forceAfterMs, includeDetached: includeBackground }),
            sessions,
        ]);
    }

    async #drainPendingContextMessages(
        ctx: Context,
        messageIds?: readonly string[],
    ): Promise<readonly PersistedPendingContextMessage[]> {
        const persist = (ctx: Context) => this.#persistPendingContextDrain(ctx, messageIds);
        const selected = await (this.#persistence?.transaction === undefined
            ? persist(ctx)
            : this.#persistence.transaction(ctx, persist));
        this.#applyPendingContextDrain(selected);
        return selected;
    }

    async #persistPendingContextDrain(
        ctx: Context,
        messageIds?: readonly string[],
    ): Promise<readonly PersistedPendingContextMessage[]> {
        const selectedIds =
            messageIds ??
            [...this.#pendingContextMessages.values()].map((pending) => pending.message.id);
        return await (this.#persistence?.drainPendingContextMessages?.(ctx, this.id, selectedIds) ??
            [...this.#pendingContextMessages.values()].filter((pending) =>
                selectedIds.includes(pending.message.id),
            ));
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

    async #saveSession(ctx: Context): Promise<void> {
        if (this.#workspaceArchived) this.#status = "archived";
        if (this.#persistence !== undefined) {
            await this.#persistence.saveSession(ctx, this.state());
        }
        await this.#reportStatus(ctx);
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
    async #reportStatus(ctx: Context): Promise<void> {
        if (this.#reportingStatus || this.#status === this.#reportedStatus) return;
        const status = this.#status;
        this.#reportingStatus = true;
        try {
            await this.#append(ctx, "session_status_changed", { status });
            if (this.#status === status) this.#reportedStatus = status;
        } finally {
            this.#reportingStatus = false;
        }
    }

    #separateModelContextFromVisibleTranscript(): void {
        if (this.#contextMessages !== undefined) return;

        const pendingContextIds = new Set(this.#pendingContextMessages.keys());
        this.#contextMessages = this.#committedMessages().filter(
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
        return this.#activeRun !== undefined;
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

    async #clearMetadataSettlement(ctx: Context): Promise<void> {
        this.#metadataRevision += 1;
        this.#metadataController?.abort();
        this.#metadataController = undefined;
        if (this.#titleStatus === "generating") {
            await this.#runSessionMutation(ctx, async (ctx) => {
                this.#titleStatus = this.#title === undefined ? "idle" : "ready";
                this.#titleError = undefined;
                await this.#saveSession(ctx);
            });
        }
    }

    #restartMetadataSettlement(): Promise<void> | undefined {
        return undefined;
    }

    #reservePendingContextForSteering(runId: string): readonly PersistedPendingContextMessage[] {
        const reserved = this.#pendingContextSteering.get(runId) ?? new Set<string>();
        this.#pendingContextSteering.set(runId, reserved);
        const selected = [...this.#pendingContextMessages.values()].filter(
            (pending) => !reserved.has(pending.message.id),
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

    async #currentWorkspaceRunReadiness(): Promise<WorkspaceRunReadiness> {
        const workspace = this.#workspaceScope();
        if (workspace === undefined) return { state: "ready" };
        return (
            (await this.#workspaceRunReadiness?.({
                cwd: this.#request.cwd,
                projectId: workspace.projectId,
                workspaceId: workspace.workspaceId,
            })) ?? { state: "ready" }
        );
    }

    #projectScope(): Extract<SessionScope, { kind: "project" | "workspace" }> {
        if (this.#scope.kind === "project" || this.#scope.kind === "workspace") return this.#scope;
        throw new Error("This operation is available only in a project or workspace chat.");
    }

    #workspaceScope(): Extract<SessionScope, { kind: "workspace" }> | undefined {
        return this.#scope.kind === "workspace" ? this.#scope : undefined;
    }

    #startScopeRuntimeRefresh(): void {
        if (!this.#scopeRuntimeRefreshPending || this.#scopeRuntimeRefresh !== undefined) return;
        this.#scopeRuntimeRefreshPending = false;
        this.#scopeRuntimeRefresh = withWorkerContext(
            "scope-runtime-refresh",
            (workerCtx) => this.#teardownRuntimeForWorkspaceTransfer(workerCtx),
            { sessionId: this.id },
        ).finally(() => {
            this.#scopeRuntimeRefresh = undefined;
        });
    }

    async #settleScopeRuntimeRefresh(): Promise<void> {
        this.#startScopeRuntimeRefresh();
        await this.#scopeRuntimeRefresh;
    }

    async #settleInferenceScopeRefresh(): Promise<void> {
        return;
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

    async #setWorkspaceTransferState(
        ctx: Context,
        state: SessionWorkspaceTransferState,
        contextMessages?: readonly Message[],
    ): Promise<void> {
        await this.#persistence?.setWorkspaceTransferState?.(ctx, {
            ...(contextMessages === undefined ? {} : { contextMessages }),
            sessionId: this.id,
            state,
        });
        this.#workspaceTransfer = state;
        if (contextMessages !== undefined) this.#contextMessages = [...contextMessages];
    }

    #workspaceTransferContextMessages(): readonly Message[] {
        return [...(this.#contextMessages ?? this.#committedMessages())].filter(
            (message) => !isExcludedFromModelContext(message),
        );
    }

    async #teardownRuntimeForWorkspaceTransfer(ctx: Context): Promise<void> {
        await this.#killExecutionProcesses(ctx, { includeBackground: true });
        this.#executionContext = undefined;
        this.#processManager = undefined;
        this.#mcpServers = [];
        this.#tools = [];
    }

    async #completePendingWorkspaceTransfer(ctx: Context, runId: string): Promise<void> {
        if (this.#workspaceTransfer.status !== "scheduled") return;
        const targetWorkspaceId = this.#workspaceTransfer.targetWorkspaceId;
        try {
            throw new Error("Session transfers are owned by Agent Base.");
        } catch (error) {
            await this.failWorkspaceTransfer(ctx, targetWorkspaceId, error, "not_touched", runId);
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
        const sourceWorkspaceId = this.#workspaceScope()?.workspaceId;
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

    async #continueGoalIfIdle(_ctx: Context): Promise<void> {}

    async #discardQueuedGoalRuns(_ctx: Context): Promise<void> {}

    async #pauseActiveGoal(ctx: Context): Promise<void> {
        if (this.#goal?.status !== "active") return;
        this.#goal = { ...this.#goal, status: "paused", updatedAt: this.#now() };
        await this.#append(ctx, "goal_changed", { goal: { ...this.#goal } });
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

    /**
     * Commits one Agent Base submission into the existing app transcript projection.
     *
     * Agent Base owns the conversation. This method only keeps Rig's public session protocol and
     * transcript rows synchronized while the old session repository is being split apart.
     */
    async projectAgentConfiguration(
        ctx: Context,
        configuration: RigAgentConfiguration,
    ): Promise<ProtocolSession> {
        if (!Value.Check(rigAgentConfigurationSchema, configuration)) {
            throw new Error("The Agent Base configuration projection is invalid.");
        }
        const current = this.snapshot();
        const provider = this.#modelCatalog.providers.find(
            (candidate) => candidate.providerId === configuration.providerId,
        );
        const model = provider?.models.find((candidate) => candidate.id === configuration.modelId);
        if (provider === undefined || model === undefined) {
            throw new Error(
                `Model '${configuration.modelId}' is not available from provider '${configuration.providerId}'.`,
            );
        }
        if (
            configuration.effort !== undefined &&
            !model.thinkingLevels.includes(configuration.effort) &&
            !(configuration.effort === "max" && model.thinkingLevels.includes("ultra"))
        ) {
            throw new Error(
                `Model '${configuration.modelId}' does not support the '${configuration.effort}' reasoning effort.`,
            );
        }
        if (
            configuration.serviceTier !== undefined &&
            !provider.serviceTiers?.includes(configuration.serviceTier)
        ) {
            throw new Error(
                `Provider '${configuration.providerId}' does not support fast inference.`,
            );
        }
        const permissionMode = parsePermissionMode(configuration.permissionMode);
        const targetModels = this.#modelsForProvider(configuration.providerId);
        const changed: SessionConfigurationField[] = [];
        const modelChanged =
            this.#modelId !== configuration.modelId ||
            this.#providerId !== configuration.providerId;
        if (modelChanged) changed.push("model");
        if (this.#effort !== configuration.effort) changed.push("effort");
        if (this.#serviceTier !== configuration.serviceTier) changed.push("serviceTier");
        const permissionChanged = this.#permissionMode !== permissionMode;

        const priorMutation = configuration.mutationId
            ? (this.events.since(undefined) ?? []).find(
                  (
                      event,
                  ): event is Extract<
                      SessionEvent,
                      { type: "session_configuration_changed" | "permission_mode_changed" }
                  > =>
                      (event.type === "session_configuration_changed" ||
                          event.type === "permission_mode_changed") &&
                      event.data.mutationId === configuration.mutationId,
              )
            : undefined;
        if (priorMutation !== undefined) {
            const priorConfiguration =
                priorMutation.type === "session_configuration_changed"
                    ? {
                          effort: priorMutation.data.effort,
                          modelId: priorMutation.data.modelId,
                          permissionMode: current.permissionMode,
                          providerId: priorMutation.data.providerId,
                          serviceTier:
                              priorMutation.data.serviceTier === null
                                  ? undefined
                                  : priorMutation.data.serviceTier,
                      }
                    : {
                          effort: current.effort,
                          modelId: current.modelId,
                          permissionMode: priorMutation.data.permissionMode,
                          providerId: current.providerId,
                          serviceTier: current.serviceTier,
                      };
            if (
                priorConfiguration.modelId !== configuration.modelId ||
                priorConfiguration.providerId !== configuration.providerId ||
                priorConfiguration.effort !== configuration.effort ||
                priorConfiguration.serviceTier !== configuration.serviceTier ||
                priorConfiguration.permissionMode !== permissionMode
            ) {
                throw new Error(
                    `Mutation '${configuration.mutationId}' was already used for a different configuration.`,
                );
            }
            return current;
        }

        const target = this.#protocolSnapshotForAgentConfiguration({
            ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
            modelId: configuration.modelId,
            permissionMode,
            providerId: configuration.providerId,
            ...(configuration.serviceTier === undefined
                ? {}
                : { serviceTier: configuration.serviceTier }),
            models: targetModels,
        });
        if (changed.length === 0 && !permissionChanged) return target;

        const events: SessionEvent[] = [];
        if (changed.length > 0) {
            events.push(
                this.#createEvent("session_configuration_changed", {
                    changed,
                    ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
                    modelId: configuration.modelId,
                    ...(configuration.mutationId === undefined
                        ? {}
                        : { mutationId: configuration.mutationId }),
                    providerId: configuration.providerId,
                    serviceTier: configuration.serviceTier ?? null,
                }),
            );
        }
        if (permissionChanged) {
            events.push(
                this.#createEvent("permission_mode_changed", {
                    ...(configuration.mutationId === undefined
                        ? {}
                        : { mutationId: configuration.mutationId }),
                    permissionMode,
                }),
            );
        }
        const state = this.state();
        const { effort: _effort, serviceTier: _serviceTier, ...stateWithoutConfiguration } = state;
        const targetState: PersistedSessionState = {
            ...stateWithoutConfiguration,
            ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
            modelId: configuration.modelId,
            models: targetModels,
            permissionMode,
            providerId: configuration.providerId,
            ...(configuration.serviceTier === undefined
                ? {}
                : { serviceTier: configuration.serviceTier }),
        };
        return await this.#runSessionMutation(ctx, async (txCtx) => {
            await this.#persistence?.saveSession(txCtx, targetState);
            for (const event of events) await this.#onAppendEvent?.(txCtx, event);
            await this.#afterTransactionCommit(txCtx, async (postCommitCtx) => {
                this.#applyProjectedAgentConfiguration(configuration, permissionMode, modelChanged);
                for (const event of events) {
                    await this.#appendDurableEvent(postCommitCtx, event, false);
                }
            });
            return target;
        });
    }

    async projectUserMessage(
        ctx: Context,
        input: {
            delivery: "run" | "steer";
            displayText: string;
            message: UserMessage;
            mutationId?: string;
            runId: string;
            submissionFingerprint?: string;
        },
    ): Promise<Extract<SessionEvent, { type: "message_submitted" }>> {
        if (
            input.submissionFingerprint !== undefined &&
            !Value.Check(submissionFingerprintSchema, input.submissionFingerprint)
        ) {
            throw new Error("The message submission fingerprint is invalid.");
        }
        if (!Value.Check(submitMessageDisplayTextSchema, input.displayText)) {
            throw new Error("The submitted display text is invalid or oversized.");
        }
        const event = this.#createEvent("message_submitted", {
            delivery: input.delivery,
            displayText: input.displayText,
            message: input.message,
            ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
            runId: input.runId,
            ...(input.submissionFingerprint === undefined
                ? {}
                : { submissionFingerprint: input.submissionFingerprint }),
        });
        if (
            await this.#stageProtocolProjection(ctx, {
                event,
                message: {
                    isPartial: false,
                    message: input.message,
                    position: this.#nextProjectedMessagePosition(ctx),
                    runId: input.runId,
                },
            })
        ) {
            return event;
        }
        return await this.#runSessionMutation(ctx, async (txCtx) => {
            await this.#storeMessage(
                txCtx,
                this.#nextMessagePosition(),
                input.message,
                false,
                input.runId,
            );
            this.#lastMessageAt = this.#now();
            await this.#appendDurableEvent(txCtx, event);
            return event;
        });
    }

    /**
     * Commits one completed Agent Base response into Rig's app transcript and event stream.
     */
    async projectAgentMessage(
        ctx: Context,
        runId: string,
        message: AgentMessage | ErrorMessage,
    ): Promise<Extract<SessionEvent, { type: "agent_message" }>> {
        const event = this.#createEvent("agent_message", { message, runId });
        if (
            await this.#stageProtocolProjection(ctx, {
                event,
                message: {
                    isPartial: false,
                    message,
                    position: this.#nextProjectedMessagePosition(ctx),
                    runId,
                },
            })
        ) {
            return event;
        }
        return await this.#runSessionMutation(ctx, async (txCtx) => {
            await this.#storeMessage(txCtx, this.#nextMessagePosition(), message, false, runId);
            await this.#appendDurableEvent(txCtx, event);
            return event;
        });
    }

    /**
     * Commits one non-transient Agent Base lifecycle event through the session projection.
     */
    async afterProtocolCommit(ctx: Context, callback: () => void): Promise<void> {
        await this.#afterTransactionCommit(ctx, () => callback());
    }

    async projectProtocolEvent<TEvent extends SessionEvent>(
        ctx: Context,
        event: TEvent,
    ): Promise<TEvent> {
        if (await this.#stageProtocolProjection(ctx, { event })) return event;
        return await this.#commitEvent(ctx, event);
    }

    /**
     * Keep the database part of an Agent Base transaction separate from this session's heap.
     *
     * Agent Base may call the protocol feature while its own transaction is still open. The
     * session persistence adapter can join that transaction, but the old session object cannot
     * observe a later rollback. Write the durable rows first and schedule the in-memory append
     * only for the host's outermost commit.
     */
    async #stageProtocolProjection(
        ctx: Context,
        operation: StagedProtocolProjectionOperation,
    ): Promise<boolean> {
        const scope = getDatabaseScope(ctx);
        if (
            !isSessionDatabaseTransaction(scope) ||
            this.#persistence?.upsertMessage === undefined ||
            this.#onAppendEvent === undefined
        ) {
            return false;
        }
        let staged = this.#stagedProtocolProjections.get(scope);
        if (staged === undefined) {
            staged = {
                nextPosition: this.#nextMessagePosition(),
                operations: [],
                scheduled: false,
            };
            this.#stagedProtocolProjections.set(scope, staged);
        }
        if (!staged.scheduled) {
            staged.scheduled = true;
            await this.#afterTransactionCommit(ctx, async (postCommitCtx) => {
                this.#stagedProtocolProjections.delete(scope);
                for (const stagedOperation of staged!.operations) {
                    if (stagedOperation.message !== undefined) {
                        if (stagedOperation.message.message.role === "user") {
                            this.#lastMessageAt = this.#now();
                        }
                        await this.#storeMessage(
                            postCommitCtx,
                            stagedOperation.message.position,
                            stagedOperation.message.message,
                            stagedOperation.message.isPartial,
                            stagedOperation.message.runId,
                            false,
                        );
                    }
                    await this.#appendDurableEvent(postCommitCtx, stagedOperation.event, false);
                }
                this.#trimRetainedMessages();
            });
        }
        if (operation.message !== undefined) {
            const position = operation.message.position;
            if (position < staged.nextPosition) {
                throw new Error("The staged protocol message position is already reserved.");
            }
            staged.nextPosition = position + 1;
            await this.#persistence.upsertMessage(ctx, this.id, operation.message);
        }
        await this.#onAppendEvent(ctx, operation.event);
        staged.operations.push(operation);
        return true;
    }

    #nextProjectedMessagePosition(ctx: Context): number {
        const scope = getDatabaseScope(ctx);
        const staged = isSessionDatabaseTransaction(scope)
            ? this.#stagedProtocolProjections.get(scope)
            : undefined;
        return staged?.nextPosition ?? this.#nextMessagePosition();
    }

    /**
     * Publishes transient Agent Base inference output without touching SQLite or the durable
     * session event lock. A completed message supersedes these updates in transcript history.
     */
    publishAgentLiveEvent(ctx: Context, event: SessionEvent): void {
        this.events.publishTransient(event);
        this.#publishLiveEvent?.(ctx, event);
    }

    async #storeMessage(
        ctx: Context,
        position: number,
        message: Message,
        isPartial: boolean,
        runId?: string,
        persist = true,
    ): Promise<void> {
        const replacedIndex = this.#messageIndexByPosition.get(position);
        const replaced = replacedIndex === undefined ? undefined : this.#messages[replacedIndex];
        const entry: PersistedSessionMessage = {
            isPartial,
            message,
            position,
            ...(runId === undefined ? {} : { runId }),
        };
        if (persist && this.#persistence !== undefined) {
            await this.#persistence.upsertMessage(ctx, this.id, entry);
        }
        if (replaced?.message.role === "user") {
            this.#submittedUserMessages.delete(replaced.message.id);
        }
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

/** The folder a tree change answered with, or the failure that says it was never there. */
function requireFolder(folder: Folder | undefined): Folder {
    if (folder === undefined) {
        throw new FolderError("folder_not_found", "That folder was not found.");
    }
    return folder;
}

function scopeConvenienceFields(scope: SessionScope): {
    folderId?: string;
    projectId?: string;
    workspaceId?: string;
} {
    if (scope.kind === "project") return { projectId: scope.projectId };
    if (scope.kind === "workspace") {
        return { projectId: scope.projectId, workspaceId: scope.workspaceId };
    }
    return scope.kind === "folder" ? { folderId: scope.folderId } : {};
}
