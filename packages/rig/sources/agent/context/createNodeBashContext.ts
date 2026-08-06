import { isAbsolute, resolve } from "node:path";

import {
    resolveSystemShell,
    type ManagedProcess,
    type NativeProcessManager,
    type ProcessRunResult,
} from "../../processes/index.js";
import { assertPermissionRevision, type PermissionContext } from "../../permissions/index.js";
import type { BashContext, BashSessionExit, BashSessionSnapshot } from "./BashContext.js";
import { assertCanUseCustomShell } from "./assertCanUseCustomShell.js";
import { createSandboxedCommand } from "./createSandboxedCommand.js";
import {
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkInterceptor,
    type ManagedNetworkProxyHandle,
    shouldApplyManagedNetworkPolicy,
    shouldBypassManagedProxyForLoopback,
    validateManagedNetworkLoopbackPorts,
} from "./ManagedNetworkPolicy.js";
import { startManagedNetworkProxy } from "./startManagedNetworkProxy.js";
import {
    startLinuxManagedNetworkBridge,
    type LinuxManagedNetworkBridge,
} from "./startLinuxManagedNetworkBridge.js";
import { loadProjectManagedNetworkPolicy } from "./loadProjectManagedNetworkPolicy.js";
import {
    createProtectedPathMonitor,
    type ProtectedPathMonitor,
} from "./createProtectedPathMonitor.js";
import { createToolEnvironment } from "./createToolEnvironment.js";
import { waitForBashSessionCompletion } from "./waitForBashSessionCompletion.js";
import {
    BASH_SESSION_STOP_GRACE_MS,
    MAX_ACTIVE_BASH_SESSIONS,
    MAX_RETAINED_BASH_SESSIONS,
} from "./bashSessionLimits.js";
import { createCommandEnvironment, type SessionSecretContext } from "../../secrets/index.js";
import { errorToMessage } from "../../errorToMessage.js";
import { runCleanupSteps } from "./runCleanupSteps.js";
import { formatManagedNetworkDenial } from "./formatManagedNetworkDenial.js";

export interface CreateNodeBashContextOptions {
    cwd: string;
    loadManagedNetworkPolicy?: typeof loadProjectManagedNetworkPolicy;
    networkInterceptor?: ManagedNetworkInterceptor;
    processManager: NativeProcessManager;
    permissions: PermissionContext;
    secrets?: SessionSecretContext;
    startManagedNetwork?: typeof startCommandManagedNetwork;
}

interface NodeBashSession {
    command: string;
    completionStderrDelta?: string;
    completionWaiters: Set<() => void>;
    /**
     * Readers waiting for the end who will also report it.
     *
     * An observer that only peeks waits the same way but consumes nothing, so
     * it must not be mistaken for someone about to tell the model the news.
     */
    consumingWaiters: number;
    cwd: string;
    /** Stopped to make room for a newer command, but still readable. */
    evicted?: true;
    /** A read has already returned this session's final status. */
    exitObserved: boolean;
    process: ManagedProcess;
    managedNetwork?: CommandManagedNetwork;
    result?: ProcessRunResult;
    sessionId: number;
    stderrOffset: number;
    stdoutOffset: number;
    timedOut: boolean;
}

export function createNodeBashContext(options: CreateNodeBashContextOptions): BashContext {
    const sessions = new Map<number, NodeBashSession>();
    let nextSessionId = 1;
    let pendingSessionStarts = 0;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: BashSessionExit) => void) | undefined;
    const activeSessionCount = () =>
        [...sessions.values()].filter((session) => session.result === undefined && !session.evicted)
            .length;
    const activeSessions = () =>
        [...sessions.values()]
            .filter((session) => session.result === undefined && !session.evicted)
            .map((session) => ({
                command: session.command,
                cwd: session.cwd,
                sessionId: session.sessionId,
                status: "running" as const,
            }));
    /**
     * Makes room for one more command. Running out of slots is our problem, not
     * the model's, so the oldest command is evicted to free one.
     *
     * The evicted session stays readable: it is stopped, not forgotten, so a
     * model still holding its task ID learns what became of it. Only its slot
     * is released, and immediately, so a command that ignores the signal cannot
     * keep the next one from starting.
     */
    const reserveSessionStart = () => {
        while (activeSessionCount() + pendingSessionStarts >= MAX_ACTIVE_BASH_SESSIONS) {
            const oldest = [...sessions.values()]
                .filter((session) => session.result === undefined && !session.evicted)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) {
                throw new Error(
                    `No more than ${String(MAX_ACTIVE_BASH_SESSIONS)} background commands can run at once.`,
                );
            }
            oldest.evicted = true;
            void oldest.process.kill("SIGTERM", { forceAfterMs: BASH_SESSION_STOP_GRACE_MS });
        }
        pendingSessionStarts += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            pendingSessionStarts -= 1;
        };
    };
    const runCwd = (cwd: string | undefined) =>
        cwd === undefined ? options.cwd : isAbsolute(cwd) ? cwd : resolve(options.cwd, cwd);
    const loadManagedNetworkPolicy =
        options.loadManagedNetworkPolicy ?? loadProjectManagedNetworkPolicy;
    const startManagedNetwork =
        options.startManagedNetwork ??
        ((policy) => startCommandManagedNetwork(policy, options.networkInterceptor));

    /**
     * Forgets the oldest finished commands once too many have piled up.
     *
     * Runs whenever a command starts or ends, so a session that only ever
     * finishes work still lets go of what it is holding.
     */
    const trimFinishedSessions = () => {
        while (sessions.size > MAX_RETAINED_BASH_SESSIONS) {
            const finished = [...sessions.values()]
                .filter((candidate) => candidate.result !== undefined)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            sessions.delete(finished.sessionId);
        }
    };
    const readSession = async (
        sessionId: number,
        readOptions: Parameters<BashContext["readSession"]>[1] = {},
    ): Promise<BashSessionSnapshot | undefined> => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        const waitMs = Math.max(0, readOptions.waitMs ?? 0);
        const peeking = readOptions.peek === true;
        if (session.result === undefined && waitMs > 0 && !readOptions.signal?.aborted) {
            if (!peeking) session.consumingWaiters += 1;
            try {
                await waitForBashSessionCompletion(
                    session.completionWaiters,
                    waitMs,
                    readOptions.signal,
                );
            } finally {
                if (!peeking) session.consumingWaiters -= 1;
            }
        }

        const processSnapshot = session.process.readOutput(
            session.stdoutOffset,
            session.stderrOffset,
        );
        const completionStderrDelta = session.completionStderrDelta ?? "";
        if (!peeking) {
            delete session.completionStderrDelta;
            session.stdoutOffset = processSnapshot.stdoutOffset;
            session.stderrOffset = processSnapshot.stderrOffset;
            if (session.result !== undefined) session.exitObserved = true;
        }
        return {
            command: session.command,
            cwd: session.cwd,
            exitCode: session.result?.exitCode ?? null,
            sessionId,
            status:
                session.result === undefined
                    ? "running"
                    : session.result.killed
                      ? "killed"
                      : "completed",
            stderr: session.result?.stderr ?? processSnapshot.stderr,
            stderrDelta: `${processSnapshot.stderrDelta}${completionStderrDelta}`,
            stdout: session.result?.stdout ?? processSnapshot.stdout,
            stdoutDelta: processSnapshot.stdoutDelta,
            timedOut: session.timedOut,
        };
    };

    return {
        activeSessionCount,
        activeSessions,
        cwd: options.cwd,
        detachSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session !== undefined) session.process.detached = true;
        },
        async interruptSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            return session.process.interrupt();
        },
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => session.result === undefined);
            // Everything is being taken down at once, by us. Telling the model
            // about each casualty afterwards would say nothing it does not know.
            for (const session of active) session.exitObserved = true;
            await Promise.all(
                active.map((session) =>
                    session.process.kill("SIGTERM", { forceAfterMs: BASH_SESSION_STOP_GRACE_MS }),
                ),
            );
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            // Whoever stopped the command is told how it ended by this very
            // call, so claim the outcome before the exit continuation can run
            // and announce it a second time.
            session.exitObserved = true;
            await session.process.kill("SIGTERM", { forceAfterMs: BASH_SESSION_STOP_GRACE_MS });
            // The process is gone, but this session records the outcome from a
            // separate continuation. Wait for that before reporting status,
            // otherwise a just-killed command still reads as running.
            if (session.result === undefined) {
                await waitForBashSessionCompletion(session.completionWaiters, 5_000);
            }
            // Stopping a command reports its status; it must not swallow output
            // the model has not read yet.
            return readSession(sessionId, { peek: true });
        },
        readSession,
        async run(runOptions) {
            const permissionMode = options.permissions.mode;
            const permissionRevision = options.permissions.revision;
            assertCanUseCustomShell(permissionMode, runOptions.shell);
            const cwd = runCwd(runOptions.cwd);
            const shell = runOptions.shell ?? resolveSystemShell();
            const toolEnvironment = await createToolEnvironment(
                permissionMode,
                globalThis.process.env,
                { cwd: options.cwd },
            );
            const networkPolicy = shouldApplyManagedNetworkPolicy(permissionMode)
                ? await loadManagedNetworkPolicy(options.cwd)
                : undefined;
            const managedNetwork = await startManagedNetwork(networkPolicy);
            let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
            try {
                sandboxedCommand = await createSandboxedCommand({
                    command: runOptions.command,
                    commandCwd: cwd,
                    cwd: options.cwd,
                    mode: permissionMode,
                    protectedPaths: options.permissions.protectedPaths,
                    ...networkSandboxOptions(networkPolicy, managedNetwork),
                    ...(toolEnvironment.PATH === undefined ? {} : { path: toolEnvironment.PATH }),
                    shell,
                });
            } catch (error) {
                await managedNetwork?.close();
                throw error;
            }
            const processRunOptions: Parameters<NativeProcessManager["run"]>[0] = {
                command: sandboxedCommand.command,
                cwd,
                env: withManagedNetworkProxy(
                    createCommandEnvironment(toolEnvironment, options.secrets, runOptions.secrets),
                    managedNetwork,
                    networkPolicy,
                ),
                timeoutMs: runOptions.timeoutMs ?? 120_000,
                maxOutputBytes: runOptions.maxOutputBytes ?? 512_000,
            };
            if (sandboxedCommand.args !== undefined) {
                processRunOptions.args = sandboxedCommand.args;
            } else {
                processRunOptions.shell = shell;
            }
            let networkDenial: ManagedNetworkBlockedRequest | undefined;
            const commandAbort = new AbortController();
            const abortFromCaller = () => commandAbort.abort();
            runOptions.signal?.addEventListener("abort", abortFromCaller, { once: true });
            if (runOptions.signal?.aborted) commandAbort.abort();
            const stopObservingNetworkDenials = managedNetwork?.proxy?.onBlockedRequest(
                (request) => {
                    networkDenial ??= request;
                    commandAbort.abort();
                },
            );
            if (runOptions.signal !== undefined || managedNetwork?.proxy !== undefined) {
                processRunOptions.signal = commandAbort.signal;
            }

            let protectedPathMonitor: ProtectedPathMonitor;
            try {
                protectedPathMonitor = await createProtectedPathMonitor(
                    sandboxedCommand.protectedCreatePaths ?? [],
                );
            } catch (error) {
                await cleanUpCommandResources(
                    { stop: async () => false },
                    managedNetwork,
                    sandboxedCommand.projectConfigPlaceholder,
                );
                throw error;
            }
            let result: ProcessRunResult;
            let cleanup: CommandCleanupResult = { protectedPathViolation: false };
            try {
                assertPermissionRevision(options.permissions, permissionRevision);
                result = await options.processManager.run(processRunOptions);
            } finally {
                stopObservingNetworkDenials?.();
                runOptions.signal?.removeEventListener("abort", abortFromCaller);
                cleanup = await cleanUpCommandResources(
                    protectedPathMonitor,
                    managedNetwork,
                    sandboxedCommand.projectConfigPlaceholder,
                );
            }
            const protectedPathMessage =
                cleanup.protectedPathViolation && result.exitCode === 0
                    ? "Sandbox blocked creation of protected agent metadata.\n"
                    : "";
            const networkDenialMessage =
                networkDenial === undefined ? "" : formatManagedNetworkDenial(networkDenial);
            return {
                stdout: result.stdout,
                stderr: `${result.stderr}${networkDenialMessage}${protectedPathMessage}${cleanup.errorMessage ?? ""}`,
                exitCode:
                    networkDenial !== undefined ||
                    cleanup.errorMessage !== undefined ||
                    (cleanup.protectedPathViolation && result.exitCode === 0)
                        ? 1
                        : result.exitCode,
                timedOut: result.timedOut,
            };
        },
        async startSession(runOptions) {
            // Validate before making room: a command that is never going to
            // start must not cost the user a running one.
            const permissionMode = options.permissions.mode;
            assertCanUseCustomShell(permissionMode, runOptions.shell);
            const releaseSessionStart = reserveSessionStart();
            try {
                const permissionRevision = options.permissions.revision;
                const cwd = runCwd(runOptions.cwd);
                const shell = runOptions.shell ?? resolveSystemShell();
                const toolEnvironment = await createToolEnvironment(
                    permissionMode,
                    globalThis.process.env,
                    { cwd: options.cwd },
                );
                const networkPolicy = shouldApplyManagedNetworkPolicy(permissionMode)
                    ? await loadManagedNetworkPolicy(options.cwd)
                    : undefined;
                const managedNetwork = await startManagedNetwork(networkPolicy);
                let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
                try {
                    sandboxedCommand = await createSandboxedCommand({
                        command: runOptions.command,
                        commandCwd: cwd,
                        cwd: options.cwd,
                        mode: permissionMode,
                        protectedPaths: options.permissions.protectedPaths,
                        ...networkSandboxOptions(networkPolicy, managedNetwork),
                        ...(toolEnvironment.PATH === undefined
                            ? {}
                            : { path: toolEnvironment.PATH }),
                        shell,
                    });
                } catch (error) {
                    await managedNetwork?.close();
                    throw error;
                }
                const processStartOptions: Parameters<NativeProcessManager["start"]>[0] = {
                    command: sandboxedCommand.command,
                    cwd,
                    env: withManagedNetworkProxy(
                        createCommandEnvironment(
                            toolEnvironment,
                            options.secrets,
                            runOptions.secrets,
                        ),
                        managedNetwork,
                        networkPolicy,
                    ),
                    maxOutputBytes: runOptions.maxOutputBytes ?? 512_000,
                    ...(runOptions.tty === undefined ? {} : { tty: runOptions.tty }),
                };
                if (sandboxedCommand.args !== undefined) {
                    processStartOptions.args = sandboxedCommand.args;
                } else {
                    processStartOptions.shell = shell;
                }
                let protectedPathMonitor: ProtectedPathMonitor;
                try {
                    protectedPathMonitor = await createProtectedPathMonitor(
                        sandboxedCommand.protectedCreatePaths ?? [],
                    );
                } catch (error) {
                    await cleanUpCommandResources(
                        { stop: async () => false },
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholder,
                    );
                    throw error;
                }
                let process: ManagedProcess;
                try {
                    assertPermissionRevision(options.permissions, permissionRevision);
                    process = options.processManager.start(processStartOptions);
                } catch (error) {
                    await cleanUpCommandResources(
                        protectedPathMonitor,
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholder,
                    );
                    throw error;
                }
                const completion = process.wait();
                const sessionId = nextSessionId;
                nextSessionId += 1;
                const session: NodeBashSession = {
                    command: runOptions.command,
                    completionWaiters: new Set(),
                    consumingWaiters: 0,
                    cwd,
                    exitObserved: false,
                    process,
                    ...(managedNetwork === undefined ? {} : { managedNetwork }),
                    sessionId,
                    stderrOffset: 0,
                    stdoutOffset: 0,
                    timedOut: false,
                };
                let networkDenial: ManagedNetworkBlockedRequest | undefined;
                const stopObservingNetworkDenials = managedNetwork?.proxy?.onBlockedRequest(
                    (request) => {
                        networkDenial ??= request;
                        void process.kill("SIGTERM", { forceAfterMs: BASH_SESSION_STOP_GRACE_MS });
                    },
                );
                sessions.set(sessionId, session);
                onActiveSessionCountChange?.(activeSessionCount());
                void completion.then(async (result) => {
                    stopObservingNetworkDenials?.();
                    const cleanup = await cleanUpCommandResources(
                        protectedPathMonitor,
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholder,
                    );
                    const protectedPathMessage =
                        cleanup.protectedPathViolation && result.exitCode === 0
                            ? "Sandbox blocked creation of protected agent metadata.\n"
                            : "";
                    const networkDenialMessage =
                        networkDenial === undefined
                            ? ""
                            : formatManagedNetworkDenial(networkDenial);
                    const completionStderrDelta = `${networkDenialMessage}${protectedPathMessage}${cleanup.errorMessage ?? ""}`;
                    if (completionStderrDelta !== "") {
                        session.completionStderrDelta = completionStderrDelta;
                    }
                    session.result = {
                        ...result,
                        exitCode:
                            networkDenial !== undefined ||
                            cleanup.errorMessage !== undefined ||
                            (cleanup.protectedPathViolation && result.exitCode === 0)
                                ? 1
                                : result.exitCode,
                        killed: networkDenial === undefined ? result.killed : false,
                        stderr: `${result.stderr}${completionStderrDelta}`,
                    };
                    const awaited = session.consumingWaiters > 0;
                    for (const finish of session.completionWaiters) finish();
                    onActiveSessionCountChange?.(activeSessionCount());
                    trimFinishedSessions();
                    // Nobody was waiting on this command, so nobody is about to
                    // learn that it ended. Say so, without the output.
                    if (!awaited && !session.exitObserved) {
                        onSessionExit?.({
                            command: session.command,
                            exitCode: session.result.exitCode,
                            sessionId,
                            status: session.result.killed ? "killed" : "completed",
                        });
                    }
                });
                trimFinishedSessions();
                return sessionId;
            } finally {
                releaseSessionStart();
            }
        },
        setActiveSessionCountListener(listener) {
            onActiveSessionCountChange = listener;
            listener?.(activeSessionCount());
        },
        setSessionExitListener(listener) {
            onSessionExit = listener;
        },
        supportsSessionInput: true,
        async writeSession(sessionId, data) {
            const session = sessions.get(sessionId);
            return session?.process.writeStdin(data) ?? false;
        },
    };
}

interface CommandManagedNetwork {
    bridge?: LinuxManagedNetworkBridge;
    close(): Promise<void>;
    proxy?: ManagedNetworkProxyHandle;
}

async function startCommandManagedNetwork(
    policy: import("./ManagedNetworkPolicy.js").ManagedNetworkPolicy | undefined,
    networkInterceptor?: ManagedNetworkInterceptor,
): Promise<CommandManagedNetwork | undefined> {
    if (policy === undefined) return undefined;
    if (process.platform !== "darwin" && process.platform !== "linux")
        throw new Error("Managed network access is currently supported only on macOS and Linux.");
    if (
        (policy.allowedDomains?.length ?? 0) === 0 &&
        (policy.allowedLoopbackPorts?.length ?? 0) === 0
    ) {
        return undefined;
    }
    validateManagedNetworkLoopbackPorts(policy.allowedLoopbackPorts ?? []);
    if ((policy.allowedDomains?.length ?? 0) === 0 && process.platform !== "linux")
        return { close: async () => {} };
    const proxy = await startManagedNetworkProxy(policy, {
        ...(networkInterceptor === undefined ? {} : { networkInterceptor }),
    });
    try {
        const bridge =
            process.platform === "linux"
                ? await startLinuxManagedNetworkBridge(
                      proxy,
                      policy.allowedLoopbackPorts === undefined
                          ? {}
                          : { loopbackPorts: policy.allowedLoopbackPorts },
                  )
                : undefined;
        return {
            ...(bridge === undefined ? {} : { bridge }),
            proxy,
            async close() {
                await runCleanupSteps("managed network", [
                    ...(bridge === undefined ? [] : [() => bridge.close()]),
                    () => proxy.close(),
                ]);
            },
        };
    } catch (error) {
        await proxy.close();
        throw error;
    }
}

interface CommandCleanupResult {
    errorMessage?: string;
    protectedPathViolation: boolean;
}

async function cleanUpCommandResources(
    protectedPathMonitor: ProtectedPathMonitor,
    managedNetwork: CommandManagedNetwork | undefined,
    projectConfigPlaceholder:
        | import("./prepareProjectConfigPlaceholder.js").ProjectConfigPlaceholder
        | undefined,
): Promise<CommandCleanupResult> {
    const [protectedPathResult, managedNetworkResult, projectConfigResult] =
        await Promise.allSettled([
            protectedPathMonitor.stop(),
            managedNetwork?.close() ?? Promise.resolve(),
            projectConfigPlaceholder?.close() ?? Promise.resolve(),
        ]);
    const errors = [
        ...(protectedPathResult.status === "rejected" ? [protectedPathResult.reason] : []),
        ...(managedNetworkResult.status === "rejected" ? [managedNetworkResult.reason] : []),
        ...(projectConfigResult.status === "rejected" ? [projectConfigResult.reason] : []),
    ];
    return {
        ...(errors.length === 0
            ? {}
            : {
                  errorMessage: `Command cleanup failed: ${errors.map(errorToMessage).join("; ")}\n`,
              }),
        protectedPathViolation:
            protectedPathResult.status === "fulfilled" ? protectedPathResult.value : true,
    };
}

function networkSandboxOptions(
    policy: import("./ManagedNetworkPolicy.js").ManagedNetworkPolicy | undefined,
    managedNetwork: CommandManagedNetwork | undefined,
): {
    networkAllowLocalBinding?: boolean;
    networkAllowedLoopbackPorts?: readonly number[];
    networkUnixProxySockets?: {
        authenticationToken: string;
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
} {
    const proxy = managedNetwork?.proxy;
    const ports = [
        ...(policy?.allowedLoopbackPorts ?? []),
        ...(proxy === undefined ? [] : [proxy.port, proxy.socksPort]),
    ];
    return {
        ...(process.platform === "darwin" && policy?.allowLocalBinding === true
            ? { networkAllowLocalBinding: true }
            : {}),
        ...(ports.length === 0 ? {} : { networkAllowedLoopbackPorts: [...new Set(ports)] }),
        ...(managedNetwork?.bridge === undefined
            ? {}
            : {
                  networkUnixProxySockets: {
                      authenticationToken: managedNetwork.bridge.authenticationToken,
                      http: managedNetwork.bridge.httpSocketPath,
                      loopback: managedNetwork.bridge.loopbackSockets,
                      socks: managedNetwork.bridge.socksSocketPath,
                  },
              }),
    };
}

function withManagedNetworkProxy(
    environment: NodeJS.ProcessEnv,
    managedNetwork: CommandManagedNetwork | undefined,
    policy: import("./ManagedNetworkPolicy.js").ManagedNetworkPolicy | undefined,
): NodeJS.ProcessEnv {
    const proxy = managedNetwork?.proxy;
    if (proxy === undefined) return environment;
    const bridge = managedNetwork?.bridge;
    const url =
        bridge === undefined ? `http://127.0.0.1:${String(proxy.port)}` : "http://127.0.0.1:3128";
    const socksUrl =
        bridge === undefined
            ? `socks5h://127.0.0.1:${String(proxy.socksPort)}`
            : "socks5h://127.0.0.1:1080";
    const noProxy = shouldBypassManagedProxyForLoopback(policy, process.platform === "linux")
        ? "localhost,127.0.0.1,::1"
        : "";
    return {
        ...environment,
        ALL_PROXY: socksUrl,
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: noProxy,
        all_proxy: socksUrl,
        http_proxy: url,
        https_proxy: url,
        no_proxy: noProxy,
    };
}
