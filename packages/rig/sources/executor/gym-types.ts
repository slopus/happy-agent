import type { ProviderUsage } from "@slopus/rig-providers";
import type {
    AssistantContent,
    Context,
    HostedCapability,
    ProviderError,
    StopReason,
    StreamOptions,
    Usage,
} from "@slopus/rig-execution";

export interface GymInferenceRequest {
    context: Context;
    /**
     * The searches this request declared for the provider to run on its own backend.
     *
     * Empty is the ordinary answer: most providers run none, and a mode that cannot reach past the
     * sandbox declares none for any provider. A hosted search cannot be observed as a tool call —
     * the provider runs it inside its own response — so this is where a test sees the decision.
     */
    hostedSearches?: readonly HostedCapability[];
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
    /**
     * Holds a hosted call open after its arguments arrived and before it completes.
     *
     * The provider is still working upstream at that point, which is the only window in which a
     * hosted call can be interrupted. Replaces the delay after the delta when both are set.
     */
    serverToolCallEndDelayMs?: number;
    stopReason?: StopReason;
    thinkingDeltaChunkSize?: number;
    thinkingDeltaDelayMs?: number;
    textDeltaChunkSize?: number;
    textDeltaDelayMs?: number;
    toolCallDeltaDelayMs?: number;
    usage?: Usage;
}
