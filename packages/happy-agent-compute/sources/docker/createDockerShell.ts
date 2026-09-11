import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { PassThrough, type Duplex } from "node:stream";

import type Dockerode from "dockerode";

import { EMPTY_COMPUTE_HOST_POLICY, type ComputeHostPolicy } from "../ComputeHostPolicy.js";
import {
    assertComputePermissions,
    type ComputeNetworkPermissions,
    type ComputePermissions,
} from "../ComputePermissions.js";
import type {
    ComputeRunOptions,
    ComputeRunResult,
    ComputeSessionActivity,
    ComputeSessionExit,
    ComputeSessionSnapshot,
    ComputeShell,
} from "../ComputeShell.js";
import type { ManagedNetworkPolicy } from "../network/ManagedNetworkPolicy.js";
import { runCleanupSteps } from "../sandbox/impl/runCleanupSteps.js";
import { quoteShellArgument } from "../sandbox/impl/quoteShellArgument.js";
import { BoundedOutputBuffer } from "../processes/index.js";
import { createSupervisorPolicy } from "../supervisor/index.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";
import { createDockerSupervisorCommand } from "./impl/createDockerSupervisorCommand.js";
import { DOCKER_PROTECTED_PATH_MONITOR_SCRIPT } from "./impl/dockerProtectedPathMonitorScript.js";
import { errorToMessage } from "./impl/errorToMessage.js";
import {
    cleanupDockerNetworkPolicyPlaceholder,
    loadDockerProjectManagedNetworkPolicyState,
    type ParseDockerProjectNetworkConfig,
} from "./impl/loadDockerProjectManagedNetworkPolicy.js";
import { resolveDockerNetworkPermissions } from "./impl/resolveDockerNetworkPermissions.js";
import {
    dockerNetworkPolicyFileNames,
    dockerProtectedProjectFileNames,
    dockerReadableDirectories,
    resolveDockerPrivateDirectories,
    snapshotDockerHostPolicy,
} from "./impl/resolveDockerHostPolicy.js";
import { runDockerExec } from "./impl/runDockerExec.js";

/** How the Docker shell is wired to the layer above it. */
export interface DockerShellOptions {
    /** Environment variables injected into every command, such as the session's Git identity. */
    baseEnvironment?: Readonly<Record<string, string>>;
    /** Product-owned paths and root project files this shell must protect. */
    hostPolicy?: ComputeHostPolicy;
    /** Interprets a project config file into a managed-network configuration; see the type. */
    parseNetworkConfig?: ParseDockerProjectNetworkConfig;
}

interface DockerShellSession {
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
    pidFile: string;
    networkPolicyPlaceholderCleanup?: () => Promise<void>;
    sessionId: number;
    stderr: BoundedOutputBuffer;
    stderrUnread: BoundedOutputBuffer;
    stderrOffset: number;
    stdout: BoundedOutputBuffer;
    stdoutUnread: BoundedOutputBuffer;
    stdoutOffset: number;
    stream: Duplex;
    timedOut: boolean;
    timeout?: NodeJS.Timeout;
}

interface ActiveDockerNetworkPolicyPlaceholder {
    projectRoot: string;
    container: Dockerode.Container;
    markerPath: string;
    networkPolicyFile: string;
    references: number;
}

const activeNetworkPolicyPlaceholders = new Map<string, ActiveDockerNetworkPolicyPlaceholder>();
const networkPolicyPlaceholderLocks = new Map<string, Promise<void>>();
const dockerEnvironmentKeys = new WeakMap<object, string>();
let nextDockerEnvironmentKey = 1;
const MAX_ACTIVE_SESSIONS = 64;
const MAX_RETAINED_SESSIONS = 64;
// How long a command has to shut itself down before it is forced; long enough to be polite, short
// enough that stopping still feels immediate.
const BASH_SESSION_STOP_GRACE_MS = 2_000;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DOCKER_EXEC_INSPECT_TIMEOUT_MS = 10_000;
// The wrapper writes its own PID, then waits for this token before exec'ing the command, so the
// backend has a PID to signal even for a command that is slow to start.
const DOCKER_EXEC_START_GATE = "compute-start\n";
const DOCKER_EXEC_START_GATE_SCRIPT = String.raw`
pid_file=$1
shift
printf '%s\n' "$$" > "$pid_file"
IFS= read -r gate
[ "$gate" = "compute-start" ] || exit 125
exec "$@"
`;

/**
 * A {@link ComputeShell} whose commands run inside one container as long-lived sessions.
 *
 * A command runs to completion within its timeout or becomes a session the agent comes back to:
 * reaching the timeout backgrounds it, it never kills it. Sessions outlive the tool call and the
 * turn, belong to this shell, and are ended only by disposing the compute. Delta reads return only
 * what accumulated since the previous read, stdin is written straight into the command, stopping is
 * graceful then forceful across the whole process tree, an unobserved exit is reported once, and
 * passing the session cap evicts the oldest command rather than failing the agent's. Restricted
 * commands invoke the static Linux supervisor mounted at {@link DOCKER_SUPERVISOR_PATH}; the
 * supervisor owns the filesystem, namespace, and filtered egress boundary.
 */
export function createDockerShell(
    environment: DockerEnvironment,
    options: DockerShellOptions = {},
): ComputeShell {
    const baseEnvironment = options.baseEnvironment ?? {};
    const hostPolicy = snapshotDockerHostPolicy(options.hostPolicy ?? EMPTY_COMPUTE_HOST_POLICY);
    const networkPolicyFiles = dockerNetworkPolicyFileNames(hostPolicy);
    const protectedProjectFiles = dockerProtectedProjectFileNames(hostPolicy);
    const readableDirectories = dockerReadableDirectories(hostPolicy);
    const sessions = new Map<number, DockerShellSession>();
    const contextId = randomUUID();
    const cwd = environment.config.workingDirectory;
    const environmentKey = getDockerEnvironmentKey(environment);
    let nextSessionId = 1;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;
    const activeSessionCount = () =>
        [...sessions.values()].filter((session) => !session.finished && !session.evicted).length;
    const retainNetworkPolicyPlaceholder = (
        key: string,
        candidate: ActiveDockerNetworkPolicyPlaceholder,
    ): void => {
        const existing = activeNetworkPolicyPlaceholders.get(key);
        if (existing !== undefined) {
            existing.references += 1;
            return;
        }
        candidate.references = 1;
        activeNetworkPolicyPlaceholders.set(key, candidate);
    };
    const retainExistingNetworkPolicyPlaceholder = (key: string): void => {
        const existing = activeNetworkPolicyPlaceholders.get(key);
        if (existing !== undefined) existing.references += 1;
    };
    const createNetworkPolicyPlaceholderCleanup = (
        key: string,
    ): (() => Promise<void>) | undefined => {
        const placeholder = activeNetworkPolicyPlaceholders.get(key);
        if (placeholder === undefined) return undefined;
        let closed = false;
        return async () => {
            if (closed) return;
            closed = true;
            await withNetworkPolicyPlaceholderLock(key, async () => {
                placeholder.references -= 1;
                if (placeholder.references > 0) return;
                // Deletion stays after the awaited cleanup so a failure keeps the zero-reference
                // entry available for a later retry instead of treating the file as user-owned.
                await cleanupDockerNetworkPolicyPlaceholder(
                    placeholder.container,
                    cwd,
                    placeholder.projectRoot,
                    placeholder.markerPath,
                    placeholder.networkPolicyFile,
                );
                activeNetworkPolicyPlaceholders.delete(key);
            });
        };
    };

    const start = async (
        runOptions: Omit<ComputeRunOptions, "signal">,
        exitObserved = false,
    ): Promise<DockerShellSession> => {
        assertComputePermissions(runOptions.permissions);
        const permissions = snapshotPermissions(runOptions.permissions);
        const permissionMode = permissions.mode;
        if (runOptions.shell !== undefined && permissionMode !== "full_access") {
            throw new Error("Custom shells are available only in Full access mode.");
        }
        assertNoSecrets(runOptions.secrets);
        if (runOptions.tty === true) {
            throw new Error("The Docker backend does not run commands under a pseudo-terminal.");
        }
        const sessionId = nextSessionId++;
        const runCwd = runOptions.cwd === undefined ? cwd : posix.resolve(cwd, runOptions.cwd);
        const shell = runOptions.shell ?? "/bin/sh";
        const pidFile = `/tmp/compute-exec-${process.pid}-${contextId}-${sessionId}.pid`;
        const container = await environment.container();
        const restricted = permissionMode !== "full_access";
        const supervisorPath = restricted ? await environment.supervisorBinary() : undefined;
        const hostPrivateDirectories = !restricted
            ? []
            : await resolveDockerPrivateDirectories(environment, hostPolicy, baseEnvironment);
        const hostDeniedWritePaths = !restricted
            ? []
            : [...hostPrivateDirectories, ...readableDirectories];
        const protectsProjectMetadata = restricted && permissionMode !== "read_only";
        const usesProjectNetworkPolicy =
            protectsProjectMetadata &&
            networkPolicyFiles.length > 0 &&
            options.parseNetworkConfig !== undefined;
        const networkPolicyPlaceholderMarker =
            !usesProjectNetworkPolicy || networkPolicyFiles.length === 0
                ? undefined
                : posix.join(cwd, `.policy-${contextId}-${String(sessionId)}`);
        const networkPolicyPath =
            networkPolicyFiles.length === 0 ? undefined : posix.join(cwd, networkPolicyFiles[0]!);
        const networkPolicyKey =
            networkPolicyPath === undefined
                ? undefined
                : `${environmentKey}\0${cwd}\0${networkPolicyPath}`;
        let networkPolicyState:
            | Awaited<ReturnType<typeof loadDockerProjectManagedNetworkPolicyState>>
            | undefined;
        try {
            networkPolicyState = await withNetworkPolicyPlaceholderLock(
                networkPolicyKey,
                async () => {
                    if (
                        networkPolicyPlaceholderMarker === undefined ||
                        networkPolicyKey === undefined
                    ) {
                        return undefined;
                    }
                    const state = await loadDockerProjectManagedNetworkPolicyState(
                        container,
                        cwd,
                        cwd,
                        networkPolicyPlaceholderMarker,
                        networkPolicyFiles,
                        options.parseNetworkConfig,
                        {
                            onPlaceholderCreated(networkPolicyFile) {
                                retainNetworkPolicyPlaceholder(networkPolicyKey!, {
                                    projectRoot: cwd,
                                    container,
                                    markerPath: networkPolicyPlaceholderMarker,
                                    networkPolicyFile,
                                    references: 0,
                                });
                            },
                        },
                    );
                    if (state.placeholderNetworkPolicyFile === undefined) {
                        retainExistingNetworkPolicyPlaceholder(networkPolicyKey);
                    }
                    return state;
                },
            );
        } catch (error) {
            if (networkPolicyPlaceholderMarker !== undefined) {
                const cleanup = createNetworkPolicyPlaceholderCleanup(networkPolicyKey!);
                if (cleanup !== undefined) {
                    await cleanup().catch(() => undefined);
                } else {
                    await cleanupDockerNetworkPolicyPlaceholder(
                        container,
                        cwd,
                        cwd,
                        networkPolicyPlaceholderMarker,
                        networkPolicyFiles[0]!,
                    ).catch(() => undefined);
                }
            }
            throw error;
        }
        const networkPolicyPlaceholderCleanup =
            networkPolicyPlaceholderMarker === undefined || networkPolicyKey === undefined
                ? undefined
                : createNetworkPolicyPlaceholderCleanup(networkPolicyKey);
        const protectedNetworkPolicyMarker =
            networkPolicyKey === undefined
                ? undefined
                : activeNetworkPolicyPlaceholders.get(networkPolicyKey)?.markerPath;
        const cleanupStartup = () =>
            runCleanupSteps(
                "Docker command startup",
                networkPolicyPlaceholderCleanup === undefined
                    ? []
                    : [networkPolicyPlaceholderCleanup],
            );
        let resolvedNetwork: ReturnType<typeof resolveDockerNetworkPermissions>;
        let supervisorNetwork: ReturnType<typeof resolveDockerSupervisorNetwork>;
        try {
            resolvedNetwork = resolveDockerNetworkPermissions(
                permissions,
                networkPolicyState?.policy,
            );
            supervisorNetwork = resolveDockerSupervisorNetwork(
                permissions,
                networkPolicyState?.policy,
                resolvedNetwork.managedPolicy,
            );
        } catch (error) {
            await cleanupStartup();
            throw error;
        }
        const protectedProjectPaths =
            !restricted || permissionMode === "read_only"
                ? []
                : [
                      ...[".git", ...protectedProjectFiles].map((name) => posix.join(cwd, name)),
                      ...(protectedNetworkPolicyMarker === undefined
                          ? []
                          : [protectedNetworkPolicyMarker]),
                  ];
        const deniedWritePaths =
            permissionMode === "read_only"
                ? []
                : [
                      ...(permissions.deniedWritePaths ?? []),
                      ...hostDeniedWritePaths,
                      ...protectedProjectPaths,
                  ];
        let supervisorPolicy: ReturnType<typeof createSupervisorPolicy> | undefined;
        try {
            const existingDeniedWritePaths = await resolveExistingDockerContainerPaths(
                container,
                cwd,
                deniedWritePaths,
                { rejectSymlinks: true },
            );
            const allowedWritePaths = await resolveExistingDockerContainerPaths(
                container,
                cwd,
                permissions.allowedWritePaths ?? [],
            );
            supervisorPolicy = restricted
                ? createSupervisorPolicy({
                      cwd,
                      platform: "linux",
                      permissions,
                      ...(permissions.allowedReadPaths === undefined
                          ? {}
                          : { allowedReadPaths: permissions.allowedReadPaths }),
                      deniedReadPaths: [
                          ...(permissions.deniedReadPaths ?? []),
                          ...hostPrivateDirectories,
                      ],
                      allowedWritePaths,
                      deniedWritePaths: existingDeniedWritePaths,
                      network: supervisorNetwork.network,
                      ...(supervisorNetwork.proxy ? { networkProxy: true } : {}),
                  })
                : undefined;
        } catch (error) {
            await cleanupStartup();
            throw error;
        }
        let invokedCommand: string[];
        try {
            if (supervisorPolicy === undefined) {
                invokedCommand = [shell, "-lc", runOptions.command];
            } else {
                const supervisorCommand = createDockerSupervisorCommand({
                    command: withWorkingDirectory(runOptions.command, runCwd),
                    policy: supervisorPolicy,
                    shell,
                    ...(supervisorPath === undefined ? {} : { supervisorPath }),
                });
                invokedCommand = [supervisorCommand.command, ...supervisorCommand.args];
            }
        } catch (error) {
            await cleanupStartup();
            throw error;
        }
        let protectedCreatePaths: readonly string[];
        try {
            protectedCreatePaths =
                !restricted || permissionMode === "read_only"
                    ? []
                    : [
                          ...protectedProjectPaths,
                          ...(await findAbsentDeniedWritePaths(container, cwd, [
                              ...(permissions.deniedWritePaths ?? []),
                              ...hostDeniedWritePaths,
                              ...protectedProjectPaths,
                          ])),
                      ];
        } catch (error) {
            await cleanupStartup();
            throw error;
        }
        let exec: Dockerode.Exec;
        try {
            const payloadCommand =
                protectedCreatePaths.length === 0
                    ? invokedCommand
                    : [
                          "/bin/sh",
                          "-c",
                          DOCKER_PROTECTED_PATH_MONITOR_SCRIPT,
                          "compute-protected-paths",
                          pidFile,
                          ...protectedCreatePaths,
                          "--",
                          ...invokedCommand,
                      ];
            const commandEnvironment = { ...baseEnvironment };
            exec = await container.exec({
                AttachStdin: true,
                AttachStderr: true,
                AttachStdout: true,
                Cmd: [
                    "/bin/sh",
                    "-c",
                    DOCKER_EXEC_START_GATE_SCRIPT,
                    "compute-command",
                    pidFile,
                    ...payloadCommand,
                ],
                ...(Object.keys(commandEnvironment).length === 0
                    ? {}
                    : {
                          Env: Object.entries(commandEnvironment).map(
                              ([name, value]) => `${name}=${value ?? ""}`,
                          ),
                      }),
                Tty: false,
                WorkingDir: restricted ? cwd : runCwd,
            });
        } catch (error) {
            await cleanupStartup();
            throw error;
        }
        let stream!: Duplex;
        try {
            stream = await exec.start({ hijack: true, stdin: true, Tty: false });
            stream.write(DOCKER_EXEC_START_GATE);
        } catch (error) {
            stream?.end();
            await cleanupStartup();
            throw error;
        }
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        const maximum = runOptions.maxOutputBytes ?? 512_000;
        const session: DockerShellSession = {
            command: runOptions.command,
            completion: Promise.resolve(),
            consumingWaiters: 0,
            cwd: runCwd,
            exec,
            exitCode: null,
            exitObserved,
            finished: false,
            killed: false,
            ...(networkPolicyPlaceholderCleanup === undefined
                ? {}
                : { networkPolicyPlaceholderCleanup }),
            pidFile,
            sessionId,
            stderr: new BoundedOutputBuffer(maximum),
            stderrUnread: new BoundedOutputBuffer(maximum),
            stderrOffset: 0,
            stdout: new BoundedOutputBuffer(maximum),
            stdoutUnread: new BoundedOutputBuffer(maximum),
            stdoutOffset: 0,
            stream,
            timedOut: false,
        };
        const appendStderr = (chunk: Buffer): void => {
            session.stderr.append(chunk);
            session.stderrUnread.append(chunk);
        };
        stdoutStream.on("data", (chunk: Buffer) => {
            session.stdout.append(chunk);
            session.stdoutUnread.append(chunk);
        });
        stderrStream.on("data", (chunk: Buffer) => {
            appendStderr(chunk);
        });
        container.modem.demuxStream(stream, stdoutStream, stderrStream);
        session.completion = new Promise<void>((resolve) => {
            let settled = false;
            const finish = async (error?: Error) => {
                if (settled) return;
                settled = true;
                if (error !== undefined) {
                    appendStderr(Buffer.from(error.message));
                }
                try {
                    session.exitCode = (await inspectDockerExec(exec)).ExitCode;
                } catch (inspectError) {
                    appendStderr(
                        Buffer.from(
                            `Could not inspect the Docker command after it exited: ${errorToMessage(inspectError)}\n`,
                        ),
                    );
                    session.exitCode = null;
                }
                try {
                    await runCleanupSteps(
                        "Docker command",
                        session.networkPolicyPlaceholderCleanup === undefined
                            ? []
                            : [session.networkPolicyPlaceholderCleanup],
                    );
                } catch (cleanupError) {
                    appendStderr(
                        Buffer.from(`Command cleanup failed: ${errorToMessage(cleanupError)}\n`),
                    );
                    session.exitCode = 1;
                }
                session.finished = true;
                if (session.timeout !== undefined) clearTimeout(session.timeout);
                const awaited = session.consumingWaiters > 0;
                onActiveSessionCountChange?.(activeSessionCount());
                trimFinishedSessions();
                resolve();
                if (!awaited && !session.exitObserved) {
                    await onSessionExit?.({
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
        onActiveSessionCountChange?.(activeSessionCount());
        if (runOptions.timeoutMs !== undefined) {
            session.timeout = setTimeout(
                () => {
                    // Reaching the timeout backgrounds the session; it marks it timed out and never
                    // stops the command, which keeps running for the agent to come back to.
                    session.timedOut = true;
                },
                Math.max(0, runOptions.timeoutMs),
            );
            session.timeout.unref();
        }
        trimFinishedSessions();
        return session;
    };

    const kill = async (session: DockerShellSession): Promise<void> => {
        if (session.finished) return;
        session.killed = true;
        const container = await environment.container();
        await runDockerExec(container, [
            "/bin/sh",
            "-c",
            'pid=$(cat "$1" 2>/dev/null) || exit 0; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
            "compute-stop",
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
                "compute-force-stop",
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

    const interrupt = async (session: DockerShellSession): Promise<boolean> => {
        if (session.finished) return false;
        const container = await environment.container();
        const result = await runDockerExec(container, [
            "/bin/sh",
            "-c",
            'pid=$(cat "$1" 2>/dev/null) || exit 1; kill -INT -- "-$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null',
            "compute-interrupt",
            session.pidFile,
        ]);
        return result.exitCode === 0;
    };

    /**
     * Forgets the oldest finished commands once too many have piled up. Runs whenever a command
     * starts or ends, so a session that only ever finishes work still lets go of what it holds.
     */
    const trimFinishedSessions = (): void => {
        while (sessions.size > MAX_RETAINED_SESSIONS) {
            const finished = [...sessions.values()]
                .filter((candidate) => candidate.finished)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            sessions.delete(finished.sessionId);
        }
    };

    /**
     * Makes room for one more background command. Running out of slots is our problem, not the
     * agent's, so the oldest command is evicted to free one. The evicted session stays readable: it
     * is stopped, not forgotten, and frees its slot the moment it is asked to stop.
     */
    const makeRoomForSession = (): void => {
        for (;;) {
            const active = [...sessions.values()].filter(
                (session) => !session.finished && !session.evicted,
            );
            if (active.length < MAX_ACTIVE_SESSIONS) return;
            const oldest = active.sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) return;
            oldest.evicted = true;
            requestKill(oldest);
        }
    };

    const requestKill = (session: DockerShellSession): void => {
        void kill(session).catch((error: unknown) => {
            session.stream.destroy(
                error instanceof Error
                    ? error
                    : new Error(`Could not stop Docker command: ${String(error)}`),
            );
        });
    };

    const snapshot = (session: DockerShellSession, peek = false): ComputeSessionSnapshot => {
        const stdoutDeltaBuffer = peek
            ? session.stdoutUnread.clone()
            : session.stdoutUnread.drain();
        const stderrDeltaBuffer = peek
            ? session.stderrUnread.clone()
            : session.stderrUnread.drain();
        const stdoutDelta = stdoutDeltaBuffer.snapshot().toString("utf8");
        const stderrDelta = stderrDeltaBuffer.snapshot().toString("utf8");
        if (!peek) {
            session.stdoutOffset = session.stdout.totalBytes - session.stdoutUnread.totalBytes;
            session.stderrOffset = session.stderr.totalBytes - session.stderrUnread.totalBytes;
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
            stderr: session.stderr.snapshot().toString("utf8"),
            stderrDelta,
            stderrBytes: session.stderr.totalBytes,
            stderrDeltaBytes: stderrDeltaBuffer.totalBytes,
            stderrDeltaOmittedBytes: stderrDeltaBuffer.omittedBytes,
            stderrOmittedBytes: session.stderr.omittedBytes,
            stdout: session.stdout.snapshot().toString("utf8"),
            stdoutDelta,
            stdoutBytes: session.stdout.totalBytes,
            stdoutDeltaBytes: stdoutDeltaBuffer.totalBytes,
            stdoutDeltaOmittedBytes: stdoutDeltaBuffer.omittedBytes,
            stdoutOmittedBytes: session.stdout.omittedBytes,
            timedOut: session.timedOut,
        };
    };

    return {
        activeSessionCount,
        activeSessions: (): readonly ComputeSessionActivity[] =>
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
        async readSession(sessionId, readOptions = {}) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            const waitMs = Math.max(0, readOptions.waitMs ?? 0);
            const peeking = readOptions.peek === true;
            if (!session.finished && waitMs > 0 && !readOptions.signal?.aborted) {
                if (!peeking) session.consumingWaiters += 1;
                try {
                    await new Promise<void>((resolve) => {
                        let settled = false;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(timer);
                            readOptions.signal?.removeEventListener("abort", finish);
                            resolve();
                        };
                        const timer = setTimeout(finish, waitMs);
                        readOptions.signal?.addEventListener("abort", finish, { once: true });
                        void session.completion.then(finish);
                    });
                } finally {
                    if (!peeking) session.consumingWaiters -= 1;
                }
            }
            return snapshot(session, peeking);
        },
        async run(runOptions) {
            const { signal, ...startOptions } = runOptions;
            const session = await start(
                { ...startOptions, timeoutMs: startOptions.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS },
                true,
            );
            const abort = () => requestKill(session);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            try {
                await session.completion;
                const result = snapshot(session);
                return toRunResult(result);
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
        async startSession(startOptions) {
            makeRoomForSession();
            return (await start(startOptions)).sessionId;
        },
        sessionUsesSecrets() {
            return false;
        },
        supportsSessionInput: true,
        async writeSession(_permissions, sessionId, data) {
            const session = sessions.get(sessionId);
            if (session === undefined || session.finished || session.stream.destroyed) return false;
            return session.stream.write(data);
        },
    };
}

function snapshotPermissions(permissions: ComputePermissions): ComputePermissions {
    return {
        mode: permissions.mode,
        network: {
            egress: permissions.network.egress,
            localBinding: permissions.network.localBinding,
            ...(permissions.network.allowedHosts === undefined
                ? {}
                : { allowedHosts: [...permissions.network.allowedHosts] }),
        },
        ...(permissions.allowedReadPaths === undefined
            ? {}
            : { allowedReadPaths: [...permissions.allowedReadPaths] }),
        ...(permissions.deniedReadPaths === undefined
            ? {}
            : { deniedReadPaths: [...permissions.deniedReadPaths] }),
        ...(permissions.allowedWritePaths === undefined
            ? {}
            : { allowedWritePaths: [...permissions.allowedWritePaths] }),
        ...(permissions.deniedWritePaths === undefined
            ? {}
            : { deniedWritePaths: [...permissions.deniedWritePaths] }),
    };
}

function getDockerEnvironmentKey(environment: DockerEnvironment): string {
    const object = environment as unknown as object;
    const existing = dockerEnvironmentKeys.get(object);
    if (existing !== undefined) return existing;
    const configured = environment.config.container ?? environment.config.name;
    const key =
        configured === undefined
            ? `environment-${String(nextDockerEnvironmentKey++)}`
            : `${environment.config.socketPath ?? "/var/run/docker.sock"}\0${configured}`;
    dockerEnvironmentKeys.set(object, key);
    return key;
}

async function withNetworkPolicyPlaceholderLock<T>(
    key: string | undefined,
    action: () => Promise<T>,
): Promise<T> {
    if (key === undefined) return action();
    const previous = networkPolicyPlaceholderLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
    );
    networkPolicyPlaceholderLocks.set(key, current);
    await previous;
    try {
        return await action();
    } finally {
        release();
        if (networkPolicyPlaceholderLocks.get(key) === current) {
            networkPolicyPlaceholderLocks.delete(key);
        }
    }
}

async function resolveExistingDockerContainerPaths(
    container: Dockerode.Container,
    cwd: string,
    paths: readonly string[],
    options: { rejectSymlinks?: boolean } = {},
): Promise<readonly string[]> {
    const resolved = [...new Set(paths.map((path) => posix.resolve(cwd, path)))];
    if (resolved.length === 0) return [];
    const result = await runDockerExec(
        container,
        [
            "/bin/sh",
            "-c",
            'for path do if [ -L "$path" ]; then printf "S\\n"; elif [ -e "$path" ]; then printf "1\\n"; else printf "0\\n"; fi; done',
            "compute-permission-paths",
            ...resolved,
        ],
        { maxOutputBytes: resolved.length * 2 },
    );
    if (result.exitCode !== 0) {
        throw new Error("Could not inspect Docker permission paths.");
    }
    const exists = result.stdout.toString("utf8").trimEnd().split("\n");
    if (exists.length !== resolved.length) {
        throw new Error("Docker returned incomplete permission-path metadata.");
    }
    if (exists.some((status) => status !== "0" && status !== "1" && status !== "S")) {
        throw new Error("Docker returned invalid permission-path metadata.");
    }
    if (options.rejectSymlinks === true && exists.includes("S")) {
        throw new Error(
            "Restricted Docker commands cannot protect a symbolic-link permission path.",
        );
    }
    return resolved.filter((_path, index) => exists[index] === "1");
}

async function findAbsentDeniedWritePaths(
    container: Dockerode.Container,
    cwd: string,
    paths: readonly string[],
): Promise<readonly string[]> {
    const targets = [...new Set(paths.map((path) => posix.resolve(cwd, path)))];
    if (targets.length === 0) return [];
    const result = await runDockerExec(
        container,
        [
            "/bin/sh",
            "-c",
            'for path do if [ -e "$path" ] || [ -L "$path" ]; then printf "0\\n"; else printf "1\\n"; fi; done',
            "compute-denied-write-paths",
            ...targets,
        ],
        { maxOutputBytes: targets.length * 2 },
    );
    if (result.exitCode !== 0) {
        throw new Error("Could not inspect denied Docker write paths.");
    }
    const absent = result.stdout.toString("utf8").trimEnd().split("\n");
    if (absent.length !== targets.length) {
        throw new Error("Docker returned incomplete denied-write metadata.");
    }
    if (absent.some((status) => status !== "0" && status !== "1")) {
        throw new Error("Docker returned invalid denied-write metadata.");
    }
    return targets.filter((_path, index) => absent[index] === "1");
}

function resolveDockerSupervisorNetwork(
    permissions: ComputePermissions,
    projectPolicy: ManagedNetworkPolicy | undefined,
    managedPolicy: ManagedNetworkPolicy | undefined,
): { network: ComputeNetworkPermissions; proxy: boolean } {
    const network: ComputeNetworkPermissions = {
        egress: permissions.network.egress,
        localBinding:
            permissions.network.localBinding && projectPolicy?.allowLocalBinding !== false,
    };
    if (!permissions.network.egress) return { network, proxy: false };
    const permissionHosts = permissions.network.allowedHosts ?? [];
    // The native supervisor can deny local binding independently, so unrestricted egress never
    // needs a separate proxy solely because localBinding is false.
    if (managedPolicy === undefined && permissionHosts.length === 0) {
        return { network, proxy: false };
    }
    const policy = managedPolicy ?? { allowedDomains: [] };
    if ((policy.allowedLoopbackPorts?.length ?? 0) > 0) {
        throw new Error(
            "Docker project network policies with allowed loopback ports are not supported by the native supervisor.",
        );
    }
    if ((policy.deniedDomains?.length ?? 0) > 0) {
        throw new Error(
            "Docker project network policies with denied domains are not supported by the native supervisor.",
        );
    }
    if (policy.allowedDomains?.some(({ ports }) => ports !== undefined) === true) {
        throw new Error(
            "Docker project network policies with per-domain ports are not supported by the native supervisor.",
        );
    }
    const allowedHosts = (policy.allowedDomains ?? []).map(({ domain }) => domain);
    // A project wildcard expresses open egress. Keep it direct so it does not become the native
    // supervisor's deliberately-invalid bare '*' host allow-list.
    if (allowedHosts.includes("*")) {
        return { network, proxy: false };
    }
    return {
        network: {
            ...network,
            allowedHosts,
        },
        proxy: true,
    };
}

function withWorkingDirectory(command: string, cwd: string): string {
    return `cd ${quoteShellArgument(cwd)} && ${command}`;
}

function toRunResult(result: ComputeSessionSnapshot): ComputeRunResult {
    return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        ...(result.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
        ...(result.stderrOmittedBytes === undefined
            ? {}
            : { stderrOmittedBytes: result.stderrOmittedBytes }),
        stdout: result.stdout,
        ...(result.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
        ...(result.stdoutOmittedBytes === undefined
            ? {}
            : { stdoutOmittedBytes: result.stdoutOmittedBytes }),
        timedOut: result.timedOut,
    };
}

function assertNoSecrets(secrets: readonly string[] | undefined): void {
    if (secrets !== undefined && secrets.length > 0) {
        throw new Error("The Docker backend cannot inject secret bundles.");
    }
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
