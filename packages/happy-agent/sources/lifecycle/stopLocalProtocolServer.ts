import type { HappyAgentClient } from "@slopus/happy-agent-client";

import { readDaemonPid, waitForDaemonProcessExit } from "./daemonPid.js";
import type { HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { waitForSocketRemoval } from "./waitForSocketRemoval.js";

const DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;

export async function stopLocalProtocolServer(
    client: HappyAgentClient,
    paths: Pick<HappyDaemonPaths, "pidPath" | "socketPath"> | string,
): Promise<void> {
    const socketPath = typeof paths === "string" ? paths : paths.socketPath;
    let pid = typeof paths === "string" ? undefined : await readDaemonPid(paths.pidPath);
    try {
        pid = (await client.shutdown()).pid;
    } catch (error) {
        const stopped = await waitForDaemonShutdown(socketPath, pid);
        if (stopped.socketRemoved && stopped.processExited) {
            return;
        }
        throw new Error(`Could not stop the existing local daemon: ${errorToMessage(error)}`);
    }
    const stopped = await waitForDaemonShutdown(socketPath, pid);
    if (!stopped.socketRemoved) {
        throw new Error(
            "Timed out while waiting for the existing local daemon to release its socket. A replacement was not started.",
        );
    }
    if (!stopped.processExited) {
        throw new Error(
            `Daemon process ${String(pid)} did not exit after releasing its socket. Run 'happy-agent kill' to force it to stop.`,
        );
    }
}

async function waitForDaemonShutdown(
    socketPath: string,
    pid: number | undefined,
): Promise<{ readonly processExited: boolean; readonly socketRemoved: boolean }> {
    const [socketRemoved, processExited] = await Promise.all([
        waitForSocketRemoval(socketPath, DAEMON_SHUTDOWN_TIMEOUT_MS),
        pid === undefined
            ? Promise.resolve(true)
            : waitForDaemonProcessExit(pid, DAEMON_SHUTDOWN_TIMEOUT_MS),
    ]);
    return { processExited, socketRemoved };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
