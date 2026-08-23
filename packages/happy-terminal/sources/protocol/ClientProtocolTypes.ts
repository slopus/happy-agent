import { Type, type Static } from "@sinclair/typebox";
import type { ToolPermissionReview } from "@slopus/happy-agent-client";
import type { SessionProviderError } from "@slopus/happy-providers";

import type { Attachment } from "./Attachment.js";
import type { ServiceNotice } from "./ServiceNotice.js";

export type PermissionMode = "auto" | "workspace_write" | "read_only" | "full_access";
export type ServiceTier = "fast";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type ProviderError = SessionProviderError;

export interface Model<TThinkingLevel extends string = string> {
    autoCompactWindow?: number;
    contextWindow?: number;
    defaultThinkingLevel: TThinkingLevel;
    id: string;
    name: string;
    thinkingLevels: readonly TThinkingLevel[];
}

export interface Usage {
    cacheRead: number;
    cacheWrite: number;
    cost: {
        cacheRead: number;
        cacheWrite: number;
        input: number;
        output: number;
        total: number;
    };
    input: number;
    output: number;
    reasoning?: number;
    totalTokens: number;
}

export interface TextBlock {
    text: string;
    type: "text";
}

export interface ImageBlock {
    data: string;
    detail?: "high" | "original";
    mediaType: string;
    type: "image";
}

export type ContentBlock = TextBlock | ImageBlock;

export interface ThinkingBlock {
    encrypted?: string;
    redacted?: boolean;
    thinking: string;
    type: "thinking";
}

export type ExplorationOperation =
    | { kind: "list"; target: string }
    | { kind: "read"; name: string }
    | { command: string; kind: "search"; path?: string; query?: string };

export interface ExplorationToolCallPresentation {
    operations: readonly ExplorationOperation[];
    type: "exploration";
}

export interface ExecCommandToolCallPresentation {
    command: string;
    type: "exec_command";
}

export interface SearchSource {
    title?: string;
    url: string;
}

export interface SearchToolCallPresentation {
    query: string;
    target: "web" | "x";
    type: "search";
}

export type ToolCallPresentation =
    | ExecCommandToolCallPresentation
    | ExplorationToolCallPresentation
    | SearchToolCallPresentation;

export type FileDiffKind = "add" | "delete" | "update";
export type FileDiffLineKind = "add" | "context" | "delete";

export interface FileDiffLine {
    kind: FileDiffLineKind;
    text: string;
}

export interface FileDiffHunk {
    lines: readonly FileDiffLine[];
    newStart: number;
    oldStart: number;
}

export interface FileDiff {
    added?: number;
    deleted?: number;
    hunks: readonly FileDiffHunk[];
    kind: FileDiffKind;
    language?: string;
    omittedLines?: number;
    path: string;
}

export interface BackgroundTerminalInteractionPresentation {
    command: string;
    input: string;
    sessionId: number;
    type: "background_terminal_interaction";
}

export interface ExecCommandPresentation {
    command: string;
    output: string;
    sessionId?: number;
    type: "exec_command";
}

export interface FileDiffToolResultPresentation {
    files: readonly FileDiff[];
    omittedFiles?: number;
    type: "file_diff";
}

export interface SearchToolResultPresentation {
    query: string;
    sources: readonly SearchSource[];
    target: "web" | "x";
    type: "search";
}

export type ToolResultPresentation =
    | BackgroundTerminalInteractionPresentation
    | ExecCommandPresentation
    | ExplorationToolCallPresentation
    | FileDiffToolResultPresentation
    | SearchToolResultPresentation;

/** The complete automatic-review annotation for one tool call. */
export interface ToolPermission {
    elevated: boolean;
    review: ToolPermissionReview;
}

export interface ToolCallBlock {
    arguments: unknown;
    id: string;
    incomplete?: boolean;
    kind?: "custom" | "function";
    name: string;
    namespace?: string;
    presentation?: ToolCallPresentation;
    /** Present exactly when this invocation crossed the automatic-review boundary. */
    toolPermission?: ToolPermission;
    type: "tool_call";
}

export type { ToolPermissionReview };

export interface ToolResultFailure {
    kind: "execution_failed" | "interrupted" | "invalid_arguments" | "tool_unavailable";
    message?: string;
}

export interface ToolResultBlock {
    display: string;
    failure?: ToolResultFailure;
    isError?: boolean;
    presentation?: ToolResultPresentation;
    rendered: readonly ContentBlock[];
    toolCallId: string;
    toolName: string;
    trustedUserEvidence?: readonly ContentBlock[];
    type: "tool_result";
}

export type AgentBlock = ContentBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export interface SystemMessage {
    blocks: readonly ContentBlock[];
    context?: "excluded";
    id: string;
    role: "system";
    structured?: ServiceNotice;
}

export interface UserMessage {
    agentMessageTriggerTurn?: boolean;
    agentSource?: {
        agentId: string;
        sessionId: string;
        title?: string;
    };
    blocks: readonly ContentBlock[];
    contextOnly?: true;
    encryptedAgentMessage?: {
        author: string;
        encryptedContent: string;
        header: string;
        recipient: string;
    };
    id: string;
    identity?: string | null;
    internal?: true;
    provenance?: "agent";
    role: "user";
    shellCommandId?: string;
}

export interface AgentMessage {
    attachments?: readonly Attachment[];
    blocks: readonly AgentBlock[];
    contextTokens?: number;
    id: string;
    internal?: true;
    providerId?: string;
    requestedModelId?: string;
    responseModel?: string;
    role: "agent";
    sessionMessage?: unknown;
    usage?: Usage;
}

export interface CompactionMessage {
    blocks: readonly ContentBlock[];
    id: string;
    providerId: string;
    requestedModelId?: string;
    responseModel?: string;
    role: "compaction";
    statistics: {
        after: { exact: boolean; tokens: number };
        before: { exact: true; tokens: number };
    };
    usage?: Usage;
}

export interface ErrorMessage {
    attempt?: number;
    blocks: readonly ContentBlock[];
    context?: "excluded";
    id: string;
    outcome: "retried" | "continued" | "failed";
    providerError?: ProviderError;
    providerId?: string;
    requestedModelId?: string;
    role: "error";
}

export type Message = SystemMessage | UserMessage | AgentMessage | CompactionMessage | ErrorMessage;

export interface AgentSnapshot {
    appendSystemPrompt?: string;
    contextMessages?: readonly Message[];
    effort?: string;
    id: string;
    instructions?: string;
    lastRunId?: string;
    messages: readonly Message[];
    modelId: string;
    providerId: string;
    queue: readonly { id: string; message: Message }[];
    serviceTier?: ServiceTier;
    status: "idle" | "running" | "aborted";
    systemPrompt?: string;
    tools: readonly string[];
}

export interface AgentCompactionResult {
    compacted: boolean;
    compactedMessageCount: number;
    estimatedTokensAfter: number;
    estimatedTokensBefore: number;
    retainedMessageCount: number;
}

/**
 * Provider and module events are an open wire union. Happy Terminal displays the fields it understands and
 * preserves unknown additions from newer Happy Agent versions.
 */
export interface AgentLoopEvent {
    type: string;
    // Event families are open across Happy Agent module versions.
    [key: string]: any;
}

export type AutoPermissionRisk = "low" | "medium" | "high" | "critical";
export type AutoPermissionUserAuthorization = "unknown" | "low" | "medium" | "high";

export type GoalStatus = "active" | "blocked" | "complete" | "paused";

export interface SessionGoal {
    createdAt: number;
    objective: string;
    status: GoalStatus;
    updatedAt: number;
}

export interface CreateGoalRequest {
    objective: string;
}

export interface ChangeGoalStatusRequest {
    status: GoalStatus;
}

export interface UserInputOption {
    description: string;
    label: string;
}

export interface UserInputQuestion {
    header: string;
    id: string;
    multiSelect: boolean;
    options: readonly UserInputOption[];
    question: string;
    required?: boolean;
}

export interface UserInputRequest {
    autoResolutionMs?: number;
    questions: readonly UserInputQuestion[];
    requestId: string;
}

export interface UserInputResponse {
    answers: Readonly<Record<string, readonly string[]>>;
}

export interface McpServerSummary {
    errorMessage?: string;
    name: string;
    promptSupport?: boolean;
    resourceSupport?: boolean;
    status: "blocked" | "connected" | "disabled" | "failed";
    toolCount: number;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface SessionTask {
    activeForm?: string;
    blockedBy: readonly string[];
    blocks: readonly string[];
    description: string;
    id: string;
    metadata?: Readonly<Record<string, unknown>>;
    owner?: string;
    status: TaskStatus;
    subject: string;
}

export type WorkflowRunStatus = "completed" | "error" | "running" | "stopped";

export interface WorkflowRun {
    agentCount: number;
    code: string;
    description: string;
    error?: string;
    finishedAt?: number;
    logs: readonly string[];
    name: string;
    output?: unknown;
    phase?: string;
    runId: string;
    startedAt: number;
    status: WorkflowRunStatus;
    taskId: string;
}

export interface WorkflowRunUpdate {
    agentCount?: number;
    code?: string;
    description?: string;
    error?: string;
    finishedAt?: number;
    log?: string;
    name?: string;
    output?: unknown;
    phase?: string;
    runId: string;
    startedAt?: number;
    status?: WorkflowRunStatus;
    taskId?: string;
}

export interface DurableSkillDefinition {
    description: string;
    location: "durable";
    name: string;
}

export interface ScheduledMessage {
    createdAt: number;
    deliveredAt?: number;
    dueAt: number;
    failure?: string;
    id: string;
    message: string;
    senderSessionId: string;
    status: "pending" | "delivered" | "undelivered" | "cancelled";
    targetAgentId: string;
    updatedAt: number;
}

export interface DockerMountConfig {
    readOnly?: boolean;
    source: string;
    target: string;
}

export interface DockerExecutionConfig {
    container?: string;
    environment?: Readonly<Record<string, string>>;
    image?: string;
    mounts?: readonly DockerMountConfig[];
    name?: string;
    socketPath?: string;
    workingDirectory: string;
}

export type SessionExecutionEnvironment =
    | { type: "local" }
    | {
          kind: "container" | "image";
          reference: string;
          type: "docker";
          workingDirectory: string;
      };

export interface BashSessionActivity {
    command: string;
    cwd: string;
    sessionId: number;
    status: "running";
}

export type BashSessionStatus = "completed" | "killed" | "running";

export interface BashSessionSnapshot {
    command: string;
    cwd: string;
    exitCode: number | null;
    sessionId: number;
    status: BashSessionStatus;
    stderr: string;
    stderrBytes?: number;
    stderrDelta: string;
    stderrDeltaBytes?: number;
    stderrDeltaOmittedBytes?: number;
    stderrOmittedBytes?: number;
    stdout: string;
    stdoutBytes?: number;
    stdoutDelta: string;
    stdoutDeltaBytes?: number;
    stdoutDeltaOmittedBytes?: number;
    stdoutOmittedBytes?: number;
    timedOut: boolean;
}

export const secretIdSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});

export const environmentVariableNameSchema = Type.String({
    pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});

const environmentVariableValueSchema = Type.String({ pattern: "^[^\\u0000]*$" });

export const environmentSecretRegistrationSchema = Type.Object(
    {
        description: Type.String({ minLength: 1 }),
        environment: Type.Record(environmentVariableNameSchema, environmentVariableValueSchema, {
            additionalProperties: false,
            minProperties: 1,
        }),
        id: secretIdSchema,
    },
    { additionalProperties: false },
);

export const environmentSecretUpdateSchema = Type.Object(
    {
        description: Type.Optional(Type.String({ minLength: 1 })),
        environment: Type.Optional(
            Type.Record(
                environmentVariableNameSchema,
                Type.Union([environmentVariableValueSchema, Type.Null()]),
                { additionalProperties: false, minProperties: 1 },
            ),
        ),
    },
    { additionalProperties: false, minProperties: 1 },
);

export type EnvironmentSecretRegistration = Static<typeof environmentSecretRegistrationSchema>;
export type EnvironmentSecretUpdate = Static<typeof environmentSecretUpdateSchema>;
export type SecretAttachmentScope = "project" | "session";

export interface SecretReference {
    availableToModel?: boolean;
    description: string;
    environmentVariables: readonly string[];
    id: string;
    kind?: "github";
}

export interface ExternalToolDefinition {
    description: string;
    label?: string;
    name: string;
    parameters: Readonly<Record<string, unknown>>;
}

export interface ExternalToolCall {
    arguments: unknown;
    batchId: string;
    consumed: boolean;
    createdAt: number;
    definition: ExternalToolDefinition;
    id: string;
    resolution?: ExternalToolCallResolution;
    resolvedAt?: number;
    runId: string;
    sessionId: string;
    skill?: DurableSkillDefinition;
    status: "pending" | "completed" | "failed" | "cancelled";
    toolCallId: string;
    toolCallIndex: number;
}

export type ExternalToolCallResolution =
    | { content?: readonly ContentBlock[]; output?: unknown; status: "completed" }
    | { error: { code?: string; data?: unknown; message: string }; status: "failed" };

export interface ResolveExternalToolCallResponse {
    accepted: boolean;
    call: ExternalToolCall;
}
