import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { posix } from "node:path";
import { PassThrough, type Duplex } from "node:stream";

import type Dockerode from "dockerode";

import type {
    BashContext,
    BashRunOptions,
    BashSessionExit,
    BashSessionSnapshot,
} from "../agent/context/BashContext.js";
import { assertCanUseCustomShell } from "../agent/context/assertCanUseCustomShell.js";
import {
    BASH_SESSION_STOP_GRACE_MS,
    MAX_ACTIVE_BASH_SESSIONS,
    MAX_RETAINED_BASH_SESSIONS,
} from "../agent/context/bashSessionLimits.js";
import {
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkInterceptor,
    type ManagedNetworkProxyHandle,
    shouldApplyManagedNetworkPolicy,
    validateManagedNetworkLoopbackPorts,
} from "../agent/context/ManagedNetworkPolicy.js";
import {
    startLinuxManagedNetworkBridge,
    type LinuxManagedNetworkBridge,
} from "../agent/context/startLinuxManagedNetworkBridge.js";
import { startManagedNetworkProxy } from "../agent/context/startManagedNetworkProxy.js";
import { assertPermissionRevision, type PermissionContext } from "../permissions/index.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";
import { runDockerExec } from "./runDockerExec.js";
import { readDockerEnvironmentVariableNames } from "./readDockerEnvironmentVariableNames.js";
import { createDockerCommandEnvironment, type SessionSecretContext } from "../secrets/index.js";
import { createDockerSandboxCommand } from "./createDockerSandboxCommand.js";
import { prepareDockerSandbox, type PreparedDockerSandbox } from "./prepareDockerSandbox.js";
import { resolveDockerPath } from "./resolveDockerPath.js";
import { DOCKER_PROTECTED_PATH_MONITOR_SCRIPT } from "./dockerProtectedPathMonitorScript.js";
import {
    cleanupDockerProjectConfigPlaceholder,
    loadDockerProjectManagedNetworkPolicyState,
} from "./loadDockerProjectManagedNetworkPolicy.js";
import { resolveDockerBindMountPath } from "./resolveDockerBindMountPath.js";
import { runCleanupSteps } from "../agent/context/runCleanupSteps.js";
import { errorToMessage } from "../errorToMessage.js";
import { formatManagedNetworkDenial } from "../agent/context/formatManagedNetworkDenial.js";
import {
    DOCKER_NETWORK_BRIDGE_DIRECTORY,
    prepareDockerNetworkBridgeHostRoot,
} from "./prepareDockerNetworkBridgeHostRoot.js";
import { prepareDockerNetworkBridgeContainerRoot } from "./prepareDockerNetworkBridgeContainerRoot.js";

interface DockerBashSession {
    command: string;
    completion: Promise<void>;
    consumingWaiters: number;
    cwd: string;
    /** Stopped to make room for a newer command, but still readable. */
    evicted?: true;
    exec: Dockerode.Exec;
    exitCode: number | null;
    exitObserved: boolean;
    finished: boolean;
    killed: boolean;
    managedNetwork?: DockerManagedNetwork;
    networkDenial?: ManagedNetworkBlockedRequest;
    pidFile: string;
    projectConfigPlaceholderCleanup?: () => Promise<void>;
    sessionId: number;
    stderr: Buffer;
    stderrOffset: number;
    stdout: Buffer;
    stdoutOffset: number;
    stream: Duplex;
    stopNetworkDenialListener?: () => void;
    timedOut: boolean;
    timeout?: NodeJS.Timeout;
}

interface DockerManagedNetwork {
    authenticationToken: string;
    bridge: LinuxManagedNetworkBridge;
    close(): Promise<void>;
    containerHttpSocketPath: string;
    containerLoopbackSockets: readonly { path: string; port: number }[];
    containerSocksSocketPath: string;
    proxy: ManagedNetworkProxyHandle;
}

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DOCKER_EXEC_INSPECT_TIMEOUT_MS = 10_000;
const DOCKER_EXEC_START_GATE = "rig-start\n";
const DOCKER_EXEC_START_GATE_SCRIPT = String.raw`
pid_file=$1
shift
printf '%s\n' "$$" > "$pid_file"
IFS= read -r gate
[ "$gate" = "rig-start" ] || exit 125
exec "$@"
`;

export function createDockerBashContext(
    environment: DockerEnvironment,
    permissions: PermissionContext,
    secrets?: SessionSecretContext,
    networkInterceptor?: ManagedNetworkInterceptor,
): BashContext {
    const sessions = new Map<number, DockerBashSession>();
    const contextId = randomUUID();
    const cwd = environment.config.workingDirectory;
    let nextSessionId = 1;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: BashSessionExit) => void) | undefined;
    let ambientEnvironmentVariables: Promise<readonly string[]> | undefined;
    let canonicalWorkspace: Promise<string> | undefined;
    let sandboxRuntime: Promise<PreparedDockerSandbox> | undefined;
    const activeSessionCount = () =>
        [...sessions.values()].filter((session) => !session.finished && !session.evicted).length;

    const start = async (
        options: Omit<BashRunOptions, "signal">,
        exitObserved = false,
    ): Promise<DockerBashSession> => {
        const permissionMode = permissions.mode;
        const permissionRevision = permissions.revision;
        assertCanUseCustomShell(permissionMode, options.shell);
        const sessionId = nextSessionId++;
        const runCwd = options.cwd === undefined ? cwd : posix.resolve(cwd, options.cwd);
        const shell = options.shell ?? "/bin/sh";
        const pidFile = `/tmp/rig-exec-${process.pid}-${contextId}-${sessionId}.pid`;
        const container = await environment.container();
        ambientEnvironmentVariables ??= readDockerEnvironmentVariableNames(container).catch(
            (error: unknown) => {
                ambientEnvironmentVariables = undefined;
                throw error;
            },
        );
        const secretEnvironment = createDockerCommandEnvironment(
            secrets,
            options.secrets,
            await ambientEnvironmentVariables,
        );
        const workspaceCwd =
            permissionMode === "full_access" ? undefined : await loadCanonicalWorkspace();
        const runtime =
            permissionMode === "full_access" ? undefined : await loadSandboxRuntime(container);
        const appliesManagedNetwork = shouldApplyManagedNetworkPolicy(permissionMode);
        const containerNetworkBridgeRoot = appliesManagedNetwork
            ? await prepareDockerNetworkBridgeContainerRoot(container, workspaceCwd!)
            : undefined;
        const projectConfigPlaceholderMarker =
            containerNetworkBridgeRoot === undefined
                ? undefined
                : posix.join(
                      containerNetworkBridgeRoot,
                      `.config-${contextId}-${String(sessionId)}`,
                  );
        let networkPolicyState:
            | Awaited<ReturnType<typeof loadDockerProjectManagedNetworkPolicyState>>
            | undefined;
        try {
            networkPolicyState =
                projectConfigPlaceholderMarker === undefined
                    ? undefined
                    : await loadDockerProjectManagedNetworkPolicyState(
                          container,
                          cwd,
                          containerNetworkBridgeRoot!,
                          projectConfigPlaceholderMarker,
                      );
        } catch (error) {
            if (projectConfigPlaceholderMarker !== undefined) {
                await cleanupDockerProjectConfigPlaceholder(
                    container,
                    cwd,
                    containerNetworkBridgeRoot!,
                    projectConfigPlaceholderMarker,
                ).catch(() => undefined);
            }
            throw error;
        }
        const networkPolicy = networkPolicyState?.policy;
        const projectConfigPlaceholderCleanup =
            networkPolicyState?.projectConfigPlaceholderCreated === true &&
            projectConfigPlaceholderMarker !== undefined &&
            containerNetworkBridgeRoot !== undefined
                ? () =>
                      cleanupDockerProjectConfigPlaceholder(
                          container,
                          cwd,
                          containerNetworkBridgeRoot,
                          projectConfigPlaceholderMarker,
                      )
                : undefined;
        const requiresManagedNetwork =
            networkPolicy !== undefined &&
            ((networkPolicy.allowedDomains?.length ?? 0) > 0 ||
                (networkPolicy.allowedLoopbackPorts?.length ?? 0) > 0);
        let managedNetwork: DockerManagedNetwork | undefined;
        try {
            const networkBridgeHostPath =
                requiresManagedNetwork && containerNetworkBridgeRoot !== undefined
                    ? await loadNetworkBridgeHostPath(
                          container,
                          workspaceCwd!,
                          containerNetworkBridgeRoot,
                      )
                    : undefined;
            managedNetwork = !requiresManagedNetwork
                ? undefined
                : await startDockerManagedNetwork(
                      containerNetworkBridgeRoot!,
                      networkBridgeHostPath!,
                      networkPolicy!,
                      networkInterceptor,
                  );
            if (containerNetworkBridgeRoot !== undefined) {
                await validateDockerNetworkBridgeRoot(container, containerNetworkBridgeRoot);
            }
        } catch (error) {
            const failedManagedNetwork = managedNetwork;
            await runCleanupSteps("Docker command startup", [
                ...(failedManagedNetwork === undefined ? [] : [() => failedManagedNetwork.close()]),
                ...(projectConfigPlaceholderCleanup === undefined
                    ? []
                    : [projectConfigPlaceholderCleanup]),
            ]);
            throw error;
        }
        let invokedCommand: string[];
        try {
            invokedCommand =
                permissionMode === "full_access"
                    ? [shell, "-lc", options.command]
                    : createDockerSandboxCommand({
                          command: options.command,
                          commandCwd: runCwd,
                          mode: permissionMode,
                          protectedPaths: permissions.protectedPaths,
                          ...(containerNetworkBridgeRoot === undefined
                              ? {}
                              : { networkBridgeRoot: containerNetworkBridgeRoot }),
                          ...(managedNetwork === undefined
                              ? {}
                              : {
                                    networkUnixProxySockets: {
                                        authenticationToken: managedNetwork.authenticationToken,
                                        http: managedNetwork.containerHttpSocketPath,
                                        loopback: managedNetwork.containerLoopbackSockets,
                                        socks: managedNetwork.containerSocksSocketPath,
                                    },
                                }),
                          ...(networkPolicyState === undefined
                              ? {}
                              : {
                                    readyProjectConfigNames:
                                        networkPolicyState.readyProjectConfigNames,
                                }),
                          runtime: runtime!,
                          shell,
                          workspaceCwd: workspaceCwd ?? cwd,
                      });
        } catch (error) {
            await runCleanupSteps("Docker command startup", [
                ...(managedNetwork === undefined ? [] : [() => managedNetwork.close()]),
                ...(projectConfigPlaceholderCleanup === undefined
                    ? []
                    : [projectConfigPlaceholderCleanup]),
            ]);
            throw error;
        }
        const protectedCreatePaths =
            workspaceCwd === undefined || permissionMode === "read_only"
                ? []
                : [
                      ".agents",
                      ".codex",
                      ".git",
                      "AGENTS_SECURITY.md",
                      ...(networkPolicyState?.absentProjectConfigNames ?? [
                          "rig.toml",
                          "happy.toml",
                      ]),
                  ].map((name) => posix.join(workspaceCwd, name));
        let exec: Dockerode.Exec;
        try {
            const payloadCommand =
                protectedCreatePaths.length === 0
                    ? invokedCommand
                    : [
                          "/bin/sh",
                          "-c",
                          DOCKER_PROTECTED_PATH_MONITOR_SCRIPT,
                          "rig",
                          pidFile,
                          ...protectedCreatePaths,
                          "--",
                          ...invokedCommand,
                      ];
            exec = await container.exec({
                AttachStdin: true,
                AttachStderr: true,
                AttachStdout: true,
                Cmd: [
                    "/bin/sh",
                    "-c",
                    DOCKER_EXEC_START_GATE_SCRIPT,
                    "rig",
                    pidFile,
                    ...payloadCommand,
                ],
                ...(Object.keys(
                    withDockerManagedNetworkEnvironment(secretEnvironment, managedNetwork),
                ).length === 0
                    ? {}
                    : {
                          Env: Object.entries(
                              withDockerManagedNetworkEnvironment(
                                  secretEnvironment,
                                  managedNetwork,
                              ),
                          ).map(([name, value]) => `${name}=${value ?? ""}`),
                      }),
                Tty: false,
                WorkingDir: runCwd,
            });
        } catch (error) {
            await runCleanupSteps("Docker command startup", [
                ...(managedNetwork === undefined ? [] : [() => managedNetwork.close()]),
                ...(projectConfigPlaceholderCleanup === undefined
                    ? []
                    : [projectConfigPlaceholderCleanup]),
            ]);
            throw error;
        }
        let stream!: Duplex;
        try {
            assertPermissionRevision(permissions, permissionRevision);
            stream = await exec.start({ hijack: true, stdin: true, Tty: false });
            assertPermissionRevision(permissions, permissionRevision);
            stream.write(DOCKER_EXEC_START_GATE);
        } catch (error) {
            stream?.end();
            await runCleanupSteps("Docker command startup", [
                ...(managedNetwork === undefined ? [] : [() => managedNetwork.close()]),
                ...(projectConfigPlaceholderCleanup === undefined
                    ? []
                    : [projectConfigPlaceholderCleanup]),
            ]);
            throw error;
        }
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        const maximum = options.maxOutputBytes ?? 512_000;
        const session: DockerBashSession = {
            command: options.command,
            completion: Promise.resolve(),
            consumingWaiters: 0,
            cwd: runCwd,
            exec,
            exitCode: null,
            exitObserved,
            finished: false,
            killed: false,
            ...(managedNetwork === undefined ? {} : { managedNetwork }),
            ...(projectConfigPlaceholderCleanup === undefined
                ? {}
                : { projectConfigPlaceholderCleanup }),
            pidFile,
            sessionId,
            stderr: Buffer.alloc(0),
            stderrOffset: 0,
            stdout: Buffer.alloc(0),
            stdoutOffset: 0,
            stream,
            timedOut: false,
        };
        stdoutStream.on("data", (chunk: Buffer) => {
            const previousLength = session.stdout.length;
            session.stdout = appendCapped(session.stdout, chunk, maximum);
            const evictedBytes = previousLength + chunk.length - session.stdout.length;
            session.stdoutOffset = Math.max(0, session.stdoutOffset - evictedBytes);
        });
        stderrStream.on("data", (chunk: Buffer) => {
            const previousLength = session.stderr.length;
            session.stderr = appendCapped(session.stderr, chunk, maximum);
            const evictedBytes = previousLength + chunk.length - session.stderr.length;
            session.stderrOffset = Math.max(0, session.stderrOffset - evictedBytes);
        });
        container.modem.demuxStream(stream, stdoutStream, stderrStream);
        session.completion = new Promise<void>((resolve) => {
            let settled = false;
            const finish = async (error?: Error) => {
                if (settled) return;
                settled = true;
                session.stopNetworkDenialListener?.();
                delete session.stopNetworkDenialListener;
                if (error !== undefined) {
                    session.stderr = appendCapped(
                        session.stderr,
                        Buffer.from(error.message),
                        maximum,
                    );
                }
                try {
                    session.exitCode = (await inspectDockerExec(exec)).ExitCode;
                } catch (inspectError) {
                    session.stderr = appendCapped(
                        session.stderr,
                        Buffer.from(
                            `Could not inspect the Docker command after it exited: ${errorToMessage(inspectError)}\n`,
                        ),
                        maximum,
                    );
                    session.exitCode = null;
                }
                try {
                    await runCleanupSteps("Docker command", [
                        ...(session.managedNetwork === undefined
                            ? []
                            : [() => session.managedNetwork!.close()]),
                        ...(session.projectConfigPlaceholderCleanup === undefined
                            ? []
                            : [session.projectConfigPlaceholderCleanup]),
                    ]);
                } catch (cleanupError) {
                    session.stderr = appendCapped(
                        session.stderr,
                        Buffer.from(`Command cleanup failed: ${errorToMessage(cleanupError)}\n`),
                        maximum,
                    );
                    session.exitCode = 1;
                }
                if (session.networkDenial !== undefined) {
                    session.stderr = appendCapped(
                        session.stderr,
                        Buffer.from(formatManagedNetworkDenial(session.networkDenial)),
                        maximum,
                    );
                    session.exitCode = 1;
                    session.killed = false;
                }
                session.finished = true;
                if (session.timeout !== undefined) clearTimeout(session.timeout);
                const awaited = session.consumingWaiters > 0;
                onActiveSessionCountChange?.(activeSessionCount());
                trimFinishedSessions();
                resolve();
                if (!awaited && !session.exitObserved) {
                    onSessionExit?.({
                        command: session.command,
                        exitCode: session.exitCode,
                        sessionId,
                        status:
                            session.killed || session.exitCode === null ? "killed" : "completed",
                    });
                }
            };
            stream.once("error", (error) => void finish(error));
            stream.once("end", () => void finish());
            stream.once("close", () => void finish());
        });
        sessions.set(sessionId, session);
        const stopNetworkDenialListener = managedNetwork?.proxy.onBlockedRequest((request) => {
            session.networkDenial ??= request;
            requestKill(session);
        });
        if (stopNetworkDenialListener !== undefined) {
            session.stopNetworkDenialListener = stopNetworkDenialListener;
        }
        onActiveSessionCountChange?.(activeSessionCount());
        if (options.timeoutMs !== undefined) {
            session.timeout = setTimeout(() => {
                session.timedOut = true;
                requestKill(session);
            }, options.timeoutMs);
            session.timeout.unref();
        }
        trimFinishedSessions();
        return session;
    };

    const loadSandboxRuntime = async (
        container: Dockerode.Container,
    ): Promise<PreparedDockerSandbox> => {
        if (sandboxRuntime === undefined) {
            const pending = prepareDockerSandbox(container);
            sandboxRuntime = pending;
            void pending.catch(() => {
                if (sandboxRuntime === pending) sandboxRuntime = undefined;
            });
        }
        return sandboxRuntime;
    };

    const loadCanonicalWorkspace = (): Promise<string> => {
        canonicalWorkspace ??= resolveDockerPath(environment, cwd).catch((error: unknown) => {
            canonicalWorkspace = undefined;
            throw error;
        });
        return canonicalWorkspace;
    };

    const loadNetworkBridgeHostPath = async (
        container: Dockerode.Container,
        workspaceCwd: string,
        expectedContainerRoot: string,
    ): Promise<string> => {
        const mapping = await resolveDockerBindMountPath(container, workspaceCwd);
        await prepareDockerNetworkBridgeHostRoot(mapping.hostPath);
        const containerPath = posix.join(mapping.containerPath, DOCKER_NETWORK_BRIDGE_DIRECTORY);
        if (containerPath !== expectedContainerRoot) {
            throw new Error(
                "Docker managed network bridge root does not match the working-directory bind mount.",
            );
        }
        await validateDockerNetworkBridgeRoot(container, containerPath);
        return mapping.hostPath;
    };

    const kill = async (session: DockerBashSession): Promise<void> => {
        if (session.finished) return;
        session.killed = true;
        const container = await environment.container();
        await runDockerExec(container, [
            "/bin/sh",
            "-c",
            'pid=$(cat "$1" 2>/dev/null) || exit 0; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
            "rig",
            session.pidFile,
        ]).catch(() => undefined);
        session.stream.end();
        await Promise.race([
            session.completion,
            new Promise<void>((resolve) => setTimeout(resolve, BASH_SESSION_STOP_GRACE_MS)),
        ]);
        if (!session.finished) {
            await runDockerExec(container, [
                "/bin/sh",
                "-c",
                'pid=$(cat "$1" 2>/dev/null) || exit 0; kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
                "rig",
                session.pidFile,
            ]).catch(() => undefined);
            await Promise.race([
                session.completion,
                new Promise<void>((resolve) => setTimeout(resolve, 500)),
            ]);
        }
        if (!session.finished) {
            session.stream.destroy();
            await session.completion;
        }
    };

    const interrupt = async (session: DockerBashSession): Promise<boolean> => {
        if (session.finished) return false;
        const container = await environment.container();
        const result = await runDockerExec(container, [
            "/bin/sh",
            "-c",
            'pid=$(cat "$1" 2>/dev/null) || exit 1; kill -INT -- "-$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null',
            "rig",
            session.pidFile,
        ]);
        return result.exitCode === 0;
    };

    /**
     * Forgets the oldest finished commands once too many have piled up.
     *
     * Runs whenever a command starts or ends, so a session that only ever
     * finishes work still lets go of what it is holding.
     */
    const trimFinishedSessions = (): void => {
        while (sessions.size > MAX_RETAINED_BASH_SESSIONS) {
            const finished = [...sessions.values()]
                .filter((candidate) => candidate.finished)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            sessions.delete(finished.sessionId);
        }
    };

    /**
     * Makes room for one more background command. Running out of slots is our
     * problem, not the model's, so the oldest command is evicted to free one.
     *
     * The evicted session stays readable: it is stopped, not forgotten, and it
     * frees its slot the moment it is asked to stop, so a command that takes
     * its time going away cannot hold up the next one.
     */
    const makeRoomForSession = (): void => {
        for (;;) {
            const active = [...sessions.values()].filter(
                (session) => !session.finished && !session.evicted,
            );
            if (active.length < MAX_ACTIVE_BASH_SESSIONS) return;
            const oldest = active.sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) return;
            oldest.evicted = true;
            requestKill(oldest);
        }
    };

    const requestKill = (session: DockerBashSession): void => {
        void kill(session).catch((error: unknown) => {
            session.stream.destroy(
                error instanceof Error
                    ? error
                    : new Error(`Could not stop Docker command: ${error}`),
            );
        });
    };

    const snapshot = (session: DockerBashSession, peek = false): BashSessionSnapshot => {
        const stdoutDelta = session.stdout.subarray(session.stdoutOffset).toString("utf8");
        const stderrDelta = session.stderr.subarray(session.stderrOffset).toString("utf8");
        if (!peek) {
            session.stdoutOffset = session.stdout.length;
            session.stderrOffset = session.stderr.length;
            if (session.finished) session.exitObserved = true;
        }
        return {
            command: session.command,
            cwd: session.cwd,
            exitCode: session.exitCode,
            sessionId: session.sessionId,
            status: session.finished
                ? session.killed || session.exitCode === null
                    ? "killed"
                    : "completed"
                : "running",
            stderr: session.stderr.toString("utf8"),
            stderrDelta,
            stdout: session.stdout.toString("utf8"),
            stdoutDelta,
            timedOut: session.timedOut,
        };
    };

    return {
        activeSessionCount,
        activeSessions: () =>
            [...sessions.values()]
                .filter((session) => !session.finished)
                .map((session) => ({
                    command: session.command,
                    cwd: session.cwd,
                    sessionId: session.sessionId,
                    status: "running" as const,
                })),
        cwd,
        async interruptSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            return interrupt(session);
        },
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => !session.finished);
            for (const session of active) session.exitObserved = true;
            await Promise.all(active.map(kill));
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            session.exitObserved = true;
            await kill(session);
            // Stopping reports status; it must not swallow unread output.
            return snapshot(session, true);
        },
        async readSession(sessionId, options = {}) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            const waitMs = Math.max(0, options.waitMs ?? 0);
            const peeking = options.peek === true;
            if (!session.finished && waitMs > 0 && !options.signal?.aborted) {
                if (!peeking) session.consumingWaiters += 1;
                try {
                    await new Promise<void>((resolve) => {
                        let settled = false;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(timer);
                            options.signal?.removeEventListener("abort", finish);
                            resolve();
                        };
                        const timer = setTimeout(finish, waitMs);
                        options.signal?.addEventListener("abort", finish, { once: true });
                        void session.completion.then(finish);
                    });
                } finally {
                    if (!peeking) session.consumingWaiters -= 1;
                }
            }
            return snapshot(session, peeking);
        },
        async run(options) {
            const { signal, ...startOptions } = options;
            const session = await start(
                {
                    ...startOptions,
                    timeoutMs: startOptions.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
                },
                true,
            );
            const abort = () => requestKill(session);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            try {
                await session.completion;
                const result = snapshot(session);
                return {
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                    stdout: result.stdout,
                    timedOut: result.timedOut,
                };
            } finally {
                signal?.removeEventListener("abort", abort);
            }
        },
        setActiveSessionCountListener(listener) {
            onActiveSessionCountChange = listener;
            listener?.(activeSessionCount());
        },
        setSessionExitListener(listener) {
            onSessionExit = listener;
        },
        async startSession(options) {
            makeRoomForSession();
            return (await start(options)).sessionId;
        },
        supportsSessionInput: true,
        async writeSession(sessionId, data) {
            const session = sessions.get(sessionId);
            if (session === undefined || session.finished || session.stream.destroyed) return false;
            return session.stream.write(data);
        },
    };
}

async function inspectDockerExec(exec: Dockerode.Exec): Promise<Dockerode.ExecInspectInfo> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            exec.inspect(),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("Timed out waiting for Docker command status.")),
                    DOCKER_EXEC_INSPECT_TIMEOUT_MS,
                );
                timeout.unref();
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

async function startDockerManagedNetwork(
    containerBridgeRoot: string,
    workspaceHostPath: string,
    policy: import("../agent/context/ManagedNetworkPolicy.js").ManagedNetworkPolicy,
    networkInterceptor?: ManagedNetworkInterceptor,
): Promise<DockerManagedNetwork> {
    if (
        (policy.allowedDomains?.length ?? 0) === 0 &&
        (policy.allowedLoopbackPorts?.length ?? 0) === 0
    ) {
        throw new Error(
            "Managed network access requires an allowed domain or an allowed loopback port.",
        );
    }
    validateManagedNetworkLoopbackPorts(policy.allowedLoopbackPorts ?? []);
    const hostBridgeRoot = await prepareDockerNetworkBridgeHostRoot(workspaceHostPath);
    const directory = await mkdtemp(join(hostBridgeRoot, "command-"));
    const containerDirectory = posix.join(containerBridgeRoot, basename(directory));
    let shortRoot: string | undefined;
    let proxy: ManagedNetworkProxyHandle | undefined;
    let bridge: LinuxManagedNetworkBridge | undefined;
    try {
        shortRoot = await mkdtemp("/tmp/rig-net-");
        const runningShortRoot = shortRoot;
        const shortDirectory = join(runningShortRoot, "s");
        await symlink(directory, shortDirectory, "dir");
        const runningProxy = await startManagedNetworkProxy(policy, {
            ...(networkInterceptor === undefined ? {} : { networkInterceptor }),
        });
        proxy = runningProxy;
        bridge = await startLinuxManagedNetworkBridge(runningProxy, {
            directory: shortDirectory,
            ...(policy.allowedLoopbackPorts === undefined
                ? {}
                : { loopbackPorts: policy.allowedLoopbackPorts }),
        });
        await makeDockerBridgeDirectoryTraversable(directory);
        const runningBridge = bridge;
        let closed = false;
        return {
            authenticationToken: runningBridge.authenticationToken,
            bridge: runningBridge,
            containerHttpSocketPath: posix.join(containerDirectory, "http.sock"),
            containerLoopbackSockets: runningBridge.loopbackSockets.map(({ port }) => ({
                path: posix.join(containerDirectory, `loopback-${String(port)}.sock`),
                port,
            })),
            containerSocksSocketPath: posix.join(containerDirectory, "socks.sock"),
            proxy: runningProxy,
            async close() {
                if (closed) return;
                await runCleanupSteps("Docker managed network", [
                    () => runningBridge.close(),
                    () => runningProxy.close(),
                    () => rm(runningShortRoot, { force: true, recursive: true }),
                    () => rm(directory, { force: true, recursive: true }),
                ]);
                closed = true;
            },
        };
    } catch (error) {
        const failedProxy = proxy;
        const failedBridge = bridge;
        await runCleanupSteps("Docker managed network startup", [
            ...(failedBridge === undefined ? [] : [() => failedBridge.close()]),
            ...(failedProxy === undefined ? [] : [() => failedProxy.close()]),
            ...(shortRoot === undefined
                ? []
                : [() => rm(shortRoot!, { force: true, recursive: true })]),
            () => rm(directory, { force: true, recursive: true }),
        ]);
        throw error;
    }
}

async function validateDockerNetworkBridgeRoot(
    container: Dockerode.Container,
    root: string,
): Promise<void> {
    const result = await runDockerExec(container, [
        "/bin/sh",
        "-c",
        '[ -d "$1" ] && [ ! -L "$1" ]',
        "rig",
        root,
    ]);
    if (result.exitCode !== 0) {
        throw new Error(
            "Could not validate the protected Docker network bridge directory immediately before command startup.",
        );
    }
}

async function makeDockerBridgeDirectoryTraversable(directory: string): Promise<void> {
    // The random command token remains the authorization boundary. Traverse-only directory
    // access lets a container UID that differs from Rig's host UID reach the authenticated
    // bridge without allowing it to list or replace any bridge path.
    await chmod(directory, 0o711);
}

function withDockerManagedNetworkEnvironment(
    environment: NodeJS.ProcessEnv,
    managedNetwork: DockerManagedNetwork | undefined,
): NodeJS.ProcessEnv {
    if (managedNetwork === undefined) return environment;
    const noProxy = "localhost,127.0.0.1,::1";
    return {
        ...environment,
        ALL_PROXY: "socks5h://127.0.0.1:1080",
        HTTP_PROXY: "http://127.0.0.1:3128",
        HTTPS_PROXY: "http://127.0.0.1:3128",
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: noProxy,
        all_proxy: "socks5h://127.0.0.1:1080",
        http_proxy: "http://127.0.0.1:3128",
        https_proxy: "http://127.0.0.1:3128",
        no_proxy: noProxy,
    };
}

function appendCapped(current: Buffer, chunk: Buffer, maximum: number): Buffer {
    const combined = Buffer.concat([current, chunk]);
    return combined.length <= maximum ? combined : combined.subarray(combined.length - maximum);
}
