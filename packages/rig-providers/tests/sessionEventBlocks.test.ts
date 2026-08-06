import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { committedSessionEvents } from "@/core/committedSessionEvents.js";

describe("committedSessionEvents", () => {
    it("discards reset blocks and keeps committed blocks", () => {
        const events: SessionEvent[] = [
            { type: "block_start" },
            { type: "text_delta", delta: "discarded" },
            { type: "block_reset" },
            { type: "retrying", attempt: 1, reason: "retry" },
            { type: "block_start" },
            { type: "text_delta", delta: "kept" },
            { type: "block_stop" },
            { type: "done", state: "normal" },
        ];

        expect(committedSessionEvents(events)).toEqual([
            { type: "retrying", attempt: 1, reason: "retry" },
            { type: "text_delta", delta: "kept" },
            { type: "done", state: "normal" },
        ]);
    });

    it("discards an unterminated block", () => {
        expect(
            committedSessionEvents([
                { type: "block_start" },
                { type: "toolcall_delta", callId: "call", delta: '{"cmd":' },
            ]),
        ).toEqual([]);
    });

    it("rejects nested and unmatched block boundaries", () => {
        expect(() =>
            committedSessionEvents([{ type: "block_start" }, { type: "block_start" }]),
        ).toThrow("A session event block is already open.");
        expect(() => committedSessionEvents([{ type: "block_stop" }])).toThrow(
            "No session event block is open.",
        );
    });
});
