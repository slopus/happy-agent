import { resolveBedrockModelId } from "@/vendors/bedrock/impl/resolveBedrockModelId.js";
import { resolveCodexModelId } from "@/vendors/codex/impl/resolveCodexModelId.js";
import type { CodexBedrockTransport } from "@/vendors/codex/CodexProvider.js";

/**
 * Resolves a rig model id to the wire model id for the Codex Responses path.
 *
 * Bedrock Mantle serves OpenAI models under dotted ids (openai.gpt-5.6-sol), while Runtime uses
 * routed variants such as global.openai.gpt-6-astra. Both follow the v1 wire contract. Native
 * Codex uses the bare model name (gpt-5.6-sol), so the credential and Bedrock transport decide
 * which mapping applies.
 */
export function resolveCodexSessionModelId(
    modelId: string,
    isBedrock: boolean,
    bedrockTransport: CodexBedrockTransport = "mantle",
): string {
    if (!isBedrock) return resolveCodexModelId(modelId);
    const resolved = resolveBedrockModelId(modelId);
    if (bedrockTransport === "mantle" || /^(?:global|us)\./u.test(resolved)) return resolved;
    return `global.${resolved}`;
}
