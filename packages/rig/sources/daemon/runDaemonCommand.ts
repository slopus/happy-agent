import { lstat } from "node:fs/promises";

import type { HappyAgentClient } from "@slopus/happy-agent-client";

import {
    ensureLocalProtocolServer,
    observeLocalProtocolServer,
} from "./ensureLocalProtocolServer.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

const DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;

export type DaemonCommand = "reload" | "start" | "status" | "stop";

/** Runs one `rig daemon` lifecycle command through the same downloaded/dev daemon path as Rig. */
export async function runDaemonCommand(
    command: DaemonCommand,
    log: (line: string) => void = console.log,
): Promise<void> {
    const paths = getHappyDaemonPaths();
    if (command === "start") {
        const connection = await ensureLocalProtocolServer();
        log(`Daemon is running at ${connection.paths.socketPath}`);
        log(`Daemon log: ${connection.paths.logPath}`);
        return;
    }

    const observed = await observeLocalProtocolServer(paths);
    if (command === "reload") {
        if (observed !== undefined)
            await stopLocalProtocolServer(observed.client, paths.socketPath);
        const connection = await ensureLocalProtocolServer();
        log(`Daemon is running at ${connection.paths.socketPath}`);
        log(`Daemon log: ${connection.paths.logPath}`);
        return;
    }

    if (command === "status") {
        if (observed === undefined) log("Daemon is not running.");
        else if (observed.health.ready) log(`Daemon is running at ${paths.socketPath}`);
        else log(`Daemon is starting at ${paths.socketPath}`);
        log(`Daemon log: ${paths.logPath}`);
        return;
    }

    if (observed === undefined) {
        log("Daemon is not running.");
        return;
    }
    await stopLocalProtocolServer(observed.client, paths.socketPath);
    log("Daemon is stopping.");
}

async function stopLocalProtocolServer(
    client: HappyAgentClient,
    socketPath: string,
): Promise<void> {
    try {
        await client.shutdown();
    } catch (error) {
        if (await waitForSocketRemoval(socketPath, DAEMON_SHUTDOWN_TIMEOUT_MS)) return;
        throw new Error(
            `Could not stop the existing local daemon: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!(await waitForSocketRemoval(socketPath, DAEMON_SHUTDOWN_TIMEOUT_MS))) {
        throw new Error("Timed out while waiting for the local daemon to release its socket.");
    }
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
