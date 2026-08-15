/**
 * Whether Codex Cloud can deliver an encrypted native agent message to this model.
 */
export function isCodexEncryptedAgentTransportModel(modelId: string): boolean {
    return (
        modelId === "openai/gpt-5.6-sol" ||
        modelId === "openai/gpt-5.6-terra" ||
        modelId === "openai/gpt-5.6-luna" ||
        modelId === "openai/gym"
    );
}
