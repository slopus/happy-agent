/**
 * `EX_UNAVAILABLE`: another process already serves this Happy home's socket. Starting again
 * cannot help until that process is gone, so neither the crash supervisor nor `start` retries it.
 */
export const AGENT_SOCKET_IN_USE_EXIT_CODE = 69;

/** A daemon found another process already listening on the socket it must bind. */
export class AgentSocketInUseError extends Error {
    readonly exitCode = AGENT_SOCKET_IN_USE_EXIT_CODE;

    constructor(readonly socketPath: string) {
        super(`Another process is already listening on ${socketPath}.`);
        this.name = "AgentSocketInUseError";
    }
}
