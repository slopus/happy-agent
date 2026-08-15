export function readBedrockBearerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const token = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
    return token === undefined || token.length === 0 ? undefined : token;
}
