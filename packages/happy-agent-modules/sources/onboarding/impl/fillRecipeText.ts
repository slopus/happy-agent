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
 * A recipe text with its variables filled, each HTML-escaped so no value can open a tag, an
 * attribute, or an entity. A variable with no value is left empty. The recipe was checked against
 * the runtime, so every name is known.
 */
export function fillRecipeText(
    text: OnboardingRecipeText,
    variables: Readonly<Record<string, string>>,
): string {
    return recipeText(text).replace(VARIABLE, (_match, name: string) => {
        const value = Object.hasOwn(variables, name) ? (variables[name] ?? "") : "";
        return value.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? character);
    });
}
