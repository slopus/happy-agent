import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { AgentDaemonError } from "./AgentDaemonError.js";
import { waitForDaemonProcessExit } from "./daemonPid.js";

const EXIT_TIMEOUT_MS = 5_000;

/**
 * Stops a Happy Agent that serves the socket but that this installation cannot reach: its crash
 * supervisor first, so it cannot restart the daemon, then the daemon with SIGTERM and, after a few
 * seconds, SIGKILL. Returns once the daemon is gone; the kernel closes its socket with it.
 */
export async function stopUnreachableAgentDaemon(daemon: {
    readonly pid: number;
    readonly supervisorPid?: number;
}): Promise<void> {
    if (daemon.supervisorPid !== undefined) await stop(daemon.supervisorPid);
    await stop(daemon.pid);
}

async function stop(pid: number): Promise<void> {
    signal(pid, "SIGTERM");
    if (await waitForDaemonProcessExit(pid, EXIT_TIMEOUT_MS)) return;
    signal(pid, "SIGKILL");
    if (!(await waitForDaemonProcessExit(pid, EXIT_TIMEOUT_MS))) {
        throw new AgentDaemonError(`Happy Agent process ${String(pid)} did not stop.`, {
            exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE,
        });
    }
}

function signal(pid: number, name: NodeJS.Signals): void {
    try {
        process.kill(pid, name);
    } catch {
        // The process may already have exited; the wait confirms it.
    }
}
