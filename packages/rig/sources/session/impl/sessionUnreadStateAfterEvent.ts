import type { SessionEvent, SessionUnreadState } from "../../protocol/index.js";

export function sessionUnreadStateAfterEvent(
    current: SessionUnreadState | undefined,
    event: SessionEvent,
): SessionUnreadState | undefined {
    if (event.type === "user_input_requested") {
        return { reason: "attention_needed", since: event.createdAt };
    }
    if (event.type !== "run_finished" && event.type !== "run_error") return current;
    if (current?.reason === "attention_needed") return current;
    return { reason: "turn_finished", since: event.createdAt };
}
