/** A safe gateway failure; transport diagnostics and credentials never cross the API. */
export class RemoteConnectionError extends Error {
    constructor(
        readonly status: number,
        readonly code:
            | "remote_unavailable"
            | "remote_timeout"
            | "remote_busy"
            | "not_found"
            | "unauthorized",
        message: string,
    ) {
        super(message);
        this.name = "RemoteConnectionError";
    }
}
