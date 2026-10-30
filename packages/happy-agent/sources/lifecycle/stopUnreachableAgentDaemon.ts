import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { AgentDaemonError } from "./AgentDaemonError.js";
import { waitForDaemonProcessExit } from "./daemonPid.js";
import { recordDaemonStopIntent } from "./daemonStopIntent.js";

const SUPERVISOR_EXIT_TIMEOUT_MS = 5_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 5_000;
const FORCED_EXIT_TIMEOUT_MS = 5_000;

export interface UnreachableAgentDaemon {
    readonly pid: number;
    /** Its crash supervisor, stood down first so it cannot restart the daemon. */
    readonly supervisorPid?: number;
}

/**
 * Stops a Happy Agent that serves the socket but that this installation cannot reach: its
 * supervisor first, then the daemon with SIGTERM and, after a few seconds, SIGKILL. `force`
 * skips straight to SIGKILL, as `kill` does. Returns once the daemon process is gone; the kernel
 * closes its listening socket with it.
 */
export async function stopUnreachableAgentDaemon(
    daemon: UnreachableAgentDaemon,
    directory: string,
    options: { readonly force?: boolean } = {},
): Promise<void> {
    if (daemon.supervisorPid !== undefined && signal(daemon.supervisorPid, "SIGTERM")) {
        await waitForDaemonProcessExit(daemon.supervisorPid, SUPERVISOR_EXIT_TIMEOUT_MS);
    }
    // A supervisor that did not stand down still treats this exit as intended. The record names
    // only this PID, so leaving it behind never suppresses a later daemon's restart.
    try {
        recordDaemonStopIntent(directory, daemon.pid);
    } catch {
        // Its supervisor was already asked to stop; the record is a second guard.
    }
    if (
        options.force !== true &&
        (!signal(daemon.pid, "SIGTERM") ||
            (await waitForDaemonProcessExit(daemon.pid, GRACEFUL_EXIT_TIMEOUT_MS)))
    ) {
        return;
    }
    signal(daemon.pid, "SIGKILL");
    if (!(await waitForDaemonProcessExit(daemon.pid, FORCED_EXIT_TIMEOUT_MS))) {
        throw new AgentDaemonError(`Happy Agent process ${String(daemon.pid)} did not stop.`, {
            exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE,
        });
    }
}

/** Whether the signal was delivered; a process that is already gone needs none. */
function signal(pid: number, name: NodeJS.Signals): boolean {
    try {
        process.kill(pid, name);
        return true;
    } catch {
        return false;
    }
}
