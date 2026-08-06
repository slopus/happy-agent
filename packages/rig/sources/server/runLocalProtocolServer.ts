import { chmod, open } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import { createProtocolHttpServer } from "./createProtocolHttpServer.js";
import { DaemonLog } from "./DaemonLog.js";
import { recordProviderFailure } from "./recordProviderFailure.js";
import { configureSessionRequest } from "../session/configureSessionRequest.js";
import {
    createDaemonStartupRequestListener,
    type DaemonStartupState,
} from "./createDaemonStartupRequestListener.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import { GitStateTracker } from "../git/GitStateTracker.js";
import { getEnvironmentLocalServerPaths } from "./getEnvironmentLocalServerPaths.js";
import { installDaemonProcessFailureLogging } from "./installDaemonProcessFailureLogging.js";
import { loadHappyIntegration, type HappyIntegrationMode } from "./loadHappyIntegration.js";
import { markGitStateFromSessionEvent } from "../git/markGitStateFromSessionEvent.js";
import { publishGitLiveEvent } from "../git/publishGitLiveEvent.js";
import { prepareLocalServerDirectory } from "./prepareLocalServerDirectory.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { TrackedTaskDrain } from "../utils/TrackedTaskDrain.js";
import { readLocalServerToken } from "./readLocalServerToken.js";
import { removeStaleSocket } from "./removeStaleSocket.js";
import { resolveHappyIntegrationMode } from "./resolveHappyIntegrationMode.js";
import { CompositeMcpToolProvider, McpClientManager, type McpToolProvider } from "../mcp/index.js";
import {
    ensureUserConfigurationFiles,
    loadConfig,
    resolveProtectedPaths,
    writeDaemonSettings,
    writeP2pNodeSettings,
} from "../config/index.js";
import { createConfiguredPresenceStore } from "../presence/index.js";
import { createProviderQuotaService } from "../executor/createProviderQuotaService.js";
import {
    createProviderUsageTracker,
    type ProviderUsageTracker,
} from "../executor/createProviderUsageTracker.js";
import { createProviderUsageService } from "../executor/createProviderUsageService.js";
import { loadConfiguredProviderUsage } from "../executor/loadConfiguredProviderUsage.js";
import { gracefulShutdown } from "../concurrency/index.js";
import { disableUnavailableProviders } from "../executor/disableUnavailableProviders.js";
import { resolveProviderDisabledReasons } from "../executor/resolveProviderDisabledReasons.js";
import { createCodingAssistantAgent } from "../runtime/createCodingAssistantAgent.js";
import { getDaemonIdentity } from "../daemon/index.js";
import { errorToMessage } from "../errorToMessage.js";
import {
    acquireSqliteProcessLock,
    SqliteProcessLockUnavailableError,
    type SqliteProcessLock,
} from "../persistence/database/acquireSqliteProcessLock.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { getNodeInspectorUrl, openNodeInspector, registerRigDebugRoot } from "../debug/index.js";
import { RigUserError } from "../RigUserError.js";
import type { HappySyncService } from "../happy/index.js";
import { getManagedWorkspacesDirectory } from "../project/getManagedWorkspacesDirectory.js";
import type { LocalServerPaths } from "./LocalServerPaths.js";
import { writeDaemonCrashReport } from "./writeDaemonCrashReport.js";
import type { PluginContext } from "../agent/context/PluginContext.js";
import { PluginManager, PluginMcpRegistry } from "../plugins/index.js";
import { createGeneratedMediaStore, getGeneratedDirectory } from "../generated-media/index.js";
import { MurmurService } from "../murmur/index.js";
import { createEventIdFactory, type GlobalLiveEvent, type P2pStatus } from "../protocol/index.js";
import { createScopeShareKind } from "../scope-sharing/createScopeShareKind.js";
import { createSessionShareKind } from "../session-sharing/createSessionShareKind.js";
import {
    describePeerCapabilities,
    PeerCapabilityContext,
    PeerTerminalViewerService,
} from "../session-sharing/peer-access/index.js";
import { createShareRuntime, type ShareRuntime } from "../sharing/createShareRuntime.js";
import { SqliteMurmurStore } from "../persistence/murmur/index.js";
import {
    loadOrCreateIrohSecretKey,
    loadOrCreateP2pIdentity,
    P2pNetwork,
    P2pPairingService,
    P2pPeerTrustStore,
    recoverP2pPairings,
} from "../p2p/index.js";
import { createServeP2pHttpRequest } from "./createServeP2pHttpRequest.js";
import { createServeP2pTunnel } from "./createServeP2pTunnel.js";

export interface RunLocalProtocolServerOptions {
    happyIntegration?: HappyIntegrationMode;
    socketPath?: string;
    tokenPath?: string;
}

/** Every kind of share this daemon replicates, over one transport and one router. */
type RigShareRuntime = ShareRuntime<{
    scope: ReturnType<typeof createScopeShareKind>;
    session: ReturnType<typeof createSessionShareKind>;
}>;

export async function runLocalProtocolServer(
    options: RunLocalProtocolServerOptions = {},
): Promise<void> {
    const paths = getEnvironmentLocalServerPaths();
    let databaseLock: SqliteProcessLock;
    try {
        databaseLock = await acquireSqliteProcessLock(`${paths.databasePath}.lock`);
    } catch (error) {
        if (error instanceof SqliteProcessLockUnavailableError) {
            throw new RigUserError("Another Rig daemon already owns the session database.", {
                hint: "Connect to the running daemon or stop it before starting another.",
            });
        }
        throw error;
    }
    try {
        await runOwnedLocalProtocolServer(options, paths);
    } finally {
        databaseLock.release();
    }
}

async function runOwnedLocalProtocolServer(
    options: RunLocalProtocolServerOptions,
    paths: LocalServerPaths,
): Promise<void> {
    await prepareLocalServerDirectory(paths.directory);
    const socketPath = options.socketPath ?? paths.socketPath;
    const tokenPath = options.tokenPath ?? paths.tokenPath;
    const startedAt = new Date().toISOString();
    const identity = getDaemonIdentity();
    const daemonLog = new DaemonLog({ path: paths.logPath, version: identity.version });
    daemonLog.record("info", "daemon_starting", "Rig daemon is starting.", {
        databasePath: paths.databasePath,
        ...(identity.developmentBuildId === undefined
            ? {}
            : { developmentBuildId: identity.developmentBuildId }),
        socketPath,
    });
    const uninstallProcessFailureLogging = installDaemonProcessFailureLogging(
        daemonLog,
        process,
        writeDaemonCrashReport,
    );
    let token: string;
    try {
        token = await readLocalServerToken(tokenPath);
        await removeStaleSocket(socketPath);
    } catch (error) {
        daemonLog.record("error", "daemon_startup_failed", "Rig daemon could not start.", {
            error: errorToMessage(error),
        });
        uninstallProcessFailureLogging();
        throw error;
    }

    let startupState: DaemonStartupState = { status: "starting" };
    let mcpToolProvider: McpToolProvider | undefined;
    let p2pNetwork: P2pNetwork | undefined;
    let p2pPairingService: P2pPairingService | undefined;
    let murmurService: MurmurService | undefined;
    let shareRuntime: RigShareRuntime | undefined;
    let happySyncService: HappySyncService | undefined;
    let happyLifecycle = Promise.resolve();
    let gitStateTracker: GitStateTracker | undefined;
    let store: PersistentSessionStore | undefined;
    let taskDrain: TrackedTaskDrain | undefined;
    let providerUsageTracker: ProviderUsageTracker | undefined;
    let stopping = false;
    const shutdown = gracefulShutdown();
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    const runHappyLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = happyLifecycle.then(operation, operation);
        happyLifecycle = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    };
    const stopServer = (reason = "Shutdown requested.") => {
        if (stopping) return;
        stopping = true;
        daemonLog.record("info", "daemon_stopping", "Rig daemon is stopping.", { reason });
        // Disposal comes before the drain closes: it aborts in-flight Git scans, so draining waits
        // on work that has already been told to stop rather than on a full scan timeout.
        gitStateTracker?.dispose();
        taskDrain?.beginClose();
        void (async () => {
            // Background loops are told to stop first, and the names of any
            // that linger say what the daemon is waiting for.
            const report = await shutdown.shutdown();
            if (report.timedOut.length > 0) {
                daemonLog.record(
                    "warning",
                    "daemon_shutdown_slow",
                    "Rig daemon is still waiting for background work to stop.",
                    { pending: report.timedOut.join(", ") },
                );
            }
            for (const failure of report.failed) {
                daemonLog.record(
                    "error",
                    "daemon_shutdown_handler_failed",
                    "A Rig daemon background task failed while shutting down.",
                    { error: errorToMessage(failure.error), task: failure.name },
                );
            }
            if (store !== undefined) {
                try {
                    await store.prepareForShutdown("shutdown");
                } catch (error) {
                    if (isDatabaseFailure(error)) fatalDatabaseFailure ??= error;
                    daemonLog.record(
                        "error",
                        "daemon_shutdown_drain_failed",
                        "Rig daemon could not finish draining interrupted sessions.",
                        { error: errorToMessage(error) },
                    );
                }
            }
            const serverClosed = new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
            server.closeAllConnections();
            await serverClosed;
            resolveStopped?.();
        })();
    };
    const startupRequestListener = createDaemonStartupRequestListener({
        getState: () => startupState,
        identity,
        onShutdown: () => stopServer("Shutdown requested through the daemon protocol."),
        token,
    });
    const server = createServer(startupRequestListener);
    const writeServerRegistry = () => {
        const inspectorUrl = getNodeInspectorUrl();
        return writeRegistry(paths.registryPath, {
            ...(inspectorUrl === undefined ? {} : { inspectorUrl }),
            pid: process.pid,
            socketPath,
            startedAt,
        });
    };
    let initialization = Promise.resolve();
    let fatalDatabaseFailure: unknown;
    const reportStartupError = (error: unknown) => {
        if (stopping) return;
        const message = errorToMessage(error);
        startupState = { error: message, status: "error" };
        daemonLog.record("error", "daemon_startup_failed", "Rig daemon could not start.", {
            error: message,
        });
    };
    const reportInitializationFailure = (error: unknown) => {
        if (isDatabaseFailure(error)) {
            fatalDatabaseFailure ??= error;
            daemonLog.record("error", "daemon_startup_failed", "Rig daemon could not start.", {
                error: errorToMessage(error),
            });
            stopServer("Database failure during daemon initialization.");
            return;
        }
        reportStartupError(error);
    };
    const stopForSigint = () => stopServer("Received SIGINT.");
    const stopForSigterm = () => stopServer("Received SIGTERM.");
    try {
        const previousUmask = process.umask(0o077);
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, () => {
                    server.off("error", reject);
                    resolve();
                });
            });
        } finally {
            process.umask(previousUmask);
        }
        process.once("SIGINT", stopForSigint);
        process.once("SIGTERM", stopForSigterm);
        try {
            await chmod(socketPath, 0o600);
            if (stopping) {
                await stopped;
                return;
            }
            await writeServerRegistry();
        } catch (error) {
            reportStartupError(error);
            await stopped;
            return;
        }
        if (stopping) {
            await stopped;
            return;
        }

        initialization = initializeDaemon().catch(reportInitializationFailure);

        await stopped;
        await initialization;
    } finally {
        process.off("SIGINT", stopForSigint);
        process.off("SIGTERM", stopForSigterm);
        await initialization;
        // Idempotent: a daemon that failed before stopServer ran still releases its watches here.
        gitStateTracker?.dispose();
        if (mcpToolProvider !== undefined) {
            try {
                await mcpToolProvider.close();
            } catch (error) {
                if (isDatabaseFailure(error)) fatalDatabaseFailure ??= error;
                daemonLog.record(
                    "error",
                    "daemon_mcp_shutdown_failed",
                    "Rig daemon could not close every MCP connection.",
                    { error: errorToMessage(error) },
                );
            }
        }
        try {
            await runHappyLifecycle(async () => {
                const service = happySyncService;
                happySyncService = undefined;
                await service?.close();
            });
        } catch (error) {
            daemonLog.record(
                "error",
                "daemon_happy_shutdown_failed",
                "Rig daemon could not close Happy sync.",
                { error: errorToMessage(error) },
            );
            if (isDatabaseFailure(error)) fatalDatabaseFailure ??= error;
        }
        try {
            store?.close();
        } finally {
            daemonLog.record("info", "daemon_stopped", "Rig daemon stopped.");
            uninstallProcessFailureLogging();
        }
    }
    if (fatalDatabaseFailure !== undefined) throw fatalDatabaseFailure;

    async function initializeDaemon(): Promise<void> {
        try {
            await ensureUserConfigurationFiles();
        } catch (error) {
            daemonLog.record(
                "warning",
                "daemon_user_configuration_initialization_failed",
                "Rig could not create the default user configuration files.",
                { error: errorToMessage(error) },
            );
        }
        const loadedConfig = await loadConfig({ cwd: process.cwd() });
        const machineProtectedPaths = [
            ...new Set([
                ...(loadedConfig.sources.global.values.permissions?.protectedPaths ?? []),
                ...(loadedConfig.sources.runtime.values.permissions?.protectedPaths ?? []),
            ]),
        ];
        if (stopping) return;
        const runtimeSettings = {
            inferenceMaxRetries: loadedConfig.config.settings.inferenceMaxRetries,
        };

        const providerUsageService = createProviderUsageService({
            loadUsage: (providerId) =>
                loadConfiguredProviderUsage({
                    providerId,
                    providers: loadedConfig.config.providers,
                }),
            onError: (providerId, error) => {
                daemonLog.record(
                    "warning",
                    "provider_usage_poll_failed",
                    "Rig could not read a provider's usage.",
                    { error: errorToMessage(error), providerId },
                );
            },
        });
        const providerQuotaService = createProviderQuotaService({
            loadClaudeUsage: (providerId) => providerUsageService.get(providerId),
            providers: loadedConfig.config.providers,
        });
        providerUsageTracker = createProviderUsageTracker({
            loadUsage: (providerId) => providerUsageService.get(providerId),
            providerIds: Object.keys(loadedConfig.config.providers),
            shutdown,
        });
        providerUsageTracker.start();
        const disabledProviderReasons = await resolveProviderDisabledReasons(
            loadedConfig.config.providers,
            process.env,
        );
        if (stopping) return;
        const availableProviders = disableUnavailableProviders(
            loadedConfig.config.providers,
            disabledProviderReasons,
        );
        const modelCatalog = createModelCatalog({
            cwd: process.cwd(),
            disabledProviderReasons,
            providers: loadedConfig.config.providers,
        });
        const pluginMcpRegistry = new PluginMcpRegistry();
        mcpToolProvider = new CompositeMcpToolProvider([new McpClientManager(), pluginMcpRegistry]);
        taskDrain = new TrackedTaskDrain();
        gitStateTracker = new GitStateTracker({
            // Snapshots ride the live channel, so they reach subscribers without ever entering the
            // durable log; branch and HEAD changes travel as ordinary project/workspace updates.
            // No store means nobody received it, which is a delivery failure rather than a
            // silent success.
            onLiveEvent: (event) =>
                store === undefined ? false : publishGitLiveEvent(store, event),
            onObserverError: (error, entity) => {
                daemonLog.record(
                    "error",
                    "git_state_observer_failed",
                    "Rig could not record or publish a Git state update.",
                    {
                        error: errorToMessage(error),
                        projectId: entity.projectId,
                        ...(entity.workspaceId === undefined
                            ? {}
                            : { workspaceId: entity.workspaceId }),
                    },
                );
            },
            onSnapshot: (entity, snapshot) => {
                const target = {
                    projectId: entity.projectId,
                    ...(entity.workspaceId === undefined
                        ? {}
                        : { workspaceId: entity.workspaceId }),
                };
                // Sessions carry Git state on their own stream, so a client
                // watching a conversation never has to open the project stream
                // as well to see which files changed.
                store?.applyGitSnapshot(target, snapshot);
                if (snapshot.comparison !== "ready") return;
                store?.applyGitFacts(target, snapshot.facts);
            },
            taskDrain,
        });
        const happyModule = await loadHappyIntegration(
            resolveHappyIntegrationMode(
                options.happyIntegration,
                loadedConfig.config.settings.happyIntegration,
            ),
        );
        const happyConfiguration = await happyModule?.importHappyCredentials({
            machineScope: socketPath,
        });
        // Sessions are created before the plugin manager exists, so they reach it through a stable
        // handle rather than a captured instance.
        let pluginManager: PluginManager | undefined;
        const plugins: PluginContext = {
            applySystemPrompt: (input) =>
                requirePluginManager(pluginManager).applySystemPrompt(input),
            callAppTool: (...parameters) =>
                requirePluginManager(pluginManager).callAppTool(...parameters),
            discoverRepository: (...parameters) =>
                requirePluginManager(pluginManager).discoverRepository(...parameters),
            install: (request) => requirePluginManager(pluginManager).install(request),
            installFromGitHub: (...parameters) =>
                requirePluginManager(pluginManager).installFromGitHub(...parameters),
            loadSkills: (fs) => requirePluginManager(pluginManager).loadSkills(fs),
            loadSystemPrompt: () => requirePluginManager(pluginManager).loadSystemPrompt(),
            list: () => requirePluginManager(pluginManager).list(),
            readIcon: (...parameters) =>
                requirePluginManager(pluginManager).readIcon(...parameters),
            network: {
                interceptHttp: (request) =>
                    requirePluginManager(pluginManager).interceptHttp(request),
                observeTunnel: (tunnel) =>
                    requirePluginManager(pluginManager).observeTunnel(tunnel),
                recordFailure: (hostname, error) =>
                    requirePluginManager(pluginManager).recordFailure(hostname, error),
                shouldIntercept: (hostname) =>
                    requirePluginManager(pluginManager).shouldIntercept(hostname),
            },
            readAppResource: (...parameters) =>
                requirePluginManager(pluginManager).readAppResource(...parameters),
            readLog: (name) => requirePluginManager(pluginManager).readLog(name),
            storageDelete: (...parameters) =>
                requirePluginManager(pluginManager).storageDelete(...parameters),
            storageGet: (...parameters) =>
                requirePluginManager(pluginManager).storageGet(...parameters),
            storageList: (...parameters) =>
                requirePluginManager(pluginManager).storageList(...parameters),
            storageSet: (...parameters) =>
                requirePluginManager(pluginManager).storageSet(...parameters),
            trace: (event) => requirePluginManager(pluginManager).trace(event),
            uninstall: (request) => requirePluginManager(pluginManager).uninstall(request),
        };
        store = new PersistentSessionStore({
            createRuntime: (options) =>
                createCodingAssistantAgent({
                    ...options,
                    // What a provider says about the account while it answers is
                    // both the daemon's freshest reading and the session's, so
                    // the session is told the complete merged picture.
                    onAccountUsage: (usage) => {
                        const merged = providerUsageService.record(usage);
                        providerUsageTracker?.observe(merged);
                        options.onAccountUsage?.(merged);
                    },
                    plugins,
                    providerUsage: {
                        current: async () => (await providerUsageTracker?.refreshAll()) ?? [],
                    },
                    providers: availableProviders,
                    protectedPaths: resolveProtectedPaths(options.cwd, machineProtectedPaths),
                    resolveInferenceMaxRetries: () => runtimeSettings.inferenceMaxRetries,
                }),
            databasePath: paths.databasePath,
            ...(loadedConfig.config.docker === undefined
                ? {}
                : { defaultDocker: loadedConfig.config.docker }),
            durableGlobalEventQueue: loadedConfig.config.settings.durableGlobalEventQueue,
            presence: createConfiguredPresenceStore(loadedConfig.config.presence),
            mcpToolProvider,
            modelCatalog,
            workspacesDirectory: getManagedWorkspacesDirectory(),
            workspaceFeatures: {
                crossWorkspace: loadedConfig.config.features.crossWorkspace,
                workspaces: loadedConfig.config.features.workspaces,
            },
            ...(happyModule === undefined
                ? {}
                : { onSessionAccess: (session) => happySyncService?.attach(session) }),
            onSessionEvent: (event, session) => {
                recordProviderFailure(daemonLog, event);
                if (happyModule !== undefined) happySyncService?.observe(event, session);
                shareRuntime?.kinds.session.wake(event.sessionId);
                const shared = session?.projectIdentity();
                if (shared !== undefined) {
                    shareRuntime?.kinds.scope.wakeForSession({
                        projectId: shared.projectId,
                        ...(shared.workspaceId === undefined
                            ? {}
                            : { workspaceId: shared.workspaceId }),
                    });
                }
                if (store !== undefined && gitStateTracker !== undefined) {
                    const identity = session?.projectIdentity();
                    markGitStateFromSessionEvent(
                        event,
                        store,
                        gitStateTracker,
                        ...(identity === undefined ? [] : ([identity] as const)),
                    );
                }
            },
            onWorkspaceCleanupError: (error, projectId, workspaceId) => {
                daemonLog.record(
                    "warning",
                    "workspace_cleanup_failed",
                    "Rig archived the workspace, but could not remove all of its local residue.",
                    {
                        error: errorToMessage(error),
                        projectId,
                        workspaceId,
                    },
                );
            },
            taskDrain,
        });
        const activeStore = store;
        const p2pPeerTrustStore = new P2pPeerTrustStore(activeStore);
        const p2pNode: {
            name: string;
            primaryId?: string;
            role: "primary" | "secondary";
        } = {
            name: loadedConfig.config.p2p.name,
            ...(loadedConfig.config.p2p.primaryId === undefined
                ? {}
                : { primaryId: loadedConfig.config.p2p.primaryId }),
            role: loadedConfig.config.p2p.role,
        };
        let assignP2pPrimary = Promise.resolve();
        const canP2pPeerConfigure = (peerId: string): boolean => {
            if (p2pNode.role !== "secondary" || p2pNode.primaryId !== peerId) return false;
            try {
                return p2pPeerTrustStore.peers().some((peer) => peer.instanceId === peerId);
            } catch {
                return false;
            }
        };
        const setP2pPrimaryIfUnset = (primaryId: string): Promise<void> => {
            const assignment = assignP2pPrimary.then(async () => {
                if (p2pNode.primaryId !== undefined) return;
                await writeP2pNodeSettings({ primaryId, role: "secondary" });
                p2pNode.primaryId = primaryId;
                p2pNode.role = "secondary";
            });
            assignP2pPrimary = assignment.catch(() => undefined);
            return assignment;
        };
        try {
            await recoverP2pPairings(p2pPeerTrustStore, setP2pPrimaryIfUnset);
        } catch (error) {
            daemonLog.record(
                "warning",
                "p2p_pairing_recovery_failed",
                "Rig could not finish a confirmed P2P pairing.",
                { error: errorToMessage(error) },
            );
        }
        const p2pIdentity = await loadOrCreateP2pIdentity(paths.p2pIdentityPath).catch(
            (error: unknown) => {
                daemonLog.record(
                    "warning",
                    "p2p_identity_unavailable",
                    "P2P identity and pairing are unavailable.",
                    { error: errorToMessage(error) },
                );
                return undefined;
            },
        );
        if (p2pIdentity !== undefined) {
            try {
                const irohSecret = await loadOrCreateIrohSecretKey(paths.irohSecretKeyPath);
                p2pPairingService = new P2pPairingService({
                    config: loadedConfig.config.p2p.iroh,
                    identity: p2pIdentity,
                    name: () => p2pNode.name,
                    onPeerTrusted: (peer) => p2pNetwork?.addTrustedPeer(peer),
                    peerTrustStore: p2pPeerTrustStore,
                    setPrimaryIfUnset: setP2pPrimaryIfUnset,
                    stableIrohEndpointId: irohSecret.public().toString(),
                    stableIrohEndpointTicket: async () => {
                        const ticket = await p2pNetwork?.irohEndpointTicket();
                        if (ticket === undefined) {
                            throw new Error("The stable Iroh P2P endpoint is unavailable.");
                        }
                        return ticket;
                    },
                });
            } catch (error) {
                daemonLog.record(
                    "warning",
                    "p2p_pairing_unavailable",
                    "P2P invitation and join are unavailable.",
                    { error: errorToMessage(error) },
                );
            }
        }
        const createP2pStatusEventId = createEventIdFactory();
        const publishP2pStatus = (status: P2pStatus): void => {
            const event: GlobalLiveEvent = {
                createdAt: Date.now(),
                data: { status },
                id: createP2pStatusEventId(),
                type: "p2p_status_changed",
            };
            activeStore.globalEventQueue.publishLive(event);
            activeStore.liveEvents.publish(event);
        };
        p2pNetwork = await P2pNetwork.create({
            config: loadedConfig.config.p2p,
            ...(p2pIdentity === undefined ? {} : { identity: p2pIdentity }),
            identityPath: paths.p2pIdentityPath,
            irohSecretKeyPath: paths.irohSecretKeyPath,
            onStatusChange: publishP2pStatus,
            onTransportUnavailable: (transport, error) => {
                daemonLog.record(
                    "warning",
                    "p2p_transport_unavailable",
                    "A P2P transport is unavailable.",
                    { error: errorToMessage(error), transport },
                );
            },
            peerTrustStore: p2pPeerTrustStore,
            serveRequest: createServeP2pHttpRequest({
                allowRequest: (peerId, request) =>
                    loadedConfig.config.p2p.exposeApi ||
                    (canP2pPeerConfigure(peerId) && isP2pConfigurationPath(request.path)),
                socketPath,
                token,
            }),
            serveTunnel: createServeP2pTunnel({ socketPath, token }),
        });
        const irohStatus = p2pNetwork
            .status()
            .transports.find(
                (transport) => transport.transport === "iroh" && transport.state === "ready",
            );
        if (irohStatus?.state === "ready") {
            daemonLog.record("info", "iroh_started", "Rig P2P networking is ready.", {
                endpointId: irohStatus.localAddress,
                instanceId: p2pNetwork.status().instanceId,
                peers: p2pPeerTrustStore
                    .peers()
                    .filter((peer) => peer.connections.iroh !== undefined).length,
                ...(loadedConfig.config.p2p.iroh.relayUrl === undefined
                    ? {}
                    : { relayUrl: loadedConfig.config.p2p.iroh.relayUrl }),
            });
        }
        shutdown.register("p2p", async () => {
            await p2pPairingService?.close();
            await p2pNetwork?.close();
        });
        murmurService = new MurmurService({
            publishGlobalEvent: (event) => {
                const entry = activeStore.globalEventQueue.appendReplaySafe(event);
                if (entry !== undefined) activeStore.globalEventQueue.publish(entry);
                if (entry !== undefined) activeStore.liveEvents.publish(event);
            },
            storeFactory: () =>
                new SqliteMurmurStore(join(dirname(paths.databasePath), "murmur.sqlite")),
        });
        await murmurService.getAccount();
        const activeMurmur = murmurService;
        const createSessionShareCapabilitiesEventId = createEventIdFactory();
        /**
         * Resolves the session one share belongs to, and the terminal scope it runs in.
         *
         * Every peer question is really a question about the owner's session: which
         * project, which workspace, which container, which permission mode. Asking the
         * share for its owner session and then asking the session is the only path, so
         * a share that has been stopped or a session that has ended answers nothing
         * rather than answering stale.
         */
        const peerShareSession = (shareId: string) => {
            const ownerSessionId =
                activeStore.sessionShareDaemonStore.queryShare(shareId)?.ownerSessionId;
            if (ownerSessionId === undefined) return undefined;
            const session = activeStore.get(ownerSessionId);
            return session === undefined ? undefined : { session, snapshot: session.snapshot() };
        };
        const peerCapabilities = new PeerCapabilityContext({
            recordAction: (entry) => {
                try {
                    activeStore.sessionShareDaemonStore.appendPeerAction({
                        ...entry,
                        now: Date.now(),
                    });
                } catch {
                    // An audit row that cannot be written must never turn an allowed action
                    // into a crash or a denied one into an allowed one. The decision has
                    // already been made and returned; this is the record of it.
                }
            },
            resolveGrant: (request) => {
                const owner = peerShareSession(request.shareId);
                if (owner === undefined) return undefined;
                // Gate one, in full: the row must exist, be active, sit at the member's
                // current epoch, and belong to a member that is itself active. The query
                // answers all four or answers nothing.
                const row = activeStore.sessionShareDaemonStore.queryMemberCapability({
                    capability: request.capability,
                    shareId: request.shareId,
                    shareMemberId: request.shareMemberId,
                });
                if (row === undefined) return undefined;
                // The session's mode is read here, at use time, rather than stored with
                // the grant. The capability is intent; what it amounts to is whatever the
                // owner's session permits right now.
                return { grantEpoch: row.grantEpoch, sessionMode: owner.snapshot.permissionMode };
            },
        });
        const peerTerminalViewer = new PeerTerminalViewerService({
            activeMemberCount: (shareId) =>
                activeStore.sessionShareDaemonStore
                    .queryMembers(shareId)
                    .filter((member) => member.state === "active").length,
            capabilities: peerCapabilities,
            terminal: (shareId, terminalId) => {
                const owner = peerShareSession(shareId);
                if (owner === undefined) return undefined;
                return activeStore.remoteTerminals.get(
                    {
                        projectId: owner.snapshot.projectId,
                        ...(owner.snapshot.workspaceId === undefined
                            ? {}
                            : { workspaceId: owner.snapshot.workspaceId }),
                    },
                    terminalId,
                );
            },
        });
        shareRuntime = createShareRuntime({
            kinds: {
                scope: createScopeShareKind({
                    daemonStore: activeStore.scopeShareDaemonStore,
                    shareStore: activeStore.scopeShares,
                }),
                session: createSessionShareKind({
                    daemonStore: activeStore.sessionShareDaemonStore,
                    docker: (ownerSessionId) => {
                        const session = activeStore.get(ownerSessionId);
                        if (session === undefined) return undefined;
                        const snapshot = session.snapshot();
                        return activeStore.remoteTerminalDocker({
                            projectId: snapshot.projectId,
                            ...(snapshot.workspaceId === undefined
                                ? {}
                                : { workspaceId: snapshot.workspaceId }),
                        });
                    },
                    peerAccess: peerCapabilities,
                    peerTerminalViewer,
                    deliverFriendMessage: (ownerSessionId, message, persisted) => {
                        activeStore
                            .get(ownerSessionId)
                            ?.applyPersistedFriendMessage(message, persisted);
                    },
                    publishCapabilities: (change) => {
                        // Cheap and authoritative: the durable member row this daemon just
                        // wrote, rather than inferring state from the capability list alone.
                        const memberState =
                            activeStore.sessionShareDaemonStore
                                .queryMembers(change.shareId)
                                .find((member) => member.shareMemberId === change.shareMemberId)
                                ?.state ?? "revoked";
                        const event: GlobalLiveEvent = {
                            createdAt: Date.now(),
                            data: {
                                capabilities: [...change.capabilities],
                                capabilitiesDescription: describePeerCapabilities(
                                    change.capabilities,
                                ),
                                memberState,
                                shareId: change.shareId,
                                shareMemberId: change.shareMemberId,
                            },
                            id: createSessionShareCapabilitiesEventId(),
                            type: "session_share_capabilities_changed",
                        };
                        activeStore.liveEvents.publish(event);
                        activeStore.globalEventQueue.publishLive(event);
                        // The owner's own session stream has to say so too. The global
                        // event reaches a client watching the machine; this reaches the
                        // client watching the session being shared, which is the one whose
                        // owner must never be able to forget somebody is attached.
                        const ownerSessionId = activeStore.sessionShareDaemonStore.queryShare(
                            change.shareId,
                        )?.ownerSessionId;
                        if (ownerSessionId !== undefined) {
                            activeStore.get(ownerSessionId)?.noteShareCapabilitiesChanged();
                        }
                    },
                    shareStore: activeStore.sessionShares,
                }),
            },
            murmur: activeMurmur,
            reportFailure: (error) => {
                daemonLog.record(
                    "warning",
                    "share_event_dropped",
                    "A sharing event could not be applied and was skipped.",
                    { error: error instanceof Error ? error.message : String(error) },
                );
            },
        });
        shutdown.register("sharing", async () => {
            await shareRuntime?.close();
        });
        shutdown.register("murmur", async () => {
            await murmurService?.close();
        });
        const startedPluginManager = (pluginManager = new PluginManager({
            daemonLog,
            ...(loadedConfig.config.docker === undefined
                ? {}
                : { defaultDocker: loadedConfig.config.docker }),
            listProviderUsage: () => providerUsageTracker?.all() ?? [],
            generatedMedia: createGeneratedMediaStore({
                hostDirectory: getGeneratedDirectory(),
            }),
            mcpRegistry: pluginMcpRegistry,
            store,
        }));
        const pluginsStarted = startedPluginManager.start().catch((error: unknown) => {
            daemonLog.record(
                "error",
                "plugins_unavailable",
                "Rig could not load the plugins folder.",
                {
                    error: errorToMessage(error),
                    pluginsDirectory: startedPluginManager.directory,
                },
            );
        });
        shutdown.register("plugins", async () => {
            await startedPluginManager.close();
            await pluginsStarted;
        });
        await pluginsStarted;
        if (stopping) return;
        if (happyModule !== undefined && happyConfiguration !== undefined) {
            try {
                const service = new happyModule.HappySyncService({
                    configuration: happyConfiguration,
                    createSession: (id, request) =>
                        store!.createWithId(
                            id,
                            configureSessionRequest(request, loadedConfig.config.docker, () =>
                                store!.queryProjectSettings(request.cwd),
                            ),
                        ),
                    databasePath: paths.databasePath,
                    getSubagents: (sessionId) => store?.listSubagents(sessionId) ?? [],
                    getProjectContext: (session) => {
                        const snapshot = session.snapshot();
                        const project = store?.getProject(snapshot.projectId);
                        if (project === undefined) return undefined;
                        const workspace =
                            snapshot.workspaceId === undefined
                                ? undefined
                                : store?.getWorkspace(project.id, snapshot.workspaceId);
                        return {
                            project,
                            ...(workspace === undefined ? {} : { workspace }),
                        };
                    },
                    loadSession: (sessionId) => store?.get(sessionId),
                    modelCatalog,
                });
                service.start();
                happySyncService = service;
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                daemonLog.record(
                    "warning",
                    "daemon_happy_unavailable",
                    "Happy sync is unavailable.",
                    { error: errorToMessage(error) },
                );
            }
        }
        registerRigDebugRoot({
            kind: "daemon",
            paths,
            server,
            store,
        });
        if (stopping) {
            taskDrain.beginClose();
            return;
        }

        createProtocolHttpServer(
            {
                inferenceMaxRetries: runtimeSettings.inferenceMaxRetries,
                ...(loadedConfig.config.docker === undefined
                    ? {}
                    : { defaultDocker: loadedConfig.config.docker }),
                ...(store.globalEventQueue === undefined
                    ? {}
                    : { globalEventQueue: store.globalEventQueue }),
                ...(gitStateTracker === undefined ? {} : { gitStateTracker }),
                modelCatalog,
                happyCloud: store.happyCloud,
                p2pNetwork,
                ...(p2pPairingService === undefined ? {} : { p2pPairing: p2pPairingService }),
                p2pNode: () => ({ ...p2pNode }),
                p2pStatus: () => p2pNetwork?.status() ?? { transports: [] },
                canP2pPeerConfigure,
                murmur: murmurService,
                ...(shareRuntime === undefined
                    ? {}
                    : {
                          scopeShares: shareRuntime.kinds.scope.contract,
                          sessionShares: shareRuntime.kinds.session.contract,
                      }),
                plugins,
                getProviderQuota: (providerId) => providerQuotaService.get(providerId),
                listProviderUsage: () => providerUsageTracker?.all() ?? [],
                onDaemonConfigChange: async (config) => {
                    await writeDaemonSettings(config.settings, {}, config.p2p.name);
                    const globalEventQueue = store?.setDurableGlobalEventQueue(
                        config.settings.durableGlobalEventQueue,
                    );
                    if (globalEventQueue === undefined) return undefined;
                    runtimeSettings.inferenceMaxRetries = config.settings.inferenceMaxRetries;
                    p2pNode.name = config.p2p.name;
                    p2pNetwork?.setName(config.p2p.name);
                    if (p2pNetwork !== undefined) publishP2pStatus(p2pNetwork.status());
                    return {
                        inferenceMaxRetries: runtimeSettings.inferenceMaxRetries,
                        globalEventQueue,
                    };
                },
                ...(happyModule === undefined
                    ? {}
                    : {
                          onReloadHappy: async () => {
                              if (stopping) return false;
                              return runHappyLifecycle(async () => {
                                  if (stopping) return false;
                                  const nextConfiguration =
                                      await happyModule.importHappyCredentials({
                                          machineScope: socketPath,
                                      });
                                  if (stopping || nextConfiguration === undefined) return false;
                                  let next: HappySyncService;
                                  try {
                                      next = new happyModule.HappySyncService({
                                          configuration: nextConfiguration,
                                          createSession: (id, request) =>
                                              store!.createWithId(
                                                  id,
                                                  configureSessionRequest(
                                                      request,
                                                      loadedConfig.config.docker,
                                                      () =>
                                                          store!.queryProjectSettings(request.cwd),
                                                  ),
                                              ),
                                          databasePath: paths.databasePath,
                                          getSubagents: (sessionId) =>
                                              store?.listSubagents(sessionId) ?? [],
                                          getProjectContext: (session) => {
                                              const snapshot = session.snapshot();
                                              const project = store?.getProject(snapshot.projectId);
                                              if (project === undefined) return undefined;
                                              const workspace =
                                                  snapshot.workspaceId === undefined
                                                      ? undefined
                                                      : store?.getWorkspace(
                                                            project.id,
                                                            snapshot.workspaceId,
                                                        );
                                              return {
                                                  project,
                                                  ...(workspace === undefined ? {} : { workspace }),
                                              };
                                          },
                                          loadSession: (sessionId) => store?.get(sessionId),
                                          modelCatalog,
                                      });
                                  } catch (error) {
                                      if (isDatabaseFailure(error)) throw error;
                                      daemonLog.record(
                                          "error",
                                          "daemon_happy_reload_failed",
                                          "Happy sync could not reload.",
                                          { error: errorToMessage(error) },
                                      );
                                      return false;
                                  }
                                  const previous = happySyncService;
                                  happySyncService = undefined;
                                  try {
                                      await previous?.close();
                                  } catch (error) {
                                      if (isDatabaseFailure(error)) throw error;
                                      daemonLog.record(
                                          "warning",
                                          "daemon_happy_previous_close_failed",
                                          "The previous Happy sync connection could not close cleanly.",
                                          { error: errorToMessage(error) },
                                      );
                                  }
                                  next.start();
                                  happySyncService = next;
                                  for (const session of store!.loadedSessions()) {
                                      next.attach(session);
                                  }
                                  return true;
                              });
                          },
                      }),
                onStartInspector: async () => {
                    const inspectorUrl = openNodeInspector();
                    await writeServerRegistry();
                    return { inspectorUrl };
                },
                onShutdown: () => stopServer("Shutdown requested through the daemon protocol."),
                store,
                taskDrain,
                token,
            },
            server,
        );
        server.off("request", startupRequestListener);
        daemonLog.record("info", "daemon_ready", "Rig daemon is ready.", {
            databasePath: paths.databasePath,
            socketPath,
        });
    }
}

function requirePluginManager(manager: PluginManager | undefined): PluginManager {
    if (manager === undefined)
        throw new Error("Rig is still starting, so plugins are unavailable.");
    return manager;
}

function isP2pConfigurationPath(path: string): boolean {
    const pathname = new URL(path, "http://rig.local").pathname;
    return (
        pathname === "/config" ||
        pathname === "/config/instructions" ||
        pathname === "/config/security"
    );
}

async function writeRegistry(path: string, payload: unknown): Promise<void> {
    const file = await open(path, "w", 0o600);
    try {
        await file.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
        await file.chmod(0o600);
    } finally {
        await file.close();
    }
}
