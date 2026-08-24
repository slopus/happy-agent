import { describe, expect, it } from "vitest";

import type { HistoryMessage } from "../../sources/history/index.js";
import { HappyMessageMapper } from "../../sources/happy/index.js";
import type { HappySessionProtocolMessage } from "../../sources/happy/HappyProtocol.js";

let ordinal = 0;

function historyMessage(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
    ordinal += 1;
    return {
        at: 1_000,
        blocks: [{ text: "hello", type: "text" }],
        recordId: `msg-${String(ordinal)}`,
        role: "user",
        ...overrides,
    };
}

function mapHistory(messages: readonly HistoryMessage[]): readonly HappySessionProtocolMessage[] {
    return new HappyMessageMapper().mapHistory(messages);
}

/** Every assertion here is about the protocol the phone receives. */
function shown(
    messages: readonly HappySessionProtocolMessage[],
): HappySessionProtocolMessage["content"][] {
    return messages.map((message) => message.content);
}

function text(messages: readonly HappySessionProtocolMessage[], index = 0): string {
    const event = shown(messages)[index]?.ev;
    if (event === undefined || !("text" in event)) throw new Error("That message carried no text.");
    return event.text;
}

describe("mapping archived Happy history", () => {
    it("carries what a person said and what the agent answered, oldest first", () => {
        const queued = mapHistory([
            historyMessage({ at: 1, blocks: [{ text: "fix the tests", type: "text" }] }),
            historyMessage({
                at: 2,
                blocks: [{ text: "they pass now", type: "text" }],
                role: "assistant",
            }),
        ]);

        expect(shown(queued)).toEqual([
            {
                ev: { t: "text", text: "fix the tests" },
                id: expect.any(String),
                role: "user",
                time: 1,
            },
            {
                ev: { t: "text", text: "they pass now" },
                id: expect.any(String),
                role: "agent",
                time: 2,
                turn: expect.any(String),
            },
        ]);
    });

    it("gives every agent-side history event the stable turn the phone requires", () => {
        const queued = mapHistory([
            historyMessage({ recordId: "user-1", role: "user", runId: "run-1" }),
            historyMessage({ recordId: "answer-1", role: "assistant", runId: "run-1" }),
            historyMessage({
                blocks: [
                    {
                        arguments: { path: "README.md" },
                        callId: "call-1",
                        name: "Read",
                        type: "tool_call",
                    },
                    {
                        callId: "call-1",
                        display: "Read complete",
                        toolName: "Read",
                        type: "tool_result",
                    },
                ],
                recordId: "tools-1",
                role: "assistant",
                runId: "run-1",
            }),
        ]);

        expect(queued[0]?.content.turn).toBeUndefined();
        expect(queued.slice(1).map((message) => message.content.turn)).toEqual([
            "history:run-1",
            "history:run-1",
            "history:run-1",
        ]);
    });

    it("identifies each message by the archive record it came from", () => {
        const queued = mapHistory([historyMessage({ recordId: "record-7" })]);

        expect(queued[0]?.localId).toBe("rig:history:record-7");
        expect(shown(queued)[0]?.id).toBe("history:record-7");
        expect(queued[0]?.meta).toEqual({ sentFrom: "rig" });
    });

    it("replays the same conversation to the same identities, so nothing is shown twice", () => {
        const messages = [historyMessage(), historyMessage({ role: "assistant" })];

        expect(mapHistory(messages).map((message) => message.localId)).toEqual(
            mapHistory(messages).map((message) => message.localId),
        );
    });

    it("shows anything that is neither person nor model as a service note", () => {
        const queued = mapHistory([
            historyMessage({ blocks: [{ text: "session resumed", type: "text" }], role: "system" }),
        ]);

        expect(shown(queued)[0]?.ev).toEqual({ t: "service", text: "session resumed" });
        expect(shown(queued)[0]?.role).toBe("agent");
    });

    it("leaves out an operational message and Happy's own echo", () => {
        expect(
            mapHistory([
                historyMessage({ hideFromUser: true }),
                historyMessage({ remoteMessageId: "remote-1" }),
            ]),
        ).toEqual([]);
    });

    it("leaves out a message that amounts to no words", () => {
        expect(
            mapHistory([
                historyMessage({ blocks: [] }),
                historyMessage({ blocks: [{ text: "   ", type: "text" }] }),
                historyMessage({ blocks: [{ thinking: "   ", type: "thinking" }] }),
                historyMessage({ blocks: [{ mediaType: "image/png", type: "image" }] }),
            ]),
        ).toEqual([]);
    });

    it("names a tool the agent used without repeating what it was given", () => {
        const queued = mapHistory([
            historyMessage({
                recordId: "tool-message",
                blocks: [
                    { text: "checking the config", type: "text" },
                    {
                        arguments: { path: "/etc/hosts" },
                        callId: "call-1",
                        name: "Read",
                        type: "tool_call",
                    },
                    {
                        callId: "call-1",
                        display: "Read complete",
                        toolName: "Read",
                        type: "tool_result",
                    },
                ],
                role: "assistant",
            }),
        ]);

        expect(shown(queued)).toEqual([
            {
                ev: { t: "text", text: "checking the config" },
                id: "history:tool-message",
                role: "agent",
                time: 1_000,
                turn: "history:tool-message",
            },
            {
                ev: {
                    args: { path: "/etc/hosts" },
                    call: "call-1",
                    description: "Running Read",
                    name: "Read",
                    t: "tool-call-start",
                    title: "Read",
                },
                id: "history:tool-message:1",
                role: "agent",
                time: 1_000,
                turn: "history:tool-message",
            },
            {
                ev: { call: "call-1", result: "Read complete", t: "tool-call-end" },
                id: "history:tool-message:2",
                role: "agent",
                time: 1_000,
                turn: "history:tool-message",
            },
        ]);
    });

    it("leaves private reasoning out without disturbing the visible message identity", () => {
        const queued = mapHistory([
            historyMessage({
                recordId: "thinking-message",
                blocks: [
                    { thinking: "they probably mean the other file", type: "thinking" },
                    { text: "Fixed.", type: "text" },
                ],
                role: "assistant",
            }),
        ]);

        expect(shown(queued)).toEqual([
            {
                ev: { t: "text", text: "Fixed." },
                id: "history:thinking-message",
                role: "agent",
                time: 1_000,
                turn: "history:thinking-message",
            },
        ]);
    });

    it("truncates a message too long to be worth scrolling", () => {
        const queued = mapHistory([
            historyMessage({ blocks: [{ text: "x".repeat(9_000), type: "text" }] }),
        ]);

        expect(text(queued)).toHaveLength(4_001);
        expect(text(queued).endsWith("…")).toBe(true);
    });

    it("keeps the newest 50 protocol messages in their original order", () => {
        const messages = Array.from({ length: 60 }, (_, index) =>
            historyMessage({
                at: index,
                blocks: [{ text: `message ${String(index + 1)}`, type: "text" }],
                recordId: `record-${String(index + 1)}`,
            }),
        );

        const queued = new HappyMessageMapper().mapHistory(messages, 50);

        expect(queued).toHaveLength(50);
        expect(text(queued, 0)).toBe("message 11");
        expect(text(queued, 49)).toBe("message 60");
        expect(queued[0]?.localId).toBe("rig:history:record-11");
    });

    it("dates a message the archive never dated, rather than refusing it", () => {
        const { at: _at, ...undated } = historyMessage();

        expect(shown(mapHistory([undated]))[0]?.time).toBe(0);
    });
});
