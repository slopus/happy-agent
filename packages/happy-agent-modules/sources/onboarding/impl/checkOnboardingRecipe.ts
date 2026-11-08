import { Value } from "@sinclair/typebox/value";

import {
    onboardingRecipeSchema,
    type OnboardingRecipe,
    type OnboardingRecipeText,
} from "../OnboardingRecipe.js";

/** What one runtime offers a recipe: anything else it names is refused. */
export interface OnboardingRuntimeOffer {
    /** Each effect with every outcome it can return. */
    readonly effects: Readonly<Record<string, readonly string[]>>;
    readonly conditions: ReadonlySet<string>;
    /** Plain variables, HTML-escaped where they are filled. */
    readonly variables: ReadonlySet<string>;
    /** Variables the runtime writes as whole Markdown or inline action blocks. */
    readonly blocks: ReadonlySet<string>;
    readonly tools: ReadonlySet<string>;
    readonly requirements: ReadonlySet<string>;
}

const VARIABLE = /\{\{([^{}]*)\}\}/gu;
const TARGETS = new Set(["handoff", "finish"]);

/**
 * Every way a recipe does not fit its schema or the runtime that would run it: a target that is
 * no step, an effect outcome left unmapped, a condition, variable, tool, or requirement the
 * runtime does not offer. Empty when the recipe can run.
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
    const steps = recipe.bootstrap.steps;
    const isStep = (id: string) => Object.hasOwn(steps, id);
    const reaches = (target: string, where: string) => {
        if (!TARGETS.has(target) && !isStep(target))
            problems.push(`${where} names no step "${target}".`);
    };
    for (const id of TARGETS) if (isStep(id)) problems.push(`"${id}" is a target, not a step ID.`);
    reaches(recipe.bootstrap.start, "bootstrap.start");
    if (recipe.bootstrap.handoffFailed !== undefined) {
        reaches(recipe.bootstrap.handoffFailed, "bootstrap.handoffFailed");
    }
    for (const [id, step] of Object.entries(steps)) {
        for (const target of Object.keys(step.next ?? {})) {
            if (!isStep(target)) problems.push(`Step "${id}" leads to no step "${target}".`);
        }
        if (step.say?.at(-1)?.when !== undefined) {
            problems.push(`Step "${id}" may say nothing: its last entry has a condition.`);
        }
        for (const entry of step.say ?? []) {
            const condition = entry.when?.replace(/^!/u, "");
            if (condition !== undefined && !offer.conditions.has(condition)) {
                problems.push(`Step "${id}" uses an unknown condition "${condition}".`);
            }
            problems.push(...unknownVariables(entry.text, offer, `Step "${id}"`));
        }
        if (step.effect !== undefined) {
            const outcomes = Object.hasOwn(offer.effects, step.effect.name)
                ? offer.effects[step.effect.name]
                : undefined;
            if (outcomes === undefined) {
                problems.push(`Step "${id}" uses an unknown effect "${step.effect.name}".`);
            } else {
                for (const outcome of outcomes) {
                    if (!Object.hasOwn(step.effect.then, outcome)) {
                        problems.push(`Step "${id}" leaves the outcome "${outcome}" unmapped.`);
                    }
                }
                for (const [outcome, target] of Object.entries(step.effect.then)) {
                    if (!outcomes.includes(outcome)) {
                        problems.push(
                            `Step "${id}" maps an outcome "${outcome}" its effect never returns.`,
                        );
                    }
                    reaches(target, `Step "${id}"`);
                }
            }
        }
        if (step.input !== undefined) {
            const rule =
                step.next !== undefined && Object.hasOwn(step.next, step.input.step)
                    ? step.next[step.input.step]
                    : undefined;
            if (rule === undefined) {
                problems.push(
                    `Step "${id}" takes a typed answer toward "${step.input.step}", which is not one of its next steps.`,
                );
            } else if (rule.params === undefined || !Object.hasOwn(rule.params, step.input.param)) {
                problems.push(
                    `Step "${id}" takes a typed answer as "${step.input.param}", which its step "${step.input.step}" does not declare.`,
                );
            }
            if (step.say === undefined) {
                problems.push(`Step "${id}" takes a typed answer but asks nothing.`);
            }
        }
        if (step.end !== undefined && (step.effect !== undefined || step.next !== undefined)) {
            problems.push(
                `Step "${id}" ends the bootstrap, so it can have no effect or next steps.`,
            );
        }
        if (step.say === undefined && step.effect === undefined && step.end === undefined) {
            problems.push(`Step "${id}" neither says nor does anything.`);
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
        return offer.variables.has(name) || offer.blocks.has(name)
            ? []
            : [`${where} uses an unknown variable "{{${name}}}".`];
    });
}
