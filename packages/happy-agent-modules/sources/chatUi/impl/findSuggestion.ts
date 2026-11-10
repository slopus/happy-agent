import type { HistoryMessage } from "../../history/index.js";
import { visibleAgentMessage } from "./visibleAgentMessage.js";

/** The tool whose completed call is the only model-written suggestion. */
export const SUGGEST_REPLIES_TOOL = "suggest_replies";

/**
 * The options of one suggestion in a visible agent message: those of the successful
 * `suggest_replies` call `toolCallId` names, or of the message's own `quick_replies` block when it
 * names none.
 */
export function findSuggestion(
    message: HistoryMessage | undefined,
    toolCallId: string | undefined,
): readonly string[] | undefined {
    for (const block of visibleAgentMessage(message)?.blocks ?? []) {
        if (toolCallId === undefined) {
            if (block.type === "quick_replies") return block.options;
        } else if (
            block.type === "tool_result" &&
            block.callId === toolCallId &&
            block.toolName === SUGGEST_REPLIES_TOOL &&
            block.isError !== true &&
            block.presentation?.type === "quick_replies"
        ) {
            return block.presentation.options;
        }
    }
    return undefined;
}
