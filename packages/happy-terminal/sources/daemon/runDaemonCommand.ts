import { lstat } from "node:fs/promises";

import type { HappyAgentClient } from "@slopus/happy-agent-client";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import { isTargetProcessAlive, waitForProcessExit } from "../processes/index.js";
import {
    killDaemonFromPidFile,
    killDaemonProcess,
    readDaemonPid,
    removeDaemonPid,
} from "./daemonPid.js";
import {
    ensureLocalProtocolServer,
    observeLocalProtocolServer,
} from "./ensureLocalProtocolServer.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

const DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;
const DAEMON_RELOAD_GRACE_TIMEOUT_MS = 5_000;

export type DaemonCommand = "kill" | "reload" | "start" | "status" | "stop";

/** Runs one `happy daemon` lifecycle command through the same downloaded/dev daemon path as Happy Terminal. */
export async function runDaemonCommand(
    command: DaemonCommand,
    log: (line: string) => void = console.log,
    ctx: Context = createRootContext().named("daemon-command"),
): Promise<void> {
    const paths = getHappyDaemonPaths();
    if (command === "start") {
        const connection = await ensureLocalProtocolServer();
        log(`Daemon is running at ${connection.paths.socketPath}`);
        log(`Daemon PID: ${String((await readDaemonPid(connection.paths.pidPath)) ?? "unknown")}`);
        log(`Daemon log: ${connection.paths.logPath}`);
        log(`Shutdown log: ${connection.paths.observationLogPath}`);
        return;
    }

    if (command === "kill") {
        const result = await killDaemonFromPidFile(ctx, paths.pidPath);
        if (!result.killed) {
            log("Daemon is not running.");
            return;
        }
        log(`Daemon process ${String(result.pid)} was killed.`);
        return;
    }

    const observed = await observeLocalProtocolServer(paths);
    if (command === "reload") {
        if (observed !== undefined) {
            await stopLocalProtocolServer(ctx, observed.client, paths, {
                forceAfterMs: DAEMON_RELOAD_GRACE_TIMEOUT_MS,
                onForce: log,
            });
        } else await assertNoUnresponsiveDaemon(paths.pidPath);
        const connection = await ensureLocalProtocolServer();
        log(`Daemon is running at ${connection.paths.socketPath}`);
        log(`Daemon PID: ${String((await readDaemonPid(connection.paths.pidPath)) ?? "unknown")}`);
        log(`Daemon log: ${connection.paths.logPath}`);
        log(`Shutdown log: ${connection.paths.observationLogPath}`);
        return;
    }

    if (command === "status") {
        const pid = await readDaemonPid(paths.pidPath);
        if (observed === undefined) {
            if (pid !== undefined && isTargetProcessAlive(pid)) {
                log(`Daemon process ${String(pid)} is running but not responding.`);
            } else {
                log("Daemon is not running.");
            }
        } else if (observed.health.ready) {
            log(`Daemon is running at ${paths.socketPath}`);
            log(`Daemon PID: ${String(pid ?? "unknown")}`);
        } else {
            log(`Daemon is starting at ${paths.socketPath}`);
            log(`Daemon PID: ${String(pid ?? "unknown")}`);
        }
        log(`Daemon log: ${paths.logPath}`);
        log(`Shutdown log: ${paths.observationLogPath}`);
        return;
    }

    if (observed === undefined) {
        await assertNoUnresponsiveDaemon(paths.pidPath);
        log("Daemon is not running.");
        return;
    }
    log("Daemon is stopping.");
    await stopLocalProtocolServer(ctx, observed.client, paths);
    log("Daemon stopped.");
}

async function stopLocalProtocolServer(
    ctx: Context,
    client: HappyAgentClient,
    paths: ReturnType<typeof getHappyDaemonPaths>,
    options: {
        readonly forceAfterMs?: number;
        readonly onForce?: (message: string) => void;
    } = {},
): Promise<void> {
    let pid = await readDaemonPid(paths.pidPath);
    let requestError: unknown;
    try {
        pid = (await client.shutdown()).pid;
    } catch (error) {
        requestError = error;
    }
    const timeoutMs = options.forceAfterMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
    const stopped = await waitForDaemonShutdown(ctx, paths.socketPath, pid, timeoutMs);
    if (stopped.socketRemoved && stopped.processExited) return;
    if (options.forceAfterMs !== undefined && pid !== undefined) {
        options.onForce?.(
            `Daemon did not stop gracefully; forcing process ${String(pid)} to exit.`,
        );
        if (!stopped.processExited) await killDaemonProcess(ctx, pid);
        await removeDaemonPid(paths.pidPath, pid);
        return;
    }
    if (requestError !== undefined) {
        throw new Error(
            `Could not stop the existing local daemon: ${requestError instanceof Error ? requestError.message : String(requestError)}`,
        );
    }
    if (!stopped.socketRemoved) {
        throw new Error("Timed out while waiting for the local daemon to release its socket.");
    }
    if (!stopped.processExited) {
        throw new Error(
            `Daemon process ${String(pid)} did not exit after releasing its socket. Run 'happy daemon kill' to force it to stop.`,
        );
    }
}

async function waitForDaemonShutdown(
    ctx: Context,
    socketPath: string,
    pid: number | undefined,
    timeoutMs: number,
): Promise<{ readonly processExited: boolean; readonly socketRemoved: boolean }> {
    const [socketRemoved, processExited] = await Promise.all([
        waitForSocketRemoval(socketPath, timeoutMs),
        pid === undefined ? Promise.resolve(true) : waitForProcessExit(ctx, pid, timeoutMs),
    ]);
    return { processExited, socketRemoved };
}

async function assertNoUnresponsiveDaemon(pidPath: string): Promise<void> {
    const pid = await readDaemonPid(pidPath);
    if (pid === undefined || !isTargetProcessAlive(pid)) return;
    throw new HappyTerminalUserError(
        `Daemon process ${String(pid)} is running but not responding.`,
        {
            hint: "Run 'happy daemon kill' to force it to stop.",
        },
    );
}

async function waitForSocketRemoval(socketPath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await lstat(socketPath);
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
}
