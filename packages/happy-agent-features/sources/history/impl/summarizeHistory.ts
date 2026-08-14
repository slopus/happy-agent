import { Type, type Static } from "@sinclair/typebox";

import {
    MAX_HISTORY_TOTAL_BLOCKS,
    MAX_HISTORY_TOTAL_MESSAGES,
    MAX_HISTORY_TOTAL_TEXT_CHARACTERS,
    type HistoryMessage,
} from "../HistoryMessage.js";

/** What a stretch of history amounts to, in numbers a reader can size it by. */
export const historyStatsSchema = Type.Object(
    {
        assistantMessages: Type.Integer({ maximum: MAX_HISTORY_TOTAL_MESSAGES, minimum: 0 }),
        messages: Type.Integer({ maximum: MAX_HISTORY_TOTAL_MESSAGES, minimum: 0 }),
        textCharacters: Type.Integer({
            maximum: MAX_HISTORY_TOTAL_TEXT_CHARACTERS,
            minimum: 0,
        }),
        thinkingBlocks: Type.Integer({ maximum: MAX_HISTORY_TOTAL_BLOCKS, minimum: 0 }),
        toolCalls: Type.Integer({ maximum: MAX_HISTORY_TOTAL_BLOCKS, minimum: 0 }),
        toolResults: Type.Integer({ maximum: MAX_HISTORY_TOTAL_BLOCKS, minimum: 0 }),
        userMessages: Type.Integer({ maximum: MAX_HISTORY_TOTAL_MESSAGES, minimum: 0 }),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyStatsSchema}. */
export type HistoryStats = Static<typeof historyStatsSchema>;

/** Count what these messages contain, without reading any of it. */
export function summarizeHistory(messages: readonly HistoryMessage[]): HistoryStats {
    const stats: HistoryStats = {
        assistantMessages: 0,
        messages: messages.length,
        textCharacters: 0,
        thinkingBlocks: 0,
        toolCalls: 0,
        toolResults: 0,
        userMessages: 0,
    };
    for (const message of messages) {
        if (message.role === "user") stats.userMessages += 1;
        if (message.role === "assistant") stats.assistantMessages += 1;
        for (const block of message.blocks) {
            if (block.type === "text") stats.textCharacters += block.text.length;
            if (block.type === "thinking") {
                stats.thinkingBlocks += 1;
                stats.textCharacters += block.thinking.length;
            }
            if (block.type === "tool_call") stats.toolCalls += 1;
            if (block.type === "tool_result") stats.toolResults += 1;
        }
    }
    return stats;
}
