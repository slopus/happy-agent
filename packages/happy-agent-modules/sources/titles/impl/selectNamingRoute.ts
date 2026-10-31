import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";

/** One account and model a name can be written on. */
export interface NamingRoute {
    readonly providerId: string;
    readonly model: string;
    readonly effort: SessionReasoningEffort;
}

/** Inexpensive models worth naming a chat with, one per vendor. */
const ECONOMICAL_MODEL_IDS = [
    "anthropic/sonnet-5",
    "openai/gpt-6-luna",
    "xai/grok-composer-2.5-fast",
];

/** Naming is a writing task, so the least reasoning the model will accept is the right amount. */
const CHEAPEST_EFFORTS: readonly SessionReasoningEffort[] = ["off", "minimal", "low", "medium"];

/**
 * Picks what writes a name, starting from the account the chat is already running on.
 *
 * Writing a title deserves the cheapest model available, but not at the cost of leaving the
 * chat's own account: only that account is known to be signed in and paid for, and a model served
 * by another one may not be reachable at all. So the chat's account is both the starting point and
 * the preference, and the configured default is what answers when the chat has named no account.
 */
export function selectNamingRoute(
    models: readonly AgentModel[],
    preferredProviderId?: string,
    defaultProviderId?: string,
): NamingRoute | undefined {
    const served =
        firstServed(models, preferredProviderId) ??
        firstServed(models, defaultProviderId) ??
        (models.length === 0 ? undefined : models);
    if (served === undefined) return undefined;
    const model =
        served.find((candidate) => ECONOMICAL_MODEL_IDS.includes(candidate.id)) ?? served[0];
    if (model === undefined) return undefined;
    return { providerId: model.providerId, model: model.id, effort: cheapestEffort(model) };
}

function firstServed(
    models: readonly AgentModel[],
    providerId: string | undefined,
): readonly AgentModel[] | undefined {
    if (providerId === undefined) return undefined;
    const served = models.filter((model) => model.providerId === providerId);
    return served.length === 0 ? undefined : served;
}

function cheapestEffort(model: AgentModel): SessionReasoningEffort {
    for (const effort of CHEAPEST_EFFORTS) {
        if (model.effortLevels.includes(effort)) return effort;
    }
    return model.defaultEffort;
}
