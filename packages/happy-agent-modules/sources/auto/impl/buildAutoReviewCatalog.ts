import type { AgentModel } from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";

/**
 * Builds the private reviewer model catalog, ported from Happy Agent v1's reviewer-model selection and its
 * `reviewerModelForProvider` catalog assumptions.
 *
 * This catalog is never returned by any public catalog route. It exists only so the private review
 * system can resolve a reviewer model for whatever the main agent is running on. It starts from the
 * main catalog — every active route the v1 final fallback needs is therefore present — and adds the
 * hidden reviewer routes v1 relied on, keyed by each provider's compatibility type:
 *
 * - a Codex-compatible provider gains `openai/codex-auto-review`, which is intentionally absent
 *   from the public model picker, at its v1 effort range and `low` default;
 * - a Bedrock provider gains `openai/gpt-5.4` (default `medium`) so a Bedrock conversation reviews
 *   on GPT-5.4, exactly as v1 did;
 * - a Claude-compatible or Bedrock provider gains `anthropic/sonnet-5`, so an Opus/Fable
 *   conversation reviews on Sonnet on the same provider route.
 *
 * A route already present in the main catalog for a provider is never overridden: the deployment's
 * own effort levels and default win, and the addition only fills a route the public catalog did not
 * already expose. `reviewerModelForAgent` then chooses among these routes with the exact v1
 * precedence; this builder only guarantees the routes it can choose from exist.
 */

const CODEX_AUTO_REVIEW: Omit<AgentModel, "providerId"> = {
    id: "openai/codex-auto-review",
    name: "Automatic permission reviewer (Codex)",
    effortLevels: ["low", "medium", "high", "xhigh"],
    defaultEffort: "low",
};

const GPT_5_4: Omit<AgentModel, "providerId"> = {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    effortLevels: ["off", "low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
};

const SONNET_5: Omit<AgentModel, "providerId"> = {
    id: "anthropic/sonnet-5",
    name: "Sonnet 5",
    effortLevels: ["off", "low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
};

export function buildAutoReviewCatalog(options: {
    /** The main agent's model catalog, copied verbatim into the private catalog. */
    models: readonly AgentModel[];
    /** The compatibility type of a provider ID, from the private provider registry. */
    typeOf: (providerId: string) => ProviderModelCompatibilityType | null;
}): AgentModel[] {
    const { models, typeOf } = options;
    const catalog: AgentModel[] = models.map((model) => ({ ...model }));
    const present = new Set(catalog.map((model) => routeKey(model.providerId, model.id)));

    const add = (providerId: string, route: Omit<AgentModel, "providerId">): void => {
        const key = routeKey(providerId, route.id);
        if (present.has(key)) return;
        present.add(key);
        catalog.push({ providerId, ...route });
    };

    const providerIds = [...new Set(models.map((model) => model.providerId))];
    for (const providerId of providerIds) {
        const kind = typeOf(providerId);
        if (kind === "codex") add(providerId, CODEX_AUTO_REVIEW);
        if (kind === "claude" || kind === "bedrock") add(providerId, SONNET_5);
        if (kind === "bedrock") add(providerId, GPT_5_4);
    }
    return catalog;
}

function routeKey(providerId: string, modelId: string): string {
    return `${providerId}\u0000${modelId}`;
}
