/** Structural protocol used by the hermetic HTTP inference fixture. */
export interface GymInferenceBlock {
    type: string;
    arguments?: unknown;
    [key: string]: unknown;
}

export interface GymInferenceMessage {
    role: string;
    content: readonly GymInferenceBlock[];
    [key: string]: unknown;
}

export interface GymInferenceTool {
    name: string;
    [key: string]: unknown;
}

export interface GymInferenceContext {
    messages: readonly GymInferenceMessage[];
    systemPrompt?: string;
    tools?: readonly GymInferenceTool[];
    [key: string]: unknown;
}

export interface GymInferenceOptions {
    sessionId?: string;
    serviceTier?: string;
    [key: string]: unknown;
}

export interface GymInferenceRequest {
    context: GymInferenceContext;
    modelId: string;
    options: GymInferenceOptions;
    providerSessionGeneration: number;
    providerId: string;
}

export interface GymInferenceResponse {
    accountUsage?: unknown;
    compactionContext?: GymInferenceContext;
    compactionSummary?: string;
    completionDelayMs?: number;
    content: readonly GymInferenceBlock[];
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
    providerError?: unknown;
    responseModel?: string;
    stopReason?: string;
    thinkingDeltaChunkSize?: number;
    thinkingDeltaDelayMs?: number;
    textDeltaChunkSize?: number;
    textDeltaDelayMs?: number;
    toolCallDeltaDelayMs?: number;
    usage?: unknown;
}
