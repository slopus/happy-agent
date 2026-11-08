import type { OnboardingRecipeStep } from "../OnboardingRecipe.js";

/** The longest typed answer a step takes when its input names no `maxLength`. */
const MAX_ANSWER = 128;

/**
 * Where a typed message leads when it answers `step`: the step its input names, with the trimmed
 * text as the parameter. Undefined when the step takes no typed answer, or the text is empty, more
 * than one line, longer than the input allows, or not one of the parameter's listed values.
 */
export function typedAnswer(
    step: OnboardingRecipeStep | undefined,
    text: string,
): { readonly step: string; readonly params: Readonly<Record<string, string>> } | undefined {
    const input = step?.input;
    if (input === undefined) return undefined;
    const value = text.trim();
    const length = [...value].length;
    const declared =
        step?.next !== undefined && Object.hasOwn(step.next, input.step)
            ? step.next[input.step]?.params?.[input.param]
            : undefined;
    if (
        length === 0 ||
        length > (input.maxLength ?? MAX_ANSWER) ||
        /[\r\n]/u.test(value) ||
        (declared?.values !== undefined && !declared.values.includes(value))
    ) {
        return undefined;
    }
    return { step: input.step, params: { [input.param]: value } };
}
