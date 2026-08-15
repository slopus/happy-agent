import type {
    AgentContext,
    AgentCompactionResult,
    AgentRunOptions,
    AgentRunResult,
    AgentSnapshot,
    ContentBlock,
    UserMessage,
} from "../agent/index.js";
import type { Context } from "@steve.kite/stdlib";
import type { PermissionMode } from "../permissions/index.js";
import type { GoalStatus, SessionGoal } from "../goals/index.js";
import type {
    AbortRunOptions,
    AbortRunResponse,
    GetSessionUsageResponse,
    ReadBackgroundProcessResponse,
    RunShellCommandResponse,
    SteerMessageResponse,
    SubmitContextMessageResponse,
    StopBackgroundProcessResponse,
    Model,
    ServiceTier,
} from "../protocol/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";

export interface CodingAssistantModelChoice {
    model: Model;
    providerId: string;
}

/** Provider metadata the terminal needs; actual inference is owned by Agent Base. */
export interface CodingAssistantProviderInfo {
    id: string;
    models: readonly Model[];
    serviceTiers?: readonly ServiceTier[];
}

export interface SteeringRunOptions extends AgentRunOptions {
    clientSubmissionId?: string;
    expectedRunId?: string;
}

export interface CodingAssistantAgentBackend {
    readonly canChangeModel: boolean;
    readonly confirmedServiceTier: ServiceTier | undefined;
    readonly context: AgentContext;
    readonly id: string;
    readonly provider: CodingAssistantProviderInfo;
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
    readBackgroundProcess?(
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
    runShellCommand?(
        command: string,
        options: { commandId: string },
    ): Promise<RunShellCommandResponse>;
    rewind?(messageId: string): Promise<UserMessage>;
    stopBackgroundProcesses?(): Promise<number>;
    stopBackgroundProcess?(sessionId: number): Promise<StopBackgroundProcessResponse>;
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
