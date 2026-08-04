import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { ClaudeApiKeyCredential } from "@/vendors/claude/ClaudeApiKeyCredential.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeOAuthCredential } from "@/vendors/claude/ClaudeOAuthCredential.js";
import { loadCodexCredential } from "@/vendors/codex/loadCodexCredential.js";
import { GeminiApiKeyCredential } from "@/vendors/gemini/GeminiApiKeyCredential.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import type { VendorCredential } from "@/vendors/VendorCredential.js";

export interface TryLoadCredentialsOptions {
    bedrockBearerToken?: string;
    bedrockBearerTokenEnvVar?: string;
    claudeApiKey?: string;
    claudeAuthToken?: string;
    claudeConfigDir?: string;
    claudeOAuthToken?: string;
    codexApiKey?: string;
    codexAuthFile?: string;
    env?: NodeJS.ProcessEnv;
    geminiApiKey?: string;
    grokApiKey?: string;
    grokAuthFile?: string;
}

export async function tryLoadCredentials(
    options: TryLoadCredentialsOptions = {},
): Promise<VendorCredential[]> {
    const env = options.env;
    const credentials = await Promise.all([
        BedrockBearerTokenCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.bedrockBearerToken === undefined
                ? {}
                : { bearerToken: options.bedrockBearerToken }),
            ...(options.bedrockBearerTokenEnvVar === undefined
                ? {}
                : { bearerTokenEnvVar: options.bedrockBearerTokenEnvVar }),
        }),
        ClaudeApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeApiKey === undefined ? {} : { apiKey: options.claudeApiKey }),
        }),
        ClaudeAuthTokenCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeAuthToken === undefined
                ? {}
                : { authToken: options.claudeAuthToken }),
        }),
        ClaudeOAuthCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeOAuthToken === undefined
                ? {}
                : { oauthToken: options.claudeOAuthToken }),
        }),
        ClaudeCodeCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeConfigDir === undefined
                ? {}
                : { configDir: options.claudeConfigDir }),
        }),
        loadCodexCredential({
            ...(options.codexApiKey === undefined ? {} : { apiKey: options.codexApiKey }),
            ...(env === undefined ? {} : { env }),
            ...(options.codexAuthFile === undefined ? {} : { authFile: options.codexAuthFile }),
        }),
        GeminiApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.geminiApiKey === undefined ? {} : { apiKey: options.geminiApiKey }),
        }),
        GrokApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.grokApiKey === undefined ? {} : { apiKey: options.grokApiKey }),
            ...(options.grokAuthFile === undefined ? {} : { authFile: options.grokAuthFile }),
        }),
        GrokSessionCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.grokAuthFile === undefined ? {} : { authFile: options.grokAuthFile }),
        }),
    ]);

    return credentials.filter((credential): credential is VendorCredential => credential !== null);
}
