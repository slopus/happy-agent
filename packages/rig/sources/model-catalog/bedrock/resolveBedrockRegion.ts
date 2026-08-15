export function resolveBedrockRegion(env: NodeJS.ProcessEnv = process.env): string {
    return env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "us-east-1";
}
