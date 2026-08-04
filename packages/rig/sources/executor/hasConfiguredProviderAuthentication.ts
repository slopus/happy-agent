import {
    ClaudeApiKeyCredential,
    ClaudeAuthTokenCredential,
    ClaudeCodeCredential,
    ClaudeOAuthCredential,
    GrokApiKeyCredential,
    GrokSessionCredential,
    loadCodexCredential,
} from "@slopus/rig-providers";

import type { ConfigProvider } from "../config/types.js";
import { readConfiguredBedrockBearerToken } from "./readConfiguredBedrockBearerToken.js";
import { loadNativeCodexProviderConfig } from "./loadNativeCodexProviderConfig.js";

export async function hasConfiguredProviderAuthentication(options: {
    config: ConfigProvider;
    env: NodeJS.ProcessEnv;
}): Promise<boolean> {
    const { config, env } = options;
    try {
        if (config.type === "bedrock") {
            return readConfiguredBedrockBearerToken(config, env) !== undefined;
        }
        if (config.type === "codex") {
            const configuredBaseUrl = config.baseUrl ?? env.RIG_CODEX_BASE_URL;
            const nativeConfiguration =
                configuredBaseUrl === undefined ? await loadNativeCodexProviderConfig(env) : null;
            const nativeBearerToken =
                configuredBaseUrl === undefined &&
                config.authFile === undefined &&
                !env.OPENAI_API_KEY?.trim() &&
                nativeConfiguration?.baseUrl !== undefined
                    ? nativeConfiguration.experimentalBearerToken
                    : undefined;
            return (
                (await loadCodexCredential({
                    ...(nativeBearerToken === undefined ? {} : { apiKey: nativeBearerToken }),
                    ...(config.authFile === undefined ? {} : { authFile: config.authFile }),
                    env,
                })) !== null
            );
        }
        if (config.type === "claude") {
            return (
                ((config.oauthToken === undefined
                    ? null
                    : await ClaudeOAuthCredential.tryLoad({
                          env,
                          oauthToken: config.oauthToken,
                      })) ??
                    (await ClaudeApiKeyCredential.tryLoad({ env })) ??
                    (await ClaudeAuthTokenCredential.tryLoad({ env })) ??
                    (config.oauthToken === undefined
                        ? await ClaudeOAuthCredential.tryLoad({ env })
                        : null) ??
                    (await ClaudeCodeCredential.tryLoad({
                        env,
                        ...(config.configDir === undefined ? {} : { configDir: config.configDir }),
                    }))) !== null
            );
        }
        if (config.type === "grok") {
            return (
                ((await GrokApiKeyCredential.tryLoad({
                    ...(config.authFile === undefined ? {} : { authFile: config.authFile }),
                    env,
                })) ??
                    (await GrokSessionCredential.tryLoad({
                        ...(config.authFile === undefined ? {} : { authFile: config.authFile }),
                        env,
                    }))) !== null
            );
        }
        config satisfies never;
        return false;
    } catch {
        return false;
    }
}
