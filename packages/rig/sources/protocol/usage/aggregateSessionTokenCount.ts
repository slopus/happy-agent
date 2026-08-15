import type { SessionEvent, SessionTokenCount } from "../index.js";
import { sessionTokenCountAfterEvent } from "./sessionTokenCountAfterEvent.js";

export function aggregateSessionTokenCount(events: readonly SessionEvent[]): SessionTokenCount {
    let count: SessionTokenCount | undefined;
    const usageByIdentity = new Map<string, number>();

    for (const event of events) {
        if (event.type === "session_reset") usageByIdentity.clear();
        const identityAndUsage = usageIdentity(event);
        if (identityAndUsage !== undefined) {
            const [identity, totalTokens] = identityAndUsage;
            const previous = usageByIdentity.get(identity);
            if (previous !== undefined) {
                const current = count ?? { lastContextTokens: 0, totalTokens: 0 };
                count = {
                    lastContextTokens:
                        event.type === "agent_message" &&
                        event.data.message.role === "agent" &&
                        event.data.message.contextTokens !== undefined
                            ? event.data.message.contextTokens
                            : current.lastContextTokens,
                    totalTokens: Math.max(0, current.totalTokens - previous + totalTokens),
                };
                usageByIdentity.set(identity, totalTokens);
                continue;
            }
            usageByIdentity.set(identity, totalTokens);
        }
        count = sessionTokenCountAfterEvent(count, event);
    }

    return count ?? { lastContextTokens: 0, totalTokens: 0 };
}

function usageIdentity(event: SessionEvent): readonly [string, number] | undefined {
    if (
        event.type === "agent_message" &&
        (event.data.message.role === "agent" || event.data.message.role === "compaction") &&
        event.data.message.usage !== undefined
    ) {
        return [`message:${event.data.message.id}`, event.data.message.usage.totalTokens];
    }
    if (
        event.type === "agent_event" &&
        event.data.event.type === "permission_review" &&
        event.data.event.transcript !== undefined
    ) {
        return [`permission_review:${event.id}`, event.data.event.transcript.usage.totalTokens];
    }
    return undefined;
}
