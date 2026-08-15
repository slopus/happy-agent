import type { ConfigProvider } from "../config/types.js";

/**
 * Prevents a remotely provisioned provider from silently using the receiving machine's account.
 * Non-credential environment stays available to the provider process.
 */
export function providerCredentialEnvironment(
    config: ConfigProvider,
    environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    if (config.credentialIsolation !== true) return environment;
    const isolated = { ...environment };
    for (const name of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_DEFAULT_REGION",
        "AWS_PROFILE",
        "AWS_REGION",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_VERTEX",
        "CODEX_HOME",
        "GROK_HOME",
        "OPENAI_API_KEY",
        "RIG_CODEX_BASE_URL",
        "RIG_CODEX_TRANSPORT",
        "RIG_GROK_BASE_URL",
        "XAI_API_KEY",
    ]) {
        delete isolated[name];
    }
    return isolated;
}
