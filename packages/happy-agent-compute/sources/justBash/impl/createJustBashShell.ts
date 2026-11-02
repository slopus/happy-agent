import { Buffer } from "node:buffer";

import { Bash, type IFileSystem, type NetworkConfig } from "just-bash";

import type { ComputeHostPolicy } from "../../ComputeHostPolicy.js";
import { assertComputePermissions, type ComputePermissions } from "../../ComputePermissions.js";
import type {
    ComputeRunOptions,
    ComputeRunResult,
    ComputeSessionExit,
    ComputeSessionSnapshot,
    ComputeShell,
} from "../../ComputeShell.js";
import { JustBashPermissionFileSystem } from "./JustBashPermissionFileSystem.js";

const MAX_ACTIVE_SESSIONS = 64;
const MAX_RETAINED_SESSIONS = 64;

interface JustBashSession {
    readonly command: string;
    completion: Promise<ComputeRunResult>;
    consumingWaiters: number;
    readonly controller: AbortController;
    readonly cwd: string;
    evicted: boolean;
    exitObserved: boolean;
    killed: boolean;
    readonly maxOutputBytes: number | undefined;
    result: ComputeRunResult | undefined;
    readonly sessionId: number;
    stderrOffset: number;
    stdoutOffset: number;
    timedOut: boolean;
    timeout: ReturnType<typeof setTimeout> | undefined;
}

/** The session manager around just-bash's cooperative, result-at-completion execution API. */
export function createJustBashShell(
    fileSystem: IFileSystem,
    cwd: string,
    home: string,
    hostPolicy: ComputeHostPolicy = {},
): ComputeShell {
    const sessions = new Map<number, JustBashSession>();
    let nextSessionId = 1;
    let activeSessionCountListener: ((count: number) => void) | undefined;
    let sessionExitListener: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;

    const activeSessions = () =>
        [...sessions.values()]
            .filter((session) => session.result === undefined && !session.evicted)
            .sort((left, right) => left.sessionId - right.sessionId);
    const notifyActiveSessionCount = () => {
        activeSessionCountListener?.(activeSessions().length);
    };
    const readSession = async (
        sessionId: number,
        options: Parameters<ComputeShell["readSession"]>[1] = {},
    ): Promise<ComputeSessionSnapshot | undefined> => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;

        const peeking = options.peek === true;
        const waitMs = Math.max(0, options.waitMs ?? 0);
        if (session.result === undefined && waitMs > 0 && !options.signal?.aborted) {
            if (!peeking) session.consumingWaiters += 1;
            try {
                await waitForCompletion(session.completion, waitMs, options.signal);
            } finally {
                if (!peeking) session.consumingWaiters -= 1;
            }
        }

        const result = session.result;
        const stdout = result?.stdout ?? "";
        const stderr = result?.stderr ?? "";
        const stdoutDelta = stdout.slice(session.stdoutOffset);
        const stderrDelta = stderr.slice(session.stderrOffset);
        const stdoutWasUnread = session.stdoutOffset === 0;
        const stderrWasUnread = session.stderrOffset === 0;
        if (!peeking) {
            session.stdoutOffset = stdout.length;
            session.stderrOffset = stderr.length;
            if (result !== undefined) session.exitObserved = true;
        }

        return {
            command: session.command,
            cwd: session.cwd,
            exitCode: result?.exitCode ?? null,
            sessionId,
            status: result === undefined ? "running" : session.killed ? "killed" : "completed",
            stderr,
            stderrDelta,
            stderrDeltaBytes:
                result !== undefined && stderrWasUnread
                    ? (result.stderrBytes ?? Buffer.byteLength(stderrDelta))
                    : Buffer.byteLength(stderrDelta),
            stderrDeltaOmittedBytes:
                result !== undefined && stderrWasUnread ? (result.stderrOmittedBytes ?? 0) : 0,
            ...(result?.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
            ...(result?.stderrOmittedBytes === undefined
                ? {}
                : { stderrOmittedBytes: result.stderrOmittedBytes }),
            stdout,
            stdoutDelta,
            stdoutDeltaBytes:
                result !== undefined && stdoutWasUnread
                    ? (result.stdoutBytes ?? Buffer.byteLength(stdoutDelta))
                    : Buffer.byteLength(stdoutDelta),
            stdoutDeltaOmittedBytes:
                result !== undefined && stdoutWasUnread ? (result.stdoutOmittedBytes ?? 0) : 0,
            ...(result?.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
            ...(result?.stdoutOmittedBytes === undefined
                ? {}
                : { stdoutOmittedBytes: result.stdoutOmittedBytes }),
            timedOut: session.timedOut,
        };
    };

    const shell: ComputeShell = {
        activeSessionCount: () => activeSessions().length,
        activeSessions: () =>
            activeSessions().map((session) => ({
                command: session.command,
                cwd: session.cwd,
                sessionId: session.sessionId,
                status: "running" as const,
            })),
        cwd,
        async killAllSessions() {
            const active = activeSessions();
            for (const session of active) {
                session.exitObserved = true;
                session.killed = true;
                session.controller.abort();
            }
            await Promise.all(active.map((session) => session.completion));
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            session.exitObserved = true;
            if (session.result === undefined) {
                session.killed = true;
                session.controller.abort();
                await session.completion;
            }
            return await readSession(sessionId, { peek: true });
        },
        readSession,
        async run(options) {
            assertSupportedOptions(options);
            const controller = new AbortController();
            let timedOut = false;
            const abort = () => controller.abort();
            options.signal?.addEventListener("abort", abort, { once: true });
            const timeout =
                options.timeoutMs === undefined
                    ? undefined
                    : setTimeout(
                          () => {
                              timedOut = true;
                              controller.abort();
                          },
                          Math.max(0, options.timeoutMs),
                      );
            try {
                return await execute(
                    createPermissionBash(fileSystem, cwd, home, options.permissions, hostPolicy),
                    options.command,
                    resolveCwd(fileSystem, cwd, options.cwd),
                    controller.signal,
                    options.maxOutputBytes,
                    () => timedOut,
                );
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
                options.signal?.removeEventListener("abort", abort);
            }
        },
        sessionUsesSecrets: () => false,
        setActiveSessionCountListener(listener) {
            activeSessionCountListener = listener;
            listener?.(activeSessions().length);
        },
        setSessionExitListener(listener) {
            sessionExitListener = listener;
        },
        async startSession(options) {
            assertSupportedOptions(options);
            while (activeSessions().length >= MAX_ACTIVE_SESSIONS) {
                const oldest = activeSessions()[0];
                if (oldest === undefined) break;
                oldest.evicted = true;
                oldest.killed = true;
                oldest.controller.abort();
            }

            const sessionId = nextSessionId;
            nextSessionId += 1;
            const controller = new AbortController();
            const session: JustBashSession = {
                command: options.command,
                completion: Promise.resolve(emptyResult()),
                consumingWaiters: 0,
                controller,
                cwd: resolveCwd(fileSystem, cwd, options.cwd),
                evicted: false,
                exitObserved: false,
                killed: false,
                maxOutputBytes: options.maxOutputBytes,
                result: undefined,
                sessionId,
                stderrOffset: 0,
                stdoutOffset: 0,
                timedOut: false,
                timeout: undefined,
            };
            const completion = execute(
                createPermissionBash(fileSystem, cwd, home, options.permissions, hostPolicy),
                session.command,
                session.cwd,
                controller.signal,
                session.maxOutputBytes,
                () => session.timedOut,
            );
            session.completion = completion;
            sessions.set(sessionId, session);
            notifyActiveSessionCount();

            if (options.timeoutMs !== undefined) {
                session.timeout = setTimeout(
                    () => {
                        // A timeout backgrounds a session; it never stops the command.
                        session.timedOut = true;
                    },
                    Math.max(0, options.timeoutMs),
                );
            }

            void completion.then(async (result) => {
                session.result = result;
                if (session.timeout !== undefined) clearTimeout(session.timeout);
                const awaited = session.consumingWaiters > 0;
                notifyActiveSessionCount();
                trimCompletedSessions(sessions);
                if (!awaited && !session.exitObserved) {
                    await sessionExitListener?.({
                        command: session.command,
                        exitCode: result.exitCode,
                        sessionId,
                        status: session.killed || result.exitCode === null ? "killed" : "completed",
                    });
                }
            });
            trimCompletedSessions(sessions);
            return sessionId;
        },
        supportsSessionInput: false,
        async writeSession(_permissions, _sessionId, _data) {
            return false;
        },
    };

    return shell;
}

function assertSupportedOptions(options: ComputeRunOptions): void {
    if (options.secrets !== undefined && options.secrets.length > 0) {
        throw new Error("The just-bash backend cannot inject secret bundles.");
    }
    if (options.environment !== undefined && Object.keys(options.environment).length > 0) {
        throw new Error("The just-bash backend cannot give a command its own environment.");
    }
    if (options.shell !== undefined) {
        throw new Error("The just-bash backend cannot select a custom shell.");
    }
    if (options.tty === true) {
        throw new Error("The just-bash backend does not support pseudo-terminals.");
    }
}

async function execute(
    bash: Bash,
    command: string,
    cwd: string,
    signal: AbortSignal,
    maxOutputBytes: number | undefined,
    timedOut: () => boolean,
): Promise<ComputeRunResult> {
    try {
        const result = await bash.exec(command, { cwd, signal });
        return toRunResult(result, maxOutputBytes, timedOut());
    } catch (error) {
        return toRunResult(
            {
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: null,
            },
            maxOutputBytes,
            timedOut(),
        );
    }
}

function toRunResult(
    result: { stdout: string; stderr: string; exitCode: number | null },
    maxOutputBytes: number | undefined,
    timedOut: boolean,
): ComputeRunResult {
    const stdout = capOutput(result.stdout, maxOutputBytes);
    const stderr = capOutput(result.stderr, maxOutputBytes);
    return {
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutOmittedBytes: stdout.omittedBytes,
        stderrOmittedBytes: stderr.omittedBytes,
        exitCode: result.exitCode,
        timedOut,
    };
}

function capOutput(
    value: string,
    maxOutputBytes: number | undefined,
): { text: string; totalBytes: number; omittedBytes: number } {
    const bytes = Buffer.from(value);
    const totalBytes = bytes.byteLength;
    if (maxOutputBytes === undefined || totalBytes <= maxOutputBytes) {
        return { text: value, totalBytes, omittedBytes: 0 };
    }

    const limit = Math.max(0, maxOutputBytes);
    const head = bytes.subarray(0, utf8PrefixWithinBudget(bytes, Math.floor(limit / 2)));
    const tail = bytes.subarray(utf8SuffixWithinBudget(bytes, limit - Math.floor(limit / 2)));
    const omittedBytes = totalBytes - head.byteLength - tail.byteLength;
    const marker = `... ${String(omittedBytes)} bytes omitted ...`;
    const parts = [head.toString(), marker, tail.toString()].filter((part) => part.length > 0);
    return { text: parts.join("\n"), totalBytes, omittedBytes };
}

function utf8PrefixWithinBudget(bytes: Buffer, budget: number): number {
    let length = Math.min(bytes.byteLength, budget);
    if (length === bytes.byteLength) return length;
    while (length > 0 && (bytes[length]! & 0xc0) === 0x80) length -= 1;
    return length;
}

function utf8SuffixWithinBudget(bytes: Buffer, budget: number): number {
    let start = Math.max(0, bytes.byteLength - budget);
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
    return start;
}

function resolveCwd(
    fileSystem: IFileSystem,
    defaultCwd: string,
    requested: string | undefined,
): string {
    return requested === undefined ? defaultCwd : fileSystem.resolvePath(defaultCwd, requested);
}

function createPermissionBash(
    fileSystem: IFileSystem,
    cwd: string,
    home: string,
    permissions: ComputePermissions,
    hostPolicy: ComputeHostPolicy,
): Bash {
    assertComputePermissions(permissions);
    const network = toJustBashNetworkConfig(permissions);
    return new Bash({
        cwd,
        env: { HOME: home },
        fs: new JustBashPermissionFileSystem(fileSystem, cwd, permissions, hostPolicy),
        ...(network === undefined ? {} : { network }),
    });
}

function toJustBashNetworkConfig(permissions: ComputePermissions): NetworkConfig | undefined {
    if (!permissions.network.egress) return undefined;
    const allowedHosts = permissions.network.allowedHosts ?? [];
    if (allowedHosts.length === 0) {
        return { dangerouslyAllowFullInternetAccess: true };
    }
    return {
        allowedMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedUrlPrefixes: allowedHosts.flatMap((host) => [`http://${host}`, `https://${host}`]),
    };
}

function emptyResult(): ComputeRunResult {
    return {
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
    };
}

async function waitForCompletion(
    completion: Promise<unknown>,
    waitMs: number,
    signal: AbortSignal | undefined,
): Promise<void> {
    await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        timer = setTimeout(finish, waitMs);
        signal?.addEventListener("abort", finish, { once: true });
        void completion.then(finish);
        if (signal?.aborted === true) finish();
    });
}

function trimCompletedSessions(sessions: Map<number, JustBashSession>): void {
    while (sessions.size > MAX_RETAINED_SESSIONS) {
        const oldestCompleted = [...sessions.values()]
            .filter((session) => session.result !== undefined)
            .sort((left, right) => left.sessionId - right.sessionId)[0];
        if (oldestCompleted === undefined) return;
        sessions.delete(oldestCompleted.sessionId);
    }
}
