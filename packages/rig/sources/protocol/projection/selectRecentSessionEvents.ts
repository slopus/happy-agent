import type { SessionEvent } from "../index.js";

function isTranscriptMessage(event: SessionEvent): boolean {
    return event.type === "message_submitted" || event.type === "agent_message";
}

export function selectRecentSessionEvents(
    events: readonly SessionEvent[],
    messageLimit: number | undefined,
): readonly SessionEvent[] {
    if (messageLimit === undefined) return events;

    let remainingMessages = messageLimit;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (!isTranscriptMessage(events[index]!)) continue;
        remainingMessages -= 1;
        if (remainingMessages === 0) return events.slice(index);
    }
    return events;
}
