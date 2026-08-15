import { describe, expect, it } from "vitest";
import type { Message, UserMessage } from "../../agent/types.js";
import type { SessionEvent } from "../../protocol/index.js";
import {
    sessionTranscriptWindow,
    transcriptRunFacts,
    type TranscriptEntry,
    type TranscriptRunFacts,
} from "../sessionTranscriptWindow.js";

function sessionEvent(type: string, createdAt: number, data: unknown): SessionEvent {
    return { createdAt, data, id: `event-${String(createdAt)}`, sessionId: "s1", type } as never;
}

function userMessage(id: string): UserMessage {
    return { blocks: [{ text: id, type: "text" }], id, role: "user" };
}

function agentMessage(id: string): Message {
    return { blocks: [{ text: id, type: "text" }], id, role: "agent" };
}

/** A turn of one prompt and one reply, plus `toolCalls` extra agent messages. */
function turn(runId: string, toolCalls = 0): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [{ message: userMessage(`${runId}-u`), runId }];
    for (let index = 0; index < toolCalls; index += 1) {
        entries.push({ message: agentMessage(`${runId}-t${index}`), runId });
    }
    entries.push({ message: agentMessage(`${runId}-a`), runId });
    return entries;
}

/** The newest turns, which always exist when no page anchor is given. */
function newest(
    entries: readonly TranscriptEntry[],
    runFacts: ReadonlyMap<string, TranscriptRunFacts>,
    turnLimit: number,
) {
    const window = sessionTranscriptWindow(entries, runFacts, turnLimit);
    if (window === undefined) throw new Error("The newest turns are always available.");
    return window;
}

describe("sessionTranscriptWindow", () => {
    it("records stable inference groups and their exact boundaries", async () => {
        const facts = transcriptRunFacts([
            sessionEvent("run_started", 10, { runId: "run-1" }),
            sessionEvent("agent_event", 20, {
                event: { iteration: 1, messageId: "message-1", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            // A second reach for the model inside the same answer. It is one
            // thing the user asked for, so it does not open a second group.
            sessionEvent("agent_event", 25, {
                event: { iteration: 2, messageId: "message-1b", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            sessionEvent("steering_applied", 30, {
                messageIds: ["steer-1"],
                runId: "run-1",
            }),
            sessionEvent("agent_event", 40, {
                event: { iteration: 3, messageId: "message-2", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            sessionEvent("run_finished", 50, {
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            }),
        ]);

        expect(facts.get("run-1")?.groups).toEqual([
            {
                endedAt: 30,
                id: "message-1",
                outcome: "success",
                reason: "steering",
                startedAt: 20,
            },
            {
                endedAt: 50,
                id: "message-2",
                outcome: "success",
                reason: "completed",
                startedAt: 40,
            },
        ]);
        expect(newest(turn("run-1"), facts, 20).turns[0]?.groups).toEqual(
            facts.get("run-1")?.groups,
        );
    });

    it("closes a group at compaction, the same as it does at steering", async () => {
        const facts = transcriptRunFacts([
            sessionEvent("run_started", 10, { runId: "run-1" }),
            sessionEvent("agent_event", 20, {
                event: { iteration: 1, messageId: "message-1", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            sessionEvent("agent_event", 30, {
                event: {
                    compactionId: "c1",
                    estimatedTokensBefore: 100,
                    type: "context_compaction_started",
                },
                runId: "run-1",
            }),
            sessionEvent("agent_event", 31, {
                event: {
                    compactedMessageCount: 4,
                    compactionId: "c1",
                    estimatedTokensAfter: 40,
                    type: "context_compacted",
                },
                runId: "run-1",
            }),
            sessionEvent("agent_event", 32, {
                event: {
                    compactionId: "c1",
                    status: "completed",
                    type: "context_compaction_finished",
                },
                runId: "run-1",
            }),
            sessionEvent("agent_event", 40, {
                event: { iteration: 2, messageId: "message-2", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            sessionEvent("run_finished", 50, {
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            }),
        ]);

        // The compaction is durable history as a message, so only where the
        // boundary fell is recorded here.
        expect(facts.get("run-1")?.boundaryGroupIds).toEqual({ c1: "message-1" });
        expect(facts.get("run-1")?.groups).toEqual([
            {
                endedAt: 30,
                id: "message-1",
                outcome: "success",
                reason: "compaction",
                startedAt: 20,
            },
            {
                endedAt: 50,
                id: "message-2",
                outcome: "success",
                reason: "completed",
                startedAt: 40,
            },
        ]);
    });

    it("records which group a steering message closes", async () => {
        // The clock cannot say: a boundary and the group it opens routinely
        // share a millisecond.
        const facts = transcriptRunFacts([
            sessionEvent("run_started", 10, { runId: "run-1" }),
            sessionEvent("agent_event", 20, {
                event: { iteration: 1, messageId: "message-1", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            sessionEvent("steering_applied", 20, { messageIds: ["steer-1"], runId: "run-1" }),
            sessionEvent("agent_event", 20, {
                event: { iteration: 2, messageId: "message-2", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            sessionEvent("run_finished", 30, {
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            }),
        ]);

        expect(facts.get("run-1")?.boundaryGroupIds).toEqual({ "steer-1": "message-1" });
    });

    it("groups contiguous messages of one run into a single turn", async () => {
        const window = newest(turn("run-1", 2), new Map(), 20);

        expect(window.turns).toHaveLength(1);
        expect(window.turns[0]?.messageIds).toEqual(["run-1-u", "run-1-t0", "run-1-t1", "run-1-a"]);
        expect(window.complete).toBe(true);
    });

    it("keeps runs whole when their messages interleave", async () => {
        const entries: TranscriptEntry[] = [
            { message: userMessage("run-1-u"), runId: "run-1" },
            { message: userMessage("run-2-u"), runId: "run-2" },
            { message: agentMessage("run-1-a"), runId: "run-1" },
            { message: agentMessage("run-2-a"), runId: "run-2" },
        ];

        const window = newest(entries, new Map(), 20);

        expect(window.turns.map((item) => item.runId)).toEqual(["run-1", "run-2"]);
        expect(window.turns[0]?.messageIds).toEqual(["run-1-u", "run-1-a"]);
        expect(window.turns[1]?.messageIds).toEqual(["run-2-u", "run-2-a"]);
        expect(window.messages.map((message) => message.id)).toEqual([
            "run-1-u",
            "run-2-u",
            "run-1-a",
            "run-2-a",
        ]);
    });

    it("keeps only the most recent turns when the conversation is longer", async () => {
        const entries = Array.from({ length: 50 }, (_, index) => turn(`run-${index}`)).flat();

        const window = newest(entries, new Map(), 20);

        expect(window.turns).toHaveLength(20);
        expect(window.turns[0]?.runId).toBe("run-30");
        expect(window.turns.at(-1)?.runId).toBe("run-49");
        expect(window.complete).toBe(false);
    });

    it("never splits a turn, so a long turn arrives whole", async () => {
        // The oldest turn is dropped entirely; the newest is 40 messages and is
        // kept intact rather than trimmed to fit a message budget.
        const entries = [...turn("run-old"), ...turn("run-big", 38)];

        const window = newest(entries, new Map(), 1);

        expect(window.turns).toHaveLength(1);
        expect(window.turns[0]?.messageIds).toHaveLength(40);
        expect(window.messages).toHaveLength(40);
        expect(window.messages.every((message: Message) => message.id.startsWith("run-big"))).toBe(
            true,
        );
    });

    it("reports the transcript complete when every turn fits", async () => {
        const entries = [...turn("run-1"), ...turn("run-2")];

        expect(newest(entries, new Map(), 20).complete).toBe(true);
    });

    it("carries the timing and outcome of each retained turn", async () => {
        const facts = new Map<string, TranscriptRunFacts>([
            ["run-1", { endedAt: 90, outcome: "success", startedAt: 10 }],
            ["run-2", { endedAt: 260, errorMessage: "Boom", outcome: "error", startedAt: 200 }],
        ]);

        const window = newest([...turn("run-1"), ...turn("run-2")], facts, 20);

        expect(window.turns[0]).toMatchObject({ endedAt: 90, outcome: "success", startedAt: 10 });
        expect(window.turns[1]).toMatchObject({ errorMessage: "Boom", outcome: "error" });
    });

    it("carries durable inference errors as messages in their turn", async () => {
        const error: Message = {
            attempt: 2,
            blocks: [{ text: "Connection lost", type: "text" }],
            id: "retry-1",
            outcome: "retried",
            role: "error",
        };
        const facts = transcriptRunFacts([
            sessionEvent("run_started", 10, { runId: "run-1" }),
            sessionEvent("agent_event", 20, {
                event: { iteration: 1, messageId: "message-1", type: "inference_iteration_start" },
                runId: "run-1",
            }),
            sessionEvent("agent_message", 50, { message: error, runId: "run-1" }),
        ]);
        const window = newest(
            [...turn("run-1"), { createdAt: 50, message: error, runId: "run-1" }],
            facts,
            20,
        );

        expect(window.messages).toContainEqual(error);
        expect(window.messageGroupId).toEqual({ "retry-1": "message-1" });
        expect(window.turns[0]?.messageIds).toContain("retry-1");
    });

    it("carries each message's own occurrence time", async () => {
        const entries = turn("run-1").map((entry, index) => ({
            ...entry,
            createdAt: 100 + index * 25,
            eventId: `event-${String(index)}`,
            ...(index === 0 ? { steeredAt: 120 } : {}),
        }));

        const window = newest(entries, new Map(), 20);

        expect(window.messageCreatedAt).toEqual({
            "run-1-a": 125,
            "run-1-u": 100,
        });
        expect(window.messageEventId).toEqual({
            "run-1-a": "event-1",
            "run-1-u": "event-0",
        });
        expect(window.messageSteeredAt).toEqual({ "run-1-u": 120 });
    });

    it("leaves a still-running turn without an end", async () => {
        const facts = new Map<string, TranscriptRunFacts>([["run-1", { startedAt: 10 }]]);

        const window = newest(turn("run-1"), facts, 20);

        expect(window.turns[0]?.endedAt).toBeUndefined();
        expect(window.turns[0]?.outcome).toBeUndefined();
    });

    it("omits messages the model needs but a reader must never see", async () => {
        const entries: TranscriptEntry[] = [
            { message: { ...userMessage("hidden"), internal: true }, runId: "run-1" },
            ...turn("run-1"),
        ];

        const window = newest(entries, new Map(), 20);

        expect(window.messages.map((message: Message) => message.id)).not.toContain("hidden");
    });

    it("keeps messages with no run of their own from joining a neighbouring turn", async () => {
        const entries: TranscriptEntry[] = [
            { message: userMessage("loose-1") },
            { message: userMessage("loose-2") },
        ];

        const window = newest(entries, new Map(), 20);

        expect(window.turns).toHaveLength(2);
    });
});

describe("paging back through a transcript", () => {
    const entries = Array.from({ length: 50 }, (_, index) => turn(`run-${index}`)).flat();

    it("returns the turns immediately before the anchor", async () => {
        const page = sessionTranscriptWindow(entries, new Map(), 20, "run-30");

        // The anchor is the oldest turn the caller already has, so the page ends
        // just before it and never repeats it.
        expect(page?.turns.map((item) => item.runId)).toEqual(
            Array.from({ length: 20 }, (_, index) => `run-${10 + index}`),
        );
        expect(page?.complete).toBe(false);
    });

    it("reports reaching the beginning of the conversation", async () => {
        const page = sessionTranscriptWindow(entries, new Map(), 20, "run-5");

        expect(page?.turns.map((item) => item.runId)).toEqual(
            Array.from({ length: 5 }, (_, index) => `run-${index}`),
        );
        // Everything older has been delivered, so a reader is at the start and
        // must not be asked to page again.
        expect(page?.complete).toBe(true);
    });

    it("returns an empty and complete page at the very beginning", async () => {
        const page = sessionTranscriptWindow(entries, new Map(), 20, "run-0");

        expect(page?.turns).toEqual([]);
        expect(page?.complete).toBe(true);
    });

    it("refuses an anchor the transcript no longer has", async () => {
        // A rewind can remove the turn a reader was paging from. Returning the
        // newest turns instead would look like a successful page and duplicate
        // the conversation.
        expect(sessionTranscriptWindow(entries, new Map(), 20, "run-gone")).toBeUndefined();
    });

    it("carries only the messages of the turns it returns", async () => {
        const page = sessionTranscriptWindow(entries, new Map(), 2, "run-30");

        expect(page?.messages.map((message) => message.id)).toEqual([
            "run-28-u",
            "run-28-a",
            "run-29-u",
            "run-29-a",
        ]);
    });
});
