import type { ConnectionsUpdatedPayload } from "@slopus/happy-agent-client";

/** A safe gateway or roster failure; credentials never cross the API. */
export class RemoteConnectionError extends Error {
    constructor(
        readonly status: number,
        readonly code:
            | "remote_unavailable"
            | "remote_timeout"
            | "remote_sign_in_required"
            | "not_found"
            | "invalid_request"
            | "conflict"
            | "forbidden"
            | "unsupported"
            | "unauthorized",
        message: string,
        readonly current?: ConnectionsUpdatedPayload,
    ) {
        super(message);
        this.name = "RemoteConnectionError";
    }
}
