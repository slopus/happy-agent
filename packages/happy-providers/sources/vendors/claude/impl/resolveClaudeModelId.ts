const CLAUDE_MODEL_IDS: Readonly<Record<string, string>> = {
    "anthropic/fable-5-1": "claude-fable-5-1",
    "anthropic/fable-5": "claude-fable-5[1m]",
    "anthropic/opus-5": "claude-opus-5[1m]",
    "anthropic/opus-4-8": "claude-opus-4-8[1m]",
    "anthropic/sonnet-5": "claude-sonnet-5[1m]",
};

export function resolveClaudeModelId(modelId: string): string {
    return CLAUDE_MODEL_IDS[modelId] ?? modelId;
}
