import type { HistoryMessage } from "../../history/index.js";

/**
 * The message when it is one a person can answer: an agent message they are shown. An offer and a
 * suggestion both live only in such a message, so a click and a tapped reply are checked against
 * this one rule.
 */
export function visibleAgentMessage(
    message: HistoryMessage | undefined,
): HistoryMessage | undefined {
    if (message === undefined) return undefined;
    if (message.role !== "assistant" && message.role !== "agent") return undefined;
    return message.hideFromUser === true ? undefined : message;
}
