import { onboardingRecipeSchema } from "../OnboardingRecipe.js";

/** The recipe schema as the plain JSON Schema `recipes/onboardingRecipe.schema.json` holds. */
export function onboardingRecipeJsonSchema(): Record<string, unknown> {
    return {
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "Onboarding recipe",
        description:
            "What one kind of onboarding says and does, as data. Generated from OnboardingRecipe.ts in @slopus/happy-agent-modules; edit that file and regenerate rather than this one.",
        ...(JSON.parse(JSON.stringify(onboardingRecipeSchema)) as Record<string, unknown>),
    };
}
