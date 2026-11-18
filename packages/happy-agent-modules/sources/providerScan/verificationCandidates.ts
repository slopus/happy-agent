import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";

/**
 * Relative cost of each model family, cheapest first. These are ranks, not prices: Happy has no
 * price data, and a lower rank only means a family is expected to cost less per request than a
 * higher one. The first matching pattern wins, so a specific family sits above a vendor catch-all.
 * Models no pattern matches are tried after every ranked model, in configuration order.
 */
const RELATIVE_COST_RANKS: readonly (readonly [RegExp, number])[] = [
    [/^anthropic\/haiku-/u, 1],
    [/^openai\/gpt-[\d.]+-luna$/u, 1],
    [/^xai\/grok-composer-/u, 1],
    [/^anthropic\/sonnet-/u, 2],
    [/^openai\/gpt-[\d.]+-terra$/u, 2],
    [/^xai\/grok-/u, 2],
    [/^anthropic\/opus-/u, 3],
    [/^openai\/gpt-[\d.]+-sol$/u, 3],
    [/^openai\/gpt-[\d.]+-astra$/u, 4],
];

/** Fable is the most expensive Anthropic family and is never used to verify a provider. */
const FABLE_MODEL = /^anthropic\/fable(?:-|$)/u;

/** The least reasoning a probe needs, in preference order. "off" is avoided on purpose. */
const VERIFICATION_EFFORTS: readonly SessionReasoningEffort[] = ["low", "minimal", "medium"];

/** The provider's models a verification may use, cheapest first, never a Fable model. */
export function verificationCandidates(
    models: readonly AgentModel[],
    providerId: string,
): { readonly candidates: readonly AgentModel[]; readonly onlyFable: boolean } {
    const routes = models.filter((model) => model.providerId === providerId);
    const candidates = routes
        .filter((model) => !FABLE_MODEL.test(model.id))
        .map((model, index) => ({ index, model, rank: relativeCostRank(model.id) }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map(({ model }) => model);
    return { candidates, onlyFable: candidates.length === 0 && routes.length > 0 };
}

/**
 * The cheapest effort a model accepts for a one-line probe. "off" is a last resort because some
 * vendors reject disabled thinking on models that still list it.
 */
export function verificationEffort(model: AgentModel): SessionReasoningEffort {
    for (const effort of VERIFICATION_EFFORTS) {
        if (model.effortLevels.includes(effort)) return effort;
    }
    if (model.defaultEffort !== "off") return model.defaultEffort;
    return model.effortLevels.find((effort) => effort !== "off") ?? "off";
}

function relativeCostRank(modelId: string): number {
    return (
        RELATIVE_COST_RANKS.find(([pattern]) => pattern.test(modelId))?.[1] ??
        Number.POSITIVE_INFINITY
    );
}
