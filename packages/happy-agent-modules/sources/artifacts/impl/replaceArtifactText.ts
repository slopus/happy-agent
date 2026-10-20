import { ArtifactInputError } from "../Artifact.js";

/**
 * Replace exact text in an artifact file's text, as the file tools' exact-text edit does.
 *
 * The text must appear exactly once unless every occurrence was asked for, because a model that
 * meant one of several and got all of them has silently changed text it never looked at. A
 * replacement identical to what it replaces is refused rather than reported as a change.
 */
export function replaceArtifactText(
    content: string,
    path: string,
    edit: { readonly oldText: string; readonly newText: string; readonly replaceAll: boolean },
): { readonly text: string; readonly replacements: number } {
    if (edit.oldText === edit.newText) {
        throw new ArtifactInputError("The replacement is identical to the text it replaces.");
    }
    if (edit.oldText.length === 0) {
        throw new ArtifactInputError(
            "old_string is empty; name the text to replace, or write the whole file with write_artifact_file.",
        );
    }
    const occurrences = content.split(edit.oldText).length - 1;
    if (occurrences === 0) {
        throw new ArtifactInputError(`This text does not appear in ${JSON.stringify(path)}.`);
    }
    if (occurrences > 1 && !edit.replaceAll) {
        throw new ArtifactInputError(
            `This text appears ${String(occurrences)} times in ${JSON.stringify(path)}. Add surrounding context to make it unique, or replace every occurrence.`,
        );
    }
    // A function replacement keeps `$&` and its kind in the new text literal.
    const text = edit.replaceAll
        ? content.replaceAll(edit.oldText, () => edit.newText)
        : content.replace(edit.oldText, () => edit.newText);
    return { text, replacements: edit.replaceAll ? occurrences : 1 };
}
