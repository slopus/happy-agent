import { ArtifactInputError } from "../Artifact.js";

/** The most characters a summary holds, counted as Unicode code points. */
export const MAX_ARTIFACT_SUMMARY_CHARACTERS = 5000;

/**
 * A summary as it is stored: CRLF line ends become `\n`, and the text is trimmed. Refuses one that
 * is then empty, longer than `MAX_ARTIFACT_SUMMARY_CHARACTERS`, or holds a control character
 * other than `\n`, saying which in words the writer can act on.
 */
export function normalizeArtifactSummary(summary: string): string {
    const text = summary.replaceAll("\r\n", "\n").trim();
    if (text === "") throw new ArtifactInputError("A summary needs some text.");
    const characters = [...text].length;
    if (characters > MAX_ARTIFACT_SUMMARY_CHARACTERS) {
        throw new ArtifactInputError(
            `A summary is at most ${MAX_ARTIFACT_SUMMARY_CHARACTERS.toLocaleString("en-US")} characters; this one has ${characters.toLocaleString("en-US")}.`,
        );
    }
    if (/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) {
        throw new ArtifactInputError(
            "A summary is plain text: line breaks are fine, but it cannot hold tabs or other control characters.",
        );
    }
    return text;
}
