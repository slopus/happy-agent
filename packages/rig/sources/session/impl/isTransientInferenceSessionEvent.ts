import type { SessionEvent } from "../../protocol/index.js";

export const TRANSIENT_INFERENCE_EVENT_TYPES = [
    "start",
    "block_start",
    "block_stop",
    "retrying",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    // A provider-run call leaves no trace in the assistant message, so only its progress is
    // disposable. Its completion stays durable, or reopening the session would lose the record
    // that the provider searched at all.
    "server_toolcall_start",
    "server_toolcall_delta",
    "done",
    "error",
    "tool_execution_progress",
    "tool_execution_status",
] as const;

const transientInferenceEventTypes = new Set<string>(TRANSIENT_INFERENCE_EVENT_TYPES);

export function isTransientInferenceSessionEvent(event: SessionEvent): boolean {
    if (event.type !== "agent_event") return false;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null || !("event" in data)) return false;
    const inferenceEvent: unknown = data.event;
    if (
        typeof inferenceEvent !== "object" ||
        inferenceEvent === null ||
        !("type" in inferenceEvent) ||
        typeof inferenceEvent.type !== "string"
    ) {
        return false;
    }
    return transientInferenceEventTypes.has(inferenceEvent.type);
}
