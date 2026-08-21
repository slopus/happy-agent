import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import type { Context } from "@steve.kite/stdlib";
import { resolveSupervisorBinary } from "@slopus/happy-agent-supervisor";

import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import { assertComputePermissions, type ComputePermissions } from "../ComputePermissions.js";
import type {
    ComputeRunResult,
    ComputeSessionExit,
    ComputeSessionSnapshot,
    ComputeShell,
} from "../ComputeShell.js";
import {
    NativeProcessManager,
    resolveSystemShell,
    type ManagedProcess,
    type ProcessRunOptions,
    type ProcessRunResult,
    type ProcessStartOptions,
} from "../processes/index.js";
import { createToolEnvironment } from "../sandbox/impl/createToolEnvironment.js";
import { createHostPolicyPrivatePaths } from "../sandbox/impl/createHostPolicyPrivatePaths.js";
import { createSensitiveReadPaths } from "../sandbox/impl/createSensitiveReadPaths.js";
import { projectProtectedFileNames } from "../sandbox/impl/projectProtectedFileNames.js";
import { quoteShellArgument } from "../sandbox/impl/quoteShellArgument.js";
import { resolvePotentialPath } from "../sandbox/impl/resolvePotentialPath.js";
import { resolveSupervisorProtectedPaths } from "../supervisor/resolveSupervisorProtectedPaths.js";
import { createSupervisorCommand, createSupervisorPolicy } from "../supervisor/index.js";
import {
    createProtectedPathMonitor,
    type ProtectedPathMonitor,
} from "./impl/createProtectedPathMonitor.js";
import {
    DEFAULT_HOST_COMMAND_TIMEOUT_MS,
    DEFAULT_HOST_MAX_OUTPUT_BYTES,
    HOST_SESSION_STOP_GRACE_MS,
    MAX_ACTIVE_HOST_SESSIONS,
    MAX_RETAINED_HOST_SESSIONS,
} from "./impl/hostSessionLimits.js";
import { waitForHostSessionCompletion } from "./impl/waitForHostSessionCompletion.js";
import {
    assertCanUseCustomShell,
    assertSecretsUnsupported,
} from "./impl/assertHostCommandOptions.js";

export interface HostShellOptions {
    /** The context that owns the compute's process lifetime; sessions never retain a tool call. */
    ctx: Context;
    /** The directory commands run in by default. */
    cwd: string;
    processManager: NativeProcessManager;
    environment?: NodeJS.ProcessEnv;
    hostPolicy?: ComputeHostPolicy;
    /** The home directory used to identify universal private credential paths. */
    homeDirectory?: string;
    /** How many commands may run at once before the oldest is evicted. Defaults to the host cap. */
    maxActiveSessions?: number;
    /** How many finished commands stay readable before the oldest is forgotten. */
    maxRetainedSessions?: number;
}

interface PreparedHostCommand {
    args?: readonly string[];
    command: string;
    processCwd?: string;
    protectedCreatePaths?: readonly string[];
    shell?: string;
}

interface HostSession {
    command: string;
    completionStderrDelta?: string;
    completionWaiters: Set<() => void>;
    /**
     * Readers waiting for the end who will also report it.
     *
     * An observer that only peeks waits the same way but consumes nothing, so it must not be
     * mistaken for someone about to tell the model the news.
     */
    consumingWaiters: number;
    cwd: string;
    /** Stopped to make room for a newer command, but still readable. */
    evicted?: true;
    /** A read has already returned this session's final status. */
    exitObserved: boolean;
    process: ManagedProcess;
    result?: ProcessRunResult;
    sessionId: number;
    stderrOffset: number;
    stdoutOffset: number;
    timedOut: boolean;
    timeout?: NodeJS.Timeout;
}

/**
 * The session manager around the native process manager, in the shape of the {@link ComputeShell}
 * contract.
 *
 * A command either runs to completion within its timeout or becomes a session the agent comes back
 * to: reaching the timeout backgrounds a session, it never stops the command. A session outlives
 * the tool call and the turn, and belongs to the compute that started it, so it is captured with
 * the compute's owning context rather than any per-call one.
 */
export function createHostShell(options: HostShellOptions): ComputeShell {
    const sessions = new Map<number, HostSession>();
    let nextSessionId = 1;
    let pendingSessionStarts = 0;
    let canonicalWorkspace: Promise<string> | undefined;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;

    const maxActiveSessions = options.maxActiveSessions ?? MAX_ACTIVE_HOST_SESSIONS;
    const maxRetainedSessions = options.maxRetainedSessions ?? MAX_RETAINED_HOST_SESSIONS;
    const runCwd = (cwd: string | undefined) =>
        cwd === undefined ? options.cwd : isAbsolute(cwd) ? cwd : resolve(options.cwd, cwd);
    const resolveCanonicalWorkspace = (): Promise<string> => {
        canonicalWorkspace ??= resolvePotentialPath(options.cwd).catch((error: unknown) => {
            canonicalWorkspace = undefined;
            throw error;
        });
        return canonicalWorkspace;
    };
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

    const prepareCommand = async (
        permissions: ComputePermissions,
        command: string,
        cwd: string,
        shell: string,
    ): Promise<PreparedHostCommand> => {
        if (permissions.mode === "full_access") {
            return { command, shell };
        }
        const canonicalCwd = await resolveCanonicalWorkspace();
        const canonicalHome = await resolvePotentialPath(options.homeDirectory ?? homedir());
        const privatePaths = absoluteHostPaths(
            canonicalCwd,
            createHostPolicyPrivatePaths(options.hostPolicy, options.environment),
        );
        const sensitiveReadPaths = absoluteHostPaths(
            canonicalCwd,
            createSensitiveReadPaths({
                ...(options.environment === undefined ? {} : { environment: options.environment }),
                ...(options.homeDirectory === undefined
                    ? {}
                    : { homeDirectory: options.homeDirectory }),
                ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
            }),
        ).filter((path) => shouldDenySensitiveReadPath(path, canonicalCwd, canonicalHome));
        const protectedNames = [".git", ...projectProtectedFileNames(options.hostPolicy)];
        const protectedPaths =
            permissions.mode === "read_only"
                ? []
                : protectedNames.map((name) => join(canonicalCwd, name));
        const supervisorPath = resolveSupervisorBinary();
        const supervisorProtectedPaths = resolveSupervisorProtectedPaths(supervisorPath);
        const deniedWritePaths =
            permissions.mode === "read_only"
                ? []
                : [
                      ...(permissions.deniedWritePaths ?? []),
                      ...privatePaths,
                      ...(options.hostPolicy?.readableDirectories ?? []),
                      ...protectedPaths,
                      ...supervisorProtectedPaths,
                  ];
        const absoluteDeniedWritePaths = absoluteHostPaths(canonicalCwd, deniedWritePaths);
        await rejectSymlinkedPaths(absoluteDeniedWritePaths);
        const policy = createSupervisorPolicy({
            cwd: canonicalCwd,
            permissions,
            deniedReadPaths: [
                ...(permissions.deniedReadPaths ?? []),
                ...privatePaths,
                ...sensitiveReadPaths,
            ],
            deniedWritePaths:
                process.platform === "darwin"
                    ? absoluteDeniedWritePaths
                    : existingHostPaths(canonicalCwd, deniedWritePaths),
            ...(permissions.allowedReadPaths === undefined
                ? {}
                : { allowedReadPaths: permissions.allowedReadPaths }),
            ...(permissions.allowedWritePaths === undefined
                ? {}
                : {
                      allowedWritePaths: existingHostPaths(
                          canonicalCwd,
                          permissions.allowedWritePaths,
                      ),
                  }),
        });
        const supervisorCommand = createSupervisorCommand({
            command: withWorkingDirectory(command, cwd),
            policy,
            shell,
            supervisorPath,
        });
        return {
            args: supervisorCommand.args,
            command: supervisorCommand.command,
            processCwd: canonicalCwd,
            protectedCreatePaths: absoluteDeniedWritePaths.filter(
                (path) => !existsHostPath(options.cwd, path),
            ),
        };
    };

    /**
     * Makes room for one more command. Running out of slots is our problem, not the model's, so the
     * oldest command is evicted to free one.
     *
     * The evicted session stays readable: it is stopped, not forgotten, so a model still holding its
     * task ID learns what became of it. Only its slot is released, and immediately, so a command
     * that ignores the signal cannot keep the next one from starting.
     */
    const reserveSessionStart = () => {
        while (activeSessionCount() + pendingSessionStarts >= maxActiveSessions) {
            const oldest = [...sessions.values()]
                .filter((session) => session.result === undefined && !session.evicted)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) {
                throw new Error(
                    `No more than ${String(maxActiveSessions)} background commands can run at once.`,
                );
            }
            oldest.evicted = true;
            void oldest.process.kill(options.ctx, "SIGTERM", {
                forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
            });
        }
        pendingSessionStarts += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            pendingSessionStarts -= 1;
        };
    };

    /**
     * Forgets the oldest finished commands once too many have piled up.
     *
     * Runs whenever a command starts or ends, so a session that only ever finishes work still lets
     * go of what it is holding.
     */
    const trimFinishedSessions = () => {
        while (sessions.size > maxRetainedSessions) {
            const finished = [...sessions.values()]
                .filter((candidate) => candidate.result !== undefined)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            sessions.delete(finished.sessionId);
        }
    };

    const readSession = async (
        sessionId: number,
        readOptions: Parameters<ComputeShell["readSession"]>[1] = {},
    ): Promise<ComputeSessionSnapshot | undefined> => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        const waitMs = Math.max(0, readOptions.waitMs ?? 0);
        const peeking = readOptions.peek === true;
        if (session.result === undefined && waitMs > 0 && !readOptions.signal?.aborted) {
            if (!peeking) session.consumingWaiters += 1;
            try {
                await waitForHostSessionCompletion(
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
            !peeking,
        );
        const completionStderrDelta = session.completionStderrDelta ?? "";
        if (!peeking) {
            delete session.completionStderrDelta;
            session.stdoutOffset = processSnapshot.stdoutOffset;
            session.stderrOffset = processSnapshot.stderrOffset;
            if (session.result !== undefined) session.exitObserved = true;
        }
        const stderrDelta = `${processSnapshot.stderrDelta}${completionStderrDelta}`;
        const stderrDeltaBytes =
            (processSnapshot.stderrDeltaBytes ??
                Buffer.byteLength(processSnapshot.stderrDelta, "utf8")) +
            Buffer.byteLength(completionStderrDelta, "utf8");
        const stdoutDeltaBytes =
            processSnapshot.stdoutDeltaBytes ??
            Buffer.byteLength(processSnapshot.stdoutDelta, "utf8");
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
            stderrDelta,
            ...(processSnapshot.stderrBytes === undefined
                ? {}
                : { stderrBytes: processSnapshot.stderrBytes }),
            ...(processSnapshot.stderrOmittedBytes === undefined
                ? {}
                : { stderrOmittedBytes: processSnapshot.stderrOmittedBytes }),
            stderrDeltaBytes,
            stderrDeltaOmittedBytes: processSnapshot.stderrDeltaOmittedBytes,
            stdout: session.result?.stdout ?? processSnapshot.stdout,
            stdoutDelta: processSnapshot.stdoutDelta,
            ...(processSnapshot.stdoutBytes === undefined
                ? {}
                : { stdoutBytes: processSnapshot.stdoutBytes }),
            ...(processSnapshot.stdoutOmittedBytes === undefined
                ? {}
                : { stdoutOmittedBytes: processSnapshot.stdoutOmittedBytes }),
            stdoutDeltaBytes,
            stdoutDeltaOmittedBytes: processSnapshot.stdoutDeltaOmittedBytes,
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
            return session.process.interrupt(options.ctx);
        },
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => session.result === undefined);
            // Everything is being taken down at once, by us. Telling the model about each casualty
            // afterwards would say nothing it does not know.
            for (const session of active) session.exitObserved = true;
            await Promise.all(
                active.map((session) =>
                    session.process.kill(options.ctx, "SIGTERM", {
                        forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
                    }),
                ),
            );
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            // Whoever stopped the command is told how it ended by this very call, so claim the
            // outcome before the exit continuation can run and announce it a second time.
            session.exitObserved = true;
            await session.process.kill(options.ctx, "SIGTERM", {
                forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
            });
            // The process is gone, but this session records the outcome from a separate
            // continuation. Wait for that before reporting status, otherwise a just-killed command
            // still reads as running.
            if (session.result === undefined) {
                await waitForHostSessionCompletion(session.completionWaiters, 5_000);
            }
            // Stopping a command reports its status; it must not swallow output the model has not
            // read yet.
            return readSession(sessionId, { peek: true });
        },
        readSession,
        async run(runOptions) {
            const permissions = snapshotPermissions(runOptions.permissions);
            assertComputePermissions(permissions);
            const mode = permissions.mode;
            assertCanUseCustomShell(mode, runOptions.shell);
            assertSecretsUnsupported(runOptions.secrets);
            const cwd = runCwd(runOptions.cwd);
            const shell = runOptions.shell ?? resolveSystemShell(options.environment);
            const toolEnvironment = await createToolEnvironment(mode, options.environment, {
                cwd: options.cwd,
                ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
                ...(options.homeDirectory === undefined
                    ? {}
                    : { homeDirectory: options.homeDirectory }),
            });
            const preparedCommand = await prepareCommand(
                permissions,
                runOptions.command,
                cwd,
                shell,
            );
            const commandEnvironment = toolEnvironment;
            const processRunOptions: ProcessRunOptions = {
                command: preparedCommand.command,
                cwd: preparedCommand.processCwd ?? cwd,
                env: commandEnvironment,
                timeoutMs: runOptions.timeoutMs ?? DEFAULT_HOST_COMMAND_TIMEOUT_MS,
                maxOutputBytes: runOptions.maxOutputBytes ?? DEFAULT_HOST_MAX_OUTPUT_BYTES,
                ...(runOptions.tty === undefined ? {} : { tty: runOptions.tty }),
            };
            if (preparedCommand.args !== undefined) {
                processRunOptions.args = preparedCommand.args;
            } else if (preparedCommand.shell !== undefined) {
                processRunOptions.shell = preparedCommand.shell;
            }

            const protectedPathMonitor = await createProtectedPathMonitor(
                preparedCommand.protectedCreatePaths ?? [],
            );
            let result: ProcessRunResult;
            let cleanup: CommandCleanupResult = { protectedPathViolation: false };
            try {
                if (runOptions.signal !== undefined) processRunOptions.signal = runOptions.signal;
                result = await options.processManager.run(options.ctx, processRunOptions);
            } finally {
                cleanup = await cleanUpCommandResources(protectedPathMonitor);
            }
            const protectedPathMessage =
                cleanup.protectedPathViolation && result.exitCode === 0
                    ? "Sandbox blocked creation of a protected project path.\n"
                    : "";
            return {
                stdout: result.stdout,
                stderr: `${result.stderr}${protectedPathMessage}${cleanup.errorMessage ?? ""}`,
                ...(result.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
                ...(result.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
                ...(result.stdoutOmittedBytes === undefined
                    ? {}
                    : { stdoutOmittedBytes: result.stdoutOmittedBytes }),
                ...(result.stderrOmittedBytes === undefined
                    ? {}
                    : { stderrOmittedBytes: result.stderrOmittedBytes }),
                exitCode:
                    cleanup.errorMessage !== undefined ||
                    (cleanup.protectedPathViolation && result.exitCode === 0)
                        ? 1
                        : result.exitCode,
                timedOut: result.timedOut,
            } satisfies ComputeRunResult;
        },
        async startSession(runOptions) {
            // Validate before making room: a command that is never going to start must not cost the
            // user a running one.
            const permissions = snapshotPermissions(runOptions.permissions);
            assertComputePermissions(permissions);
            const mode = permissions.mode;
            assertCanUseCustomShell(mode, runOptions.shell);
            assertSecretsUnsupported(runOptions.secrets);
            const releaseSessionStart = reserveSessionStart();
            try {
                const cwd = runCwd(runOptions.cwd);
                const shell = runOptions.shell ?? resolveSystemShell(options.environment);
                const toolEnvironment = await createToolEnvironment(mode, options.environment, {
                    cwd: options.cwd,
                    ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
                    ...(options.homeDirectory === undefined
                        ? {}
                        : { homeDirectory: options.homeDirectory }),
                });
                const preparedCommand = await prepareCommand(
                    permissions,
                    runOptions.command,
                    cwd,
                    shell,
                );
                const commandEnvironment = toolEnvironment;
                const processStartOptions: ProcessStartOptions = {
                    command: preparedCommand.command,
                    cwd: preparedCommand.processCwd ?? cwd,
                    env: commandEnvironment,
                    maxOutputBytes: runOptions.maxOutputBytes ?? DEFAULT_HOST_MAX_OUTPUT_BYTES,
                    ...(runOptions.tty === undefined ? {} : { tty: runOptions.tty }),
                };
                if (preparedCommand.args !== undefined) {
                    processStartOptions.args = preparedCommand.args;
                } else if (preparedCommand.shell !== undefined) {
                    processStartOptions.shell = preparedCommand.shell;
                }
                const protectedPathMonitor = await createProtectedPathMonitor(
                    preparedCommand.protectedCreatePaths ?? [],
                );
                let process: ManagedProcess;
                try {
                    process = await options.processManager.start(options.ctx, processStartOptions);
                } catch (error) {
                    await cleanUpCommandResources(protectedPathMonitor);
                    throw error;
                }
                const completion = process.wait(options.ctx);
                const sessionId = nextSessionId;
                nextSessionId += 1;
                const session: HostSession = {
                    command: runOptions.command,
                    completionWaiters: new Set(),
                    consumingWaiters: 0,
                    cwd,
                    exitObserved: false,
                    process,
                    sessionId,
                    stderrOffset: 0,
                    stdoutOffset: 0,
                    timedOut: false,
                };
                // Reaching the timeout backgrounds the session; it marks it timed out and never
                // stops the command, which keeps running for the agent to come back to.
                if (runOptions.timeoutMs !== undefined) {
                    session.timeout = setTimeout(
                        () => {
                            session.timedOut = true;
                        },
                        Math.max(0, runOptions.timeoutMs),
                    );
                    session.timeout.unref();
                }
                sessions.set(sessionId, session);
                onActiveSessionCountChange?.(activeSessionCount());
                void completion.then(async (result) => {
                    if (session.timeout !== undefined) clearTimeout(session.timeout);
                    const cleanup = await cleanUpCommandResources(protectedPathMonitor);
                    const protectedPathMessage =
                        cleanup.protectedPathViolation && result.exitCode === 0
                            ? "Sandbox blocked creation of a protected project path.\n"
                            : "";
                    const completionStderrDelta = `${protectedPathMessage}${cleanup.errorMessage ?? ""}`;
                    if (completionStderrDelta !== "") {
                        session.completionStderrDelta = completionStderrDelta;
                    }
                    session.result = {
                        ...result,
                        exitCode:
                            cleanup.errorMessage !== undefined ||
                            (cleanup.protectedPathViolation && result.exitCode === 0)
                                ? 1
                                : result.exitCode,
                        stderr: `${result.stderr}${completionStderrDelta}`,
                    };
                    const awaited = session.consumingWaiters > 0;
                    for (const finish of session.completionWaiters) finish();
                    onActiveSessionCountChange?.(activeSessionCount());
                    trimFinishedSessions();
                    // Nobody was waiting on this command, so nobody is about to learn that it
                    // ended. Say so, without the output.
                    if (!awaited && !session.exitObserved) {
                        await onSessionExit?.({
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
        sessionUsesSecrets() {
            // The host compute never injects secrets, so no session is ever secret-bearing.
            return false;
        },
        supportsSessionInput: true,
        async writeSession(_permissions, sessionId, data) {
            const session = sessions.get(sessionId);
            return session?.process.writeStdin(options.ctx, data) ?? false;
        },
    };
}

interface CommandCleanupResult {
    errorMessage?: string;
    protectedPathViolation: boolean;
}

/**
 * Tears down the resources a command holds and reports whether a protected path was touched.
 *
 * Each teardown is settled independently so one failure cannot leave another resource leaked, and
 * the protected-path monitor is treated as a violation if it could not report otherwise: failing
 * closed is the safe reading when the backstop itself errored.
 */
async function cleanUpCommandResources(
    protectedPathMonitor: ProtectedPathMonitor,
): Promise<CommandCleanupResult> {
    const results = await Promise.allSettled([protectedPathMonitor.stop()]);
    const protectedPathResult = results[0]!;
    const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => (result.status === "rejected" ? result.reason : undefined));
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

function absoluteHostPaths(cwd: string, paths: readonly string[]): string[] {
    return [
        ...new Set(paths.map((path) => (isAbsolute(path) ? normalize(path) : resolve(cwd, path)))),
    ];
}

function withWorkingDirectory(command: string, cwd: string): string {
    return `cd ${quoteShellArgument(cwd)} && ${command}`;
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

function existsHostPath(cwd: string, path: string): boolean {
    return existsSync(isAbsolute(path) ? path : resolve(cwd, path));
}

function existingHostPaths(cwd: string, paths: readonly string[]): string[] {
    return absoluteHostPaths(cwd, paths).filter((path) => existsSync(path));
}

async function rejectSymlinkedPaths(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
        try {
            const metadata = await lstat(path);
            if (metadata.isSymbolicLink()) {
                throw new Error(
                    `Restricted host commands cannot protect a symbolic-link path: ${path}.`,
                );
            }
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
            throw error;
        }
    }
}

function shouldDenySensitiveReadPath(path: string, cwd: string, homeDirectory: string): boolean {
    const normalizedPath = normalize(path);
    const normalizedHome = normalize(homeDirectory);
    if (normalizedPath !== normalizedHome) return true;
    const normalizedCwd = normalize(cwd);
    // The package protects the home tree by default, but an ordinary workspace usually lives
    // below it. Masking the whole home tree in that case would also mask the workspace. Keep all
    // narrower credential paths in the policy, and only omit the broad home root for a strict
    // descendant workspace; a workspace equal to or above home remains protected.
    return !(normalizedCwd !== normalizedHome && isPathInside(normalizedHome, normalizedCwd));
}

function isPathInside(root: string, target: string): boolean {
    const relativePath = relative(root, target);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
