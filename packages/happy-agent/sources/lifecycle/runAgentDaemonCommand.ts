import { HappyAgentClient, type HealthResponse } from "@slopus/happy-agent-client";

import { AgentDaemonError } from "./AgentDaemonError.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { isDaemonProcessRunning, killDaemonFromPidFile, readDaemonPid } from "./daemonPid.js";
import { readDaemonTokenIfPresent } from "./daemonToken.js";
import { ensureAgentDaemon } from "./ensureAgentDaemon.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { stopLocalProtocolServer } from "./stopLocalProtocolServer.js";

export type AgentDaemonCommand = "kill" | "reload" | "start" | "stop" | "status";

export function isAgentDaemonCommand(value: string | undefined): value is AgentDaemonCommand {
    return (
        value === "start" ||
        value === "stop" ||
        value === "status" ||
        value === "reload" ||
        value === "kill"
    );
}

export interface RunAgentDaemonCommandOptions {
    /** The daemon entrypoint handed to {@link ensureAgentDaemon} when a daemon must be spawned. */
    entrypoint?: string;
    log?: (line: string) => void;
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
        const result = await killDaemonFromPidFile(paths.pidPath);
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
            await stopLocalProtocolServer(connection.client, paths);
        } else {
            await assertNoUnresponsiveDaemon(paths.pidPath);
        }
        const reloaded = await ensureAgentDaemon({
            confirmRestart: async () => true,
            ...ensureOptions,
        });
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
            log(`Daemon log: ${paths.logPath}`);
            log(`Shutdown log: ${paths.observationLogPath}`);
            return;
        }
        if (!connection.health.ready) {
            log(`Daemon is starting at ${paths.socketPath}`);
            log(`Daemon log: ${paths.logPath}`);
            return;
        }
        log(`Daemon is running at ${paths.socketPath}`);
        log(`Daemon PID: ${String(pid ?? "unknown")}`);
        log(`Daemon log: ${paths.logPath}`);
        log(`Shutdown log: ${paths.observationLogPath}`);
        return;
    }

    if (connection === undefined) {
        await assertNoUnresponsiveDaemon(paths.pidPath);
        log("Daemon is not running.");
        return;
    }
    log("Daemon is stopping.");
    await stopLocalProtocolServer(connection.client, paths);
    log("Daemon stopped.");
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
