import type { SessionEvent } from "../index.js";
import { isTransientInferenceSessionEvent } from "./isTransientInferenceSessionEvent.js";

/**
 * Events that are delivered to attached clients but never written to the
 * durable event log.
 *
 * Inference stream updates are superseded by the completed message. Composer
 * drafts change on every keystroke burst and their latest value already lives
 * on the session row, so a client that reconnects reads the draft from the
 * session snapshot instead of replaying every intermediate edit. Activity and
 * Git state describe the current moment only, and their latest value already
 * lives on the session row an attaching client reads, so replaying every past
 * value would only be noise.
 */
export function isLiveOnlySessionEvent(event: SessionEvent): boolean {
    return (
        event.type === "session_draft_changed" ||
        event.type === "session_activity_changed" ||
        event.type === "session_context_changed" ||
        event.type === "session_git_changed" ||
        isTransientInferenceSessionEvent(event)
    );
}
