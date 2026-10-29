import type { OnboardingWorkRow } from "../OnboardingFlow.js";
import { chatActionEscape } from "./chatActions/chatActionBlocks.js";

/**
 * Focus's proposal as the inline action block Happy's model shows: each row ticked, Looks right
 * the one answer, and the label it takes while nothing is ticked.
 */
export function proposalBlock(rows: readonly OnboardingWorkRow[]): string {
    return [
        '<form data-action="onboarding.workAccept" data-table>',
        ...rows.map(
            (row) =>
                `  <label data-icon="${chatActionEscape(row.icon)}"${row.ongoing ? " data-ongoing" : ""}><input type="checkbox" value="${chatActionEscape(row.id)}" checked>${chatActionEscape(row.title)} <small>${chatActionEscape(row.ongoing ? `Ongoing · ${row.why}` : row.why)}</small><small>${chatActionEscape(row.topic)}</small><small>${chatActionEscape(row.firstMessage)}</small></label>`,
        ),
        '  <button type="submit" data-emphasis data-empty-label="Continue without these">Looks right</button>',
        '  <button type="button" data-action="onboarding.workChange">Adjust</button>',
        "</form>",
    ].join("\n");
}
