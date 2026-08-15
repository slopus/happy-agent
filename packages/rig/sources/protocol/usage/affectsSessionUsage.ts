import type { SessionEvent } from "../index.js";

export function affectsSessionUsage(event: SessionEvent): boolean {
    if (event.type === "agent_event") {
        return (
            event.data.event.type === "permission_review" ||
            event.data.event.type === "context_compacted"
        );
    }
    return (
        event.type === "agent_message" ||
        event.type === "session_configuration_changed" ||
        event.type === "session_created" ||
        event.type === "session_reset" ||
        event.type === "session_rewound"
    );
}
