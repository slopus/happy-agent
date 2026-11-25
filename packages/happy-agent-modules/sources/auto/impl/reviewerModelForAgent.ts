import type { AgentModel } from "@slopus/happy-agent-base";
import { providerModelFamily, type SessionReasoningEffort } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";

/** The reviewer model IDs, matching the v1 catalog entries these routes are keyed by. */
const REVIEWER_MODEL_SONNET = "anthropic/sonnet-5";
const REVIEWER_MODEL_CODEX_AUTO_REVIEW = "openai/codex-auto-review";
const REVIEWER_MODEL_GPT_5_4 = "openai/gpt-5.4";
const HIDDEN_REVIEWER_MODELS = [
    REVIEWER_MODEL_SONNET,
    REVIEWER_MODEL_CODEX_AUTO_REVIEW,
    REVIEWER_MODEL_GPT_5_4,
] as const;

/**
 * The Antigravity model that reviews when no account Happy runs itself can, and the effort it
 * reviews at. Antigravity runs it with none of its own tools, only Happy's reviewer tools.
 */
export const ANTIGRAVITY_REVIEWER_MODEL = "antigravity/gemini-4-hydrogen";
const ANTIGRAVITY_REVIEWER_EFFORT: SessionReasoningEffort = "low";

/**
 * Picks the models that review Auto permission decisions, ported from Happy Agent v1's
 * `reviewerModelForProvider.ts` and generalized to the v2 per-provider-route catalog.
 *
 * This is a pure function over a supplied catalog: it never reaches into a registry and never
 * resolves a provider. The private review catalog is the single source of truth for what a route
 * can serve, so "resolvable" here means "present in `models`". Within one account the precedence
 * matches v1 exactly:
 *
 * 1. An Anthropic Opus/Fable conversation reviews on Sonnet on the same provider route.
 * 2. Otherwise the hidden `openai/codex-auto-review` route is used when the provider has it.
 * 3. Otherwise the hidden `openai/gpt-5.4` route is used when the provider has it.
 * 4. Otherwise the active provider/model/effort route is kept, matching v1's
 *    `provider.reviewerModelFor?.(model) ?? provider.reviewerModel ?? model`.
 *
 * Those are tried first. A route that turns out to be unavailable falls through to the routes of
 * Happy's default model, then to every other enabled account in `fallbacks` order, each on its
 * own first model, and last to {@link ANTIGRAVITY_REVIEWER_MODEL} on an enabled Antigravity
 * account. With no route at all this throws; the caller converts that into an unavailable review
 * and never allows the action.
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

/**
 * No configured model can review this agent: no Claude, Codex, or Grok account Happy runs, and no
 * Antigravity account serving its reviewer model.
 */
export class NoReviewerModelError extends Error {}

export function reviewerModelForAgent(options: {
    /** The private review catalog: one entry per enabled provider/model route. */
    models: readonly AgentModel[];
    /** The main agent's current provider/model/effort route. */
    active: AutoReviewerRoute;
}): AutoReviewerRoute {
    return reviewerModelsForAgent(options)[0]!;
}

/** Each eligible route once, in the order a review tries them. */
export function reviewerModelsForAgent(options: {
    models: readonly AgentModel[];
    active: AutoReviewerRoute;
    /** Happy's enabled models, default first: the accounts tried after the agent's own. */
    fallbacks?: readonly AgentModel[];
}): AutoReviewerRoute[] {
    const { models, active } = options;
    const fallbacks = options.fallbacks ?? [];
    const routes: AutoReviewerRoute[] = [];
    const add = (route: AutoReviewerRoute): void => {
        if (
            !routes.some(
                (known) => known.providerId === route.providerId && known.modelId === route.modelId,
            )
        )
            routes.push(route);
    };

    // The agent's own account. A harness model runs inside that harness, so reviewing on it would
    // start another foreign agent; its account's hidden reviewer routes stand in for it.
    const ownRoutes = isHarnessModel(active.modelId)
        ? hiddenRoutes(models, active.providerId)
        : accountRoutes(models, active);
    ownRoutes.forEach(add);

    // Happy's default model, then every other enabled account, each once, on its first model.
    const tried = new Set([active.providerId]);
    const happyModels = fallbacks.filter(
        (model) => !isHarnessModel(model.id) && findRoute(models, model.providerId, model.id),
    );
    const defaultModel = happyModels[0];
    if (defaultModel !== undefined) {
        accountRoutes(models, routeFor(defaultModel)).forEach(add);
        tried.add(defaultModel.providerId);
    }
    for (const { providerId } of fallbacks) {
        if (tried.has(providerId)) continue;
        tried.add(providerId);
        const first = happyModels.find((model) => model.providerId === providerId);
        (first === undefined
            ? hiddenRoutes(models, providerId)
            : accountRoutes(models, routeFor(first))
        ).forEach(add);
    }

    const antigravity = models.find(
        (model) =>
            model.id === ANTIGRAVITY_REVIEWER_MODEL &&
            fallbacks.some((enabled) => enabled.providerId === model.providerId),
    );
    if (antigravity !== undefined) {
        add({
            providerId: antigravity.providerId,
            modelId: antigravity.id,
            effort: antigravity.effortLevels.includes(ANTIGRAVITY_REVIEWER_EFFORT)
                ? ANTIGRAVITY_REVIEWER_EFFORT
                : antigravity.defaultEffort,
        });
    }

    if (routes.length > 0) return routes;
    throw new NoReviewerModelError(
        `No reviewer model route could be resolved for ${active.modelId} on provider ` +
            `${active.providerId}.`,
    );
}

/** One account's reviewer routes for a model Happy runs on it, in v1 precedence. */
function accountRoutes(
    models: readonly AgentModel[],
    active: AutoReviewerRoute,
): AutoReviewerRoute[] {
    const routes: AutoReviewerRoute[] = [];
    if (
        active.modelId.startsWith("anthropic/opus-") ||
        active.modelId.startsWith("anthropic/fable-")
    ) {
        const sonnet = findRoute(models, active.providerId, REVIEWER_MODEL_SONNET);
        if (sonnet !== undefined) routes.push(routeFor(sonnet));
    }
    for (const candidateId of [REVIEWER_MODEL_CODEX_AUTO_REVIEW, REVIEWER_MODEL_GPT_5_4]) {
        const hidden = findRoute(models, active.providerId, candidateId);
        if (hidden !== undefined) routes.push(routeFor(hidden));
    }
    if (
        findRoute(models, active.providerId, active.modelId) !== undefined &&
        !routes.some((route) => route.modelId === active.modelId)
    )
        routes.push(active);
    return routes;
}

/** An account's hidden reviewer routes, for an account Happy runs no model of its own on. */
function hiddenRoutes(models: readonly AgentModel[], providerId: string): AutoReviewerRoute[] {
    return HIDDEN_REVIEWER_MODELS.flatMap((candidateId) => {
        const hidden = findRoute(models, providerId, candidateId);
        return hidden === undefined ? [] : [routeFor(hidden)];
    });
}

function isHarnessModel(modelId: string): boolean {
    return providerModelFamily(modelId) === "foreign";
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
