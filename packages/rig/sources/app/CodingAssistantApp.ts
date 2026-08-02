/* eslint-disable no-control-regex -- Terminal rendering intentionally parses ANSI controls. */
import { createId } from "@paralleldrive/cuid2";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    CURSOR_MARKER,
    Editor,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type AutocompleteItem,
    type Component,
    type Focusable,
    type TUI,
} from "@earendil-works/pi-tui";

import {
    type AgentLoopEvent,
    type ContentBlock,
    type Message,
    type Skill,
    type ToolResultBlock,
    type UserMessage,
    formatSkillInvocation,
} from "../agent/index.js";
import type { BashSessionActivity, BashSessionSnapshot } from "../agent/context/BashContext.js";
import { loadAgentSkillCatalog } from "../agent/skills/loadAgentSkillCatalog.js";
import { MAXIMUM_SKILL_FILE_BYTES } from "../agent/skills/loadSkillFromFile.js";
import { parseSkillFrontmatter } from "../agent/skills/parseSkillFrontmatter.js";
import type { FileDiff } from "../agent/ToolResultPresentation.js";
import { errorToMessage } from "../errorToMessage.js";
import { ONLINE_PRESENCE_ID } from "../presence/index.js";
import type { NativeProcessManager } from "../processes/index.js";
import { humanizeMcpName } from "../mcp/humanizeMcpName.js";
import type { ServiceTier, Usage } from "@slopus/rig-execution";
import {
    DEFAULT_INFERENCE_MAX_RETRIES,
    MAX_INFERENCE_MAX_RETRIES,
} from "../config/inferenceRetrySettings.js";
import type {
    FileSearchResult,
    EventId,
    McpServerSummary,
    PluginSummary,
    PresenceSnapshot,
    PresenceSummary,
    RunShellCommandResult,
    RunShellCommandResponse,
    SecretSummary,
    SessionEvent,
    SessionSharedMetadata,
    SessionTokenCount,
    SessionTask,
    SteerMessageResponse,
    SubagentSummary,
    WorkflowRun,
} from "../protocol/index.js";
import type { SecretAttachmentScope, SecretRegistration } from "../secrets/index.js";
import type { UserInputRequest, UserInputResponse } from "../user-input/index.js";
import { humanizeWorkflowName } from "../workflows/index.js";
import { createCodeReviewPrompt } from "../review/index.js";
import type { AppTranscriptEntry } from "./AppTranscriptEntry.js";
import type { CodexMcpToolCall } from "./CodexMcpToolCall.js";
import { CODEX_DARK_DIFF_PALETTE, CODEX_LIGHT_DIFF_PALETTE } from "./CodexFileDiff.js";
import type {
    CodingAssistantAgentBackend,
    CodingAssistantModelChoice,
} from "./CodingAssistantAgentBackend.js";
import { createEditorTheme } from "./createEditorTheme.js";
import {
    createBackgroundTerminalViewer,
    type BackgroundTerminalViewer,
} from "./createBackgroundTerminalViewer.js";
import { createSelectionPanel } from "./createSelectionPanel.js";
import { createSecretInputPanel } from "./createSecretInputPanel.js";
import { createSubagentMonitor, type SubagentMonitor } from "./createSubagentMonitor.js";
import { createWorkflowMonitor } from "./createWorkflowMonitor.js";
import { containsMarkdownTable } from "./containsMarkdownTable.js";
import { compactCompletedTurnEntries } from "./compactCompletedTurnEntries.js";
import { createCompletedTurn } from "./createCompletedTurn.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { createSlashCommands, type SlashCommandItem } from "./createSlashCommands.js";
import { describeModelChoice } from "./describeModelChoice.js";
import { describeReasoningLevel } from "./describeReasoningLevel.js";
import { encodeModelChoice } from "./encodeModelChoice.js";
import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";
import { formatCompactTokens as formatTokens } from "./formatCompactTokens.js";
import { formatCodexMcpToolResult } from "./formatCodexMcpToolResult.js";
import { FileMentionAutocomplete } from "./FileMentionAutocomplete.js";
import { SessionDraftSync } from "./SessionDraftSync.js";
import type { FileMentionContext } from "./findFileMentionContext.js";
import { formatFileMention } from "./formatFileMention.js";
import { formatProviderError } from "./formatProviderError.js";
import { formatResetDuration } from "./formatResetDuration.js";
import { formatSessionTokenStatus } from "./formatSessionTokenStatus.js";
import { formatSessionUsageSummary } from "./formatSessionUsageSummary.js";
import { formatSubagentToolCall } from "./formatSubagentToolCall.js";
import { formatToolResultForDisplay } from "./formatToolResultForDisplay.js";
import { formatTurnUsageSummary } from "./formatTurnUsageSummary.js";
import { providerErrorResetAt } from "./providerErrorResetAt.js";
import { humanizeReasoningLevel } from "./humanizeReasoningLevel.js";
import { humanizePermissionMode } from "./humanizePermissionMode.js";
import { humanizeProviderId } from "./humanizeProviderId.js";
import { humanizePermissionReviewLevel } from "./humanizePermissionReviewLevel.js";
import { humanizeGoalStatus } from "./humanizeGoalStatus.js";
import { humanizeToolName } from "./humanizeToolName.js";
import { parseCodexMcpToolInvocation } from "./parseCodexMcpToolInvocation.js";
import {
    readClipboardImage,
    type ClipboardImage,
    type ReadClipboardImageOptions,
} from "./readClipboardImage.js";
import { ACTIVITY_WAVE_FRAME_COUNT, renderActivityWave } from "./renderActivityWave.js";
import { AppendOnlyStreamingRender } from "./AppendOnlyStreamingRender.js";
import { renderAgentMarkdown } from "./renderAgentMarkdown.js";
import { renderBackgroundTerminalCompletion } from "./renderBackgroundTerminalCompletion.js";
import { renderBackgroundTerminalInteraction } from "./renderBackgroundTerminalInteraction.js";
import { renderBackgroundTerminalSummary } from "./renderBackgroundTerminalSummary.js";
import { renderChildRows, type ChildRow } from "./renderChildRows.js";
import { renderCompletedTurnStats } from "./renderCompletedTurnStats.js";
import { renderCodexFileDiff } from "./renderCodexFileDiff.js";
import { renderCodexMcpToolCall } from "./renderCodexMcpToolCall.js";
import { renderNoticeWithChildren } from "./renderNoticeWithChildren.js";
import { renderExecCommand } from "./renderExecCommand.js";
import { renderExploration } from "./renderExploration.js";
import { renderPendingSteeringMessages } from "./renderPendingSteeringMessages.js";
import {
    describeActivePeerCapabilities,
    renderPeerCapabilityIndicator,
} from "./renderPeerCapabilityIndicator.js";
import { renderRigBanner } from "./renderRigBanner.js";
import { renderStartupStatusCard } from "./renderStartupStatusCard.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { subagentElapsedMs } from "./subagentElapsedMs.js";
import { renderSubagentSummary } from "./renderSubagentSummary.js";
import { renderTurnCompletionSeparator } from "./renderTurnCompletionSeparator.js";
import { renderWorkflowSummary } from "./renderWorkflowSummary.js";
import { TranscriptEntryRenderCache } from "./TranscriptEntryRenderCache.js";
import { upsertSubagentSummary } from "./upsertSubagentSummary.js";
import { applyWorkflowRunUpdate } from "./applyWorkflowRunUpdate.js";
import type { TerminalTheme } from "./TerminalTheme.js";
import type { StartupStatusCardModel } from "./StartupStatusCardModel.js";
import { SecretMenuController } from "./SecretMenuController.js";
import { TemporaryFullscreenController } from "./TemporaryFullscreenController.js";
import { updateSessionTokenCount } from "../session/usage/updateSessionTokenCount.js";
import { renderFullscreenComponent } from "./renderFullscreenComponent.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NOT_BOLD_OR_DIM = "\x1b[22m";
const CURSOR_BG = "\x1b[48;5;244m";
const CURSOR_FG = "\x1b[38;5;232m";
const INPUT_PLACEHOLDER = "Ask Rig to do anything";
const INPUT_PROMPT = "› ";
const INPUT_LINE_INDENT = "  ";
const PENDING_TOOL_CALL_TITLE = "Working";
const ACTIVITY_ANIMATION_MS = 120;
const PLUGIN_STATUS_LABELS = {
    failed: "Failed",
    running: "Running",
    stopped: "Stopped",
} satisfies Record<PluginSummary["status"], string>;
const REASONING_DOWN_RAW_KEYS = new Set(["\x1b,", "\x1b[1;2B"]);
const REASONING_UP_RAW_KEYS = new Set(["\x1b.", "\x1b[1;2A"]);
const MODEL_MENU_RAW_KEYS = new Set(["\x1bm", "\x1bM"]);
const IMAGE_PASTE_RAW_KEYS = new Set(["\x16", "\x1bv"]);
const AUTOCOMPLETE_MAX_VISIBLE = 6;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const TERMINAL_FOCUS_IN = "\x1b[I";
const TERMINAL_FOCUS_OUT = "\x1b[O";
const IMAGE_PLACEHOLDER_REGEX = /\[Image #(\d+) [A-Z0-9]+\]/gu;
const IMAGE_CHIP_BG = "\x1b[48;5;240m";
const IMAGE_CHIP_FG = "\x1b[38;5;255m";
const FILE_MENTION_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const FAST_MODE_ON_MESSAGE = "Fast mode is on. Fast inference uses 2× plan usage.";
const FAST_MODE_OFF_MESSAGE = "Fast mode is off.";
const FOREGROUND_SHELL_YIELD_MS = 10_000;
/** How long shutdown waits for the last composer draft to reach the daemon. */
const DRAFT_FLUSH_TIMEOUT_MS = 500;

function entryBoundary(entry: AppTranscriptEntry | undefined): boolean {
    return entry?.completedTurn !== undefined || entry?.turnElapsedMs !== undefined;
}

const MAX_DIFF_FILES_PER_TOOL = 20;
const MAX_DIFF_ROWS_PER_TOOL = 120;

export type AppExitReason = "exit" | "reload";

/** Plain-English summary of how long this presence lets a question wait. */
function describePresenceWait(answerWaitMs: number | null): string {
    if (answerWaitMs === null) return "Questions wait for you as long as they need to.";
    if (answerWaitMs <= 0) return "Questions never wait; agents keep working on their own.";
    const minutes = Math.max(1, Math.round(answerWaitMs / 60_000));
    return `Questions wait about ${String(minutes)} minute${minutes === 1 ? "" : "s"}, then agents continue.`;
}

export interface CodingAssistantAppOptions {
    activeAgentLabel?: string;
    agent: CodingAssistantAgentBackend;
    attachSecret?: (id: string, scope: SecretAttachmentScope) => void | Promise<void>;
    cwd: string;
    initialBackgroundProcesses?: readonly BashSessionActivity[];
    initialUsage?: Usage;
    initialMcpServers?: readonly McpServerSummary[];
    initialNotices?: readonly { text: string; title: string }[];
    initialSessionEvents?: readonly SessionEvent[];
    initialSessionTokenCount?: SessionTokenCount;
    initialSubagents?: readonly SubagentSummary[];
    initialProjectSecretIds?: readonly string[];
    initialSessionSecretIds?: readonly string[];
    initialTasks?: readonly SessionTask[];
    /** Compact owner-share status only; Happy owns management controls. */
    sessionShare?: SessionSharedMetadata;
    initialUsageEventId?: EventId;
    initialWorkflowEventId?: EventId;
    initialWorkflows?: readonly WorkflowRun[];
    workflowsEnabled?: boolean;
    initialUserInputs?: readonly UserInputRequest[];
    modelLocked?: boolean;
    listSecrets?: () => readonly SecretSummary[] | Promise<readonly SecretSummary[]>;
    /** Where the user is, and how to switch it. Absent when the daemon does not report presence. */
    presence?: {
        get?: () => Promise<PresenceSnapshot>;
        initial?: PresenceSnapshot;
        set: (presenceId: string) => Promise<PresenceSnapshot>;
    };
    processManager: NativeProcessManager;
    sessionBacked?: boolean;
    tui: TUI;
    idFactory?: () => string;
    onDefaultModelChange?: (preference: DefaultModelPreference) => void | Promise<void>;
    onTerminalFocusChange?: (focused: boolean) => void;
    onUserActivity?: () => void;
    onSettingsChange?: (settings: AppSettings) => void | Promise<void>;
    onStopWorkflow?: (runId: string) => void | Promise<void>;
    watchSubagentEvents?: (
        sessionId: string,
        signal: AbortSignal,
        onEvent: (event: SessionEvent) => void,
    ) => Promise<void>;
    onExit?: () => void | Promise<void>;
    respondUserInput?: (requestId: string, response: UserInputResponse) => void | Promise<void>;
    now?: () => number;
    readClipboardImage?: (
        options?: ReadClipboardImageOptions,
    ) => Promise<ClipboardImage | undefined>;
    searchFiles?: (query: string) => Promise<readonly FileSearchResult[]>;
    inferenceMaxRetries?: number;
    compactCompletedTurns?: boolean;
    completionChime?: boolean;
    registerSecret?: (registration: SecretRegistration) => SecretSummary | Promise<SecretSummary>;
    unregisterSecret?: (id: string) => boolean | Promise<boolean>;
    detachSecret?: (id: string, scope: SecretAttachmentScope) => void | Promise<void>;
    durableGlobalEventQueue?: boolean;
    debugInfo?: AppDebugInfo;
    showReasoning?: boolean;
    showUsage?: boolean;
    startupStatus?: StartupStatusCardModel;
    version?: string;
    theme?: TerminalTheme;
}

export interface AppDebugInfo {
    daemonLogPath: string;
    serverInspectorUrl?: string;
    sessionId: string;
    startInspectors: () => Promise<AppDebugInspectorUrls>;
    stateDirectory: string;
    tuiInspectorUrl?: string;
    tuiStderrIsTTY: boolean;
}

interface AppDebugInspectorUrls {
    serverInspectorUrl: string;
    tuiInspectorUrl: string;
}

function addUsage(left: Usage, right: Usage): Usage {
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        totalTokens: left.totalTokens + right.totalTokens,
        cost: {
            input: left.cost.input + right.cost.input,
            output: left.cost.output + right.cost.output,
            cacheRead: left.cost.cacheRead + right.cost.cacheRead,
            cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
            total: left.cost.total + right.cost.total,
        },
    };
}

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

export interface DefaultModelPreference {
    effort: string;
    modelId: string;
    providerId: string;
    serviceTier: ServiceTier | null;
}

export interface AppSettings {
    inferenceMaxRetries: number;
    compactCompletedTurns: boolean;
    completionChime: boolean;
    durableGlobalEventQueue: boolean;
    showReasoning: boolean;
    showUsage: boolean;
}

interface PendingPrompt {
    content: string | readonly ContentBlock[];
    displayText: string;
    shellCommand?: string;
    transcriptAppended?: boolean;
    transcriptEntryId?: string;
}

interface PendingSteeringMessage {
    displayText: string;
    id: string;
    runId: string;
    transcriptIndex: number;
}

interface PastedImage {
    data: string;
    mediaType: string;
    path: string;
    placeholder: string;
}

interface PromptSubmission {
    content: string | readonly ContentBlock[];
    displayText: string;
    shellCommand?: string;
    transcriptAppended?: boolean;
    transcriptEntryId?: string;
}

interface LocalSteeringSubmission {
    accepted: boolean;
    applied: boolean;
    id: number;
    invalidated: boolean;
    messageId: string;
    runEnded: boolean;
    runId: string;
    submission: PromptSubmission;
}

interface SteeringInterruptIntent {
    runId: string;
}

interface ActiveUserInput {
    answers: Record<string, readonly string[]>;
    questionIndex: number;
    request: UserInputRequest;
    selected: Set<string>;
}

interface FreeformUserInput {
    existingAnswers: readonly string[];
    questionId: string;
    requestId: string;
}

interface ForegroundShellCommand {
    backgroundRequested: boolean;
    commandId: string;
    sessionId: number;
}

export class CodingAssistantApp implements Component, Focusable {
    readonly #activeAgentLabel: string | undefined;
    readonly #agent: CodingAssistantAgentBackend;
    readonly #cwd: string;
    readonly #idFactory: () => string;
    #draftSync: SessionDraftSync | undefined;
    readonly #now: () => number;
    readonly #editor: Editor;
    readonly #fileMentionAutocomplete: FileMentionAutocomplete | undefined;
    readonly #onDefaultModelChange:
        | ((preference: DefaultModelPreference) => void | Promise<void>)
        | undefined;
    readonly #onSettingsChange: ((settings: AppSettings) => void | Promise<void>) | undefined;
    readonly #onTerminalFocusChange: ((focused: boolean) => void) | undefined;
    readonly #onUserActivity: (() => void) | undefined;
    readonly #onStopWorkflow: ((runId: string) => void | Promise<void>) | undefined;
    readonly #watchSubagentEvents: CodingAssistantAppOptions["watchSubagentEvents"];
    readonly #onExit: (() => void | Promise<void>) | undefined;
    readonly #respondUserInput:
        | ((requestId: string, response: UserInputResponse) => void | Promise<void>)
        | undefined;
    readonly #processManager: NativeProcessManager;
    #sessionShare: SessionSharedMetadata | undefined;
    readonly #readClipboardImage: (
        options?: ReadClipboardImageOptions,
    ) => Promise<ClipboardImage | undefined>;
    readonly #tui: TUI;
    readonly #temporaryFullscreen: TemporaryFullscreenController;
    readonly #theme: TerminalTheme;
    readonly #startupStatus: StartupStatusCardModel;
    readonly #secretMenu: SecretMenuController;
    readonly #presence: CodingAssistantAppOptions["presence"];
    #presenceState: PresenceSnapshot | undefined;
    readonly #version: string;
    readonly #exitPromise: Promise<AppExitReason>;

    #abortController: AbortController | undefined;
    #abortNotified = false;
    #activeLocalSessionRunId: string | undefined;
    #activeRun: Promise<void> | undefined;
    #activeUserInput: ActiveUserInput | undefined;
    #answeringUserInputRequestId: string | undefined;
    #activityAnimationFrame = 0;
    #activityStartedAtMs: number | undefined;
    #activityAnimationTimer: ReturnType<typeof setInterval> | undefined;
    #providerErrorResetTimer: ReturnType<typeof setInterval> | undefined;
    #cursorVisible = true;
    #entries: AppTranscriptEntry[] = [];
    readonly #assistantStreamingRender = new AppendOnlyStreamingRender<AppTranscriptEntry>();
    readonly #thinkingStreamingRender = new AppendOnlyStreamingRender<AppTranscriptEntry>();
    readonly #entryRenderCache = new TranscriptEntryRenderCache();
    readonly #headerLinesByWidth = new Map<number, readonly string[]>();
    #exiting = false;
    #exitResolve: ((reason: AppExitReason) => void) | undefined;
    #focused = false;
    #started = false;
    #terminalFocused = true;
    #freeformUserInput: FreeformUserInput | undefined;
    #pendingPrompts: PendingPrompt[] = [];
    #pendingSubmittedUserEntries: AppTranscriptEntry[] = [];
    #pendingSteeringMessages: PendingSteeringMessage[] = [];
    #inFlightSteeringSubmissions = new Map<number, LocalSteeringSubmission>();
    #acceptedSteeringSubmissions: LocalSteeringSubmission[] = [];
    #rejectedSteeringSubmissions = new Map<number, LocalSteeringSubmission>();
    #continuationRequestedSteeringMessageIds = new Set<string>();
    #nextSteeringSubmissionId = 1;
    #steeringInterruptIntent: SteeringInterruptIntent | undefined;
    #activeSessionRunId: string | undefined;
    #latestSessionRunId: string | undefined;
    #activeTurnEntryStart: number | undefined;
    #interruptRequestInFlight = false;
    #interruptSettlementRunId: string | undefined;
    #compacting = false;
    #pastedImagesById = new Map<number, PastedImage>();
    #selectionPanel: Component | undefined;
    #selectionPanelFullscreen = false;
    #backgroundTerminalViewer: BackgroundTerminalViewer | undefined;
    #backgroundTerminalViewerController: AbortController | undefined;
    #foregroundShellCommand: ForegroundShellCommand | undefined;
    #shellMode = false;
    #sessionMutationInFlight = false;
    #activeSessionMutation: Promise<void> | undefined;
    #sessionMutationBoundaryApplied = false;
    #ignoredBoundaryRunIds = new Set<string>();
    #dismissedSlashCommandText: string | undefined;
    #activeSubmissions = new Set<Promise<void>>();
    #bracketedPasteBuffer: string | undefined;
    #backgroundProcesses: readonly BashSessionActivity[] = [];
    #observedShellProcesses: readonly BashSessionActivity[] = [];
    #yieldedBackgroundTerminals = new Map<number, string>();
    #inferenceMaxRetries: number;
    #compactCompletedTurns: boolean;
    #directShellCommandsBySessionId = new Map<number, { command: string; commandId: string }>();
    #backgroundedShellCommandIds = new Set<string>();
    #completionChime: boolean;
    #durableGlobalEventQueue: boolean;
    #showReasoning: boolean;
    #showUsage: boolean;
    #sessionBacked: boolean;
    #modelLocked: boolean;
    #mcpServers: readonly McpServerSummary[];
    #slashCommandSelectionIndex = 0;
    readonly #slashCommands: readonly SlashCommandItem[];
    #skillCommands: SlashCommandItem[] = [];
    #skillCommandsLoaded = false;
    #skillCommandsRefresh: Promise<void> | undefined;
    #skillsByName = new Map<string, Skill>();
    #imagePasteInFlight: Promise<void> | undefined;
    #nextPastedImageId = 1;
    #runToken = 0;
    #running = false;
    #activeToolCallIds = new Set<string>();
    #awaitingApprovalToolCallIds = new Set<string>();
    #reviewingPermissionToolCallIds = new Set<string>();
    #stoppedToolCallIds = new Set<string>();
    #seenToolCallIds = new Set<string>();
    #statusText = "Idle";
    #stopped = false;
    #streamEntryId: string | undefined;
    /** Streamed assistant entries still waiting for their durable message, oldest first. */
    #unreconciledStreamEntryIds: string[] = [];
    #subagents: readonly SubagentSummary[];
    #subagentRefreshTimer: ReturnType<typeof setInterval> | undefined;
    #tasks: readonly SessionTask[];
    #thinkingEntryIdsByContentIndex = new Map<number, string>();
    #toolCallEntryIdsByContentIndex = new Map<number, string>();
    #streamedToolCallEntries = new Set<AppTranscriptEntry>();
    #streamingThinkingEntryIds = new Set<string>();
    #deferredTurnSeparator = false;
    readonly #debugInfo: AppDebugInfo | undefined;
    #debugInspectorStart: Promise<AppDebugInspectorUrls> | undefined;
    #pendingSubagentCompletionIds = new Set<string>();
    #recordedSubagentCompletionIds = new Set<string>();
    #renderedCompletionNotices = new Map<string, number>();
    #runningToolCallIds = new Set<string>();
    #stoppingBackgroundTerminals = false;
    #toolStatusByCallId = new Map<string, string>();
    #usage: Usage = zeroUsage();
    #usageRequestVersion = 0;
    #skipInitialUsageReplay = false;
    #latestContextTokens = 0;
    #sessionTokenCount: SessionTokenCount = { lastContextTokens: 0, totalTokens: 0 };
    #activeCompactionId: string | undefined;
    #compactionStartedAtMs: number | undefined;
    #lastUserInputAtMs: number | undefined;
    #userInputRequests: UserInputRequest[] = [];
    #workflows: readonly WorkflowRun[];
    #workflowsEnabled: boolean;
    #replayingInitialSessionEvents = false;
    #lastNormalRender: { height: number; lines: readonly string[]; width: number } | undefined;

    constructor(options: CodingAssistantAppOptions) {
        this.#activeAgentLabel =
            options.activeAgentLabel === undefined
                ? undefined
                : this.#singleLine(options.activeAgentLabel);
        this.#agent = options.agent;
        this.#cwd = options.cwd;
        this.#idFactory = options.idFactory ?? createId;
        this.#now = options.now ?? Date.now;
        this.#onDefaultModelChange = options.onDefaultModelChange;
        this.#onSettingsChange = options.onSettingsChange;
        this.#onTerminalFocusChange = options.onTerminalFocusChange;
        this.#onUserActivity = options.onUserActivity;
        this.#onStopWorkflow = options.onStopWorkflow;
        this.#watchSubagentEvents = options.watchSubagentEvents;
        this.#onExit = options.onExit;
        this.#respondUserInput = options.respondUserInput;
        this.#processManager = options.processManager;
        this.#sessionShare = options.sessionShare;
        this.#readClipboardImage = options.readClipboardImage ?? readClipboardImage;
        this.#sessionBacked = options.sessionBacked ?? false;
        this.#inferenceMaxRetries = options.inferenceMaxRetries ?? DEFAULT_INFERENCE_MAX_RETRIES;
        this.#compactCompletedTurns = options.compactCompletedTurns ?? false;
        this.#completionChime = options.completionChime ?? false;
        this.#durableGlobalEventQueue = options.durableGlobalEventQueue ?? false;
        this.#debugInfo = options.debugInfo;
        this.#showReasoning = options.showReasoning ?? false;
        this.#showUsage = options.showUsage ?? false;
        this.#modelLocked = options.modelLocked ?? !options.agent.canChangeModel;
        this.#mcpServers = options.initialMcpServers ?? [];
        this.#subagents = options.initialSubagents ?? [];
        this.#tasks = options.initialTasks ?? [];
        this.#workflows = options.initialWorkflows ?? [];
        this.#workflowsEnabled = options.workflowsEnabled ?? true;
        this.#slashCommands = createSlashCommands({ workflowsEnabled: this.#workflowsEnabled });
        this.#tui = options.tui;
        this.#temporaryFullscreen = new TemporaryFullscreenController(this.#tui);
        this.#theme = { ...(options.theme ?? DEFAULT_TERMINAL_THEME) };
        this.#secretMenu = new SecretMenuController({
            appendEntry: (entry) => this.#appendEntry(entry),
            attachSecret: options.attachSecret,
            closePanel: () => this.#setSelectionPanel(undefined),
            detachSecret: options.detachSecret,
            initialProjectSecretIds: options.initialProjectSecretIds,
            initialSessionSecretIds: options.initialSessionSecretIds,
            listSecrets: options.listSecrets,
            registerSecret: options.registerSecret,
            requestRender: () => this.#requestRender(),
            showPanel: (component) => this.#setSelectionPanel(component, true),
            theme: this.#theme,
            unregisterSecret: options.unregisterSecret,
        });
        this.#presence = options.presence;
        this.#presenceState = options.presence?.initial;
        this.#version = options.version ?? "0.0.0";
        const snapshot = options.agent.snapshot();
        const startupStatus: StartupStatusCardModel = {
            access: humanizePermissionMode(options.agent.permissionMode),
            environment: "Local",
            fast: snapshot.serviceTier === "fast",
            model: options.agent.model.name,
            provider: humanizeProviderId(options.agent.provider.id),
            reasoning: humanizeReasoningLevel(
                snapshot.effort ?? options.agent.model.defaultThinkingLevel,
            ),
            session: "New session",
            version: this.#version,
            workspace: options.cwd,
            ...options.startupStatus,
        };
        this.#startupStatus = {
            ...startupStatus,
            ...(startupStatus.usage === undefined
                ? {}
                : {
                      usage: {
                          ...(startupStatus.usage.fiveHour === undefined
                              ? {}
                              : { fiveHour: { ...startupStatus.usage.fiveHour } }),
                          ...(startupStatus.usage.weekly === undefined
                              ? {}
                              : { weekly: { ...startupStatus.usage.weekly } }),
                      },
                  }),
        };
        this.#editor = new Editor(this.#tui, createEditorTheme(this.#theme), { paddingX: 0 });
        this.#fileMentionAutocomplete =
            options.searchFiles === undefined
                ? undefined
                : new FileMentionAutocomplete(options.searchFiles, () => this.#requestRender());
        this.#exitPromise = new Promise((resolve) => {
            this.#exitResolve = resolve;
        });

        this.#editor.onSubmit = (value) => {
            this.#submit(value);
        };
        this.#startDraftSync();

        for (const notice of options.initialNotices ?? []) {
            this.#appendEntry({ role: "event", text: notice.text, title: notice.title });
        }

        this.#replayingInitialSessionEvents = true;
        if (options.initialUsage !== undefined) {
            this.#usage = structuredClone(options.initialUsage);
        }
        if (options.initialSessionTokenCount !== undefined) {
            this.#sessionTokenCount = structuredClone(options.initialSessionTokenCount);
        }
        try {
            let reachedInitialSnapshot = options.initialWorkflowEventId === undefined;
            let reachedInitialUsage = options.initialUsageEventId === undefined;
            for (const event of options.initialSessionEvents ?? []) {
                // The snapshot is authoritative through its last event. Apply only state events
                // that raced in after it so persisted history cannot overwrite current state.
                if (
                    (event.type === "workflow_changed" || event.type === "secrets_changed") &&
                    !reachedInitialSnapshot
                ) {
                    if (event.id === options.initialWorkflowEventId) reachedInitialSnapshot = true;
                    continue;
                }
                if (event.id === options.initialWorkflowEventId) reachedInitialSnapshot = true;
                this.#skipInitialUsageReplay =
                    options.initialUsage !== undefined && !reachedInitialUsage;
                this.applySessionEvent(event);
                if (event.id === options.initialUsageEventId) reachedInitialUsage = true;
            }
        } finally {
            this.#skipInitialUsageReplay = false;
            this.#replayingInitialSessionEvents = false;
        }
        // The session snapshot is authoritative for pending questions. Restore it only
        // after historical run events have replayed so an older run_finished event cannot
        // clear an approval that is still pending on the current run.
        for (const request of options.initialUserInputs ?? []) {
            this.#enqueueUserInputRequest(request);
        }
        this.#observedShellProcesses = options.initialBackgroundProcesses ?? [];
        this.#backgroundProcesses = this.#observedShellProcesses;
        for (const process of this.#observedShellProcesses) {
            this.#yieldedBackgroundTerminals.set(process.sessionId, process.command);
            const direct = this.#directShellCommandsBySessionId.get(process.sessionId);
            if (direct !== undefined) {
                this.#backgroundShellCommand(direct.commandId, process.sessionId, "");
            }
        }
        this.#syncProviderErrorResetTimer();
        this.#syncSubagentRefreshTimer();

        void this.#refreshSkillCommands();
    }

    get focused(): boolean {
        return this.#focused;
    }

    set focused(value: boolean) {
        this.#focused = value;
        this.#editor.focused = value && this.#terminalFocused;
        this.#cursorVisible = true;
        if (value && this.#terminalFocused) {
            this.#startCursorBlink();
        } else {
            this.#stopCursorBlink();
            if (!this.#terminalFocused) this.#cursorVisible = false;
        }
    }

    start(options: { tuiAlreadyStarted?: boolean } = {}): void {
        this.#tui.addChild(this);
        this.#started = true;
        this.focused = true;
        this.#tui.setFocus(this);
        if (options.tuiAlreadyStarted !== true) {
            this.#tui.start();
        }
        this.#syncTemporaryFullscreen();
        this.#requestRender();
    }

    async stop(reason: AppExitReason = "exit"): Promise<void> {
        if (this.#stopped || this.#exiting) {
            return;
        }

        this.#exiting = true;
        this.#statusText = "Stopped";
        this.#abortController?.abort();
        this.#closeBackgroundTerminalViewer();
        this.#stopActivityAnimation();
        this.#stopProviderErrorResetTimer();
        this.#stopSubagentRefreshTimer();
        this.#setSelectionPanel(undefined);
        this.#stopCursorBlink();
        this.#activeToolCallIds.clear();
        this.#awaitingApprovalToolCallIds.clear();
        this.#reviewingPermissionToolCallIds.clear();
        this.#runningToolCallIds.clear();
        this.#toolStatusByCallId.clear();
        this.#fileMentionAutocomplete?.clear();
        await this.#stopDraftSync();
        this.#editor.setText("");
        this.#shellMode = false;
        this.#discardLocalSteeringSubmissionsForBoundary();
        this.#pastedImagesById.clear();
        this.#requestRender();
        await this.#waitForShutdownRender();

        this.#stopped = true;
        this.#temporaryFullscreen.dispose();
        this.#started = false;
        this.#tui.stop();

        try {
            // We are leaving for good, so background work goes with us:
            // nothing Rig started outlives Rig.
            await this.#processManager.killAll({ forceAfterMs: 500, includeDetached: true });
            await this.#onExit?.();
        } finally {
            this.#exitResolve?.(reason);
            this.#requestRender();
        }
    }

    waitForExit(): Promise<AppExitReason> {
        return this.#exitPromise;
    }

    applySessionEvent(event: SessionEvent): void {
        const eventRunId = this.#sessionEventRunId(event);
        if (
            event.type !== "session_reset" &&
            event.type !== "session_rewound" &&
            eventRunId !== undefined &&
            this.#ignoredBoundaryRunIds.has(eventRunId)
        ) {
            return;
        }

        if (event.type === "session_updated") {
            // Absent means this update carries nothing about sharing, not that sharing ended;
            // overwriting the indicator on every unrelated session update would make it flicker
            // out from under an owner who never actually stopped being watched.
            if (event.data.session.shared !== undefined) {
                this.#applySessionShareUpdate(event.data.session.shared);
            }
            return;
        }

        if (event.type === "message_submitted") {
            if (event.data.delivery === "context") {
                this.#appendEntry({
                    contextOnly: true,
                    id: event.data.message.id,
                    role: "user",
                    text: event.data.displayText,
                });
                return;
            }
            this.#modelLocked = true;
            if (event.data.delivery === "run") {
                this.#latestSessionRunId = event.data.runId;
            }
            const notificationPrefix = "Background work ";
            if (event.data.source === "notification") {
                if (this.#consumeRenderedCompletionNotice(event.data.displayText)) return;
            } else if (event.data.delivery === "steer") {
                const localSteering = this.#localSteeringSubmission(event.data.message.id);
                if (localSteering !== undefined) {
                    localSteering.accepted = true;
                    localSteering.runId = event.data.runId;
                }
                if (this.#steeringInterruptIntent?.runId === event.data.runId) {
                    this.#tryRequestSteeringInterrupt(event.data.runId);
                }
                this.#recordUserInput(event.createdAt);
                if (
                    !this.#pendingSteeringMessages.some(
                        (pending) => pending.id === event.data.message.id,
                    )
                ) {
                    this.#pendingSteeringMessages.push({
                        displayText: event.data.displayText,
                        id: event.data.message.id,
                        runId: event.data.runId,
                        transcriptIndex:
                            this.#entries.length + this.#pendingSteeringMessages.length,
                    });
                }
                this.#requestRender();
                return;
            } else {
                this.#recordUserInput(event.createdAt);
                if (
                    this.#reconcileSubmittedUserEntry(event.data.message.id, event.data.displayText)
                ) {
                    if (this.#activeRun !== undefined) {
                        this.#activeLocalSessionRunId ??= event.data.runId;
                    }
                    return;
                }
            }
            this.#appendEntry({
                ...(event.data.source === "notification" ? { childText: true } : {}),
                id: event.data.message.id,
                role: event.data.source === "notification" ? "event" : "user",
                text:
                    event.data.source === "notification" &&
                    event.data.displayText.startsWith(notificationPrefix)
                        ? event.data.displayText.slice(notificationPrefix.length)
                        : event.data.displayText,
                ...(event.data.source === "notification" ? { title: "Background work" } : {}),
            });
            return;
        }

        if (event.type === "shell_command_started") {
            this.#directShellCommandsBySessionId.set(event.data.sessionId, {
                command: event.data.command,
                commandId: event.data.commandId,
            });
            this.#ensureShellCommandEntry(event.data.command, event.data.commandId);
            return;
        }

        if (event.type === "shell_command_finished") {
            const backgrounded = this.#backgroundedShellCommandIds.delete(event.data.commandId);
            if (event.data.sessionId !== undefined) {
                this.#directShellCommandsBySessionId.delete(event.data.sessionId);
                this.#yieldedBackgroundTerminals.delete(event.data.sessionId);
            }
            this.#backgroundProcesses = this.#observedShellProcesses.filter((process) =>
                this.#yieldedBackgroundTerminals.has(process.sessionId),
            );
            if (backgrounded) {
                this.#appendEntry({
                    backgroundTerminalCompletion: event.data.command,
                    role: "event",
                    text: event.data.command,
                });
                this.#requestRender();
            } else {
                this.#finishShellCommand(event.data);
            }
            return;
        }

        if (event.type === "steering_applied") {
            for (const messageId of event.data.messageIds) {
                const localSteering = this.#localSteeringSubmission(messageId);
                if (localSteering !== undefined) localSteering.applied = true;
            }
            this.#promotePendingSteeringMessages(event.data.messageIds);
            if (this.#steeringInterruptIntent?.runId === event.data.runId) {
                this.#tryRequestSteeringInterrupt(event.data.runId);
            }
            return;
        }

        if (event.type === "run_started") {
            this.#usageRequestVersion += 1;
            this.#abortNotified = false;
            // A new run must never adopt a streamed entry left behind by the previous one.
            this.#unreconciledStreamEntryIds = [];
            this.#activeSessionRunId = event.data.runId;
            this.#latestSessionRunId = event.data.runId;
            if (this.#activeRun !== undefined) {
                this.#activeLocalSessionRunId ??= event.data.runId;
            }
            this.#activeTurnEntryStart = this.#entries.length;
            this.#setRunning(true);
            this.#deferredTurnSeparator = true;
            this.#statusText = "Running";
            this.#activityStartedAtMs = this.#lastUserInputAtMs ?? this.#now();
            this.#startActivityAnimation();
            this.#requestRender();
            return;
        }

        if (event.type === "session_activity_changed") {
            const activity = event.data.activity;
            if (
                activity.runId !== undefined &&
                this.#activeSessionRunId !== undefined &&
                activity.runId !== this.#activeSessionRunId
            ) {
                return;
            }
            if (this.#running) {
                this.#statusText =
                    activity.kind === "idle" || activity.kind === "stopped"
                        ? "Idle"
                        : activity.label;
                this.#requestRender();
            }
            return;
        }

        if (event.type === "agent_event") {
            this.#applyAgentEvent(event.data.event, event.createdAt);
            return;
        }

        if (event.type === "agent_message") {
            this.#applyAgentMessage(event.data.message);
            return;
        }

        if (event.type === "user_input_requested") {
            this.#enqueueUserInputRequest(event.data);
            return;
        }

        if (event.type === "user_input_resolved") {
            this.#removeUserInputRequest(event.data.requestId);
            return;
        }

        if (event.type === "mcp_servers_changed") {
            this.#mcpServers = event.data.servers;
            const blockedServers = event.data.servers.filter(
                (server) => server.status === "blocked",
            );
            if (blockedServers.length > 0) {
                this.#appendEntry({
                    role: "event",
                    title:
                        blockedServers.length === 1 ? "MCP server blocked" : "MCP servers blocked",
                    text: "",
                    noticeChildren: blockedServers.map((server) => ({
                        label: humanizeMcpName(server.name, "MCP server"),
                        reason:
                            server.errorMessage ??
                            "This server is blocked by the current security boundary.",
                    })),
                });
            }
            this.#requestRender();
            return;
        }

        if (event.type === "tasks_changed") {
            this.#tasks = event.data.tasks;
            this.#requestRender();
            return;
        }

        if (event.type === "secrets_changed") {
            this.#secretMenu.updateAttachments(
                event.data.projectSecretIds,
                event.data.sessionSecretIds,
            );
            this.#requestRender();
            return;
        }

        if (event.type === "subagent_changed") {
            const previous = this.#subagents.find(
                (subagent) => subagent.id === event.data.subagent.id,
            );
            this.#subagents = upsertSubagentSummary(this.#subagents, event.data.subagent);
            if (this.#isActiveSubagent(event.data.subagent)) {
                this.#recordedSubagentCompletionIds.delete(event.data.subagent.id);
            }
            const becameInactive =
                previous !== undefined &&
                this.#isActiveSubagent(previous) &&
                !this.#isActiveSubagent(event.data.subagent);
            const hasActiveDescendant = this.#hasActiveSubagentDescendant(event.data.subagent.id);
            if (becameInactive && hasActiveDescendant) {
                this.#pendingSubagentCompletionIds.add(event.data.subagent.id);
            }
            if (
                previous !== undefined &&
                !this.#isActiveSubagent(event.data.subagent) &&
                !this.#recordedSubagentCompletionIds.has(event.data.subagent.id) &&
                !hasActiveDescendant &&
                (becameInactive || this.#pendingSubagentCompletionIds.has(event.data.subagent.id))
            ) {
                this.#pendingSubagentCompletionIds.delete(event.data.subagent.id);
                if (event.data.subagent.status !== "suspended") {
                    this.#recordedSubagentCompletionIds.add(event.data.subagent.id);
                }
                this.#recordSubagentCompletion(event.data.subagent);
            }
            this.#syncSubagentRefreshTimer();
            this.#requestRender();
            return;
        }

        if (event.type === "subagents_suspended") {
            this.#appendEntry({
                role: "event",
                title: "Subagents suspended",
                text: event.data.displayText,
            });
            return;
        }

        if (event.type === "workflow_changed") {
            const previous = this.#workflows.find(
                (workflow) => workflow.runId === event.data.update.runId,
            );
            this.#workflows = applyWorkflowRunUpdate(this.#workflows, event.data.update);
            const next = this.#workflows.find(
                (workflow) => workflow.runId === event.data.update.runId,
            );
            if (previous?.status === "running" && next !== undefined && next.status !== "running") {
                this.#recordWorkflowCompletion(next);
            }
            this.#requestRender();
            return;
        }

        if (event.type === "run_finished") {
            this.#finishLocalSteeringRun(event.data.runId, {
                restoreUnapplied: event.data.stopReason !== "aborted",
            });
            const turnElapsedMs =
                event.data.stopReason === "stop"
                    ? this.#elapsedSinceLastUserInput(event.createdAt)
                    : undefined;
            if (event.data.stopReason === "aborted") {
                this.#appendAbortNotice();
            } else if (event.data.stopReason !== "stop") {
                this.#deferredTurnSeparator = false;
            }
            this.#discardPendingToolCallEntries();
            if (this.#activeSessionRunId === event.data.runId) {
                this.#activeSessionRunId = undefined;
            }
            if (this.#interruptSettlementRunId === event.data.runId) {
                this.#interruptSettlementRunId = undefined;
            }
            this.#setRunning(false);
            this.#modelLocked = this.#pendingPrompts.some(
                (prompt) => prompt.shellCommand === undefined,
            );
            this.#statusText =
                event.data.stopReason === "stop" ? "Idle" : `Stopped: ${event.data.stopReason}`;
            this.#stopActivityAnimation();
            this.#streamEntryId = undefined;
            this.#thinkingEntryIdsByContentIndex.clear();
            this.#streamingThinkingEntryIds.clear();
            this.#toolCallEntryIdsByContentIndex.clear();
            this.#markActiveToolCallsStopped();
            this.#activeToolCallIds.clear();
            this.#awaitingApprovalToolCallIds.clear();
            this.#reviewingPermissionToolCallIds.clear();
            this.#runningToolCallIds.clear();
            this.#toolStatusByCallId.clear();
            this.#clearUserInputRequests();
            if (turnElapsedMs !== undefined) this.#appendTurnCompletion(turnElapsedMs);
            else this.#activeTurnEntryStart = undefined;
            this.#startDrainQueue();
            this.#requestRender();
            return;
        }

        if (event.type === "run_error") {
            this.#finishLocalSteeringRun(event.data.runId);
            this.#deferredTurnSeparator = false;
            this.#discardPendingToolCallEntries();
            if (this.#activeSessionRunId === event.data.runId) {
                this.#activeSessionRunId = undefined;
            }
            if (this.#interruptSettlementRunId === event.data.runId) {
                this.#interruptSettlementRunId = undefined;
            }
            this.#setRunning(false);
            this.#modelLocked = this.#pendingPrompts.some(
                (prompt) => prompt.shellCommand === undefined,
            );
            this.#statusText = "Error";
            this.#stopActivityAnimation();
            this.#markActiveToolCallsStopped();
            this.#activeToolCallIds.clear();
            this.#awaitingApprovalToolCallIds.clear();
            this.#reviewingPermissionToolCallIds.clear();
            this.#runningToolCallIds.clear();
            this.#toolStatusByCallId.clear();
            this.#clearUserInputRequests();
            const alreadyRendered = this.#hasActiveInferenceFailure(event.data.errorMessage);
            this.#activeTurnEntryStart = undefined;
            if (!alreadyRendered) {
                this.#appendEntry({
                    role: "error",
                    ...(event.data.providerError === undefined
                        ? {}
                        : { providerError: event.data.providerError }),
                    providerErrorFallback: event.data.errorMessage,
                    ...(event.data.providerId === undefined
                        ? {}
                        : { providerErrorProviderId: event.data.providerId }),
                    text: event.data.errorMessage,
                });
            }
            this.#startDrainQueue();
            return;
        }

        if (event.type === "session_reset") {
            this.#usageRequestVersion += 1;
            if (this.#activeSessionRunId !== undefined) {
                this.#ignoredBoundaryRunIds.add(this.#activeSessionRunId);
            }
            const discardedQueuedPrompts = this.#discardLocalPromptsForBoundary();
            this.#sessionMutationBoundaryApplied = true;
            this.#activeSessionRunId = undefined;
            this.#latestSessionRunId = undefined;
            this.#activeTurnEntryStart = undefined;
            this.#interruptSettlementRunId = undefined;
            this.#setRunning(false);
            this.#clearEntries();
            this.#pendingSteeringMessages = [];
            this.#modelLocked = false;
            this.#seenToolCallIds.clear();
            this.#streamEntryId = undefined;
            this.#thinkingEntryIdsByContentIndex.clear();
            this.#streamingThinkingEntryIds.clear();
            this.#toolCallEntryIdsByContentIndex.clear();
            this.#activeToolCallIds.clear();
            this.#awaitingApprovalToolCallIds.clear();
            this.#reviewingPermissionToolCallIds.clear();
            this.#runningToolCallIds.clear();
            this.#toolStatusByCallId.clear();
            this.#usage = zeroUsage();
            this.#latestContextTokens = 0;
            this.#sessionTokenCount = updateSessionTokenCount(this.#sessionTokenCount, {
                type: "reset",
            });
            this.#subagents = [];
            this.#lastUserInputAtMs = undefined;
            this.#workflows = [];
            this.#backgroundProcesses = [];
            this.#observedShellProcesses = [];
            this.#yieldedBackgroundTerminals.clear();
            this.#directShellCommandsBySessionId.clear();
            this.#backgroundedShellCommandIds.clear();
            this.#foregroundShellCommand = undefined;
            this.#closeBackgroundTerminalViewer();
            this.#renderedCompletionNotices.clear();
            this.#clearUserInputRequests();
            this.#appendEntry({
                role: "system",
                text:
                    discardedQueuedPrompts > 0
                        ? "Session reset. Started a new session. Queued input was saved to input history."
                        : "Session reset. Started a new session.",
            });
            return;
        }

        if (event.type === "session_rewound") {
            this.#usageRequestVersion += 1;
            if (this.#activeSessionRunId !== undefined) {
                this.#ignoredBoundaryRunIds.add(this.#activeSessionRunId);
            }
            const discardedQueuedPrompts = this.#discardLocalPromptsForBoundary();
            this.#sessionMutationBoundaryApplied = true;
            this.#activeSessionRunId = undefined;
            this.#latestSessionRunId = undefined;
            this.#interruptSettlementRunId = undefined;
            this.#setRunning(false);
            this.#pendingSteeringMessages = [];
            const targetIndex = this.#entries.findIndex(
                (entry) => entry.id === event.data.messageId,
            );
            if (targetIndex >= 0) this.#entries = this.#entries.slice(0, targetIndex);
            this.#modelLocked = false;
            this.#statusText = "Idle";
            this.#streamEntryId = undefined;
            this.#thinkingEntryIdsByContentIndex.clear();
            this.#streamingThinkingEntryIds.clear();
            this.#toolCallEntryIdsByContentIndex.clear();
            this.#activeToolCallIds.clear();
            this.#awaitingApprovalToolCallIds.clear();
            this.#reviewingPermissionToolCallIds.clear();
            this.#runningToolCallIds.clear();
            this.#toolStatusByCallId.clear();
            this.#directShellCommandsBySessionId.clear();
            this.#backgroundedShellCommandIds.clear();
            this.#foregroundShellCommand = undefined;
            this.#closeBackgroundTerminalViewer();
            this.#clearUserInputRequests();
            if (discardedQueuedPrompts > 0) {
                this.#appendEntry({
                    role: "system",
                    text: "Conversation rewound. Queued input was saved to input history.",
                });
            }
            this.#requestRender();
            return;
        }

        if (event.type === "session_title_changed") {
            return;
        }

        if (event.type === "session_configuration_changed") {
            // One change can move several settings at once, so each one that actually moved gets
            // its own row and the transcript reads the same as when they change separately.
            if (event.data.changed.includes("model")) {
                this.#usageRequestVersion += 1;
                this.#latestContextTokens = 0;
                this.#appendEntry({
                    role: "event",
                    title: "Model",
                    text: `Model changed to ${this.#modelDisplayName()}.`,
                });
            }
            if (event.data.changed.includes("effort")) {
                this.#appendEntry({
                    role: "event",
                    title: "Reasoning",
                    text: `Reasoning changed to ${humanizeReasoningLevel(event.data.effort ?? "off")}.`,
                });
            }
            if (event.data.changed.includes("serviceTier")) {
                this.#appendEntry({
                    role: "event",
                    title: "Fast mode",
                    text:
                        event.data.serviceTier === "fast"
                            ? FAST_MODE_ON_MESSAGE
                            : FAST_MODE_OFF_MESSAGE,
                });
            }
            return;
        }

        if (event.type === "permission_mode_changed") {
            this.#appendEntry({
                role: "event",
                title: "Permissions",
                text: `Permissions changed to ${humanizePermissionMode(event.data.permissionMode)}.`,
            });
            this.#requestRender();
            return;
        }

        if (event.type === "session_draft_changed") {
            this.#applyRemoteDraft(event.data.draft ?? "", event.data.origin, event.data.updatedAt);
            return;
        }
    }

    async waitForIdle(): Promise<void> {
        for (;;) {
            const activeSubmissions = [...this.#activeSubmissions];
            if (activeSubmissions.length > 0) {
                await Promise.all(activeSubmissions);
                continue;
            }

            const activeRun = this.#activeRun;
            if (activeRun !== undefined) {
                await activeRun;
                continue;
            }

            const sessionMutation = this.#activeSessionMutation;
            if (sessionMutation === undefined) return;
            await sessionMutation;
        }
    }

    handleInput(data: string): void {
        if (this.#stopped || this.#exiting) {
            return;
        }

        if (data === TERMINAL_FOCUS_IN || data === TERMINAL_FOCUS_OUT) {
            this.#setTerminalFocused(data === TERMINAL_FOCUS_IN);
            return;
        }

        const escapePressed = matchesKey(data, "escape");
        this.#onUserActivity?.();

        if (this.#backgroundTerminalViewer !== undefined) {
            this.#backgroundTerminalViewer.handleInput?.(data);
            this.#requestRender();
            return;
        }

        if (
            this.#foregroundShellCommand !== undefined &&
            (data === "\x02" || matchesKey(data, "ctrl+b"))
        ) {
            this.#foregroundShellCommand.backgroundRequested = true;
            this.#requestRender();
            return;
        }

        if (
            this.#foregroundShellCommand !== undefined &&
            (data === "\x03" || matchesKey(data, "ctrl+c"))
        ) {
            const foreground = this.#foregroundShellCommand;
            const entry = this.#entries.find((candidate) => candidate.id === foreground.commandId);
            if (entry !== undefined) entry.detail = "Stopping shell command";
            void this.#stopBackgroundProcess(foreground.sessionId).catch(() => {
                foreground.backgroundRequested = true;
            });
            this.#requestRender();
            return;
        }

        if (this.#sessionMutationInFlight) {
            this.#requestRender();
            return;
        }

        if (this.#selectionPanel !== undefined) {
            if (matchesKey(data, "ctrl+c") || data === "\x03") {
                this.#selectionPanel.handleInput?.("\x1b");
                this.#requestRender();
                return;
            }
            this.#selectionPanel.handleInput?.(data);
            this.#requestRender();
            return;
        }

        if (this.#freeformUserInput !== undefined) {
            if (this.#handlePastedInput(data)) return;
            if (matchesKey(data, "ctrl+c") || data === "\x03") {
                this.#handleCtrlC();
                return;
            }
            if (matchesKey(data, "ctrl+d") && this.#editor.getText().length === 0) {
                void this.stop();
                return;
            }
            if (matchesKey(data, "escape")) {
                if (this.#editor.getText().length > 0) {
                    this.#editor.setText("");
                } else {
                    this.#leaveFreeformUserInput();
                    this.#openUserInputQuestion();
                }
                this.#requestRender();
                return;
            }
            this.#markTypingActivity();
            this.#editor.handleInput(data);
            this.#requestRender();
            return;
        }

        if (
            this.#shellMode &&
            matchesKey(data, "backspace") &&
            this.#editor.getCursor().line === 0 &&
            this.#editor.getCursor().col === 0
        ) {
            this.#shellMode = false;
            this.#syncAutocompleteState();
            this.#requestRender();
            return;
        }

        const shellCommandInput = data.includes("\x1b")
            ? undefined
            : this.#consumeShellModePrefix(data);
        if (shellCommandInput !== undefined) {
            data = shellCommandInput;
            if (data.length === 0) {
                this.#requestRender();
                return;
            }
        }

        if (this.#handlePastedInput(data)) {
            return;
        }

        if (this.#handleImagePasteShortcut(data)) {
            return;
        }

        if (matchesKey(data, "ctrl+c") || data === "\x03") {
            this.#handleCtrlC();
            return;
        }

        if (matchesKey(data, "ctrl+d") && this.#editor.getText().length === 0) {
            void this.stop();
            return;
        }

        const previousFileMentionSuggestionCount = this.#fileMentionSnapshot()?.items.length ?? 0;
        if (this.#handleSlashCommandAutocompleteInput(data)) {
            this.#requestRender();
            return;
        }

        if (
            this.#running &&
            matchesKey(data, "tab") &&
            previousFileMentionSuggestionCount === 0 &&
            this.#queueCurrentInput()
        ) {
            return;
        }

        if (
            this.#fileMentionAutocomplete?.handleInput(
                data,
                this.#editor.getLines(),
                this.#editor.getCursor(),
                (path, context) => this.#completeFileMention(path, context),
            ) === true
        ) {
            this.#requestRender();
            return;
        }

        if (escapePressed) {
            this.#markTypingActivity();
            if (this.#editor.getText().length > 0 || !this.#openBacktrackMenu()) {
                this.#handleMainComposerEscape();
            }
            this.#requestRender();
            return;
        }

        if (this.#handleModelMenuShortcut(data)) {
            this.#requestRender();
            return;
        }

        if (this.#handleReasoningShortcut(data)) {
            this.#requestRender();
            return;
        }

        this.#markTypingActivity();
        this.#editor.handleInput(data);
        this.#syncAutocompleteState();
        this.#requestRender();
    }

    #handlePastedInput(data: string): boolean {
        if (this.#bracketedPasteBuffer !== undefined) {
            return this.#appendBracketedPaste(data);
        }

        const startIndex = data.indexOf(BRACKETED_PASTE_START);
        if (startIndex !== -1) {
            const beforePaste = data.slice(0, startIndex);
            if (beforePaste.length > 0) {
                this.#editor.handleInput(beforePaste);
            }

            const pastePayload = data.slice(startIndex + BRACKETED_PASTE_START.length);
            this.#appendBracketedPaste(pastePayload);
            return true;
        }

        if (this.#isPlainPastePayload(data)) {
            this.#insertPaste(data);
            return true;
        }

        return false;
    }

    #handleImagePasteShortcut(data: string): boolean {
        if (
            !matchesKey(data, "ctrl+v") &&
            !matchesKey(data, "alt+v") &&
            !matchesKey(data, "super+v") &&
            !IMAGE_PASTE_RAW_KEYS.has(data)
        ) {
            return false;
        }

        if (this.#imagePasteInFlight !== undefined) {
            return true;
        }

        const paste = this.#pasteClipboardImage().finally(() => {
            if (this.#imagePasteInFlight === paste) {
                this.#imagePasteInFlight = undefined;
            }
            this.#requestRender();
        });
        this.#imagePasteInFlight = paste;
        return true;
    }

    async #pasteClipboardImage(): Promise<void> {
        try {
            const image = await this.#readClipboardImage({
                outputDirectory: join(this.#cwd, ".context", "clipboard-images"),
            });
            if (image === undefined) {
                this.#appendEntry({
                    role: "event",
                    title: "Clipboard",
                    text: "No image found in the clipboard.",
                });
                return;
            }

            this.#insertPastedImage(image);
        } catch (error) {
            this.#appendEntry({
                role: "error",
                title: "Clipboard",
                text: `Image paste failed: ${errorToMessage(error)}`,
            });
        }
    }

    #insertPastedImage(image: ClipboardImage): void {
        const id = this.#nextPastedImageId++;
        const placeholder = `[Image #${id} ${this.#formatImageType(image.mediaType)}]`;
        this.#pastedImagesById.set(id, {
            data: image.data,
            mediaType: image.mediaType,
            path: image.path,
            placeholder,
        });

        const currentText = this.#editor.getText();
        const prefix = currentText.length > 0 && !/\s$/u.test(currentText) ? " " : "";
        this.#markTypingActivity();
        this.#editor.insertTextAtCursor(`${prefix}${placeholder} `);
        this.#syncAutocompleteState();
        this.#requestRender();
    }

    #appendBracketedPaste(data: string): boolean {
        const currentBuffer = this.#bracketedPasteBuffer ?? "";
        const nextBuffer = currentBuffer + data;
        const endIndex = nextBuffer.indexOf(BRACKETED_PASTE_END);

        if (endIndex === -1) {
            this.#bracketedPasteBuffer = nextBuffer;
            return true;
        }

        const pastedText = nextBuffer.slice(0, endIndex);
        const remaining = nextBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
        this.#bracketedPasteBuffer = undefined;
        this.#insertPaste(pastedText);

        if (remaining.length > 0) {
            this.handleInput(remaining);
        }

        return true;
    }

    #insertPaste(text: string): void {
        const shellCommandInput = this.#consumeShellModePrefix(text);
        const input = shellCommandInput ?? text;
        if (input.length === 0) {
            this.#syncAutocompleteState();
            this.#requestRender();
            return;
        }

        this.#markTypingActivity();
        this.#editor.handleInput(`${BRACKETED_PASTE_START}${input}${BRACKETED_PASTE_END}`);
        this.#syncAutocompleteState();
        this.#requestRender();
    }

    #consumeShellModePrefix(text: string): string | undefined {
        if (
            this.#shellMode ||
            this.#freeformUserInput !== undefined ||
            this.#editor.getText().trim().length > 0
        ) {
            return undefined;
        }

        const firstNonWhitespaceIndex = text.search(/\S/u);
        if (firstNonWhitespaceIndex < 0 || text[firstNonWhitespaceIndex] !== "!") {
            return undefined;
        }

        this.#shellMode = true;
        this.#editor.setText("");
        this.#fileMentionAutocomplete?.clear();
        this.#dismissedSlashCommandText = undefined;
        return text.slice(firstNonWhitespaceIndex + 1);
    }

    #isPlainPastePayload(data: string): boolean {
        return data.length > 1 && !data.includes("\x1b") && !matchesKey(data, "enter");
    }

    invalidate(): void {
        this.#editor.invalidate();
    }

    setTheme(theme: TerminalTheme): void {
        // Retained transcript rows are append-only: a palette change recolors
        // them through terminal palette redefinition, so the transcript and
        // header caches must keep serving the already-painted bytes.
        Object.assign(this.#theme, theme);
        this.invalidate();
        this.#requestRender();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const fullscreenComponent =
            this.#backgroundTerminalViewer ??
            (this.#selectionPanelFullscreen ? this.#selectionPanel : undefined);
        if (fullscreenComponent !== undefined) {
            if (!this.#started) return this.#fullscreenLines(fullscreenComponent, safeWidth);

            const height = this.#tui.terminal.rows;
            const retained = this.#lastNormalRender;
            if (
                retained !== undefined &&
                retained.width === safeWidth &&
                retained.height === height
            ) {
                process.nextTick(() => this.#paintTemporaryFullscreen());
                return [...retained.lines];
            }

            const resizedNormal = this.#renderNormalFrame(safeWidth, false);
            this.#lastNormalRender = { height, lines: resizedNormal, width: safeWidth };
            process.nextTick(() => this.#paintTemporaryFullscreen());
            return resizedNormal;
        }
        const normal = this.#renderNormalFrame(safeWidth);
        this.#lastNormalRender = {
            height: this.#tui.terminal.rows,
            lines: normal,
            width: safeWidth,
        };
        return normal;
    }

    #renderNormalFrame(safeWidth: number, includeFullscreenPanel = true): string[] {
        const header = this.#renderHeader(safeWidth);
        const transcript = this.#renderTranscript(safeWidth);
        if (this.#exiting) return [...header, ...transcript];
        return [
            ...header,
            ...transcript,
            ...this.#renderLiveTail(
                safeWidth,
                includeFullscreenPanel ? this.#selectionPanel : undefined,
            ),
        ];
    }

    headerRenderCacheSizeForTesting(): number {
        return this.#headerLinesByWidth.size;
    }

    #renderLiveTail(width: number, selectionPanel: Component | undefined): string[] {
        const safeWidth = Math.max(1, width);
        const slashCommandSuggestions = this.#slashCommandSuggestions();
        const fileMentionSnapshot =
            slashCommandSuggestions.length === 0 && !this.#isShellMode()
                ? this.#fileMentionSnapshot()
                : undefined;
        const footer = this.#renderFooter(
            safeWidth,
            slashCommandSuggestions.length > 0
                ? slashCommandSuggestions
                : (fileMentionSnapshot?.items ?? []),
            slashCommandSuggestions.length > 0
                ? this.#slashCommandSelectionIndex
                : (fileMentionSnapshot?.selectedIndex ?? 0),
        );
        const input = this.#renderInput(safeWidth);
        const activeWork =
            selectionPanel === undefined
                ? this.#renderActiveWorkList(safeWidth)
                : this.#renderActiveToolRows(safeWidth);
        const pendingSteering =
            selectionPanel === undefined
                ? renderPendingSteeringMessages(
                      this.#pendingSteeringMessages.map((message) => message.displayText),
                      safeWidth,
                  )
                : [];
        const queuedPrompts =
            selectionPanel === undefined ? this.#renderQueuedPrompts(safeWidth) : [];
        const activityLabel = this.#activityLabel();
        const activity =
            activityLabel !== undefined && this.#shouldRenderActivityAsLastMessage()
                ? this.#renderActivityLine(activityLabel, safeWidth)
                : [];

        return [
            "",
            ...activeWork,
            ...(activeWork.length > 0 ? [""] : []),
            ...activity,
            ...(activity.length > 0 ? [""] : []),
            ...pendingSteering,
            ...(pendingSteering.length > 0 ? [""] : []),
            ...queuedPrompts,
            ...(queuedPrompts.length > 0 ? [""] : []),
            ...(selectionPanel === undefined ? input : selectionPanel.render(safeWidth)),
            ...footer,
            "",
        ];
    }

    #submit(value: string): void {
        if (this.#freeformUserInput !== undefined) {
            this.#submitFreeformUserInput(value);
            return;
        }
        const shellMode = this.#shellMode;
        this.#shellMode = false;
        const submission = this.#submitAsync(value, shellMode).catch((error: unknown) => {
            this.#appendEntry({ role: "error", text: errorToMessage(error) });
        });
        const trackedSubmission = submission.finally(() => {
            this.#activeSubmissions.delete(trackedSubmission);
            this.#requestRender();
        });
        this.#activeSubmissions.add(trackedSubmission);
    }

    async #submitAsync(value: string, shellMode: boolean): Promise<void> {
        if (this.#compacting) {
            this.#appendEntry({
                role: "event",
                title: "Compaction",
                text: "Wait for conversation compaction to finish before submitting.",
            });
            return;
        }

        const submission = this.#createPromptSubmission(value, shellMode);
        if (submission === undefined) {
            return;
        }
        const prompt = submission.displayText;

        this.#fileMentionAutocomplete?.clear();
        this.#editor.setText("");

        if (submission.shellCommand !== undefined) {
            this.#editor.addToHistory(prompt);
            this.#pendingPrompts.push(submission);
            this.#startDrainQueue();
            this.#requestRender();
            return;
        }

        if (prompt.startsWith("/skill:")) {
            this.#editor.addToHistory(prompt);
            await this.#submitSkillCommand(prompt);
            this.#requestRender();
            return;
        }

        if (prompt === "/compact") {
            await this.#compactSession();
            this.#requestRender();
            return;
        }

        if (prompt === "/context" || prompt.startsWith("/context ")) {
            this.#editor.addToHistory(prompt);
            const text = prompt.slice("/context".length).trim();
            if (text.length === 0) {
                this.#appendEntry({
                    role: "error",
                    text: "Add the background context after /context.",
                });
            } else if (this.#agent.sendContext === undefined) {
                this.#appendEntry({
                    role: "error",
                    text: "Context notes are unavailable for this session.",
                });
            } else {
                await this.#agent.sendContext(text);
            }
            this.#requestRender();
            return;
        }

        if (this.#handleCommand(prompt)) {
            this.#requestRender();
            return;
        }

        this.#editor.addToHistory(prompt);

        if (!this.#sessionBacked) this.#recordUserInput(this.#now());
        this.#modelLocked = true;
        if (this.#running) {
            if (this.#sessionBacked && this.#activeSessionRunId === undefined) {
                this.#pendingPrompts.push(submission);
                this.#requestRender();
                return;
            }
            if (
                this.#interruptSettlementRunId !== undefined &&
                this.#interruptSettlementRunId === this.#activeSessionRunId
            ) {
                this.#pendingPrompts.push(submission);
                this.#requestRender();
                return;
            }
            const localSteering = this.#trackLocalSteeringSubmission(submission);
            try {
                const response = await this.#agent.steer(submission.content, {
                    ...(localSteering === undefined
                        ? {}
                        : { clientSubmissionId: localSteering.messageId }),
                    displayText: submission.displayText,
                    ...(localSteering === undefined ? {} : { expectedRunId: localSteering.runId }),
                });
                this.#settleLocalSteeringSubmission(localSteering, true, response);
            } catch (error) {
                if (localSteering?.invalidated === true) return;
                if (localSteering?.accepted === true) {
                    this.#settleLocalSteeringSubmission(localSteering, true);
                    return;
                }
                this.#settleLocalSteeringSubmission(localSteering, false);
                throw error;
            }
            if (!this.#sessionBacked) this.#appendEntry({ role: "user", text: prompt });
            this.#requestRender();
            return;
        }
        // Nothing is running, so this prompt starts its own turn. Claim its transcript row now
        // instead of letting it render as queued work for however long startup happens to take.
        this.#claimTranscriptRowForPrompt(submission);
        this.#pendingPrompts.push(submission);
        this.#startDrainQueue();
        this.#requestRender();
    }

    #createPromptSubmission(
        value: string,
        shellMode = this.#shellMode,
    ): PromptSubmission | undefined {
        const prompt = value.trim();
        if (prompt.length === 0 && !shellMode) {
            return undefined;
        }

        const shellCommand = shellMode ? prompt : undefined;
        const displayText = shellMode ? `!${prompt}` : prompt;
        const content =
            shellCommand === undefined
                ? (createCodeReviewPrompt(prompt) ?? this.#contentFromPrompt(prompt))
                : "";
        return {
            content,
            displayText,
            ...(shellCommand === undefined ? {} : { shellCommand }),
        };
    }

    #contentFromPrompt(prompt: string): string | readonly ContentBlock[] {
        const blocks: ContentBlock[] = [];
        let cursor = 0;
        let hasImage = false;

        for (const match of prompt.matchAll(IMAGE_PLACEHOLDER_REGEX)) {
            const rawMatch = match[0];
            const matchIndex = match.index;
            const imageId = Number(match[1]);
            const image = this.#pastedImagesById.get(imageId);
            if (image === undefined || image.placeholder !== rawMatch) {
                continue;
            }

            const text = prompt.slice(cursor, matchIndex);
            if (text.trim().length > 0) {
                blocks.push({ type: "text", text });
            }
            blocks.push({
                type: "image",
                data: image.data,
                mediaType: image.mediaType,
            });
            cursor = matchIndex + rawMatch.length;
            hasImage = true;
        }

        if (!hasImage) {
            return prompt;
        }

        const trailingText = prompt.slice(cursor);
        if (trailingText.trim().length > 0) {
            blocks.push({ type: "text", text: trailingText });
        }

        return blocks;
    }

    async #submitSkillCommand(prompt: string): Promise<void> {
        const parsed = /^\/skill:([a-z0-9-]+)(?:\s+([\s\S]*))?$/u.exec(prompt);
        if (parsed === null) {
            this.#appendEntry({
                role: "event",
                title: "Skill",
                text: "Use /skill:<name> followed by optional instructions.",
            });
            return;
        }

        await this.#refreshSkillCommands({ force: true });
        const skillName = parsed[1];
        const skill = skillName === undefined ? undefined : this.#skillsByName.get(skillName);
        if (skill === undefined) {
            this.#appendEntry({
                role: "event",
                title: "Skill",
                text: `Skill '${skillName ?? ""}' was not found.`,
            });
            return;
        }

        let content: string;
        try {
            content =
                skill.source.type === "plugin"
                    ? Buffer.from(
                          await this.#agent.context.fs.readFileBuffer(skill.filePath, {
                              maxBytes: MAXIMUM_SKILL_FILE_BYTES,
                              noFollow: true,
                          }),
                      ).toString("utf8")
                    : await this.#agent.context.fs.readFile(skill.filePath);
        } catch (error) {
            this.#appendEntry({
                role: "error",
                title: "Skill",
                text: errorToMessage(error),
            });
            return;
        }

        const expandedPrompt = formatSkillInvocation(
            skill,
            parseSkillFrontmatter(content).body,
            parsed[2] ?? "",
        );
        const submission: PromptSubmission = {
            content: expandedPrompt,
            displayText: prompt,
        };

        if (!this.#sessionBacked) this.#recordUserInput(this.#now());
        this.#modelLocked = true;
        if (this.#running) {
            if (this.#sessionBacked && this.#activeSessionRunId === undefined) {
                this.#pendingPrompts.push(submission);
                this.#requestRender();
                return;
            }
            const localSteering = this.#trackLocalSteeringSubmission(submission);
            try {
                const response = await this.#agent.steer(expandedPrompt, {
                    ...(localSteering === undefined
                        ? {}
                        : { clientSubmissionId: localSteering.messageId }),
                    displayText: prompt,
                    ...(localSteering === undefined ? {} : { expectedRunId: localSteering.runId }),
                });
                this.#settleLocalSteeringSubmission(localSteering, true, response);
            } catch (error) {
                if (localSteering?.invalidated === true) return;
                if (localSteering?.accepted === true) {
                    this.#settleLocalSteeringSubmission(localSteering, true);
                    return;
                }
                this.#settleLocalSteeringSubmission(localSteering, false);
                throw error;
            }
            if (!this.#sessionBacked) this.#appendEntry({ role: "user", text: prompt });
            return;
        }
        if (!this.#sessionBacked) {
            this.#appendEntry({ role: "user", text: prompt });
            submission.transcriptAppended = true;
        }
        this.#pendingPrompts.push(submission);
        this.#startDrainQueue();
    }

    #handleCommand(prompt: string): boolean {
        if (prompt === "/goal" || prompt.startsWith("/goal ")) {
            void this.#handleGoalCommand(prompt).catch((error: unknown) => {
                this.#appendEntry({ role: "error", text: errorToMessage(error) });
                this.#requestRender();
            });
            return true;
        }

        if (prompt === "/model") {
            this.#openModelMenu();
            return true;
        }

        if (prompt === "/effort" || prompt === "/ford") {
            this.#openReasoningMenu({
                model: this.#agent.model,
                providerId: this.#agent.provider.id,
            });
            return true;
        }

        if (prompt === "/fast" || prompt.startsWith("/fast ")) {
            this.#handleFastCommand(prompt);
            return true;
        }

        if (prompt === "/configure") {
            this.#openConfigureMenu();
            return true;
        }

        if (prompt === "/debug") {
            this.#handleDebugCommand();
            return true;
        }

        if (prompt === "/presence" || prompt === "/away") {
            this.#openPresenceMenu();
            return true;
        }

        if (prompt === "/permissions" || prompt === "/permission") {
            this.#openPermissionsMenu();
            return true;
        }

        if (prompt === "/mcp") {
            this.#showMcpStatus();
            return true;
        }

        if (prompt === "/plugins" || prompt.startsWith("/plugins ")) {
            void this.#showPlugins(prompt.slice("/plugins".length).trim()).catch(
                (error: unknown) => {
                    this.#appendEntry({
                        role: "error",
                        title: "Plugins",
                        text: errorToMessage(error),
                    });
                    this.#requestRender();
                },
            );
            return true;
        }

        if (prompt === "/secrets") {
            this.#secretMenu.open();
            return true;
        }

        if (prompt === "/usage" || prompt === "/tokens") {
            this.#showUsageSummary();
            return true;
        }

        if (prompt === "/tasks" || prompt === "/todos") {
            this.#showTasks();
            return true;
        }

        if (prompt === "/agents") {
            this.#openSubagentMonitor();
            return true;
        }

        if (prompt === "/ps") {
            this.#showBackgroundTerminals();
            return true;
        }

        if (prompt === "/stop") {
            this.#stopBackgroundTerminals();
            return true;
        }

        if (prompt === "/workflows" || prompt === "/workflow") {
            if (this.#workflowsEnabled) {
                this.#openWorkflowMonitor();
            } else {
                this.#appendEntry({
                    role: "event",
                    text: "Workflows are disabled for this session.",
                    title: "Workflows",
                });
                this.#requestRender();
            }
            return true;
        }

        if (prompt === "/new") {
            this.#resetSession();
            return true;
        }

        if (prompt === "/reload") {
            void this.stop("reload");
            return true;
        }

        if (prompt === "/exit") {
            void this.stop();
            return true;
        }

        if (prompt === "/clear") {
            this.#clearEntries();
            this.#streamEntryId = undefined;
            this.#thinkingEntryIdsByContentIndex.clear();
            this.#streamingThinkingEntryIds.clear();
            this.#toolCallEntryIdsByContentIndex.clear();
            this.#activeToolCallIds.clear();
            this.#awaitingApprovalToolCallIds.clear();
            this.#reviewingPermissionToolCallIds.clear();
            this.#runningToolCallIds.clear();
            this.#toolStatusByCallId.clear();
            this.#appendEntry({ role: "system", text: "Transcript cleared." });
            return true;
        }

        if (prompt === "/abort") {
            if (!this.#abortActiveRun()) {
                void this.#abortIdleSession();
            }
            return true;
        }

        return false;
    }

    #handleDebugCommand(): void {
        const debug = this.#debugInfo;
        if (debug === undefined) {
            this.#appendDebugInfo();
            return;
        }
        if (debug.tuiInspectorUrl === undefined && debug.tuiStderrIsTTY) {
            const finish = (start: boolean) => {
                this.#closeSelectionPanel();
                if (start) {
                    void this.#startInspectorsAndReport();
                } else {
                    this.#appendEntry({
                        role: "event",
                        text: "Live debugging was not started.",
                        title: "Debug",
                    });
                }
            };
            this.#showSelectionPanel(
                createSelectionPanel({
                    items: [
                        {
                            description: "Open local debugger ports for this TUI and daemon.",
                            label: "Start inspectors",
                            value: "start",
                        },
                        {
                            description: "Leave live debugging off.",
                            label: "Cancel",
                            value: "cancel",
                        },
                    ],
                    onCancel: () => finish(false),
                    onSelect: (item) => finish(item.value === "start"),
                    subtitle:
                        "The TUI's stderr is still this terminal. Node will write debugger connection messages here and may disturb the interface. Redirect stderr before starting when possible.",
                    theme: this.#theme,
                    title: "Start live debugging?",
                }),
            );
            return;
        }
        void this.#startInspectorsAndReport();
    }

    async #startInspectorsAndReport(): Promise<void> {
        const debug = this.#debugInfo;
        if (debug === undefined) {
            this.#appendDebugInfo();
            return;
        }
        try {
            if (debug.tuiInspectorUrl === undefined || debug.serverInspectorUrl === undefined) {
                const starting = this.#debugInspectorStart ?? debug.startInspectors();
                this.#debugInspectorStart = starting;
                const urls = await starting;
                debug.serverInspectorUrl = urls.serverInspectorUrl;
                debug.tuiInspectorUrl = urls.tuiInspectorUrl;
                if (this.#debugInspectorStart === starting) this.#debugInspectorStart = undefined;
            }
            this.#appendDebugInfo();
        } catch (error) {
            this.#debugInspectorStart = undefined;
            this.#appendEntry({
                role: "error",
                text: errorToMessage(error),
                title: "Debug",
            });
            this.#requestRender();
        }
    }

    #appendDebugInfo(): void {
        const debug = this.#debugInfo;
        const details =
            debug === undefined
                ? [{ label: "Session", reason: "Unavailable" }]
                : [
                      { label: "Session", reason: debug.sessionId },
                      { label: "State directory", reason: debug.stateDirectory },
                      { label: "Daemon log", reason: debug.daemonLogPath },
                      { label: "TUI inspector", reason: debug.tuiInspectorUrl ?? "Off" },
                      { label: "Daemon inspector", reason: debug.serverInspectorUrl ?? "Off" },
                      {
                          label: "Live state",
                          reason: "Evaluate globalThis.__rigDebug in either inspector",
                      },
                  ];
        this.#appendEntry({
            noticeChildren: details,
            role: "event",
            text: "Open either inspector and evaluate globalThis.__rigDebug to walk the live process state.",
            title: "Debug",
        });
        this.#requestRender();
    }

    #handleFastCommand(prompt: string): void {
        if (!this.#supportsFastInference()) {
            this.#appendEntry({
                role: "error",
                text: `Fast inference is not available with ${this.#agent.model.name}.`,
            });
            return;
        }

        const argument = prompt.slice("/fast".length).trim().toLowerCase();
        const fastEnabled = this.#agent.snapshot().serviceTier === "fast";
        if (argument === "status") {
            this.#appendEntry({
                role: "event",
                title: "Fast mode",
                text: fastEnabled ? "Fast mode is on." : FAST_MODE_OFF_MESSAGE,
            });
            return;
        }

        let serviceTier: ServiceTier | undefined;
        if (argument.length === 0) {
            serviceTier = fastEnabled ? undefined : "fast";
        } else if (argument === "on") {
            serviceTier = "fast";
        } else if (argument !== "off") {
            this.#appendEntry({ role: "error", text: "Usage: /fast [on|off|status]" });
            return;
        }

        const completeChange = () => {
            const effort = this.#agent.snapshot().effort ?? this.#agent.model.defaultThinkingLevel;
            this.#persistDefaultModel(
                this.#agent.model.id,
                effort,
                this.#agent.provider.id,
                this.#agent.confirmedServiceTier ?? null,
            );
            if (!this.#sessionBacked) {
                this.#appendEntry({
                    role: "event",
                    title: "Fast mode",
                    text: serviceTier === "fast" ? FAST_MODE_ON_MESSAGE : FAST_MODE_OFF_MESSAGE,
                });
            }
            this.#requestRender();
        };
        try {
            const change = this.#agent.setServiceTier(serviceTier);
            if (change === undefined) {
                completeChange();
                return;
            }
            void change.then(completeChange).catch((error: unknown) => {
                this.#appendEntry({
                    role: "error",
                    text: `Could not turn fast mode ${serviceTier === "fast" ? "on" : "off"}: ${errorToMessage(error)}`,
                });
                this.#requestRender();
            });
        } catch (error) {
            this.#appendEntry({
                role: "error",
                text: `Could not turn fast mode ${serviceTier === "fast" ? "on" : "off"}: ${errorToMessage(error)}`,
            });
            this.#requestRender();
        }
    }

    async #handleGoalCommand(prompt: string): Promise<void> {
        const argument = prompt.slice("/goal".length).trim();
        const goal = this.#agent.goal;

        if (argument.length === 0) {
            this.#appendEntry({
                role: "event",
                title: "Goal",
                text:
                    goal === undefined
                        ? "No goal is set. Use /goal followed by an objective to start one."
                        : `Status: ${humanizeGoalStatus(goal.status)}\nObjective: ${goal.objective}\n\nCommands: /goal pause, /goal resume, /goal clear`,
            });
            return;
        }

        if (argument === "pause" || argument === "resume") {
            if (this.#agent.changeGoalStatus === undefined) {
                throw new Error("Goal controls are unavailable in this session.");
            }
            const status = argument === "pause" ? "paused" : "active";
            await this.#agent.changeGoalStatus(status);
            this.#appendEntry({
                role: "event",
                title: "Goal",
                text: argument === "pause" ? "Goal paused." : "Goal resumed.",
            });
            return;
        }

        if (argument === "clear") {
            if (this.#agent.clearGoal === undefined) {
                throw new Error("Goal controls are unavailable in this session.");
            }
            await this.#agent.clearGoal();
            this.#appendEntry({ role: "event", title: "Goal", text: "Goal cleared." });
            return;
        }

        if (this.#agent.setGoal === undefined) {
            throw new Error("Goal controls are unavailable in this session.");
        }
        await this.#agent.setGoal(argument);
        this.#appendEntry({
            role: "event",
            title: "Goal",
            text: `Goal started: ${argument}`,
        });
    }

    #showMcpStatus(): void {
        if (this.#mcpServers.length === 0) {
            this.#appendEntry({
                role: "event",
                title: "MCP servers",
                text: "No MCP servers have connected in this session.",
            });
            return;
        }
        const text = this.#mcpServers
            .map((server) => {
                if (server.status === "connected") {
                    const capabilities = [
                        server.resourceSupport === true ? "resources" : undefined,
                        server.promptSupport === true ? "prompts" : undefined,
                    ].filter((value) => value !== undefined);
                    return `${server.name}: connected with ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}${capabilities.length === 0 ? "" : `, ${capabilities.join(" and ")}`}`;
                }
                if (server.status === "disabled") return `${server.name}: disabled`;
                if (server.status === "blocked") {
                    return `${server.name}: blocked${server.errorMessage === undefined ? "" : ` — ${server.errorMessage}`}`;
                }
                return `${server.name}: could not connect${server.errorMessage === undefined ? "" : ` — ${server.errorMessage}`}`;
            })
            .join("\n");
        this.#appendEntry({ role: "event", title: "MCP servers", text });
    }

    async #showPlugins(name: string): Promise<void> {
        const plugins = this.#agent.context.plugins;
        if (plugins === undefined) throw new Error("Plugins are unavailable in this session.");
        if (name.length > 0) {
            const log = await plugins.readLog(name);
            const text = `${log.truncated ? "[Earlier plugin output omitted.]\n" : ""}${log.text}`;
            const displayText =
                log.error !== undefined && log.error !== log.text
                    ? `${log.error}${text.length === 0 ? "" : `\n\n${text}`}`
                    : text;
            this.#appendEntry({
                role: "event",
                title: `${log.name} · ${PLUGIN_STATUS_LABELS[log.status]}`,
                text:
                    displayText.length === 0
                        ? "This plugin has not written any output."
                        : displayText,
            });
            this.#requestRender();
            return;
        }
        const result = await plugins.list();
        const lines = [
            ...result.plugins.map(
                (plugin) =>
                    `${plugin.name}: ${PLUGIN_STATUS_LABELS[plugin.status]}${plugin.error === undefined ? "" : ` — ${plugin.error}`}`,
            ),
            ...result.failures.map(
                (failure) => `${failure.folder}: could not register — ${failure.error}`,
            ),
        ];
        this.#appendEntry({
            role: "event",
            title: "Plugins",
            text:
                lines.length === 0
                    ? "No plugins are installed."
                    : `${lines.join("\n")}\n\nUse /plugins <name> to read the bounded current log.`,
        });
        this.#requestRender();
    }

    #showUsageSummary(): void {
        if (this.#agent.getUsage !== undefined) {
            const version = ++this.#usageRequestVersion;
            void this.#agent
                .getUsage()
                .then((summary) => {
                    if (version !== this.#usageRequestVersion) return;
                    this.#appendEntry({
                        childText: true,
                        role: "event",
                        title: "Usage",
                        text: formatSessionUsageSummary(
                            summary,
                            this.#agent.modelChoices ?? [
                                { model: this.#agent.model, providerId: this.#agent.provider.id },
                            ],
                            this.#now(),
                        ),
                    });
                })
                .catch(() => {
                    if (version !== this.#usageRequestVersion) return;
                    this.#appendEntry({
                        role: "event",
                        title: "Usage",
                        text: "Usage unavailable.",
                    });
                });
            return;
        }

        const contextWindow = this.#agent.model.contextWindow;
        const context =
            contextWindow === undefined
                ? `${formatTokens(this.#latestContextTokens)} tokens in the latest context`
                : `${formatTokens(this.#latestContextTokens)} of ${formatTokens(contextWindow)} context tokens (${Math.max(0, Math.round((1 - this.#latestContextTokens / contextWindow) * 100))}% left)`;
        this.#appendEntry({
            role: "event",
            title: "Token usage",
            text: [
                context,
                `Input: ${formatTokens(this.#usage.input)}`,
                `Output: ${formatTokens(this.#usage.output)}`,
                `Cache read: ${formatTokens(this.#usage.cacheRead)}`,
                `Cache write: ${formatTokens(this.#usage.cacheWrite)}`,
                `Session tokens: ${formatTokens(this.#sessionTokenCount.totalTokens)}`,
            ].join("\n"),
        });
    }

    #showTasks(): void {
        if (this.#tasks.length === 0) {
            this.#appendEntry({
                role: "event",
                title: "Tasks",
                text: "No tasks are being tracked in this session.",
            });
            return;
        }
        const status = {
            completed: "Completed",
            in_progress: "In progress",
            pending: "Pending",
        } as const;
        this.#appendEntry({
            role: "event",
            title: "Tasks",
            text: this.#tasks
                .map((task) => `#${task.id} · ${status[task.status]} · ${task.subject}`)
                .join("\n"),
        });
    }

    #openSubagentMonitor(): void {
        const monitor = createSubagentMonitor({
            getHeight: () => Math.max(1, this.#tui.terminal.rows),
            getSubagents: () => this.#subagents,
            modelName: (modelId) =>
                this.#agent.modelChoices?.find((choice) => choice.model.id === modelId)?.model
                    .name ??
                (modelId === this.#agent.model.id ? this.#agent.model.name : undefined) ??
                modelId
                    .split("/")
                    .at(-1)
                    ?.split(/[-_]/u)
                    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
                    .join(" ") ??
                "Unknown model",
            now: this.#now,
            onCancel: () => this.#closeSelectionPanel(),
            onRequestRender: () => this.#requestRender(),
            theme: this.#theme,
            watchSubagent: async (sessionId, signal, onEvent) => {
                if (this.#watchSubagentEvents === undefined) {
                    throw new Error("Live subagent logs are unavailable in this session.");
                }
                await this.#watchSubagentEvents(sessionId, signal, onEvent);
            },
        });
        this.#showSelectionPanel(monitor);
    }

    #showBackgroundTerminals(): void {
        if (this.#backgroundProcesses.length === 0) {
            this.#appendEntry({
                role: "event",
                title: "Background terminals",
                text: "No background terminals running.",
            });
            return;
        }
        if (this.#backgroundProcesses.length === 1) {
            const process = this.#backgroundProcesses[0];
            if (process !== undefined) this.#openBackgroundTerminalViewer(process);
            return;
        }

        this.#showSelectionPanel(
            createSelectionPanel({
                items: this.#backgroundProcesses.map((process) => ({
                    description: process.cwd,
                    label: process.command.replaceAll("\n", " "),
                    value: String(process.sessionId),
                })),
                onCancel: () => this.#closeSelectionPanel(),
                onSelect: (item) => {
                    const process = this.#backgroundProcesses.find(
                        (candidate) => String(candidate.sessionId) === item.value,
                    );
                    if (process !== undefined) this.#openBackgroundTerminalViewer(process);
                },
                subtitle: "Choose a terminal to inspect its live output.",
                theme: this.#theme,
                title: "Background terminals",
            }),
        );
    }

    #openBackgroundTerminalViewer(process: BashSessionActivity): void {
        this.#closeBackgroundTerminalViewer();
        const controller = new AbortController();
        const viewer = createBackgroundTerminalViewer({
            command: process.command,
            cwd: process.cwd,
            height: () => this.#tui.terminal.rows,
            onCancel: () => this.#closeBackgroundTerminalViewer(),
            onRequestRender: () => this.#requestRender(),
            onStop: async () => {
                const result = await this.#stopBackgroundProcess(process.sessionId);
                return result;
            },
            theme: this.#theme,
        });
        this.#backgroundTerminalViewer = viewer;
        this.#backgroundTerminalViewerController = controller;
        this.#syncTemporaryFullscreen();
        this.#closeSelectionPanel();
        void this.#pollBackgroundTerminalViewer(viewer, process.sessionId, controller.signal);
        this.#requestRender();
    }

    #closeBackgroundTerminalViewer(): void {
        this.#backgroundTerminalViewerController?.abort();
        this.#backgroundTerminalViewerController = undefined;
        this.#backgroundTerminalViewer = undefined;
        this.#syncTemporaryFullscreen();
    }

    async #pollBackgroundTerminalViewer(
        viewer: BackgroundTerminalViewer,
        sessionId: number,
        signal: AbortSignal,
    ): Promise<void> {
        try {
            while (!signal.aborted && this.#backgroundTerminalViewer === viewer) {
                const snapshot = await this.#readBackgroundProcess(sessionId, 500);
                if (signal.aborted || this.#backgroundTerminalViewer !== viewer) return;
                if (snapshot === undefined) {
                    viewer.setError("The background terminal is no longer available.");
                    this.#requestRender();
                    return;
                }
                viewer.update(snapshot);
                this.#requestRender();
                if (snapshot.status !== "running") return;
            }
        } catch (error) {
            if (signal.aborted || this.#backgroundTerminalViewer !== viewer) return;
            viewer.setError(errorToMessage(error));
            this.#requestRender();
        }
    }

    #stopBackgroundTerminals(): void {
        this.#appendEntry({
            role: "event",
            title: "Background terminals",
            text: "Stopping all background terminals.",
        });
        this.#stoppingBackgroundTerminals = true;
        const stop =
            this.#agent.stopBackgroundProcesses === undefined
                ? (this.#agent.context.bash.killAllSessions?.() ?? Promise.resolve(0))
                : this.#agent.stopBackgroundProcesses();
        void stop
            .then(() => {
                this.#backgroundProcesses = [];
                this.#yieldedBackgroundTerminals.clear();
                this.#requestRender();
            })
            .catch((error: unknown) => {
                this.#appendEntry({
                    role: "error",
                    title: "Background terminals",
                    text: errorToMessage(error),
                });
                this.#requestRender();
            })
            .finally(() => {
                this.#stoppingBackgroundTerminals = false;
            });
    }

    #openWorkflowMonitor(initialRunId?: string): void {
        this.#showSelectionPanel(
            createWorkflowMonitor({
                theme: this.#theme,
                getSubagents: () => this.#subagents,
                getWorkflows: () => this.#workflows,
                ...(initialRunId === undefined ? {} : { initialRunId }),
                now: this.#now,
                onCancel: () => this.#closeSelectionPanel(),
                onRequestRender: () => this.#requestRender(),
                onStop: async (runId) => {
                    if (this.#onStopWorkflow === undefined) {
                        this.#appendEntry({
                            role: "event",
                            text: "Workflow controls are unavailable in this session.",
                            title: "Workflows",
                        });
                        this.#closeSelectionPanel();
                        return;
                    }
                    try {
                        await this.#onStopWorkflow(runId);
                    } catch (error) {
                        this.#appendEntry({
                            role: "error",
                            text: errorToMessage(error),
                            title: "Workflow",
                        });
                        this.#closeSelectionPanel();
                    }
                },
            }),
        );
    }

    async #compactSession(): Promise<void> {
        if (this.#compacting || this.#running || this.#pendingPrompts.length > 0) {
            this.#appendEntry({
                role: "event",
                title: "Compaction",
                text: "Wait for the active response to finish before compacting.",
            });
            return;
        }

        this.#compacting = true;
        this.#statusText = "Compacting conversation";
        this.#startActivityAnimation();
        this.#requestRender();
        try {
            const result = await this.#agent.compact(
                undefined,
                this.#sessionBacked ? undefined : (event) => this.#applyAgentEvent(event),
            );
            if (!result.compacted) {
                this.#appendEntry({
                    role: "event",
                    title: "Compaction",
                    text: "There is not enough conversation history to compact yet.",
                });
            }
        } finally {
            this.#compacting = false;
            this.#statusText = "Idle";
            this.#stopActivityAnimation();
            this.#requestRender();
        }
    }

    #resetSession(): void {
        if (this.#sessionMutationInFlight) return;
        this.#usageRequestVersion += 1;
        const discardedQueuedPrompts = this.#discardLocalPromptsForBoundary();
        if (this.#activeSessionRunId !== undefined) {
            this.#ignoredBoundaryRunIds.add(this.#activeSessionRunId);
        }
        this.#sessionMutationInFlight = true;
        this.#sessionMutationBoundaryApplied = false;
        this.#statusText = "Resetting session";
        this.#requestRender();
        const mutation = this.#agent
            .reset()
            .then(() => {
                if (!this.#sessionMutationBoundaryApplied) {
                    this.#clearEntries();
                    this.#modelLocked = false;
                    this.#seenToolCallIds.clear();
                    this.#streamEntryId = undefined;
                    this.#thinkingEntryIdsByContentIndex.clear();
                    this.#streamingThinkingEntryIds.clear();
                    this.#toolCallEntryIdsByContentIndex.clear();
                    this.#activeToolCallIds.clear();
                    this.#awaitingApprovalToolCallIds.clear();
                    this.#reviewingPermissionToolCallIds.clear();
                    this.#runningToolCallIds.clear();
                    this.#toolStatusByCallId.clear();
                    this.#usage = zeroUsage();
                    this.#latestContextTokens = 0;
                    this.#sessionTokenCount = updateSessionTokenCount(this.#sessionTokenCount, {
                        type: "reset",
                    });
                    this.#lastUserInputAtMs = undefined;
                    this.#abortNotified = false;
                    this.#statusText = "Idle";
                    this.#appendEntry({
                        role: "system",
                        text:
                            discardedQueuedPrompts > 0
                                ? "Session reset. Started a new session. Queued input was saved to input history."
                                : "Session reset. Started a new session.",
                    });
                }
            })
            .catch((error: unknown) => {
                this.#statusText = "Error";
                this.#appendEntry({
                    role: "error",
                    text: `The session could not be reset: ${errorToMessage(error)}`,
                });
            })
            .finally(() => {
                this.#sessionMutationInFlight = false;
                if (this.#activeSessionMutation === mutation) {
                    this.#activeSessionMutation = undefined;
                }
                this.#requestRender();
            });
        this.#activeSessionMutation = mutation;
    }

    #startDrainQueue(): void {
        if (
            this.#activeRun !== undefined ||
            this.#compacting ||
            this.#interruptRequestInFlight ||
            this.#interruptSettlementRunId !== undefined ||
            this.#running ||
            this.#pendingPrompts.length === 0
        ) {
            return;
        }

        this.#activeRun = this.#drainQueue().finally(() => {
            this.#activeRun = undefined;
            this.#startDrainQueue();
            this.#requestRender();
        });
    }

    async #drainQueue(): Promise<void> {
        while (!this.#stopped) {
            if (this.#interruptRequestInFlight || this.#interruptSettlementRunId !== undefined) {
                break;
            }
            const prompt = this.#pendingPrompts[0];
            if (prompt === undefined) {
                break;
            }

            if (prompt.shellCommand !== undefined) {
                this.#pendingPrompts.shift();
                await this.#runShellCommand(prompt.shellCommand);
                continue;
            }

            await this.#runPrompt(prompt);
        }
    }

    async #runPrompt(prompt: PendingPrompt): Promise<void> {
        const controller = new AbortController();
        const runToken = ++this.#runToken;
        this.#activeLocalSessionRunId = undefined;
        this.#abortController = controller;
        this.#abortNotified = false;
        this.#setRunning(true);
        this.#deferredTurnSeparator = true;
        this.#statusText = "Running";
        this.#streamEntryId = undefined;
        this.#unreconciledStreamEntryIds = [];
        this.#thinkingEntryIdsByContentIndex.clear();
        this.#streamingThinkingEntryIds.clear();
        this.#toolCallEntryIdsByContentIndex.clear();
        this.#activeToolCallIds.clear();
        this.#awaitingApprovalToolCallIds.clear();
        this.#reviewingPermissionToolCallIds.clear();
        this.#runningToolCallIds.clear();
        this.#toolStatusByCallId.clear();
        this.#activityStartedAtMs = this.#lastUserInputAtMs ?? this.#now();
        this.#startActivityAnimation();
        this.#requestRender();

        let turnCompleted = false;
        const hasNewerSessionRun = () =>
            this.#sessionBacked &&
            this.#activeLocalSessionRunId !== undefined &&
            this.#latestSessionRunId !== undefined &&
            this.#latestSessionRunId !== this.#activeLocalSessionRunId;
        try {
            await this.#refreshSkillCommands({ force: true });
            if (!this.#isCurrentRun(runToken)) {
                return;
            }

            if (this.#pendingPrompts[0] !== prompt) {
                return;
            }
            this.#pendingPrompts.shift();
            this.#claimTranscriptRowForPrompt(prompt);
            this.#activeTurnEntryStart = this.#entries.length;

            const result = await this.#agent.send(prompt.content, {
                ...(this.#sessionBacked && prompt.transcriptEntryId !== undefined
                    ? { clientSubmissionId: prompt.transcriptEntryId }
                    : {}),
                displayText: prompt.displayText,
                signal: controller.signal,
                ...(this.#sessionBacked
                    ? {}
                    : {
                          onEvent: (event) => this.#handleAgentEvent(event, runToken),
                          onMessage: (message) => this.#handleAgentMessage(message, runToken),
                      }),
            });
            if (!this.#isCurrentRun(runToken)) {
                return;
            }
            if (this.#sessionBacked) this.#activeLocalSessionRunId ??= result.runId;
            if (hasNewerSessionRun()) return;

            if (result.stopReason === "aborted") {
                this.#statusText = "Idle";
                this.#appendAbortNotice();
            } else {
                turnCompleted = result.stopReason === "stop";
                if (!turnCompleted) {
                    this.#deferredTurnSeparator = false;
                }
                this.#statusText =
                    result.stopReason === "stop" ? "Idle" : `Stopped: ${result.stopReason}`;
            }
        } catch (error) {
            if (!this.#isCurrentRun(runToken)) {
                return;
            }
            if (hasNewerSessionRun()) return;
            if (controller.signal.aborted) {
                this.#statusText = "Idle";
                this.#appendAbortNotice();
            } else {
                this.#deferredTurnSeparator = false;
                this.#statusText = "Error";
                this.#appendEntry({ role: "error", text: errorToMessage(error) });
            }
        } finally {
            if (this.#isCurrentRun(runToken)) {
                if (this.#abortController === controller) {
                    this.#abortController = undefined;
                }
                const preserveSessionRun = hasNewerSessionRun();
                this.#activeLocalSessionRunId = undefined;
                if (!preserveSessionRun) {
                    this.#setRunning(false);
                    this.#discardPendingToolCallEntries();
                    this.#stopActivityAnimation();
                    this.#streamEntryId = undefined;
                    this.#thinkingEntryIdsByContentIndex.clear();
                    this.#streamingThinkingEntryIds.clear();
                    this.#toolCallEntryIdsByContentIndex.clear();
                    this.#activeToolCallIds.clear();
                    this.#awaitingApprovalToolCallIds.clear();
                    this.#reviewingPermissionToolCallIds.clear();
                    this.#runningToolCallIds.clear();
                    this.#toolStatusByCallId.clear();
                    const turnElapsedMs =
                        !this.#sessionBacked && turnCompleted
                            ? this.#elapsedSinceLastUserInput(this.#now())
                            : undefined;
                    if (turnElapsedMs !== undefined) this.#appendTurnCompletion(turnElapsedMs);
                    else this.#activeTurnEntryStart = undefined;
                }
                this.#requestRender();
            }
        }
    }

    #handleMainComposerEscape(): void {
        if (this.#shellMode && this.#editor.getText().length === 0) {
            this.#shellMode = false;
            return;
        }

        if (this.#editor.getText().length > 0) {
            this.#clearComposerDraftToHistory();
            return;
        }

        if (this.#running) {
            if (this.#interruptRequestInFlight) return;
            if (
                this.#sessionBacked &&
                this.#agent.abort !== undefined &&
                this.#activeSessionRunId !== undefined &&
                this.#hasLocalOrPendingSteering(this.#activeSessionRunId)
            ) {
                this.#requestSteeringInterrupt(this.#activeSessionRunId);
                return;
            }

            this.#restoreQueuedPromptsToComposer();
            if (this.#abortActiveRun()) return;
            if (this.#sessionBacked && this.#agent.abort !== undefined) {
                this.#requestSessionInterrupt(false);
            }
            return;
        }

        this.#restoreQueuedPromptsToComposer();
    }

    /**
     * Shares the composer with the other clients on this session: the unsent
     * message is restored here after a restart and follows the user to another
     * terminal or an external client.
     */
    #startDraftSync(): void {
        const setDraft = this.#agent.setDraft?.bind(this.#agent);
        if (setDraft === undefined) return;
        const origin = this.#idFactory();
        this.#draftSync = new SessionDraftSync({
            draft: this.#agent.draft ?? "",
            ...(this.#agent.draftUpdatedAt === undefined
                ? {}
                : { draftUpdatedAt: this.#agent.draftUpdatedAt }),
            now: this.#now,
            origin,
            push: (draft, updatedAt) => setDraft(draft, { origin, updatedAt }),
            // A draft that fails to sync stays in this composer. It is never
            // worth interrupting the session over.
            onError: () => {},
        });
        const restored = this.#agent.draft ?? "";
        if (restored.length > 0) this.#editor.setText(restored);
        this.#editor.onChange = (text) => {
            // While the composer is answering a question it is not the draft.
            if (this.#freeformUserInput !== undefined) return;
            this.#draftSync?.recordLocalText(text);
        };
    }

    #applyRemoteDraft(draft: string, origin: string | undefined, updatedAt: number): void {
        const text = this.#draftSync?.applyRemoteDraft(draft, origin, updatedAt);
        if (text === undefined) return;
        if (this.#freeformUserInput !== undefined) return;
        if (this.#editor.getText() === text) return;
        this.#editor.setText(text);
        this.#fileMentionAutocomplete?.clear();
        this.#requestRender();
    }

    /**
     * Leaves the question composer and returns it to the shared draft.
     *
     * The editor is cleared while `#freeformUserInput` still suppresses draft
     * writes, so borrowing the composer to answer a question never clears the
     * draft that the other clients on this session are showing.
     */
    #leaveFreeformUserInput(): void {
        if (this.#freeformUserInput === undefined) return;
        this.#editor.setText("");
        this.#freeformUserInput = undefined;
        this.#restoreComposerDraft();
    }

    /** Returns the composer to the shared draft after a question releases it. */
    #restoreComposerDraft(): void {
        const draft = this.#draftSync?.remote ?? "";
        if (draft.length === 0) return;
        this.#editor.setText(draft);
    }

    async #stopDraftSync(): Promise<void> {
        const sync = this.#draftSync;
        if (sync === undefined) return;
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                sync.flush(),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, DRAFT_FLUSH_TIMEOUT_MS);
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            // Disposing before teardown clears the editor keeps the stored
            // draft intact for the next terminal that opens this session.
            sync.dispose();
        }
    }

    #clearComposerDraftToHistory(): void {
        const editorText = this.#editor.getText();
        if (editorText.length === 0) return;
        const draft = editorText.trim();
        if (draft.length > 0) this.#editor.addToHistory(this.#shellMode ? `!${draft}` : draft);
        this.#editor.setText("");
        this.#shellMode = false;
        this.#fileMentionAutocomplete?.clear();
        this.#dismissedSlashCommandText = undefined;
    }

    #hasLocalOrPendingSteering(runId: string): boolean {
        return (
            this.#steeringInterruptIntent?.runId === runId ||
            [...this.#inFlightSteeringSubmissions.values()].some(
                (submission) => submission.runId === runId,
            ) ||
            this.#steeringMessageIdsForRun(runId).length > 0
        );
    }

    #requestSteeringInterrupt(runId: string): void {
        if (this.#steeringInterruptIntent?.runId !== runId) {
            this.#steeringInterruptIntent = { runId };
        }
        this.#interruptSettlementRunId = runId;
        this.#statusText = "Sending pending messages";
        this.#requestRender();
        this.#tryRequestSteeringInterrupt(runId);
    }

    #tryRequestSteeringInterrupt(runId: string): void {
        const intent = this.#steeringInterruptIntent;
        if (intent?.runId !== runId) return;
        if (
            [...this.#inFlightSteeringSubmissions.values()].some(
                (submission) => submission.runId === runId,
            )
        ) {
            return;
        }
        if (!this.#running || this.#activeSessionRunId !== runId) {
            this.#clearSteeringInterrupt(runId);
            return;
        }
        const steeringMessageIds = this.#steeringMessageIdsForRun(runId);
        if (steeringMessageIds.length === 0) {
            this.#clearSteeringInterrupt(runId);
            return;
        }

        this.#steeringInterruptIntent = undefined;
        this.#requestSessionInterrupt(true, steeringMessageIds);
    }

    #steeringMessageIdsForRun(runId: string): string[] {
        const messageIds = [
            ...this.#acceptedSteeringSubmissions
                .filter((submission) => submission.runId === runId && submission.accepted)
                .sort((left, right) => left.id - right.id)
                .map((submission) => submission.messageId),
            ...this.#pendingSteeringMessages
                .filter((pending) => pending.runId === runId)
                .sort((left, right) => left.transcriptIndex - right.transcriptIndex)
                .map((pending) => pending.id),
        ];
        return [...new Set(messageIds)].filter(
            (messageId) => !this.#continuationRequestedSteeringMessageIds.has(messageId),
        );
    }

    #clearSteeringInterrupt(runId: string, options: { startDrain?: boolean } = {}): void {
        if (this.#steeringInterruptIntent?.runId === runId) {
            this.#steeringInterruptIntent = undefined;
        }
        if (!this.#interruptRequestInFlight && this.#interruptSettlementRunId === runId) {
            this.#interruptSettlementRunId = undefined;
        }
        if (this.#running && this.#activeSessionRunId === runId) {
            this.#statusText = "Running";
        }
        if (options.startDrain !== false) this.#startDrainQueue();
        this.#requestRender();
    }

    #requestSessionInterrupt(
        continuePendingSteering: boolean,
        steeringMessageIds: readonly string[] = [],
    ): void {
        if (this.#agent.abort === undefined || this.#interruptRequestInFlight) return;
        this.#interruptRequestInFlight = true;
        this.#interruptSettlementRunId = this.#activeSessionRunId;
        this.#statusText = continuePendingSteering ? "Sending pending messages" : "Stopping";
        this.#requestRender();
        if (continuePendingSteering) {
            for (const messageId of steeringMessageIds) {
                this.#continuationRequestedSteeringMessageIds.add(messageId);
            }
        }
        const request = continuePendingSteering
            ? this.#agent.abort({
                  continuePendingSteering: true,
                  ...(this.#activeSessionRunId === undefined
                      ? {}
                      : { expectedRunId: this.#activeSessionRunId }),
                  steeringMessageIds,
              })
            : this.#agent.abort(
                  this.#activeSessionRunId === undefined
                      ? undefined
                      : { expectedRunId: this.#activeSessionRunId },
              );
        void request
            .then((response) => {
                if (continuePendingSteering && response.continued !== true) {
                    for (const messageId of steeringMessageIds) {
                        this.#continuationRequestedSteeringMessageIds.delete(messageId);
                    }
                }
                if (this.#running) this.#statusText = "Running";
            })
            .catch((error: unknown) => {
                for (const messageId of steeringMessageIds) {
                    this.#continuationRequestedSteeringMessageIds.delete(messageId);
                }
                this.#interruptSettlementRunId = undefined;
                this.#statusText = "Error";
                this.#appendEntry({ role: "error", text: errorToMessage(error) });
            })
            .finally(() => {
                this.#interruptRequestInFlight = false;
                if (!this.#running) this.#interruptSettlementRunId = undefined;
                this.#startDrainQueue();
                this.#requestRender();
            });
    }

    #openBacktrackMenu(): boolean {
        if (this.#running || !this.#sessionBacked || this.#agent.rewind === undefined) {
            return false;
        }
        const userEntries = this.#entries.filter((entry) => entry.role === "user");
        if (userEntries.length === 0) return false;

        const items = [...userEntries].reverse().map((entry) => ({
            description: entry.text.replaceAll("\n", " ").trim() || "Message with attachments",
            label: entry.text.split("\n")[0]?.trim() || "Message with attachments",
            value: entry.id,
        }));
        this.#showSelectionPanel(
            createSelectionPanel({
                theme: this.#theme,
                items,
                onCancel: () => this.#closeSelectionPanel(),
                onSelect: (item) => {
                    if (this.#agent.rewind === undefined) return;
                    this.#closeSelectionPanel();
                    this.#discardLocalPromptsForBoundary();
                    this.#sessionMutationInFlight = true;
                    this.#sessionMutationBoundaryApplied = false;
                    this.#statusText = "Rewinding";
                    this.#requestRender();
                    const mutation = this.#agent
                        .rewind(item.value)
                        .then((message) => this.#finishBacktrack(item.value, message))
                        .catch((error: unknown) => {
                            this.#statusText = "Error";
                            this.#appendEntry({ role: "error", text: errorToMessage(error) });
                        })
                        .finally(() => {
                            this.#sessionMutationInFlight = false;
                            if (this.#activeSessionMutation === mutation) {
                                this.#activeSessionMutation = undefined;
                            }
                            this.#requestRender();
                        });
                    this.#activeSessionMutation = mutation;
                },
                subtitle: "Choose a prompt to edit again. Files stay unchanged.",
                title: "Rewind conversation",
            }),
        );
        return true;
    }

    #finishBacktrack(messageId: string, message: UserMessage): void {
        const targetIndex = this.#entries.findIndex((entry) => entry.id === messageId);
        if (targetIndex >= 0) this.#entries = this.#entries.slice(0, targetIndex);
        this.#shellMode = false;
        this.#editor.setText(
            message.blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
        );
        this.#syncAutocompleteState();
        this.#modelLocked = false;
        this.#statusText = "Idle";
        this.#requestRender();
    }

    // A prompt owns its transcript row from the moment it is shown as submitted work. Claiming
    // the row up front lets the queued list skip it, so the text is never drawn in both places
    // and never moves between them.
    #claimTranscriptRowForPrompt(prompt: PendingPrompt): void {
        if (prompt.transcriptAppended === true) return;
        const entry = this.#appendEntry({ role: "user", text: prompt.displayText });
        prompt.transcriptAppended = true;
        prompt.transcriptEntryId = entry.id;
        if (!this.#sessionBacked) return;
        this.#pendingSubmittedUserEntries.push(entry);
        if (this.#pendingSubmittedUserEntries.length > 100) {
            this.#pendingSubmittedUserEntries.shift();
        }
    }

    // Escape pulls unstarted prompts back into the composer. A prompt that claimed a transcript
    // row never ran, so its row is released with it rather than left behind as phantom history.
    #releaseTranscriptRowForPrompt(prompt: PendingPrompt): void {
        const entryId = prompt.transcriptEntryId;
        if (prompt.transcriptAppended !== true || entryId === undefined) return;
        const index = this.#entries.findIndex((entry) => entry.id === entryId);
        if (index >= 0) this.#entries.splice(index, 1);
        this.#pendingSubmittedUserEntries = this.#pendingSubmittedUserEntries.filter(
            (entry) => entry.id !== entryId,
        );
        prompt.transcriptAppended = false;
        delete prompt.transcriptEntryId;
    }

    #restoreQueuedPromptsToComposer(): void {
        if (this.#pendingPrompts.length === 0) return;
        const draft = this.#editor.getText().trim();
        const shellCommand =
            this.#pendingPrompts.length === 1 && draft.length === 0
                ? this.#pendingPrompts[0]?.shellCommand
                : undefined;
        const restored = this.#pendingPrompts.map((prompt) => prompt.displayText);
        if (draft.length > 0) restored.push(draft);
        for (const prompt of this.#pendingPrompts) this.#releaseTranscriptRowForPrompt(prompt);
        this.#pendingPrompts = [];
        this.#shellMode = shellCommand !== undefined;
        this.#editor.setText(shellCommand ?? restored.join("\n"));
        this.#syncAutocompleteState();
    }

    #trackLocalSteeringSubmission(
        submission: PromptSubmission,
    ): LocalSteeringSubmission | undefined {
        if (!this.#sessionBacked || this.#activeSessionRunId === undefined) return undefined;
        const local: LocalSteeringSubmission = {
            accepted: false,
            applied: false,
            id: this.#nextSteeringSubmissionId++,
            invalidated: false,
            messageId: this.#idFactory(),
            runEnded: false,
            runId: this.#activeSessionRunId,
            submission,
        };
        this.#inFlightSteeringSubmissions.set(local.id, local);
        return local;
    }

    #settleLocalSteeringSubmission(
        local: LocalSteeringSubmission | undefined,
        accepted: boolean,
        response?: void | SteerMessageResponse,
    ): void {
        if (local === undefined) return;
        this.#inFlightSteeringSubmissions.delete(local.id);
        if (local.invalidated) return;
        if (response?.delivery === "run") {
            local.invalidated = true;
            this.#tryRequestSteeringInterrupt(local.runId);
            this.#requestRender();
            return;
        }

        if (response !== undefined) local.runId = response.runId;
        local.accepted ||= accepted;

        if (local.accepted) {
            if (local.runEnded && !local.applied) {
                this.#rejectedSteeringSubmissions.set(local.id, local);
                this.#removePendingSteeringMessage(local.messageId);
            } else if (
                !local.runEnded &&
                !this.#acceptedSteeringSubmissions.some((submission) => submission.id === local.id)
            ) {
                this.#acceptedSteeringSubmissions.push(local);
            }
        } else {
            this.#rejectedSteeringSubmissions.set(local.id, local);
        }

        const runHasInFlight = [...this.#inFlightSteeringSubmissions.values()].some(
            (submission) => submission.runId === local.runId,
        );
        if (!runHasInFlight) this.#restoreRejectedSteeringSubmissions(local.runId);
        this.#tryRequestSteeringInterrupt(local.runId);
        this.#requestRender();
    }

    #localSteeringSubmission(messageId: string): LocalSteeringSubmission | undefined {
        return (
            [...this.#inFlightSteeringSubmissions.values()].find(
                (submission) => submission.messageId === messageId,
            ) ??
            this.#acceptedSteeringSubmissions.find(
                (submission) => submission.messageId === messageId,
            ) ??
            [...this.#rejectedSteeringSubmissions.values()].find(
                (submission) => submission.messageId === messageId,
            )
        );
    }

    #removePendingSteeringMessage(messageId: string): void {
        this.#pendingSteeringMessages = this.#pendingSteeringMessages.filter(
            (submission) => submission.id !== messageId,
        );
    }

    #restoreRejectedSteeringSubmissions(runId: string): void {
        const rejected = [...this.#rejectedSteeringSubmissions.values()]
            .filter((submission) => submission.runId === runId && !submission.invalidated)
            .sort((left, right) => left.id - right.id);
        if (rejected.length === 0) return;
        for (const submission of rejected) {
            this.#rejectedSteeringSubmissions.delete(submission.id);
        }

        const restored = rejected.map((submission) => submission.submission.displayText);
        const draft = this.#editor.getText().trim();
        if (draft.length > 0) restored.push(draft);
        this.#editor.setText(restored.join("\n"));
        this.#syncAutocompleteState();
    }

    #finishLocalSteeringRun(runId: string, options: { restoreUnapplied?: boolean } = {}): void {
        const restoreUnapplied = options.restoreUnapplied !== false;
        for (const submission of [
            ...this.#inFlightSteeringSubmissions.values(),
            ...this.#acceptedSteeringSubmissions,
        ]) {
            if (submission.runId === runId) {
                this.#continuationRequestedSteeringMessageIds.delete(submission.messageId);
            }
        }
        for (const pending of this.#pendingSteeringMessages) {
            if (pending.runId === runId) {
                this.#continuationRequestedSteeringMessageIds.delete(pending.id);
            }
        }
        for (const submission of this.#inFlightSteeringSubmissions.values()) {
            if (submission.runId !== runId) continue;
            if (restoreUnapplied) submission.runEnded = true;
            else submission.invalidated = true;
        }
        for (const submission of this.#acceptedSteeringSubmissions) {
            if (restoreUnapplied && submission.runId === runId && !submission.applied) {
                this.#rejectedSteeringSubmissions.set(submission.id, submission);
                this.#removePendingSteeringMessage(submission.messageId);
            }
        }
        if (!restoreUnapplied) {
            this.#pendingSteeringMessages = this.#pendingSteeringMessages.filter(
                (pending) => pending.runId !== runId,
            );
            for (const [submissionId, submission] of this.#rejectedSteeringSubmissions) {
                if (submission.runId === runId) {
                    this.#rejectedSteeringSubmissions.delete(submissionId);
                }
            }
        }
        this.#acceptedSteeringSubmissions = this.#acceptedSteeringSubmissions.filter(
            (submission) => submission.runId !== runId,
        );
        if (
            restoreUnapplied &&
            ![...this.#inFlightSteeringSubmissions.values()].some(
                (submission) => submission.runId === runId,
            )
        ) {
            this.#restoreRejectedSteeringSubmissions(runId);
        }
        this.#clearSteeringInterrupt(runId, { startDrain: false });
    }

    #discardLocalSteeringSubmissionsForBoundary(): void {
        for (const submission of this.#inFlightSteeringSubmissions.values()) {
            submission.invalidated = true;
        }
        this.#inFlightSteeringSubmissions.clear();
        this.#acceptedSteeringSubmissions = [];
        this.#rejectedSteeringSubmissions.clear();
        this.#continuationRequestedSteeringMessageIds.clear();
        this.#steeringInterruptIntent = undefined;
        if (!this.#interruptRequestInFlight) this.#interruptSettlementRunId = undefined;
    }

    #discardLocalPromptsForBoundary(): number {
        this.#discardLocalSteeringSubmissionsForBoundary();
        const discarded = this.#pendingPrompts;
        for (const prompt of discarded) this.#editor.addToHistory(prompt.displayText);
        this.#pendingPrompts = [];
        this.#runToken += 1;
        this.#abortController?.abort();
        this.#abortController = undefined;
        return discarded.length;
    }

    #sessionEventRunId(event: SessionEvent): string | undefined {
        if (event.type === "session_activity_changed") {
            return event.data.activity.runId;
        }
        const runId = (event.data as { runId?: unknown }).runId;
        return typeof runId === "string" ? runId : undefined;
    }

    #abortActiveRun(options: { silent?: boolean } = {}): boolean {
        if (!this.#running || this.#abortController === undefined) {
            return false;
        }
        if (
            this.#sessionBacked &&
            this.#activeSessionRunId !== undefined &&
            this.#activeLocalSessionRunId !== this.#activeSessionRunId
        ) {
            this.#requestSessionInterrupt(false);
            return true;
        }

        const controller = this.#abortController;
        if (this.#sessionBacked && this.#activeSessionRunId !== undefined) {
            // The run-specific stream can settle before the shared session event stream.
            // Keep queued input behind the durable terminal event so it starts as a new turn.
            this.#interruptSettlementRunId = this.#activeSessionRunId;
        }
        this.#runToken += 1;
        controller.abort();
        this.#abortController = undefined;
        this.#activeTurnEntryStart = undefined;
        this.#setRunning(false);
        this.#statusText = "Idle";
        this.#discardPendingToolCallEntries();
        this.#thinkingEntryIdsByContentIndex.clear();
        this.#streamingThinkingEntryIds.clear();
        this.#toolCallEntryIdsByContentIndex.clear();
        this.#markActiveToolCallsStopped();
        this.#activeToolCallIds.clear();
        this.#awaitingApprovalToolCallIds.clear();
        this.#reviewingPermissionToolCallIds.clear();
        this.#runningToolCallIds.clear();
        this.#toolStatusByCallId.clear();
        this.#stopActivityAnimation();
        void this.#processManager.killAll({ forceAfterMs: 500 }).catch((error: unknown) => {
            this.#appendEntry({ role: "error", text: errorToMessage(error) });
        });
        if (options.silent !== true) {
            this.#appendAbortNotice();
        }
        this.#requestRender();
        return true;
    }

    async #abortIdleSession(): Promise<void> {
        try {
            const localProcessCount = this.#processManager.activeCount();
            let response;
            if (this.#agent.abort === undefined) {
                await this.#processManager.killAll({ forceAfterMs: 500 });
                response = { aborted: false, stoppedProcesses: localProcessCount };
            } else {
                response = await this.#agent.abort();
            }
            const stoppedProcesses = response.stoppedProcesses ?? 0;
            this.#appendEntry({
                role: "event",
                title: "Session",
                text:
                    stoppedProcesses === 0
                        ? "No active run."
                        : `Stopped ${String(stoppedProcesses)} background ${stoppedProcesses === 1 ? "process" : "processes"}.`,
            });
        } catch (error) {
            this.#appendEntry({ role: "error", text: errorToMessage(error) });
        }
        this.#requestRender();
    }

    #isCurrentRun(runToken: number): boolean {
        return !this.#stopped && runToken === this.#runToken;
    }

    #handleAgentEvent(event: AgentLoopEvent, runToken: number): void {
        if (!this.#isCurrentRun(runToken)) {
            return;
        }

        this.#applyAgentEvent(event);
    }

    #applyAgentEvent(event: AgentLoopEvent, createdAt = this.#now()): void {
        if (event.type === "inference_iteration_start") {
            this.#statusText = "Running";
            this.#streamEntryId = undefined;
            this.#streamedToolCallEntries.clear();
            this.#thinkingEntryIdsByContentIndex.clear();
            this.#streamingThinkingEntryIds.clear();
            this.#toolCallEntryIdsByContentIndex.clear();
        } else if (event.type === "block_reset") {
            this.#resetStreamedInference();
            this.#statusText = "Running";
        } else if (event.type === "retrying") {
            const reason = this.#singleLine(event.reason);
            this.#statusText = reason.length === 0 ? "Retrying" : `Retrying · ${reason}`;
        } else if (event.type === "text_start") {
            this.#statusText = "Running";
        } else if (event.type === "text_delta") {
            this.#appendStreamText(event.delta);
        } else if (event.type === "text_end") {
            this.#finishStreamText(event.content);
        } else if (event.type === "thinking_start") {
            this.#statusText = "Thinking";
        } else if (event.type === "thinking_delta") {
            this.#statusText = "Thinking";
            this.#appendThinkingText(event.contentIndex, event.delta);
        } else if (event.type === "thinking_end") {
            this.#statusText = "Thinking";
            this.#finishThinkingText(event.contentIndex, event.content);
        } else if (event.type === "toolcall_start") {
            this.#statusText = "Running";
            this.#ensureToolCallEntry(event.contentIndex);
        } else if (event.type === "toolcall_delta") {
            this.#statusText = "Running";
            this.#ensureToolCallEntry(event.contentIndex);
        } else if (event.type === "toolcall_end") {
            this.#finishToolCall(event.contentIndex, event.toolCall);
        } else if (event.type === "tool_execution_start") {
            this.#activeToolCallIds.add(event.toolCall.id);
            this.#runningToolCallIds.add(event.toolCall.id);
            const entry = this.#entries.find((candidate) => candidate.id === event.toolCall.id);
            if (entry !== undefined && event.toolCall.presentation?.type === "exploration") {
                entry.exploration = event.toolCall.presentation;
                delete entry.execCommand;
            } else if (
                entry !== undefined &&
                event.toolCall.presentation?.type === "exec_command"
            ) {
                entry.execCommand = {
                    ...event.toolCall.presentation,
                    output: "",
                };
                delete entry.exploration;
            }
            this.#refreshToolActivityStatus();
        } else if (event.type === "tool_execution_end") {
            const entry = this.#entries.find(
                (candidate) => candidate.id === event.result.toolCallId,
            );
            if (entry?.mcpToolCall === undefined) {
                this.#finishToolResult(event.result);
                this.#markConcreteWorkCompleted(event.result);
            } else {
                this.#runningToolCallIds.delete(event.result.toolCallId);
                this.#toolStatusByCallId.delete(event.result.toolCallId);
            }
            this.#refreshToolActivityStatus();
        } else if (event.type === "tool_execution_progress") {
            const entry = this.#entries.find((candidate) => candidate.id === event.toolCallId);
            if (entry !== undefined) entry.detail = this.#singleLine(event.display);
        } else if (event.type === "tool_execution_status") {
            if (this.#runningToolCallIds.has(event.toolCallId)) {
                this.#toolStatusByCallId.set(event.toolCallId, this.#singleLine(event.status));
                this.#refreshToolActivityStatus();
            }
        } else if (event.type === "context_compaction_started") {
            this.#activeCompactionId = event.compactionId;
            this.#compactionStartedAtMs = createdAt;
            this.#statusText = `Compacting context · ${formatTokens(event.estimatedTokensBefore)} tokens`;
        } else if (event.type === "context_compacted") {
            this.#latestContextTokens = event.estimatedTokensAfter;
            if (!this.#skipInitialUsageReplay) {
                this.#sessionTokenCount = updateSessionTokenCount(this.#sessionTokenCount, {
                    type: "compaction",
                    contextTokens: event.estimatedTokensAfter,
                });
            }
            this.#appendEntry({
                role: "event",
                title: "Context compacted",
                text: `Summarized ${event.compactedMessageCount} older messages; ${formatTokens(event.estimatedTokensBefore)} → ${formatTokens(event.estimatedTokensAfter)} tokens. The full transcript remains visible.`,
            });
        } else if (event.type === "context_compaction_finished") {
            if (this.#activeCompactionId === event.compactionId) {
                this.#activeCompactionId = undefined;
                this.#compactionStartedAtMs = undefined;
                this.#statusText = this.#running
                    ? "Working"
                    : this.#compacting
                      ? "Compacting conversation"
                      : "Idle";
            }
        } else if (event.type === "permission_review_started") {
            this.#reviewingPermissionToolCallIds.add(event.toolCallId);
            this.#refreshToolActivityStatus();
        } else if (event.type === "permission_review") {
            if (event.transcript !== undefined && !this.#skipInitialUsageReplay) {
                this.#usage = addUsage(this.#usage, event.transcript.usage);
                this.#sessionTokenCount = updateSessionTokenCount(this.#sessionTokenCount, {
                    type: "usage",
                    contextTokens: this.#latestContextTokens,
                    usage: event.transcript.usage,
                });
            }
            this.#reviewingPermissionToolCallIds.delete(event.toolCallId);
            this.#refreshToolActivityStatus();
            if (event.decision === "deny") {
                const toolEntry = this.#entries.find((entry) => entry.id === event.toolCallId);
                if (toolEntry !== undefined) {
                    toolEntry.permissionReview = `Refused: ${event.reason} Risk: ${humanizePermissionReviewLevel(event.risk)}. User authorization: ${humanizePermissionReviewLevel(event.userAuthorization)}.`;
                }
            }
        } else if (event.type === "temporary_full_access_started") {
            const toolEntry = this.#entries.find((entry) => entry.id === event.toolCallId);
            if (toolEntry !== undefined) {
                toolEntry.permissionReview = "Approved automatically: temporary Full access.";
            }
        } else if (event.type === "background_processes_changed") {
            const nextProcesses =
                event.processes ?? (event.running === 0 ? [] : this.#observedShellProcesses);
            this.#recordClosedBackgroundTerminals(nextProcesses);
            this.#observedShellProcesses = nextProcesses;
            this.#backgroundProcesses = nextProcesses.filter((process) =>
                this.#yieldedBackgroundTerminals.has(process.sessionId),
            );
        } else if (event.type === "background_processes_stopped") {
            this.#backgroundProcesses = [];
            this.#yieldedBackgroundTerminals.clear();
            this.#appendEntry({
                role: "event",
                title: "Permissions",
                text: `Stopped ${event.count} running process${event.count === 1 ? "" : "es"} before reducing permissions.`,
            });
        } else if (event.type === "done") {
            this.#statusText = event.reason === "toolUse" ? "Running tools" : "Working";
        } else if (event.type === "error") {
            if (event.reason === "aborted") {
                this.#statusText = "Idle";
                this.#appendAbortNotice();
                return;
            }
            this.#deferredTurnSeparator = false;
            this.#statusText = "Error";
            const providerId = this.#agent.provider.id;
            this.#appendEntry({
                role: "error",
                ...(event.error.providerError === undefined
                    ? {}
                    : { providerError: event.error.providerError }),
                ...(event.error.errorMessage === undefined
                    ? {}
                    : { providerErrorFallback: event.error.errorMessage }),
                providerErrorProviderId: providerId,
                text: formatProviderError(event.error.providerError, {
                    ...(event.error.errorMessage === undefined
                        ? {}
                        : { fallbackMessage: event.error.errorMessage }),
                    now: this.#now(),
                    providerId,
                }),
            });
            this.#syncProviderErrorResetTimer();
        }

        this.#requestRender();
    }

    #markActiveToolCallsStopped(): void {
        for (const toolCallId of this.#activeToolCallIds) {
            this.#stoppedToolCallIds.add(toolCallId);
        }
        for (const toolCallId of this.#awaitingApprovalToolCallIds) {
            this.#stoppedToolCallIds.add(toolCallId);
        }
        for (const toolCallId of this.#reviewingPermissionToolCallIds) {
            this.#stoppedToolCallIds.add(toolCallId);
        }
    }

    #appendAbortNotice(): void {
        this.#deferredTurnSeparator = false;
        this.#markActiveToolCallsStopped();
        this.#activeToolCallIds.clear();
        this.#awaitingApprovalToolCallIds.clear();
        this.#reviewingPermissionToolCallIds.clear();
        this.#runningToolCallIds.clear();
        this.#toolStatusByCallId.clear();
        if (this.#abortNotified) {
            return;
        }

        this.#abortNotified = true;
        this.#appendEntry({
            role: "error",
            title: "Session interrupted",
            text: "The active run was stopped.",
        });
    }

    #handleAgentMessage(message: Message, runToken: number): void {
        if (!this.#isCurrentRun(runToken)) return;
        this.#applyAgentMessage(message);
    }

    #applyAgentMessage(message: Message): void {
        if (message.role === "error") {
            const text = message.blocks
                .map((block) =>
                    block.type === "text" ? block.text : `[Image: ${block.mediaType}]`,
                )
                .join("\n");
            if (message.outcome === "failed" && this.#hasActiveInferenceFailure(text)) return;
            this.#deferredTurnSeparator = false;
            this.#appendEntry({
                id: message.id,
                role: "error",
                ...(message.providerError === undefined
                    ? {}
                    : { providerError: message.providerError }),
                providerErrorFallback: text,
                ...(message.providerId === undefined
                    ? {}
                    : { providerErrorProviderId: message.providerId }),
                text,
                title:
                    message.outcome === "retried"
                        ? message.attempt === undefined
                            ? "Inference failed and was retried"
                            : `Inference attempt ${String(message.attempt)} failed and was retried`
                        : message.outcome === "continued"
                          ? "Action failed"
                          : "Run failed",
            });
            this.#requestRender();
            return;
        }
        if (message.role === "compaction") {
            if (message.usage !== undefined && !this.#skipInitialUsageReplay) {
                this.#usage = addUsage(this.#usage, message.usage);
                this.#sessionTokenCount = updateSessionTokenCount(this.#sessionTokenCount, {
                    type: "usage",
                    contextTokens: this.#latestContextTokens,
                    usage: message.usage,
                });
            }
            return;
        }
        if (message.role !== "agent") {
            return;
        }
        if (message.usage !== undefined) {
            if (!this.#skipInitialUsageReplay) {
                this.#usage = addUsage(this.#usage, message.usage);
                this.#sessionTokenCount = updateSessionTokenCount(this.#sessionTokenCount, {
                    type: "usage",
                    contextTokens: message.contextTokens ?? this.#latestContextTokens,
                    usage: message.usage,
                });
            }
            if (message.contextTokens !== undefined) {
                this.#latestContextTokens = message.contextTokens;
            }
        }

        let pendingText = "";
        let textSegment = 0;
        const flushText = () => {
            if (pendingText.trim().length === 0) {
                pendingText = "";
                return;
            }

            const id = textSegment === 0 ? message.id : `${message.id}:text:${textSegment}`;
            this.#finishAssistantMessage(id, pendingText);
            pendingText = "";
            textSegment += 1;
        };

        for (const [contentIndex, block] of message.blocks.entries()) {
            if (block.type === "text") {
                pendingText += block.text;
                continue;
            }

            flushText();

            if (block.type === "thinking") {
                this.#finishThinkingMessage(message.id, contentIndex, block.thinking);
            } else if (block.type === "tool_call" && !this.#seenToolCallIds.has(block.id)) {
                this.#seenToolCallIds.add(block.id);
                const mcpToolCall = this.#createMcpToolCall(block.name, block.arguments);
                const exploration =
                    block.presentation?.type === "exploration" ? block.presentation : undefined;
                const execCommand =
                    block.presentation?.type === "exec_command"
                        ? { ...block.presentation, output: "" }
                        : undefined;
                this.#appendEntry({
                    id: block.id,
                    role: "tool",
                    title: this.#toolDisplayName(block.name),
                    text: this.#formatToolCall(block.name, block.arguments, block.id),
                    ...(execCommand === undefined ? {} : { execCommand }),
                    ...(exploration === undefined ? {} : { exploration }),
                    ...(mcpToolCall === undefined ? {} : { mcpToolCall }),
                });
            } else if (block.type === "tool_result") {
                this.#finishToolResult(block);
                this.#markConcreteWorkCompleted(block);
            }
        }

        flushText();
        this.#refreshToolActivityStatus();
        this.#requestRender();
    }

    #hasActiveInferenceFailure(reason: string): boolean {
        const start = this.#activeTurnEntryStart ?? this.#entries.length;
        return this.#entries
            .slice(start)
            .some(
                (entry) =>
                    entry.role === "error" &&
                    (entry.text === reason || entry.providerErrorFallback === reason),
            );
    }

    #ensureStreamEntry(): AppTranscriptEntry {
        const existing =
            this.#streamEntryId === undefined
                ? undefined
                : this.#entries.find((entry) => entry.id === this.#streamEntryId);
        if (existing !== undefined) {
            return existing;
        }

        const entry = this.#appendEntry({ role: "assistant", text: "" });
        this.#streamEntryId = entry.id;
        this.#unreconciledStreamEntryIds.push(entry.id);
        return entry;
    }

    #appendStreamText(delta: string): void {
        if (this.#streamEntryId === undefined && delta.trim().length === 0) {
            return;
        }
        const entry = this.#ensureStreamEntry();
        entry.text += delta;
    }

    #finishStreamText(text: string): void {
        if (text.trim().length === 0) {
            if (this.#streamEntryId !== undefined) {
                const entry = this.#entries.find(
                    (candidate) => candidate.id === this.#streamEntryId,
                );
                if (entry !== undefined && entry.text.trim().length === 0) entry.text = "";
            }
            return;
        }
        const entry = this.#ensureStreamEntry();
        entry.text = text;
    }

    #ensureThinkingEntry(contentIndex: number): AppTranscriptEntry {
        const existingId = this.#thinkingEntryIdsByContentIndex.get(contentIndex);
        const existing =
            existingId === undefined
                ? undefined
                : this.#entries.find((entry) => entry.id === existingId);
        if (existing !== undefined) {
            return existing;
        }

        const entry = this.#appendEntry({ role: "thinking", text: "" });
        this.#thinkingEntryIdsByContentIndex.set(contentIndex, entry.id);
        return entry;
    }

    #appendThinkingText(contentIndex: number, delta: string): void {
        if (
            delta.length === 0 ||
            (!this.#thinkingEntryIdsByContentIndex.has(contentIndex) && delta.trim().length === 0)
        ) {
            return;
        }

        const entry = this.#ensureThinkingEntry(contentIndex);
        this.#streamingThinkingEntryIds.add(entry.id);
        entry.text += delta;
    }

    #finishThinkingText(contentIndex: number, text: string): void {
        if (text.trim().length === 0) {
            const existingId = this.#thinkingEntryIdsByContentIndex.get(contentIndex);
            if (existingId !== undefined) this.#streamingThinkingEntryIds.delete(existingId);
            return;
        }

        const entry = this.#ensureThinkingEntry(contentIndex);
        entry.text = text;
        this.#streamingThinkingEntryIds.delete(entry.id);
    }

    #ensureToolCallEntry(contentIndex: number): AppTranscriptEntry {
        const existingId = this.#toolCallEntryIdsByContentIndex.get(contentIndex);
        const existing =
            existingId === undefined
                ? undefined
                : this.#entries.find((entry) => entry.id === existingId);
        if (existing !== undefined) {
            return existing;
        }

        const entry = this.#appendEntry({
            role: "tool",
            title: PENDING_TOOL_CALL_TITLE,
            text: PENDING_TOOL_CALL_TITLE,
        });
        this.#streamedToolCallEntries.add(entry);
        this.#toolCallEntryIdsByContentIndex.set(contentIndex, entry.id);
        return entry;
    }

    #finishToolCall(
        contentIndex: number,
        toolCall: {
            id: string;
            name: string;
            arguments: unknown;
        },
    ): void {
        this.#seenToolCallIds.add(toolCall.id);
        this.#stoppedToolCallIds.delete(toolCall.id);
        this.#activeToolCallIds.add(toolCall.id);
        this.#statusText = `Calling ${this.#toolDisplayName(toolCall.name)}`;
        const mcpToolCall = this.#createMcpToolCall(toolCall.name, toolCall.arguments);

        const existingId = this.#toolCallEntryIdsByContentIndex.get(contentIndex);
        const existing =
            existingId === undefined
                ? undefined
                : this.#entries.find((entry) => entry.id === existingId);

        const backgroundInteraction = this.#backgroundTerminalInteraction(
            toolCall.name,
            toolCall.arguments,
        );
        if (backgroundInteraction !== undefined) {
            this.#toolStatusByCallId.set(toolCall.id, backgroundInteraction.label);
        }
        if (existing !== undefined && backgroundInteraction?.input === "") {
            this.#removeUnrenderedToolEntry(existing);
            this.#toolCallEntryIdsByContentIndex.delete(contentIndex);
            return;
        }

        if (existing !== undefined) {
            existing.id = toolCall.id;
            existing.title = this.#toolDisplayName(toolCall.name);
            existing.text = this.#formatToolCall(toolCall.name, toolCall.arguments, toolCall.id);
            if (mcpToolCall === undefined) {
                delete existing.mcpToolCall;
            } else {
                existing.mcpToolCall = mcpToolCall;
            }
            this.#toolCallEntryIdsByContentIndex.delete(contentIndex);
            return;
        }

        this.#toolCallEntryIdsByContentIndex.delete(contentIndex);
        this.#appendEntry({
            id: toolCall.id,
            role: "tool",
            title: this.#toolDisplayName(toolCall.name),
            text: this.#formatToolCall(toolCall.name, toolCall.arguments, toolCall.id),
            ...(mcpToolCall === undefined ? {} : { mcpToolCall }),
        });
    }

    /**
     * The above-composer indicator is the one place an owner is guaranteed to see that a
     * capability is active, so its disappearance must never be silent: when the last member
     * loses every capability, the same update that drops the live row also writes the history
     * row that explains where it went, in the same render the terminal-layout-stability rule
     * requires.
     */
    #applySessionShareUpdate(share: SessionSharedMetadata): void {
        const wasActive = (this.#sessionShare?.capabilityMemberCount ?? 0) > 0;
        if (wasActive && share.capabilityMemberCount === 0 && this.#sessionShare !== undefined) {
            this.#appendEntry({
                role: "event",
                text: `No member can ${describeActivePeerCapabilities(this.#sessionShare)} in this session anymore.`,
            });
        }
        this.#sessionShare = share;
        this.#requestRender();
    }

    #backgroundTerminalInteraction(
        toolName: string,
        args: unknown,
    ): { input: string; label: string } | undefined {
        if (toolName.toLowerCase() !== "write_stdin" || !this.#isRecord(args)) return undefined;
        const input = typeof args.chars === "string" ? args.chars : "";
        return {
            input,
            label:
                input.length === 0
                    ? "Waiting for background terminal"
                    : "Interacting with background terminal",
        };
    }

    #removeUnrenderedToolEntry(entry: AppTranscriptEntry): void {
        const index = this.#entries.indexOf(entry);
        if (index < 0) return;
        this.#entries.splice(index, 1);
        this.#streamedToolCallEntries.delete(entry);
    }

    #finishThinkingMessage(messageId: string, contentIndex: number, text: string): void {
        if (text.trim().length === 0) {
            return;
        }

        const entry = this.#ensureThinkingEntry(contentIndex);
        entry.id = `${messageId}:thinking:${contentIndex}`;
        entry.text = text;
        this.#thinkingEntryIdsByContentIndex.set(contentIndex, entry.id);
    }

    #finishAssistantMessage(messageId: string, text: string): void {
        // A durable message can arrive after its streamed entry was orphaned by a run or
        // iteration boundary, and the event stream can redeliver it after a reconnect. Both
        // must land on the entry the text already occupies instead of appending a copy.
        const settled = this.#entries.find(
            (candidate) => candidate.id === messageId && candidate.role === "assistant",
        );
        const entry = settled ?? this.#takeStreamedAssistantEntry();
        if (entry !== undefined) {
            entry.id = messageId;
            if (!this.#abortNotified && text.trim().length > 0) entry.text = text;
            return;
        }

        if (text.trim().length === 0) return;
        this.#appendEntry({ id: messageId, role: "assistant", text });
    }

    /** Claims the oldest streamed assistant entry that no durable message has adopted yet. */
    #takeStreamedAssistantEntry(): AppTranscriptEntry | undefined {
        const streaming =
            this.#streamEntryId === undefined
                ? undefined
                : this.#entries.find((candidate) => candidate.id === this.#streamEntryId);
        if (streaming !== undefined) {
            this.#unreconciledStreamEntryIds = this.#unreconciledStreamEntryIds.filter(
                (id) => id !== streaming.id,
            );
            this.#streamEntryId = undefined;
            return streaming;
        }

        while (this.#unreconciledStreamEntryIds.length > 0) {
            const id = this.#unreconciledStreamEntryIds.shift();
            const orphan = this.#entries.find((candidate) => candidate.id === id);
            if (orphan !== undefined) return orphan;
        }
        return undefined;
    }

    #reconcileSubmittedUserEntry(messageId: string, displayText: string): boolean {
        const existing = this.#entries.find(
            (entry) => entry.role === "user" && entry.id === messageId,
        );
        if (existing !== undefined) {
            this.#pendingSubmittedUserEntries = this.#pendingSubmittedUserEntries.filter(
                (entry) => entry !== existing,
            );
            return true;
        }

        let pendingIndex = this.#pendingSubmittedUserEntries.findIndex(
            (entry) => entry.id === messageId,
        );
        if (pendingIndex < 0) {
            pendingIndex = this.#pendingSubmittedUserEntries.findIndex(
                (entry) => entry.text === displayText,
            );
        }
        if (pendingIndex < 0) return false;

        const [entry] = this.#pendingSubmittedUserEntries.splice(pendingIndex, 1);
        if (entry === undefined) return false;
        entry.id = messageId;
        entry.text = displayText;
        this.#requestRender();
        return true;
    }

    #appendEntry(entry: Omit<AppTranscriptEntry, "id"> & { id?: string }): AppTranscriptEntry {
        const completeEntry: AppTranscriptEntry = {
            id: entry.id ?? this.#idFactory(),
            role: entry.role,
            text: entry.text,
        };
        if (entry.detail !== undefined) {
            completeEntry.detail = entry.detail;
        }
        if (entry.backgroundTerminalCompletion !== undefined) {
            completeEntry.backgroundTerminalCompletion = entry.backgroundTerminalCompletion;
        }
        if (entry.backgroundTerminalInteraction !== undefined) {
            completeEntry.backgroundTerminalInteraction = entry.backgroundTerminalInteraction;
        }
        if (entry.childText !== undefined) {
            completeEntry.childText = entry.childText;
        }
        if (entry.contextOnly !== undefined) {
            completeEntry.contextOnly = entry.contextOnly;
        }
        if (entry.execCommand !== undefined) {
            completeEntry.execCommand = entry.execCommand;
        }
        if (entry.exploration !== undefined) {
            completeEntry.exploration = entry.exploration;
        }
        if (entry.fileDiffs !== undefined) {
            completeEntry.fileDiffs = entry.fileDiffs;
        }
        if (entry.omittedFileDiffs !== undefined) {
            completeEntry.omittedFileDiffs = entry.omittedFileDiffs;
        }
        if (entry.mcpToolCall !== undefined) {
            completeEntry.mcpToolCall = entry.mcpToolCall;
        }
        if (entry.noticeChildren !== undefined) {
            completeEntry.noticeChildren = entry.noticeChildren;
        }
        if (entry.permissionReview !== undefined) {
            completeEntry.permissionReview = entry.permissionReview;
        }
        if (entry.providerError !== undefined) {
            completeEntry.providerError = entry.providerError;
        }
        if (entry.providerErrorFallback !== undefined) {
            completeEntry.providerErrorFallback = entry.providerErrorFallback;
        }
        if (entry.providerErrorProviderId !== undefined) {
            completeEntry.providerErrorProviderId = entry.providerErrorProviderId;
        }
        if (entry.title !== undefined) {
            completeEntry.title = entry.title;
        }
        if (entry.turnElapsedMs !== undefined) {
            completeEntry.turnElapsedMs = entry.turnElapsedMs;
        }
        if (entry.turnUsage !== undefined) {
            completeEntry.turnUsage = entry.turnUsage;
        }

        this.#entries.push(completeEntry);
        this.#requestRender();
        return completeEntry;
    }

    #clearEntries(): void {
        this.#entries = [];
        this.#unreconciledStreamEntryIds = [];
        this.#activeTurnEntryStart = undefined;
        this.#pendingSubmittedUserEntries = [];
        this.#streamedToolCallEntries.clear();
        this.#stoppedToolCallIds.clear();
        this.#observedShellProcesses = [];
        this.#yieldedBackgroundTerminals.clear();
        this.#deferredTurnSeparator = false;
        this.#syncProviderErrorResetTimer();
    }

    #discardPendingToolCallEntries(): void {
        this.#entries = this.#entries.filter((entry) => {
            const pending =
                this.#streamedToolCallEntries.has(entry) &&
                entry.title === PENDING_TOOL_CALL_TITLE &&
                entry.text === PENDING_TOOL_CALL_TITLE;
            return !pending;
        });
        this.#streamedToolCallEntries.clear();
    }

    #resetStreamedInference(): void {
        const entryIds = new Set(this.#thinkingEntryIdsByContentIndex.values());
        if (this.#streamEntryId !== undefined) entryIds.add(this.#streamEntryId);
        for (const entry of this.#streamedToolCallEntries) {
            entryIds.add(entry.id);
            this.#activeToolCallIds.delete(entry.id);
            this.#awaitingApprovalToolCallIds.delete(entry.id);
            this.#reviewingPermissionToolCallIds.delete(entry.id);
            this.#runningToolCallIds.delete(entry.id);
            this.#seenToolCallIds.delete(entry.id);
            this.#stoppedToolCallIds.delete(entry.id);
            this.#toolStatusByCallId.delete(entry.id);
        }
        this.#entries = this.#entries.filter((entry) => !entryIds.has(entry.id));
        this.#streamEntryId = undefined;
        this.#streamedToolCallEntries.clear();
        this.#thinkingEntryIdsByContentIndex.clear();
        this.#streamingThinkingEntryIds.clear();
        this.#toolCallEntryIdsByContentIndex.clear();
    }

    #renderHeader(width: number): string[] {
        const cached = this.#headerLinesByWidth.get(width);
        if (cached !== undefined) return [...cached];
        const lines = [
            "",
            ...renderRigBanner({
                brand: this.#theme.brand,
                secondary: this.#theme.secondary,
                version: this.#version,
                width,
            }),
            "",
            ...renderStartupStatusCard({
                model: this.#startupStatus,
                theme: this.#theme,
                width,
            }),
            "",
        ];
        this.#headerLinesByWidth.clear();
        this.#headerLinesByWidth.set(width, lines);
        return lines;
    }

    #renderTranscript(width: number): string[] {
        const entries = this.#visibleTranscriptEntries();
        return this.#renderTranscriptEntries(entries, width);
    }

    #visibleTranscriptEntries(): AppTranscriptEntry[] {
        const liveExplorationEntries = new Set(this.#liveExplorationEntries());
        const sourceEntries = this.#entries.filter(
            (entry) => !this.#activeToolCallIds.has(entry.id) && !liveExplorationEntries.has(entry),
        );
        const reasoningEntries = this.#showReasoning
            ? [...sourceEntries]
            : sourceEntries.filter((entry) => entry.role !== "thinking");
        return this.#compactCompletedTurns
            ? compactCompletedTurnEntries(reasoningEntries)
            : reasoningEntries;
    }

    #renderTranscriptEntries(entries: readonly AppTranscriptEntry[], width: number): string[] {
        const lines: string[] = [];
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            if (entry === undefined) continue;
            if (this.#isExplorationEntry(entry)) {
                const group = [entry];
                while (
                    entryBoundary(group.at(-1)) === false &&
                    this.#isExplorationEntry(entries[index + 1])
                ) {
                    const next = entries[index + 1];
                    if (next === undefined) break;
                    group.push(next);
                    index += 1;
                }
                if (lines.length > 0) lines.push("");
                lines.push(...this.#renderExplorationEntries(group, width));
                const last = group.at(-1);
                if (last !== undefined) this.#appendEntryCompletion(lines, last, width);
                continue;
            }
            const entryLines = this.#entryRenderCache.render(
                entry,
                {
                    dynamicState: this.#entryRenderState(entry),
                    theme: this.#theme,
                    width,
                },
                () => this.#renderEntry(entry, width),
            );
            if (entryLines.length === 0) continue;
            if (lines.length > 0) lines.push("");
            lines.push(...entryLines);
            this.#appendEntryCompletion(lines, entry, width);
        }
        return lines;
    }

    #appendEntryCompletion(lines: string[], entry: AppTranscriptEntry, width: number): void {
        const usageSummary =
            this.#showUsage && entry.turnUsage !== undefined
                ? formatTurnUsageSummary(entry.turnUsage)
                : undefined;
        if (this.#compactCompletedTurns && entry.completedTurn !== undefined) {
            lines.push(
                "",
                renderCompletedTurnStats(entry.completedTurn.stats, width, usageSummary),
            );
        } else if (entry.turnElapsedMs !== undefined) {
            lines.push("", renderTurnCompletionSeparator(entry.turnElapsedMs, width, usageSummary));
        }
    }

    #entryRenderState(entry: AppTranscriptEntry): string {
        if (entry.role === "assistant") {
            const isStreaming = entry.id === this.#streamEntryId;
            const tableRowBudget =
                isStreaming && containsMarkdownTable(entry.text)
                    ? Math.max(1, this.#tui.terminal.rows - 8)
                    : "";
            return `assistant:${String(isStreaming)}:${String(tableRowBudget)}`;
        }
        if (entry.role === "thinking") {
            return `thinking:${String(this.#streamingThinkingEntryIds.has(entry.id))}`;
        }
        if (entry.role === "error") {
            const resetAt = providerErrorResetAt(entry.providerError);
            if (resetAt === undefined) {
                return [
                    this.#activeToolCallIds.has(entry.id),
                    this.#awaitingApprovalToolCallIds.has(entry.id),
                    this.#stoppedToolCallIds.has(entry.id),
                    this.#shouldRenderActivityAsLastMessage(),
                ].join(":");
            }
            return [
                this.#activeToolCallIds.has(entry.id),
                this.#awaitingApprovalToolCallIds.has(entry.id),
                this.#stoppedToolCallIds.has(entry.id),
                this.#shouldRenderActivityAsLastMessage(),
                formatResetDuration(resetAt - this.#now()),
            ].join(":");
        }
        if (entry.role !== "tool") return "";
        return [
            this.#activeToolCallIds.has(entry.id),
            this.#awaitingApprovalToolCallIds.has(entry.id),
            this.#stoppedToolCallIds.has(entry.id),
            this.#shouldRenderActivityAsLastMessage(),
        ].join(":");
    }

    #renderEntry(entry: AppTranscriptEntry, width: number): string[] {
        if (entry.role === "user") {
            return this.#renderUserEntry(entry, width);
        }
        if (entry.role === "assistant") {
            return this.#renderAssistantEntry(entry, width);
        }
        if (entry.role === "thinking") {
            return this.#renderThinkingEntry(entry, width);
        }
        if (entry.backgroundTerminalCompletion !== undefined) {
            return [renderBackgroundTerminalCompletion(entry.backgroundTerminalCompletion, width)];
        }
        if (entry.backgroundTerminalInteraction !== undefined) {
            return renderBackgroundTerminalInteraction(entry.backgroundTerminalInteraction, width);
        }
        if (entry.execCommand !== undefined) {
            const active = this.#activeToolCallIds.has(entry.id);
            const stopped = this.#stoppedToolCallIds.has(entry.id);
            const isError = entry.role === "error";
            return renderExecCommand(entry.execCommand, {
                active,
                brand: this.#theme.brand,
                ...(entry.detail === undefined ? {} : { detail: entry.detail }),
                primary: this.#theme.primary,
                ...(entry.permissionReview === undefined ? {} : { review: entry.permissionReview }),
                status:
                    stopped || isError
                        ? this.#theme.error
                        : active
                          ? this.#theme.warning
                          : this.#theme.success,
                verb: stopped ? "Stopped" : isError ? "Failed" : active ? "Running" : "Ran",
                width,
            });
        }
        if (entry.mcpToolCall !== undefined) {
            return this.#renderMcpToolEntry(entry, width);
        }
        if (entry.fileDiffs !== undefined && entry.fileDiffs.length > 0 && entry.role !== "error") {
            return this.#renderFileDiffEntry(entry, width);
        }
        if (entry.role === "tool") {
            return this.#renderToolEntry(entry, width, false);
        }
        if (entry.role === "error") {
            return entry.detail === undefined
                ? this.#renderNoticeEntry(
                      entry.title ?? "Error",
                      this.#providerErrorEntryText(entry),
                      width,
                      this.#theme.error,
                  )
                : this.#renderToolEntry(entry, width, true);
        }
        if (entry.role === "event") {
            if (entry.noticeChildren !== undefined) {
                return renderNoticeWithChildren({
                    children: entry.noticeChildren,
                    color: this.#theme.warning,
                    title: entry.title ?? "Event",
                    width,
                });
            }
            return this.#renderNoticeEntry(
                entry.title ?? "Event",
                entry.text,
                width,
                this.#theme.warning,
                entry.childText === true,
            );
        }

        return this.#renderNoticeEntry("System", entry.text, width, this.#theme.secondary);
    }

    #openPresenceMenu(): void {
        const presence = this.#presence;
        if (presence === undefined || this.#presenceState === undefined) {
            this.#appendEntry({
                role: "event",
                title: "Presence",
                text: "This session cannot change your presence.",
            });
            this.#requestRender();
            return;
        }
        if (presence.get === undefined) {
            this.#showPresencePanel(presence, this.#presenceState);
            return;
        }
        // Presence is daemon-wide and can expire on its own, so read it again before showing it.
        presence
            .get()
            .then((fresh) => {
                this.#presenceState = fresh;
                this.#showPresencePanel(presence, fresh);
            })
            .catch(() => {
                if (this.#presenceState !== undefined) {
                    this.#showPresencePanel(presence, this.#presenceState);
                }
            });
    }

    #showPresencePanel(
        presence: NonNullable<CodingAssistantAppOptions["presence"]>,
        state: PresenceSnapshot,
    ): void {
        const panel = createSelectionPanel({
            theme: this.#theme,
            title: "Where are you?",
            subtitle: "Agents follow this when they need an answer",
            selectedValue: state.presence.id,
            items: state.presences.map((candidate: PresenceSummary) => ({
                value: candidate.id,
                label: `${candidate.emoji} ${candidate.title}`,
                description: describePresenceWait(candidate.answerWaitMs),
            })),
            onSelect: (item) => {
                presence
                    .set(item.value)
                    .then((next) => {
                        this.#presenceState = next;
                        this.#appendEntry({
                            role: "event",
                            title: "Presence",
                            text: `You are now ${next.presence.title}.`,
                        });
                        this.#requestRender();
                    })
                    .catch((error: unknown) => {
                        this.#appendEntry({ role: "error", text: errorToMessage(error) });
                        this.#requestRender();
                    });
                this.#closeSelectionPanel();
                this.#requestRender();
            },
            onCancel: () => this.#closeSelectionPanel(),
        });
        this.#showSelectionPanel(panel);
        this.#requestRender();
    }

    #renderFooter(
        width: number,
        suggestions: readonly AutocompleteItem[],
        selectedIndex: number,
    ): string[] {
        if (suggestions.length > 0) {
            return this.#renderAutocomplete(width, suggestions, selectedIndex);
        }

        if (this.#isShellMode()) {
            const indent = " ".repeat(visibleWidth(INPUT_PROMPT));
            return [this.#fitLine(`${indent}${this.#theme.error}Shell mode${RESET}`, width)];
        }

        const parts = [`${this.#theme.warning}${this.#modelWithReasoningDisplayName()}${RESET}`];
        parts.push(`${this.#theme.success}${this.#cwdDisplayName()}${RESET}`);
        if (this.#activeAgentLabel !== undefined) {
            parts.push(`${this.#theme.secondary}${this.#activeAgentLabel}${RESET}`);
        }
        if (this.#sessionShare !== undefined) {
            const label =
                this.#sessionShare.state === "active"
                    ? "shared"
                    : `shared ${this.#sessionShare.state}`;
            parts.push(`${this.#theme.secondary}${label}${RESET}`);
        }
        const queuedCount = this.#promptsShownAsQueued().length;
        if (queuedCount > 0) {
            parts.push(`${this.#theme.secondary}queued ${queuedCount}${RESET}`);
        }
        // Online is the quiet default, so the footer only speaks up when the user is elsewhere.
        const presence = this.#presenceState?.presence;
        if (presence !== undefined && presence.id !== ONLINE_PRESENCE_ID) {
            parts.push(
                `${this.#theme.secondary}${presence.emoji} ${presence.title.toLowerCase()}${RESET}`,
            );
        }
        parts.push(
            `${this.#theme.secondary}${humanizePermissionMode(this.#agent.permissionMode).toLowerCase()}${RESET}`,
        );
        if (this.#showUsage) parts.push(`${this.#theme.secondary}${this.#usageFooter()}${RESET}`);

        const indent = " ".repeat(visibleWidth(INPUT_PROMPT));
        const separator = `${DIM} · ${RESET}`;
        const line = `${indent}${parts.join(separator)}`;
        if (visibleWidth(line) <= width || this.#activeAgentLabel === undefined) {
            return [this.#fitLine(line, width)];
        }

        const access = parts.at(this.#showUsage ? -2 : -1);
        if (access === undefined) return [this.#fitLine(line, width)];
        const prefixParts = parts.filter((part) => part !== access);
        const suffix = `${separator}${access}`;
        const prefixWidth = Math.max(0, width - visibleWidth(suffix));
        if (prefixWidth === 0) return [this.#fitLine(`${indent}${access}`, width)];
        return [
            `${truncateToWidth(`${indent}${prefixParts.join(separator)}`, prefixWidth)}${suffix}`,
        ];
    }

    #activeSubagentCount(): number {
        return this.#subagents.filter((subagent) => this.#isActiveSubagent(subagent)).length;
    }

    #isActiveSubagent(subagent: SubagentSummary): boolean {
        return (
            (subagent.status === "queued" || subagent.status === "running") &&
            !subagent.taskName?.startsWith("workflow_")
        );
    }

    #hasActiveSubagentDescendant(parentId: string): boolean {
        const byId = new Map(this.#subagents.map((subagent) => [subagent.id, subagent]));
        return this.#subagents.some((subagent) => {
            if (!this.#isActiveSubagent(subagent)) return false;
            let parent = byId.get(subagent.parentSessionId);
            while (parent !== undefined) {
                if (parent.id === parentId) return true;
                parent = byId.get(parent.parentSessionId);
            }
            return false;
        });
    }

    #activeWorkflowCount(): number {
        return this.#workflows.filter((workflow) => workflow.status === "running").length;
    }

    #renderActiveWorkList(width: number): string[] {
        const activeSubagents = this.#subagents.filter((subagent) =>
            this.#isActiveSubagent(subagent),
        );
        const rows = [
            ...this.#renderActiveToolRows(width),
            renderSubagentSummary({
                count: activeSubagents.length,
                elapsedMs: Math.max(
                    0,
                    ...activeSubagents.map((subagent) => subagentElapsedMs(subagent, this.#now())),
                ),
                totalTokens: activeSubagents.reduce(
                    (total, subagent) => total + (subagent.totalTokens ?? 0),
                    0,
                ),
                width,
            }),
            renderWorkflowSummary(this.#activeWorkflowCount(), width),
            renderBackgroundTerminalSummary(this.#backgroundProcesses.length, width),
            renderPeerCapabilityIndicator(this.#sessionShare, width),
        ];
        return rows.filter((row): row is string => row !== undefined);
    }

    #renderActiveToolRows(width: number): string[] {
        const liveExplorationEntries = this.#liveExplorationEntries();
        const liveExplorationSet = new Set(liveExplorationEntries);
        const rows = this.#entries
            .filter(
                (entry) => this.#activeToolCallIds.has(entry.id) && !liveExplorationSet.has(entry),
            )
            .flatMap((entry) => this.#renderEntry(entry, width));
        if (liveExplorationEntries.length > 0) {
            rows.push(...this.#renderExplorationEntries(liveExplorationEntries, width));
        }
        return rows;
    }

    #liveExplorationEntries(): AppTranscriptEntry[] {
        const entries: AppTranscriptEntry[] = [];
        for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
            const entry = this.#entries[index];
            if (!this.#isExplorationEntry(entry)) break;
            entries.unshift(entry);
        }
        return entries.some((entry) => this.#activeToolCallIds.has(entry.id)) ? entries : [];
    }

    #isExplorationEntry(entry: AppTranscriptEntry | undefined): entry is AppTranscriptEntry {
        return (
            entry?.exploration !== undefined &&
            entry.role === "tool" &&
            entry.permissionReview === undefined &&
            !this.#stoppedToolCallIds.has(entry.id)
        );
    }

    #renderExplorationEntries(entries: readonly AppTranscriptEntry[], width: number): string[] {
        const active = entries.some((entry) => this.#activeToolCallIds.has(entry.id));
        return renderExploration(
            entries.flatMap((entry) =>
                entry.exploration === undefined ? [] : [entry.exploration],
            ),
            {
                accent: this.#theme.accent,
                brand: this.#theme.brand,
                primary: this.#theme.primary,
                status: active ? this.#theme.warning : this.#theme.success,
                title: active ? "Exploring" : "Explored",
                width,
            },
        );
    }

    #sessionUsage(): Usage {
        return this.#subagents.reduce(
            (total, subagent) =>
                subagent.usage === undefined ? total : addUsage(total, subagent.usage),
            this.#usage,
        );
    }

    #usageFooter(): string {
        const usage = this.#sessionUsage();
        const sessionTokens = this.#subagents.reduce(
            (total, subagent) =>
                total +
                (subagent.sessionTokenCount?.totalTokens ?? subagent.usage?.totalTokens ?? 0),
            this.#sessionTokenCount.totalTokens,
        );
        return formatSessionTokenStatus({
            contextTokens: this.#latestContextTokens,
            ...(this.#agent.model.contextWindow === undefined
                ? {}
                : { contextWindow: this.#agent.model.contextWindow }),
            sessionTokens,
            usage,
        });
    }

    #subagentMetrics(subagent: SubagentSummary): string {
        return `${formatActivityElapsedTime(subagentElapsedMs(subagent, this.#now()))} · ${formatTokens(subagent.totalTokens ?? 0)} context tokens`;
    }

    // A prompt that already owns a transcript row is shown there, so it is not also counted or
    // drawn as queued work waiting its turn.
    #promptsShownAsQueued(): PendingPrompt[] {
        return this.#pendingPrompts.filter((prompt) => prompt.transcriptAppended !== true);
    }

    #renderQueuedPrompts(width: number): string[] {
        return this.#promptsShownAsQueued().flatMap((prompt) => {
            const prefix = `${DIM}↳ queued${RESET} `;
            const prefixWidth = visibleWidth(prefix);
            const wrapped = wrapTextWithAnsi(
                prompt.displayText,
                Math.max(1, width - prefixWidth),
            ).slice(0, 3);
            const indent = " ".repeat(prefixWidth);
            return wrapped.map((line, index) =>
                this.#fitLine(`${index === 0 ? prefix : indent}${DIM}${line}${RESET}`, width),
            );
        });
    }

    #promotePendingSteeringMessages(messageIds: readonly string[]): void {
        for (const messageId of messageIds) {
            const index = this.#pendingSteeringMessages.findIndex(
                (pending) => pending.id === messageId,
            );
            if (index < 0) continue;
            const [pending] = this.#pendingSteeringMessages.splice(index, 1);
            if (pending !== undefined) {
                this.#entries.push({
                    id: pending.id,
                    role: "user",
                    text: pending.displayText,
                });
            }
        }
        this.#requestRender();
    }

    #renderAutocomplete(
        width: number,
        suggestions: readonly AutocompleteItem[],
        selectedIndex: number,
        maxVisible = AUTOCOMPLETE_MAX_VISIBLE,
    ): string[] {
        const rowWidth = Math.max(1, width - 1);
        const visibleCount = Math.max(1, Math.min(maxVisible, AUTOCOMPLETE_MAX_VISIBLE));
        const safeSelectedIndex = Math.min(selectedIndex, suggestions.length - 1);
        const startIndex = Math.max(
            0,
            Math.min(
                safeSelectedIndex - Math.floor(visibleCount / 2),
                suggestions.length - visibleCount,
            ),
        );
        const visibleSuggestions = suggestions.slice(startIndex, startIndex + visibleCount);
        const labelWidth = Math.max(
            8,
            ...visibleSuggestions.map((item) => visibleWidth(this.#singleLine(item.label)) + 2),
        );
        const labelColumnWidth = Math.min(labelWidth, Math.max(1, rowWidth - 2));

        return visibleSuggestions.map((item, index) => {
            const absoluteIndex = startIndex + index;
            const isSelected = absoluteIndex === safeSelectedIndex;
            const marker = isSelected ? "→ " : "  ";
            const label = this.#fitAndPadLine(this.#singleLine(item.label), labelColumnWidth);
            const remainingWidth = Math.max(
                0,
                rowWidth - visibleWidth(marker) - visibleWidth(label),
            );
            const description = truncateToWidth(
                this.#singleLine(item.description ?? ""),
                remainingWidth,
                "",
                false,
            );
            const line = isSelected
                ? `${this.#theme.brand}${marker}${label}${description}${RESET}`
                : `${marker}${label}${DIM}${this.#theme.secondary}${description}${RESET}`;
            return this.#fitLine(line, rowWidth);
        });
    }

    #openModelMenu(): void {
        if (this.#exiting || this.#stopped) {
            return;
        }

        const selectedModelId = this.#agent.model.id;
        const selectedProviderId = this.#agent.provider.id;
        const selectedValue = encodeModelChoice(selectedProviderId, selectedModelId);
        const choices = this.#modelChoices();
        const panel = createSelectionPanel({
            theme: this.#theme,
            title: "Choose Model",
            subtitle: this.#modelLocked
                ? "Wait for the active response to finish"
                : "Enter selects, Esc cancels",
            selectedValue,
            items: choices.map((choice) => ({
                value: encodeModelChoice(choice.providerId, choice.model.id),
                label: choice.model.name,
                description: describeModelChoice(
                    choice.model,
                    choice.providerId,
                    choice.model.id === selectedModelId && choice.providerId === selectedProviderId,
                    {
                        locked:
                            this.#modelLocked &&
                            (choice.model.id !== selectedModelId ||
                                choice.providerId !== selectedProviderId),
                    },
                ),
            })),
            onSelect: (item) => {
                const choice = choices.find(
                    (candidate) =>
                        encodeModelChoice(candidate.providerId, candidate.model.id) === item.value,
                );
                if (choice === undefined) {
                    this.#closeSelectionPanel();
                    return;
                }
                if (this.#modelLocked && item.value !== selectedValue) {
                    this.#appendEntry({
                        role: "event",
                        title: "Model",
                        text: "Wait for the active response to finish before changing models.",
                    });
                    this.#closeSelectionPanel();
                    this.#requestRender();
                    return;
                }

                this.#closeSelectionPanel();
                this.#openReasoningMenu(choice);
            },
            onCancel: () => {
                this.#closeSelectionPanel();
            },
        });
        this.#showSelectionPanel(panel);
    }

    #openReasoningMenu(choice: CodingAssistantModelChoice): void {
        const { model, providerId } = choice;

        const currentEffort = this.#agent.snapshot().effort;
        const defaultEffort = model.defaultThinkingLevel;
        const isCurrent =
            model.id === this.#agent.model.id && providerId === this.#agent.provider.id;
        const selectedEffort =
            isCurrent && currentEffort !== undefined && model.thinkingLevels.includes(currentEffort)
                ? currentEffort
                : defaultEffort;
        const panel = createSelectionPanel({
            theme: this.#theme,
            title: "Choose Reasoning",
            subtitle: model.name,
            selectedValue: selectedEffort,
            items: model.thinkingLevels.map((level) => ({
                value: level,
                label: humanizeReasoningLevel(level),
                description: describeReasoningLevel(level, {
                    isCurrent: isCurrent && level === currentEffort,
                    isDefault: level === defaultEffort,
                }),
            })),
            onSelect: (item) => {
                if (this.#modelLocked || isCurrent) {
                    this.#agent.setEffort(item.value);
                    if (!this.#modelLocked) {
                        this.#persistDefaultModel(
                            model.id,
                            item.value,
                            providerId,
                            this.#agent.confirmedServiceTier ?? null,
                        );
                    }
                    if (!this.#sessionBacked) {
                        this.#appendEntry({
                            role: "event",
                            title: "Reasoning",
                            text: `Reasoning changed to ${humanizeReasoningLevel(item.value)}.`,
                        });
                    }
                } else {
                    const completeChange = () => {
                        this.#persistDefaultModel(
                            model.id,
                            item.value,
                            providerId,
                            this.#agent.confirmedServiceTier ?? null,
                        );
                        if (!this.#sessionBacked) {
                            this.#appendEntry({
                                role: "event",
                                title: "Model",
                                text: `Model changed to ${model.name} with ${humanizeReasoningLevel(item.value)} reasoning.`,
                            });
                        }
                        this.#requestRender();
                    };
                    try {
                        const change = this.#agent.setModel(model.id, item.value, providerId);
                        if (change === undefined) {
                            completeChange();
                        } else {
                            void change.then(completeChange).catch((error: unknown) => {
                                this.#appendEntry({
                                    role: "error",
                                    text: `Could not change to ${model.name}: ${errorToMessage(error)}`,
                                });
                                this.#requestRender();
                            });
                        }
                    } catch (error) {
                        this.#appendEntry({
                            role: "error",
                            text: `Could not change to ${model.name}: ${errorToMessage(error)}`,
                        });
                    }
                }
                this.#closeSelectionPanel();
                this.#requestRender();
            },
            onCancel: () => {
                this.#closeSelectionPanel();
            },
        });
        this.#showSelectionPanel(panel);
    }

    #openConfigureMenu(): void {
        if (this.#exiting || this.#stopped) {
            return;
        }

        const panel = createSelectionPanel({
            theme: this.#theme,
            title: "Configure",
            subtitle: "App settings",
            items: [
                {
                    value: "reasoning",
                    label: this.#showReasoning ? "Hide reasoning" : "Show reasoning",
                    description: "Toggle reasoning blocks in the transcript.",
                },
                {
                    value: "usage",
                    label: this.#showUsage ? "Hide token status" : "Show token status",
                    description: "Toggle session tokens, cache hit, and context left below input.",
                },
                {
                    value: "completion-chime",
                    label: this.#completionChime
                        ? "Disable completion chime"
                        : "Enable completion chime",
                    description: "Ring once when all session work has settled.",
                },
                {
                    value: "durable-events",
                    label: this.#durableGlobalEventQueue
                        ? "Disable durable event queue"
                        : "Enable durable event queue",
                    description: "Persist every daemon event for external synchronization.",
                },
                {
                    value: "compact-turns",
                    label: this.#compactCompletedTurns
                        ? "Show full completed turns"
                        : "Compact completed turns",
                    description: "Keep turn stats and the final response after completion.",
                },
                {
                    value: "inference-retries",
                    label: `Inference retries · ${this.#inferenceMaxRetries}`,
                    description: "Maximum retries before any inference provider reports failure.",
                },
            ],
            onSelect: (item) => {
                if (item.value === "inference-retries") {
                    this.#openInferenceRetriesInput();
                    return;
                }
                if (item.value === "compact-turns") {
                    this.#compactCompletedTurns = !this.#compactCompletedTurns;
                }
                if (item.value === "reasoning") this.#showReasoning = !this.#showReasoning;
                if (item.value === "usage") this.#showUsage = !this.#showUsage;
                if (item.value === "completion-chime") {
                    this.#completionChime = !this.#completionChime;
                }
                if (item.value === "durable-events") {
                    this.#durableGlobalEventQueue = !this.#durableGlobalEventQueue;
                }
                this.#persistSettings();
                this.#closeSelectionPanel();
                let text: string;
                if (item.value === "compact-turns") {
                    text = `Completed turn compaction ${this.#compactCompletedTurns ? "enabled" : "disabled"}.`;
                } else if (item.value === "reasoning") {
                    text = `Reasoning display ${this.#showReasoning ? "enabled" : "disabled"}.`;
                } else if (item.value === "usage") {
                    text = `Token status ${this.#showUsage ? "enabled" : "disabled"}.`;
                } else if (item.value === "completion-chime") {
                    text = `Completion chime ${this.#completionChime ? "enabled" : "disabled"}.`;
                } else {
                    text = `Durable event queue ${this.#durableGlobalEventQueue ? "enabled" : "disabled"}.`;
                }
                this.#appendEntry({
                    role: "event",
                    title: "Settings",
                    text,
                });
                this.#requestRender();
            },
            onCancel: () => {
                this.#closeSelectionPanel();
            },
        });
        this.#showSelectionPanel(panel);
    }

    #openInferenceRetriesInput(error?: string): void {
        this.#showSelectionPanel(
            createSecretInputPanel({
                label: "Attempts",
                masked: false,
                onCancel: () => this.#openConfigureMenu(),
                onSubmit: (value) => {
                    const normalized = value.trim();
                    const attempts = Number(normalized);
                    if (
                        !/^\d+$/u.test(normalized) ||
                        !Number.isInteger(attempts) ||
                        attempts > MAX_INFERENCE_MAX_RETRIES
                    ) {
                        this.#openInferenceRetriesInput(
                            `Enter a whole number from 0 to ${MAX_INFERENCE_MAX_RETRIES}.`,
                        );
                        return;
                    }
                    this.#inferenceMaxRetries = attempts;
                    this.#closeSelectionPanel();
                    this.#persistSettings(() => {
                        this.#appendEntry({
                            role: "event",
                            title: "Settings",
                            text: `Inference retries set to ${attempts}.`,
                        });
                        this.#requestRender();
                    });
                },
                subtitle: error ?? `Enter a whole number from 0 to ${MAX_INFERENCE_MAX_RETRIES}.`,
                theme: this.#theme,
                title: "Inference retries",
            }),
        );
    }

    #openPermissionsMenu(): void {
        const panel = createSelectionPanel({
            theme: this.#theme,
            title: "Choose Permissions",
            subtitle: "Applies to this session and its subagents",
            selectedValue: this.#agent.permissionMode,
            items: [
                {
                    value: "auto",
                    label: "Auto",
                    description: "Automatically review risky actions without interrupting you.",
                },
                {
                    value: "workspace_write",
                    label: "Workspace write",
                    description: "Write in the workspace; block shell network access.",
                },
                {
                    value: "read_only",
                    label: "Read only",
                    description: "Keep project files read only; allow temporary files.",
                },
                {
                    value: "full_access",
                    label: "Full access",
                    description: "Allow unrestricted filesystem, shell, and network access.",
                },
            ],
            onSelect: (item) => {
                const mode = item.value as "auto" | "workspace_write" | "read_only" | "full_access";
                try {
                    const change = this.#agent.setPermissionMode(mode);
                    void Promise.resolve(change)
                        .then(() => {
                            if (!this.#sessionBacked) {
                                this.#appendEntry({
                                    role: "event",
                                    title: "Permissions",
                                    text: `Permissions changed to ${humanizePermissionMode(mode)}.`,
                                });
                            }
                            this.#requestRender();
                        })
                        .catch((error: unknown) => {
                            this.#appendEntry({ role: "error", text: errorToMessage(error) });
                            this.#requestRender();
                        });
                } catch (error) {
                    this.#appendEntry({ role: "error", text: errorToMessage(error) });
                }
                this.#closeSelectionPanel();
                this.#requestRender();
            },
            onCancel: () => this.#closeSelectionPanel(),
        });
        this.#showSelectionPanel(panel);
    }

    #enqueueUserInputRequest(request: UserInputRequest): void {
        if (
            this.#userInputRequests.some((candidate) => candidate.requestId === request.requestId)
        ) {
            return;
        }
        if (request.requestId.endsWith(":permission")) {
            const toolCallId = request.requestId.slice(0, -":permission".length);
            this.#reviewingPermissionToolCallIds.delete(toolCallId);
            this.#awaitingApprovalToolCallIds.add(toolCallId);
            this.#refreshToolActivityStatus();
        }
        this.#userInputRequests.push(request);
        this.#openNextUserInputRequest();
    }

    #openNextUserInputRequest(): void {
        if (
            this.#activeUserInput !== undefined ||
            this.#answeringUserInputRequestId !== undefined ||
            this.#freeformUserInput !== undefined
        ) {
            return;
        }
        const request = this.#userInputRequests[0];
        if (request === undefined) return;
        this.#activeUserInput = {
            answers: {},
            questionIndex: 0,
            request,
            selected: new Set(),
        };
        this.#openUserInputQuestion();
    }

    #openUserInputQuestion(): void {
        const active = this.#activeUserInput;
        const question = active?.request.questions[active.questionIndex];
        if (active === undefined || question === undefined) return;
        const isPermissionRequest = active.request.requestId.endsWith(":permission");

        const items = question.options.map((option, index) => ({
            value: `option:${index}`,
            label: active.selected.has(option.label) ? `✓ ${option.label}` : option.label,
            description: option.description,
        }));
        if (question.multiSelect && active.selected.size > 0) {
            items.push({
                value: "done",
                label: "Done",
                description: `Submit ${active.selected.size} selected answer${active.selected.size === 1 ? "" : "s"}.`,
            });
        }
        if (question.required === false) {
            items.push({
                value: "skip",
                label: "Leave unset",
                description: "Leave this optional answer unset.",
            });
        }
        items.push({
            value: "other",
            label: "Type another answer",
            description: "Enter a response that is not listed.",
        });

        this.#showInlineSelectionPanel(
            createSelectionPanel({
                cancelDisabled: !isPermissionRequest,
                theme: this.#theme,
                title: question.header,
                subtitle: `${question.question} · ${active.questionIndex + 1} of ${active.request.questions.length}`,
                items,
                onSelect: (item) => {
                    if (item.value === "other") {
                        this.#freeformUserInput = {
                            existingAnswers: [...active.selected],
                            questionId: question.id,
                            requestId: active.request.requestId,
                        };
                        this.#closeSelectionPanel();
                        this.#editor.setText("");
                        this.#requestRender();
                        return;
                    }
                    if (item.value === "done") {
                        this.#commitUserInputAnswer([...active.selected]);
                        return;
                    }
                    if (item.value === "skip") {
                        this.#commitUserInputAnswer([]);
                        return;
                    }

                    const optionIndex = Number.parseInt(item.value.slice("option:".length), 10);
                    const option = question.options[optionIndex];
                    if (option === undefined) return;
                    if (!question.multiSelect) {
                        this.#commitUserInputAnswer([option.label]);
                        return;
                    }
                    if (active.selected.has(option.label)) active.selected.delete(option.label);
                    else active.selected.add(option.label);
                    this.#openUserInputQuestion();
                    this.#requestRender();
                },
                onCancel: () => {
                    if (!isPermissionRequest) return;
                    this.#closeSelectionPanel();
                    this.#handleMainComposerEscape();
                },
            }),
        );
        this.#requestRender();
    }

    #commitUserInputAnswer(answers: readonly string[]): void {
        const active = this.#activeUserInput;
        const question = active?.request.questions[active.questionIndex];
        if (active === undefined || question === undefined) return;
        if (answers.length === 0 && question.required !== false) return;

        if (answers.length === 0) delete active.answers[question.id];
        else active.answers[question.id] = [...answers];
        active.questionIndex += 1;
        active.selected = new Set();
        if (active.questionIndex < active.request.questions.length) {
            this.#openUserInputQuestion();
            return;
        }
        this.#sendUserInputResponse(active.request, { answers: active.answers });
    }

    #submitFreeformUserInput(value: string): void {
        const answer = value.trim();
        const freeform = this.#freeformUserInput;
        const active = this.#activeUserInput;
        if (answer.length === 0 || freeform === undefined || active === undefined) return;
        if (active.request.requestId !== freeform.requestId) return;
        if (active.request.questions[active.questionIndex]?.id !== freeform.questionId) return;

        this.#leaveFreeformUserInput();
        this.#commitUserInputAnswer([...freeform.existingAnswers, answer]);
        this.#requestRender();
    }

    #sendUserInputResponse(request: UserInputRequest, response: UserInputResponse): void {
        this.#activeUserInput = undefined;
        this.#closeSelectionPanel();
        if (this.#respondUserInput === undefined) {
            this.#appendEntry({
                role: "error",
                text: "This client cannot send interactive answers.",
            });
            this.#removeUserInputRequest(request.requestId);
            this.#handleMainComposerEscape();
            return;
        }

        this.#answeringUserInputRequestId = request.requestId;
        void Promise.resolve(this.#respondUserInput(request.requestId, response))
            .then(() => this.#removeUserInputRequest(request.requestId))
            .catch((error: unknown) => {
                this.#answeringUserInputRequestId = undefined;
                this.#appendEntry({
                    role: "error",
                    text: `The answer could not be sent: ${errorToMessage(error)}`,
                });
                this.#openNextUserInputRequest();
                this.#requestRender();
            });
    }

    #removeUserInputRequest(requestId: string): void {
        const wasActive = this.#activeUserInput?.request.requestId === requestId;
        const wasFreeform = this.#freeformUserInput?.requestId === requestId;
        if (requestId.endsWith(":permission")) {
            const toolCallId = requestId.slice(0, -":permission".length);
            const wasReviewing = this.#reviewingPermissionToolCallIds.delete(toolCallId);
            const wasAwaiting = this.#awaitingApprovalToolCallIds.delete(toolCallId);
            if (wasReviewing || wasAwaiting) {
                this.#refreshToolActivityStatus();
            }
        }
        this.#userInputRequests = this.#userInputRequests.filter(
            (request) => request.requestId !== requestId,
        );
        if (wasActive) this.#activeUserInput = undefined;
        if (wasFreeform) this.#leaveFreeformUserInput();
        if (this.#answeringUserInputRequestId === requestId) {
            this.#answeringUserInputRequestId = undefined;
        }
        if (wasActive || wasFreeform) this.#closeSelectionPanel();
        this.#openNextUserInputRequest();
        this.#requestRender();
    }

    #clearUserInputRequests(): void {
        const hadVisibleRequest =
            this.#activeUserInput !== undefined || this.#freeformUserInput !== undefined;
        this.#userInputRequests = [];
        this.#activeUserInput = undefined;
        this.#answeringUserInputRequestId = undefined;
        this.#leaveFreeformUserInput();
        if (hadVisibleRequest) this.#closeSelectionPanel();
    }

    #showSelectionPanel(component: Component): void {
        this.#secretMenu.hide();
        this.#setSelectionPanel(component, true);
    }

    #showInlineSelectionPanel(component: Component): void {
        this.#secretMenu.hide();
        this.#setSelectionPanel(component, false);
    }

    #closeSelectionPanel(): void {
        this.#secretMenu.hide();
        this.#setSelectionPanel(undefined);
    }

    #setSelectionPanel(component: Component | undefined, fullscreen = false): void {
        if (this.#selectionPanel !== component) {
            (this.#selectionPanel as Partial<SubagentMonitor> | undefined)?.dispose?.();
        }
        this.#selectionPanel = component;
        this.#selectionPanelFullscreen = component !== undefined && fullscreen;
        this.#syncTemporaryFullscreen();
    }

    #syncTemporaryFullscreen(): void {
        if (!this.#started) return;
        if (this.#selectionPanelFullscreen || this.#backgroundTerminalViewer !== undefined) {
            this.#temporaryFullscreen.open(this.#lastNormalRender === undefined);
            this.#requestRender();
        } else {
            this.#temporaryFullscreen.close();
        }
    }

    #paintTemporaryFullscreen(): void {
        const component =
            this.#backgroundTerminalViewer ??
            (this.#selectionPanelFullscreen ? this.#selectionPanel : undefined);
        if (!this.#started || component === undefined) return;
        const width = Math.max(1, this.#tui.terminal.columns);
        const height = Math.max(1, this.#tui.terminal.rows);
        this.#temporaryFullscreen.render(this.#fullscreenLines(component, width), width, height);
    }

    #fullscreenLines(component: Component, width: number): string[] {
        return renderFullscreenComponent({
            component,
            height: this.#tui.terminal.rows,
            theme: this.#theme,
            width,
        });
    }

    #renderInput(width: number): string[] {
        return [
            this.#surfaceLine("", width),
            ...this.#renderInputContent(width),
            this.#surfaceLine("", width),
        ];
    }

    #renderInputContent(width: number): string[] {
        if (this.#editor.getText().length === 0) {
            return [this.#inputSurfaceLine(this.#emptyInputLine(), width)];
        }

        const promptWidth = visibleWidth(INPUT_PROMPT);
        const editorWidth = Math.max(1, width - promptWidth);
        const contentLines = this.#stripSpuriousLeadingEmptyLine(
            this.#stripEditorChrome(this.#editor.render(editorWidth)),
        );

        return contentLines.map((line, index) => {
            if (this.#isEditorScrollIndicator(line)) {
                return this.#inputSurfaceLine(`${INPUT_LINE_INDENT}${DIM}${line}${RESET}`, width);
            }
            const prefix = index === 0 ? this.#inputPrompt() : INPUT_LINE_INDENT;
            const rendered = `${prefix}${this.#styleImagePlaceholders(line)}`;
            return this.#inputSurfaceLine(
                this.#cursorVisible ? rendered : this.#hideCursor(rendered),
                width,
            );
        });
    }

    #finishToolResult(
        block: Pick<
            ToolResultBlock,
            "display" | "failure" | "isError" | "presentation" | "toolCallId" | "toolName"
        > &
            Partial<Pick<ToolResultBlock, "rendered">>,
    ): void {
        this.#moveActiveToolEntryToTranscriptTail(block.toolCallId);
        this.#activeToolCallIds.delete(block.toolCallId);
        this.#awaitingApprovalToolCallIds.delete(block.toolCallId);
        this.#reviewingPermissionToolCallIds.delete(block.toolCallId);
        this.#runningToolCallIds.delete(block.toolCallId);
        this.#toolStatusByCallId.delete(block.toolCallId);
        if (block.isError === true && block.failure?.kind === "interrupted") {
            this.#stoppedToolCallIds.add(block.toolCallId);
        } else {
            this.#stoppedToolCallIds.delete(block.toolCallId);
        }
        const existing = this.#entries.find((entry) => entry.id === block.toolCallId);
        if (
            block.presentation?.type === "background_terminal_interaction" &&
            block.presentation.input === ""
        ) {
            if (existing !== undefined) this.#removeUnrenderedToolEntry(existing);
            return;
        }
        const detail = this.#formatToolResult(block);
        if (existing !== undefined) {
            existing.role = block.isError ? "error" : "tool";
            existing.title = this.#toolDisplayName(block.toolName);
            if (
                block.isError === true ||
                (block.presentation?.type === "exec_command" &&
                    block.presentation.sessionId !== undefined)
            ) {
                delete existing.exploration;
            }
            if (block.presentation?.type === "exploration" && block.isError !== true) {
                existing.exploration = block.presentation;
                delete existing.backgroundTerminalInteraction;
                delete existing.detail;
                delete existing.execCommand;
                delete existing.fileDiffs;
                delete existing.omittedFileDiffs;
                return;
            }
            if (block.presentation?.type === "exec_command") {
                existing.execCommand = block.presentation;
                delete existing.backgroundTerminalInteraction;
                delete existing.detail;
                delete existing.fileDiffs;
                delete existing.omittedFileDiffs;
                this.#trackYieldedBackgroundTerminal(block.presentation);
                return;
            } else if (block.isError === true) {
                delete existing.backgroundTerminalInteraction;
                delete existing.fileDiffs;
                delete existing.omittedFileDiffs;
            } else if (block.presentation?.type === "background_terminal_interaction") {
                existing.backgroundTerminalInteraction = block.presentation;
                delete existing.detail;
                delete existing.fileDiffs;
                delete existing.omittedFileDiffs;
                return;
            } else if (
                block.presentation?.type === "file_diff" &&
                block.presentation.files.length > 0
            ) {
                existing.fileDiffs = block.presentation.files;
                if (block.presentation.omittedFiles === undefined) {
                    delete existing.omittedFileDiffs;
                } else {
                    existing.omittedFileDiffs = block.presentation.omittedFiles;
                }
            }
            if (existing.mcpToolCall !== undefined) {
                const result =
                    formatCodexMcpToolResult(block.rendered) ??
                    (block.isError === true ? undefined : "(empty result)");
                existing.mcpToolCall = {
                    invocation: existing.mcpToolCall.invocation,
                    ...(result === undefined
                        ? existing.mcpToolCall.result === undefined
                            ? {}
                            : { result: existing.mcpToolCall.result }
                        : { result }),
                    status: block.isError === true ? "error" : "success",
                };
            }
            if (block.failure?.kind === "tool_unavailable") {
                existing.text = this.#toolDisplayName(block.toolName);
            }
            existing.detail = detail;
            return;
        }

        const appended = this.#appendEntry({
            id: block.toolCallId,
            role: block.isError ? "error" : "tool",
            title: this.#toolDisplayName(block.toolName),
            text: this.#toolDisplayName(block.toolName),
            ...(block.presentation?.type === "background_terminal_interaction"
                ? { backgroundTerminalInteraction: block.presentation }
                : block.presentation?.type === "exec_command"
                  ? { execCommand: block.presentation }
                  : block.presentation?.type === "exploration" && block.isError !== true
                    ? { exploration: block.presentation }
                    : { detail }),
            ...(block.isError !== true &&
            block.presentation?.type === "file_diff" &&
            block.presentation.files.length > 0
                ? { fileDiffs: block.presentation.files }
                : {}),
            ...(block.isError !== true &&
            block.presentation?.type === "file_diff" &&
            block.presentation.omittedFiles !== undefined
                ? { omittedFileDiffs: block.presentation.omittedFiles }
                : {}),
        });
        if (appended.execCommand !== undefined) {
            this.#trackYieldedBackgroundTerminal(appended.execCommand);
        }
    }

    #moveActiveToolEntryToTranscriptTail(toolCallId: string): void {
        if (!this.#activeToolCallIds.has(toolCallId)) return;
        const index = this.#entries.findIndex((entry) => entry.id === toolCallId);
        if (index < 0 || index === this.#entries.length - 1) return;
        const [entry] = this.#entries.splice(index, 1);
        if (entry !== undefined) this.#entries.push(entry);
    }

    #formatToolCall(toolName: string, args: unknown, toolCallId?: string): string {
        const record = this.#isRecord(args) ? args : {};
        const stringField = (key: string): string | undefined => {
            const value = record[key];
            return typeof value === "string" && value.length > 0 ? value : undefined;
        };

        const normalized = toolName.toLowerCase();
        const resolvedModelId =
            toolCallId === undefined
                ? undefined
                : this.#subagents.find((subagent) => subagent.parentToolCallId === toolCallId)
                      ?.modelId;
        const subagentCall = formatSubagentToolCall({
            args: record,
            currentModel: this.#agent.model,
            currentProviderId: this.#agent.provider.id,
            modelChoices: this.#modelChoices(),
            ...(resolvedModelId === undefined ? {} : { resolvedModelId }),
            toolName,
        });
        if (subagentCall !== undefined) return subagentCall;
        if (normalized === "write_stdin") {
            const chars = record.chars;
            return typeof chars === "string" && chars.length > 0
                ? "Interacting with background terminal"
                : "Waiting for background terminal";
        }
        if (normalized === "request_user_input" || normalized === "askuserquestion") {
            const questions = record.questions;
            const firstQuestion = Array.isArray(questions) ? questions[0] : undefined;
            if (this.#isRecord(firstQuestion) && typeof firstQuestion.question === "string") {
                return this.#singleLine(firstQuestion.question);
            }
            return "Waiting for your answer";
        }
        const command = stringField("cmd") ?? stringField("command");
        if (command !== undefined) {
            const shell = stringField("shell");
            const shellSuffix = shell === undefined ? "" : ` (Shell: ${this.#singleLine(shell)})`;
            const secrets = Array.isArray(record.secrets)
                ? record.secrets.filter((value): value is string => typeof value === "string")
                : [];
            const secretSuffix =
                secrets.length === 0
                    ? ""
                    : ` (Secrets: ${secrets.map((id) => this.#singleLine(id)).join(", ")})`;
            return `${this.#singleLine(command)}${shellSuffix}${secretSuffix}`;
        }

        const path = stringField("file_path") ?? stringField("path");
        if (path !== undefined) {
            return this.#singleLine(path);
        }

        const pattern = stringField("pattern");
        if (pattern !== undefined) {
            return this.#singleLine(pattern);
        }

        const query = stringField("query");
        if (query !== undefined) {
            return this.#singleLine(query);
        }

        if (normalized === "todowrite") {
            const todos = record.todos;
            return Array.isArray(todos)
                ? `${todos.length} todo${todos.length === 1 ? "" : "s"}`
                : "todos";
        }

        if (normalized === "taskcreate") {
            return stringField("subject") ?? "Create task";
        }
        if (normalized === "taskget") {
            const taskId = stringField("taskId");
            return taskId === undefined ? "Read task" : `Read task ${taskId}`;
        }
        if (normalized === "taskupdate") {
            const taskId = stringField("taskId");
            return taskId === undefined ? "Update task" : `Update task ${taskId}`;
        }
        if (normalized === "tasklist") return "Current tasks";
        if (normalized === "followup_task" || normalized === "sendmessage") {
            return stringField("summary") ?? "Send follow-up work";
        }
        if (normalized === "wait_agent") return "Wait for delegated work";
        if (normalized === "list_agents") return "Show delegated work";
        if (normalized === "interrupt_agent") return "Stop delegated work";

        return this.#toolDisplayName(toolName);
    }

    #createMcpToolCall(toolName: string, args: unknown): CodexMcpToolCall | undefined {
        const invocation = parseCodexMcpToolInvocation(toolName, args);
        return invocation === undefined ? undefined : { invocation, status: "active" };
    }

    #toolDisplayName(toolName: string): string {
        return humanizeToolName(toolName);
    }

    #formatToolResult(block: Pick<ToolResultBlock, "display" | "failure" | "toolName">): string {
        const display = block.display.length > 0 ? block.display : "(empty result)";
        return this.#singleLine(formatToolResultForDisplay({ ...block, display }));
    }

    #formatImageType(mediaType: string): string {
        const subtype = mediaType.split("/")[1]?.split(";")[0]?.trim();
        if (subtype === undefined || subtype.length === 0) {
            return "IMAGE";
        }

        const upperSubtype = subtype.toUpperCase();
        return upperSubtype === "JPEG" ? "JPG" : upperSubtype;
    }

    #styleImagePlaceholders(text: string): string {
        return text.replace(
            IMAGE_PLACEHOLDER_REGEX,
            (placeholder) =>
                `${IMAGE_CHIP_BG}${IMAGE_CHIP_FG}${placeholder}${this.#theme.inputBackground}${this.#theme.primary}`,
        );
    }

    #fitLine(line: string, width: number): string {
        return truncateToWidth(line, width, "", true);
    }

    #renderUserEntry(entry: AppTranscriptEntry, width: number): string[] {
        const prefix =
            entry.contextOnly === true
                ? `${BOLD}›${NOT_BOLD_OR_DIM} ${DIM}context ·${RESET} `
                : `${BOLD}›${NOT_BOLD_OR_DIM} `;
        const prefixWidth = visibleWidth(prefix);
        const contentWidth = Math.max(1, width - prefixWidth);
        const text = this.#styleImagePlaceholders(entry.text.length === 0 ? " " : entry.text);
        const wrapped = wrapTextWithAnsi(text, contentWidth);
        const indent = " ".repeat(prefixWidth);
        return [
            this.#surfaceLine("", width),
            ...wrapped.map((line, index) =>
                this.#inputSurfaceLine(`${index === 0 ? prefix : indent}${line}`, width),
            ),
            this.#surfaceLine("", width),
        ];
    }

    #renderAssistantEntry(entry: AppTranscriptEntry, width: number): string[] {
        const prefix = `${DIM}•${RESET} `;
        const prefixWidth = visibleWidth(prefix);
        const contentWidth = Math.max(1, width - prefixWidth);
        const isStreaming = entry.id === this.#streamEntryId;
        if (!isStreaming && entry.text.trim().length === 0) return [];
        const renderMarkdown = (text: string): readonly string[] =>
            renderAgentMarkdown({
                text,
                width: contentWidth,
                cwd: this.#cwd,
                theme: this.#theme,
            });
        let renderedMarkdown: readonly string[];
        if (isStreaming && containsMarkdownTable(entry.text)) {
            this.#assistantStreamingRender.discard(entry);
            const mutableTableRows = Math.max(1, this.#tui.terminal.rows - 8);
            renderedMarkdown = renderMarkdown(entry.text).slice(0, mutableTableRows);
        } else {
            renderedMarkdown = this.#assistantStreamingRender.render({
                entry,
                isStreaming,
                render: renderMarkdown,
                text: entry.text,
                width: contentWidth,
            });
        }
        if (isStreaming && renderedMarkdown.length === 0) {
            renderedMarkdown = [" ".repeat(contentWidth)];
        }
        const indent = " ".repeat(prefixWidth);
        return renderedMarkdown.map((line, index) =>
            this.#fitLine(`${index === 0 ? prefix : indent}${line}`, width),
        );
    }

    #renderThinkingEntry(entry: AppTranscriptEntry, width: number): string[] {
        const prefix = `${DIM}•${RESET} `;
        const prefixWidth = visibleWidth(prefix);
        const contentWidth = Math.max(1, width - prefixWidth);
        const isStreaming = this.#streamingThinkingEntryIds.has(entry.id);
        if (!isStreaming && entry.text.trim().length === 0) return [];
        let renderedMarkdown = this.#thinkingStreamingRender.render({
            entry,
            isStreaming,
            render: (text) =>
                renderAgentMarkdown({
                    text,
                    width: contentWidth,
                    cwd: this.#cwd,
                    theme: this.#theme,
                }),
            text: entry.text,
            width: contentWidth,
        });
        if (isStreaming && renderedMarkdown.length === 0) {
            renderedMarkdown = [" ".repeat(contentWidth)];
        }
        const indent = " ".repeat(prefixWidth);
        return renderedMarkdown.map((line, index) =>
            this.#fitLine(`${index === 0 ? prefix : indent}${line}`, width),
        );
    }

    #renderToolEntry(entry: AppTranscriptEntry, width: number, isError: boolean): string[] {
        if (
            !isError &&
            entry.title === PENDING_TOOL_CALL_TITLE &&
            entry.text === PENDING_TOOL_CALL_TITLE
        ) {
            if (this.#shouldRenderActivityAsLastMessage()) return [];
            return [this.#fitLine(`${DIM}• ${PENDING_TOOL_CALL_TITLE}${RESET}`, width)];
        }

        const toolName = entry.title ?? "tool";
        const active = this.#activeToolCallIds.has(entry.id);
        const awaitingApproval = this.#awaitingApprovalToolCallIds.has(entry.id);
        const stopped = this.#stoppedToolCallIds.has(entry.id);
        const verb = stopped
            ? "Stopped"
            : isError
              ? "Failed"
              : awaitingApproval
                ? "Awaiting approval"
                : this.#toolVerb(toolName, active);
        const dot =
            stopped || isError
                ? this.#theme.error
                : awaitingApproval
                  ? this.#theme.warning
                  : this.#theme.success;
        const callText = this.#singleLine(entry.text);
        const displayText = callText.length > 0 && callText !== toolName ? callText : toolName;
        if (toolName === "Write stdin" && active) return [];
        const title = `${dot}•${RESET} ${this.#theme.brand}${BOLD}${verb}${NOT_BOLD_OR_DIM}${this.#theme.primary} ${displayText}${RESET}`;
        const lines = [this.#fitLine(title, width)];
        const childRows: ChildRow[] = [];
        if (entry.permissionReview !== undefined && width >= 5) {
            childRows.push({ prefix: DIM, suffix: RESET, text: entry.permissionReview });
        }
        if (entry.detail !== undefined) {
            const detailText = entry.detail.length > 0 ? entry.detail : "(empty result)";
            childRows.push({
                prefix: DIM,
                suffix: RESET,
                text: detailText,
                wrap: isError,
            });
        }
        lines.push(
            ...renderChildRows(childRows, {
                afterMarker: `${RESET}${DIM}`,
                markerStyle: DIM,
                width,
            }),
        );
        return lines;
    }

    #renderMcpToolEntry(entry: AppTranscriptEntry, width: number): string[] {
        const call = entry.mcpToolCall;
        if (call === undefined) return [];
        const stopped = this.#stoppedToolCallIds.has(entry.id);
        let result = call.result;
        if (
            result === undefined &&
            entry.detail !== undefined &&
            call.status === "active" &&
            !stopped
        ) {
            result = entry.detail;
        }
        if (stopped && (result === undefined || (Array.isArray(result) && result.length === 0))) {
            result = "Interrupted.";
        }

        return renderCodexMcpToolCall(
            {
                invocation: call.invocation,
                ...(entry.permissionReview === undefined ? {} : { review: entry.permissionReview }),
                ...(result === undefined ? {} : { result }),
                status: stopped ? "error" : call.status,
            },
            {
                palette: {
                    accent: this.#theme.accent,
                    error: this.#theme.error,
                    primary: this.#theme.primary,
                    success: this.#theme.success,
                },
                width,
            },
        );
    }

    #renderFileDiffEntry(entry: AppTranscriptEntry, width: number): string[] {
        const diffs: readonly FileDiff[] = entry.fileDiffs ?? [];
        const visibleDiffs = diffs.slice(0, MAX_DIFF_FILES_PER_TOOL);
        const rowsPerFile = Math.max(
            1,
            Math.floor(MAX_DIFF_ROWS_PER_TOOL / Math.max(1, visibleDiffs.length)) - 1,
        );
        const palette =
            this.#theme.isLight === true ? CODEX_LIGHT_DIFF_PALETTE : CODEX_DARK_DIFF_PALETTE;
        const lines: string[] = [];
        if (entry.permissionReview !== undefined && width >= 5) {
            lines.push(
                ...renderChildRows(
                    [
                        {
                            prefix: DIM,
                            suffix: NOT_BOLD_OR_DIM,
                            text: sanitizeTerminalText(entry.permissionReview),
                        },
                    ],
                    { markerStyle: DIM, width },
                ),
            );
        }
        for (const [index, diff] of visibleDiffs.entries()) {
            if (index > 0) lines.push("");
            lines.push(...renderCodexFileDiff(diff, { maxRows: rowsPerFile, palette, width }));
        }
        const hiddenFiles =
            diffs.length -
            visibleDiffs.length +
            Math.max(0, Math.floor(entry.omittedFileDiffs ?? 0));
        const hiddenFilesLine =
            hiddenFiles === 0
                ? undefined
                : this.#fitLine(
                      `${DIM}… ${hiddenFiles} more file${hiddenFiles === 1 ? "" : "s"}${NOT_BOLD_OR_DIM}`,
                      width,
                  );
        if (hiddenFilesLine !== undefined) lines.push(hiddenFilesLine);
        if (lines.length <= MAX_DIFF_ROWS_PER_TOOL) return lines;
        const reservedTailRows = hiddenFilesLine === undefined ? 1 : 2;
        const visible = lines.slice(0, MAX_DIFF_ROWS_PER_TOOL - reservedTailRows);
        const hidden = lines.length - visible.length - (hiddenFilesLine === undefined ? 0 : 1);
        visible.push(
            this.#fitLine(
                `${DIM}… ${hidden} more row${hidden === 1 ? "" : "s"}${NOT_BOLD_OR_DIM}`,
                width,
            ),
        );
        if (hiddenFilesLine !== undefined) visible.push(hiddenFilesLine);
        return visible;
    }

    #renderNoticeEntry(
        title: string,
        text: string,
        width: number,
        color: string,
        childText = false,
    ): string[] {
        const safeTitle = this.#singleLine(title);
        const safeText = sanitizeTerminalText(text);
        if (childText) {
            return [
                this.#fitLine(`${color}•${RESET} ${BOLD}${safeTitle}${RESET}`, width),
                ...renderChildRows(
                    safeText.split("\n").map((line) => ({ text: line })),
                    { afterMarker: RESET, markerStyle: DIM, width },
                ),
            ];
        }
        const prefix = `${color}•${RESET} ${BOLD}${safeTitle}${NOT_BOLD_OR_DIM} `;
        const prefixWidth = visibleWidth(prefix);
        const wrapped = wrapTextWithAnsi(
            safeText.length === 0 ? " " : safeText,
            Math.max(1, width - prefixWidth),
        );
        const indent = " ".repeat(prefixWidth);
        return wrapped.map((line, index) =>
            this.#fitLine(`${index === 0 ? prefix : indent}${line}`, width),
        );
    }

    #emptyInputLine(): string {
        const placeholder =
            this.#freeformUserInput === undefined ? INPUT_PLACEHOLDER : "Type another answer";
        const marker = this.#focused ? CURSOR_MARKER : "";
        if (!this.#focused || !this.#cursorVisible) {
            return `${this.#inputPrompt()}${marker}${this.#theme.secondary}${placeholder}${this.#theme.primary}`;
        }

        const firstCharacter = placeholder[0] ?? " ";
        const rest = placeholder.slice(firstCharacter.length);
        return `${this.#inputPrompt()}${marker}${CURSOR_BG}${CURSOR_FG}${firstCharacter}${RESET}${this.#theme.secondary}${rest}${this.#theme.primary}`;
    }

    #surfaceLine(line: string, width: number): string {
        return `${this.#theme.inputBackground}${this.#theme.primary}${this.#fitAndPadLine(line, width)}${RESET}`;
    }

    #inputSurfaceLine(line: string, width: number): string {
        const softened = this.#softenFakeCursor(line);
        return `${this.#theme.inputBackground}${this.#theme.primary}${this.#fitAndPadLine(this.#restoreInputSurface(softened), width)}${RESET}`;
    }

    #restoreInputSurface(line: string): string {
        return line.replaceAll(
            RESET,
            `${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
        );
    }

    #softenFakeCursor(line: string): string {
        return line.replace(
            /\x1b\[7m([\s\S]*?)\x1b\[(?:27|0)m/gu,
            `${CURSOR_BG}${CURSOR_FG}$1${this.#theme.inputBackground}${this.#theme.primary}`,
        );
    }

    #activityText(): string | undefined {
        const label = this.#activityLabel();
        if (label === undefined) {
            return undefined;
        }

        const elapsed = this.#activityElapsedText();
        if (elapsed === undefined) {
            return label;
        }

        return `${label} (${elapsed})`;
    }

    #activityElapsedText(): string | undefined {
        const startedAt = this.#compactionStartedAtMs ?? this.#activityStartedAtMs;
        if (startedAt === undefined) {
            return undefined;
        }

        return formatActivityElapsedTime(this.#now() - startedAt);
    }

    #recordUserInput(createdAt: number): void {
        this.#lastUserInputAtMs = createdAt;
        if (this.#running) this.#activityStartedAtMs = createdAt;
    }

    #elapsedSinceLastUserInput(completedAt: number): number | undefined {
        if (this.#lastUserInputAtMs === undefined) return undefined;
        return Math.max(0, completedAt - this.#lastUserInputAtMs);
    }

    #appendTurnCompletion(elapsedMs: number): void {
        if (!this.#deferredTurnSeparator) return;
        this.#deferredTurnSeparator = false;
        const latest = this.#entries.at(-1);
        if (latest === undefined) {
            this.#activeTurnEntryStart = undefined;
            return;
        }
        latest.turnElapsedMs = elapsedMs;
        const turnStart = this.#activeTurnEntryStart ?? this.#entries.length - 1;
        const completedTurn = createCompletedTurn(this.#entries.slice(turnStart), elapsedMs);
        if (completedTurn !== undefined) {
            completedTurn.entry.completedTurn = completedTurn.turn;
            if (completedTurn.entry !== latest) {
                delete latest.turnElapsedMs;
                completedTurn.entry.turnElapsedMs = elapsedMs;
            }
        }
        // Snapshot session usage now so the history row never changes after later turns.
        (completedTurn?.entry ?? latest).turnUsage = structuredClone(this.#sessionUsage());
        this.#activeTurnEntryStart = undefined;
        this.#requestRender();
    }

    #markConcreteWorkCompleted(
        result: Pick<ToolResultBlock, "presentation" | "toolCallId" | "toolName">,
    ): void {
        const entry = this.#entries.find((candidate) => candidate.id === result.toolCallId);
        const normalized = result.toolName.toLowerCase();
        const concreteTool =
            (result.presentation !== undefined &&
                !(
                    result.presentation.type === "background_terminal_interaction" &&
                    result.presentation.input === ""
                )) ||
            entry?.mcpToolCall !== undefined ||
            normalized === "bash" ||
            normalized === "web_search" ||
            normalized === "websearch" ||
            normalized.startsWith("mcp__");
        if (!concreteTool) return;
        this.#deferredTurnSeparator = true;
    }

    #recordClosedBackgroundTerminals(nextProcesses: readonly BashSessionActivity[]): void {
        const nextSessionIds = new Set(nextProcesses.map((process) => process.sessionId));
        const closed = [...this.#yieldedBackgroundTerminals].filter(
            ([sessionId]) => !nextSessionIds.has(sessionId),
        );
        if (closed.length === 0 || this.#stoppingBackgroundTerminals) return;

        for (const [sessionId, command] of closed) {
            this.#yieldedBackgroundTerminals.delete(sessionId);
            if (this.#directShellCommandsBySessionId.has(sessionId)) continue;
            this.#appendEntry({
                backgroundTerminalCompletion: command,
                role: "event",
                text: command,
            });
        }
    }

    #trackYieldedBackgroundTerminal(
        presentation: NonNullable<AppTranscriptEntry["execCommand"]>,
    ): void {
        if (presentation.sessionId === undefined || this.#replayingInitialSessionEvents) return;
        this.#yieldedBackgroundTerminals.set(presentation.sessionId, presentation.command);
        this.#backgroundProcesses = this.#observedShellProcesses.filter((process) =>
            this.#yieldedBackgroundTerminals.has(process.sessionId),
        );
    }

    #recordSubagentCompletion(subagent: SubagentSummary): void {
        const outcome =
            subagent.status === "completed"
                ? "completed"
                : subagent.status === "suspended"
                  ? "was suspended"
                  : subagent.status === "aborted"
                    ? "was stopped"
                    : "failed";
        const displayText = `Background work "${subagent.description}" ${outcome}.`;
        const metricsDisplayText = `Background work "${subagent.description}" ${outcome} in ${this.#subagentMetrics(subagent)}.`;
        this.#renderedCompletionNotices.set(
            displayText,
            (this.#renderedCompletionNotices.get(displayText) ?? 0) + 1,
        );
        this.#recordCompletionNotice(metricsDisplayText, "Background work", "Background work ");
    }

    #recordWorkflowCompletion(workflow: WorkflowRun): void {
        const outcome =
            workflow.status === "completed"
                ? "completed"
                : workflow.status === "stopped"
                  ? "was stopped"
                  : "failed";
        const displayText = `Workflow ${humanizeWorkflowName(workflow.name)} ${outcome}.`;
        this.#recordCompletionNotice(displayText, "Workflow", "Workflow ");
    }

    #recordCompletionNotice(displayText: string, title: string, prefix: string): void {
        const count = this.#renderedCompletionNotices.get(displayText) ?? 0;
        this.#renderedCompletionNotices.set(displayText, count + 1);
        if (this.#renderedCompletionNotices.size > 100) {
            const oldest = this.#renderedCompletionNotices.keys().next().value;
            if (oldest !== undefined) this.#renderedCompletionNotices.delete(oldest);
        }
        this.#appendEntry({
            childText: title === "Background work",
            role: "event",
            title,
            text: displayText.startsWith(prefix) ? displayText.slice(prefix.length) : displayText,
        });
    }

    #consumeRenderedCompletionNotice(displayText: string): boolean {
        const count = this.#renderedCompletionNotices.get(displayText) ?? 0;
        if (count === 0) return false;
        if (count === 1) this.#renderedCompletionNotices.delete(displayText);
        else this.#renderedCompletionNotices.set(displayText, count - 1);
        return true;
    }

    #refreshToolActivityStatus(): void {
        if (this.#awaitingApprovalToolCallIds.size > 0) {
            this.#statusText = "Waiting for approval";
            return;
        }
        if (this.#reviewingPermissionToolCallIds.size > 0) {
            this.#statusText = "Reviewing permissions";
            return;
        }
        if (this.#runningToolCallIds.size === 0) {
            this.#statusText = "Working";
            return;
        }
        if (this.#runningToolCallIds.size === 1) {
            const toolCallId = this.#runningToolCallIds.values().next().value as string;
            const status = this.#toolStatusByCallId.get(toolCallId);
            if (status !== undefined && status.length > 0) {
                this.#statusText = status;
                return;
            }
        }
        this.#statusText = `Running ${this.#runningToolCallIds.size} tool${this.#runningToolCallIds.size === 1 ? "" : "s"}`;
    }

    #activityLabel(): string | undefined {
        if (this.#statusText === "Idle") {
            return undefined;
        }
        if (this.#statusText === "Running") {
            return "Working";
        }
        if (this.#statusText.startsWith("Stopped:")) {
            return undefined;
        }

        return this.#statusText;
    }

    #shouldRenderActivityAsLastMessage(): boolean {
        return this.#running || this.#compacting;
    }

    #renderActivityLine(label: string, width: number): string[] {
        const prefix = `${DIM}◦${RESET} `;
        const frame = this.#activityAnimationFrame;
        const elapsed = this.#activityElapsedText();
        const elapsedText = elapsed ?? "0s";
        const elapsedSuffix = ` ${DIM}${this.#theme.secondary}(${elapsedText} · esc to interrupt)${RESET}`;

        return [
            this.#fitLine(
                `${prefix}${renderActivityWave(label, frame, this.#theme)}${elapsedSuffix}`,
                width,
            ),
        ];
    }

    #hideCursor(line: string): string {
        return line.replace(/\x1b\[7m([\s\S]*?)\x1b\[(?:27|0)m/gu, "$1");
    }

    #fitAndPadLine(line: string, width: number): string {
        const fitted = truncateToWidth(line, width, "", false);
        const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
        return `${fitted}${padding}`;
    }

    #inputPrompt(): string {
        if (this.#isShellMode()) {
            return `${this.#theme.error}${BOLD}!${NOT_BOLD_OR_DIM}${this.#theme.primary} `;
        }
        return `${this.#theme.brand}${BOLD}›${NOT_BOLD_OR_DIM}${this.#theme.primary} `;
    }

    #handleReasoningShortcut(data: string): boolean {
        const direction = this.#reasoningShortcutDirection(data);
        if (direction === undefined) {
            return false;
        }

        const nextEffort = this.#nextReasoningEffort(direction);
        if (nextEffort !== undefined) {
            this.#agent.setEffort(nextEffort);
            if (!this.#modelLocked) {
                this.#persistDefaultModel(this.#agent.model.id, nextEffort);
            }
        }

        return true;
    }

    #persistDefaultModel(
        modelId: string,
        effort: string,
        providerId: string = this.#agent.provider.id,
        serviceTier: ServiceTier | null = this.#agent.confirmedServiceTier ?? null,
    ): void {
        if (this.#onDefaultModelChange === undefined) {
            return;
        }

        void Promise.resolve(
            this.#onDefaultModelChange({
                modelId,
                providerId,
                effort,
                serviceTier,
            }),
        ).catch(() => {
            if (this.#stopped || this.#exiting) {
                return;
            }
            this.#appendEntry({
                role: "event",
                title: "Configuration",
                text: "Could not update the config file.",
            });
            this.#requestRender();
        });
    }

    #persistSettings(onPersisted?: () => void): void {
        if (this.#onSettingsChange === undefined) {
            onPersisted?.();
            return;
        }

        void Promise.resolve(
            this.#onSettingsChange({
                inferenceMaxRetries: this.#inferenceMaxRetries,
                compactCompletedTurns: this.#compactCompletedTurns,
                completionChime: this.#completionChime,
                durableGlobalEventQueue: this.#durableGlobalEventQueue,
                showReasoning: this.#showReasoning,
                showUsage: this.#showUsage,
            }),
        )
            .then(() => onPersisted?.())
            .catch(() => {
                if (this.#stopped || this.#exiting) {
                    return;
                }
                this.#appendEntry({
                    role: "event",
                    title: "Configuration",
                    text: "Could not update the config file.",
                });
                this.#requestRender();
            });
    }

    #modelChoices(): readonly CodingAssistantModelChoice[] {
        return (
            this.#agent.modelChoices ??
            this.#agent.provider.models.map((model) => ({
                model,
                providerId: this.#agent.provider.id,
            }))
        );
    }

    #handleModelMenuShortcut(data: string): boolean {
        if (MODEL_MENU_RAW_KEYS.has(data) || matchesKey(data, "alt+m")) {
            this.#openModelMenu();
            return true;
        }

        return false;
    }

    #refreshSkillCommands(options: { force?: boolean } = {}): Promise<void> {
        if (
            options.force !== true &&
            (this.#skillCommandsLoaded || this.#skillCommandsRefresh !== undefined)
        ) {
            return this.#skillCommandsRefresh ?? Promise.resolve();
        }

        const refresh = loadAgentSkillCatalog(this.#agent.context)
            .then((skills) => {
                this.#skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
                this.#skillCommands = skills.map((skill) => ({
                    value: `skill:${skill.name}`,
                    label: `/skill:${skill.name}`,
                    description: skill.description,
                    aliases: [],
                }));
                this.#skillCommandsLoaded = true;
            })
            .catch(() => {
                this.#skillsByName = new Map();
                this.#skillCommands = [];
                this.#skillCommandsLoaded = true;
            });

        const trackedRefresh = refresh.finally(() => {
            if (this.#skillCommandsRefresh === trackedRefresh) {
                this.#skillCommandsRefresh = undefined;
            }
            this.#requestRender();
        });
        this.#skillCommandsRefresh = trackedRefresh;
        return trackedRefresh;
    }

    #handleSlashCommandAutocompleteInput(data: string): boolean {
        const suggestions = this.#slashCommandSuggestions();
        if (suggestions.length === 0) {
            return false;
        }

        if (matchesKey(data, "up")) {
            this.#slashCommandSelectionIndex =
                (this.#slashCommandSelectionIndex + suggestions.length - 1) % suggestions.length;
            return true;
        }

        if (matchesKey(data, "down")) {
            this.#slashCommandSelectionIndex =
                (this.#slashCommandSelectionIndex + 1) % suggestions.length;
            return true;
        }

        if (matchesKey(data, "escape")) {
            this.#dismissedSlashCommandText = this.#editor.getText();
            return true;
        }

        if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
            const selected = suggestions[this.#slashCommandSelectionIndex] ?? suggestions[0];
            if (selected === undefined) {
                return true;
            }

            this.#dismissedSlashCommandText = undefined;
            this.#submit(`/${selected.value}`);
            return true;
        }

        return false;
    }

    #slashCommandSuggestions(): readonly AutocompleteItem[] {
        const text = this.#editor.getText();
        if (
            text.length === 0 ||
            text === this.#dismissedSlashCommandText ||
            text.includes("\n") ||
            !text.startsWith("/") ||
            /\s/u.test(text)
        ) {
            return [];
        }

        const query = text.slice(1).toLowerCase();
        if (!this.#skillCommandsLoaded && this.#skillCommandsRefresh === undefined) {
            void this.#refreshSkillCommands();
        }

        const suggestions = [...this.#slashCommands, ...this.#skillCommands].filter((command) => {
            if (command.value === "fast" && !this.#supportsFastInference()) {
                return false;
            }
            return (
                command.value.toLowerCase().startsWith(query) ||
                command.aliases.some((alias) => alias.toLowerCase().startsWith(query))
            );
        });
        if (this.#slashCommandSelectionIndex >= suggestions.length) {
            this.#slashCommandSelectionIndex = 0;
        }

        return suggestions;
    }

    #completeFileMention(path: string, context: FileMentionContext): void {
        for (const _segment of FILE_MENTION_SEGMENTER.segment(context.prefix)) {
            this.#editor.handleInput("\x7f");
        }

        const suffix =
            context.afterCursor.length === 0 || !/^\s/u.test(context.afterCursor) ? " " : "";
        this.#editor.insertTextAtCursor(`${formatFileMention(path)}${suffix}`);
        this.#fileMentionAutocomplete?.dismiss(this.#editor.getLines(), this.#editor.getCursor());
        this.#syncAutocompleteState();
    }

    #fileMentionSnapshot() {
        return this.#fileMentionAutocomplete?.snapshot(
            this.#editor.getLines(),
            this.#editor.getCursor(),
        );
    }

    #syncAutocompleteState(): void {
        const text = this.#editor.getText();
        if (
            this.#dismissedSlashCommandText !== undefined &&
            text !== this.#dismissedSlashCommandText
        ) {
            this.#dismissedSlashCommandText = undefined;
        }
        this.#slashCommandSuggestions();
        if (this.#isShellMode()) this.#fileMentionAutocomplete?.clear();
        else this.#fileMentionAutocomplete?.sync(this.#editor.getLines(), this.#editor.getCursor());
    }

    #isShellMode(): boolean {
        return this.#freeformUserInput === undefined && this.#shellMode;
    }

    async #runShellCommand(rawCommand: string): Promise<void> {
        const command = rawCommand.trim();
        if (command.length === 0) {
            this.#appendEntry({
                role: "event",
                title: "Shell command",
                text: "Enter a shell command after !.",
            });
            return;
        }

        const commandId = this.#idFactory();
        this.#ensureShellCommandEntry(command, commandId);

        try {
            const response =
                this.#agent.runShellCommand === undefined
                    ? await this.#startLocalShellCommand(command, commandId)
                    : await this.#agent.runShellCommand(command, { commandId });
            if (response.status === "finished") {
                this.#finishShellCommand(response);
                return;
            }
            this.#directShellCommandsBySessionId.set(response.sessionId, { command, commandId });
            await this.#runForegroundShellCommand(response);
        } catch (error) {
            this.#finishShellCommand({
                command,
                commandId,
                errorMessage: errorToMessage(error),
                exitCode: null,
                output: errorToMessage(error),
                timedOut: false,
            });
        }
    }

    #ensureShellCommandEntry(command: string, commandId: string): AppTranscriptEntry {
        const existing = this.#entries.find((entry) => entry.id === commandId);
        if (existing !== undefined) return existing;
        this.#activeToolCallIds.add(commandId);
        return this.#appendEntry({
            detail: "Starting shell command",
            execCommand: { command, output: "", type: "exec_command" },
            id: commandId,
            role: "tool",
            text: command,
        });
    }

    async #startLocalShellCommand(
        command: string,
        commandId: string,
    ): Promise<RunShellCommandResponse> {
        const sessionId = await this.#agent.context.bash.startSession({
            command,
            maxOutputBytes: 512_000,
        });
        return {
            command,
            commandId,
            eventId: `local-shell:${commandId}`,
            sessionId,
            status: "running",
        };
    }

    async #runForegroundShellCommand(
        response: Extract<RunShellCommandResponse, { status: "running" }>,
    ): Promise<void> {
        const foreground: ForegroundShellCommand = {
            backgroundRequested: false,
            commandId: response.commandId,
            sessionId: response.sessionId,
        };
        this.#foregroundShellCommand = foreground;
        const entry = this.#entries.find((candidate) => candidate.id === response.commandId);
        if (entry !== undefined) entry.detail = "Ctrl+B to background · Ctrl+C to stop";
        this.#requestRender();
        const deadline = Date.now() + FOREGROUND_SHELL_YIELD_MS;
        try {
            for (;;) {
                let snapshot: BashSessionSnapshot | undefined;
                try {
                    snapshot = await this.#readBackgroundProcess(response.sessionId, 250);
                } catch {
                    if (!this.#activeToolCallIds.has(response.commandId)) return;
                    const entry = this.#entries.find(
                        (candidate) => candidate.id === response.commandId,
                    );
                    this.#backgroundShellCommand(
                        response.commandId,
                        response.sessionId,
                        entry?.execCommand?.output ?? "",
                    );
                    return;
                }
                if (snapshot === undefined) {
                    if (!this.#activeToolCallIds.has(response.commandId)) return;
                    const entry = this.#entries.find(
                        (candidate) => candidate.id === response.commandId,
                    );
                    this.#backgroundShellCommand(
                        response.commandId,
                        response.sessionId,
                        entry?.execCommand?.output ?? "",
                    );
                    return;
                }
                this.#updateForegroundShellCommand(response.commandId, snapshot);
                if (snapshot.status !== "running") {
                    this.#finishShellCommand(this.#shellResult(response.commandId, snapshot));
                    return;
                }
                if (foreground.backgroundRequested || Date.now() >= deadline) {
                    if (!this.#activeToolCallIds.has(response.commandId)) return;
                    this.#backgroundShellCommand(
                        response.commandId,
                        response.sessionId,
                        this.#shellOutput(snapshot),
                    );
                    return;
                }
            }
        } finally {
            if (this.#foregroundShellCommand === foreground) {
                this.#foregroundShellCommand = undefined;
            }
        }
    }

    async #readBackgroundProcess(
        sessionId: number,
        waitMs: number,
    ): Promise<BashSessionSnapshot | undefined> {
        // Watching a command must not consume output the agent has not read.
        return this.#agent.readBackgroundProcess === undefined
            ? this.#agent.context.bash.readSession(sessionId, { peek: true, waitMs })
            : this.#agent.readBackgroundProcess(sessionId, { waitMs });
    }

    async #stopBackgroundProcess(sessionId: number): Promise<BashSessionSnapshot | undefined> {
        if (this.#agent.stopBackgroundProcess === undefined) {
            return this.#agent.context.bash.killSession(sessionId);
        }
        return (await this.#agent.stopBackgroundProcess(sessionId)).process;
    }

    #updateForegroundShellCommand(commandId: string, snapshot: BashSessionSnapshot): void {
        const entry = this.#entries.find((candidate) => candidate.id === commandId);
        if (entry === undefined || !this.#activeToolCallIds.has(commandId)) return;
        entry.execCommand = {
            command: snapshot.command,
            output: this.#shellOutput(snapshot),
            sessionId: snapshot.sessionId,
            type: "exec_command",
        };
        entry.detail = "Ctrl+B to background · Ctrl+C to stop";
        this.#requestRender();
    }

    #backgroundShellCommand(commandId: string, sessionId: number, output: string): void {
        const entry = this.#entries.find((candidate) => candidate.id === commandId);
        if (entry !== undefined) {
            entry.execCommand = {
                command: entry.execCommand?.command ?? entry.text,
                output,
                sessionId,
                type: "exec_command",
            };
            entry.detail = "Continues in background · /ps to view";
        }
        this.#activeToolCallIds.delete(commandId);
        this.#backgroundedShellCommandIds.add(commandId);
        const direct = this.#directShellCommandsBySessionId.get(sessionId);
        if (!this.#observedShellProcesses.some((process) => process.sessionId === sessionId)) {
            this.#observedShellProcesses = [
                ...this.#observedShellProcesses,
                {
                    command: direct?.command ?? entry?.execCommand?.command ?? "Shell command",
                    cwd: this.#cwd,
                    sessionId,
                    status: "running",
                },
            ];
        }
        this.#yieldedBackgroundTerminals.set(
            sessionId,
            direct?.command ?? entry?.execCommand?.command ?? "Shell command",
        );
        this.#backgroundProcesses = this.#observedShellProcesses.filter((process) =>
            this.#yieldedBackgroundTerminals.has(process.sessionId),
        );
        this.#requestRender();
    }

    #shellResult(commandId: string, snapshot: BashSessionSnapshot): RunShellCommandResult {
        return {
            command: snapshot.command,
            commandId,
            exitCode: snapshot.exitCode,
            output: this.#shellOutput(snapshot),
            sessionId: snapshot.sessionId,
            timedOut: snapshot.timedOut,
        };
    }

    #shellOutput(snapshot: Pick<BashSessionSnapshot, "stderr" | "stdout">): string {
        return [snapshot.stdout, snapshot.stderr].filter(Boolean).join("\n");
    }

    #finishShellCommand(result: RunShellCommandResult): void {
        if (
            !this.#activeToolCallIds.has(result.commandId) &&
            !this.#backgroundedShellCommandIds.has(result.commandId)
        ) {
            if (result.sessionId !== undefined) {
                this.#directShellCommandsBySessionId.delete(result.sessionId);
                this.#yieldedBackgroundTerminals.delete(result.sessionId);
            }
            return;
        }
        this.#moveActiveToolEntryToTranscriptTail(result.commandId);
        const failed =
            result.errorMessage !== undefined ||
            result.timedOut ||
            (result.exitCode !== null && result.exitCode !== 0);
        const existing = this.#entries.find((entry) => entry.id === result.commandId);
        const output =
            result.output.length > 0
                ? result.output
                : result.timedOut
                  ? "Command timed out."
                  : result.exitCode === null
                    ? (result.errorMessage ?? "Command did not finish.")
                    : "";
        if (existing === undefined) {
            this.#appendEntry({
                execCommand: { command: result.command, output, type: "exec_command" },
                id: result.commandId,
                role: failed ? "error" : "tool",
                text: result.command,
            });
        } else {
            existing.execCommand = {
                command: result.command,
                output,
                type: "exec_command",
            };
            existing.role = failed ? "error" : "tool";
            delete existing.detail;
        }
        this.#activeToolCallIds.delete(result.commandId);
        this.#backgroundedShellCommandIds.delete(result.commandId);
        if (result.sessionId !== undefined) {
            this.#directShellCommandsBySessionId.delete(result.sessionId);
            this.#yieldedBackgroundTerminals.delete(result.sessionId);
        }
        this.#requestRender();
    }

    #reasoningShortcutDirection(data: string): "down" | "up" | undefined {
        if (
            REASONING_DOWN_RAW_KEYS.has(data) ||
            matchesKey(data, "alt+,") ||
            matchesKey(data, "shift+down")
        ) {
            return "down";
        }
        if (
            REASONING_UP_RAW_KEYS.has(data) ||
            matchesKey(data, "alt+.") ||
            matchesKey(data, "shift+up")
        ) {
            return "up";
        }

        return undefined;
    }

    #nextReasoningEffort(direction: "down" | "up"): string | undefined {
        const choices = [...this.#agent.model.thinkingLevels];
        if (choices.length === 0) {
            return undefined;
        }

        const firstChoice = choices[0];
        if (firstChoice === undefined) {
            return undefined;
        }

        const snapshotEffort = this.#agent.snapshot().effort;
        const fallbackEffort = this.#agent.model.defaultThinkingLevel;
        const currentEffort =
            snapshotEffort !== undefined && choices.includes(snapshotEffort)
                ? snapshotEffort
                : choices.includes(fallbackEffort)
                  ? fallbackEffort
                  : firstChoice;
        const currentIndex = choices.indexOf(currentEffort);
        const nextIndex = direction === "up" ? currentIndex + 1 : currentIndex - 1;

        return choices[nextIndex];
    }

    #modelDisplayName(): string {
        return (this.#agent.model.id.split("/").at(-1) ?? this.#agent.model.id).toLowerCase();
    }

    #modelWithReasoningDisplayName(): string {
        const snapshot = this.#agent.snapshot();
        const effort = snapshot.effort ?? this.#agent.model.defaultThinkingLevel;
        const label =
            effort === undefined
                ? this.#modelDisplayName()
                : `${this.#modelDisplayName()} ${effort.toLowerCase()}`;
        return snapshot.serviceTier === "fast" ? `${label} fast` : label;
    }

    #supportsFastInference(): boolean {
        return this.#agent.provider.serviceTiers?.includes("fast") === true;
    }

    #cwdDisplayName(): string {
        const gymWorkspace = process.env.RIG_GYM_DISPLAY_WORKSPACE?.trim();
        if (gymWorkspace !== undefined && gymWorkspace.length > 0) return gymWorkspace;
        const home = homedir();
        if (this.#cwd === home) {
            return "~";
        }
        if (this.#cwd.startsWith(`${home}/`)) {
            return `~/${this.#cwd.slice(home.length + 1)}`;
        }

        return this.#cwd;
    }

    #toolVerb(toolName: string, active: boolean): string {
        const normalized = toolName.toLowerCase();
        if (normalized.includes("bash") || normalized.includes("exec")) {
            return active ? "Running" : "Ran";
        }
        if (
            normalized.includes("grep") ||
            normalized.includes("find") ||
            normalized.includes("glob") ||
            normalized === "ls"
        ) {
            return active ? "Exploring" : "Explored";
        }
        if (normalized.includes("read") || normalized.includes("view")) {
            return active ? "Reading" : "Read";
        }
        if (
            normalized.includes("write") ||
            normalized.includes("edit") ||
            normalized.includes("patch")
        ) {
            return active ? "Editing" : "Edited";
        }

        return active ? "Using" : "Used";
    }

    #isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    #singleLine(text: string): string {
        return sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();
    }

    #markTypingActivity(): void {
        this.#cursorVisible = true;
    }

    #stripEditorChrome(lines: string[]): string[] {
        let content = [...lines];

        while (content.length > 0 && this.#isEditorBorderLine(content[0] ?? "")) {
            content = content.slice(1);
        }
        while (content.length > 0 && this.#isEditorBorderLine(content[content.length - 1] ?? "")) {
            content = content.slice(0, -1);
        }

        return content.filter((line) => !this.#isEditorBorderLine(line));
    }

    #isEditorScrollIndicator(line: string): boolean {
        const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
        return stripped.includes(" more ") && (stripped.includes("↑") || stripped.includes("↓"));
    }

    #isEditorBorderLine(line: string): boolean {
        const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
        return stripped.length > 0 && [...stripped].every((character) => character === "─");
    }

    #stripSpuriousLeadingEmptyLine(lines: string[]): string[] {
        if (lines.length <= 1) {
            return lines;
        }

        const first = lines[0] ?? "";
        if (this.#isVisibleEditorLine(first)) {
            return lines;
        }

        return lines.slice(1);
    }

    #isVisibleEditorLine(line: string): boolean {
        const stripped = line
            .replace(/\x1b\[[0-9;]*m/g, "")
            .replaceAll(CURSOR_MARKER, "")
            .trim();
        return stripped.length > 0 || line.includes("\x1b[7m") || line.includes(CURSOR_MARKER);
    }

    #startCursorBlink(): void {
        if (!this.#stopped) this.#cursorVisible = true;
    }

    #stopCursorBlink(): void {
        this.#cursorVisible = true;
    }

    #startActivityAnimation(): void {
        if (this.#activityAnimationTimer !== undefined || this.#stopped) {
            return;
        }

        this.#activityAnimationFrame = 0;
        this.#activityAnimationTimer = setInterval(() => {
            if (this.#stopped || this.#exiting) {
                return;
            }

            this.#activityAnimationFrame =
                (this.#activityAnimationFrame + 1) % ACTIVITY_WAVE_FRAME_COUNT;
            if (this.#activityText() !== undefined) {
                this.#requestRender();
            }
        }, ACTIVITY_ANIMATION_MS);
        this.#activityAnimationTimer.unref?.();
    }

    #stopActivityAnimation(): void {
        if (this.#activityAnimationTimer === undefined) {
            this.#activityAnimationFrame = 0;
            this.#activityStartedAtMs = undefined;
            return;
        }

        clearInterval(this.#activityAnimationTimer);
        this.#activityAnimationTimer = undefined;
        this.#activityAnimationFrame = 0;
        this.#activityStartedAtMs = undefined;
    }

    #syncSubagentRefreshTimer(): void {
        if (this.#activeSubagentCount() === 0) {
            this.#stopSubagentRefreshTimer();
            return;
        }
        if (this.#subagentRefreshTimer !== undefined || this.#stopped) return;
        this.#subagentRefreshTimer = setInterval(() => this.#requestRender(), 1_000);
        this.#subagentRefreshTimer.unref?.();
    }

    #stopSubagentRefreshTimer(): void {
        if (this.#subagentRefreshTimer === undefined) return;
        clearInterval(this.#subagentRefreshTimer);
        this.#subagentRefreshTimer = undefined;
    }

    #providerErrorEntryText(entry: AppTranscriptEntry): string {
        if (entry.providerError === undefined && entry.providerErrorFallback === undefined) {
            return entry.text;
        }
        return formatProviderError(entry.providerError, {
            ...(entry.providerErrorFallback === undefined
                ? {}
                : { fallbackMessage: entry.providerErrorFallback }),
            now: this.#now(),
            providerId: entry.providerErrorProviderId ?? this.#agent.provider.id,
        });
    }

    #hasLiveProviderErrorReset(): boolean {
        const now = this.#now();
        return this.#entries.some((entry) => {
            const resetAt = providerErrorResetAt(entry.providerError);
            return resetAt !== undefined && resetAt > now;
        });
    }

    #syncProviderErrorResetTimer(): void {
        if (this.#stopped || this.#exiting || !this.#hasLiveProviderErrorReset()) {
            this.#stopProviderErrorResetTimer();
            return;
        }
        if (this.#providerErrorResetTimer !== undefined) return;
        // Paint first, then stop once the countdown has expired so "1s" becomes "now"
        // instead of freezing on the last positive remaining duration.
        this.#providerErrorResetTimer = setInterval(() => {
            if (this.#stopped || this.#exiting) {
                this.#stopProviderErrorResetTimer();
                return;
            }
            this.#requestRender();
            if (!this.#hasLiveProviderErrorReset()) {
                this.#stopProviderErrorResetTimer();
            }
        }, 1_000);
        this.#providerErrorResetTimer.unref?.();
    }

    #stopProviderErrorResetTimer(): void {
        if (this.#providerErrorResetTimer === undefined) return;
        clearInterval(this.#providerErrorResetTimer);
        this.#providerErrorResetTimer = undefined;
    }

    #requestRender(force = false): void {
        if (!this.#stopped) {
            this.#tui.requestRender(force);
        }
    }

    #waitForShutdownRender(): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, 25);
        });
    }

    #handleCtrlC(): void {
        if (this.#editor.getText().length > 0 || this.#shellMode) {
            this.#editor.setText("");
            this.#shellMode = false;
            this.#fileMentionAutocomplete?.clear();
            this.#dismissedSlashCommandText = undefined;
            this.#requestRender();
            return;
        }
        if (this.#abortActiveRun()) return;
        void this.stop();
    }

    #queueCurrentInput(): boolean {
        const submission = this.#createPromptSubmission(this.#editor.getText(), this.#shellMode);
        if (submission === undefined) return false;
        this.#editor.setText("");
        this.#shellMode = false;
        this.#editor.addToHistory(submission.displayText);
        this.#fileMentionAutocomplete?.clear();
        if (submission.shellCommand === undefined) this.#modelLocked = true;
        this.#pendingPrompts.push(submission);
        this.#requestRender();
        return true;
    }

    #setTerminalFocused(focused: boolean): void {
        if (this.#terminalFocused === focused) return;
        this.#terminalFocused = focused;
        this.#onTerminalFocusChange?.(focused);
        this.#editor.focused = this.#focused && focused;
        if (focused && this.#focused) {
            this.#cursorVisible = true;
            this.#startCursorBlink();
        } else {
            this.#stopCursorBlink();
            this.#cursorVisible = false;
        }
        this.#requestRender();
    }

    #setRunning(running: boolean): void {
        const wasRunning = this.#running;
        this.#running = running;
        if (!running || !wasRunning) {
            this.#activeCompactionId = undefined;
            this.#compactionStartedAtMs = undefined;
        }
    }
}
