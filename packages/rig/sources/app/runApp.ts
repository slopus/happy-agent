import { basename } from "node:path";

import { TUI } from "@earendil-works/pi-tui";
import type { Context } from "@steve.kite/stdlib";

import { createNodeAgentContext } from "../agent/index.js";
import {
    ensureLocalProtocolServer,
    RemoteAgent,
    type SessionTerminalConnection,
} from "../client/index.js";
import {
    createProjectConfigSecurityNotice,
    createProjectConfigSecurityNoticeTitle,
    loadConfig,
    resolveProtectedPaths,
    updateRuntimePreferences,
} from "../config/index.js";
import { createProjectMcpSecurityNotice, loadMcpServerConfigEntries } from "../mcp/index.js";
import { NativeProcessManager } from "../processes/index.js";
import type { PermissionMode } from "../permissions/index.js";
import type { CreateSessionRequest, SessionEvent } from "../protocol/index.js";
import { resolveDockerExecutionConfig } from "../execution/index.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { CodingAssistantApp, type AppExitReason } from "./CodingAssistantApp.js";
import { createSerialTaskQueue } from "./createSerialTaskQueue.js";
import { createStopOnceHandler } from "./createStopOnceHandler.js";
import { createStartupStatusCardModel } from "./createStartupStatusCardModel.js";
import { ensureSessionCanResume } from "./ensureSessionCanResume.js";
import { installResumeInstructions } from "./installResumeInstructions.js";
import { installTerminalCrashCleanup } from "./installTerminalCrashCleanup.js";
import { providerQuotaToStartupStatusUsage } from "./providerQuotaToStartupStatusUsage.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { reportCliFailure } from "../reportCliFailure.js";
import { resolveTerminalTheme } from "./resolveTerminalTheme.js";
import { resolveStartupProviderQuota } from "./resolveStartupProviderQuota.js";
import {
    resolveStartupSessionId,
    type StartupSessionSelection,
} from "./resolveStartupSessionId.js";
import { RigTerminal } from "./RigTerminal.js";
import { sessionAgentFooterLabel } from "./sessionAgentFooterLabel.js";
import { StartupStatusApp } from "./StartupStatusApp.js";
import {
    getDebugRootDirectory,
    getNodeInspectorUrl,
    openNodeInspector,
    registerRigDebugRoot,
} from "../debug/index.js";

const INITIAL_TUI_MESSAGE_LIMIT = 30;

export interface RunAppOptions {
    apiKey?: string;
    compactCompletedTurns?: boolean;
    cwd?: string;
    debug?: boolean;
    effort?: string;
    instructions?: string;
    modelId?: string;
    providerId?: string;
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    sessionSelection?: StartupSessionSelection;
    showReasoning?: boolean;
    showUsage?: boolean;
    docker?: DockerExecutionConfig | null;
}

export type RunAppResult = { action: "exit" } | { action: "reload"; sessionId: string };

export async function runApp(ctx: Context, options: RunAppOptions = {}): Promise<RunAppResult> {
    const cwd = options.cwd ?? process.cwd();
    const [loadedConfig, mcpConfigEntries] = await Promise.all([
        loadConfig({ cwd }),
        loadMcpServerConfigEntries(cwd),
    ]);
    const projectConfigNotice = createProjectConfigSecurityNotice(
        loadedConfig.sources.local.values,
        basename(loadedConfig.sources.local.path),
    );
    const projectMcpNotice = createProjectMcpSecurityNotice(mcpConfigEntries);
    const machineProtectedPaths = [
        ...new Set([
            ...(loadedConfig.sources.global.values.permissions?.protectedPaths ?? []),
            ...(loadedConfig.sources.runtime.values.permissions?.protectedPaths ?? []),
            ...(loadedConfig.sources.global.values.workspace?.protectedSync ?? []),
            ...(loadedConfig.sources.runtime.values.workspace?.protectedSync ?? []),
        ]),
    ];
    const agentOptions: CreateSessionRequest = {
        trackUnread: true,
        cwd,
        modelId: loadedConfig.config.defaults.modelId,
        permissionMode: loadedConfig.config.defaults.permissionMode,
        workflowsEnabled: loadedConfig.config.features.workflows,
    };
    if (loadedConfig.config.defaults.providerId !== undefined) {
        agentOptions.providerId = loadedConfig.config.defaults.providerId;
    }
    if (loadedConfig.config.defaults.effort !== undefined) {
        agentOptions.effort = loadedConfig.config.defaults.effort;
    }
    if (loadedConfig.config.defaults.serviceTier !== undefined) {
        agentOptions.serviceTier = loadedConfig.config.defaults.serviceTier;
    }
    if (loadedConfig.config.defaults.instructions !== undefined) {
        agentOptions.instructions = loadedConfig.config.defaults.instructions;
    }
    if (loadedConfig.config.docker !== undefined) {
        agentOptions.docker = resolveDockerExecutionConfig(loadedConfig.config.docker, cwd);
    }
    if (options.docker === null) {
        delete agentOptions.docker;
        agentOptions.local = true;
    } else if (options.docker !== undefined) {
        agentOptions.docker = resolveDockerExecutionConfig(options.docker, cwd);
    }
    if (options.apiKey !== undefined) agentOptions.apiKey = options.apiKey;
    if (options.effort !== undefined) agentOptions.effort = options.effort;
    if (options.instructions !== undefined) agentOptions.instructions = options.instructions;
    if (options.modelId !== undefined) agentOptions.modelId = options.modelId;
    if (options.providerId !== undefined) agentOptions.providerId = options.providerId;
    if (options.permissionMode !== undefined) agentOptions.permissionMode = options.permissionMode;
    let compactCompletedTurns =
        options.compactCompletedTurns ?? loadedConfig.config.settings.compactCompletedTurns;
    let inferenceMaxRetries = loadedConfig.config.settings.inferenceMaxRetries;
    let inferenceFatalRetries = loadedConfig.config.settings.inferenceFatalRetries;
    let completionChime = loadedConfig.config.settings.completionChime;
    const daemonHeapSnapshots = loadedConfig.config.settings.daemonHeapSnapshots;
    let durableGlobalEventQueue = loadedConfig.config.settings.durableGlobalEventQueue;
    let showReasoning = options.showReasoning ?? loadedConfig.config.settings.showReasoning;
    let showUsage = options.showUsage ?? loadedConfig.config.settings.showUsage;
    const enqueueRuntimeConfigWrite = createSerialTaskQueue();
    const startupTheme = resolveTerminalTheme(loadedConfig.config.theme);
    const runtimeTheme = loadedConfig.sources.runtime.values.theme;

    // Keep the terminal in TUI mode while the daemon starts so startup work is visible.
    const terminal = new RigTerminal();
    terminal.setTitle(`Rig - ${sanitizeTerminalTitle(basename(cwd))}`);
    const tui = new TUI(terminal, false);
    const startup = new StartupStatusApp({
        cwd,
        rows: () => terminal.rows,
        theme: startupTheme,
        tui,
        version: readPackageVersion(),
    });
    const terminalCrashCleanup = installTerminalCrashCleanup({ terminal, tui });
    let terminalAppearance: Promise<
        [
            Awaited<ReturnType<TUI["queryTerminalBackgroundColor"]>>,
            Awaited<ReturnType<TUI["queryTerminalColorScheme"]>>,
        ]
    >;
    let exitReason: AppExitReason = "exit";
    try {
        startup.start();
        tui.setTerminalColorSchemeNotifications(true);
        terminal.write("\x1b[?1004h");
        terminalAppearance = Promise.all([
            tui.queryTerminalBackgroundColor({ timeoutMs: 250 }),
            tui.queryTerminalColorScheme({ timeoutMs: 250 }),
        ]);
    } catch (error) {
        try {
            startup.stop();
        } catch {
            // Preserve the startup failure while restoring the terminal below.
        }
        await terminalCrashCleanup.restoreAndDrain();
        terminalCrashCleanup.uninstall();
        throw error;
    }

    const opened = await (async () => {
        let sessionTerminal: SessionTerminalConnection | undefined;
        try {
            const connection = await ensureLocalProtocolServer({
                confirmRestart: (request) => startup.confirmDaemonRestart(request),
                onStatus: (message) => {
                    startup.setStatus(message);
                },
            });
            let resumeSessionId = options.resumeSessionId;
            if (options.sessionSelection !== undefined) {
                resumeSessionId = await resolveStartupSessionId({
                    client: connection.client,
                    cwd,
                    selection: options.sessionSelection,
                    startup,
                });
                // Dismissing the picker is a decision to stop, not a failure to report.
                if (resumeSessionId === undefined) return undefined;
            }
            startup.setStatus("Opening session.");
            const [openedSession, modelsResponse] = await Promise.all([
                resumeSessionId === undefined
                    ? connection.client.createSession(agentOptions)
                    : connection.client.getSession(resumeSessionId, {
                          messageLimit: INITIAL_TUI_MESSAGE_LIMIT,
                      }),
                connection.client.models(),
            ]);
            if (resumeSessionId !== undefined) {
                ensureSessionCanResume(openedSession.session);
            }
            sessionTerminal = await connection.client.connectSessionTerminal(
                openedSession.session.id,
                { focused: true },
            );
            startup.setStatus("Loading transcript.");
            const loadedHistory =
                resumeSessionId === undefined
                    ? { events: [] as SessionEvent[] }
                    : await connection.client.getEvents(openedSession.session.id, undefined, {
                          messageLimit: INITIAL_TUI_MESSAGE_LIMIT,
                      });

            return {
                history: loadedHistory,
                localServer: connection,
                modelCatalog: modelsResponse.catalog,
                resumed: resumeSessionId !== undefined,
                session: openedSession,
                sessionTerminal,
            };
        } catch (error) {
            try {
                startup.stop();
            } catch {
                // Preserve the connection failure while restoring the terminal below.
            }
            await terminalCrashCleanup.restoreAndDrain();
            terminalCrashCleanup.uninstall();
            await sessionTerminal?.close().catch(() => undefined);
            throw error;
        }
    })();
    if (opened === undefined) {
        startup.stop();
        await terminalCrashCleanup.restoreAndDrain();
        terminalCrashCleanup.uninstall();
        return { action: "exit" };
    }
    const { history, localServer, modelCatalog, resumed, session, sessionTerminal } = opened;
    const resumeCommand = `rig resume ${session.session.id}`;
    // Installed the moment the session exists, so every later exit can still report the way back.
    const resumeInstructions = installResumeInstructions({
        resumeCommand,
        sessionId: session.session.id,
    });
    try {
        const processManager = new NativeProcessManager();
        const [terminalBackground, terminalColorScheme] = await terminalAppearance;
        const theme = resolveTerminalTheme(
            loadedConfig.config.theme,
            terminalBackground ?? terminalColorSchemeBackground(terminalColorScheme),
        );
        const sessionCwd = session.session.cwd;
        if (session.session.title !== undefined) {
            terminal.setTitle(`Rig - ${sanitizeTerminalTitle(session.session.title)}`);
        }
        const [subagents, currentProviderQuotaResponse, secretRegistrations] = await Promise.all([
            localServer.client.listSubagents(session.session.id),
            resolveStartupProviderQuota(() =>
                localServer.client.getCurrentProviderQuota(session.session.id),
            ),
            localServer.client.listSecrets(),
        ]).catch(async (error: unknown) => {
            try {
                startup.stop();
            } catch {
                // Preserve the session failure while restoring the terminal below.
            }
            await terminalCrashCleanup.restoreAndDrain();
            terminalCrashCleanup.uninstall();
            throw error;
        });
        const context = createNodeAgentContext(ctx, {
            cwd: sessionCwd,
            permissionMode: session.session.permissionMode,
            processManager,
            protectedPaths: resolveProtectedPaths(sessionCwd, machineProtectedPaths),
        });
        const agent = new RemoteAgent({
            client: localServer.client,
            context,
            debug: options.debug === true,
            modelCatalog,
            session: session.session,
        });
        const version = readPackageVersion();
        const activeAgentLabel = sessionAgentFooterLabel(session.session.agent);
        const startupUsage = providerQuotaToStartupStatusUsage(
            currentProviderQuotaResponse?.currentProviderId === session.session.providerId
                ? currentProviderQuotaResponse.quota
                : undefined,
        );
        const initialNotices = [
            ...(options.debug === true
                ? [
                      {
                          text: `Each request will write private JSON records to ${getDebugRootDirectory(sessionCwd)}. These files include prompts, model responses, tool arguments, and tool results.`,
                          title: "Debug logging enabled",
                      },
                  ]
                : []),
            ...(projectConfigNotice === undefined
                ? []
                : [
                      {
                          text: projectConfigNotice,
                          title: createProjectConfigSecurityNoticeTitle(
                              loadedConfig.sources.local.values,
                          ),
                      },
                  ]),
            ...(projectMcpNotice === undefined
                ? []
                : [{ text: projectMcpNotice, title: "Project MCP needs trust" }]),
        ];
        const tuiInspectorUrl = getNodeInspectorUrl();
        // Presence is daemon-wide, so a client that cannot read it simply hides the control.
        const initialPresence = await localServer.client
            .getPresence()
            .then((result) => result.presence)
            .catch(() => undefined);
        const app = new CodingAssistantApp({
            ctx,
            ...(activeAgentLabel === undefined ? {} : { activeAgentLabel }),
            agent,
            attachSecret: (id, scope) => agent.attachSecret(id, scope),
            cwd: sessionCwd,
            detachSecret: (id, scope) => agent.detachSecret(id, scope),
            initialSessionEvents: history.events,
            initialBackgroundProcesses: session.session.backgroundProcesses ?? [],
            ...(session.session.cumulativeUsage === undefined
                ? {}
                : { initialUsage: session.session.cumulativeUsage }),
            ...(session.session.sessionTokenCount === undefined
                ? {}
                : { initialSessionTokenCount: session.session.sessionTokenCount }),
            initialMcpServers: session.session.mcpServers,
            ...(initialNotices.length === 0 ? {} : { initialNotices }),
            initialSubagents: subagents.subagents,
            initialProjectSecretIds: session.session.projectSecretIds,
            initialSessionSecretIds: session.session.sessionSecretIds,
            initialUserInputs: session.session.pendingUserInputs,
            initialTasks: session.session.tasks,
            ...(session.session.lastEventId === undefined
                ? {}
                : {
                      initialUsageEventId: session.session.lastEventId,
                      initialWorkflowEventId: session.session.lastEventId,
                  }),
            initialWorkflows: session.session.workflows ?? [],
            workflowsEnabled: session.session.workflowsEnabled !== false,
            modelLocked: session.session.modelLocked,
            listSecrets: () =>
                localServer.client.listSecrets().then((response) => response.secrets),
            presence: {
                get: () => localServer.client.getPresence().then((result) => result.presence),
                ...(initialPresence === undefined ? {} : { initial: initialPresence }),
                set: (presenceId) =>
                    localServer.client
                        .setPresence({ presenceId })
                        .then((result) => result.presence),
            },
            onDefaultModelChange: (preference) =>
                enqueueRuntimeConfigWrite(() =>
                    updateRuntimePreferences(loadedConfig.paths.runtime, {
                        defaults: {
                            modelId: preference.modelId,
                            providerId: preference.providerId,
                            effort: preference.effort,
                            permissionMode: agent.permissionMode,
                            serviceTier: preference.serviceTier,
                        },
                        settings: {
                            inferenceMaxRetries,
                            inferenceFatalRetries,
                            compactCompletedTurns,
                            completionChime,
                            daemonHeapSnapshots,
                            durableGlobalEventQueue,
                            showReasoning,
                            showUsage,
                        },
                        ...(runtimeTheme === undefined ? {} : { theme: runtimeTheme }),
                    }),
                ),
            onSettingsChange: async (settings) => {
                inferenceMaxRetries = settings.inferenceMaxRetries;
                inferenceFatalRetries = settings.inferenceFatalRetries;
                compactCompletedTurns = settings.compactCompletedTurns;
                completionChime = settings.completionChime;
                durableGlobalEventQueue = settings.durableGlobalEventQueue;
                showReasoning = settings.showReasoning;
                showUsage = settings.showUsage;
                await enqueueRuntimeConfigWrite(() =>
                    updateRuntimePreferences(loadedConfig.paths.runtime, {
                        defaults: {
                            modelId: agent.model.id,
                            providerId: agent.provider.id,
                            effort: agent.snapshot().effort ?? agent.model.defaultThinkingLevel,
                            permissionMode: agent.permissionMode,
                            serviceTier: agent.confirmedServiceTier ?? null,
                        },
                        settings: { ...settings, daemonHeapSnapshots },
                        ...(runtimeTheme === undefined ? {} : { theme: runtimeTheme }),
                    }),
                );
                await localServer.client.updateDaemonConfig({
                    settings: {
                        inferenceMaxRetries,
                        inferenceFatalRetries,
                        durableGlobalEventQueue,
                    },
                });
            },
            onTerminalFocusChange: (focused) => {
                void sessionTerminal.setFocused(focused).catch(() => {});
            },
            onUserActivity: () => {
                void localServer.client.recordSessionActivity(session.session.id).catch(() => {});
            },
            onStopWorkflow: (runId) =>
                localServer.client.stopWorkflow(session.session.id, runId).then(() => undefined),
            watchSubagentEvents: (sessionId, signal, onEvent) =>
                localServer.client.watchSessionEvents({ onEvent, sessionId, signal }),
            processManager,
            registerSecret: (registration) =>
                localServer.client.registerSecret(registration).then((response) => response.secret),
            respondUserInput: (requestId, response) =>
                localServer.client
                    .answerUserInput(session.session.id, requestId, response)
                    .then(() => undefined),
            searchFiles: (query) => {
                const scope = session.session.scope;
                if (scope.kind !== "project" && scope.kind !== "workspace") {
                    throw new Error("File search is available only in project or workspace chats.");
                }
                return localServer.client
                    .searchFiles(
                        {
                            projectId: scope.projectId,
                            ...(scope.kind === "workspace"
                                ? { workspaceId: scope.workspaceId }
                                : {}),
                        },
                        query,
                    )
                    .then((response) => response.files);
            },
            sessionBacked: true,
            inferenceMaxRetries,
            inferenceFatalRetries,
            compactCompletedTurns,
            completionChime,
            durableGlobalEventQueue,
            debugInfo: {
                daemonLogPath: localServer.paths.logPath,
                sessionId: session.session.id,
                startInspectors: async () => {
                    const server = await localServer.client.startInspector();
                    return {
                        serverInspectorUrl: server.inspectorUrl,
                        tuiInspectorUrl: openNodeInspector(),
                    };
                },
                stateDirectory: localServer.paths.directory,
                tuiStderrIsTTY: process.stderr.isTTY === true,
                ...(tuiInspectorUrl === undefined ? {} : { tuiInspectorUrl }),
            },
            showReasoning,
            showUsage,
            startupStatus: createStartupStatusCardModel({
                githubAvailable: secretRegistrations.secrets.some(
                    (secret) => secret.kind === "github",
                ),
                model: agent.model,
                resumed,
                session: session.session,
                ...(startupUsage === undefined ? {} : { usage: startupUsage }),
                version,
            }),
            theme,
            tui,
            unregisterSecret: (id) =>
                localServer.client.unregisterSecret(id).then((response) => response.removed),
            updateSecret: (id, update) =>
                localServer.client.updateSecret(id, update).then((response) => response.secret),
            version,
        });
        let terminalThemeRefresh = 0;
        const stopWatchingTerminalTheme = tui.onTerminalColorSchemeChange((colorScheme) => {
            const refresh = ++terminalThemeRefresh;
            void tui.queryTerminalBackgroundColor({ timeoutMs: 250 }).then((background) => {
                if (refresh !== terminalThemeRefresh) return;
                app.setTheme(
                    resolveTerminalTheme(
                        loadedConfig.config.theme,
                        background ?? terminalColorSchemeBackground(colorScheme),
                    ),
                );
            });
        });
        startup.stop();
        const followController = new AbortController();
        registerRigDebugRoot({
            agent,
            app,
            connection: localServer,
            eventFollowerController: followController,
            kind: "tui",
            sessionId: session.session.id,
            terminal,
            tui,
        });
        const observedChimeEvents = new Set<string>();
        const lastHistoryEventId = history.events.at(-1)?.id ?? session.session.lastEventId;
        void localServer.client.watchSessionEvents({
            ...(lastHistoryEventId !== undefined ? { after: lastHistoryEventId } : {}),
            onEvent: (event) => {
                if (event.type === "session_title_changed" && event.data.title !== undefined) {
                    terminal.setTitle(`Rig - ${sanitizeTerminalTitle(event.data.title)}`);
                }
                const shouldChime =
                    !observedChimeEvents.has(event.id) &&
                    (event.type === "user_input_requested" ||
                        event.type === "run_error" ||
                        (event.type === "run_finished" && event.data.stopReason !== "aborted"));
                if (shouldChime) {
                    observedChimeEvents.add(event.id);
                    if (completionChime) terminal.write("\x07");
                }
                agent.applySessionEvent(event);
                app.applySessionEvent(event);
            },
            sessionId: session.session.id,
            signal: followController.signal,
        });

        const requestStop = createStopOnceHandler(
            () => app.stop(),
            (error) => {
                reportCliFailure(error);
            },
        );
        const stop = () => {
            void requestStop();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        // Node terminates on an unhandled hangup, which would skip shutdown entirely.
        process.on("SIGHUP", stop);

        let appExitedNormally = false;
        try {
            app.start({ tuiAlreadyStarted: true });
            exitReason = await app.waitForExit();
            appExitedNormally = true;
        } finally {
            if (!appExitedNormally) await terminalCrashCleanup.restoreAndDrain();
            terminalCrashCleanup.uninstall();
            stopWatchingTerminalTheme();
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            process.off("SIGHUP", stop);
            followController.abort();
            terminal.write("\x1b[?1004l");
            // Nothing Rig started outlives Rig, background work included.
            await processManager.killAll(ctx, { forceAfterMs: 500, includeDetached: true });
            // A reload reopens this same session, so its instructions would only be noise.
            if (exitReason === "reload") resumeInstructions.suppress();
            else resumeInstructions.report();
        }
    } catch (error) {
        await terminalCrashCleanup.restoreAndDrain();
        terminalCrashCleanup.uninstall();
        throw error;
    } finally {
        await sessionTerminal.close().catch(() => undefined);
    }
    return exitReason === "reload"
        ? { action: "reload", sessionId: session.session.id }
        : { action: "exit" };
}

function terminalColorSchemeBackground(
    colorScheme: "dark" | "light" | undefined,
): { r: number; g: number; b: number } | undefined {
    if (colorScheme === undefined) return undefined;
    return colorScheme === "light" ? { r: 0xff, g: 0xff, b: 0xff } : { r: 0x0d, g: 0x0d, b: 0x0d };
}

function sanitizeTerminalTitle(value: string): string {
    return [...value]
        .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint > 31 && codePoint !== 127;
        })
        .join("");
}
