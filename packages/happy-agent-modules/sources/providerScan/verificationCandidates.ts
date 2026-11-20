import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";

/**
 * Relative cost of each model family, cheapest first. These are ranks, not prices: Happy has no
 * price data, and a lower rank only means a family is expected to cost less per request than a
 * higher one. Patterns match the model's own name, the last segment of its ID, so a family ranks
 * the same served by its vendor (`anthropic/haiku-5-5`) and run by a harness
 * (`claude-code/haiku`, `antigravity/claude-sonnet-5-5`, `opencode/openai/gpt-6-luna`). The first
 * matching pattern wins, so a specific family sits above a catch-all. Models no pattern matches
 * are tried after every ranked model, in configuration order.
 */
const RELATIVE_COST_RANKS: readonly (readonly [RegExp, number])[] = [
    [/^(?:claude-)?haiku(?:-|\[|$)/u, 1],
    [/^gpt-[\d.]+-luna$/u, 1],
    [/^grok-composer-/u, 1],
    [/^gemini-[\d.]+-flash(?:-|$)/u, 1],
    [/^(?:claude-)?sonnet(?:-|\[|$)/u, 2],
    [/^gpt-[\d.]+-terra$/u, 2],
    [/^grok-/u, 2],
    [/^gemini-/u, 2],
    [/^(?:claude-)?opus(?:-|\[|$)/u, 3],
    [/^gpt-[\d.]+-sol$/u, 3],
    [/^gpt-[\d.]+-astra$/u, 4],
];

/**
 * Fable is the most expensive Anthropic family and is never used to verify a provider, whether its
 * vendor serves it or a harness runs it (`claude-code/fable`).
 */
const FABLE_MODEL = /^(?:claude-)?fable(?:-|\[|$)/u;

/** The least reasoning a probe needs, in preference order. "off" is avoided on purpose. */
const VERIFICATION_EFFORTS: readonly SessionReasoningEffort[] = ["low", "minimal", "medium"];

/** The provider's models a verification may use, cheapest first, never a Fable model. */
export function verificationCandidates(
    models: readonly AgentModel[],
    providerId: string,
): { readonly candidates: readonly AgentModel[]; readonly onlyFable: boolean } {
    const routes = models.filter((model) => model.providerId === providerId);
    const candidates = routes
        .filter((model) => !FABLE_MODEL.test(modelName(model.id)))
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
    const name = modelName(modelId);
    return (
        RELATIVE_COST_RANKS.find(([pattern]) => pattern.test(name))?.[1] ?? Number.POSITIVE_INFINITY
    );
}

/** The model's own name, without the vendor or harness segments in front of it. */
function modelName(modelId: string): string {
    return modelId.slice(modelId.lastIndexOf("/") + 1);
}
