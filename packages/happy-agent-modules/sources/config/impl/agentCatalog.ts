import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import {
    AnthropicProvider,
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
    loadCodexCredential,
    type BaseProvider,
} from "@slopus/happy-providers";
import type { HappyAgentConfigValues, HappyAgentConfiguration } from "../ConfigModule.js";

type ConfiguredProvider = HappyAgentConfigValues["providers"][string];

/** Provider-facing context limits that are not part of Agent Base's routing identity. */
export interface AgentModelContext {
    readonly contextWindow: number;
    readonly autoCompactWindow: number;
}

type CatalogAgentModel = AgentModel & AgentModelContext;

const MODEL_CONTEXTS: Readonly<Record<string, AgentModelContext>> = Object.freeze({
    "anthropic/fable-5": Object.freeze({
        contextWindow: 1_000_000,
        autoCompactWindow: 333_000,
    }),
    "anthropic/opus-4-8": Object.freeze({
        contextWindow: 1_000_000,
        autoCompactWindow: 333_000,
    }),
    "anthropic/opus-5": Object.freeze({
        contextWindow: 1_000_000,
        autoCompactWindow: 333_000,
    }),
    "anthropic/sonnet-5": Object.freeze({
        contextWindow: 1_000_000,
        autoCompactWindow: 333_000,
    }),
    "openai/gpt-5.4": Object.freeze({
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
 * The curated catalog. Rig never asks a vendor which models exist; the list is source, and a
 * configured provider entry decides which of these its own key serves.
 */
const CATALOG: readonly CatalogAgentModel[] = [
    model("codex", "openai/gpt-5.6-sol", "GPT-5.6 Sol", ALL_BUT_OFF, "medium", ["priority"]),
    model("codex", "openai/gpt-5.6-terra", "GPT-5.6 Terra", EVERY_EFFORT, "medium", ["priority"]),
    model("codex", "openai/gpt-5.6-luna", "GPT-5.6 Luna", EVERY_EFFORT, "medium", ["priority"]),
    model("claude", "anthropic/opus-5", "Opus 5 1M"),
    model("claude", "anthropic/sonnet-5", "Sonnet 5"),
    model("claude", "anthropic/fable-5", "Fable 5"),
    model("claude", "anthropic/opus-4-8", "Opus 4.8 1M"),
    model("grok", "xai/grok-4.6", "Grok 4.6", ["low", "medium", "high", "xhigh"], "high"),
    model("grok", "xai/grok-build", "Grok Build", ["medium"]),
    model("grok", "xai/grok-4.5", "Grok 4.5", ["low", "medium", "high"], "high"),
    model("grok", "xai/grok-composer-2.5-fast", "Composer 2.5", ["off"], "off"),
];

/** Bedrock resells the same families, minus Grok, and adds one of its own. */
const BEDROCK_CATALOG: readonly CatalogAgentModel[] = [
    ...CATALOG.filter((candidate) => candidate.providerId !== "grok").map((candidate) => {
        const { serviceTiers: _unsupported, ...rest } = candidate;
        return { ...rest, providerId: "bedrock" };
    }),
    model("bedrock", "openai/gpt-5.4", "GPT-5.4", ["off", "low", "medium", "high", "xhigh"]),
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
): readonly CatalogAgentModel[] {
    const values = configuration.values;
    const available: CatalogAgentModel[] = [];
    for (const [id, provider] of Object.entries(values.providers)) {
        if (provider.enabled === false) continue;
        const source = provider.type === "bedrock" ? BEDROCK_CATALOG : CATALOG;
        for (const candidate of source) {
            if (provider.type !== "bedrock" && candidate.providerId !== provider.type) continue;
            if (provider.includeModels?.includes(candidate.id) === false) continue;
            if (provider.excludeModels?.includes(candidate.id) === true) continue;
            available.push({ ...candidate, providerId: id });
        }
    }
    const wantedModel = values.defaults.modelId;
    const wantedProvider = values.defaults.providerId;
    const chosen =
        available.find(
            (candidate) =>
                candidate.id === wantedModel &&
                (wantedProvider === undefined || candidate.providerId === wantedProvider),
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

/** Context limits for one enabled provider/model route, when the curated catalog knows them. */
export function agentModelContext(modelId: string): AgentModelContext | undefined {
    const context = MODEL_CONTEXTS[modelId];
    return context === undefined ? undefined : { ...context };
}

/**
 * One registry holding every enabled provider, each constructing its client on first use so a
 * credential is read when a session needs it rather than at startup.
 */
export function agentProviders(configuration: HappyAgentConfiguration): AgentProviders {
    const providers = new AgentProviders();
    const retryLimit = configuration.values.settings.inferenceMaxRetries;
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.enabled === false) continue;
        providers.add(
            id,
            async ({ model: selected }) => await createProvider(id, provider, selected, retryLimit),
            provider.type,
        );
    }
    return providers;
}

async function createProvider(
    id: string,
    provider: ConfiguredProvider,
    selectedModel: string | undefined,
    retryLimit: number | undefined,
): Promise<BaseProvider> {
    // Credential isolation means this provider may use only what its own configuration names.
    // Without it, each vendor's ambient discovery — its CLI's own login files and environment —
    // is allowed to answer, which is how Rig reuses a Codex or Claude Code sign-in.
    const ambient = provider.credentialIsolation !== true;
    const retries = retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit };
    const configured = async <T>(
        value: string | undefined,
        fromValue: (value: string) => Promise<T | null>,
        discover: () => Promise<T | null>,
    ): Promise<T | null> =>
        value === undefined ? (ambient ? await discover() : null) : await fromValue(value);

    if (provider.type === "codex") {
        const credential = ambient
            ? await loadCodexCredential({
                  ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                  ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
              })
            : ((provider.apiKey === undefined
                  ? null
                  : await CodexApiKeyCredential.tryLoad({ apiKey: provider.apiKey })) ??
              (provider.authFile === undefined
                  ? null
                  : await CodexSessionCredential.tryLoad({ authFile: provider.authFile })));
        return new CodexProvider({
            credential: required(credential, "Codex", id),
            parallelToolCalls: true,
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
            ...(provider.transport === undefined || provider.transport === "auto"
                ? {}
                : {
                      transport:
                          provider.transport === "websocket-cached"
                              ? ("websocket" as const)
                              : provider.transport,
                  }),
            ...retries,
        });
    }

    if (provider.type === "claude") {
        const credential =
            (await configured(
                provider.oauthToken,
                async (oauthToken) => await ClaudeOAuthCredential.tryLoad({ oauthToken }),
                async () => await ClaudeOAuthCredential.tryLoad({}),
            )) ??
            (await configured(
                provider.apiKey,
                async (apiKey) => await ClaudeApiKeyCredential.tryLoad({ apiKey }),
                async () => await ClaudeApiKeyCredential.tryLoad({}),
            )) ??
            (await configured(
                provider.authToken,
                async (authToken) => await ClaudeAuthTokenCredential.tryLoad({ authToken }),
                async () => await ClaudeAuthTokenCredential.tryLoad({}),
            )) ??
            (await configured(
                provider.configDir,
                async (configDir) => await ClaudeCodeCredential.tryLoad({ configDir }),
                async () => await ClaudeCodeCredential.tryLoad({}),
            ));
        return new AnthropicProvider({
            credential: required(credential, "Claude", id),
            ...(provider.executable === undefined
                ? {}
                : { pathToClaudeCodeExecutable: provider.executable }),
            ...retries,
        });
    }

    if (provider.type === "grok") {
        // Grok reads its key from the environment unless isolation forbids it. Ambient providers
        // may also reuse the default Grok CLI session; isolated ones must name their auth file.
        const env = ambient ? undefined : {};
        const withEnv = <T extends object>(input: T) =>
            env === undefined ? input : { ...input, env };
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
        return new GrokProvider({
            credential: required(credential, "Grok", id),
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
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
        "Bedrock",
        id,
    );
    // Bedrock serves each family through that family's own wire protocol, so the selected model
    // decides which client speaks to it.
    const override =
        selectedModel === undefined ? undefined : provider.modelOverrides?.[selectedModel];
    const shared = {
        credential,
        ...(override?.endpoint === undefined ? {} : { endpoint: override.endpoint }),
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        ...((override?.region ?? provider.region) === undefined
            ? {}
            : { region: override?.region ?? provider.region }),
        ...retries,
    };
    return selectedModel?.startsWith("anthropic/") === true
        ? new AnthropicProvider({
              ...shared,
              ...(override?.transport === undefined ? {} : { transport: override.transport }),
          })
        : new CodexProvider(shared);
}

function required<T>(credential: T | null, vendor: string, id: string): T {
    if (credential === null) {
        throw new Error(`${vendor} authentication is unavailable for provider "${id}".`);
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
