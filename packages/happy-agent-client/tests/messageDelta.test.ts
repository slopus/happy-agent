import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { applyMessageDelta } from "../sources/applyMessageDelta.js";
import { messageDeltaPayloadSchema } from "../sources/protocol/events.js";
import {
    type AgentMessage,
    clientMetadataSchema,
    type MessageHistoryResponse,
    messageHistoryResponseSchema,
    type UserMessage,
} from "../sources/protocol/messages.js";

const message: AgentMessage = {
    content: [
        { text: "Hello, world", type: "text" },
        {
            arguments: { command: "pwd" },
            id: "stable-call-id",
            name: "exec_command",
            status: "running",
            type: "tool_call",
        },
    ],
    createdAt: 1,
    id: "message1",
    metadata: {},
    role: "agent",
};

function delta(offset: number, append: string) {
    return {
        agentId: "agent1",
        append,
        blockIndex: 0,
        messageId: message.id,
        offset,
        runId: "run1",
    };
}

describe("message delta application", () => {
    it("converges a history snapshot with duplicate and overlapping replay", () => {
        const toolCall = message.content[1];

        const duplicate = applyMessageDelta(message, delta(5, ", world"));
        expect(duplicate).toEqual({ append: "", kind: "replayed", message });
        if (duplicate.kind !== "replayed") throw new Error("Expected duplicate replay.");

        expect(applyMessageDelta(duplicate.message, delta(12, "")).kind).toBe("applied");

        const overlap = applyMessageDelta(duplicate.message, delta(7, "world!"));
        expect(overlap.kind).toBe("applied");
        if (overlap.kind !== "applied") throw new Error("Expected overlap to apply.");
        expect(overlap.append).toBe("!");
        expect(overlap.message.content[0]).toEqual({ text: "Hello, world!", type: "text" });
        expect(overlap.message.content[1]).toBe(toolCall);

        const appended = applyMessageDelta(overlap.message, delta(13, " Done"));
        expect(appended.kind).toBe("applied");
        if (appended.kind !== "applied") throw new Error("Expected append to apply.");

        const replayed = applyMessageDelta(appended.message, delta(13, " Done"));
        expect(replayed.kind).toBe("replayed");
        if (replayed.kind !== "replayed") throw new Error("Expected append to replay.");
        expect(replayed.message.content[0]).toEqual({
            text: "Hello, world! Done",
            type: "text",
        });
        expect(replayed.message.content[1]).toBe(toolCall);
    });

    it("requests authoritative reconciliation for a genuine gap or conflict", () => {
        expect(applyMessageDelta(message, delta(13, " missed"))).toEqual({
            kind: "reconcile",
        });
        expect(applyMessageDelta(message, delta(7, "WORLD"))).toEqual({
            kind: "reconcile",
        });
    });

    it("exposes runtime schemas for the new cursor and offset fields", () => {
        const history = {
            cursor: "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
            hasMore: false,
            runs: [],
        } satisfies MessageHistoryResponse;

        expect(Value.Check(messageHistoryResponseSchema, history)).toBe(true);
        expect(Value.Check(messageHistoryResponseSchema, { hasMore: false, runs: [] })).toBe(false);
        expect(Value.Check(messageDeltaPayloadSchema, delta(0, "Hello"))).toBe(true);
        expect(Value.Check(messageDeltaPayloadSchema, { ...delta(0, "Hello"), offset: -1 })).toBe(
            false,
        );
    });

    it("types and validates freeform client-owned user-message metadata", () => {
        const clientMetadata = {
            composer: "mobile",
            localDraft: { revision: 4, tags: ["auth", null] },
        };
        const user: UserMessage = {
            clientMetadata,
            content: [{ text: "Fix it", type: "text" }],
            createdAt: 1,
            delivery: "queue",
            id: "message2",
            metadata: {},
            mode: {
                effort: "medium",
                modelId: "model1",
                permissionMode: "auto",
                providerId: "provider1",
                serviceTier: null,
            },
            role: "user",
            runId: null,
            status: "pending",
        };

        expect(user.clientMetadata).toEqual(clientMetadata);
        expect(Value.Check(clientMetadataSchema, clientMetadata)).toBe(true);
        expect(Value.Check(clientMetadataSchema, ["not", "an", "object"])).toBe(false);
    });
});
