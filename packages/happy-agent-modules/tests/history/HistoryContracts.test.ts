import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import {
    historyAgentSummarySchema,
    historyAgentSummariesSchema,
    historyAgentTargetSchema,
} from "../../sources/history/HistoryAgent.js";
import { historyPageSchema, historyQuerySchema } from "../../sources/history/HistoryPage.js";
import {
    summarizeHistory,
    historyStatsSchema,
} from "../../sources/history/impl/summarizeHistory.js";
import {
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
} from "../../sources/history/HistoryMessage.js";

describe("history public contracts", () => {
    it("counts every message and block type without conflating agent/system roles", () => {
        const stats = summarizeHistory([
            {
                blocks: [
                    { text: "hello", type: "text" },
                    { thinking: "reason", type: "thinking" },
                    {
                        arguments: { path: "src" },
                        callId: "call",
                        name: "read",
                        type: "tool_call",
                    },
                    {
                        callId: "call",
                        output: "done",
                        toolName: "read",
                        type: "tool_result",
                    },
                ],
                recordId: "assistant",
                role: "assistant",
            },
            {
                blocks: [{ text: "user", type: "text" }],
                recordId: "user",
                role: "user",
            },
            {
                blocks: [{ text: "error", type: "text" }],
                recordId: "error",
                role: "error",
            },
        ]);

        expect(stats).toEqual({
            assistantMessages: 1,
            messages: 3,
            textCharacters: 20,
            thinkingBlocks: 1,
            toolCalls: 1,
            toolResults: 1,
            userMessages: 1,
        });
        expect(Value.Check(historyStatsSchema, stats)).toBe(true);
    });

    it("validates target summaries and rejects unbounded or line-breaking host values", () => {
        const summary = {
            agentId: "agent-a",
            description: "Auditor",
            messageCount: 2,
            path: "/root/audit",
            status: "working",
        };
        expect(Value.Check(historyAgentSummarySchema, summary)).toBe(true);
        expect(Value.Check(historyAgentSummariesSchema, [summary])).toBe(true);
        expect(
            Value.Check(historyAgentSummarySchema, {
                ...summary,
                path: "bad\npath",
            }),
        ).toBe(false);
        expect(
            Value.Check(historyAgentSummarySchema, {
                ...summary,
                status: "",
            }),
        ).toBe(false);
        expect(Value.Check(historyAgentTargetSchema, "x".repeat(1_025))).toBe(false);
    });

    it("validates query shapes and empty pages at the runtime boundary", () => {
        expect(Value.Check(historyQuerySchema, { cursor: 0, limit: 1 })).toBe(true);
        expect(Value.Check(historyQuerySchema, { cursor: 0, from: "start", limit: 1 })).toBe(true);
        // The semantic cursor/from conflict is rejected by the selector and module operation,
        // since TypeBox validates shape rather than relationships between optional fields.
        expect(
            Value.Check(historyPageSchema, {
                agentId: "agent-a",
                cursor: 0,
                matchedMessages: 0,
                matchedStats: {
                    assistantMessages: 0,
                    messages: 0,
                    textCharacters: 0,
                    thinkingBlocks: 0,
                    toolCalls: 0,
                    toolResults: 0,
                    userMessages: 0,
                },
                messages: [],
                totalMessages: 0,
                totalStats: {
                    assistantMessages: 0,
                    messages: 0,
                    textCharacters: 0,
                    thinkingBlocks: 0,
                    toolCalls: 0,
                    toolResults: 0,
                    userMessages: 0,
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(historyQuerySchema, {
                limit: 0,
            }),
        ).toBe(false);
    });

    it("accepts only Base-generated CUID2 identities for durable tool blocks", () => {
        expect(
            Value.Check(historyToolCallBlockSchema, {
                type: "tool_call",
                callId: "basecall1",
                name: "read",
            }),
        ).toBe(true);
        expect(
            Value.Check(historyToolResultBlockSchema, {
                type: "tool_result",
                callId: "basecall1",
                toolName: "read",
            }),
        ).toBe(true);
        expect(
            Value.Check(historyToolCallBlockSchema, {
                type: "tool_call",
                callId: "provider_call-1",
                name: "read",
            }),
        ).toBe(false);
    });
});
