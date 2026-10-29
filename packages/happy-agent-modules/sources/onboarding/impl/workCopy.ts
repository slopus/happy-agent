import type { OnboardingWorkRow } from "../OnboardingFlow.js";
import { chatActionEscape } from "./chatActions/chatActionBlocks.js";

/**
 * Happy's words around the person's work, in the inline action grammar. The desktop's flow on
 * `chat-onboarding` is the reference for their wording.
 */

export function discoveringMessage(assistant: string): string {
    return [
        `Reading your ${assistant} sessions and the recent Git history of those projects. This takes a minute.`,
        "",
        '<output data-status="running">Looking at what you\'ve been working on…</output>',
    ].join("\n");
}

export function proposingMessage(): string {
    return [
        "Organizing that the way I'd keep it.",
        "",
        '<output data-status="running">Putting your work in order…</output>',
    ].join("\n");
}

/** Focus's proposal: the final state, each row ticked, Looks right the one answer. */
export function proposalMessage(intro: string, rows: readonly OnboardingWorkRow[]): string {
    return [
        intro,
        "",
        "**Looks right** places these in your sidebar and starts each chat on its first message. Each one makes a read-only plan and waits for you.",
        "",
        '<form data-action="onboarding.workAccept" data-table>',
        ...rows.map(
            (row) =>
                `  <label data-icon="${chatActionEscape(row.icon)}"${row.ongoing ? " data-ongoing" : ""}><input type="checkbox" value="${chatActionEscape(row.id)}" checked>${chatActionEscape(row.title)} <small>${chatActionEscape(row.ongoing ? `Ongoing · ${row.why}` : row.why)}</small><small>${chatActionEscape(row.topic)}</small><small>${chatActionEscape(row.firstMessage)}</small></label>`,
        ),
        '  <button type="submit" data-emphasis>Looks right</button>',
        '  <button type="button" data-action="onboarding.workChange">Adjust</button>',
        "</form>",
    ].join("\n");
}

export function proposalFailedMessage(reason: string): string {
    return [
        `I couldn't put a proposal together: ${reason}`,
        "",
        "<menu>",
        '  <button data-action="onboarding.workTell" data-emphasis>I\'ll tell you instead</button>',
        "</menu>",
    ].join("\n");
}

export function nothingFoundMessage(assistant: string): string {
    return [
        `I didn't find recent work in your ${assistant} sessions. Tell me what you'd like to get done and we'll start there.`,
        "",
        "<menu>",
        '  <button data-action="onboarding.workTell" data-emphasis>Tell Happy what I work on</button>',
        '  <button data-action="onboarding.newChatSkip">Skip this</button>',
        "</menu>",
    ].join("\n");
}

export function phoneFailedMessage(reason: string): string {
    return `I couldn't open a phone pairing: ${reason}`;
}
