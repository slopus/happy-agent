import type { ProviderUsage } from "@slopus/happy-providers";
import type { ProviderError, StopReason, Usage } from "../protocol/index.js";

export interface GymInferenceContext {
    messages: readonly {
        role: string;
        content?: unknown;
        [key: string]: unknown;
    }[];
    systemPrompt?: string;
}

export interface GymInferenceOptions {
    serviceTier?: "fast";
    sessionId?: string;
    thinking?: string;
}

export type GymAssistantContent =
    | { type: "text"; text: string; textSignature?: string }
    | { type: "thinking"; thinking: string; encrypted?: string; redacted?: boolean }
    | {
          type: "toolCall";
          id: string;
          providerToolCallId?: string;
          name: string;
          namespace?: string;
          arguments: Record<string, unknown>;
          incomplete?: boolean;
          kind?: "custom" | "function";
          vendor?: unknown;
      };

export interface GymInferenceRequest {
    context: GymInferenceContext;
    modelId: string;
    options: GymInferenceOptions;
    providerSessionGeneration: number;
    providerId: string;
}

export interface GymInferenceResponse {
    /** Account usage the scripted provider reports while it answers, as Claude does. */
    accountUsage?: ProviderUsage;
    compactionContext?: GymInferenceContext;
    compactionSummary?: string;
    completionDelayMs?: number;
    content: readonly GymAssistantContent[];
    contextTokens?: number;
    delayMs?: number;
    disconnectAfterTextDeltas?: number;
    errorAfterContentStart?: boolean;
    errorAfterTextDeltas?: number;
    errorMessage?: string;
    providerRetries?: readonly {
        attempt: number;
        delayMs?: number;
        reason: string;
    }[];
    providerError?: ProviderError;
    responseModel?: string;
    stopReason?: StopReason;
    thinkingDeltaChunkSize?: number;
    thinkingDeltaDelayMs?: number;
    textDeltaChunkSize?: number;
    textDeltaDelayMs?: number;
    toolCallDeltaDelayMs?: number;
    usage?: Usage;
}
