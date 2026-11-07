import { isBedrockModelArn } from "@/vendors/bedrock/impl/isBedrockModelArn.js";

/**
 * A Bedrock model or inference-profile ID: a lowercase vendor or geography segment, a dot, and the
 * rest, such as `anthropic.claude-opus-5-5`, `openai.gpt-oss-120b-1:0`, `us.zai.glm-5.3`, or
 * `global.moonshotai.kimi-k3`.
 */
const BEDROCK_MODEL_ID = /^[a-z0-9-]+\.[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/**
 * Checks a caller's curated-to-wire Bedrock model map. Each value is sent as the request's model
 * unchanged, so it must be a Bedrock model ARN, inference-profile ARN, application-inference-profile
 * ARN, inference-profile ID, or model ID.
 */
export function assertBedrockModelIds(ids: Readonly<Record<string, string>> | undefined): void {
    for (const [model, wire] of Object.entries(ids ?? {})) {
        if (wire.length > 2_048 || (!isBedrockModelArn(wire) && !BEDROCK_MODEL_ID.test(wire))) {
            throw new Error(
                `The Bedrock model ID for ${model} must be a Bedrock model or inference-profile ARN or ID: ${wire}.`,
            );
        }
    }
}

/** The wire model a caller mapped for this curated model, looking only at the map's own keys. */
export function mappedBedrockModelId(
    ids: Readonly<Record<string, string>> | undefined,
    model: string,
): string | undefined {
    return ids !== undefined && Object.hasOwn(ids, model) ? ids[model] : undefined;
}
