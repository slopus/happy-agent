import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { AgentDaemonError } from "./AgentDaemonError.js";
import { waitForDaemonProcessExit } from "./daemonPid.js";
import { recordDaemonStopIntent } from "./daemonStopIntent.js";

const EXIT_TIMEOUT_MS = 5_000;

/**
 * Stops a Happy Agent that serves the socket but that this installation cannot reach: its crash
 * supervisor first, so it cannot restart the daemon, then the daemon with SIGTERM and, after a few
 * seconds, SIGKILL. Returns once the daemon is gone; the kernel closes its socket with it.
 */
export async function stopUnreachableAgentDaemon(
    daemon: { readonly pid: number; readonly supervisorPid?: number },
    directory: string,
): Promise<void> {
    if (daemon.supervisorPid !== undefined && signal(daemon.supervisorPid, "SIGTERM")) {
        await waitForDaemonProcessExit(daemon.supervisorPid, EXIT_TIMEOUT_MS);
    }
    // A supervisor that did not stand down still treats this exit as intended. The record names
    // only this PID, so leaving it behind never suppresses a later daemon's restart.
    try {
        recordDaemonStopIntent(directory, daemon.pid);
    } catch {
        // Its supervisor was already asked to stop; the record is a second guard.
    }
    if (
        !signal(daemon.pid, "SIGTERM") ||
        (await waitForDaemonProcessExit(daemon.pid, EXIT_TIMEOUT_MS))
    ) {
        return;
    }
    signal(daemon.pid, "SIGKILL");
    if (!(await waitForDaemonProcessExit(daemon.pid, EXIT_TIMEOUT_MS))) {
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
