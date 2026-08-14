import { spawn, type ChildProcess } from "node:child_process";
import { chmod, open } from "node:fs/promises";

import {
    getEnvironmentLocalServerPaths,
    prepareDaemonDiagnostics,
    prepareLocalServerDirectory,
    readLocalServerToken,
    rotateDaemonLog,
    runLocalProtocolServer,
    writeLocalServerToken,
    type LocalServerPaths,
} from "../server/index.js";
import { daemonIdentitiesMatch, getDaemonIdentity } from "../daemon/index.js";
import {
    acquireSqliteProcessLock,
    SqliteProcessLockUnavailableError,
    type SqliteProcessLock,
} from "../persistence/database/acquireSqliteProcessLock.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { RigUserError } from "../RigUserError.js";
import type { DaemonIdentity, ReadyHealthResponse } from "../protocol/index.js";
import { ProtocolHttpClient } from "./ProtocolHttpClient.js";
import { loadDaemonSettings } from "../config/index.js";
import { stopLocalProtocolServer } from "./stopLocalProtocolServer.js";

const DAEMON_STARTUP_LOCK_TIMEOUT_MS = 60_000;
const DATABASE_OWNERSHIP_HANDOFF_TIMEOUT_MS = 30_000;
const DAEMON_CHILD_STARTUP_TIMEOUT_MS = 60_000;
const DAEMON_CHILD_TERMINATION_TIMEOUT_MS = 2_000;

export interface LocalProtocolServerConnection {
    client: ProtocolHttpClient;
    paths: LocalServerPaths;
    token: string;
}

export interface EnsureLocalProtocolServerOptions {
    confirmRestart?: (request: DaemonRestartRequest) => Promise<boolean>;
    onStatus?: (message: string) => void;
}

export interface DaemonRestartRequest {
    currentIdentity: DaemonIdentity;
    runningIdentity: DaemonIdentity;
}

export async function ensureLocalProtocolServer(
    options: EnsureLocalProtocolServerOptions = {},
): Promise<LocalProtocolServerConnection> {
    const paths = getEnvironmentLocalServerPaths();
    const currentIdentity = getDaemonIdentity();
    await prepareLocalServerDirectory(paths.directory);

    for (;;) {
        const observed = await observeLocalProtocolServer(paths);
        if (
            observed !== undefined &&
            daemonIdentitiesMatch(currentIdentity, observed.health.identity)
        ) {
            return connectToObservedServer(observed, paths);
        }

        let approvedIdentity: DaemonIdentity | undefined;
        if (observed !== undefined) {
            const request: DaemonRestartRequest = {
                currentIdentity,
                runningIdentity: observed.health.identity,
            };
            const shouldRestart = (await options.confirmRestart?.(request)) ?? false;
            if (!shouldRestart) {
                throw new RigUserError("The running daemon does not match this Rig CLI.", {
                    hint: "Run rig daemon stop, then try again.",
                });
            }
            approvedIdentity = observed.health.identity;
        }

        const startupLock = await acquireDaemonStartupLock(paths);
        try {
            const current = await observeLocalProtocolServer(paths);
            if (
                current !== undefined &&
                daemonIdentitiesMatch(currentIdentity, current.health.identity)
            ) {
                const connection = await connectToObservedServer(current, paths);
                return connection;
            }
            if (current !== undefined) {
                if (
                    approvedIdentity === undefined ||
                    !daemonIdentitiesMatch(approvedIdentity, current.health.identity)
                ) {
                    continue;
                }
                options.onStatus?.("Restarting local daemon.");
                await stopLocalProtocolServer(current.client);
            }

            await waitForDatabaseOwnershipHandoff(paths);
            options.onStatus?.("Starting local daemon.");
            const connection = await startLocalProtocolServer(paths, options);
            return connection;
        } finally {
            await startupLock.release();
        }
    }
}

export async function readTokenIfPresent(tokenPath: string): Promise<string | undefined> {
    try {
        return await readLocalServerToken(tokenPath);
    } catch {
        return undefined;
    }
}

interface ObservedLocalProtocolServer {
    client: ProtocolHttpClient;
    health: Awaited<ReturnType<ProtocolHttpClient["health"]>>;
    token: string;
}

async function observeLocalProtocolServer(
    paths: LocalServerPaths,
): Promise<ObservedLocalProtocolServer | undefined> {
    const token = await readTokenIfPresent(paths.tokenPath);
    if (token === undefined) return undefined;
    const client = new ProtocolHttpClient({ socketPath: paths.socketPath, token });
    const health = await readHealth(client);
    return health === undefined ? undefined : { client, health, token };
}

async function connectToObservedServer(
    observed: ObservedLocalProtocolServer,
    paths: LocalServerPaths,
): Promise<LocalProtocolServerConnection> {
    await resolveReadyHealth(observed.client, observed.health);
    await reconcileDaemonSettings(observed.client);
    return { client: observed.client, paths, token: observed.token };
}

async function acquireDaemonStartupLock(paths: LocalServerPaths): Promise<SqliteProcessLock> {
    try {
        return await acquireSqliteProcessLock(`${paths.registryPath}.startup.lock`, {
            timeoutMs: DAEMON_STARTUP_LOCK_TIMEOUT_MS,
        });
    } catch (error) {
        if (error instanceof SqliteProcessLockUnavailableError) {
            throw new RigUserError("Rig could not coordinate local daemon startup.", {
                hint: "Another Rig process is still starting or stopping the daemon. Try again.",
            });
        }
        throw error;
    }
}

async function waitForDatabaseOwnershipHandoff(paths: LocalServerPaths): Promise<void> {
    let ownership: SqliteProcessLock;
    try {
        ownership = await acquireSqliteProcessLock(`${paths.databasePath}.lock`, {
            timeoutMs: DATABASE_OWNERSHIP_HANDOFF_TIMEOUT_MS,
        });
    } catch (error) {
        if (error instanceof SqliteProcessLockUnavailableError) {
            throw new RigUserError("Another Rig daemon still owns the session database.", {
                hint: "Wait for it to stop before starting a replacement.",
            });
        }
        throw error;
    }
    await ownership.release();
}

async function startLocalProtocolServer(
    paths: LocalServerPaths,
    options: EnsureLocalProtocolServerOptions,
): Promise<LocalProtocolServerConnection> {
    const token = await readOrCreateLocalServerToken(paths.tokenPath);
    let child: ChildProcess | undefined;
    if (process.env.RIG_GYM_IN_PROCESS_DAEMON === "1") {
        void runLocalProtocolServer({
            happyIntegration: "enabled",
            socketPath: paths.socketPath,
            tokenPath: paths.tokenPath,
        }).catch((error: unknown) => {
            if (isDatabaseFailure(error)) throw error;
            options.onStatus?.(
                `Local daemon stopped: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    } else {
        child = await spawnLocalServer(paths);
    }
    const client = new ProtocolHttpClient({ socketPath: paths.socketPath, token });
    const readiness = waitForReady(client);
    if (child === undefined) {
        await readiness;
    } else {
        await superviseSpawnedLocalServer(child, readiness, DAEMON_CHILD_STARTUP_TIMEOUT_MS);
    }
    await reconcileDaemonSettings(client);
    return { client, paths, token };
}

/**
 * Keeps already-connected local clients authorized when the daemon process is replaced.
 *
 * The token file lives in the daemon's private state directory and is already restricted to the
 * current user. Rotating it on every daemon start strands clients whose event streams reconnect
 * after a reload: their immutable client connection still carries the previous token and the new
 * daemon rejects it with HTTP 401.
 */
export async function readOrCreateLocalServerToken(tokenPath: string): Promise<string> {
    const existing = await readTokenIfPresent(tokenPath);
    if (existing === undefined || existing.length === 0) return writeLocalServerToken(tokenPath);
    await chmod(tokenPath, 0o600);
    return existing;
}

async function readHealth(
    client: ProtocolHttpClient,
): Promise<Awaited<ReturnType<ProtocolHttpClient["health"]>> | undefined> {
    try {
        return await client.health();
    } catch {
        return undefined;
    }
}

async function spawnLocalServer(paths: LocalServerPaths): Promise<ChildProcess> {
    const entrypoint = process.argv[1];
    if (entrypoint === undefined) {
        throw new Error("Cannot locate the current CLI entrypoint.");
    }

    await rotateDaemonLog(paths.logPath).catch(() => undefined);
    const daemonSettings = await loadDaemonSettings();
    const log = await open(paths.logPath, "a", 0o600);
    try {
        await log.chmod(0o600);
        const diagnosticArguments = await prepareDaemonDiagnostics({
            heapSnapshots: daemonSettings.daemonHeapSnapshots,
            path: paths.diagnosticsPath,
        }).catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            await log.write(`[daemon diagnostics unavailable] ${message}\n`).catch(() => undefined);
            return [];
        });
        const child = spawn(
            process.execPath,
            [...process.execArgv, ...diagnosticArguments, entrypoint, "--server"],
            {
                detached: true,
                env: {
                    ...process.env,
                    RIG_SERVER_SOCKET_PATH: paths.socketPath,
                    RIG_SERVER_TOKEN_PATH: paths.tokenPath,
                },
                stdio: ["ignore", log.fd, log.fd],
            },
        );
        return child;
    } finally {
        await log.close();
    }
}

export interface SpawnedLocalServerProcess {
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
 * stalls during database ownership or startup is terminated and reaped instead of becoming an
 * invisible detached daemon that can survive for days.
 */
export async function superviseSpawnedLocalServer<Result>(
    child: SpawnedLocalServerProcess,
    readiness: Promise<Result>,
    timeoutMs: number,
): Promise<Result> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error("Timed out while starting the local Rig daemon.")),
                timeoutMs,
            );
            timer.unref();
        });
        const result = await Promise.race([readiness, timeout]);
        child.unref();
        return result;
    } catch (error) {
        await terminateSpawnedLocalServer(child);
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function terminateSpawnedLocalServer(child: SpawnedLocalServerProcess): Promise<void> {
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
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, DAEMON_CHILD_TERMINATION_TIMEOUT_MS / 2);
        reapTimer = setTimeout(finish, DAEMON_CHILD_TERMINATION_TIMEOUT_MS);
        forceTimer.unref();
        reapTimer.unref();
        child.kill("SIGTERM");
    });
}

export async function waitForReady(client: ProtocolHttpClient): Promise<ReadyHealthResponse> {
    let deadline = Date.now() + 5_000;
    let observedStarting = false;
    let recoveredAfterStartingFailure = false;
    while (Date.now() < deadline) {
        let health: Awaited<ReturnType<ProtocolHttpClient["health"]>>;
        try {
            health = await client.health();
        } catch {
            // The socket may not be accepting connections yet.
            if (observedStarting && !recoveredAfterStartingFailure) {
                recoveredAfterStartingFailure = true;
                deadline = Date.now() + 5_000;
            }
            await delay(50);
            continue;
        }
        if (health.status === "ready") return health;
        if (health.status === "error") throw daemonStartupError(health.error);
        observedStarting = true;
        deadline = Date.now() + 5_000;
        await delay(50);
    }

    if (observedStarting) {
        throw new Error("The local daemon stopped responding while it was starting.");
    }
    throw new Error("Timed out while waiting for the local Rig server.");
}

async function resolveReadyHealth(
    client: ProtocolHttpClient,
    health: Awaited<ReturnType<ProtocolHttpClient["health"]>>,
): Promise<ReadyHealthResponse> {
    if (health.status === "error") throw daemonStartupError(health.error);
    if (health.status === "ready") return health;
    return waitForReady(client);
}

async function reconcileDaemonSettings(client: ProtocolHttpClient): Promise<void> {
    const daemonSettings = await loadDaemonSettings();
    const current = await client.getDaemonConfig();
    if (
        current.config.settings.inferenceMaxRetries === daemonSettings.inferenceMaxRetries &&
        current.config.settings.inferenceFatalRetries === daemonSettings.inferenceFatalRetries &&
        current.config.settings.durableGlobalEventQueue === daemonSettings.durableGlobalEventQueue
    ) {
        return;
    }

    const updated = await client.updateDaemonConfig({
        settings: {
            inferenceMaxRetries: daemonSettings.inferenceMaxRetries,
            inferenceFatalRetries: daemonSettings.inferenceFatalRetries,
            durableGlobalEventQueue: daemonSettings.durableGlobalEventQueue,
        },
    });
    if (
        updated.config.settings.inferenceMaxRetries !== daemonSettings.inferenceMaxRetries ||
        updated.config.settings.inferenceFatalRetries !== daemonSettings.inferenceFatalRetries ||
        updated.config.settings.durableGlobalEventQueue !== daemonSettings.durableGlobalEventQueue
    ) {
        throw new Error("The local daemon did not apply the requested configuration.");
    }
}

function daemonStartupError(message: string): Error {
    return new Error(`Daemon could not start: ${message}`);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
