export const BEDROCK_DEFAULT_REGION = "us-east-1";

export function bedrockMantleEndpoint(region: string): string {
    return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

export function anthropicBedrockMantleEndpoint(region: string): string {
    return `https://bedrock-mantle.${region}.api.aws/anthropic`;
}

/** China regions form their own AWS partition, served under a separate DNS suffix. */
export function isBedrockChinaRegion(region: string): boolean {
    return region.startsWith("cn-");
}

export function bedrockRuntimeEndpoint(region: string): string {
    const domain = isBedrockChinaRegion(region) ? "amazonaws.com.cn" : "amazonaws.com";
    return `https://bedrock-runtime.${region}.${domain}`;
}

export function bedrockRuntimeOpenAIEndpoint(region: string): string {
    return `${bedrockRuntimeEndpoint(region)}/openai/v1`;
}
