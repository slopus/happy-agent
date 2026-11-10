import { Value } from "@sinclair/typebox/value";

import {
    onboardingRecipeSchema,
    type OnboardingRecipe,
    type OnboardingRecipeText,
} from "../OnboardingRecipe.js";

/** What one runtime offers a recipe: anything else it names is refused. */
export interface OnboardingRuntimeOffer {
    /** Variables the opening, its failure words, and the guide may use. */
    readonly variables: ReadonlySet<string>;
    /** Chat UI component types the runtime can fill below the opening's words. */
    readonly components: ReadonlySet<string>;
    /** Reply component types the runtime can suggest and answer in the opening. */
    readonly replies: ReadonlySet<string>;
    readonly tools: ReadonlySet<string>;
    readonly requirements: ReadonlySet<string>;
}

const VARIABLE = /\{\{([^{}]*)\}\}/gu;

/**
 * Every way a recipe does not fit its schema or the runtime that would run it: a variable,
 * component, tool, or requirement the runtime does not offer. Empty when the recipe can run.
 */
export function checkOnboardingRecipe(
    recipe: unknown,
    offer: OnboardingRuntimeOffer,
): readonly string[] {
    if (!Value.Check(onboardingRecipeSchema, recipe)) {
        const first = [...Value.Errors(onboardingRecipeSchema, recipe)][0];
        return [`The recipe does not match its schema at ${first?.path ?? "/"}: ${first?.message}`];
    }
    const problems: string[] = [];
    const bootstrap = recipe.bootstrap;
    if (bootstrap !== undefined) {
        problems.push(...unknownVariables(bootstrap.say, offer, "The opening"));
        if (bootstrap.failed !== undefined) {
            problems.push(...unknownVariables(bootstrap.failed, offer, "The failure text"));
        }
        if (bootstrap.answer !== undefined) {
            problems.push(...unknownVariables(bootstrap.answer, offer, "The answer text"));
        }
        if ((bootstrap.replies === undefined) !== (bootstrap.answer === undefined)) {
            problems.push("The opening's replies and its answer come together.");
        }
        for (const type of bootstrap.replies ?? []) {
            if (!offer.replies.has(type)) {
                problems.push(`The opening suggests a reply this runtime can't fill: "${type}".`);
            }
        }
        for (const type of bootstrap.offer) {
            if (!offer.components.has(type)) {
                problems.push(`The opening offers a component this runtime can't fill: "${type}".`);
            }
        }
    }
    problems.push(...unknownVariables(recipe.guide, offer, "The guide"));
    for (const tool of recipe.tools) {
        if (!offer.tools.has(tool)) problems.push(`The recipe uses an unknown tool "${tool}".`);
    }
    for (const requirement of recipe.requirements) {
        if (!offer.requirements.has(requirement)) {
            problems.push(`The recipe requires something unknown: "${requirement}".`);
        }
    }
    return problems;
}

/** The recipe as checked; throws with every problem when it cannot run. */
export function assertOnboardingRecipe(
    recipe: unknown,
    offer: OnboardingRuntimeOffer,
): OnboardingRecipe {
    const problems = checkOnboardingRecipe(recipe, offer);
    if (problems.length > 0 || !Value.Check(onboardingRecipeSchema, recipe)) {
        throw new Error(`The onboarding recipe cannot run:\n${problems.join("\n")}`);
    }
    return recipe;
}

/** A recipe text as one string: lines joined with line feeds. */
export function recipeText(text: OnboardingRecipeText): string {
    return typeof text === "string" ? text : text.join("\n");
}

function unknownVariables(
    text: OnboardingRecipeText,
    offer: OnboardingRuntimeOffer,
    where: string,
): string[] {
    return [...recipeText(text).matchAll(VARIABLE)].flatMap((match) => {
        const name = match[1] ?? "";
        return offer.variables.has(name)
            ? []
            : [`${where} uses an unknown variable "{{${name}}}".`];
    });
}
