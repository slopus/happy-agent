import {
    ClaudeApiKeyCredential,
    ClaudeAuthTokenCredential,
    ClaudeCodeCredential,
    ClaudeOAuthCredential,
    ClaudeProvider,
    type ProviderUsage,
} from "@slopus/rig-providers";
import { builtinModelProfiles, type ExecutorProvider } from "@slopus/rig-execution";

import type { ConfigClaudeProvider } from "../config/types.js";
import { createConfiguredClaudeEnvironment } from "./createConfiguredClaudeEnvironment.js";

export function claudeExecution(options: {
    config: ConfigClaudeProvider;
    env: NodeJS.ProcessEnv;
    id: string;
    /** Receives the account usage Claude reports while it is already answering. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const executable = options.config.executable ?? options.env.RIG_CLAUDE_CODE_EXECUTABLE;
    const environment = createConfiguredClaudeEnvironment(options.config, options.env);
    const pathToClaudeCodeExecutable = executable;
    return {
        id: options.id,
        extendProfilePromptContext: (context) => ({
            ...context,
            ...(environment.CLAUDE_CONFIG_DIR === undefined
                ? {}
                : { claudeConfigDirectory: environment.CLAUDE_CONFIG_DIR }),
            ...(environment.SHELL === undefined ? {} : { shell: environment.SHELL }),
        }),
        profiles: builtinModelProfiles(options.id, "claude"),
        sessionId: options.sessionId ?? options.id,
        native: async () => {
            const credential =
                (options.config.oauthToken === undefined
                    ? null
                    : await ClaudeOAuthCredential.tryLoad({
                          env: environment,
                          oauthToken: options.config.oauthToken,
                      })) ??
                (await ClaudeApiKeyCredential.tryLoad({ env: environment })) ??
                (await ClaudeAuthTokenCredential.tryLoad({ env: environment })) ??
                (options.config.oauthToken === undefined
                    ? await ClaudeOAuthCredential.tryLoad({ env: environment })
                    : null) ??
                (await ClaudeCodeCredential.tryLoad({
                    env: environment,
                    ...(options.config.configDir === undefined
                        ? {}
                        : { configDir: options.config.configDir }),
                }));
            if (credential === null) {
                throw new Error(
                    "Claude authentication is unavailable. Sign in with Claude Code or configure a credential.",
                );
            }
            return new ClaudeProvider({
                credential,
                env: environment,
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                ...(options.onAccountUsage === undefined
                    ? {}
                    : {
                          // The vendor reading knows nothing of Rig's provider
                          // names, so the configured account is named here.
                          onAccountUsage: (usage) =>
                              options.onAccountUsage?.({ ...usage, providerId: options.id }),
                      }),
                ...(pathToClaudeCodeExecutable === undefined ? {} : { pathToClaudeCodeExecutable }),
            });
        },
    };
}
