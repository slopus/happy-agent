import { release } from "node:os";

import type { ProviderUsage } from "@slopus/rig-providers";
import {
    Executor,
    type ExecutorProvider,
    type HostedCapability,
    type Identity,
} from "@slopus/rig-execution";

import type { AgentContext } from "../agent/context/AgentContext.js";
import type { PermissionMode } from "../permissions/index.js";
import type { ConfigProvider, ConfigProviders } from "../config/types.js";
import {
    permissionModeAllowsProviderRunSearch,
    hostedSearchesFor,
} from "../runtime/resolveHostedCapabilities.js";
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
    identity?: Identity;
    /**
     * The session's own permission mode, asked for rather than captured.
     *
     * One executor outlives the agent contexts built around it: switching to an incompatible
     * model drops the runtime and its context but keeps the executor, and the mode is then
     * changed on a context this executor has never seen. Reading the session directly is what
     * keeps a later narrowing real. Falls back to this agent's context when absent.
     */
    resolvePermissionMode?: () => PermissionMode | undefined;
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

/**
 * The one place a provider-run search is decided, asked freshly for every request.
 *
 * Two inputs and no others: the permission mode says whether this agent may reach outside Rig's
 * sandbox at all, and the provider says what its own backend can run. Not depth, not whether this
 * is a subagent, not configuration — a search declared on a request is a harness detail.
 *
 * The mode is read at the moment the request is built rather than when the agent was created,
 * because it can change underneath a live session. Nothing can be taken back after that: a
 * declared search runs on the provider's backend, out of Rig's reach.
 */
function hostedCapabilitiesForRequest(
    options: CreateExecutorOptions,
    config: ConfigProvider,
): () => readonly HostedCapability[] {
    const searches = hostedSearchesFor(config.type);
    if (searches.length === 0) return () => [];
    return () =>
        permissionModeAllowsProviderRunSearch(
            options.resolvePermissionMode?.() ?? options.agentContext.permissions?.mode,
        )
            ? searches
            : [];
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
              // The same question Grok is asked, in the same place: OpenAI runs its search inside
              // its own response, so declining to declare it is the whole enforcement.
              hostedCapabilitiesForRequest: hostedCapabilitiesForRequest(options, config),
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
                  // Resolved against this provider's own configuration rather than against
                  // whichever provider happened to be selected when the executor was built. One
                  // executor owns every configured provider and outlives a model switch, so
                  // asking here is what lets someone start on Claude, switch to Grok, and still
                  // get the searches a root Grok agent holds.
                  hostedCapabilitiesForRequest: hostedCapabilitiesForRequest(options, config),
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
