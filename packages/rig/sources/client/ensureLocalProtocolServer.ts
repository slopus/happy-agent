import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

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
            startupLock.release();
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
    ownership.release();
}

async function startLocalProtocolServer(
    paths: LocalServerPaths,
    options: EnsureLocalProtocolServerOptions,
): Promise<LocalProtocolServerConnection> {
    const token = await writeLocalServerToken(paths.tokenPath);
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
        await spawnLocalServer(paths);
    }
    const client = new ProtocolHttpClient({ socketPath: paths.socketPath, token });
    await waitForReady(client);
    await reconcileDaemonSettings(client);
    return { client, paths, token };
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

async function spawnLocalServer(paths: LocalServerPaths): Promise<void> {
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
        child.unref();
    } finally {
        await log.close();
    }
}

async function waitForReady(client: ProtocolHttpClient): Promise<ReadyHealthResponse> {
    let deadline = Date.now() + 5_000;
    let observedStarting = false;
    while (Date.now() < deadline) {
        let health: Awaited<ReturnType<ProtocolHttpClient["health"]>>;
        try {
            health = await client.health();
        } catch {
            // The socket may not be accepting connections yet.
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
        current.config.settings.durableGlobalEventQueue === daemonSettings.durableGlobalEventQueue
    ) {
        return;
    }

    const updated = await client.updateDaemonConfig({
        settings: {
            inferenceMaxRetries: daemonSettings.inferenceMaxRetries,
            durableGlobalEventQueue: daemonSettings.durableGlobalEventQueue,
        },
    });
    if (
        updated.config.settings.inferenceMaxRetries !== daemonSettings.inferenceMaxRetries ||
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
