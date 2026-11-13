import type { InstructionsHunk } from "./diffInstructionLines.js";

/** The longest a change notice may grow before the rest is summarized. */
export const MAX_INSTRUCTIONS_CHANGE_CHARACTERS = 32_000;

const HEADING = [
    "# Instructions changed",
    "Your instructions changed after this conversation began. The system prompt stays as it was first sent, so it still shows the earlier text; this notice supersedes it. Text in <removed> no longer applies. Text in <added> is in force now, in place of the <removed> text directly before it when there is one.",
].join("\n");
const OMITTED =
    "[More of the instructions changed than fits in this notice. Treat the instructions that are not shown here as possibly out of date.]";

/**
 * Tell a model which lines of its instructions changed, as a notice in the conversation.
 *
 * The earlier text is quoted so the model knows what to stop following, and the current text so
 * it knows what to follow instead; it needs nothing else to apply the change.
 */
export function formatInstructionsChange(hunks: readonly InstructionsHunk[]): string {
    const parts = [HEADING];
    let length = HEADING.length;
    for (const hunk of hunks) {
        const part = [
            ...(hunk.removed.length === 0
                ? []
                : [`<removed>\n${hunk.removed.join("\n")}\n</removed>`]),
            ...(hunk.added.length === 0 ? [] : [`<added>\n${hunk.added.join("\n")}\n</added>`]),
        ].join("\n");
        if (length + part.length + 2 > MAX_INSTRUCTIONS_CHANGE_CHARACTERS) {
            parts.push(OMITTED);
            break;
        }
        parts.push(part);
        length += part.length + 2;
    }
    return parts.join("\n\n");
}
