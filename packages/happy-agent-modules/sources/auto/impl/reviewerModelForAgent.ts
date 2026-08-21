import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";

/** The reviewer model IDs, matching the v1 catalog entries these routes are keyed by. */
const REVIEWER_MODEL_SONNET = "anthropic/sonnet-5";
const REVIEWER_MODEL_CODEX_AUTO_REVIEW = "openai/codex-auto-review";
const REVIEWER_MODEL_GPT_5_4 = "openai/gpt-5.4";

/**
 * Picks the model that reviews Auto permission decisions, ported from Happy Agent v1's
 * `reviewerModelForProvider.ts` and generalized to the v2 per-provider-route catalog.
 *
 * This is a pure function over a supplied catalog: it never reaches into a registry and never
 * resolves a provider. The private review catalog is the single source of truth for what a route
 * can serve, so "resolvable" here means "present in `models`". The precedence matches v1 exactly:
 *
 * 1. An Anthropic Opus/Fable conversation reviews on Sonnet on the same provider route.
 * 2. Otherwise the hidden `openai/codex-auto-review` route is used when the provider has it.
 * 3. Otherwise the hidden `openai/gpt-5.4` route is used when the provider has it.
 * 4. Otherwise the active provider/model/effort route is kept, matching v1's
 *    `provider.reviewerModelFor?.(model) ?? provider.reviewerModel ?? model`.
 * 5. If even the active route is not in the catalog, this throws. The caller converts that into an
 *    unavailable/unproven review; it never picks an arbitrary model or allows the action.
 *
 * A selected hidden route runs at that catalog entry's default effort (Codex Auto Review defaults
 * to `low`, GPT-5.4 to `medium`, Sonnet to its own default); the fallback keeps the active effort.
 */

export const autoReviewerRouteSchema = Type.Object(
    {
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        effort: Type.Unsafe<SessionReasoningEffort>(Type.String({ minLength: 1, maxLength: 64 })),
    },
    { additionalProperties: false },
);

export type AutoReviewerRoute = Static<typeof autoReviewerRouteSchema>;

export function reviewerModelForAgent(options: {
    /** The private review catalog: one entry per enabled provider/model route. */
    models: readonly AgentModel[];
    /** The main agent's current provider/model/effort route. */
    active: AutoReviewerRoute;
}): AutoReviewerRoute {
    const { models, active } = options;

    if (
        active.modelId.startsWith("anthropic/opus-") ||
        active.modelId.startsWith("anthropic/fable-")
    ) {
        const sonnet = findRoute(models, active.providerId, REVIEWER_MODEL_SONNET);
        if (sonnet !== undefined) return routeFor(sonnet);
    }

    for (const candidateId of [REVIEWER_MODEL_CODEX_AUTO_REVIEW, REVIEWER_MODEL_GPT_5_4]) {
        const hidden = findRoute(models, active.providerId, candidateId);
        if (hidden !== undefined) return routeFor(hidden);
    }

    if (findRoute(models, active.providerId, active.modelId) !== undefined) return active;

    throw new Error(
        `No reviewer model route could be resolved for ${active.modelId} on provider ` +
            `${active.providerId}.`,
    );
}

function findRoute(
    models: readonly AgentModel[],
    providerId: string,
    modelId: string,
): AgentModel | undefined {
    return models.find((model) => model.providerId === providerId && model.id === modelId);
}

function routeFor(model: AgentModel): AutoReviewerRoute {
    return { providerId: model.providerId, modelId: model.id, effort: model.defaultEffort };
}
