import type { ProviderUsage } from "@slopus/rig-providers";
import type {
    AssistantContent,
    Context,
    ProviderError,
    StopReason,
    StreamOptions,
    Usage,
} from "@slopus/rig-execution";

export interface GymInferenceRequest {
    context: Context;
    modelId: string;
    options: StreamOptions;
    providerSessionGeneration: number;
    providerId: string;
}

export interface GymInferenceResponse {
    /** Account usage the scripted provider reports while it answers, as Claude does. */
    accountUsage?: ProviderUsage;
    compactionContext?: Context;
    compactionSummary?: string;
    completionDelayMs?: number;
    content: readonly AssistantContent[];
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
    /** Tools the provider ran on its own backend before this response's content, as Grok search does. */
    serverToolCalls?: readonly {
        arguments: string;
        callId?: string;
        name: string;
    }[];
    /** Pauses before and after a hosted call's argument delta, keeping its live row observable. */
    serverToolCallDeltaDelayMs?: number;
    stopReason?: StopReason;
    thinkingDeltaChunkSize?: number;
    thinkingDeltaDelayMs?: number;
    textDeltaChunkSize?: number;
    textDeltaDelayMs?: number;
    toolCallDeltaDelayMs?: number;
    usage?: Usage;
}
