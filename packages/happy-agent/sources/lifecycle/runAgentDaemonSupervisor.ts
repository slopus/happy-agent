import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
    HAPPY_AGENT_NEWER_DATA_EXIT_CODE,
    happyAgentDataVersionPath,
    readHappyAgentDataVersion,
} from "@slopus/happy-agent-modules/data-version";

import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { isDaemonProcessRunning, readDaemonPid } from "./daemonPid.js";
import { daemonProcessIdentity } from "./daemonProcessIdentity.js";
import { consumeDaemonStopIntent } from "./daemonStopIntent.js";
import {
    daemonSupervisorStatePath,
    removeDaemonSupervisorState,
    writeDaemonSupervisorState,
} from "./daemonSupervisorState.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";
import {
    resolveAgentDaemonProcessCommand,
    type AgentDaemonProcessCommand,
} from "./resolveAgentDaemonProcessCommand.js";
import { rotateDaemonLog } from "./rotateDaemonLog.js";
import {
    AGENT_DAEMON_SUPERVISE_ENVIRONMENT,
    DEFAULT_DAEMON_SUPERVISOR_POLICY,
    superviseAgentDaemon,
    type DaemonSupervisorOutcome,
    type DaemonSupervisorPolicy,
    type SupervisedDaemonProcess,
} from "./superviseAgentDaemon.js";

export interface RunAgentDaemonSupervisorOptions {
    /** The daemon command. Defaults to this executable's own `run`. */
    readonly command?: AgentDaemonProcessCommand;
    readonly policy?: DaemonSupervisorPolicy;
    /** Aborts supervision; by default SIGTERM, SIGINT, and SIGHUP do. */
    readonly stopSignal?: AbortSignal;
}

/**
 * Runs the crash supervisor in this process until supervision ends, returning its exit code.
 *
 * The supervisor loads none of the agent runtime: it starts the daemon, waits for it to exit,
 * and restarts it only after an unexpected exit. See {@link superviseAgentDaemon}.
 */
export async function runAgentDaemonSupervisor(
    options: RunAgentDaemonSupervisorOptions = {},
): Promise<number> {
    const paths = getHappyDaemonPaths();
    const command = options.command ?? resolveAgentDaemonProcessCommand(undefined);
    if (command === undefined) throw new Error("Cannot locate the Happy agent daemon entrypoint.");
    const environment = { ...process.env };
    delete environment[AGENT_DAEMON_SUPERVISE_ENVIRONMENT];

    const stop = new AbortController();
    const onSignal = () => stop.abort();
    const ownsSignals = options.stopSignal === undefined;
    if (ownsSignals) {
        process.once("SIGTERM", onSignal);
        process.once("SIGINT", onSignal);
        if (process.platform !== "win32") process.once("SIGHUP", onSignal);
    } else if (options.stopSignal.aborted) {
        stop.abort();
    } else {
        options.stopSignal.addEventListener("abort", onSignal, { once: true });
    }

    const statePath = daemonSupervisorStatePath(paths.directory);
    const instance = randomUUID();
    const supervisorIdentity = await daemonProcessIdentity(process.pid).catch(() => undefined);
    const log = (line: string) => {
        // Diagnostics never stop supervision.
        void appendFile(paths.logPath, `${new Date().toISOString()} ${line}\n`, {
            mode: 0o600,
        }).catch(() => undefined);
    };

    let outcome: DaemonSupervisorOutcome;
    try {
        outcome = await superviseAgentDaemon(
            {
                spawnDaemon: async () => await spawnDaemon(command, environment, paths.logPath),
                consumeStopIntent: async (pid) =>
                    await consumeDaemonStopIntent(paths.directory, pid),
                otherDaemonRunning: async (exitedPid) => {
                    const pid = await readDaemonPid(paths.pidPath).catch(() => undefined);
                    return (
                        pid !== undefined &&
                        pid !== exitedPid &&
                        pid !== process.pid &&
                        (await isDaemonProcessRunning(pid))
                    );
                },
                publish: async (snapshot) => {
                    const stamp =
                        snapshot.phase === "refused"
                            ? await readHappyAgentDataVersion(
                                  happyAgentDataVersionPath(paths.directory),
                              )
                            : undefined;
                    await writeDaemonSupervisorState(statePath, {
                        version: 1,
                        instance,
                        supervisorPid: process.pid,
                        ...(supervisorIdentity === undefined ? {} : { supervisorIdentity }),
                        phase: snapshot.phase,
                        ...(snapshot.phase === "running" ? { daemonPid: snapshot.daemonPid } : {}),
                        restarts: snapshot.restarts,
                        quickFailures: snapshot.quickFailures,
                        ...(snapshot.lastExit === undefined ? {} : { lastExit: snapshot.lastExit }),
                        ...(snapshot.phase === "restarting"
                            ? { nextRestartAt: new Date(snapshot.nextRestartAt).toISOString() }
                            : {}),
                        ...(stamp === undefined
                            ? {}
                            : { writtenBy: stamp.writtenBy, minimumVersion: stamp.minimumVersion }),
                        updatedAt: new Date().toISOString(),
                    }).catch((error: unknown) => {
                        log(
                            `supervisor: could not publish its status: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    });
                },
                release: async () => {
                    await removeDaemonSupervisorState(statePath, instance).catch(() => undefined);
                },
                log,
                now: () => Date.now(),
                sleep: async (ms, signal) => {
                    await delay(ms, undefined, { signal }).catch(() => undefined);
                },
                stopSignal: stop.signal,
            },
            options.policy ?? DEFAULT_DAEMON_SUPERVISOR_POLICY,
        );
    } finally {
        if (ownsSignals) {
            process.removeListener("SIGTERM", onSignal);
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGHUP", onSignal);
        } else {
            options.stopSignal.removeEventListener("abort", onSignal);
        }
    }
    if (outcome.kind === "refused") return HAPPY_AGENT_NEWER_DATA_EXIT_CODE;
    if (outcome.kind === "socket-in-use") return AGENT_SOCKET_IN_USE_EXIT_CODE;
    return outcome.kind === "gave-up" ? 1 : 0;
}

async function spawnDaemon(
    command: AgentDaemonProcessCommand,
    environment: NodeJS.ProcessEnv,
    logPath: string,
): Promise<SupervisedDaemonProcess> {
    await rotateDaemonLog(logPath).catch(() => undefined);
    const log = await open(logPath, "a", 0o600);
    try {
        const child = spawn(command.executable, command.arguments, {
            cwd: homedir(),
            env: environment,
            stdio: ["ignore", log.fd, log.fd],
            windowsHide: true,
        });
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
            child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
        if (child.pid === undefined) throw new Error("The daemon process has no PID.");
        return { pid: child.pid, exited };
    } finally {
        await log.close();
    }
}
