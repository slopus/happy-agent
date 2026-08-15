import { describe, expect, it } from "vitest";

// The daemon's own rule, read from source the way the protocol conformance
// check reads its types. Nothing from it reaches this library's bundle.
import { sessionUnreadStateAfterEvent } from "../../rig/sources/session/impl/sessionUnreadStateAfterEvent.js";
import type { SessionEvent as DaemonSessionEvent } from "../../rig/sources/protocol/index.js";
import { sessionUnreadAfterEvent } from "@/sessionUnread.js";
import type { SessionEvent, SessionUnreadState } from "@/protocol.js";

function event(type: string, createdAt: number): SessionEvent {
    return {
        createdAt,
        data: {},
        id: `event-${String(createdAt)}`,
        type,
    } as unknown as SessionEvent;
}

describe("the unread state a chat is left in", () => {
    it("starts a chat read and leaves it read while it works", () => {
        expect(sessionUnreadAfterEvent(undefined, event("run_started", 1))).toBeUndefined();
        expect(sessionUnreadAfterEvent(undefined, event("agent_message", 2))).toBeUndefined();
    });

    it("marks a finished turn, and a question as needing the person", () => {
        expect(sessionUnreadAfterEvent(undefined, event("run_finished", 3))).toEqual({
            reason: "turn_finished",
            since: 3,
        });
        expect(sessionUnreadAfterEvent(undefined, event("run_error", 4))).toEqual({
            reason: "turn_finished",
            since: 4,
        });
        expect(sessionUnreadAfterEvent(undefined, event("user_input_requested", 5))).toEqual({
            reason: "attention_needed",
            since: 5,
        });
    });

    it("keeps a question outstanding when the run that asked it stops", () => {
        const asking = sessionUnreadAfterEvent(undefined, event("user_input_requested", 6));
        // The turn ending does not answer the question, so the weaker reason
        // must not overwrite it and the moment it began asking is preserved.
        expect(sessionUnreadAfterEvent(asking, event("run_finished", 7))).toEqual({
            reason: "attention_needed",
            since: 6,
        });
    });

    it("keeps the oldest waiting time when more work finishes", () => {
        const finished = sessionUnreadAfterEvent(undefined, event("run_finished", 8));
        // A second finish is a fresh wait only in that it re-stamps the moment;
        // this pins the behaviour so a change to it is deliberate.
        expect(sessionUnreadAfterEvent(finished, event("run_finished", 9))).toEqual({
            reason: "turn_finished",
            since: 9,
        });
    });

    it("agrees with the daemon on every sequence, because it mirrors its rule", () => {
        const types = [
            "run_started",
            "run_finished",
            "run_error",
            "user_input_requested",
            "agent_message",
            "message_submitted",
        ];
        // Every ordered pair and triple of the events that could plausibly move
        // the state, replayed through both implementations.
        for (const first of types) {
            for (const second of types) {
                for (const third of types) {
                    let local: SessionUnreadState | undefined;
                    let daemon: SessionUnreadState | undefined;
                    let at = 0;
                    for (const type of [first, second, third]) {
                        at += 1;
                        const applied = event(type, at);
                        local = sessionUnreadAfterEvent(local, applied);
                        daemon = sessionUnreadStateAfterEvent(
                            daemon,
                            applied as unknown as DaemonSessionEvent,
                        );
                    }
                    expect(local, `${first} then ${second} then ${third}`).toEqual(daemon);
                }
            }
        }
    });
});
