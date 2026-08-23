import { describe, expect, it } from "vitest";

import {
    historyMessageSearchParts,
    messageMatchesHistoryFilters,
} from "../../sources/history/impl/messageMatchesHistoryFilters.js";
import { selectHistoryPage } from "../../sources/history/impl/selectHistoryPage.js";
import type { HistoryMessage } from "../../sources/history/HistoryMessage.js";
import type { HistoryRecord } from "../../sources/history/HistoryPage.js";

function record(
    position: number,
    recordId: string,
    role: HistoryMessage["role"],
    text: string,
    extra: Partial<HistoryMessage> = {},
): HistoryRecord {
    return {
        message: {
            blocks: [{ text, type: "text" }],
            recordId,
            role,
            ...extra,
        },
        position,
    };
}

describe("history selection", () => {
    it("filters before paging and keeps cursors tied to sparse source positions", () => {
        const records = [
            record(10, "r10", "user", "unrelated"),
            record(20, "r20", "assistant", "needle one"),
            record(30, "r30", "user", "unrelated"),
            record(40, "r40", "assistant", "needle two"),
            record(50, "r50", "error", "unrelated"),
            record(60, "r60", "assistant", "needle three"),
        ];

        const first = selectHistoryPage(records, {
            limit: 2,
            query: "NEEDLE",
        });
        expect(first.messages.map(({ position }) => position)).toEqual([20, 40]);
        expect(first.cursor).toBe(20);
        expect(first.nextCursor).toBe(60);
        expect(first.previousCursor).toBeUndefined();
        expect(first.matchedMessages).toBe(3);
        expect(first.totalMessages).toBe(6);

        if (first.nextCursor === undefined) throw new Error("Expected a continuation cursor");
        const second = selectHistoryPage(records, {
            cursor: first.nextCursor,
            limit: 2,
            query: "needle",
        });
        expect(second.messages.map(({ position }) => position)).toEqual([60]);
        expect(second.cursor).toBe(60);
        expect(second.nextCursor).toBeUndefined();
        expect(second.previousCursor).toBe(20);
    });

    it("returns an older-page cursor when a cursor is beyond the final match", () => {
        const records = [
            record(100, "r100", "user", "first"),
            record(200, "r200", "assistant", "second"),
            record(300, "r300", "assistant", "third"),
        ];

        const page = selectHistoryPage(records, {
            cursor: 999,
            limit: 2,
            query: "second",
        });

        expect(page.messages).toEqual([]);
        expect(page.cursor).toBe(999);
        expect(page.previousCursor).toBe(200);
        expect(page.nextCursor).toBeUndefined();
    });

    it("supports a reverse read while retaining chronological output and a previous cursor", () => {
        const records = Array.from({ length: 5 }, (_, index) =>
            record(index * 10, `r${index}`, "assistant", `message ${index}`),
        );

        const page = selectHistoryPage(records, { from: "end", limit: 2 });

        expect(page.messages.map(({ position }) => position)).toEqual([30, 40]);
        expect(page.cursor).toBe(30);
        expect(page.previousCursor).toBe(10);
        expect(page.nextCursor).toBeUndefined();
    });

    it("treats role filters and literal wildcard characters consistently", () => {
        const records = [
            record(0, "r0", "assistant", "100% done"),
            record(1, "r1", "user", "100_percent done"),
            record(2, "r2", "assistant", "not a match"),
        ];

        const percent = selectHistoryPage(records, {
            limit: 10,
            query: "100%",
            roles: ["assistant"],
        });
        expect(percent.messages.map(({ message }) => message.recordId)).toEqual(["r0"]);

        const underscore = selectHistoryPage(records, {
            limit: 10,
            query: "100_",
            roles: ["user"],
        });
        expect(underscore.messages.map(({ message }) => message.recordId)).toEqual(["r1"]);
    });

    it("searches tool arguments, display text, output, images, and thinking", () => {
        const message: HistoryMessage = {
            blocks: [
                {
                    arguments: { secret: "argument needle" },
                    callId: "call1",
                    name: "search",
                    type: "tool_call",
                },
                {
                    callId: "call1",
                    display: "display needle",
                    output: "output needle",
                    toolName: "search",
                    type: "tool_result",
                },
                { mediaType: "image/needle", type: "image" },
                { thinking: "thinking needle", type: "thinking" },
            ],
            recordId: "r",
            role: "assistant",
        };

        expect(messageMatchesHistoryFilters(message, { query: "argument needle" })).toBe(true);
        expect(messageMatchesHistoryFilters(message, { query: "display needle" })).toBe(true);
        expect(messageMatchesHistoryFilters(message, { query: "output needle" })).toBe(true);
        expect(messageMatchesHistoryFilters(message, { query: "image/needle" })).toBe(true);
        expect(messageMatchesHistoryFilters(message, { query: "thinking needle" })).toBe(true);
        expect(historyMessageSearchParts(message).join("\n")).toContain("argument needle");
    });

    it("folds Unicode text with one shared rule", () => {
        const message = record(0, "r", "assistant", "CAFÉ Straße");

        expect(messageMatchesHistoryFilters(message.message, { query: "café straße" })).toBe(true);
        expect(messageMatchesHistoryFilters(message.message, { query: "CAFÉ STRASSE" })).toBe(
            false,
        );
    });

    it("rejects unstable records and contradictory paging inputs", () => {
        const valid = record(0, "r0", "user", "valid");

        expect(() =>
            selectHistoryPage(
                [valid, { ...valid, position: 0, message: { ...valid.message, recordId: "r1" } }],
                {
                    limit: 1,
                },
            ),
        ).toThrow("unstable");
        expect(() =>
            selectHistoryPage([valid, { ...valid, position: 1 }], {
                limit: 1,
            }),
        ).toThrow("unstable");
        expect(() =>
            selectHistoryPage([valid], {
                cursor: 0,
                from: "start",
                limit: 1,
            }),
        ).toThrow("either cursor or from");
        expect(() => selectHistoryPage([valid], { limit: 0 })).toThrow();
    });

    it("does not mutate the source record list while selecting", () => {
        const records = [
            record(10, "r10", "assistant", "ten"),
            record(20, "r20", "assistant", "twenty"),
        ];
        const before = structuredClone(records);

        selectHistoryPage(records, { from: "end", limit: 1 });

        expect(records).toEqual(before);
    });
});
