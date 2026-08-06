import type { ConfigBedrockProvider } from "../config/types.js";
import type { ExecutorProvider } from "@slopus/rig-execution";
import { bedrockExecution } from "./bedrockExecution.js";
import { readConfiguredBedrockBearerToken } from "./readConfiguredBedrockBearerToken.js";

export function configuredBedrockExecution(options: {
    agentId?: string;
    config: ConfigBedrockProvider;
    env: NodeJS.ProcessEnv;
    id: string;
    resolveInferenceMaxRetries?: () => number;
}): ExecutorProvider | undefined {
    const bearerToken = readConfiguredBedrockBearerToken(options.config, options.env);
    if (bearerToken === undefined) return undefined;
    return bedrockExecution({
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        bearerToken,
        env: options.env,
        id: options.id,
        ...(options.resolveInferenceMaxRetries === undefined
            ? {}
            : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
        ...(options.config.modelOverrides === undefined
            ? {}
            : { modelOverrides: options.config.modelOverrides }),
        ...(options.config.region === undefined ? {} : { region: options.config.region }),
    });
}
