import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";

export function resolveAnthropicBedrockModelId(
    model: string,
    region: string,
    transport: AnthropicBedrockTransport = "runtime",
): string {
    if (!model.startsWith("anthropic/")) return model;
    const modelName = model.slice("anthropic/".length);
    const base = `anthropic.claude-${modelName}`;
    if (!["fable-5-1", "fable-5", "opus-5", "opus-4-8", "sonnet-5"].includes(modelName)) {
        throw new Error(
            `Anthropic model "${model}" is not available through Rig's Bedrock catalog. Pass a Bedrock model or inference-profile ID directly to use an unlisted model.`,
        );
    }
    if (transport === "mantle") return base;
    if (modelName === "opus-5" || modelName === "opus-4-8") {
        if (region === "ap-northeast-1" || region === "ap-northeast-3") {
            return `jp.${base}`;
        }
        if (region === "ap-southeast-2") return `au.${base}`;
        if (region.startsWith("eu-")) return `eu.${base}`;
        if (region.startsWith("us-")) return `us.${base}`;
        return `global.${base}`;
    }
    if (modelName === "fable-5-1" || modelName === "fable-5") {
        if (region.startsWith("eu-")) return `eu.${base}`;
        if (region.startsWith("us-")) return `us.${base}`;
        return `global.${base}`;
    }
    if (modelName === "sonnet-5") {
        if (region === "ap-southeast-2" || region === "ap-southeast-4") {
            return `au.${base}`;
        }
        if (region.startsWith("eu-")) return `eu.${base}`;
        if (region.startsWith("us-")) return `us.${base}`;
        return `global.${base}`;
    }
    return base;
}
