import { lstat } from "node:fs/promises";

import {
    HappyAgentApiError,
    type DrainWaitingAgent,
    type DrainWaitingFor,
    type HappyAgentClient,
} from "@slopus/happy-agent-client";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import { isTargetProcessAlive, waitForProcessExit } from "../processes/index.js";
import { killDaemonFromPidFile, readDaemonPid } from "./daemonPid.js";
import {
    ensureLocalProtocolServer,
    observeLocalProtocolServer,
} from "./ensureLocalProtocolServer.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

const DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_INTERVAL_MS = 100;
/**
 * Agent work owns the drain for as long as it needs, but an HTTP mutation finishes in moments.
 * One that does not is a daemon bug, and it must not leave a stop waiting forever.
 */
const DRAIN_MUTATION_TIMEOUT_MS = 30_000;

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
            await stopLocalProtocolServer(ctx, observed.client, paths, log);
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
            log(
                observed.health.draining === true
                    ? `Daemon is draining at ${paths.socketPath}`
                    : `Daemon is running at ${paths.socketPath}`,
            );
            log(`Daemon PID: ${String(pid ?? "unknown")}`);
            if (observed.health.draining === true) {
                log(formatDrainProgress(observed.health.drainWaitingFor ?? []));
            }
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
    await stopLocalProtocolServer(ctx, observed.client, paths, log);
    log("Daemon stopped.");
}

async function stopLocalProtocolServer(
    ctx: Context,
    client: HappyAgentClient,
    paths: ReturnType<typeof getHappyDaemonPaths>,
    report: (message: string) => void,
): Promise<void> {
    let pid = await readDaemonPid(paths.pidPath);
    await drainLocalProtocolServer(client, report);
    let requestError: unknown;
    try {
        pid = (await client.shutdown()).pid;
    } catch (error) {
        requestError = error;
    }
    const stopped = await waitForDaemonShutdown(
        ctx,
        paths.socketPath,
        pid,
        DAEMON_SHUTDOWN_TIMEOUT_MS,
    );
    if (stopped.socketRemoved && stopped.processExited) return;
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

async function drainLocalProtocolServer(
    client: HappyAgentClient,
    report: (message: string) => void,
): Promise<void> {
    try {
        await client.drain();
    } catch (error: unknown) {
        if (error instanceof HappyAgentApiError && (error.status === 403 || error.status === 404)) {
            report("This daemon does not support draining; stopping it directly.");
            return;
        }
        throw error;
    }
    let previous: string | undefined;
    let stalledSince: number | undefined;
    for (;;) {
        const health = await client.getHealth();
        const waiting = health.drainWaitingFor ?? [];
        const current = JSON.stringify(waiting);
        const changed = current !== previous;
        if (changed) {
            report(formatDrainProgress(waiting));
            previous = current;
        }
        if (waiting.length === 0) return;
        if (waiting.every((wait) => wait.name === "api-mutations")) {
            if (changed || stalledSince === undefined) stalledSince = Date.now();
            if (Date.now() - stalledSince >= DRAIN_MUTATION_TIMEOUT_MS) {
                report(formatDrainGaveUp(waiting));
                return;
            }
        } else {
            stalledSince = undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
    }
}

function formatDrainGaveUp(waiting: readonly DrainWaitingFor[]): string {
    return (
        `Stopping anyway: ${waiting.map(formatDrainWait).join("; ")} did not finish within ` +
        `${String(Math.round(DRAIN_MUTATION_TIMEOUT_MS / 1000))} seconds.`
    );
}

function formatDrainProgress(waiting: readonly DrainWaitingFor[]): string {
    if (waiting.length === 0) return "Daemon drain is complete.";
    return `Draining: ${waiting.map(formatDrainWait).join("; ")}.`;
}

function formatDrainWait(wait: DrainWaitingFor): string {
    const noun =
        wait.name === "api-mutations"
            ? plural(wait.count, "API mutation")
            : wait.name === "agent-system"
              ? plural(wait.count, "agent")
              : wait.name === "auto-agent-system"
                ? plural(wait.count, "permission reviewer")
                : `${String(wait.count)} ${wait.name.replaceAll("-", " ")}`;
    if (wait.agents === undefined || wait.agents.length === 0) return noun;
    const agents = wait.agents.map((agent) => `${agent.id}: ${stageLabel(agent.stage)}`).join(", ");
    return `${noun} (${agents}${wait.truncated === true ? ", …" : ""})`;
}

function stageLabel(stage: DrainWaitingAgent["stage"]): string {
    return stage === "tools" ? "tool calls" : stage;
}

function plural(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
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
