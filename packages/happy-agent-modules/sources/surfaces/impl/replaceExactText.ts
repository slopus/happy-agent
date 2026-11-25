import { SurfaceError } from "../SurfaceError.js";

/**
 * Replace exact text, with the uniqueness rule the file tools use.
 *
 * The text must appear exactly once unless every occurrence was asked for, because a model that
 * meant one of several and got all of them has silently changed text it never looked at. A
 * replacement identical to what it replaces is refused rather than reported as a change.
 * `where` names what is being edited, and `rewrite` says how to write all of it instead.
 */
export function replaceExactText(
    content: string,
    edit: { readonly oldText: string; readonly newText: string; readonly replaceAll: boolean },
    subject: { readonly where: string; readonly rewrite: string },
): { readonly text: string; readonly replacements: number } {
    if (edit.oldText === edit.newText)
        throw new SurfaceError(
            "invalid_request",
            "The replacement is identical to the text it replaces.",
        );
    if (edit.oldText.length === 0)
        throw new SurfaceError(
            "invalid_request",
            `old_string is empty; name the text to replace, or ${subject.rewrite}.`,
        );
    const occurrences = content.split(edit.oldText).length - 1;
    if (occurrences === 0)
        throw new SurfaceError("invalid_request", `This text does not appear in ${subject.where}.`);
    if (occurrences > 1 && !edit.replaceAll)
        throw new SurfaceError(
            "invalid_request",
            `This text appears ${String(occurrences)} times in ${subject.where}. Add surrounding context to make it unique, or replace every occurrence.`,
        );
    // A function replacement keeps `$&` and its kind in the new text literal.
    return {
        text: edit.replaceAll
            ? content.replaceAll(edit.oldText, () => edit.newText)
            : content.replace(edit.oldText, () => edit.newText),
        replacements: edit.replaceAll ? occurrences : 1,
    };
}
