import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import {
    historyBlockSchema,
    historyMessageSchema,
    historyMessageWithinPersistenceBounds,
    historyToolArgumentsSchema,
    historyToolArgumentsWithinByteLimit,
    MAX_HISTORY_ARGUMENT_DEPTH,
    MAX_HISTORY_BLOCKS_PER_MESSAGE,
    MAX_HISTORY_MESSAGE_JSON_BYTES,
    MAX_HISTORY_REMOTE_MESSAGE_ID_LENGTH,
    MAX_HISTORY_TEXT_LENGTH,
} from "../../sources/history/HistoryMessage.js";
import { historyStoreSchema } from "../../sources/history/HistoryStore.js";

function validMessage() {
    return {
        blocks: [{ text: "hello", type: "text" as const }],
        recordId: "record-1",
        role: "assistant" as const,
    };
}

describe("history runtime bounds and contracts", () => {
    it("retains exact requested arguments that must fail execution instead of acceptance", () => {
        const argumentsValue = {
            body: "x".repeat(1_010_000),
            values: Array.from({ length: 300 }, () => null),
        };
        const block = {
            type: "tool_call",
            callId: "requestedcall1",
            name: "exec_command",
            arguments: argumentsValue,
        };
        expect(historyToolArgumentsWithinByteLimit(argumentsValue)).toBe(false);
        expect(historyMessageWithinPersistenceBounds({ ...validMessage(), blocks: [block] })).toBe(
            false,
        );
        expect(
            historyMessageWithinPersistenceBounds({
                ...validMessage(),
                blocks: [{ ...block, requested: true }],
            }),
        ).toBe(true);
    });

    it("accepts a minimal message and rejects malformed identities, timestamps, and blocks", () => {
        expect(Value.Check(historyMessageSchema, validMessage())).toBe(true);
        expect(
            Value.Check(historyMessageSchema, {
                ...validMessage(),
                recordId: "bad\nid",
            }),
        ).toBe(false);
        expect(
            Value.Check(historyMessageSchema, {
                ...validMessage(),
                at: -1,
            }),
        ).toBe(false);
        expect(
            Value.Check(historyMessageSchema, {
                ...validMessage(),
                blocks: [{ text: "hello", type: "text", unexpected: true }],
            }),
        ).toBe(false);
        expect(
            Value.Check(historyBlockSchema, {
                mediaType: "",
                type: "image",
            }),
        ).toBe(false);
        expect(
            Value.Check(historyMessageSchema, {
                ...validMessage(),
                remoteMessageId: "r".repeat(MAX_HISTORY_REMOTE_MESSAGE_ID_LENGTH + 1),
            }),
        ).toBe(false);
        expect(
            Value.Check(historyMessageSchema, {
                ...validMessage(),
                hideFromUser: "yes",
            }),
        ).toBe(false);
    });

    it("enforces both container depth and UTF-8 byte size for tool arguments", () => {
        let withinDepth: unknown = "leaf";
        for (let index = 0; index < MAX_HISTORY_ARGUMENT_DEPTH; index += 1) {
            withinDepth = { nested: withinDepth };
        }
        let beyondDepth: unknown = withinDepth;
        beyondDepth = { nested: beyondDepth };

        expect(Value.Check(historyToolArgumentsSchema, withinDepth)).toBe(true);
        expect(historyToolArgumentsWithinByteLimit(withinDepth)).toBe(true);
        expect(Value.Check(historyToolArgumentsSchema, beyondDepth)).toBe(false);
        expect(historyToolArgumentsWithinByteLimit(beyondDepth)).toBe(false);

        const unicodeValue = "🙂".repeat(300_000);
        expect(unicodeValue.length).toBeLessThanOrEqual(1_000_000);
        expect(historyToolArgumentsWithinByteLimit({ unicodeValue })).toBe(false);
    });

    it("enforces array, object-property, and object-key bounds", () => {
        const withinArray = Array.from({ length: 256 }, () => null);
        const beyondArray = Array.from({ length: 257 }, () => null);
        expect(historyToolArgumentsWithinByteLimit(withinArray)).toBe(true);
        expect(Value.Check(historyToolArgumentsSchema, beyondArray)).toBe(false);

        const withinObject = Object.fromEntries(
            Array.from({ length: 256 }, (_, index) => [`key-${index}`, null]),
        );
        const beyondObject = Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`key-${index}`, null]),
        );
        expect(historyToolArgumentsWithinByteLimit(withinObject)).toBe(true);
        expect(Value.Check(historyToolArgumentsSchema, beyondObject)).toBe(false);

        const longKey = { ["k".repeat(257)]: null };
        expect(Value.Check(historyToolArgumentsSchema, longKey)).toBe(false);
    });

    it("enforces the final serialized-message byte ceiling after per-field limits", () => {
        const largeText = "x".repeat(MAX_HISTORY_TEXT_LENGTH - 1);
        const blockCount = Math.ceil(MAX_HISTORY_MESSAGE_JSON_BYTES / MAX_HISTORY_TEXT_LENGTH) + 1;
        const blocks = Array.from({ length: blockCount }, (_, index) => ({
            text: `${index}${largeText}`,
            type: "text" as const,
        }));
        expect(blocks.length).toBeLessThanOrEqual(MAX_HISTORY_BLOCKS_PER_MESSAGE);
        const message = {
            ...validMessage(),
            blocks,
        };

        expect(JSON.stringify(message)!.length).toBeGreaterThan(MAX_HISTORY_MESSAGE_JSON_BYTES);
        expect(historyMessageWithinPersistenceBounds(message)).toBe(false);
    });

    it("rejects too many blocks even when each block is individually valid", () => {
        const blocks = Array.from({ length: MAX_HISTORY_BLOCKS_PER_MESSAGE + 1 }, () => ({
            text: "",
            type: "text" as const,
        }));
        expect(historyMessageWithinPersistenceBounds({ ...validMessage(), blocks })).toBe(false);
    });

    it("requires both store operations and rejects extra store capabilities", () => {
        const validStore = {
            append: async () => undefined,
            read: async () => undefined,
        };
        expect(Value.Check(historyStoreSchema, validStore)).toBe(true);
        expect(Value.Check(historyStoreSchema, { append: validStore.append })).toBe(false);
        expect(
            Value.Check(historyStoreSchema, {
                ...validStore,
                delete: async () => undefined,
            }),
        ).toBe(false);
    });

    it("does not confuse the schema's character limits with the message byte limit", () => {
        const text = "é".repeat(MAX_HISTORY_TEXT_LENGTH);
        expect(text.length).toBe(MAX_HISTORY_TEXT_LENGTH);
        expect(
            Value.Check(historyMessageSchema, {
                ...validMessage(),
                blocks: [{ text, type: "text" as const }],
            }),
        ).toBe(true);
        expect(
            historyMessageWithinPersistenceBounds({
                ...validMessage(),
                blocks: [{ text, type: "text" as const }],
            }),
        ).toBe(true);
    });
});
