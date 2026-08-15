import type { Message } from "../types.js";

export type ChatHistoryRole = "assistant" | "error" | "system" | "user";

export interface ChatHistoryStats {
    assistantMessages: number;
    messages: number;
    textCharacters: number;
    thinkingBlocks: number;
    toolCalls: number;
    toolResults: number;
    userMessages: number;
}

export interface ChatHistoryAgentSummary {
    agentId: string;
    description?: string;
    messageCount: number;
    path: string;
    status: string;
}

export interface ChatHistoryPage {
    agent: ChatHistoryAgentSummary;
    agents: readonly ChatHistoryAgentSummary[];
    cursor: number;
    matchedMessages: number;
    matchedStats: ChatHistoryStats;
    messages: readonly { message: Message; position: number }[];
    nextCursor?: number;
    previousCursor?: number;
    totalStats: ChatHistoryStats;
    totalMessages: number;
}

export interface ChatHistoryContext {
    read(options: {
        cursor?: number;
        from?: "end" | "start";
        limit: number;
        query?: string;
        roles?: readonly ChatHistoryRole[];
        target?: string;
    }): ChatHistoryPage;
}
