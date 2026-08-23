import { describe, expect, it } from "vitest";

import type { HistoryPage } from "../../sources/history/HistoryPage.js";
import { formatHistoryMessage, truncate } from "../../sources/history/impl/formatHistoryMessage.js";
import {
    formatHistoryPage,
    MAX_HISTORY_CHARACTERS,
} from "../../sources/history/impl/formatHistoryPage.js";
import { summarizeHistory } from "../../sources/history/impl/summarizeHistory.js";

function pageWithMessages(messages: HistoryPage["messages"]): HistoryPage {
    return {
        agentId: "agent-a",
        cursor: messages[0]?.position ?? 0,
        matchedMessages: messages.length,
        matchedStats: summarizeHistory(messages.map(({ message }) => message)),
        messages,
        totalMessages: messages.length,
        totalStats: summarizeHistory(messages.map(({ message }) => message)),
    };
}

describe("history rendering", () => {
    it("reports truncation without exceeding the requested limit", () => {
        expect(truncate("short", 10)).toBe("short");
        expect(truncate("0123456789", 10)).toBe("0123456789");
        expect(truncate("0123456789", 5)).toHaveLength(5);
        expect(truncate("0123456789", 5)).toBe("\n...[");
        expect(truncate("0123456789", 0)).toBe("");
    });

    it("renders attribution, images, redacted thinking, and optionally hides tool blocks", () => {
        const message = {
            at: 1,
            blocks: [
                { text: "visible", type: "text" as const },
                { mediaType: "image/png", type: "image" as const },
                { redacted: true, thinking: "secret", type: "thinking" as const },
                {
                    arguments: { path: "src" },
                    callId: "call1",
                    name: "read",
                    type: "tool_call" as const,
                },
                {
                    callId: "call1",
                    display: "Read one file.",
                    isError: true,
                    output: "permission denied",
                    toolName: "read",
                    type: "tool_result" as const,
                },
            ],
            model: "model-1",
            provider: "provider-1",
            recordId: "record-1",
            role: "agent" as const,
            senderAgentId: "agent-b",
        };

        const withTools = formatHistoryMessage(message, 7);
        expect(withTools).toContain("7. AGENT (agent-b) (provider-1, model-1)");
        expect(withTools).toContain("Text: visible");
        expect(withTools).toContain("[Image: image/png]");
        expect(withTools).toContain("Thinking: [redacted]");
        expect(withTools).toContain("Tool call: read");
        expect(withTools).toContain("Tool result: read (error)");
        expect(withTools).toContain("Summary: Read one file.");

        const withoutTools = formatHistoryMessage(message, 7, { includeTools: false });
        expect(withoutTools).not.toContain("Tool call:");
        expect(withoutTools).not.toContain("Tool result:");
    });

    it("bounds a large page from the beginning and reports exactly the consumed statistics", () => {
        const messages = Array.from({ length: 12 }, (_, index) => ({
            message: {
                blocks: [{ text: `${index}${"x".repeat(12_000)}`, type: "text" as const }],
                recordId: `record-${index}`,
                role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
            },
            position: index,
        }));
        const page = pageWithMessages(messages);

        const formatted = formatHistoryPage(page);

        expect(formatted.history.length).toBeLessThanOrEqual(MAX_HISTORY_CHARACTERS);
        expect(formatted.consumedMessages).toBeGreaterThan(0);
        expect(formatted.consumedMessages).toBeLessThan(messages.length);
        expect(formatted.startIndex).toBe(0);
        expect(formatted.stats).toEqual(
            summarizeHistory(
                messages.slice(0, formatted.consumedMessages).map(({ message }) => message),
            ),
        );
    });

    it("fills a large page from the end while keeping the selected output chronological", () => {
        const messages = Array.from({ length: 12 }, (_, index) => ({
            message: {
                blocks: [{ text: `${index}${"y".repeat(12_000)}`, type: "text" as const }],
                recordId: `record-${index}`,
                role: "assistant" as const,
            },
            position: index,
        }));
        const page = pageWithMessages(messages);

        const formatted = formatHistoryPage(page, { fromEnd: true });
        const firstSelected = formatted.startIndex;

        expect(formatted.history.length).toBeLessThanOrEqual(MAX_HISTORY_CHARACTERS);
        expect(formatted.consumedMessages).toBeGreaterThan(0);
        expect(firstSelected).toBeGreaterThan(0);
        expect(formatted.history.indexOf(`${firstSelected + 1}. ASSISTANT`)).toBeGreaterThanOrEqual(
            0,
        );
        expect(formatted.history.indexOf(`${messages.length}. ASSISTANT`)).toBeGreaterThan(
            formatted.history.indexOf(`${firstSelected + 1}. ASSISTANT`),
        );
        expect(formatted.stats).toEqual(
            summarizeHistory(messages.slice(firstSelected).map(({ message }) => message)),
        );
    });
});
