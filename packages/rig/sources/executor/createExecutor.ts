import { release } from "node:os";

import type { ProviderUsage } from "@slopus/happy-providers";
import {
    Executor,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Terra,
    type ExecutorProvider,
    type Identity,
} from "@slopus/rig-execution";

import type { AgentContext } from "../agent/context/AgentContext.js";
import type { ConfigProvider, ConfigProviders } from "../config/types.js";
import type { OneOffInferenceRoute, SearchInferenceRoutes } from "../tools/search/index.js";
import { configuredBedrockExecution } from "./configuredBedrockExecution.js";
import { claudeExecution } from "./claudeExecution.js";
import { codexExecution } from "./codexExecution.js";
import { grokExecution } from "./grokExecution.js";
import { filterConfiguredProviderModels } from "./filterConfiguredProviderModels.js";
import { providerCredentialEnvironment } from "./providerCredentialEnvironment.js";

export interface CreateExecutorOptions {
    agentContext: AgentContext;
    allowEmptyModels?: boolean;
    apiKey?: string;
    env: NodeJS.ProcessEnv;
    identity?: Identity;
    /** Receives account usage a provider reports while it is already answering. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    providers: ConfigProviders;
    resolveInferenceFatalRetries?: () => number;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}

export interface CreateExecutorResult {
    executor?: Executor;
    missingCredentials: ReadonlyMap<string, string>;
    searchRoutes: SearchInferenceRoutes;
}

export function createExecutor(options: CreateExecutorOptions): CreateExecutorResult {
    const definitions: ExecutorProvider[] = [];
    const missingCredentials = new Map<string, string>();
    const searchRoutes: SearchInferenceRoutes = {
        bedrockRoutes: [],
        claudeRoutes: [],
        codexRoutes: [],
        grokRoutes: [],
    };
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
        if (config.type === "bedrock") {
            const bedrockRoute = bedrockSearchRoute(filtered, config.searchModelId);
            if (bedrockRoute !== undefined) {
                searchRoutes.bedrockRoutes = [...searchRoutes.bedrockRoutes, bedrockRoute];
            }
        }
        const route = firstVisibleRoute(filtered);
        if (route !== undefined) {
            if (config.type === "claude") {
                searchRoutes.claudeRoutes = [...searchRoutes.claudeRoutes, route];
            }
            if (config.type === "codex") {
                searchRoutes.codexRoutes = [...searchRoutes.codexRoutes, route];
            }
            if (config.type === "grok") {
                searchRoutes.grokRoutes = [...searchRoutes.grokRoutes, route];
            }
        }
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
        searchRoutes,
    };
}

function firstVisibleRoute(provider: ExecutorProvider): OneOffInferenceRoute | undefined {
    const profile = provider.profiles.find((candidate) => candidate.hidden !== true);
    return profile === undefined ? undefined : { profile, provider };
}

/**
 * Bedrock's hosted search belongs to its GPT models: they are the ones served over the Responses
 * endpoint, while its Anthropic models go over the plain Messages transport and cannot reach it.
 *
 * These are the fallback when the configuration file does not name a search model. Search is a
 * bounded query-and-summarize call that does not need a frontier model, and both of these are
 * offered in every region where Web Search runs, so the tool answers with the same model wherever
 * it is configured.
 */
const BEDROCK_SEARCH_MODEL_IDS = [modelOpenaiGpt56Luna.id, modelOpenaiGpt56Terra.id] as const;

function bedrockSearchRoute(
    provider: ExecutorProvider,
    configuredModelId: string | undefined,
): OneOffInferenceRoute | undefined {
    // A configured model is a decision the user already made, so it is used as written or not at
    // all. Falling back to a different model would answer their search from somewhere they did not
    // ask for, which is worse than the tool being absent.
    const modelIds =
        configuredModelId === undefined ? BEDROCK_SEARCH_MODEL_IDS : [configuredModelId];
    for (const modelId of modelIds) {
        const profile = provider.profiles.find(
            (candidate) => candidate.hidden !== true && candidate.id === modelId,
        );
        if (profile !== undefined) return { profile, provider };
    }
    return undefined;
}

function configuredExecutor(
    options: CreateExecutorOptions,
    id: string,
    config: ConfigProvider,
): ExecutorProvider | undefined {
    const env = providerCredentialEnvironment(config, options.env);
    return config.type === "codex"
        ? codexExecution({
              ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
              config,
              env,
              id,
              ...(options.resolveInferenceFatalRetries === undefined
                  ? {}
                  : {
                        resolveInferenceFatalRetries: options.resolveInferenceFatalRetries,
                    }),
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
                env,
                id,
                ...(options.onAccountUsage === undefined
                    ? {}
                    : { onAccountUsage: options.onAccountUsage }),
                ...(options.resolveInferenceFatalRetries === undefined
                    ? {}
                    : { resolveInferenceFatalRetries: options.resolveInferenceFatalRetries }),
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            })
          : config.type === "grok"
            ? grokExecution({
                  ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
                  config,
                  env,
                  id,
                  ...(options.resolveInferenceFatalRetries === undefined
                      ? {}
                      : { resolveInferenceFatalRetries: options.resolveInferenceFatalRetries }),
                  ...(options.resolveInferenceMaxRetries === undefined
                      ? {}
                      : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                  ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
              })
            : configuredBedrockExecution({
                  ...(options.sessionId === undefined ? {} : { agentId: options.sessionId }),
                  config,
                  env,
                  id,
                  ...(options.resolveInferenceFatalRetries === undefined
                      ? {}
                      : { resolveInferenceFatalRetries: options.resolveInferenceFatalRetries }),
                  ...(options.resolveInferenceMaxRetries === undefined
                      ? {}
                      : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
              });
}
