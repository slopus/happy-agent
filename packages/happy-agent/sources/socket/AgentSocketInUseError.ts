import { AgentDaemonError } from "../lifecycle/AgentDaemonError.js";

/**
 * `EX_UNAVAILABLE`: another process already serves this Happy home's socket. Starting again
 * cannot help until that process is gone, so neither the crash supervisor nor `start` retries it.
 */
export const AGENT_SOCKET_IN_USE_EXIT_CODE = 69;

/** A daemon found another process already listening on the socket it must bind. */
export class AgentSocketInUseError extends AgentDaemonError {
    constructor(socketPath: string) {
        super(`Another process is already listening on ${socketPath}.`, {
            hint: "Run 'happy-agent start', which replaces a Happy Agent this installation can no longer reach.",
            exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE,
        });
        this.name = "AgentSocketInUseError";
    }
}
