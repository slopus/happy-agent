import { createId } from "@paralleldrive/cuid2";
import type { ProviderUsage } from "@slopus/happy-providers";

import { createPermissionReviewSideAgent } from "../permissions/index.js";
import { Executor, type Identity } from "@slopus/rig-execution";

import {
    Agent,
    createNodeAgentContext,
    createDockerAgentContext,
    type AgentOptions,
    type AgentCommunicationContext,
    type AgentTreeUsageContext,
    type ChatHistoryContext,
    type GoalContext,
    type PermissionMode,
    type SessionSecretContext,
    type SubagentContext,
    type TaskContext,
    type UserInputContext,
} from "../agent/index.js";
import type { Message } from "../agent/types.js";
import { DEFAULT_RIG_CONFIG } from "../config/defaultConfig.js";
import { findConfiguredProvider } from "../config/findConfiguredProvider.js";
import { getGlobalAgentsMdPath } from "../config/getGlobalAgentsMdPath.js";
import { getGlobalSecurityMdPath } from "../config/getGlobalSecurityMdPath.js";
import { readGlobalAgentsMd } from "../config/readGlobalAgentsMd.js";
import { readGlobalSecurityMd } from "../config/readGlobalSecurityMd.js";
import { readProjectSecurityMd } from "../config/readProjectSecurityMd.js";
import type { ConfigProviders } from "../config/types.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { NativeProcessManager } from "../processes/index.js";
import { createExecutor } from "../executor/createExecutor.js";
import { createGymProviderFromEnvironment } from "../executor/createGymProviderFromEnvironment.js";
import { getBedrockModelRoute } from "../executor/getBedrockModelRoute.js";
import { modelOpenaiGpt56Sol } from "@slopus/rig-execution";
import type { ServiceTier } from "@slopus/rig-execution";
import { routeProviderThroughGym } from "../executor/routeProviderThroughGym.js";
import type { WorkflowContext } from "../workflows/index.js";
import type { CodingAssistantRuntime } from "./CodingAssistantRuntime.js";
import { createDefaultInstructions } from "./createDefaultInstructions.js";
import { createGymJustBashAgentContext } from "./createGymJustBashAgentContext.js";
import { agentFolderLabel } from "../agent/impl/agentFolderLabel.js";
import type { PluginContext } from "../agent/context/PluginContext.js";
import type { SlotContext } from "../agent/context/SlotContext.js";
import type { FolderContext } from "../agent/context/FolderContext.js";
import type { WorkletContext } from "../agent/context/WorkletContext.js";
import type { WorkspaceContext } from "../agent/context/WorkspaceContext.js";
import type { SchedulingContext } from "../scheduling/index.js";
import type { ProviderUsageContext } from "../agent/context/ProviderUsageContext.js";
import { createGeneratedMediaStore, getGeneratedDirectory } from "../generated-media/index.js";
import { CONTAINER_GENERATED_PATH } from "../execution/index.js";
import { AttachmentContext, type AttachmentScope } from "../tools/attachments/AttachmentContext.js";
import type { Context } from "@steve.kite/stdlib";

export interface CreateCodingAssistantAgentOptions {
    attachmentScope?: AttachmentScope;
    appendSystemPrompt?: string;
    agentCommunication?: AgentCommunicationContext;
    agentTreeUsage?: AgentTreeUsageContext;
    cwd: string;
    ctx: Context;
    docker?: DockerExecutionConfig;
    agentId?: string;
    /** Stable Rig identity whose credentials and usage this runtime consumes. */
    ownerInstanceId?: string;
    apiKey?: string;
    chatHistory?: ChatHistoryContext;
    effort?: string;
    executor?: Executor;
    env?: NodeJS.ProcessEnv;
    folders?: FolderContext;
    goals?: GoalContext;
    instructions?: string;
    identity?: Identity;
    isSubagent?: boolean;
    local?: boolean;
    messages?: readonly Message[];
    /** Receives account usage a provider reports while it is already answering. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    contextMessages?: readonly Message[];
    modelId?: string;
    providerId?: string;
    processManager?: NativeProcessManager;
    permissionMode?: PermissionMode;
    providers?: ConfigProviders;
    providerUsage?: ProviderUsageContext;
    resolveInferenceMaxRetries?: () => number;
    serviceTier?: ServiceTier;
    /** Variables injected into every command this session executes. */
    shellEnvironment?: Readonly<Record<string, string>>;
    startDate?: string;
    secrets?: SessionSecretContext;
    scheduling?: SchedulingContext;
    slots?: SlotContext;
    worklets?: WorkletContext;
    subagents?: SubagentContext;
    systemPrompt?: string;
    plugins?: PluginContext;
    protectedPaths?: readonly string[];
    tasks?: TaskContext;
    userInput?: UserInputContext;
    workflows?: WorkflowContext;
    workflowsEnabled?: boolean;
    workspaces?: WorkspaceContext;
    sessionId?: string;
}

export function createCodingAssistantAgent(
    options: CreateCodingAssistantAgentOptions,
): CodingAssistantRuntime {
    const processManager = options.processManager ?? new NativeProcessManager();
    const env = options.env ?? process.env;
    const shellEnvironment =
        options.shellEnvironment === undefined
            ? process.env
            : { ...process.env, ...options.shellEnvironment };
    const agentId = options.agentId ?? createId();
    const workflowsEnabled = options.workflows !== undefined && options.workflowsEnabled !== false;
    const sharedContextOptions = {
        ...(options.folders !== undefined ? { folders: options.folders } : {}),
        ...(options.goals !== undefined ? { goals: options.goals } : {}),
        ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
        ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
        ...(options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths }),
        ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
        ...(options.tasks !== undefined ? { tasks: options.tasks } : {}),
        ...(options.userInput !== undefined ? { userInput: options.userInput } : {}),
        ...(workflowsEnabled ? { workflows: options.workflows } : {}),
    };
    const context =
        process.env.RIG_GYM_RUNTIME === "just-bash"
            ? createGymJustBashAgentContext(sharedContextOptions)
            : options.docker === undefined
              ? createNodeAgentContext(options.ctx, {
                    ...sharedContextOptions,
                    cwd: options.cwd,
                    environment: shellEnvironment,
                    processManager,
                })
              : createDockerAgentContext({
                    ...sharedContextOptions,
                    docker: options.docker,
                    ...(options.shellEnvironment === undefined
                        ? {}
                        : { environment: options.shellEnvironment }),
                    sessionId: options.sessionId ?? options.agentId ?? "standalone",
                });
    const runtimeCwd = context.fs.cwd;
    context.attachments = new AttachmentContext(
        options.attachmentScope === undefined ? {} : { scope: options.attachmentScope },
    );
    if (
        process.env.RIG_GYM_RUNTIME !== "just-bash" &&
        (options.docker === undefined || options.docker.container === undefined)
    ) {
        const hostDirectory = getGeneratedDirectory(env);
        context.generatedMedia = createGeneratedMediaStore({
            hostDirectory,
            ...(options.docker === undefined ? {} : { modelDirectory: CONTAINER_GENERATED_PATH }),
        });
    }
    context.agentCommunication =
        options.agentCommunication ??
        ({
            info: () => {
                throw new Error("Cross-agent messaging is unavailable in this session.");
            },
            me: () => ({ agentId, folder: agentFolderLabel(runtimeCwd) }),
            send: () => {
                throw new Error("Cross-agent messaging is unavailable in this session.");
            },
        } satisfies AgentCommunicationContext);
    if (options.agentTreeUsage !== undefined) {
        context.agentTreeUsage = options.agentTreeUsage;
    }
    if (options.chatHistory !== undefined) {
        context.chatHistory = options.chatHistory;
    }
    if (options.subagents !== undefined) {
        context.subagents = options.subagents;
    }
    if (options.workspaces !== undefined) {
        context.workspaces = options.workspaces;
    }
    if (options.plugins !== undefined) {
        context.plugins = options.plugins;
    }
    if (options.scheduling !== undefined) {
        context.scheduling = options.scheduling;
    }
    if (options.slots !== undefined) {
        context.slots = options.slots;
    }
    if (options.worklets !== undefined) {
        context.worklets = options.worklets;
    }
    if (options.providerUsage !== undefined) {
        context.providerUsage = options.providerUsage;
    }
    const modelId = options.modelId ?? modelOpenaiGpt56Sol.id;
    const providerId =
        options.providerId ??
        (modelId.startsWith("anthropic/")
            ? "claude"
            : modelId.startsWith("xai/")
              ? "grok"
              : modelId.startsWith("openai/")
                ? "codex"
                : getBedrockModelRoute(modelId) !== undefined
                  ? "bedrock"
                  : "codex");
    const providerConfig =
        providerId === "gym"
            ? undefined
            : findConfiguredProvider(options.providers ?? DEFAULT_RIG_CONFIG.providers, providerId);
    if (providerId !== "gym" && (providerConfig === undefined || !providerConfig.enabled)) {
        throw new Error(`Unknown or disabled inference provider '${providerId}'.`);
    }
    const nativeProvider =
        options.executor ??
        (() => {
            if (providerId === "gym") {
                const provider = createGymProviderFromEnvironment(env);
                if (provider === undefined) {
                    throw new Error("RIG_GYM_INFERENCE_URL is required for the gym provider.");
                }
                return provider;
            }
            if (providerConfig === undefined)
                throw new Error(`Unknown inference provider '${providerId}'.`);
            const result = createExecutor({
                agentContext: context,
                ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
                env,
                ...(options.identity === undefined ? {} : { identity: options.identity }),
                ...(options.onAccountUsage === undefined
                    ? {}
                    : { onAccountUsage: options.onAccountUsage }),
                providers: options.providers ?? DEFAULT_RIG_CONFIG.providers,
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : {
                          resolveInferenceMaxRetries: options.resolveInferenceMaxRetries,
                      }),
                sessionId: agentId,
            });
            const executor = result.executor;
            if (executor === undefined) {
                const variable = result.missingCredentials.get(providerId);
                throw new Error(
                    variable === undefined
                        ? `Inference provider '${providerId}' is unavailable.`
                        : `Inference provider '${providerId}' requires the ${variable} environment variable.`,
                );
            }
            executor.selectProvider(providerId);
            return executor;
        })();
    // The reviewer gets its own context so its read-only permissions are its own. Reusing the
    // agent's context would let the agent under review widen the reviewer along with itself.
    const createPermissionReviewContext = () =>
        process.env.RIG_GYM_RUNTIME === "just-bash"
            ? createGymJustBashAgentContext({
                  permissionMode: "read_only",
                  ...(options.protectedPaths === undefined
                      ? {}
                      : { protectedPaths: options.protectedPaths }),
              })
            : options.docker === undefined
              ? createNodeAgentContext(options.ctx, {
                    cwd: options.cwd,
                    environment: shellEnvironment,
                    permissionMode: "read_only",
                    processManager,
                    ...(options.protectedPaths === undefined
                        ? {}
                        : { protectedPaths: options.protectedPaths }),
                })
              : createDockerAgentContext({
                    docker: options.docker,
                    ...(options.shellEnvironment === undefined
                        ? {}
                        : { environment: options.shellEnvironment }),
                    permissionMode: "read_only",
                    ...(options.protectedPaths === undefined
                        ? {}
                        : { protectedPaths: options.protectedPaths }),
                    sessionId: `${options.sessionId ?? options.agentId ?? "standalone"}:auto-reviewer`,
                });
    if (nativeProvider instanceof Executor) nativeProvider.selectProvider(providerId);
    const provider = routeProviderThroughGym(nativeProvider, env, options.onAccountUsage);
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (model === undefined) {
        throw new Error(`Unknown model '${modelId}' for provider '${provider.id}'`);
    }
    const usesOfficialCodexBedrockPrompt =
        provider.type === "bedrock" && model.id.startsWith("openai/");
    const agentOptions: AgentOptions = {
        ...(options.appendSystemPrompt !== undefined
            ? { appendSystemPrompt: options.appendSystemPrompt }
            : {}),
        provider,
        createPermissionReviewAgent: () =>
            createPermissionReviewSideAgent({
                context: createPermissionReviewContext(),
                id: `${agentId}:auto-reviewer`,
                model: provider.reviewerModelFor?.(model) ?? provider.reviewerModel ?? model,
                provider,
                readSecurityPolicy: async () => {
                    const [globalPolicy, projectPolicy] = await Promise.all([
                        readGlobalSecurityMd(getGlobalSecurityMdPath(env)),
                        readProjectSecurityMd(context.fs),
                    ]);
                    const policies = [
                        ...(globalPolicy === undefined
                            ? []
                            : [`## Global SECURITY.md\n\n${globalPolicy}`]),
                        ...(projectPolicy === undefined
                            ? []
                            : [`## Project AGENTS_SECURITY.md\n\n${projectPolicy}`]),
                    ];
                    return policies.length === 0 ? undefined : policies.join("\n\n");
                },
                ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
                tools: [],
            }),
        modelId,
        context,
        id: agentId,
        readGlobalInstructions: () => readGlobalAgentsMd(getGlobalAgentsMdPath(env)),
        ...(options.instructions !== undefined
            ? { instructions: options.instructions }
            : provider.type === "claude" || usesOfficialCodexBedrockPrompt
              ? {}
              : { instructions: createDefaultInstructions(runtimeCwd) }),
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.messages !== undefined ? { messages: options.messages } : {}),
        ...(options.contextMessages !== undefined
            ? { contextMessages: options.contextMessages }
            : {}),
        ...(options.startDate !== undefined ? { startDate: options.startDate } : {}),
        traceSessionId: options.sessionId ?? agentId,
        tools: [],
        printToConsole: false,
    };
    if (options.effort !== undefined) {
        agentOptions.effort = options.effort;
    }
    if (options.serviceTier !== undefined) {
        agentOptions.serviceTier = options.serviceTier;
    }

    return {
        agent: new Agent(agentOptions),
        context,
        cwd: runtimeCwd,
        processManager,
        executor: provider,
    };
}
