import type { OnboardingRecipeText } from "../OnboardingRecipe.js";
import { recipeText } from "./checkOnboardingRecipe.js";

const VARIABLE = /\{\{([^{}]*)\}\}/gu;
const ESCAPES: Readonly<Record<string, string>> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/**
 * A recipe text with its variables filled: a plain variable HTML-escaped, so no value can open a
 * tag, an attribute, or an entity; a block variable as the runtime wrote it. A variable with no
 * value is left empty. The recipe was checked against the runtime, so every name is known.
 */
export function fillRecipeText(
    text: OnboardingRecipeText,
    variables: Readonly<Record<string, string>>,
    blocks: Readonly<Record<string, string>>,
): string {
    return recipeText(text).replace(VARIABLE, (_match, name: string) => {
        if (Object.hasOwn(blocks, name)) return blocks[name] ?? "";
        const value = Object.hasOwn(variables, name) ? (variables[name] ?? "") : "";
        return value.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? character);
    });
}

/** The block variables a text uses, so only those are built. */
export function recipeVariables(text: OnboardingRecipeText): ReadonlySet<string> {
    return new Set([...recipeText(text).matchAll(VARIABLE)].map((match) => match[1] ?? ""));
}
