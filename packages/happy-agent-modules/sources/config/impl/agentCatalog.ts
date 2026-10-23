import { stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import {
    AnthropicProvider,
    type AnthropicBedrockTransport,
    BedrockAwsCredential,
    BedrockBearerTokenCredential,
    ClaudeApiKeyCredential,
    ClaudeAuthTokenCredential,
    ClaudeCodeCredential,
    ClaudeOAuthCredential,
    CodexApiKeyCredential,
    CodexProvider,
    CodexSessionCredential,
    GrokApiKeyCredential,
    GrokProvider,
    GrokSessionCredential,
    KimiProvider,
    GlmProvider,
    OpenAICompatibleProvider,
    type ForeignAgentModel,
    providerModelFamily,
    loadCodexCredential,
    resolveClaudeCodeExecutablePath,
    type BaseProvider,
    type ProviderModelCompatibilityType,
    type ProviderUsage,
} from "@slopus/happy-providers";
import type { HappyAgentConfigValues, HappyAgentConfiguration } from "../ConfigModule.js";
import { RoundRobinRouterProvider } from "./RoundRobinRouterProvider.js";
import {
    createForeignAgentProvider,
    foreignAgentRouteForModel,
    foreignAgentRoutes,
    happyHarnessAccepts,
    isForeignAgentProvider,
    type ForeignAgentConfiguredProvider,
} from "./createForeignAgentProvider.js";
import { foreignAgentModels } from "./foreignAgentModels.js";
import { CredentialDiagnosticSources } from "./credentialDiagnosticSanitizer.js";
import type { ProviderCredentialFailures } from "./ProviderCredentialFailures.js";
import { ProviderCredentialsUnavailableError } from "./ProviderCredentialsUnavailableError.js";
import type { ProviderExecutionObservations } from "./ProviderExecutionObservations.js";
import { observeProviderExecution } from "./observeProviderExecution.js";
import { resolveDefaultNodeName } from "./resolveDefaultNodeName.js";
import { openAICompatibleApiKey, openAICompatibleModels } from "./openAICompatibleModels.js";

type ConfiguredProvider = HappyAgentConfigValues["providers"][string];
type ConcreteConfiguredProvider = Exclude<ConfiguredProvider, { readonly type: "smart" }>;

/** Provider-facing context limits that are not part of Agent Base's routing identity. */
export interface AgentModelContext {
    readonly contextWindow: number;
    readonly autoCompactWindow: number;
}

type CatalogAgentModel = AgentModel & AgentModelContext;

export interface SmartProviderModelRoute {
    readonly candidates: readonly string[];
    readonly model: CatalogAgentModel;
    readonly region?: string;
}

export interface SmartProviderRoute {
    readonly models: readonly SmartProviderModelRoute[];
    readonly type: ProviderModelCompatibilityType;
}

/** One provider/model route in the complete catalog, whether or not configuration enables it. */
export type ConfiguredAgentModel = AgentModel & {
    readonly autoCompactWindow: number | null;
    readonly contextWindow: number | null;
    readonly enabled: boolean;
};

/**
 * Claude Code's own default compacts just under the full 1M window, but the Claude Code team
 * recommends 400k as the compromise between task depth and context pollution, and measured
 * sessions show 300k to 400k halving re-read tokens at the same wall-clock time while Opus
 * starts degrading on task-related context beyond that range. See the commit that set this.
 */
const CLAUDE_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_AUTO_COMPACT_WINDOW = 400_000;

const MODEL_CONTEXTS: Readonly<Record<string, AgentModelContext>> = Object.freeze({
    "moonshotai/kimi-k3": Object.freeze({
        contextWindow: 1_000_000,
        autoCompactWindow: 850_000,
    }),
    "zai/glm-5.3": Object.freeze({
        contextWindow: 1_000_000,
        autoCompactWindow: 850_000,
    }),
    "anthropic/fable-5-1": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/fable-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/opus-4-8": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/opus-5-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/opus-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/sonnet-5-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/haiku-5-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/sonnet-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "openai/gpt-5.4": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-6.1-sol": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-6-astra": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-6-sol": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-6-luna": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-5.6-luna": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-5.6-sol": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-5.6-terra": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "xai/grok-4.5": Object.freeze({
        contextWindow: 500_000,
        autoCompactWindow: 450_000,
    }),
    "xai/grok-4.6": Object.freeze({
        contextWindow: 500_000,
        autoCompactWindow: 450_000,
    }),
    "xai/grok-4.7": Object.freeze({
        contextWindow: 500_000,
        autoCompactWindow: 450_000,
    }),
    "xai/grok-build": Object.freeze({
        contextWindow: 500_000,
        autoCompactWindow: 450_000,
    }),
    "xai/grok-composer-2.5-fast": Object.freeze({
        contextWindow: 200_000,
        autoCompactWindow: 180_000,
    }),
});

const EVERY_EFFORT: AgentModel["effortLevels"] = ["off", "low", "medium", "high", "xhigh", "max"];
const ALL_BUT_OFF: AgentModel["effortLevels"] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The curated catalog. Happy Agent never asks a vendor which models exist; the list is source, and a
 * configured provider entry decides which of these its own key serves.
 */
const CATALOG: readonly CatalogAgentModel[] = [
    model("codex", "openai/gpt-6.1-sol", "GPT-6.1 Sol", ALL_BUT_OFF, "high", ["priority"]),
    model("codex", "openai/gpt-6-astra", "GPT-6 Astra", ALL_BUT_OFF, "high", ["priority"]),
    model("codex", "openai/gpt-6-sol", "GPT-6 Sol", ALL_BUT_OFF, "high", ["priority"]),
    model("codex", "openai/gpt-6-luna", "GPT-6 Luna", ALL_BUT_OFF, "medium", ["priority"]),
    model("codex", "openai/gpt-5.6-sol", "GPT-5.6 Sol", ALL_BUT_OFF, "medium", ["priority"]),
    model("codex", "openai/gpt-5.6-terra", "GPT-5.6 Terra", EVERY_EFFORT, "medium", ["priority"]),
    model("codex", "openai/gpt-5.6-luna", "GPT-5.6 Luna", EVERY_EFFORT, "medium", ["priority"]),
    // Opus 5.5 and Sonnet 5.5 always think: the API rejects disabled thinking, so "off" is not
    // offered.
    model("claude", "anthropic/opus-5-5", "Opus 5.5 1M", ALL_BUT_OFF),
    model("claude", "anthropic/opus-5", "Opus 5 1M"),
    model("claude", "anthropic/sonnet-5-5", "Sonnet 5.5", ALL_BUT_OFF),
    model("claude", "anthropic/haiku-5-5", "Haiku 5.5", ALL_BUT_OFF),
    model("claude", "anthropic/sonnet-5", "Sonnet 5"),
    model("claude", "anthropic/fable-5-1", "Fable 5.1"),
    model("claude", "anthropic/fable-5", "Fable 5"),
    model("claude", "anthropic/opus-4-8", "Opus 4.8 1M"),
    model("grok", "xai/grok-4.7", "Grok 4.7", ["low", "medium", "high", "xhigh"], "high"),
    model("grok", "xai/grok-4.6", "Grok 4.6", ["low", "medium", "high", "xhigh"], "high"),
    model("grok", "xai/grok-build", "Grok Build", ["medium"]),
    model("grok", "xai/grok-4.5", "Grok 4.5", ["low", "medium", "high"], "high"),
    model("grok", "xai/grok-composer-2.5-fast", "Composer 2.5", ["off"], "off"),
];

/**
 * The native models AWS documents on Bedrock. A model added to its native catalog stays off Bedrock
 * until AWS serves it and its Bedrock route is known.
 */
const BEDROCK_RESOLD_MODEL_IDS: ReadonlySet<string> = new Set([
    "openai/gpt-6-astra",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "anthropic/opus-5-5",
    "anthropic/opus-5",
    "anthropic/sonnet-5-5",
    "anthropic/sonnet-5",
    "anthropic/fable-5-1",
    "anthropic/fable-5",
    "anthropic/opus-4-8",
]);

/** Bedrock resells a documented subset and adds models supported only through AWS. */
const BEDROCK_CATALOG: readonly CatalogAgentModel[] = [
    ...CATALOG.filter((candidate) => BEDROCK_RESOLD_MODEL_IDS.has(candidate.id)).map(
        (candidate) => {
            const { serviceTiers: _unsupported, ...rest } = candidate;
            return { ...rest, providerId: "bedrock" };
        },
    ),
    model("bedrock", "openai/gpt-5.4", "GPT-5.4", ["off", "low", "medium", "high", "xhigh"]),
    model("bedrock", "moonshotai/kimi-k3", "Kimi K3", ["low", "high", "max"], "high"),
    model("bedrock", "zai/glm-5.3", "GLM 5.3", ["low", "high", "max"], "max"),
];

/**
 * Every model the configuration actually enables, with the configured default first.
 *
 * The order matters: the first entry is what a session gets when it names nothing. A configured
 * default that no enabled provider serves — a removed model, a disabled provider, or a hostile
 * project file — must not keep the daemon down: the first available model stands in and the
 * ignored value is reported through `onIgnored` for the caller to surface.
 */
export function agentModels(
    configuration: HappyAgentConfiguration,
    onIgnored?: (message: string) => void,
    isProviderEnabled?: (id: string) => boolean,
    isAccountEnabled?: (id: string) => boolean,
): readonly CatalogAgentModel[] {
    const values = configuration.values;
    const hidden = (candidate: { providerId: string }) =>
        values.providers[candidate.providerId]?.hidden === true;
    const enabled = agentModelCatalog(configuration, isProviderEnabled, isAccountEnabled)
        .filter((candidate) => candidate.enabled)
        .map(({ enabled: _enabled, ...candidate }) => candidate as CatalogAgentModel);
    // Hidden routes stay valid for existing sessions but never stand in as the default.
    const available = [
        ...enabled.filter((candidate) => !hidden(candidate)),
        ...enabled.filter(hidden),
    ];
    const wantedModel = values.defaults.modelId;
    const wantedProvider = values.defaults.providerId;
    const chosen =
        available.find(
            (candidate) =>
                candidate.id === wantedModel &&
                (wantedProvider === undefined
                    ? !hidden(candidate)
                    : candidate.providerId === wantedProvider),
        ) ?? undefined;
    if (chosen === undefined) {
        const standIn = available[0];
        if (standIn !== undefined) {
            onIgnored?.(
                `The configured default model "${wantedModel}" is not served by any enabled provider, so "${standIn.id}" stands in.`,
            );
        }
        return available;
    }
    const effort = values.defaults.effort;
    const effortSupported =
        effort === undefined || chosen.effortLevels.includes(effort as AgentModel["defaultEffort"]);
    if (!effortSupported) {
        onIgnored?.(
            `The configured effort "${effort ?? ""}" is not supported by model "${chosen.id}", so its own default effort stands in.`,
        );
    }
    const first =
        effort === undefined || !effortSupported
            ? chosen
            : { ...chosen, defaultEffort: effort as AgentModel["defaultEffort"] };
    return [first, ...available.filter((candidate) => candidate !== chosen)];
}

/**
 * Every curated model for every configured provider, including disabled and filtered routes.
 *
 * Catalog responses must not be inferred from models that happened to run: an excluded model is
 * still one the daemon knows, and its false `enabled` value is the fact clients need to display.
 */
export function agentModelCatalog(
    configuration: HappyAgentConfiguration,
    isProviderEnabled: (id: string) => boolean = (id) =>
        configuration.values.providers[id]?.enabled !== false,
    isAccountEnabled: (id: string) => boolean = (id) =>
        configuration.values.providers[id]?.enabled !== false,
): readonly ConfiguredAgentModel[] {
    const concreteModels: ConfiguredAgentModel[] = [];
    const values = configuration.values;
    for (const [id, provider] of Object.entries(values.providers)) {
        if (provider.type === "smart") continue;
        for (const candidate of providerCatalog(configuration, id, provider)) {
            if (!modelAvailableOnProvider(provider, candidate.id)) continue;
            const enabled =
                isProviderEnabled(id) &&
                provider.includeModels?.includes(candidate.id) !== false &&
                provider.excludeModels?.includes(candidate.id) !== true;
            concreteModels.push({ ...candidate, enabled, providerId: id });
        }
    }
    const models = [...concreteModels];
    for (const [id, provider] of Object.entries(values.providers)) {
        if (provider.type !== "smart") continue;
        const route = smartProviderRoute(configuration, id, concreteModels);
        if (route === undefined) continue;
        for (const routed of route.models) {
            const enabled =
                isProviderEnabled(id) &&
                provider.includeModels?.includes(routed.model.id) !== false &&
                provider.excludeModels?.includes(routed.model.id) !== true &&
                routed.candidates.some((candidate) => isAccountEnabled(candidate));
            models.push({ ...routed.model, enabled, providerId: id });
        }
    }
    return models;
}

/** Resolve one smart provider into exact-model routes, silently dropping invalid members. */
export function smartProviderRoute(
    configuration: HappyAgentConfiguration,
    providerId: string,
    catalog: readonly ConfiguredAgentModel[] = concreteAgentModelCatalog(configuration),
): SmartProviderRoute | undefined {
    const smart = configuration.values.providers[providerId];
    if (smart?.type !== "smart") return undefined;
    // A foreign agent's conversation lives in the account that started it, so rotating accounts
    // would replay the whole transcript on every switch; smart providers pool Happy's own only.
    const concrete = smart.providers
        .map((id) => [id, configuration.values.providers[id]] as const)
        .filter(
            (
                entry,
            ): entry is readonly [
                string,
                Exclude<
                    ConfiguredProvider,
                    { readonly type: "smart" } | ForeignAgentConfiguredProvider
                >,
            ] =>
                entry[1] !== undefined &&
                entry[1].type !== "smart" &&
                !isForeignAgentProvider(entry[1]),
        );
    const type = concrete[0]?.[1].type;
    if (type === undefined) return undefined;
    const compatibleIds = new Set(
        concrete.filter(([, provider]) => provider.type === type).map(([id]) => id),
    );
    const orderedModels: string[] = [];
    const routes = new Map<
        string,
        { candidates: string[]; model: CatalogAgentModel; region?: string }
    >();
    for (const candidateId of smart.providers) {
        if (!compatibleIds.has(candidateId)) continue;
        for (const entry of catalog) {
            if (entry.providerId !== candidateId) continue;
            // Claude Code and Codex CLI models stay with the account that started them.
            if (providerModelFamily(entry.id) === "foreign") continue;
            const candidateProvider = configuration.values.providers[candidateId];
            if (
                candidateProvider === undefined ||
                candidateProvider.type === "smart" ||
                candidateProvider.includeModels?.includes(entry.id) === false ||
                candidateProvider.excludeModels?.includes(entry.id) === true
            ) {
                continue;
            }
            let route = routes.get(entry.id);
            const region =
                type === "bedrock"
                    ? bedrockModelRegion(configuration, candidateId, entry.id)
                    : undefined;
            if (route === undefined) {
                const { enabled: _enabled, ...model } = entry;
                route = {
                    candidates: [],
                    model: model as CatalogAgentModel,
                    ...(region === undefined ? {} : { region }),
                };
                routes.set(entry.id, route);
                orderedModels.push(entry.id);
            }
            if (
                type === "bedrock" &&
                !sameBedrockRegion(route.region, region, route.candidates.length)
            ) {
                continue;
            }
            route.candidates.push(candidateId);
        }
    }
    return {
        models: orderedModels
            .map((modelId) => routes.get(modelId)!)
            .filter((route) => route.candidates.length > 0),
        type,
    };
}

/**
 * One foreign agent model in the catalog. A foreign agent compacts its own context, so Happy's
 * automatic compaction is set at the full window rather than ahead of it.
 */
function foreignCatalogModel(candidate: ForeignAgentModel): CatalogAgentModel {
    return {
        providerId: "foreign",
        id: candidate.id,
        name: candidate.name,
        effortLevels: candidate.effortLevels,
        defaultEffort: candidate.defaultEffort,
        contextWindow: candidate.contextWindow,
        autoCompactWindow: candidate.contextWindow,
    };
}

/**
 * The models one configured account can serve: Happy's curated list when Happy's own loop runs on
 * it, then the models of every foreign agent running on it, as each agent reports them.
 */
function providerCatalog(
    configuration: HappyAgentConfiguration,
    id: string,
    provider: ConcreteConfiguredProvider,
): readonly CatalogAgentModel[] {
    const native = !happyHarnessAccepts(configuration, id, provider)
        ? []
        : provider.type === "bedrock"
          ? BEDROCK_CATALOG
          : provider.type === "openai_compatible"
            ? openAICompatibleModels(configuration.paths.agentHome, id, provider).map(
                  (candidate): CatalogAgentModel => ({
                      providerId: id,
                      id: candidate.id,
                      name: candidate.name,
                      effortLevels: candidate.efforts ?? [candidate.defaultEffort],
                      defaultEffort: candidate.defaultEffort,
                      contextWindow: candidate.contextWindow,
                      autoCompactWindow: candidate.autoCompactWindow,
                  }),
              )
            : CATALOG.filter((candidate) => candidate.providerId === provider.type);
    const foreign = foreignAgentRoutes(configuration)
        .filter((route) => route.providerId === id)
        .flatMap((route) =>
            foreignAgentModels(configuration.paths.agentHome, route).map(foreignCatalogModel),
        );
    return [...native, ...foreign];
}

/**
 * Context limits for one foreign agent route, from the models its agent reports. Unknown when no
 * foreign agent serves the model on that provider.
 */
export function foreignAgentModelContext(
    configuration: HappyAgentConfiguration,
    providerId: string,
    modelId: string,
): AgentModelContext | undefined {
    const route = foreignAgentRouteForModel(configuration, providerId, modelId);
    if (route === undefined) return undefined;
    const model = foreignAgentModels(configuration.paths.agentHome, route).find(
        (candidate) => candidate.id === modelId,
    );
    return model === undefined
        ? undefined
        : { contextWindow: model.contextWindow, autoCompactWindow: model.contextWindow };
}

/**
 * Context limits for one model on an OpenAI-compatible account, or on a smart provider pooling
 * them. Unknown for every other route.
 */
export function openAICompatibleModelContext(
    configuration: HappyAgentConfiguration,
    providerId: string,
    modelId: string,
): AgentModelContext | undefined {
    const provider = configuration.values.providers[providerId];
    if (provider?.type === "smart") {
        const candidate = smartProviderRoute(configuration, providerId)?.models.find(
            (route) => route.model.id === modelId,
        )?.candidates[0];
        return candidate === undefined
            ? undefined
            : openAICompatibleModelContext(configuration, candidate, modelId);
    }
    if (provider?.type !== "openai_compatible") return undefined;
    const model = openAICompatibleModels(configuration.paths.agentHome, providerId, provider).find(
        (candidate) => candidate.id === modelId,
    );
    return model === undefined
        ? undefined
        : { contextWindow: model.contextWindow, autoCompactWindow: model.autoCompactWindow };
}

/** Context limits for one enabled provider/model route, when the curated catalog knows them. */
export function agentModelContext(modelId: string): AgentModelContext | undefined {
    const context = MODEL_CONTEXTS[modelId];
    return context === undefined
        ? undefined
        : { contextWindow: context.contextWindow, autoCompactWindow: context.autoCompactWindow };
}

/**
 * One registry holding every configured provider, each constructing its client on first use so a
 * credential is read when a session needs it rather than at startup.
 */
export function agentProviders(
    configuration: HappyAgentConfiguration,
    onAccountUsage?: (usage: ProviderUsage) => void,
    isProviderEnabled: (providerId: string) => boolean = () => true,
    providerSignal: (providerId: string) => AbortSignal | undefined = () => undefined,
    concreteProviders?: AgentProviders,
    observations?: ProviderExecutionObservations,
    credentialFailures?: ProviderCredentialFailures,
): AgentProviders {
    const providers = new AgentProviders();
    const retryLimit = configuration.values.settings.inferenceMaxRetries;
    let hostName: Promise<string> | undefined;
    if (concreteProviders !== undefined) {
        for (const id of concreteProviders.ids) {
            if (configuration.values.providers[id]?.type === "smart") continue;
            const type = concreteProviders.typeOf(id);
            if (type === null) continue;
            providers.add(
                id,
                async ({ model }) => {
                    const provider = await concreteProviders.resolve(id, model);
                    if (provider === null) throw new Error(`Provider "${id}" is unavailable.`);
                    return observations === undefined
                        ? provider
                        : observeProviderExecution(provider, observations, id, null);
                },
                type,
            );
        }
    }
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.type === "smart" || concreteProviders !== undefined) continue;
        providers.add(
            id,
            async ({ model: selected }) => {
                hostName ??=
                    configuration.values.node.name === undefined
                        ? resolveDefaultNodeName()
                        : Promise.resolve(configuration.values.node.name);
                const sources = new CredentialDiagnosticSources(id, [hostname(), await hostName]);
                try {
                    const foreign = foreignAgentRouteForModel(configuration, id, selected);
                    if (foreign === undefined && isForeignAgentProvider(provider)) {
                        throw new Error(`Provider "${id}" does not serve "${selected ?? ""}".`);
                    }
                    const concrete =
                        foreign !== undefined
                            ? createForeignAgentProvider(foreign, configuration.paths.agentHome)
                            : await createProvider(
                                  id,
                                  provider as Exclude<
                                      ConcreteConfiguredProvider,
                                      ForeignAgentConfiguredProvider
                                  >,
                                  selected,
                                  retryLimit,
                                  configuration.paths.claudeWorkingDirectory,
                                  configuration.paths.agentHome,
                                  sources,
                                  onAccountUsage,
                              );
                    credentialFailures?.clear(id);
                    const diagnostics = sources.snapshot();
                    const protectedProvider = diagnostics.protect(concrete);
                    return observations === undefined
                        ? protectedProvider
                        : observeProviderExecution(
                              protectedProvider,
                              observations,
                              id,
                              sources.credentialSource,
                              sources.recovery,
                              provider.type,
                              diagnostics,
                              sources.signIn,
                          );
                } catch (error) {
                    // Discovery may throw before a credential exists. Only inputs already passed
                    // to that discovery can be removed; no after-the-fact source inference.
                    const safe = sources.snapshot().error(error);
                    if (safe instanceof ProviderCredentialsUnavailableError)
                        credentialFailures?.record(safe);
                    throw safe;
                }
            },
            isForeignAgentProvider(provider) ? "foreign" : provider.type,
        );
    }
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.type !== "smart") continue;
        const route = smartProviderRoute(configuration, id);
        if (route === undefined || route.models.length === 0) continue;
        const cache = new Map<string, RoundRobinRouterProvider>();
        providers.add(
            id,
            ({ model: selected }) => {
                const routed =
                    route.models.find((candidate) => candidate.model.id === selected) ??
                    (selected === undefined ? route.models[0] : undefined);
                if (routed === undefined) {
                    throw new Error(
                        `Smart provider "${id}" has no compatible route for model "${selected ?? ""}".`,
                    );
                }
                let resolved = cache.get(routed.model.id);
                if (resolved === undefined) {
                    resolved = new RoundRobinRouterProvider({
                        candidates: routed.candidates.map((providerId) => ({ providerId })),
                        isEnabled: isProviderEnabled,
                        model: routed.model.id,
                        ...(routed.region === undefined ? {} : { region: routed.region }),
                        resolve: async (providerId, model) =>
                            await providers.resolve(providerId, model),
                        signal: providerSignal,
                    });
                    cache.set(routed.model.id, resolved);
                }
                return resolved;
            },
            route.type,
        );
    }
    return providers;
}

function concreteAgentModelCatalog(
    configuration: HappyAgentConfiguration,
): readonly ConfiguredAgentModel[] {
    const models: ConfiguredAgentModel[] = [];
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.type === "smart") continue;
        for (const candidate of providerCatalog(configuration, id, provider)) {
            if (!modelAvailableOnProvider(provider, candidate.id)) continue;
            models.push({ ...candidate, enabled: true, providerId: id });
        }
    }
    return models;
}

/**
 * The only regions where AWS's model cards list Mantle in-region support for these models.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html
 */
const BEDROCK_MANTLE_REGIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "anthropic/sonnet-5-5": ["us-gov-west-1"],
    "anthropic/sonnet-5": [
        "us-east-1",
        "us-gov-west-1",
        "eu-north-1",
        "eu-west-1",
        "ap-southeast-4",
    ],
});

/**
 * A model whose Mantle route AWS does not serve in the configured region is not offered there.
 * Runtime inference profiles have separate availability; never silently switch transport/region.
 */
function modelAvailableOnProvider(provider: ConcreteConfiguredProvider, modelId: string): boolean {
    if (provider.type !== "bedrock") return true;
    if (
        (modelId === "moonshotai/kimi-k3" || modelId === "zai/glm-5.3") &&
        provider.modelOverrides?.[modelId]?.transport === "mantle"
    )
        return false;
    const mantleRegions = BEDROCK_MANTLE_REGIONS[modelId];
    if (mantleRegions === undefined) return true;
    if (resolveAnthropicBedrockTransport(provider, modelId) !== "mantle") return true;
    const region = provider.modelOverrides?.[modelId]?.region ?? provider.region ?? "us-east-1";
    return mantleRegions.includes(region);
}

function bedrockModelRegion(
    configuration: HappyAgentConfiguration,
    providerId: string,
    modelId: string,
): string | undefined {
    const provider = configuration.values.providers[providerId];
    if (provider?.type !== "bedrock") return undefined;
    return provider.modelOverrides?.[modelId]?.region ?? provider.region;
}

function sameBedrockRegion(
    anchor: string | undefined,
    candidate: string | undefined,
    existingCandidates: number,
): boolean {
    if (existingCandidates === 0) return true;
    return anchor !== undefined && candidate !== undefined && anchor === candidate;
}

async function createProvider(
    id: string,
    provider: Exclude<ConcreteConfiguredProvider, ForeignAgentConfiguredProvider>,
    selectedModel: string | undefined,
    retryLimit: number | undefined,
    claudeWorkingDirectory: string,
    agentHome: string,
    sources: CredentialDiagnosticSources,
    onAccountUsage?: (usage: ProviderUsage) => void,
): Promise<BaseProvider> {
    // Credential isolation means this provider may use only what its own configuration names.
    // Without it, each vendor's ambient discovery — its CLI's own login files and environment —
    // is allowed to answer, which is how Happy Agent reuses a Codex or Claude Code sign-in.
    const ambient = provider.credentialIsolation !== true;
    const retries = retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit };
    const configured = async <T>(
        key: string,
        value: string | undefined,
        fromValue: (value: string) => Promise<T | null>,
        discover: () => Promise<T | null>,
    ): Promise<T | null> => {
        sources.configured(key, value);
        return value === undefined ? (ambient ? await discover() : null) : await fromValue(value);
    };

    if (provider.type === "codex") {
        const environment = { ...process.env };
        sources.configured("api_key", provider.apiKey);
        if (!provider.apiKey?.trim()) {
            sources.configured("auth_file", provider.authFile);
            if (provider.authFile?.trim()) sources.path(provider.authFile);
            else if (ambient) {
                const directory = environment.CODEX_HOME?.trim();
                sources.environment("CODEX_HOME", directory);
                sources.path(directory || join(homedir(), ".codex"));
                sources.path(
                    join(directory || homedir(), directory ? "auth.json" : ".codex/auth.json"),
                );
            }
        }
        const credential = ambient
            ? await loadCodexCredential({
                  env: environment,
                  ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                  ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
              })
            : ((provider.apiKey === undefined
                  ? null
                  : await CodexApiKeyCredential.tryLoad({ apiKey: provider.apiKey })) ??
              (provider.authFile === undefined
                  ? null
                  : await CodexSessionCredential.tryLoad({ authFile: provider.authFile })));
        // Codex's own default sign-in, the one its login command repairs, was the source consulted.
        const defaultCodexLogin =
            ambient &&
            provider.apiKey === undefined &&
            provider.authFile === undefined &&
            !environment.CODEX_HOME?.trim();
        if (ambient && !provider.apiKey?.trim() && credential instanceof CodexApiKeyCredential)
            sources.environment("OPENAI_API_KEY", environment.OPENAI_API_KEY);
        if (credential instanceof CodexSessionCredential) {
            sources.path(credential.authFile);
            sources.add(credential.credential.accountId);
            sources.add(credential.credential.accessToken);
        }
        if (credential !== null) {
            if (provider.apiKey?.trim())
                sources.selected("configuration", `providers.${id}.api_key`);
            else if (
                credential instanceof CodexApiKeyCredential &&
                environment.OPENAI_API_KEY?.trim()
            )
                sources.selected("environment", "OPENAI_API_KEY");
            else
                sources.selected(
                    "native_login",
                    "Codex sign-in",
                    defaultCodexLogin ? "codex" : undefined,
                );
        }
        return new CodexProvider({
            credential: required(credential, id, "codex", defaultCodexLogin),
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
            ...(provider.transport === undefined || provider.transport === "auto"
                ? {}
                : {
                      transport:
                          provider.transport === "websocket-cached"
                              ? ("websocket" as const)
                              : provider.transport,
                  }),
            // A ChatGPT login is measured by every response it answers, exactly like Claude's
            // limiter; the provider stays silent for API-key traffic, which has no such account.
            ...(onAccountUsage === undefined
                ? {}
                : {
                      onAccountUsage: (usage: ProviderUsage) =>
                          onAccountUsage({ ...usage, providerId: id }),
                  }),
            ...retries,
        });
    }

    if (provider.type === "claude") {
        const credential =
            (await configured(
                "oauth_token",
                provider.oauthToken,
                async (oauthToken) => await ClaudeOAuthCredential.tryLoad({ oauthToken }),
                async () => {
                    sources.environment(
                        "CLAUDE_CODE_OAUTH_TOKEN",
                        process.env.CLAUDE_CODE_OAUTH_TOKEN,
                    );
                    return await ClaudeOAuthCredential.tryLoad({});
                },
            )) ??
            (await configured(
                "api_key",
                provider.apiKey,
                async (apiKey) => await ClaudeApiKeyCredential.tryLoad({ apiKey }),
                async () => {
                    sources.environment("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
                    return await ClaudeApiKeyCredential.tryLoad({});
                },
            )) ??
            (await configured(
                "auth_token",
                provider.authToken,
                async (authToken) => await ClaudeAuthTokenCredential.tryLoad({ authToken }),
                async () => {
                    sources.environment("ANTHROPIC_AUTH_TOKEN", process.env.ANTHROPIC_AUTH_TOKEN);
                    return await ClaudeAuthTokenCredential.tryLoad({});
                },
            )) ??
            (await configured(
                "config_dir",
                provider.configDir,
                async (configDir) => {
                    sources.path(configDir);
                    return await ClaudeCodeCredential.tryLoad({ configDir });
                },
                async () => {
                    const directory = process.env.CLAUDE_CONFIG_DIR?.trim();
                    sources.environment("CLAUDE_CONFIG_DIR", directory);
                    sources.path(directory || join(homedir(), ".claude"));
                    return await ClaudeCodeCredential.tryLoad({});
                },
            ));
        if (credential instanceof ClaudeCodeCredential)
            sources.path(credential.configDir ?? join(homedir(), ".claude"));
        if (credential instanceof ClaudeCodeCredential) {
            sources.selected(
                "native_login",
                "Claude Code sign-in",
                provider.configDir === undefined && !process.env.CLAUDE_CONFIG_DIR?.trim()
                    ? "claude"
                    : undefined,
            );
        } else if (credential !== null) {
            const [key, value, variable] =
                credential instanceof ClaudeOAuthCredential
                    ? ["oauth_token", provider.oauthToken, "CLAUDE_CODE_OAUTH_TOKEN"]
                    : credential instanceof ClaudeApiKeyCredential
                      ? ["api_key", provider.apiKey, "ANTHROPIC_API_KEY"]
                      : ["auth_token", provider.authToken, "ANTHROPIC_AUTH_TOKEN"];
            sources.selected(
                value === undefined ? "environment" : "configuration",
                value === undefined ? variable! : `providers.${id}.${key}`,
            );
        }
        await ensureClaudeWorkingDirectory(claudeWorkingDirectory);
        return new AnthropicProvider({
            credential: required(
                credential,
                id,
                "claude",
                ambient &&
                    provider.oauthToken === undefined &&
                    provider.apiKey === undefined &&
                    provider.authToken === undefined &&
                    provider.configDir === undefined &&
                    !process.env.CLAUDE_CONFIG_DIR?.trim(),
            ),
            cwd: claudeWorkingDirectory,
            // Bun cannot use the SDK's runtime require.resolve from its compiled filesystem.
            // The standalone build adapts this resolver to materialize its embedded executable.
            pathToClaudeCodeExecutable: provider.executable ?? resolveClaudeCodeExecutablePath(),
            // Every Claude response already carries the account's own limiter reading, so the
            // account is measured by the work it does. The vendor names the reading after its own
            // vendor key; this account is whichever configured provider actually spent the tokens.
            ...(onAccountUsage === undefined
                ? {}
                : {
                      onAccountUsage: (usage: ProviderUsage) =>
                          onAccountUsage({ ...usage, providerId: id }),
                  }),
            ...retries,
        });
    }

    if (provider.type === "grok") {
        // Grok reads its key from the environment unless isolation forbids it. Ambient providers
        // may also reuse the default Grok CLI session; isolated ones must name their auth file.
        const env = ambient ? { ...process.env } : {};
        const withEnv = <T extends object>(input: T) => ({ ...input, env });
        // Grok's own default sign-in, the one its login command repairs, was the source consulted.
        const defaultGrokLogin =
            ambient &&
            provider.apiKey === undefined &&
            provider.authFile === undefined &&
            !env.GROK_HOME?.trim();
        sources.configured("api_key", provider.apiKey);
        if (!provider.apiKey?.trim()) {
            sources.environment("XAI_API_KEY", env.XAI_API_KEY);
            if (!env.XAI_API_KEY?.trim()) {
                sources.configured("auth_file", provider.authFile);
                if (provider.authFile?.trim()) sources.path(provider.authFile);
                else {
                    const directory = env.GROK_HOME?.trim();
                    sources.environment("GROK_HOME", directory);
                    sources.path(directory || join(homedir(), ".grok"));
                    sources.path(
                        join(directory || homedir(), directory ? "auth.json" : ".grok/auth.json"),
                    );
                }
            }
        }
        const credential =
            (await GrokApiKeyCredential.tryLoad(
                withEnv({
                    ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                    ...(provider.authFile === undefined || provider.apiKey !== undefined
                        ? {}
                        : { authFile: provider.authFile }),
                }),
            )) ??
            (ambient || provider.authFile !== undefined
                ? await GrokSessionCredential.tryLoad(
                      withEnv(
                          provider.authFile === undefined ? {} : { authFile: provider.authFile },
                      ),
                  )
                : null);
        if (credential !== null) {
            if (provider.apiKey?.trim())
                sources.selected("configuration", `providers.${id}.api_key`);
            else if (env.XAI_API_KEY?.trim()) sources.selected("environment", "XAI_API_KEY");
            else
                sources.selected(
                    "native_login",
                    "Grok sign-in",
                    defaultGrokLogin ? "grok" : undefined,
                );
        }
        return new GrokProvider({
            credential: required(credential, id, "grok", defaultGrokLogin),
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
            ...retries,
        });
    }

    if (provider.type === "openai_compatible") {
        // Only what this provider's own table names is consulted; there is no ambient login.
        sources.configured("api_key", provider.apiKey);
        sources.configured("api_key_env", provider.apiKeyEnv);
        if (provider.apiKeyEnv !== undefined)
            sources.environment(provider.apiKeyEnv, process.env[provider.apiKeyEnv]);
        const apiKey = openAICompatibleApiKey(provider);
        if (apiKey === undefined) {
            throw new ProviderCredentialsUnavailableError(id, "openai_compatible", false);
        }
        sources.selected(
            provider.apiKey === undefined ? "environment" : "configuration",
            provider.apiKey === undefined ? provider.apiKeyEnv! : `providers.${id}.api_key`,
        );
        const models = openAICompatibleModels(agentHome, id, provider);
        return new OpenAICompatibleProvider({
            apiKey,
            endpoint: provider.baseUrl,
            vendor: provider.name ?? id,
            models: models.map((candidate) => ({
                id: candidate.id,
                inputTypes: candidate.input,
                ...(candidate.efforts === undefined ? {} : { efforts: candidate.efforts }),
                ...(candidate.request === undefined ? {} : { request: candidate.request }),
            })),
            ...(selectedModel === undefined ? {} : { model: selectedModel }),
            ...(provider.request === undefined ? {} : { request: provider.request }),
            ...(provider.headers === undefined ? {} : { headers: provider.headers }),
            reasoningField:
                provider.reasoningField === undefined || provider.reasoningField === "none"
                    ? null
                    : provider.reasoningField,
            ...retries,
        });
    }

    const bearer = {
        ...(provider.bearerToken === undefined ? {} : { bearerToken: provider.bearerToken }),
        ...(provider.bearerTokenEnvVar === undefined
            ? {}
            : { bearerTokenEnvVar: provider.bearerTokenEnvVar }),
    };
    const explicitBearer =
        provider.bearerToken !== undefined || provider.bearerTokenEnvVar !== undefined;
    const explicitAws =
        provider.configFile !== undefined ||
        provider.credentialsFile !== undefined ||
        provider.profile !== undefined;
    if (explicitAws) {
        sources.configured("config_file", provider.configFile);
        sources.configured("credentials_file", provider.credentialsFile);
        sources.configured("profile", provider.profile);
        sources.path(provider.configFile);
        sources.path(provider.credentialsFile);
        sources.add(provider.profile);
    } else {
        sources.configured("bearer_token", provider.bearerToken);
        sources.configured("bearer_token_env_var", provider.bearerTokenEnvVar);
        if (
            !provider.bearerToken?.trim() &&
            (ambient || provider.bearerTokenEnvVar !== undefined)
        ) {
            const name = provider.bearerTokenEnvVar ?? "AWS_BEARER_TOKEN_BEDROCK";
            sources.environment(name, process.env[name]);
        }
    }
    const aws = {
        ...(provider.configFile === undefined ? {} : { configFilepath: provider.configFile }),
        ...(provider.credentialsFile === undefined
            ? {}
            : { credentialsFilepath: provider.credentialsFile }),
        // Naming either shared file selects its default profile instead of allowing unrelated
        // environment credentials to win the standard AWS chain.
        ...(provider.profile === undefined
            ? explicitAws
                ? { profile: "default" }
                : {}
            : { profile: provider.profile }),
    };
    const bearerCredential = explicitAws
        ? null
        : await BedrockBearerTokenCredential.tryLoad(
              ambient
                  ? bearer
                  : {
                        ...bearer,
                        env: provider.bearerTokenEnvVar === undefined ? {} : process.env,
                    },
          );
    const credential = required(
        bearerCredential ??
            (explicitAws || (ambient && !explicitBearer)
                ? await BedrockAwsCredential.tryLoad(aws)
                : null),
        id,
        "bedrock",
        false,
    );
    if (bearerCredential !== null) {
        sources.selected(
            provider.bearerToken?.trim() ? "configuration" : "environment",
            provider.bearerToken?.trim()
                ? `providers.${id}.bearer_token`
                : (provider.bearerTokenEnvVar ?? "AWS_BEARER_TOKEN_BEDROCK"),
        );
    }
    // Bedrock serves each family through that family's own wire protocol, so the selected model
    // decides which client speaks to it.
    const override =
        selectedModel === undefined ? undefined : provider.modelOverrides?.[selectedModel];
    const transport = resolveAnthropicBedrockTransport(provider, selectedModel);
    const shared = {
        credential,
        ...(override?.endpoint === undefined ? {} : { endpoint: override.endpoint }),
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        ...((override?.region ?? provider.region) === undefined
            ? {}
            : { region: override?.region ?? provider.region }),
        ...retries,
    };
    if (
        selectedModel?.startsWith("moonshotai/") === true ||
        selectedModel?.startsWith("zai/") === true
    ) {
        if (override?.transport === "mantle") {
            throw new Error(
                `${selectedModel === "moonshotai/kimi-k3" ? "Kimi K3" : "GLM 5.3"} requires Bedrock Runtime.`,
            );
        }
        return selectedModel.startsWith("moonshotai/")
            ? new KimiProvider(shared)
            : new GlmProvider(shared);
    }
    return selectedModel?.startsWith("anthropic/") === true
        ? new AnthropicProvider({
              ...shared,
              ...(transport === undefined ? {} : { transport }),
          })
        : new CodexProvider({
              ...shared,
              ...(override?.transport === undefined
                  ? {}
                  : { bedrockTransport: override.transport }),
          });
}

function resolveAnthropicBedrockTransport(
    provider: Extract<ConcreteConfiguredProvider, { readonly type: "bedrock" }>,
    model: string | undefined,
): AnthropicBedrockTransport | undefined {
    if (model?.startsWith("anthropic/") !== true) return undefined;
    // AWS documents no commercial Mantle route for Fable 5.1 or Sonnet 5.5, so both default to
    // Runtime; the others prefer Mantle.
    return (
        provider.modelOverrides?.[model]?.transport ??
        (model === "anthropic/fable-5-1" || model === "anthropic/sonnet-5-5" ? "runtime" : "mantle")
    );
}

/** The one Anthropic transport shared by every concrete route behind this selection. */
export function configuredAnthropicBedrockTransport(
    configuration: HappyAgentConfiguration,
    providerId: string,
    model: string | undefined,
): AnthropicBedrockTransport | undefined {
    if (model?.startsWith("anthropic/") !== true) return undefined;
    const provider = configuration.values.providers[providerId];
    if (provider === undefined) return undefined;
    if (provider.type === "bedrock") return resolveAnthropicBedrockTransport(provider, model);
    if (provider.type !== "smart") return undefined;

    const route = smartProviderRoute(configuration, providerId)?.models.find(
        (candidate) => candidate.model.id === model,
    );
    if (route === undefined || route.candidates.length === 0) return undefined;
    const transports = route.candidates.map((candidateId) => {
        const candidate = configuration.values.providers[candidateId];
        return candidate?.type === "bedrock"
            ? resolveAnthropicBedrockTransport(candidate, model)
            : undefined;
    });
    const first = transports[0];
    return first !== undefined && transports.every((transport) => transport === first)
        ? first
        : undefined;
}

/**
 * Creates Claude Code's private folder when it is missing. Every session resolves its provider
 * again, and securing a folder on Windows starts PowerShell, so an existing folder is left alone.
 */
async function ensureClaudeWorkingDirectory(directory: string): Promise<void> {
    const existing = await stat(directory).catch(() => undefined);
    if (existing?.isDirectory() === true) return;
    await ensurePrivateDirectory(directory);
}

function required<T>(
    credential: T | null,
    id: string,
    vendor: ConstructorParameters<typeof ProviderCredentialsUnavailableError>[1],
    defaultNativeLogin: boolean,
): T {
    if (credential === null) {
        throw new ProviderCredentialsUnavailableError(id, vendor, defaultNativeLogin);
    }
    return credential;
}

function model(
    providerId: string,
    id: string,
    name: string,
    effortLevels: AgentModel["effortLevels"] = EVERY_EFFORT,
    defaultEffort: AgentModel["defaultEffort"] = "medium",
    serviceTiers?: AgentModel["serviceTiers"],
): CatalogAgentModel {
    const context = MODEL_CONTEXTS[id];
    if (context === undefined) {
        throw new Error(`Model "${id}" has no configured context window.`);
    }
    return {
        ...context,
        defaultEffort,
        effortLevels,
        id,
        name,
        providerId,
        ...(serviceTiers === undefined ? {} : { serviceTiers }),
    };
}
