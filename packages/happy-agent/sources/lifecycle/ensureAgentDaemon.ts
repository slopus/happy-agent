import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, open } from "node:fs/promises";
import { homedir } from "node:os";

import {
    HappyAgentClient,
    HAPPY_AGENT_MIN_PROTOCOL_VERSION,
    type HealthResponse,
} from "@slopus/happy-agent-client";
import { loadHappyAgentConfiguration } from "@slopus/happy-agent-modules";
import {
    describeHappyAgentNewerData,
    HAPPY_AGENT_NEWER_DATA_EXIT_CODE,
    happyAgentDataVersionPath,
    readHappyAgentDataVersion,
} from "@slopus/happy-agent-modules/data-version";

import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { AgentDaemonError } from "./AgentDaemonError.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { decideAgentSocketAction } from "./decideAgentSocketAction.js";
import { inspectAgentSocket, type AgentSocketListener } from "./inspectAgentSocket.js";
import { stopUnreachableAgentDaemon } from "./stopUnreachableAgentDaemon.js";
import {
    readDaemonToken,
    readDaemonTokenIfPresent,
    readOrCreateDaemonToken,
} from "./daemonToken.js";
import { getDaemonIdentity, type AgentDaemonIdentity } from "./getDaemonIdentity.js";
import { getHappyDaemonPaths, type HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { resolveAgentDaemonProcessCommand } from "./resolveAgentDaemonProcessCommand.js";
import { AGENT_DAEMON_SUPERVISE_ENVIRONMENT } from "./superviseAgentDaemon.js";
import { rotateDaemonLog } from "./rotateDaemonLog.js";
import { stopLocalProtocolServer } from "./stopLocalProtocolServer.js";

const DAEMON_CHILD_STARTUP_TIMEOUT_MS = 60_000;
const DAEMON_CHILD_TERMINATION_TIMEOUT_MS = 2_000;
const DAEMON_RESTART_ATTEMPTS = 20;

export interface AgentDaemonConnection {
    client: HappyAgentClient;
    paths: HappyDaemonPaths;
    token: string;
}

export interface EnsureAgentDaemonOptions {
    confirmRestart?: (request: AgentDaemonRestartRequest) => Promise<boolean>;
    onStatus?: (message: string) => void;
    /** Something a person should know was done along the way, such as a daemon that was stopped. */
    onNotice?: (message: string) => void;
    /**
     * The script a replacement daemon process runs. Defaults to the current executable script;
     * a product that embeds this lifecycle names its own daemon entrypoint here. A compiled
     * Happy Agent binary relaunches itself directly.
     */
    entrypoint?: string;
    /** Test-only: run the daemon inside the calling process instead of spawning one. */
    runInProcess?: boolean;
}

export interface AgentDaemonRestartRequest {
    currentIdentity: AgentDaemonIdentity;
    runningIdentity: AgentDaemonIdentity;
}

/**
 * Connects to the local Happy agent daemon, starting one when none is running.
 *
 * This is the whole boot sequence: observe the daemon's health, match its identity, and spawn or
 * restart the detached daemon process until a matching daemon serves the socket.
 */
export async function ensureAgentDaemon(
    options: EnsureAgentDaemonOptions = {},
): Promise<AgentDaemonConnection> {
    const paths = getHappyDaemonPaths();
    const currentIdentity = getDaemonIdentity();
    await ensurePrivateDirectory(paths.directory);

    let replacedUnreachable = false;
    let socketTakenWhileStarting = false;
    for (let attempt = 0; attempt < DAEMON_RESTART_ATTEMPTS; attempt += 1) {
        // Look before writing anything: a start that fails on a busy socket must not leave a
        // fresh token beside a daemon that never knew it.
        const listener = await inspectAgentSocket(paths);
        const action = decideAgentSocketAction(listener, paths.socketPath, {
            pid: process.pid,
            uid: process.getuid?.(),
            platform: process.platform,
        });
        if (action.kind === "refuse") throw action.error;
        if (action.kind === "replace") {
            if (replacedUnreachable) {
                throw new AgentDaemonError(
                    `Another Happy Agent that this installation cannot reach started serving ${paths.socketPath}.`,
                    {
                        hint: "Run 'happy-agent status' to see what is serving it.",
                        exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE,
                    },
                );
            }
            replacedUnreachable = true;
            await stopUnreachableAgentDaemon(action, paths.directory);
            await reportNotice(
                options,
                paths,
                `Stopped Happy Agent ${action.version === undefined ? "" : `${action.version} `}(PID ${String(action.pid)}), which this installation could no longer reach.`,
            );
            continue;
        }
        const observed = listener.kind === "authenticated" ? listener : undefined;
        if (observed !== undefined && daemonVersionsMatch(currentIdentity, observed.health)) {
            return await connectToObservedDaemon(observed, paths);
        }

        if (observed !== undefined) {
            const request: AgentDaemonRestartRequest = {
                currentIdentity,
                runningIdentity: { version: observed.health.version.daemon },
            };
            const shouldRestart = (await options.confirmRestart?.(request)) ?? false;
            if (!shouldRestart) {
                throw new AgentDaemonError("The running daemon does not match this client.", {
                    hint: "Stop the daemon, then try again.",
                });
            }
            options.onStatus?.("Restarting local daemon.");
            await stopLocalProtocolServer(observed.client, paths);
        }

        options.onStatus?.("Starting local daemon.");
        let connection: AgentDaemonConnection;
        try {
            connection = await startAgentDaemonProcess(paths, options);
        } catch (error) {
            // Another start may have bound the socket first. Look once more to connect to it, or
            // to identify a listener this installation cannot use.
            if (
                !socketTakenWhileStarting &&
                error instanceof AgentDaemonError &&
                error.exitCode === AGENT_SOCKET_IN_USE_EXIT_CODE
            ) {
                socketTakenWhileStarting = true;
                continue;
            }
            throw error;
        }
        const health = await readHealth(connection.client);
        // Another client may have won the race to start a daemon with a different identity;
        // observe again instead of handing back a connection to the wrong daemon.
        if (health === undefined || !daemonVersionsMatch(currentIdentity, health)) {
            await delay(250);
            continue;
        }
        return connection;
    }
    throw new AgentDaemonError("The local daemon could not be started.", {
        hint: "Another client keeps replacing it. Stop the daemon, then try again.",
    });
}

export async function readTokenIfPresent(tokenPath: string): Promise<string | undefined> {
    return readDaemonTokenIfPresent(tokenPath);
}

/** Tells the person, and the daemon log that a desktop launch leaves behind. */
async function reportNotice(
    options: EnsureAgentDaemonOptions,
    paths: HappyDaemonPaths,
    message: string,
): Promise<void> {
    options.onNotice?.(message);
    await appendFile(paths.logPath, `${new Date().toISOString()} start: ${message}\n`, {
        mode: 0o600,
    }).catch(() => undefined);
}

async function connectToObservedDaemon(
    observed: Extract<AgentSocketListener, { kind: "authenticated" }>,
    paths: HappyDaemonPaths,
): Promise<AgentDaemonConnection> {
    await resolveReadyHealth(observed.client, observed.health);
    return { client: observed.client, paths, token: observed.token };
}

async function startAgentDaemonProcess(
    paths: HappyDaemonPaths,
    options: EnsureAgentDaemonOptions,
): Promise<AgentDaemonConnection> {
    const configuration = await loadHappyAgentConfiguration(paths.happyHome);
    if (configuration.values.feature.team.enabled) {
        throw new AgentDaemonError("Local daemon connections are disabled in team mode.", {
            hint: "Run 'happy-agent run' under the team deployment's process supervisor.",
        });
    }
    // Readiness is authenticated too. The daemon replaces any old token with the configured
    // value before serving health, so use that value from the very first readiness request.
    const token =
        configuration.values.api?.token ?? (await readOrCreateDaemonToken(paths.tokenPath));
    let child: ChildProcess | undefined;
    if (options.runInProcess === true) {
        // The runtime import is deferred so lifecycle management never loads the whole agent.
        const { runAgentDaemon } = await import("./runAgentDaemon.js");
        void runAgentDaemon({ persistPid: false }).catch((error: unknown) => {
            options.onStatus?.(
                `Local daemon stopped: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    } else {
        child = await spawnAgentDaemon(paths, options.entrypoint);
    }
    const client = createDaemonClient(paths, token);
    // A freshly spawned native executable may spend several seconds loading and
    // securing its runtime before it can publish the first health response.
    const readinessPolling = new AbortController();
    const readiness = waitForReady(
        client,
        DAEMON_CHILD_STARTUP_TIMEOUT_MS,
        readinessPolling.signal,
    );
    try {
        if (child === undefined) {
            await readiness;
        } else {
            await superviseSpawnedDaemon(child, readiness, DAEMON_CHILD_STARTUP_TIMEOUT_MS, {
                describeRefusal: async () =>
                    describeHappyAgentNewerData(
                        await readHappyAgentDataVersion(happyAgentDataVersionPath(paths.directory)),
                    ),
            });
        }
    } finally {
        // A start that failed early must not keep polling, and keep this process alive, until
        // the readiness deadline.
        readinessPolling.abort();
    }
    // The daemon may have created its own token when none existed; reread so the connection uses
    // whatever the daemon actually serves.
    const servedToken = await readDaemonToken(paths.tokenPath);
    return {
        client: servedToken === token ? client : createDaemonClient(paths, servedToken),
        paths,
        token: servedToken,
    };
}

function createDaemonClient(paths: HappyDaemonPaths, token: string): HappyAgentClient {
    return new HappyAgentClient({
        endpoint: "http://happy",
        fetch: createUnixSocketFetch(paths.socketPath),
        token,
    });
}

async function readHealth(client: HappyAgentClient): Promise<HealthResponse | undefined> {
    try {
        return await client.getHealth();
    } catch {
        return undefined;
    }
}

async function spawnAgentDaemon(
    paths: HappyDaemonPaths,
    entrypoint: string | undefined,
): Promise<ChildProcess> {
    const command = resolveAgentDaemonProcessCommand(entrypoint);
    if (command === undefined) {
        throw new AgentDaemonError("Cannot locate the Happy agent daemon entrypoint.");
    }

    await rotateDaemonLog(paths.logPath).catch(() => undefined);
    const log = await open(paths.logPath, "a", 0o600);
    try {
        await log.chmod(0o600);
        const child = spawn(command.executable, command.arguments, {
            // A desktop launch starts in `/`, and anything the daemon runs without its own
            // directory would otherwise start reading from the root of the disk.
            cwd: homedir(),
            detached: true,
            windowsHide: true,
            env: daemonLaunchEnvironment(),
            stdio: ["ignore", log.fd, log.fd],
        });
        return child;
    } finally {
        await log.close();
    }
}

/**
 * On macOS and Linux the spawned `run` process becomes a crash supervisor that runs the daemon
 * as its child and restarts it after an unexpected exit. Windows keeps an unsupervised daemon:
 * it has no process groups to stop a supervisor and its stalled child together.
 */
function daemonLaunchEnvironment(): NodeJS.ProcessEnv {
    if (process.platform === "win32") return process.env;
    return { ...process.env, [AGENT_DAEMON_SUPERVISE_ENVIRONMENT]: "1" };
}

export interface SpawnedAgentDaemonProcess {
    /** Present for a real process; a detached one also leads its own process group. */
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): boolean;
    once(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
    removeListener(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
    unref(): void;
}

/**
 * Keeps a replacement child owned until it proves that it can serve the socket. A child that
 * stalls during startup is terminated and reaped instead of becoming an invisible detached daemon
 * that can survive for days.
 */
export async function superviseSpawnedDaemon<Result>(
    child: SpawnedAgentDaemonProcess,
    readiness: Promise<Result>,
    timeoutMs: number,
    options: {
        /** What to tell a person when the daemon refused data a newer release wrote. */
        readonly describeRefusal?: () => Promise<string>;
    } = {},
): Promise<Result> {
    let timer: NodeJS.Timeout | undefined;
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    try {
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error("Timed out while starting the local daemon.")),
                timeoutMs,
            );
            timer.unref();
        });
        // A crash supervisor exits with a failure only once it has given up on a daemon that
        // keeps failing during startup; waiting out the full timeout after that tells nobody
        // anything. A clean exit is not a failure: the supervisor may have stood aside for a
        // daemon that another start launched, and readiness still decides.
        const failed = new Promise<never>((_, reject) => {
            onExit = (code, signal) => {
                if (code === 0 && signal === null) return;
                if (code === HAPPY_AGENT_NEWER_DATA_EXIT_CODE && signal === null) {
                    // Starting again cannot help; the caller exits with the same status.
                    const fallback = describeHappyAgentNewerData(undefined);
                    void (options.describeRefusal?.() ?? Promise.resolve(fallback))
                        .catch(() => fallback)
                        .then((message) => {
                            reject(
                                new AgentDaemonError(message, {
                                    exitCode: HAPPY_AGENT_NEWER_DATA_EXIT_CODE,
                                }),
                            );
                        });
                    return;
                }
                if (code === AGENT_SOCKET_IN_USE_EXIT_CODE && signal === null) {
                    reject(
                        new AgentDaemonError(
                            "The local daemon could not start because another process already serves its socket.",
                            {
                                hint: "Run 'happy-agent status' to see what is serving it.",
                                exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE,
                            },
                        ),
                    );
                    return;
                }
                reject(
                    new AgentDaemonError(
                        `The local daemon failed to start (${signal === null ? `exit code ${String(code)}` : `signal ${signal}`}).`,
                        {
                            hint: "Run 'happy-agent status', and see the daemon log for the reason.",
                        },
                    ),
                );
            };
            if (child.exitCode !== null || child.signalCode !== null) {
                onExit(child.exitCode, child.signalCode);
            } else {
                child.once("exit", onExit);
            }
        });
        const result = await Promise.race([readiness, timeout, failed]);
        child.unref();
        return result;
    } catch (error) {
        await terminateSpawnedDaemon(child);
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onExit !== undefined) child.removeListener("exit", onExit);
    }
}

async function terminateSpawnedDaemon(child: SpawnedAgentDaemonProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
        let forceTimer: NodeJS.Timeout | undefined;
        let reapTimer: NodeJS.Timeout | undefined;
        const finish = () => {
            if (forceTimer !== undefined) clearTimeout(forceTimer);
            if (reapTimer !== undefined) clearTimeout(reapTimer);
            child.removeListener("exit", onExit);
            resolve();
        };
        const onExit = () => finish();
        child.once("exit", onExit);
        forceTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                signalSpawnedDaemon(child, "SIGKILL");
            }
        }, DAEMON_CHILD_TERMINATION_TIMEOUT_MS / 2);
        reapTimer = setTimeout(finish, DAEMON_CHILD_TERMINATION_TIMEOUT_MS);
        forceTimer.unref();
        reapTimer.unref();
        signalSpawnedDaemon(child, "SIGTERM");
    });
}

/**
 * The spawned process may be a crash supervisor whose stalled daemon is its child. Both share
 * the detached process group, so a failed start signals the group and leaves neither behind.
 */
function signalSpawnedDaemon(child: SpawnedAgentDaemonProcess, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid !== undefined) {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch {
            // Not a group leader, or already gone; signal the process itself.
        }
    }
    child.kill(signal);
}

export async function waitForReady(
    client: Pick<HappyAgentClient, "getHealth">,
    initialTimeoutMs = 5_000,
    signal?: AbortSignal,
): Promise<HealthResponse> {
    let deadline = Date.now() + initialTimeoutMs;
    let observedStarting = false;
    let recoveredAfterStartingFailure = false;
    while (Date.now() < deadline) {
        if (signal?.aborted === true) throw new Error("Stopped waiting for the local daemon.");
        let health: HealthResponse;
        try {
            health = await client.getHealth();
        } catch {
            // The socket may not be accepting connections yet.
            if (observedStarting && !recoveredAfterStartingFailure) {
                recoveredAfterStartingFailure = true;
                deadline = Date.now() + 5_000;
            }
            await delay(50);
            continue;
        }
        assertCompatibleProtocol(health);
        if (health.ready) return health;
        observedStarting = true;
        deadline = Date.now() + 5_000;
        await delay(50);
    }

    if (observedStarting) {
        throw new Error("The local daemon stopped responding while it was starting.");
    }
    throw new Error("Timed out while waiting for the local daemon.");
}

async function resolveReadyHealth(
    client: HappyAgentClient,
    health: HealthResponse,
): Promise<HealthResponse> {
    assertCompatibleProtocol(health);
    if (health.ready) return health;
    return waitForReady(client);
}

function assertCompatibleProtocol(health: HealthResponse): void {
    if (health.version.protocol >= HAPPY_AGENT_MIN_PROTOCOL_VERSION) return;
    throw new AgentDaemonError(
        `The running daemon uses protocol ${String(health.version.protocol)}, but this client requires protocol ${String(HAPPY_AGENT_MIN_PROTOCOL_VERSION)} or newer.`,
        { hint: "Update the daemon to a compatible version." },
    );
}

function daemonVersionsMatch(identity: AgentDaemonIdentity, health: HealthResponse): boolean {
    return (
        health.version.protocol >= HAPPY_AGENT_MIN_PROTOCOL_VERSION &&
        health.version.daemon === identity.version
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
