import { HappyAgentClient, type HealthResponse } from "@slopus/happy-agent-client";

import { AgentDaemonError } from "./AgentDaemonError.js";
import { assertReloadCallerOutsideDaemon } from "./assertReloadCallerOutsideDaemon.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { isDaemonProcessRunning, killDaemonFromPidFile, readDaemonPid } from "./daemonPid.js";
import { consumeDaemonStopIntent, recordDaemonStopIntent } from "./daemonStopIntent.js";
import { describeDaemonSupervisor, standDownDaemonSupervisor } from "./daemonSupervisorControl.js";
import { readDaemonTokenIfPresent } from "./daemonToken.js";
import { drainDaemonFromSignal } from "./drainDaemonFromSignal.js";
import { ensureAgentDaemon } from "./ensureAgentDaemon.js";
import { getDaemonIdentity } from "./getDaemonIdentity.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { startReloadStatus } from "./reloadStatus.js";
import {
    drainLocalProtocolServer,
    formatDrainProgress,
    stopLocalProtocolServer,
} from "./stopLocalProtocolServer.js";

export type AgentDaemonCommand = "drain" | "kill" | "reload" | "start" | "stop" | "status";

export function isAgentDaemonCommand(value: string | undefined): value is AgentDaemonCommand {
    return (
        value === "start" ||
        value === "stop" ||
        value === "status" ||
        value === "reload" ||
        value === "drain" ||
        value === "kill"
    );
}

export interface RunAgentDaemonCommandOptions {
    /** The daemon entrypoint handed to {@link ensureAgentDaemon} when a daemon must be spawned. */
    entrypoint?: string;
    log?: (line: string) => void;
    /**
     * Where timed reload phase lines go. They are diagnostics for a log file, not messages for a
     * person, so a reload run in a terminal leaves them out.
     */
    diagnostics?: (line: string) => void;
    /** Test-only: run a started daemon inside the calling process instead of spawning one. */
    runInProcess?: boolean;
}

/** Runs one daemon lifecycle command and reports the outcome in human-readable lines. */
export async function runAgentDaemonCommand(
    command: AgentDaemonCommand,
    options: RunAgentDaemonCommandOptions = {},
): Promise<void> {
    const log = options.log ?? ((line: string) => console.log(line));
    const paths = getHappyDaemonPaths();
    if (command === "drain") {
        if (process.platform === "win32") {
            const connection = await connectToExistingDaemon();
            if (connection === undefined)
                throw new AgentDaemonError("The daemon is unavailable; no drain was performed.");
            await drainLocalProtocolServer(connection.client, log);
            log("The daemon is drained and still running.");
        } else {
            await drainDaemonFromSignal(paths, log);
        }
        return;
    }
    const ensureOptions = {
        ...(options.entrypoint === undefined ? {} : { entrypoint: options.entrypoint }),
        ...(options.runInProcess === undefined ? {} : { runInProcess: options.runInProcess }),
    };

    if (command === "start") {
        const connection = await ensureAgentDaemon({
            confirmRestart: async () => true,
            ...ensureOptions,
        });
        log(`Daemon is running at ${connection.paths.socketPath}`);
        log(`Daemon PID: ${String((await readDaemonPid(connection.paths.pidPath)) ?? "unknown")}`);
        log(`Daemon log: ${connection.paths.logPath}`);
        log(`Shutdown log: ${connection.paths.observationLogPath}`);
        return;
    }

    if (command === "kill") {
        // The crash supervisor goes first, so it cannot restart the daemon being killed.
        await standDownDaemonSupervisor(paths.directory);
        const recordedPid = await readDaemonPid(paths.pidPath).catch(() => undefined);
        if (recordedPid !== undefined && (await isDaemonProcessRunning(recordedPid))) {
            try {
                recordDaemonStopIntent(paths.directory, recordedPid);
            } catch {
                // The supervisor was already stood down above; the record is a second guard.
            }
        }
        const result = await killDaemonFromPidFile(paths.pidPath);
        if (recordedPid !== undefined) {
            // The supervisor was already stood down; the record has nothing left to explain.
            await consumeDaemonStopIntent(paths.directory, recordedPid);
        }
        if (!result.killed) {
            log("Daemon is not running.");
            return;
        }
        log(`Daemon process ${String(result.pid)} was killed.`);
        return;
    }

    const connection = await connectToExistingDaemon();
    if (command === "reload") {
        if (connection !== undefined) {
            await assertReloadCallerOutsideDaemon(await readDaemonPid(paths.pidPath));
        } else {
            await assertNoUnresponsiveDaemon(paths.pidPath);
            // A supervisor waiting to restart a crashed daemon would compete with the reload.
            await standDownDaemonSupervisor(paths.directory);
        }
        // Clients that did not start this reload read its phases from reload.json.
        const status = startReloadStatus(paths, {
            firstPhase: connection === undefined ? "starting" : "draining",
            log: options.diagnostics ?? (() => undefined),
            version: getDaemonIdentity().version,
        });
        let reloaded: Awaited<ReturnType<typeof ensureAgentDaemon>>;
        try {
            if (connection !== undefined) {
                await recordStopIntentForRecordedDaemon(paths);
                const targetVersion = getDaemonIdentity().version;
                await stopLocalProtocolServer(connection.client, paths, {
                    // The replacement is this command's own executable, so its version is known.
                    drain: {
                        cause:
                            connection.health.version.daemon === targetVersion
                                ? "reload"
                                : "update",
                        intent: "restart",
                        targetVersion,
                    },
                    onDrainProgress: log,
                    onDrainWaiting: (waiting) => status.draining(waiting),
                    onStopping: () => status.phase("stopping"),
                    onExitedWhileDraining: () =>
                        log("The daemon exited while draining; starting a fresh one."),
                });
            }
            status.phase("starting");
            reloaded = await ensureAgentDaemon({
                confirmRestart: async () => true,
                ...ensureOptions,
            });
            status.done();
        } catch (error) {
            status.failed(error);
            throw error;
        } finally {
            await status.close();
        }
        log(`Daemon is running at ${reloaded.paths.socketPath}`);
        log(`Daemon PID: ${String((await readDaemonPid(reloaded.paths.pidPath)) ?? "unknown")}`);
        log(`Daemon log: ${reloaded.paths.logPath}`);
        log(`Shutdown log: ${reloaded.paths.observationLogPath}`);
        return;
    }

    if (command === "status") {
        const pid = await readDaemonPid(paths.pidPath);
        if (connection === undefined) {
            if (pid !== undefined && (await isDaemonProcessRunning(pid))) {
                log(`Daemon process ${String(pid)} is running but not responding.`);
            } else {
                log("Daemon is not running.");
            }
            for (const line of await describeDaemonSupervisor(paths.directory, false)) log(line);
            log(`Daemon log: ${paths.logPath}`);
            log(`Shutdown log: ${paths.observationLogPath}`);
            return;
        }
        if (!connection.health.ready) {
            log(`Daemon is starting at ${paths.socketPath}`);
            log(`Daemon log: ${paths.logPath}`);
            return;
        }
        log(
            connection.health.draining === true
                ? `Daemon is draining at ${paths.socketPath}`
                : `Daemon is running at ${paths.socketPath}`,
        );
        log(`Daemon PID: ${String(pid ?? "unknown")}`);
        if (connection.health.draining === true) {
            log(formatDrainProgress(connection.health.drainWaitingFor ?? []));
        }
        for (const line of await describeDaemonSupervisor(paths.directory, true)) log(line);
        log(`Daemon log: ${paths.logPath}`);
        log(`Shutdown log: ${paths.observationLogPath}`);
        return;
    }

    if (connection === undefined) {
        await assertNoUnresponsiveDaemon(paths.pidPath);
        // A daemon down between crash restarts stays down once stopped.
        await standDownDaemonSupervisor(paths.directory);
        log("Daemon is not running.");
        return;
    }
    log("Daemon is stopping.");
    await recordStopIntentForRecordedDaemon(paths);
    await stopLocalProtocolServer(connection.client, paths, {
        drain: { cause: "stop", intent: "shutdown" },
        onDrainProgress: log,
        onExitedWhileDraining: () => log("The daemon exited while draining."),
    });
    log("Daemon stopped.");
}

/**
 * A stop begins with the drain, not with the shutdown request: the daemon records its own stop
 * intent only once shutdown starts, so a daemon that crashes while draining would otherwise look
 * like an unexpected exit and be restarted by its supervisor despite the stop. Recording first
 * keeps an intentional stop from ever respawning. The record names only this PID, so it never
 * suppresses a later daemon's restart.
 */
async function recordStopIntentForRecordedDaemon(
    paths: ReturnType<typeof getHappyDaemonPaths>,
): Promise<void> {
    const pid = await readDaemonPid(paths.pidPath).catch(() => undefined);
    if (pid === undefined) return;
    try {
        recordDaemonStopIntent(paths.directory, pid);
    } catch {
        // Without the record a crash during the drain is judged by its exit status alone.
    }
}

async function assertNoUnresponsiveDaemon(pidPath: string): Promise<void> {
    const pid = await readDaemonPid(pidPath);
    if (pid === undefined || !(await isDaemonProcessRunning(pid))) return;
    throw new AgentDaemonError(`Daemon process ${String(pid)} is running but not responding.`, {
        hint: "Run 'happy-agent kill' to force it to stop.",
    });
}

async function connectToExistingDaemon(): Promise<
    | {
          client: HappyAgentClient;
          health: HealthResponse;
      }
    | undefined
> {
    const paths = getHappyDaemonPaths();
    const token = await readDaemonTokenIfPresent(paths.tokenPath);
    if (token === undefined) {
        return undefined;
    }

    const client = new HappyAgentClient({
        endpoint: "http://happy",
        fetch: createUnixSocketFetch(paths.socketPath),
        token,
    });
    try {
        const health = await client.getHealth();
        return { client, health };
    } catch {
        return undefined;
    }
}
