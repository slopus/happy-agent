import type { LiveSession } from "@slopus/happy-agent-client";

/** Only controlled, human-readable failures cross the Live HTTP boundary. */
export class LiveError extends Error {
    constructor(
        readonly status: number,
        readonly code:
            | "invalid_request"
            | "not_found"
            | "conflict"
            | "forbidden"
            | "live_unavailable"
            | "unsupported",
        message: string,
        readonly session?: LiveSession,
    ) {
        super(message);
        this.name = "LiveError";
    }
}
