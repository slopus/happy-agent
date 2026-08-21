import type {
    AgentCompactionResult,
    AgentLoopEvent,
    AgentSnapshot,
    ContentBlock,
    GoalStatus,
    Message,
    Model,
    PermissionMode,
    ProviderError,
    SecretAttachmentScope,
    ServiceTier,
    SessionGoal,
    StopReason,
    UserMessage,
} from "../protocol/index.js";
import type { Context } from "@steve.kite/stdlib";
import type {
    AbortRunOptions,
    AbortRunResponse,
    GetSessionUsageResponse,
    ReadBackgroundProcessResponse,
    RunShellCommandResponse,
    SteerMessageResponse,
    SubmitContextMessageResponse,
    StopBackgroundProcessResponse,
} from "../protocol/index.js";

export interface CodingAssistantClientProvider {
    id: string;
    models: readonly Model[];
    serviceTiers?: readonly ServiceTier[];
}

export interface AgentRunOptions {
    clientSubmissionId?: string;
    displayText?: string;
    onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
    onMessage?: (message: Message) => void | Promise<void>;
    signal?: AbortSignal;
}

export interface AgentRunResult {
    contextMessages: readonly Message[];
    debugDirectory?: string;
    errorMessage?: string;
    messages: readonly Message[];
    providerError?: ProviderError;
    providerId?: string;
    requestedModelId?: string;
    runId: string;
    stopReason: StopReason;
}

export interface CodingAssistantModelChoice {
    model: Model;
    providerId: string;
}

export interface SteeringRunOptions extends AgentRunOptions {
    clientSubmissionId?: string;
    expectedRunId?: string;
}

export interface CodingAssistantAgentBackend {
    readonly canChangeModel: boolean;
    readonly confirmedServiceTier: ServiceTier | undefined;
    readonly id: string;
    readonly provider: CodingAssistantClientProvider;
    readonly model: Model;
    readonly modelChoices?: readonly CodingAssistantModelChoice[];
    readonly permissionMode: PermissionMode;
    /** Unsent composer text shared with the other clients on this session. */
    readonly draft?: string;
    /** When that draft was typed, which decides who wins between clients. */
    readonly draftUpdatedAt?: number | undefined;
    readonly goal?: SessionGoal | undefined;
    readonly projectSecretIds?: readonly string[];
    readonly secretIds?: readonly string[];
    readonly sessionSecretIds?: readonly string[];
    getUsage?(): Promise<GetSessionUsageResponse>;
    readBackgroundProcess(
        sessionId: number,
        options?: { waitMs?: number },
    ): Promise<ReadBackgroundProcessResponse | undefined>;
    abort?(options?: AbortRunOptions): Promise<AbortRunResponse>;
    attachSecret?(secretId: string, scope?: SecretAttachmentScope): Promise<void>;
    compact(
        ctx: Context,
        signal?: AbortSignal,
        onEvent?: AgentRunOptions["onEvent"],
    ): Promise<AgentCompactionResult>;
    changeGoalStatus?(status: GoalStatus): Promise<void>;
    clearGoal?(): Promise<void>;
    detachSecret?(secretId: string, scope?: SecretAttachmentScope): Promise<void>;
    reset(): Promise<void>;
    runShellCommand(
        command: string,
        options: { commandId: string },
    ): Promise<RunShellCommandResponse>;
    rewind?(messageId: string): Promise<UserMessage>;
    stopBackgroundProcesses(): Promise<number>;
    stopBackgroundProcess(sessionId: number): Promise<StopBackgroundProcessResponse>;
    send(
        ctx: Context,
        content: string | readonly ContentBlock[],
        options?: AgentRunOptions,
    ): Promise<AgentRunResult>;
    sendContext?(text: string): Promise<SubmitContextMessageResponse>;
    steer(
        content: string | readonly ContentBlock[],
        options?: SteeringRunOptions,
    ): Promise<void | SteerMessageResponse>;
    setEffort(effort: string | undefined): void;
    setModel(
        modelId: string,
        effort: string | undefined,
        providerId?: string,
    ): void | Promise<void>;
    setServiceTier(serviceTier: ServiceTier | undefined): void | Promise<void>;
    setPermissionMode(mode: PermissionMode): void | Promise<void>;
    setDraft?(draft: string, options?: { origin?: string; updatedAt?: number }): Promise<void>;
    setGoal?(objective: string): Promise<void>;
    snapshot(): AgentSnapshot;
}
