export const BEDROCK_DEFAULT_REGION = "us-east-1";

export function bedrockMantleEndpoint(region: string): string {
    return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

export function anthropicBedrockMantleEndpoint(region: string): string {
    return `https://bedrock-mantle.${region}.api.aws/anthropic`;
}

export function bedrockRuntimeEndpoint(region: string): string {
    return `https://bedrock-runtime.${region}.amazonaws.com`;
}

export function bedrockRuntimeOpenAIEndpoint(region: string): string {
    return `${bedrockRuntimeEndpoint(region)}/openai/v1`;
}
