import type { DebugLog } from "../debug/index.js";
import type { ProviderError, ServiceTier, StopReason } from "../protocol/index.js";
import type { AgentLoopEvent } from "./AgentLoopEvent.js";
import type { Message } from "./types.js";

export type AgentStatus = "idle" | "running" | "aborted";

export interface QueuedAgentMessage {
    id: string;
    message: Message;
}

export interface AgentSnapshot {
    appendSystemPrompt?: string;
    id: string;
    providerId: string;
    modelId: string;
    effort?: string;
    serviceTier?: ServiceTier;
    status: AgentStatus;
    instructions?: string;
    messages: readonly Message[];
    contextMessages?: readonly Message[];
    queue: readonly QueuedAgentMessage[];
    tools: readonly string[];
    lastRunId?: string;
    systemPrompt?: string;
}

export interface AgentRunOptions {
    beforeInference?: () => Promise<void>;
    clientSubmissionId?: string;
    debug?: DebugLog;
    displayText?: string;
    signal?: AbortSignal;
    onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
    onMessage?: (message: Message) => void | Promise<void>;
}

interface AgentLoopOutcome {
    messages: readonly Message[];
    contextMessages: readonly Message[];
}

export type AgentRunResult = (
    | (AgentLoopOutcome & {
          errorMessage: string;
          providerError: ProviderError;
          providerId: string;
          requestedModelId: string;
          stopReason: "error";
      })
    | (AgentLoopOutcome & {
          errorMessage?: never;
          stopReason: Exclude<StopReason, "error">;
      })
) & {
    debugDirectory?: string;
    runId: string;
};

export interface AgentCompactionResult {
    compacted: boolean;
    compactedMessageCount: number;
    estimatedTokensAfter: number;
    estimatedTokensBefore: number;
    retainedMessageCount: number;
}