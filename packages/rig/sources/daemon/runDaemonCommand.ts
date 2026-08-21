import { lstat } from "node:fs/promises";

import type { HappyAgentClient } from "@slopus/happy-agent-client";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import { RigUserError } from "../RigUserError.js";
import { isTargetProcessAlive, waitForProcessExit } from "../processes/index.js";
import { killDaemonFromPidFile, readDaemonPid } from "./daemonPid.js";
import {
    ensureLocalProtocolServer,
    observeLocalProtocolServer,
} from "./ensureLocalProtocolServer.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

const DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;

export type DaemonCommand = "kill" | "reload" | "start" | "status" | "stop";

/** Runs one `rig daemon` lifecycle command through the same downloaded/dev daemon path as Rig. */
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
        if (observed !== undefined) await stopLocalProtocolServer(ctx, observed.client, paths);
        else await assertNoUnresponsiveDaemon(paths.pidPath);
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
): Promise<void> {
    let pid = await readDaemonPid(paths.pidPath);
    try {
        pid = (await client.shutdown()).pid;
    } catch (error) {
        const stopped = await waitForDaemonShutdown(ctx, paths.socketPath, pid);
        if (stopped.socketRemoved && stopped.processExited) return;
        throw new Error(
            `Could not stop the existing local daemon: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const stopped = await waitForDaemonShutdown(ctx, paths.socketPath, pid);
    if (!stopped.socketRemoved) {
        throw new Error("Timed out while waiting for the local daemon to release its socket.");
    }
    if (!stopped.processExited) {
        throw new Error(
            `Daemon process ${String(pid)} did not exit after releasing its socket. Run 'rig daemon kill' to force it to stop.`,
        );
    }
}

async function waitForDaemonShutdown(
    ctx: Context,
    socketPath: string,
    pid: number | undefined,
): Promise<{ readonly processExited: boolean; readonly socketRemoved: boolean }> {
    const [socketRemoved, processExited] = await Promise.all([
        waitForSocketRemoval(socketPath, DAEMON_SHUTDOWN_TIMEOUT_MS),
        pid === undefined
            ? Promise.resolve(true)
            : waitForProcessExit(ctx, pid, DAEMON_SHUTDOWN_TIMEOUT_MS),
    ]);
    return { processExited, socketRemoved };
}

async function assertNoUnresponsiveDaemon(pidPath: string): Promise<void> {
    const pid = await readDaemonPid(pidPath);
    if (pid === undefined || !isTargetProcessAlive(pid)) return;
    throw new RigUserError(`Daemon process ${String(pid)} is running but not responding.`, {
        hint: "Run 'rig daemon kill' to force it to stop.",
    });
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
