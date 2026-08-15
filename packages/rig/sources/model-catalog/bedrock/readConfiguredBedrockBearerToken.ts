import type { ConfigBedrockProvider } from "../../config/types.js";
import { readBedrockBearerToken } from "./readBedrockBearerToken.js";

/**
 * The token written in the configuration file wins, then the environment variable the file names,
 * then the default one. Configuration is the more specific statement of intent, and it is the only
 * one of the three that survives a shell that never exported anything.
 */
export function readConfiguredBedrockBearerToken(
    config: ConfigBedrockProvider,
    env: NodeJS.ProcessEnv,
): string | undefined {
    const configured = config.bearerToken?.trim();
    if (configured !== undefined && configured.length > 0) return configured;
    if (config.bearerTokenEnvVar === undefined) return readBedrockBearerToken(env);
    const value = env[config.bearerTokenEnvVar]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
}
