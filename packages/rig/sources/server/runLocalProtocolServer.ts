import { chmod, open } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import {
    beginProtocolHttpServerShutdown,
    createProtocolHttpServer,
} from "./createProtocolHttpServer.js";
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
import { createP2pStatusChangedEvent } from "./createP2pStatusChangedEvent.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { TrackedTaskDrain } from "../utils/TrackedTaskDrain.js";
import { readLocalServerToken } from "./readLocalServerToken.js";
import { removeStaleSocket } from "./removeStaleSocket.js";
import { resolveHappyIntegrationMode } from "./resolveHappyIntegrationMode.js";
import {
    ensureUserConfigurationFiles,
    loadConfig,
    writeDaemonSettings,
    writeP2pNodeSettings,
} from "../config/index.js";
import { MILLISECONDS_PER_DAY } from "../config/toolResultRetentionSettings.js";
import { createConfiguredPresenceStore } from "../presence/index.js";
import { createProviderQuotaService } from "../provider-services/createProviderQuotaService.js";
import {
    createProviderUsageTracker,
    type ProviderUsageTracker,
} from "../provider-services/createProviderUsageTracker.js";
import { createProviderUsageService } from "../provider-services/createProviderUsageService.js";
import { createCredentialBindingUsageRouter } from "../provider-services/createCredentialBindingUsageRouter.js";
import { loadConfiguredProviderUsage } from "../provider-services/loadConfiguredProviderUsage.js";
import { gracefulShutdown } from "../concurrency/index.js";
import { disableUnavailableProviders } from "../provider-services/disableUnavailableProviders.js";
import { resolveProviderDisabledReasons } from "../provider-services/resolveProviderDisabledReasons.js";
import { getDaemonIdentity } from "../daemon/index.js";
import { errorToMessage } from "../errorToMessage.js";
import {
    acquireSqliteProcessLock,
    SqliteProcessLockUnavailableError,
    type SqliteProcessLock,
} from "../persistence/database/acquireSqliteProcessLock.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import {
    closeNodeInspector,
    getNodeInspectorUrl,
    openNodeInspector,
    registerRigDebugRoot,
} from "../debug/index.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { RigUserError } from "../RigUserError.js";
import type { HappySyncService } from "../happy/index.js";
import { getManagedWorkspacesDirectory } from "../project/getManagedWorkspacesDirectory.js";
import type { LocalServerPaths } from "./LocalServerPaths.js";
import { writeDaemonCrashReport } from "./writeDaemonCrashReport.js";
import type { PluginContext } from "../agent/context/PluginContext.js";
import { RigAgentService } from "../agent/RigAgentService.js";
import { PluginManager, PluginMcpRegistry } from "../plugins/index.js";
import { WorkletManager, WorkletToolRegistry } from "../worklets/index.js";
import { createGeneratedMediaStore, getGeneratedDirectory } from "../generated-media/index.js";
import { createEventIdFactory, type GlobalLiveEvent, type P2pStatus } from "../protocol/index.js";
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
import {
    P2pProfileReplicator,
    replicateProfileForP2pRequest,
    RigProfileStore,
} from "../profiles/index.js";
import { GitHubSecretSync } from "../secrets/index.js";
import {
    createLocalCredentialSnapshot,
    P2pCredentialReplicator,
    P2pCredentialRuntimeRegistry,
    P2pCredentialStore,
} from "../credentials/index.js";
import { OnboardingService } from "../onboarding/OnboardingService.js";
import { prepareRemoteWorkGitSecret } from "./prepareRemoteWorkGitSecret.js";
import { resetMurmurStore, SharingLifecycleService, SharingService } from "../sharing/index.js";
import {
    createProcessContext,
    createDaemonLogger,
    initializeDaemonContext,
    startObservability,
    withWorkerContext,
} from "../observability/index.js";
import type { Context } from "@steve.kite/stdlib";

export interface RunLocalProtocolServerOptions {
    happyIntegration?: HappyIntegrationMode;
    socketPath?: string;
    tokenPath?: string;
}

export async function runLocalProtocolServer(
    options: RunLocalProtocolServerOptions = {},
): Promise<void> {
    const paths = getEnvironmentLocalServerPaths();
    const identity = getDaemonIdentity();
    const daemonLog = new DaemonLog({ path: paths.logPath, version: identity.version });
    const observability = startObservability();
    // Contexts must capture the SDK-backed tracer. Creating them first leaves the stdlib adapter
    // attached to OpenTelemetry's non-recording bootstrap tracer, which has no usable trace ID.
    initializeDaemonContext(createDaemonLogger(daemonLog), observability.tracer);
    let databaseLock: SqliteProcessLock;
    try {
        await prepareLocalServerDirectory(dirname(paths.databasePath));
        databaseLock = await withWorkerContext("database-lock", () =>
            acquireSqliteProcessLock(`${paths.databasePath}.lock`),
        );
    } catch (error) {
        await observability.shutdown();
        if (error instanceof SqliteProcessLockUnavailableError) {
            throw new RigUserError("Another Rig daemon already owns the session database.", {
                hint: "Connect to the running daemon or stop it before starting another.",
            });
        }
        throw error;
    }
    try {
        await runOwnedLocalProtocolServer(daemonLog, identity, options, paths);
    } finally {
        try {
            await observability.shutdown();
        } finally {
            await databaseLock.release();
        }
    }
}

async function runOwnedLocalProtocolServer(
    daemonLog: DaemonLog,
    identity: ReturnType<typeof getDaemonIdentity>,
    options: RunLocalProtocolServerOptions,
    paths: LocalServerPaths,
): Promise<void> {
    await prepareLocalServerDirectory(paths.directory);
    const socketPath = options.socketPath ?? paths.socketPath;
    const tokenPath = options.tokenPath ?? paths.tokenPath;
    const startedAt = new Date().toISOString();
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
    let worklets: WorkletManager | undefined;
    let p2pNetwork: P2pNetwork | undefined;
    let p2pPairingService: P2pPairingService | undefined;
    let p2pProfileReplicator: P2pProfileReplicator | undefined;
    let p2pCredentialReplicator: P2pCredentialReplicator | undefined;
    let p2pCredentialRuntimeRegistry: P2pCredentialRuntimeRegistry | undefined;
    let p2pCredentialStore: P2pCredentialStore | undefined;
    let rigProfiles: RigProfileStore | undefined;
    let onboarding: OnboardingService | undefined;
    let sharing: SharingLifecycleService | undefined;
    let happySyncService: HappySyncService | undefined;
    let happyLifecycle = Promise.resolve();
    let gitStateTracker: GitStateTracker | undefined;
    let store: PersistentSessionStore | undefined;
    let agents: RigAgentService | undefined;
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
        beginProtocolHttpServerShutdown(server);
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
                    await withWorkerContext("session-store-shutdown", (ctx) =>
                        store!.prepareForShutdown(ctx, "shutdown"),
                    );
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
            if (store !== undefined) {
                try {
                    await withWorkerContext("remote-terminals-shutdown", (ctx) =>
                        store!.remoteTerminals.close(ctx),
                    );
                } catch (error) {
                    if (isDatabaseFailure(error)) fatalDatabaseFailure ??= error;
                    daemonLog.record(
                        "error",
                        "daemon_remote_terminal_shutdown_failed",
                        "Rig daemon could not close every remote terminal.",
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
    const startupRequestListener = await withWorkerContext("startup-listener", (ctx) =>
        createDaemonStartupRequestListener(ctx, {
            getState: () => startupState,
            identity,
            onShutdown: () => stopServer("Shutdown requested through the daemon protocol."),
            token,
        }),
    );
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
    let inspectorOperation = Promise.resolve();
    const inspectorSerialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
        const result = inspectorOperation.then(operation);
        inspectorOperation = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
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

        initialization = withWorkerContext("daemon-initialize", initializeDaemon).catch(
            reportInitializationFailure,
        );

        await stopped;
        await initialization;
    } finally {
        process.off("SIGINT", stopForSigint);
        process.off("SIGTERM", stopForSigterm);
        await initialization;
        // Idempotent: a daemon that failed before stopServer ran still releases its watches here.
        gitStateTracker?.dispose();
        try {
            await runHappyLifecycle(async () => {
                const service = happySyncService;
                happySyncService = undefined;
                await withWorkerContext("happy-sync-shutdown", (ctx) => service?.close(ctx));
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
            await withWorkerContext("agent-system-close", async (ctx) => {
                await agents?.close(ctx);
                agents = undefined;
            });
        } finally {
            if (store !== undefined) {
                await withWorkerContext("session-store-close", (ctx) => store!.close(ctx));
            }
            daemonLog.record("info", "daemon_stopped", "Rig daemon stopped.");
            uninstallProcessFailureLogging();
        }
    }
    if (fatalDatabaseFailure !== undefined) throw fatalDatabaseFailure;

    async function initializeDaemon(ctx: Context): Promise<void> {
        const postReadyTasks: Array<() => void> = [];
        try {
            await ctx.span("rig.daemon.configuration.ensure", () => ensureUserConfigurationFiles());
        } catch (error) {
            daemonLog.record(
                "warning",
                "daemon_user_configuration_initialization_failed",
                "Rig could not create the default user configuration files.",
                { error: errorToMessage(error) },
            );
        }
        const loadedConfig = await ctx.span("rig.daemon.configuration.load", () =>
            loadConfig({ cwd: process.cwd() }),
        );
        // Session inference ownership is keyed by the same durable identity used to authenticate
        // P2P transport. Starting without it would make credential ownership unstable across
        // restarts, so identity initialization is now part of the daemon's core startup.
        const p2pIdentity = await ctx.span("rig.daemon.identity.load", () =>
            loadOrCreateP2pIdentity(paths.p2pIdentityPath),
        );
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
        const disabledProviderReasons = await ctx.span("rig.daemon.providers.resolve", () =>
            resolveProviderDisabledReasons(loadedConfig.config.providers, process.env),
        );
        if (stopping) return;
        const availableProviders = disableUnavailableProviders(
            loadedConfig.config.providers,
            disabledProviderReasons,
        );
        const modelCatalog = createModelCatalog(ctx, {
            cwd: process.cwd(),
            disabledProviderReasons,
            providers: loadedConfig.config.providers,
        });
        const credentialUsageRouter = createCredentialBindingUsageRouter({
            localInstanceId: p2pIdentity.instanceId,
            localProviders: availableProviders,
            localQuotaService: providerQuotaService,
            localUsageService: providerUsageService,
            observeLocalUsage: (usage) => providerUsageTracker?.observe(usage),
            resolveScope: (ownerInstanceId) => p2pCredentialRuntimeRegistry?.scope(ownerInstanceId),
        });
        const pluginMcpRegistry = new PluginMcpRegistry();
        const workletToolRegistry = new WorkletToolRegistry();
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
            onSnapshot: (entity, snapshot) =>
                withWorkerContext("git-snapshot", async (ctx) => {
                    const target = {
                        projectId: entity.projectId,
                        ...(entity.workspaceId === undefined
                            ? {}
                            : { workspaceId: entity.workspaceId }),
                    };
                    // Sessions carry Git state on their own stream, so a client
                    // watching a conversation never has to open the project stream
                    // as well to see which files changed.
                    try {
                        await store?.applyGitSnapshot(ctx, target, snapshot);
                        if (snapshot.comparison === "ready") {
                            await store?.applyGitFacts(ctx, target, snapshot.facts);
                        }
                    } catch (error: unknown) {
                        if (isDatabaseFailure(error)) {
                            rethrowDatabaseFailure(error);
                            return;
                        }
                        daemonLog.record(
                            "error",
                            "git_state_persistence_failed",
                            "Rig could not persist a Git state update.",
                            {
                                error: errorToMessage(error),
                                projectId: entity.projectId,
                                ...(entity.workspaceId === undefined
                                    ? {}
                                    : { workspaceId: entity.workspaceId }),
                            },
                        );
                    }
                }),
            taskDrain,
        });
        const happyModule = await ctx.span("rig.daemon.happy_integration.load", () =>
            loadHappyIntegration(
                resolveHappyIntegrationMode(
                    options.happyIntegration,
                    loadedConfig.config.settings.happyIntegration,
                ),
            ),
        );
        const happyConfiguration = await ctx.span("rig.daemon.happy_credentials.load", async () =>
            happyModule?.importHappyCredentials({
                machineScope: socketPath,
            }),
        );
        // Sessions are created before the plugin manager exists, so they reach it through a stable
        // handle rather than a captured instance.
        let pluginManager: PluginManager | undefined;
        const plugins: PluginContext = {
            applySystemPrompt: (ctx, input) =>
                requirePluginManager(pluginManager).applySystemPrompt(ctx, input),
            callAppTool: (...parameters) =>
                requirePluginManager(pluginManager).callAppTool(...parameters),
            discoverRepository: (...parameters) =>
                requirePluginManager(pluginManager).discoverRepository(...parameters),
            install: (ctx, request) => requirePluginManager(pluginManager).install(ctx, request),
            installFromGitHub: (...parameters) =>
                requirePluginManager(pluginManager).installFromGitHub(...parameters),
            loadSkills: (ctx, fs) => requirePluginManager(pluginManager).loadSkills(ctx, fs),
            loadSystemPrompt: (ctx) => requirePluginManager(pluginManager).loadSystemPrompt(ctx),
            list: (ctx) => requirePluginManager(pluginManager).list(ctx),
            readIcon: (...parameters) =>
                requirePluginManager(pluginManager).readIcon(...parameters),
            network: {
                interceptHttp: (ctx, request) =>
                    requirePluginManager(pluginManager).interceptHttp(ctx, request),
                observeTunnel: (tunnel) =>
                    requirePluginManager(pluginManager).observeTunnel(tunnel),
                recordFailure: (hostname, error) =>
                    requirePluginManager(pluginManager).recordFailure(hostname, error),
                shouldIntercept: (hostname) =>
                    requirePluginManager(pluginManager).shouldIntercept(hostname),
            },
            readAppResource: (...parameters) =>
                requirePluginManager(pluginManager).readAppResource(...parameters),
            readLog: (ctx, name) => requirePluginManager(pluginManager).readLog(ctx, name),
            storageDelete: (...parameters) =>
                requirePluginManager(pluginManager).storageDelete(...parameters),
            storageGet: (...parameters) =>
                requirePluginManager(pluginManager).storageGet(...parameters),
            storageList: (...parameters) =>
                requirePluginManager(pluginManager).storageList(...parameters),
            storageSet: (...parameters) =>
                requirePluginManager(pluginManager).storageSet(...parameters),
            trace: (event) => requirePluginManager(pluginManager).trace(event),
            uninstall: (ctx, request) =>
                requirePluginManager(pluginManager).uninstall(ctx, request),
        };
        store = await ctx.span("rig.daemon.session_store.open", () =>
            PersistentSessionStore.open(ctx, {
                databasePath: paths.databasePath,
                ...(loadedConfig.config.docker === undefined
                    ? {}
                    : { defaultDocker: loadedConfig.config.docker }),
                durableGlobalEventQueue: loadedConfig.config.settings.durableGlobalEventQueue,
                toolResultRetentionMs:
                    loadedConfig.config.settings.toolResultRetentionDays * MILLISECONDS_PER_DAY,
                presence: createConfiguredPresenceStore(loadedConfig.config.presence),
                localInstanceId: p2pIdentity.instanceId,
                modelCatalog,
                resolveModelCatalog: (ownerInstanceId) =>
                    p2pCredentialRuntimeRegistry?.catalog(ownerInstanceId) ?? modelCatalog,
                workspacesDirectory: getManagedWorkspacesDirectory(),
                workspaceFeatures: {
                    crossWorkspace: loadedConfig.config.features.crossWorkspace,
                    workspaces: loadedConfig.config.features.workspaces,
                },
                ...(happyModule === undefined
                    ? {}
                    : {
                          onSessionAccess: (session) => {
                              const service = happySyncService;
                              if (service?.shouldAttachOnAccess(session) !== true) return;
                              void withWorkerContext("happy-session-access", (ctx) =>
                                  service.attach(ctx, session),
                              ).catch(rethrowDatabaseFailure);
                          },
                      }),
                onSessionEvent: async (event, session) => {
                    recordProviderFailure(daemonLog, event);
                    if (happyModule !== undefined) {
                        await withWorkerContext("happy-session-event", (ctx) =>
                            happySyncService?.observe(ctx, event, session),
                        );
                    }
                    if (store !== undefined && gitStateTracker !== undefined) {
                        const identity = session?.projectIdentity();
                        await withWorkerContext("git-session-event", (ctx) =>
                            markGitStateFromSessionEvent(
                                ctx,
                                event,
                                store!,
                                gitStateTracker!,
                                ...(identity === undefined ? [] : ([identity] as const)),
                            ),
                        );
                    }
                },
                onWorkspaceBranchError: (error, projectId, workspaceId) => {
                    daemonLog.record(
                        "warning",
                        "workspace_branch_rename_failed",
                        "Rig renamed the workspace, but its Git branch kept the name it already had.",
                        {
                            error: errorToMessage(error),
                            projectId,
                            workspaceId,
                        },
                    );
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
                taskDrain: taskDrain!,
            }),
        );
        const agentSystemCtx = createProcessContext("agent-system");
        agents = await agentSystemCtx.span("rig.daemon.agent_system.open", () =>
            RigAgentService.open(agentSystemCtx, {
                database: store!.database,
                modelCatalog,
                providers: availableProviders,
                resolveInferenceMaxRetries: () => runtimeSettings.inferenceMaxRetries,
                resolveSession: async (ctx, sessionId) =>
                    await store?.get(ctx, sessionId, { loadAgentTree: false }),
            }),
        );
        const githubSecretSync = new GitHubSecretSync({
            register: (secret) => {
                void withWorkerContext("github-secret-register", async (ctx) => {
                    await store?.registerSpecialSecret(ctx, secret);
                });
            },
            unregister: () => {
                void withWorkerContext("github-secret-unregister", async (ctx) => {
                    await store?.unregisterSpecialSecret(ctx, "github");
                });
            },
        });
        let githubSecretStartup: Promise<void> | undefined;
        let githubSecretRefreshLoop: Promise<void> | undefined;
        postReadyTasks.push(() => {
            githubSecretStartup = withWorkerContext("github-credentials-refresh", (ctx) =>
                ctx.span("rig.daemon.github_credentials.refresh", () => githubSecretSync.refresh()),
            )
                .catch(() => undefined)
                .then(() => {
                    if (!stopping) githubSecretRefreshLoop = githubSecretSync.run(shutdown.signal);
                });
        });
        shutdown.register("GitHub credential refresh", async () => {
            await githubSecretStartup;
            await githubSecretRefreshLoop;
        });
        const activeStore = store;
        const p2pPeerTrustStore = new P2pPeerTrustStore(activeStore);
        const trustedPeerIds = new Set(
            (
                await ctx.span("rig.daemon.p2p.trusted_peers.load", () =>
                    p2pPeerTrustStore.peers(ctx),
                )
            ).map((peer) => peer.instanceId),
        );
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
                return trustedPeerIds.has(peerId);
            } catch {
                return false;
            }
        };
        const isTrustedP2pPeer = (peerId: string): boolean => {
            try {
                return trustedPeerIds.has(peerId);
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
            await ctx.span("rig.daemon.p2p.pairings.recover", () =>
                recoverP2pPairings(ctx, p2pPeerTrustStore, setP2pPrimaryIfUnset),
            );
        } catch (error) {
            daemonLog.record(
                "warning",
                "p2p_pairing_recovery_failed",
                "Rig could not finish a confirmed P2P pairing.",
                { error: errorToMessage(error) },
            );
        }
        p2pCredentialStore = new P2pCredentialStore({
            database: activeStore,
            identity: p2pIdentity,
        });
        p2pCredentialRuntimeRegistry = await ctx.span(
            "rig.daemon.p2p.credential_runtime.open",
            () =>
                P2pCredentialRuntimeRegistry.open(ctx, {
                    localCatalog: modelCatalog,
                    localInstanceId: p2pIdentity.instanceId,
                    localName: () => p2pNode.name,
                    localProviders: availableProviders,
                    peers: (ctx) => p2pPeerTrustStore.peers(ctx),
                    runtimeDirectory: join(paths.directory, "p2p-credential-runtime"),
                    store: p2pCredentialStore!,
                }),
        );
        const profilesStore = new RigProfileStore({
            database: activeStore,
            localInstanceId: p2pIdentity.instanceId,
            publish: (_ctx, event) => {
                activeStore.globalEventQueue.publishLive(event);
                activeStore.liveEvents.publish(event);
                p2pProfileReplicator?.syncProfile(_ctx, event.data.profileId, event.data.version);
            },
        });
        rigProfiles = profilesStore;
        const sharingLifecycle = new SharingLifecycleService({
            database: activeStore,
            open: (ctx) =>
                SharingService.open(ctx, {
                    database: activeStore,
                    directory: dirname(paths.databasePath),
                    folders: activeStore,
                    onError: (error) => {
                        if (isDatabaseFailure(error)) {
                            fatalDatabaseFailure ??= error;
                            stopServer("Database failure while synchronizing Sharing.");
                            return;
                        }
                        daemonLog.record(
                            "warning",
                            "sharing_sync_failed",
                            "Sharing could not synchronize contacts through Murmur.",
                            { error: errorToMessage(error) },
                        );
                    },
                    profiles: profilesStore,
                    publish: (_ctx, event) => {
                        activeStore.globalEventQueue.publishLive(event);
                        activeStore.liveEvents.publish(event);
                    },
                }),
            profiles: profilesStore,
            resetState: async (ctx) => {
                await resetMurmurStore(dirname(paths.databasePath));
                await activeStore.resetSharingState(ctx);
            },
        });
        sharing = sharingLifecycle;
        const unsubscribeFolderSharing = activeStore.liveEvents.subscribe(({ event }) => {
            if (event.type === "folders_changed") {
                void withWorkerContext("folder-sharing-change", (ctx) =>
                    sharingLifecycle.foldersChanged(ctx),
                );
            }
        });
        shutdown.register("folder sharing observer", async () => unsubscribeFolderSharing());
        shutdown.register("sharing", () =>
            withWorkerContext("sharing-shutdown", (ctx) => sharingLifecycle.close(ctx)),
        );
        try {
            await ctx.span("rig.daemon.sharing.start", () => sharingLifecycle.start(ctx));
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            daemonLog.record(
                "warning",
                "sharing_initialization_failed",
                "Sharing is unavailable because its private identity store could not be opened.",
                { error: errorToMessage(error) },
            );
        }
        onboarding = new OnboardingService({
            murmurConfigured: (ctx) => sharingLifecycle.configured(ctx),
            onboardMurmur: (ctx, request) => sharingLifecycle.onboardMurmur(ctx, request),
            persistence: activeStore,
            profileComplete: async (ctx) =>
                (await profilesStore.list(ctx)).some(
                    (profile) => profile.parentInstanceId === p2pIdentity.instanceId,
                ),
            providersConfigured: () => modelCatalog.models.length > 0,
        });
        let p2pStartup: Promise<void> | undefined;
        let publishP2pStatus = (_status: P2pStatus): void => undefined;
        postReadyTasks.push(() => {
            p2pStartup = withWorkerContext("p2p-startup", (ctx) =>
                ctx
                    .span("rig.daemon.p2p.start", async (ctx) => {
                        {
                            try {
                                const irohSecret = await ctx.span(
                                    "rig.daemon.p2p.iroh_identity.load",
                                    () => loadOrCreateIrohSecretKey(paths.irohSecretKeyPath),
                                );
                                p2pPairingService = new P2pPairingService({
                                    config: loadedConfig.config.p2p.iroh,
                                    identity: p2pIdentity,
                                    name: () => p2pNode.name,
                                    onPeerTrusted: (peer) => {
                                        trustedPeerIds.add(peer.instanceId);
                                        p2pNetwork?.addTrustedPeer(peer);
                                        void withWorkerContext("p2p-profile-peer-change", (ctx) =>
                                            p2pProfileReplicator?.peerChanged(ctx, peer.instanceId),
                                        );
                                        void withWorkerContext("p2p-credential-refresh", (ctx) =>
                                            p2pCredentialRuntimeRegistry!.refresh(ctx),
                                        );
                                        void withWorkerContext(
                                            "p2p-credential-peer-change",
                                            (ctx) =>
                                                p2pCredentialReplicator?.peerChanged(
                                                    ctx,
                                                    peer.instanceId,
                                                ),
                                        );
                                    },
                                    peerTrustStore: p2pPeerTrustStore,
                                    setPrimaryIfUnset: setP2pPrimaryIfUnset,
                                    stableIrohEndpointId: irohSecret.public().toString(),
                                    stableIrohEndpointTicket: async () => {
                                        const ticket = await p2pNetwork?.irohEndpointTicket();
                                        if (ticket === undefined) {
                                            throw new Error(
                                                "The stable Iroh P2P endpoint is unavailable.",
                                            );
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
                        const credentialConnectedPeers = new Set<string>();
                        publishP2pStatus = (status: P2pStatus): void => {
                            const event: GlobalLiveEvent = createP2pStatusChangedEvent(
                                status,
                                (peerId) => p2pNetwork?.peerApiAvailable(peerId) === true,
                                createP2pStatusEventId(),
                            );
                            activeStore.globalEventQueue.publishLive(event);
                            activeStore.liveEvents.publish(event);
                            const connected = new Set(
                                status.transports.flatMap((transport) =>
                                    transport.state === "ready"
                                        ? transport.peers.flatMap((peer) =>
                                              peer.status === "connected" &&
                                              peer.peerId !== undefined
                                                  ? [peer.peerId]
                                                  : [],
                                          )
                                        : [],
                                ),
                            );
                            for (const peerId of connected) {
                                if (!credentialConnectedPeers.has(peerId)) {
                                    void withWorkerContext("p2p-credential-peer-change", (ctx) =>
                                        p2pCredentialReplicator?.peerChanged(ctx, peerId),
                                    );
                                }
                            }
                            credentialConnectedPeers.clear();
                            for (const peerId of connected) credentialConnectedPeers.add(peerId);
                        };
                        const startedP2pNetwork = await ctx.span("rig.daemon.p2p.initialize", () =>
                            P2pNetwork.create(ctx, {
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
                                        ((isP2pCredentialPath(request.path) ||
                                            isP2pProfilePath(request.path)) &&
                                            isTrustedP2pPeer(peerId)) ||
                                        (isTrustedP2pPeer(peerId) &&
                                            isP2pRemoteWorkPath(request.path, request.method)) ||
                                        (canP2pPeerConfigure(peerId) &&
                                            isP2pConfigurationPath(request.path)),
                                    socketPath,
                                    token,
                                }),
                                serveTunnel: createServeP2pTunnel({ socketPath, token }),
                            }),
                        );
                        if (stopping) {
                            await startedP2pNetwork.close();
                            return;
                        }
                        p2pNetwork = startedP2pNetwork;
                        p2pCredentialReplicator = new P2pCredentialReplicator({
                            listPeers: (ctx) => p2pPeerTrustStore.peers(ctx),
                            network: p2pNetwork,
                            onError: (_ctx, peerId, error) => {
                                daemonLog.record(
                                    "warning",
                                    "p2p_credential_replication_failed",
                                    "Rig could not synchronize inference credentials with a peer Rig.",
                                    { error: errorToMessage(error), peerId },
                                );
                            },
                            snapshot: async (ctx) =>
                                p2pCredentialStore!.prepareOwnSnapshot(
                                    ctx,
                                    await createLocalCredentialSnapshot({
                                        credentialRecoveryDirectory: join(
                                            paths.directory,
                                            "p2p-credential-owner-recovery",
                                        ),
                                        owner: {
                                            instanceId: p2pIdentity.instanceId,
                                            publicKey: p2pIdentity.publicKey,
                                        },
                                        providers: availableProviders,
                                    }),
                                ),
                            store: p2pCredentialStore!,
                        });
                        await ctx.span("rig.daemon.p2p.credentials.sync", () =>
                            p2pCredentialReplicator!.syncAll(ctx),
                        );
                        if (rigProfiles !== undefined && p2pIdentity !== undefined) {
                            p2pProfileReplicator = new P2pProfileReplicator({
                                listPeerIds: async (ctx) =>
                                    (await p2pPeerTrustStore.peers(ctx)).map(
                                        (peer) => peer.instanceId,
                                    ),
                                localInstanceId: p2pIdentity.instanceId,
                                network: p2pNetwork,
                                onError: (_ctx, peerId, error) => {
                                    daemonLog.record(
                                        "warning",
                                        "p2p_profile_replication_failed",
                                        "Rig could not synchronize a human profile with a secondary Rig.",
                                        { error: errorToMessage(error), peerId },
                                    );
                                },
                                profiles: rigProfiles,
                            });
                            p2pProfileReplicator.syncAll(ctx, { recheckTargets: true });
                        }
                        const irohStatus = p2pNetwork
                            .status()
                            .transports.find(
                                (transport) =>
                                    transport.transport === "iroh" && transport.state === "ready",
                            );
                        if (irohStatus?.state === "ready") {
                            daemonLog.record(
                                "info",
                                "iroh_started",
                                "Rig P2P networking is ready.",
                                {
                                    endpointId: irohStatus.localAddress,
                                    instanceId: p2pNetwork.status().instanceId,
                                    peers: (await p2pPeerTrustStore.peers(ctx)).filter(
                                        (peer) => peer.connections.iroh !== undefined,
                                    ).length,
                                    ...(loadedConfig.config.p2p.iroh.relayUrl === undefined
                                        ? {}
                                        : { relayUrl: loadedConfig.config.p2p.iroh.relayUrl }),
                                },
                            );
                        }
                    })
                    .catch((error: unknown) => {
                        if (isDatabaseFailure(error)) {
                            fatalDatabaseFailure ??= error;
                            stopServer("Database failure while starting P2P networking.");
                            return;
                        }
                        daemonLog.record(
                            "warning",
                            "p2p_start_failed",
                            "P2P networking could not finish starting.",
                            { error: errorToMessage(error) },
                        );
                    }),
            );
        });
        shutdown.register("p2p", async () => {
            await p2pStartup;
            await p2pPairingService?.close();
            await withWorkerContext("p2p-profile-replicator-shutdown", (ctx) =>
                p2pProfileReplicator?.close(ctx),
            );
            await withWorkerContext("p2p-credential-replicator-shutdown", async (ctx) => {
                await p2pCredentialReplicator?.close(ctx);
            });
            await p2pNetwork?.close();
        });
        const startedPluginManager = (pluginManager = new PluginManager({
            ...(agents === undefined ? {} : { agents }),
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
        let pluginsStarted: Promise<void> | undefined;
        postReadyTasks.push(() => {
            pluginsStarted = withWorkerContext("plugins-startup", (ctx) =>
                ctx.span("rig.daemon.plugins.start", () => startedPluginManager.start(ctx)),
            ).catch((error: unknown) => {
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
        });
        shutdown.register("plugins", async () => {
            await withWorkerContext("plugins-shutdown", (ctx) => startedPluginManager.close(ctx));
            await pluginsStarted;
        });
        const workletManager = new WorkletManager({
            publish: (_ctx, event) => {
                activeStore.globalEventQueue.publishLive(event);
                activeStore.liveEvents.publish(event);
            },
            registry: workletToolRegistry,
            store: store.worklets,
        });
        worklets = workletManager;
        let workletsStarted: Promise<void> | undefined;
        postReadyTasks.push(() => {
            workletsStarted = withWorkerContext("worklets-startup", (ctx) =>
                ctx.span("rig.daemon.worklets.start", () => workletManager.start(ctx)),
            ).catch((error: unknown) => {
                daemonLog.record(
                    "error",
                    "worklets_unavailable",
                    "Rig could not start the worklets folder.",
                    {
                        error: errorToMessage(error),
                        workletsDirectory: workletManager.directory,
                    },
                );
            });
        });
        shutdown.register("worklets", async () => {
            await withWorkerContext("worklets-shutdown", (ctx) => workletManager.close(ctx));
            await workletsStarted;
        });
        if (stopping) return;
        let happyStartup: Promise<void> | undefined;
        if (happyModule !== undefined && happyConfiguration !== undefined) {
            postReadyTasks.push(() => {
                happyStartup = Promise.allSettled([p2pStartup, pluginsStarted, workletsStarted])
                    .then(async () => {
                        if (stopping) return;
                        await withWorkerContext("happy-sync-startup", (ctx) =>
                            ctx.span("rig.daemon.happy_sync.start", async (ctx) => {
                                let openingService: HappySyncService | undefined;
                                try {
                                    openingService = await ctx.span(
                                        "rig.daemon.happy_sync.open",
                                        () =>
                                            happyModule.HappySyncService.open(ctx, {
                                                ...(agents === undefined ? {} : { agents }),
                                                configuration: happyConfiguration,
                                                createSession: async (ctx, id, request) =>
                                                    store!.createWithId(
                                                        ctx,
                                                        id,
                                                        await configureSessionRequest(
                                                            request,
                                                            loadedConfig.config.docker,
                                                            () =>
                                                                store!.queryProjectSettings(
                                                                    ctx,
                                                                    request.cwd,
                                                                ),
                                                        ),
                                                    ),
                                                database: store!.database,
                                                getSubagents: async (ctx, sessionId) =>
                                                    (await store?.listSubagents(ctx, sessionId)) ??
                                                    [],
                                                getProjectContext: async (ctx, session) => {
                                                    const identity = session.projectIdentity();
                                                    if (identity === undefined) return undefined;
                                                    const project = await store?.getProject(
                                                        ctx,
                                                        identity.projectId,
                                                    );
                                                    if (project === undefined) return undefined;
                                                    const workspace =
                                                        identity.workspaceId === undefined
                                                            ? undefined
                                                            : await store?.getWorkspace(
                                                                  ctx,
                                                                  project.id,
                                                                  identity.workspaceId,
                                                              );
                                                    return {
                                                        project,
                                                        ...(workspace === undefined
                                                            ? {}
                                                            : { workspace }),
                                                    };
                                                },
                                                modelCatalog,
                                            }),
                                    );
                                    if (stopping) return;
                                    await ctx.span("rig.daemon.happy_sync.connect", () =>
                                        openingService!.start(ctx),
                                    );
                                    if (stopping) return;
                                    happySyncService = openingService;
                                    openingService = undefined;
                                } finally {
                                    await openingService?.close(ctx);
                                }
                            }),
                        );
                    })
                    .catch((error: unknown) => {
                        if (isDatabaseFailure(error)) {
                            fatalDatabaseFailure ??= error;
                            stopServer("Database failure while starting Happy sync.");
                            return;
                        }
                        daemonLog.record(
                            "warning",
                            "daemon_happy_unavailable",
                            "Happy sync is unavailable.",
                            { error: errorToMessage(error) },
                        );
                    });
            });
            shutdown.register("Happy startup", async () => await happyStartup);
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

        await ctx.span("rig.daemon.protocol_server.ready", () =>
            createProtocolHttpServer(
                ctx,
                {
                    ...(agents === undefined ? {} : { agents }),
                    inferenceMaxRetries: runtimeSettings.inferenceMaxRetries,
                    ...(loadedConfig.config.docker === undefined
                        ? {}
                        : { defaultDocker: loadedConfig.config.docker }),
                    ...(activeStore.globalEventQueue === undefined
                        ? {}
                        : { globalEventQueue: activeStore.globalEventQueue }),
                    ...(gitStateTracker === undefined ? {} : { gitStateTracker }),
                    modelCatalog,
                    ...(onboarding === undefined ? {} : { onboarding }),
                    resolveModelCatalog: (ownerInstanceId) =>
                        p2pCredentialRuntimeRegistry?.catalog(ownerInstanceId) ?? modelCatalog,
                    happyCloud: activeStore.happyCloud,
                    resolveP2pNetwork: () => p2pNetwork,
                    resolveP2pPairing: () => p2pPairingService,
                    p2pNode: () => ({ ...p2pNode }),
                    p2pStatus: () => p2pNetwork?.status() ?? { name: p2pNode.name, transports: [] },
                    ...(rigProfiles === undefined ? {} : { profiles: rigProfiles }),
                    ...(sharing === undefined ? {} : { sharing }),
                    replaceP2pCredentials: async (ctx, authenticatedOwnerId, envelope) => {
                        if (
                            store === undefined ||
                            p2pCredentialRuntimeRegistry === undefined ||
                            p2pCredentialStore === undefined
                        ) {
                            throw new Error("P2P credential provisioning is unavailable.");
                        }
                        const runtimeRegistry = p2pCredentialRuntimeRegistry;
                        const peer = (await p2pPeerTrustStore.peers(ctx)).find(
                            (candidate) => candidate.instanceId === authenticatedOwnerId,
                        );
                        if (peer === undefined) {
                            throw new Error("That credential owner is not a trusted peer Rig.");
                        }
                        const result = await p2pCredentialStore.replaceEncrypted(
                            ctx,
                            authenticatedOwnerId,
                            peer.publicKey,
                            envelope,
                        );
                        if (await runtimeRegistry.refresh(ctx)) {
                            credentialUsageRouter.clearProvisionedCaches();
                        }
                        return result;
                    },
                    ...(rigProfiles === undefined || p2pNetwork === undefined
                        ? {}
                        : {
                              prepareP2pRequest: async (ctx, { body, path, peerId, signal }) => {
                                  if (!isTrustedP2pPeer(peerId)) return undefined;
                                  await p2pCredentialReplicator?.ensureForRequest(
                                      ctx,
                                      peerId,
                                      signal,
                                  );
                                  await replicateProfileForP2pRequest(ctx, {
                                      body,
                                      network: p2pNetwork!,
                                      onSynchronized: (synchronizedPeerId, profileId, version) =>
                                          p2pProfileReplicator?.profileSynchronized(
                                              ctx,
                                              synchronizedPeerId,
                                              profileId,
                                              version,
                                          ),
                                      path,
                                      peerId,
                                      profiles: rigProfiles!,
                                      signal,
                                  });
                                  return prepareRemoteWorkGitSecret(path, body, activeStore);
                              },
                          }),
                    canP2pPeerConfigure,
                    canP2pPeerProvision: isTrustedP2pPeer,
                    canP2pPeerUseRemoteWork: isTrustedP2pPeer,
                    plugins,
                    ...(worklets === undefined ? {} : { worklets }),
                    getProviderQuota: (providerId, ownerInstanceId, credential) =>
                        credentialUsageRouter.quota(ownerInstanceId, providerId, credential),
                    listProviderUsage: async (ownerInstanceId) => {
                        const resolvedOwnerInstanceId = ownerInstanceId ?? p2pIdentity.instanceId;
                        const providers =
                            p2pCredentialRuntimeRegistry?.providers(resolvedOwnerInstanceId) ??
                            availableProviders;
                        return Promise.all(
                            Object.keys(providers).map((providerId) =>
                                credentialUsageRouter.entry(resolvedOwnerInstanceId, providerId),
                            ),
                        );
                    },
                    onDaemonConfigChange: async (ctx, config) => {
                        await writeDaemonSettings(config.settings, {}, config.p2p.name);
                        const globalEventQueue = await store?.setDurableGlobalEventQueue(
                            ctx,
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
                              onReloadHappy: async (ctx) => {
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
                                          next = await happyModule.HappySyncService.open(ctx, {
                                              ...(agents === undefined ? {} : { agents }),
                                              configuration: nextConfiguration,
                                              createSession: async (ctx, id, request) =>
                                                  store!.createWithId(
                                                      ctx,
                                                      id,
                                                      await configureSessionRequest(
                                                          request,
                                                          loadedConfig.config.docker,
                                                          () =>
                                                              store!.queryProjectSettings(
                                                                  ctx,
                                                                  request.cwd,
                                                              ),
                                                      ),
                                                  ),
                                              database: store!.database,
                                              getSubagents: async (ctx, sessionId) =>
                                                  (await store?.listSubagents(ctx, sessionId)) ??
                                                  [],
                                              getProjectContext: async (ctx, session) => {
                                                  const identity = session.projectIdentity();
                                                  if (identity === undefined) return undefined;
                                                  const project = await store?.getProject(
                                                      ctx,
                                                      identity.projectId,
                                                  );
                                                  if (project === undefined) return undefined;
                                                  const workspace =
                                                      identity.workspaceId === undefined
                                                          ? undefined
                                                          : await store?.getWorkspace(
                                                                ctx,
                                                                project.id,
                                                                identity.workspaceId,
                                                            );
                                                  return {
                                                      project,
                                                      ...(workspace === undefined
                                                          ? {}
                                                          : { workspace }),
                                                  };
                                              },
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
                                          await previous?.close(ctx);
                                      } catch (error) {
                                          if (isDatabaseFailure(error)) throw error;
                                          daemonLog.record(
                                              "warning",
                                              "daemon_happy_previous_close_failed",
                                              "The previous Happy sync connection could not close cleanly.",
                                              { error: errorToMessage(error) },
                                          );
                                      }
                                      await next.start(ctx);
                                      happySyncService = next;
                                      return true;
                                  });
                              },
                          }),
                    onStartInspector: (_ctx) =>
                        inspectorSerialize(async () => {
                            const inspectorUrl = openNodeInspector();
                            await writeServerRegistry();
                            return { inspectorUrl };
                        }),
                    onStopInspector: (_ctx) =>
                        inspectorSerialize(async () => {
                            const stopped = closeNodeInspector();
                            // Reconcile the registry even when the inspector was already
                            // closed through another in-process path.
                            await writeServerRegistry();
                            return { stopped };
                        }),
                    onShutdown: () => stopServer("Shutdown requested through the daemon protocol."),
                    store: activeStore,
                    taskDrain: taskDrain!,
                    token,
                },
                server,
            ),
        );
        server.off("request", startupRequestListener);
        daemonLog.record("info", "daemon_ready", "Rig daemon is ready.", {
            databasePath: paths.databasePath,
            socketPath,
        });
        setImmediate(() => {
            if (!stopping) {
                for (const start of postReadyTasks) start();
            }
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

function isP2pProfilePath(path: string): boolean {
    const pathname = new URL(path, "http://rig.local").pathname;
    return pathname === "/profiles" || /^\/profiles\/[a-z][a-z0-9]+$/u.test(pathname);
}

function isP2pCredentialPath(path: string): boolean {
    return new URL(path, "http://rig.local").pathname === "/inference-credentials";
}

export function isP2pRemoteWorkPath(path: string, _method: string): boolean {
    const pathname = new URL(path, "http://rig.local").pathname;
    return (
        pathname === "/catalog" ||
        pathname === "/events/live" ||
        pathname === "/git/watch" ||
        pathname === "/messages" ||
        pathname === "/timeline" ||
        pathname === "/documents" ||
        pathname.startsWith("/documents/") ||
        pathname === "/folders" ||
        pathname.startsWith("/folders/") ||
        pathname === "/project-assets" ||
        pathname.startsWith("/project-assets/") ||
        pathname === "/projects" ||
        pathname.startsWith("/projects/") ||
        pathname === "/sessions" ||
        pathname.startsWith("/sessions/")
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
