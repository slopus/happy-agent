import { basename } from "node:path";

import { TUI } from "@earendil-works/pi-tui";
import { createId } from "@paralleldrive/cuid2";
import type { HappyAgentEvent, Question } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import {
    ensureLocalProtocolServer,
    ensureWorkspaceForCwd,
    HappyAgentEventHub,
    RemoteAgent,
} from "../client/index.js";
import { detectHappyAgentUpdate, type HappyAgentUpdate } from "../daemon/index.js";
import {
    createProjectConfigSecurityNotice,
    loadConfig,
    updateRuntimePreferences,
} from "../config/index.js";
import {
    getDebugRootDirectory,
    getNodeInspectorUrl,
    openNodeInspector,
    registerHappyTerminalDebugRoot,
} from "../debug/index.js";
import { NativeProcessManager } from "../processes/index.js";
import type { ContentBlock, PermissionMode, UserInputRequest } from "../protocol/index.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { reportCliFailure } from "../reportCliFailure.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import { CodingAssistantApp, type AppExitReason } from "./CodingAssistantApp.js";
import { createSerialTaskQueue } from "./createSerialTaskQueue.js";
import { createStopOnceHandler } from "./createStopOnceHandler.js";
import { humanizePermissionMode } from "./humanizePermissionMode.js";
import { humanizeProviderId } from "./humanizeProviderId.js";
import { humanizeReasoningLevel } from "./humanizeReasoningLevel.js";
import { formatHappyAgentUpdateNotice } from "./formatHappyAgentUpdateNotice.js";
import { installResumeInstructions } from "./installResumeInstructions.js";
import { installTerminalCrashCleanup } from "./installTerminalCrashCleanup.js";
import { providerQuotaToStartupStatusUsage } from "./providerQuotaToStartupStatusUsage.js";
import { resolveStartupProviderQuota } from "./resolveStartupProviderQuota.js";
import {
    resolveStartupSessionId,
    type StartupSessionSelection,
} from "./resolveStartupSessionId.js";
import { resolveTerminalTheme } from "./resolveTerminalTheme.js";
import { HappyTerminalProcessTerminal } from "./HappyTerminalProcessTerminal.js";
import { StartupStatusApp } from "./StartupStatusApp.js";

const INITIAL_TUI_MESSAGE_LIMIT = 30;

export interface RunAppOptions {
    /** Command the host exposes for reopening a session, normally `happy`. */
    commandName?: string;
    compactCompletedTurns?: boolean;
    cwd?: string;
    debug?: boolean;
    effort?: string;
    instructions?: string;
    modelId?: string;
    onError?: (error: unknown) => void;
    providerId?: string;
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    sessionSelection?: StartupSessionSelection;
    showReasoning?: boolean;
    showUsage?: boolean;
    /** Version displayed by the host, defaulting to the installed Happy Terminal package. */
    version?: string;
}

export type RunAppResult = { action: "exit" } | { action: "reload"; sessionId: string };

export async function runApp(ctx: Context, options: RunAppOptions = {}): Promise<RunAppResult> {
    const requestedCwd = options.cwd ?? process.cwd();
    const version = options.version ?? readPackageVersion();
    const loadedConfig = await loadConfig({ cwd: requestedCwd });
    let compactCompletedTurns =
        options.compactCompletedTurns ?? loadedConfig.config.settings.compactCompletedTurns;
    let completionChime = loadedConfig.config.settings.completionChime;
    let showReasoning = options.showReasoning ?? loadedConfig.config.settings.showReasoning;
    let showUsage = options.showUsage ?? loadedConfig.config.settings.showUsage;
    const enqueueRuntimeConfigWrite = createSerialTaskQueue();
    const startupTheme = resolveTerminalTheme(loadedConfig.config.theme);
    const runtimeTheme = loadedConfig.sources.runtime.values.theme;

    const terminal = new HappyTerminalProcessTerminal();
    terminal.setTitle(`Happy Terminal - ${sanitizeTerminalTitle(basename(requestedCwd))}`);
    const tui = new TUI(terminal, false);
    const startup = new StartupStatusApp({
        cwd: requestedCwd,
        rows: () => terminal.rows,
        theme: startupTheme,
        tui,
        version,
    });
    const terminalCrashCleanup = installTerminalCrashCleanup({ terminal, tui });
    let terminalAppearance: Promise<
        [
            Awaited<ReturnType<TUI["queryTerminalBackgroundColor"]>>,
            Awaited<ReturnType<TUI["queryTerminalColorScheme"]>>,
        ]
    >;
    try {
        startup.start();
        tui.setTerminalColorSchemeNotifications(true);
        terminal.write("\x1b[?1004h");
        terminalAppearance = Promise.all([
            tui.queryTerminalBackgroundColor({ timeoutMs: 250 }),
            tui.queryTerminalColorScheme({ timeoutMs: 250 }),
        ]);
    } catch (error) {
        await restoreAfterFailure(startup, terminalCrashCleanup);
        throw error;
    }

    let exitReason: AppExitReason = "exit";
    const agentUpdateController = new AbortController();
    const opened = await (async () => {
        try {
            const localServer = await ensureLocalProtocolServer({
                onStatus: (message) => startup.setStatus(message),
            });
            const agentUpdate = detectHappyAgentUpdate({
                currentVersion: localServer.health.version.daemon,
                paths: localServer.paths,
                signal: agentUpdateController.signal,
            }).catch(() => undefined);
            let agentId = options.resumeSessionId;
            if (options.sessionSelection !== undefined) {
                agentId = await resolveStartupSessionId({
                    client: localServer.client,
                    cwd: requestedCwd,
                    selection: options.sessionSelection,
                    startup,
                });
                if (agentId === undefined) return undefined;
            }

            startup.setStatus("Opening agent.");
            const resumed = agentId !== undefined;
            const agentResponse =
                agentId === undefined
                    ? await localServer.client.createAgent({
                          workspaceId: (
                              await ensureWorkspaceForCwd(localServer.client, requestedCwd)
                          ).id,
                      })
                    : await localServer.client.getAgent(agentId);
            if (agentResponse.agent.parentAgentId !== null) {
                throw new Error(
                    "Subagents are driven by their parent and cannot be opened as an interactive Happy Terminal agent.",
                );
            }
            const [bootstrap, configResponse, history, pendingQuestion, workspaceResponse] =
                await Promise.all([
                    localServer.client.getAgentBootstrap(agentResponse.agent.id),
                    localServer.client.getConfig(),
                    localServer.client.getMessages(agentResponse.agent.id, {
                        limit: INITIAL_TUI_MESSAGE_LIMIT,
                        omitToolData: true,
                    }),
                    localServer.client.getPendingQuestion(agentResponse.agent.id),
                    localServer.client.getWorkspace(agentResponse.agent.workspaceId),
                ]);
            if (agentResponse.agent.unread !== null) {
                await localServer.client
                    .markAgentRead(agentResponse.agent.id)
                    .catch(() => undefined);
            }
            return {
                agent: bootstrap.agent,
                bootstrap,
                config: configResponse.config,
                eventCursor: history.cursor < bootstrap.cursor ? history.cursor : bootstrap.cursor,
                history,
                localServer,
                agentUpdate,
                pendingQuestion: pendingQuestion.question,
                resumed,
                workspace: workspaceResponse.workspace,
            };
        } catch (error) {
            agentUpdateController.abort();
            await restoreAfterFailure(startup, terminalCrashCleanup);
            throw error;
        }
    })();
    if (opened === undefined) {
        agentUpdateController.abort();
        startup.stop();
        await terminalCrashCleanup.restoreAndDrain();
        terminalCrashCleanup.uninstall();
        return { action: "exit" };
    }

    const resumeCommand = `${options.commandName ?? "happy"} resume ${opened.agent.id}`;
    const resumeInstructions = installResumeInstructions({
        resumeCommand,
        sessionId: opened.agent.id,
    });
    try {
        const processManager = new NativeProcessManager();
        const [terminalBackground, terminalColorScheme] = await terminalAppearance;
        const theme = resolveTerminalTheme(
            loadedConfig.config.theme,
            terminalBackground ?? terminalColorSchemeBackground(terminalColorScheme),
        );
        const workspaceCwd =
            opened.workspace.compute.type === "host" ? opened.workspace.compute.path : requestedCwd;
        if (opened.agent.title !== null) {
            terminal.setTitle(`Happy Terminal - ${sanitizeTerminalTitle(opened.agent.title)}`);
        }

        const events = new HappyAgentEventHub(opened.localServer.client, opened.eventCursor);
        events.start();
        const agent = new RemoteAgent({
            agent: opened.agent,
            bootstrap: opened.bootstrap,
            client: opened.localServer.client,
            config: opened.config,
            events,
            history: opened.history,
        });
        const providerId =
            options.providerId ??
            loadedConfig.config.defaults.providerId ??
            opened.config.defaults.providerId;
        const modelId =
            options.modelId ??
            loadedConfig.config.defaults.modelId ??
            opened.config.defaults.modelId;
        const effort =
            options.effort ?? loadedConfig.config.defaults.effort ?? opened.config.defaults.effort;
        try {
            agent.setModel(modelId, effort, providerId);
        } catch (error) {
            throw new HappyTerminalUserError(
                `Model '${modelId}' is not available from provider '${providerId}' in this daemon's configuration.`,
                {
                    cause: error,
                    hint: "Check HAPPY_TERMINAL_MODEL and HAPPY_TERMINAL_PROVIDER, or add the provider to happy.toml and run happy daemon reload.",
                },
            );
        }
        agent.setPermissionMode(
            options.permissionMode ??
                loadedConfig.config.defaults.permissionMode ??
                opened.config.defaults.permissionMode,
        );
        if (loadedConfig.config.defaults.serviceTier !== undefined) {
            agent.setServiceTier(loadedConfig.config.defaults.serviceTier);
        }

        const tuiInspectorUrl = getNodeInspectorUrl();
        // The probe keeps running for /usage; startup only shows what answers within budget.
        const startupQuotas = await resolveStartupProviderQuota(() => agent.providerQuotas());
        const startupUsage = providerQuotaToStartupStatusUsage(
            startupQuotas?.find((entry) => entry.providerId === agent.provider.id)?.quota,
        );
        const projectConfigNotice = createProjectConfigSecurityNotice(
            loadedConfig.sources.local.values,
            basename(loadedConfig.sources.local.path),
        );
        const agentUpdate = await alreadyResolved(opened.agentUpdate);
        const initialNotices = [
            ...(projectConfigNotice === undefined ? [] : [projectConfigNotice]),
            ...(agentUpdate === undefined
                ? []
                : [formatHappyAgentUpdateNotice(agentUpdate, options.commandName ?? "happy")]),
            ...(options.debug === true
                ? [
                      {
                          text: `Each request may write private JSON records to ${getDebugRootDirectory(workspaceCwd)}. These files can include prompts, model responses, tool arguments, and tool results.`,
                          title: "Debug logging enabled",
                      },
                  ]
                : []),
        ];
        const app = new CodingAssistantApp({
            agent,
            engineVersion: opened.localServer.health.version.daemon,
            compactCompletedTurns,
            completionChime,
            ctx,
            cwd: workspaceCwd,
            debugInfo: {
                daemonLogPath: opened.localServer.paths.logPath,
                sessionId: opened.agent.id,
                startInspectors: async () => {
                    const server = await opened.localServer.client.startInspector();
                    return {
                        serverInspectorUrl: server.inspectorUrl,
                        tuiInspectorUrl: openNodeInspector(),
                    };
                },
                stateDirectory: opened.localServer.paths.agentDirectory,
                tuiStderrIsTTY: process.stderr.isTTY === true,
                ...(tuiInspectorUrl === undefined ? {} : { tuiInspectorUrl }),
            },
            initialMessages: agent.snapshot().messages,
            ...(opened.pendingQuestion === null
                ? {}
                : { initialUserInputs: [toUserInputRequest(opened.pendingQuestion)] }),
            ...(initialNotices.length === 0 ? {} : { initialNotices }),
            onDefaultModelChange: (preference) =>
                enqueueRuntimeConfigWrite(() =>
                    updateRuntimePreferences(loadedConfig.paths.runtime, {
                        defaults: {
                            effort: preference.effort,
                            modelId: preference.modelId,
                            permissionMode: agent.permissionMode,
                            providerId: preference.providerId,
                            serviceTier: preference.serviceTier,
                        },
                        settings: {
                            compactCompletedTurns,
                            completionChime,
                            showReasoning,
                            showUsage,
                        },
                        ...(runtimeTheme === undefined ? {} : { theme: runtimeTheme }),
                    }),
                ),
            onSettingsChange: async (settings) => {
                compactCompletedTurns = settings.compactCompletedTurns;
                completionChime = settings.completionChime;
                showReasoning = settings.showReasoning;
                showUsage = settings.showUsage;
                await enqueueRuntimeConfigWrite(() =>
                    updateRuntimePreferences(loadedConfig.paths.runtime, {
                        defaults: {
                            effort: agent.snapshot().effort ?? agent.model.defaultThinkingLevel,
                            modelId: agent.model.id,
                            permissionMode: agent.permissionMode,
                            providerId: agent.provider.id,
                            serviceTier: agent.confirmedServiceTier ?? null,
                        },
                        settings,
                        ...(runtimeTheme === undefined ? {} : { theme: runtimeTheme }),
                    }),
                );
            },
            processManager,
            respondUserInput: (questionId, response) =>
                opened.localServer.client
                    .answerQuestion(opened.agent.id, questionId, {
                        answers: Object.fromEntries(
                            Object.entries(response.answers).map(([id, values]) => [
                                id,
                                [...values],
                            ]),
                        ),
                    })
                    .then(() => undefined),
            searchFiles: (query) =>
                opened.localServer.client
                    .searchFiles(opened.workspace.id, { query })
                    .then((response) => response.files),
            sessionBacked: true,
            showReasoning,
            showUsage,
            startupStatus: {
                access: humanizePermissionMode(agent.permissionMode),
                engineVersion: opened.localServer.health.version.daemon,
                environment: opened.workspace.compute.type === "host" ? "Local" : "Docker",
                fast: agent.confirmedServiceTier !== undefined,
                model: agent.model.name,
                provider: humanizeProviderId(agent.provider.id),
                reasoning: humanizeReasoningLevel(
                    agent.snapshot().effort ?? agent.model.defaultThinkingLevel,
                ),
                session: opened.resumed ? "Resumed" : "New session",
                ...(startupUsage === undefined ? {} : { usage: startupUsage }),
                version,
                workspace: workspaceCwd,
            },
            theme,
            tui,
            version,
        });

        let usageRefresh: Promise<void> | undefined;
        let usageRefreshQueued = false;
        const refreshUsage = (): void => {
            if (usageRefresh !== undefined) {
                usageRefreshQueued = true;
                return;
            }
            usageRefresh = agent
                .getUsage()
                .then((summary) => app.applyUsageSummary(summary))
                .catch(() => undefined)
                .finally(() => {
                    usageRefresh = undefined;
                    if (!usageRefreshQueued) return;
                    usageRefreshQueued = false;
                    refreshUsage();
                });
        };
        refreshUsage();

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
        registerHappyTerminalDebugRoot({
            agent,
            app,
            connection: opened.localServer,
            eventFollowerController: followController,
            kind: "tui",
            sessionId: opened.agent.id,
            terminal,
            tui,
        });
        void followAgentEvents({
            after: opened.agent.lastCursor,
            agent,
            app,
            chime: () => {
                if (completionChime) terminal.write("\x07");
            },
            events,
            refreshUsage,
            signal: followController.signal,
            terminal,
        }).catch((error: unknown) => {
            if (!followController.signal.aborted) (options.onError ?? reportCliFailure)(error);
        });

        const requestStop = createStopOnceHandler(
            () => app.stop(),
            (error) => reportCliFailure(error),
        );
        const stop = () => void requestStop();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
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
            agentUpdateController.abort();
            followController.abort();
            await events.close();
            terminal.write("\x1b[?1004l");
            await processManager.killAll(ctx, { forceAfterMs: 500, includeDetached: true });
            if (exitReason === "reload") resumeInstructions.suppress();
            else resumeInstructions.report();
        }
    } catch (error) {
        agentUpdateController.abort();
        await terminalCrashCleanup.restoreAndDrain();
        terminalCrashCleanup.uninstall();
        throw error;
    }
    return exitReason === "reload"
        ? { action: "reload", sessionId: opened.agent.id }
        : { action: "exit" };
}

const UNRESOLVED = Symbol("unresolved");

async function alreadyResolved(
    promise: Promise<HappyAgentUpdate | undefined> | undefined,
): Promise<HappyAgentUpdate | undefined> {
    if (promise === undefined) return undefined;
    const result = await Promise.race([promise, Promise.resolve(UNRESOLVED)]);
    return result === UNRESOLVED ? undefined : result;
}

async function followAgentEvents(options: {
    after: string;
    agent: RemoteAgent;
    app: CodingAssistantApp;
    chime: () => void;
    events: HappyAgentEventHub;
    refreshUsage: () => void;
    signal: AbortSignal;
    terminal: HappyTerminalProcessTerminal;
}): Promise<void> {
    // Pending steering messages carry no run yet, so the follower remembers which run is
    // active to stamp their session events with the run they are steering.
    let activeRunId: string | undefined;
    await options.events.follow({
        after: options.after,
        signal: options.signal,
        onGap: async () => {
            options.app.applyAgentSnapshot(await options.agent.resync());
        },
        onEvent: async (event) => {
            if (event.type === "config.updated") {
                // Catalog refresh is ancillary to the ordered conversation stream. A transient
                // read failure leaves the previous catalog in place for the next event or resync.
                await options.agent.reconcileModelCatalog().catch(() => undefined);
            }
            const pendingSteer =
                event.type === "message.created" &&
                event.payload.message.role === "user" &&
                event.payload.message.status === "pending" &&
                event.payload.message.delivery === "steer";
            const message = options.agent.applyEvent(event);
            // A pending steering message renders in the queued list until its run accepts it,
            // so it must not also land in the transcript here.
            if (message !== undefined && !pendingSteer) options.app.applyMessage(message);
            const loopEvent = options.agent.applyLoopEvent(event);
            if (loopEvent !== undefined) options.app.applyAgentLoopEvent(loopEvent);
            if (
                event.type === "agent.context.updated" &&
                event.payload.agentId === options.agent.id
            ) {
                options.refreshUsage();
            } else if (
                event.type === "agent.updated" &&
                event.payload.agentId === options.agent.id
            ) {
                options.refreshUsage();
                const changes = event.payload.changes;
                if (typeof changes.title === "string") {
                    options.terminal.setTitle(
                        `Happy Terminal - ${sanitizeTerminalTitle(changes.title)}`,
                    );
                }
            } else if (
                event.type === "agent.draft.updated" &&
                event.payload.agentId === options.agent.id
            ) {
                const updatedAt = event.payload.draft.updatedAt ?? Date.now();
                options.app.applySessionEvent({
                    createdAt: updatedAt,
                    data: {
                        ...(event.payload.draft.value?.text === undefined
                            ? {}
                            : { draft: event.payload.draft.value.text }),
                        ...(event.payload.mutationId === undefined
                            ? {}
                            : { origin: event.payload.mutationId }),
                        updatedAt,
                    },
                    id: createId(),
                    sessionId: options.agent.id,
                    type: "session_draft_changed",
                });
            } else if (
                event.type === "question.created" &&
                event.payload.question.agentId === options.agent.id
            ) {
                options.app.applyUserInputRequest(toUserInputRequest(event.payload.question));
                options.chime();
            } else if (
                event.type === "question.updated" &&
                questionBelongsToAgent(event, options.agent.id) &&
                event.payload.changes.status !== "pending"
            ) {
                options.app.resolveUserInputRequest(event.payload.questionId);
            } else if (
                event.type === "message.created" &&
                event.payload.agentId === options.agent.id &&
                event.payload.message.role === "user" &&
                event.payload.message.status === "pending" &&
                event.payload.message.delivery === "steer"
            ) {
                options.app.applySessionEvent({
                    createdAt: event.payload.message.createdAt,
                    data: {
                        delivery: "steer",
                        displayText: userMessageDisplayText(event.payload.message.content),
                        message: {
                            blocks: toUserMessageBlocks(event.payload.message.content),
                            id: event.payload.message.id,
                            role: "user",
                        },
                        ...(event.payload.mutationId === undefined
                            ? {}
                            : { mutationId: event.payload.mutationId }),
                        runId: activeRunId ?? "",
                    },
                    id: createId(),
                    sessionId: options.agent.id,
                    type: "message_submitted",
                });
            } else if (event.type === "run.started" && event.payload.agentId === options.agent.id) {
                activeRunId = event.payload.run.id;
                if (event.payload.acceptedMessageIds.length > 0) {
                    options.app.applySessionEvent({
                        createdAt: event.payload.run.startedAt,
                        data: {
                            messageIds: event.payload.acceptedMessageIds,
                            runId: event.payload.run.id,
                        },
                        id: createId(),
                        sessionId: options.agent.id,
                        type: "steering_applied",
                    });
                }
                options.app.applySessionEvent({
                    createdAt: event.payload.run.startedAt,
                    data: { runId: event.payload.run.id },
                    id: createId(),
                    sessionId: options.agent.id,
                    type: "run_started",
                });
            } else if (
                event.type === "run.boundary" &&
                event.payload.agentId === options.agent.id
            ) {
                // Steering atomically continues into the successor run; only the run identity
                // moves, the turn stays open.
                activeRunId = event.payload.startedRun.id;
                if (event.payload.acceptedMessageIds.length > 0) {
                    options.app.applySessionEvent({
                        createdAt: event.payload.startedRun.startedAt,
                        data: {
                            messageIds: event.payload.acceptedMessageIds,
                            runId: event.payload.startedRun.id,
                        },
                        id: createId(),
                        sessionId: options.agent.id,
                        type: "steering_applied",
                    });
                }
                options.app.applySessionEvent({
                    createdAt: event.payload.startedRun.startedAt,
                    data: { runId: event.payload.startedRun.id },
                    id: createId(),
                    sessionId: options.agent.id,
                    type: "run_started",
                });
            } else if (
                event.type === "run.finished" &&
                event.payload.agentId === options.agent.id
            ) {
                if (activeRunId === event.payload.run.id) activeRunId = undefined;
                const run = event.payload.run;
                options.app.applySessionEvent({
                    createdAt: run.endedAt ?? Date.now(),
                    data: {
                        modelLocked: false,
                        runId: run.id,
                        stopReason:
                            run.reason === "abort"
                                ? "aborted"
                                : run.reason === "error"
                                  ? "error"
                                  : "stop",
                    },
                    id: createId(),
                    sessionId: options.agent.id,
                    type: "run_finished",
                });
                options.refreshUsage();
                if (run.reason !== "abort") options.chime();
            }
            return false;
        },
    });
}

function questionBelongsToAgent(
    event: Extract<HappyAgentEvent, { type: "question.updated" }>,
    agentId: string,
): boolean {
    const changes = event.payload.changes;
    return changes.agentId === undefined || changes.agentId === agentId;
}

type PendingUserMessageContent = Extract<
    Extract<HappyAgentEvent, { type: "message.created" }>["payload"]["message"],
    { role: "user" }
>["content"];

/** The composer text a pending user message renders as, one placeholder per image. */
function userMessageDisplayText(content: PendingUserMessageContent): string {
    return content
        .map((block) =>
            block.type === "text"
                ? block.text
                : block.type === "image"
                  ? `[image:${block.mimeType}]`
                  : "",
        )
        .join("");
}

function toUserMessageBlocks(content: PendingUserMessageContent): ContentBlock[] {
    return content.flatMap((block): ContentBlock[] => {
        if (block.type === "text") return [{ text: block.text, type: "text" }];
        if (block.type === "image") {
            return [{ data: block.data, mediaType: block.mimeType, type: "image" }];
        }
        return [];
    });
}

function toUserInputRequest(question: Question): UserInputRequest {
    return {
        ...(question.autoResolveAt === null
            ? {}
            : { autoResolutionMs: Math.max(0, question.autoResolveAt - Date.now()) }),
        questions: question.questions.map((prompt) => ({
            header: prompt.header,
            id: prompt.id,
            multiSelect: prompt.multiSelect,
            options: prompt.options,
            question: prompt.question,
        })),
        requestId: question.id,
    };
}

async function restoreAfterFailure(
    startup: StartupStatusApp,
    cleanup: ReturnType<typeof installTerminalCrashCleanup>,
): Promise<void> {
    try {
        startup.stop();
    } catch {
        // Preserve the original failure while restoring the terminal.
    }
    await cleanup.restoreAndDrain();
    cleanup.uninstall();
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
