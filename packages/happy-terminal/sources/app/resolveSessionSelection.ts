import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import type { ModelCatalog, ServiceTier } from "../protocol/index.js";

/** What Happy Terminal knows before it reads the catalog: a model, and whatever else the person named. */
export interface SessionSelectionPreferences {
    readonly modelId: string;
    readonly providerId?: string;
    readonly effort?: string;
    readonly serviceTier?: ServiceTier | null;
}

/** The complete answer every request carries. */
export interface ResolvedSessionSelection {
    readonly modelId: string;
    readonly providerId: string;
    readonly effort: string;
    readonly serviceTier: ServiceTier | null;
}

/**
 * Completes a selection from the catalog the agent published.
 *
 * The agent chooses nothing on a client's behalf: a request that leaves out the account, the model,
 * the effort or the service tier is refused. Happy Terminal therefore resolves its own defaults here, once,
 * against the catalog it just read, and says plainly when the configured model is not in it.
 */
export function resolveSessionSelection(
    preferences: SessionSelectionPreferences,
    catalog: ModelCatalog,
): ResolvedSessionSelection {
    const providers = catalog.providers.filter((provider) =>
        provider.models.some((model) => model.id === preferences.modelId),
    );
    if (providers.length === 0) {
        throw new HappyTerminalUserError(
            `Model "${preferences.modelId}" is not available on this agent.`,
            {
                hint: "Run /model to see the models this agent serves.",
            },
        );
    }
    const provider =
        preferences.providerId === undefined
            ? (providers.find((candidate) => candidate.providerId === catalog.defaultProviderId) ??
              providers[0]!)
            : providers.find((candidate) => candidate.providerId === preferences.providerId);
    if (provider === undefined) {
        throw new HappyTerminalUserError(
            `Model "${preferences.modelId}" is not served by provider "${preferences.providerId!}".`,
            { hint: `It is served by ${providers.map((one) => one.providerId).join(", ")}.` },
        );
    }
    const model = provider.models.find((candidate) => candidate.id === preferences.modelId)!;
    const effort = preferences.effort ?? model.defaultThinkingLevel;
    if (!model.thinkingLevels.includes(effort)) {
        throw new HappyTerminalUserError(
            `Model "${model.id}" does not support the "${effort}" reasoning effort.`,
            { hint: `It supports ${model.thinkingLevels.join(", ")}.` },
        );
    }
    const serviceTier = preferences.serviceTier ?? null;
    if (serviceTier !== null && provider.serviceTiers?.includes(serviceTier) !== true) {
        throw new HappyTerminalUserError(
            `Provider "${provider.providerId}" does not offer the "${serviceTier}" service tier.`,
        );
    }
    return { effort, modelId: model.id, providerId: provider.providerId, serviceTier };
}
