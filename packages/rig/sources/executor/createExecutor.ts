import { release } from "node:os";

import type { ProviderUsage } from "@slopus/rig-providers";
import {
    Executor,
    type ExecutorProvider,
    type HostedCapability,
    type Identity,
} from "@slopus/rig-execution";

import type { AgentContext } from "../agent/context/AgentContext.js";
import type { ConfigProvider, ConfigProviders } from "../config/types.js";
import { configuredBedrockExecution } from "./configuredBedrockExecution.js";
import { claudeExecution } from "./claudeExecution.js";
import { codexExecution } from "./codexExecution.js";
import { grokExecution } from "./grokExecution.js";
import { filterConfiguredProviderModels } from "./filterConfiguredProviderModels.js";

export interface CreateExecutorOptions {
    agentContext: AgentContext;
    allowEmptyModels?: boolean;
    apiKey?: string;
    env: NodeJS.ProcessEnv;
    /** Provider-executed searches this agent was granted. Empty unless something granted them. */
    hostedCapabilities?: readonly HostedCapability[];
    identity?: Identity;
    /** Receives account usage a provider reports while it is already answering. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    providers: ConfigProviders;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}

export interface CreateExecutorResult {
    executor?: Executor;
    missingCredentials: ReadonlyMap<string, string>;
}

export function createExecutor(options: CreateExecutorOptions): CreateExecutorResult {
    const definitions: ExecutorProvider[] = [];
    const missingCredentials = new Map<string, string>();
    for (const [id, config] of Object.entries(options.providers)) {
        if (!config.enabled) continue;
        const configured = configuredExecutor(options, id, config);
        if (configured === undefined) {
            missingCredentials.set(
                id,
                config.type === "bedrock"
                    ? (config.bearerTokenEnvVar ?? "AWS_BEARER_TOKEN_BEDROCK")
                    : "local coding-assistant authentication",
            );
            continue;
        }
        const filtered = filterConfiguredProviderModels(
            configured,
            config,
            options.allowEmptyModels === undefined ? {} : { allowEmpty: options.allowEmptyModels },
        );
        definitions.push(filtered);
    }
    return {
        ...(definitions.length === 0
            ? {}
            : {
                  executor: new Executor(definitions, {
                      environment: {
                          osVersion: release(),
                          platform: process.platform,
                          primaryWorkingDirectory: options.agentContext.fs.cwd,
                          shell: options.env.SHELL ?? "",
                      },
                      ...(options.identity === undefined ? {} : { identity: options.identity }),
                  }),
              }),
        missingCredentials,
    };
}

function configuredExecutor(
    options: CreateExecutorOptions,
    id: string,
    config: ConfigProvider,
): ExecutorProvider | undefined {
    return config.type === "codex"
        ? codexExecution({
              ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
              config,
              env: options.env,
              id,
              ...(options.resolveInferenceMaxRetries === undefined
                  ? {}
                  : {
                        resolveInferenceMaxRetries: options.resolveInferenceMaxRetries,
                    }),
              ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          })
        : config.type === "claude"
          ? claudeExecution({
                config,
                env: options.env,
                id,
                ...(options.onAccountUsage === undefined
                    ? {}
                    : { onAccountUsage: options.onAccountUsage }),
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            })
          : config.type === "grok"
            ? grokExecution({
                  ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
                  config,
                  env: options.env,
                  ...(options.hostedCapabilities === undefined
                      ? {}
                      : { hostedCapabilities: options.hostedCapabilities }),
                  id,
                  ...(options.resolveInferenceMaxRetries === undefined
                      ? {}
                      : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                  ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
              })
            : configuredBedrockExecution({
                  ...(options.sessionId === undefined ? {} : { agentId: options.sessionId }),
                  config,
                  env: options.env,
                  id,
                  ...(options.resolveInferenceMaxRetries === undefined
                      ? {}
                      : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
              });
}
