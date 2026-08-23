import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import type { HistoryBlock, HistoryMessage } from "../../sources/history/HistoryMessage.js";
import type { HistoryRecord } from "../../sources/history/HistoryStore.js";
import { createHistoryExcerpt } from "../../sources/history/impl/createHistoryExcerpt.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

function historyMessage(
    position: number,
    role: HistoryMessage["role"] = "user",
    blocks: readonly HistoryBlock[] = [{ type: "text", text: `message ${position}` }],
): HistoryMessage {
    return {
        role,
        blocks: [...blocks],
        recordId: `record-${position}`,
        at: position,
    };
}

function historyRecord(
    position: number,
    role: HistoryMessage["role"] = "user",
    blocks?: readonly HistoryBlock[],
): HistoryRecord {
    return { position, message: historyMessage(position, role, blocks) };
}

describe("HistoryModule.readExcerpt", () => {
    it("quotes both ends of a long history once, with the archive's exact totals", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-excerpt-two-ends");
        await database.ready;

        try {
            for (let index = 0; index < 240; index += 1) {
                await history.record(database.context, "agent-a", {
                    blocks: [{ text: `message-${index}`, type: "text" }],
                    recordId: `record-${index}`,
                    role: index % 2 === 0 ? "user" : "assistant",
                });
            }

            const excerpt = await history.readExcerpt(database.context, "agent-a", 32_000);
            if (excerpt === undefined) throw new Error("Expected an excerpt.");

            expect(excerpt.statsAreSampled).toBe(false);
            expect(excerpt.stats.messages).toBe(240);
            expect(excerpt.beginning).toContain("message-0");
            expect(excerpt.recent).toContain("message-239");
            // The middle is not shown: it is neither end of the conversation.
            expect(excerpt.beginning).not.toContain("message-120");
            expect(excerpt.recent).not.toContain("message-120");
        } finally {
            database.close();
        }
    });

    it("quotes a short history once even though both bounded reads cover all of it", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-excerpt-overlap");
        await database.ready;

        try {
            for (let index = 0; index < 3; index += 1) {
                await history.record(database.context, "agent-a", {
                    blocks: [{ text: `only-${index}`, type: "text" }],
                    recordId: `record-${index}`,
                    role: "user",
                });
            }

            const excerpt = await history.readExcerpt(database.context, "agent-a", 32_000);
            if (excerpt === undefined) throw new Error("Expected an excerpt.");

            const rendered = `${excerpt.beginning}\n${excerpt.recent}`;
            expect(rendered.match(/1\. USER/g)).toHaveLength(1);
            expect(rendered.match(/3\. USER/g)).toHaveLength(1);
            expect(excerpt.stats.messages).toBe(3);
        } finally {
            database.close();
        }
    });

    it("returns nothing for an agent that recorded nothing", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-excerpt-empty");
        await database.ready;

        try {
            await expect(
                history.readExcerpt(database.context, "silent-agent", 32_000),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("refuses an invalid identity or an out-of-bounds budget", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-excerpt-bounds");
        await database.ready;

        try {
            await expect(
                history.readExcerpt(database.context, "bad\nagent", 32_000),
            ).rejects.toThrow("invalid agent ID");
            await expect(history.readExcerpt(database.context, "agent-a", 0)).rejects.toThrow(
                "bounded positive integer",
            );
            await expect(
                history.readExcerpt(database.context, "agent-a", 1_000_000),
            ).rejects.toThrow("bounded positive integer");
        } finally {
            database.close();
        }
    });
});

describe("createHistoryExcerpt", () => {
    it("keeps the earliest four and latest eight records in source order", () => {
        const records = Array.from({ length: 15 }, (_, position) => historyRecord(position));
        const result = createHistoryExcerpt(records, 32_000);

        expect(result.beginning).toContain("1. USER");
        expect(result.beginning).toContain("4. USER");
        expect(result.beginning).not.toContain("5. USER");
        expect(result.recent).toContain("8. USER");
        expect(result.recent).toContain("15. USER");
        expect(result.recent).not.toContain("7. USER");
        expect(result.statsAreSampled).toBe(true);
        expect(result.stats.messages).toBe(15);
    });

    it("uses an archive-wide aggregate when one is supplied", () => {
        const records = [historyRecord(0), historyRecord(1, "assistant")];
        const exactStats = {
            assistantMessages: 10,
            messages: 20,
            textCharacters: 300,
            thinkingBlocks: 4,
            toolCalls: 3,
            toolResults: 2,
            userMessages: 10,
        };

        const result = createHistoryExcerpt(records, 32_000, exactStats);

        expect(result.stats).toEqual(exactStats);
        expect(result.statsAreSampled).toBe(false);
    });

    it("bounds the combined excerpt output", () => {
        const records = Array.from({ length: 20 }, (_, position) =>
            historyRecord(position, "user", [{ type: "text", text: "x".repeat(5_000) }]),
        );

        const result = createHistoryExcerpt(records, 500);

        expect(result.beginning.length + result.recent.length).toBeLessThanOrEqual(500);
        expect(result.beginning.length).toBeGreaterThan(0);
        expect(result.recent.length).toBeGreaterThan(0);
    });

    it("caps each rendered message before the excerpt budget is applied", () => {
        const result = createHistoryExcerpt(
            [historyRecord(0, "user", [{ type: "text", text: "x".repeat(5_000) }])],
            32_000,
        );

        expect(result.beginning.length).toBeLessThan(1_600);
        expect(result.beginning).toContain("[truncated");
    });

    it("formats all supported history block kinds for the handoff", () => {
        const blocks: HistoryBlock[] = [
            { type: "text", text: "visible" },
            { type: "thinking", thinking: "reasoned", redacted: true },
            { type: "image", mediaType: "image/png" },
            { type: "tool_call", callId: "call1", name: "lookup", arguments: { q: "x" } },
            {
                type: "tool_result",
                callId: "call1",
                toolName: "lookup",
                display: "looked up",
                output: "result",
                isError: true,
            },
        ];

        const result = createHistoryExcerpt([historyRecord(0, "assistant", blocks)], 32_000);

        expect(result.beginning).toContain("Text: visible");
        expect(result.beginning).toContain("Thinking: [redacted]");
        expect(result.beginning).toContain("[Image: image/png]");
        expect(result.beginning).toContain('Tool call: lookup {"q":"x"}');
        expect(result.beginning).toContain("Tool result: lookup (error)");
        expect(result.beginning).toContain("Output: result");
    });
});
