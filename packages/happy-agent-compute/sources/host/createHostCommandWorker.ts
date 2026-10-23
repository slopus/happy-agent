import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { resolveSupervisorBinary } from "@slopus/happy-agent-supervisor";

import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import { assertComputePermissions, type ComputePermissions } from "../ComputePermissions.js";
import { createToolEnvironment } from "../sandbox/impl/createToolEnvironment.js";
import { resolvePotentialPath } from "../sandbox/impl/resolvePotentialPath.js";
import { createSupervisorPolicy, createSupervisorWorkerCommand } from "../supervisor/index.js";
import {
    defaultHomeDirectory,
    resolveHostDeniedReadPaths,
} from "./impl/resolveHostDeniedReadPaths.js";

/**
 * How long one start may take before it is abandoned and its whole process tree killed.
 *
 * Generous on purpose: the first setup of a workspace can rewrite permissions across a large
 * folder tree, and abandoning that work only means the next attempt starts it again.
 */
const WORKER_START_TIMEOUT_MS = 10 * 60 * 1000;
/** How long one command waits for a worker that is still starting, before it is turned away. */
const READY_WAIT_MS = 30_000;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const RETRY_START_MS = 60_000;
const RETRY_LIMIT_MS = 30 * 60 * 1000;
const STDERR_LIMIT_BYTES = 64 * 1024;

/**
 * Thrown instead of running a command while a worker that failed to start waits to try again,
 * or while a start is still under way. No process is started for a refused command.
 */
export class HostCommandWorkerUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HostCommandWorkerUnavailableError";
    }
}

export interface HostCommandWorkerOptions {
    /** The lifetime that owns the worker process; aborting it stops the worker. */
    ctx: Context;
    /** The workspace every command reads, and the only one the worker's sandbox is prepared for. */
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    hostPolicy?: ComputeHostPolicy;
    /** How long the worker keeps running with nothing to do. Defaults to five minutes. */
    idleMs?: number;
    /**
     * Asked whenever the idle time runs out; `true` keeps the worker for another idle period.
     * It never starts a stopped worker, so it can name every workspace still in use.
     */
    keepAlive?: () => boolean;
    /** Read-only permissions; a worker never runs anything that can write. */
    permissions: ComputePermissions;
    /** A development build of the native supervisor. Defaults to the installed one. */
    supervisorPath?: string;
}

export interface HostCommandWorkerRun {
    /** The program and its arguments, run directly without a shell. */
    argv: readonly string[];
    maxOutputBytes: number;
    signal?: AbortSignal;
    timeoutMs: number;
}

export interface HostCommandWorkerResult {
    exitCode: number;
    stderr: string;
    stdout: Buffer;
    timedOut: boolean;
    /** Output exceeded `maxOutputBytes`; the command was stopped and `stdout` holds the prefix. */
    truncated: boolean;
}

export interface HostCommandWorker {
    dispose(): Promise<void>;
    run(options: HostCommandWorkerRun): Promise<HostCommandWorkerResult>;
    /**
     * Starts the worker in the background if it is not running, and restarts its idle time.
     *
     * For work that is about to need it, such as an agent run beginning in the workspace. It
     * never waits and never throws; a worker waiting to retry a failed start stays waiting.
     */
    warm(): void;
}

const workerEventSchema = Type.Union([
    Type.Object({ type: Type.Literal("ready") }),
    Type.Object({ data: Type.String(), id: Type.Integer(), type: Type.Literal("stdout") }),
    Type.Object({ data: Type.String(), id: Type.Integer(), type: Type.Literal("stderr") }),
    Type.Object({
        code: Type.Integer(),
        id: Type.Integer(),
        timedOut: Type.Boolean(),
        type: Type.Literal("exit"),
    }),
    Type.Object({ id: Type.Integer(), message: Type.String(), type: Type.Literal("error") }),
    Type.Object({ message: Type.String(), type: Type.Literal("protocolError") }),
]);
type WorkerEvent = Static<typeof workerEventSchema>;

interface ActiveRun {
    id: number;
    maxOutputBytes: number;
    reject(error: Error): void;
    resolve(result: HostCommandWorkerResult): void;
    stderr: Buffer[];
    stderrBytes: number;
    stdout: Buffer[];
    stdoutBytes: number;
    truncated: boolean;
}

interface RunningWorker {
    child: ChildProcessWithoutNullStreams;
    exited: Promise<void>;
    ready: Promise<void>;
}

/**
 * One sandboxed process that runs a workspace's read-only commands one at a time.
 *
 * On Windows every restricted command otherwise costs a sandbox logon, a private desktop, an ACL
 * refresh, and a scratch directory, which is seconds of work and visible system load when a Git
 * tracker runs thousands of short commands a day. The worker pays those once, under the same
 * read-only policy every restricted host command receives, and runs each command with its own
 * restricted token and job. It starts on first use or `warm`, and stops when idle.
 *
 * Starting is single-flight: there is never more than one start under way. A start that fails or
 * times out has its whole process tree killed, and the next one waits one minute, doubling up to
 * thirty, while commands are refused with a human-readable `HostCommandWorkerUnavailableError`.
 * Without that, a sandbox setup that cannot finish would be started again for every command.
 */
export function createHostCommandWorker(options: HostCommandWorkerOptions): HostCommandWorker {
    if (process.platform !== "win32") {
        throw new Error("A sandboxed command worker is only available on Windows.");
    }
    assertComputePermissions(options.permissions);
    if (options.permissions.mode !== "read_only" || options.permissions.network.egress) {
        throw new Error("A sandboxed command worker runs only read-only commands without network.");
    }
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    let worker: RunningWorker | undefined;
    let launching: Promise<RunningWorker> | undefined;
    let active: ActiveRun | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    let idleTimer: NodeJS.Timeout | undefined;
    let nextId = 1;
    let disposed = false;
    let retryAt = 0;
    let retryDelayMs = RETRY_START_MS;
    let lastFailure = "";

    const stop = (running: RunningWorker) => {
        if (worker === running) worker = undefined;
        // Closing stdin ends the worker's current command and then the worker itself.
        running.child.stdin.end();
    };
    const dispose = async () => {
        disposed = true;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        await launching?.catch(() => undefined);
        const running = worker;
        if (running === undefined) return;
        stop(running);
        await running.exited;
    };
    const armIdle = (running: RunningWorker) => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = undefined;
        if (disposed || worker !== running || active !== undefined) return;
        idleTimer = setTimeout(() => {
            if (options.keepAlive?.() === true) armIdle(running);
            else stop(running);
        }, idleMs);
        idleTimer.unref();
    };
    const recordFailure = (error: unknown) => {
        lastFailure = error instanceof Error ? error.message : String(error);
        retryAt = Date.now() + retryDelayMs;
        retryDelayMs = Math.min(RETRY_LIMIT_MS, retryDelayMs * 2);
    };
    const unavailable = () => {
        const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000));
        return new HostCommandWorkerUnavailableError(
            `The sandbox for this workspace could not start, so it will try again in about ` +
                `${String(minutes)} minute${minutes === 1 ? "" : "s"}. ${lastFailure}`.trim(),
        );
    };
    /** The running or starting worker, starting one only when none is and no retry is pending. */
    const launch = (): Promise<RunningWorker> => {
        if (worker !== undefined) return Promise.resolve(worker);
        if (launching !== undefined) return launching;
        if (Date.now() < retryAt) return Promise.reject(unavailable());
        const attempt = start().then(
            (running) => {
                if (disposed) {
                    running.child.kill();
                    throw new Error("The sandboxed command worker was stopped.");
                }
                worker = running;
                running.ready.then(
                    () => {
                        retryDelayMs = RETRY_START_MS;
                        retryAt = 0;
                        armIdle(running);
                    },
                    (error: unknown) => {
                        if (worker === running) worker = undefined;
                        recordFailure(error);
                    },
                );
                return running;
            },
            (error: unknown) => {
                recordFailure(error);
                throw error;
            },
        );
        launching = attempt;
        void attempt
            .finally(() => {
                if (launching === attempt) launching = undefined;
            })
            .catch(() => undefined);
        return attempt;
    };
    /** Waits a bounded time for a start, never abandoning the start itself. */
    const whenReady = async (running: RunningWorker) => {
        let timer: NodeJS.Timeout | undefined;
        const waited = new Promise<"waiting">((resolve) => {
            timer = setTimeout(() => resolve("waiting"), READY_WAIT_MS);
            timer.unref();
        });
        try {
            const outcome = await Promise.race([
                running.ready.then(() => "ready" as const),
                waited,
            ]);
            if (outcome === "waiting") {
                throw new HostCommandWorkerUnavailableError(
                    "The sandbox for this workspace is still starting.",
                );
            }
        } catch (error) {
            if (error instanceof HostCommandWorkerUnavailableError) throw error;
            throw unavailable();
        } finally {
            clearTimeout(timer);
        }
    };
    options.ctx.lifetime?.addEventListener("abort", () => void dispose(), { once: true });

    const start = async (): Promise<RunningWorker> => {
        const canonicalCwd = await resolvePotentialPath(options.cwd);
        const { privatePaths, sensitiveReadPaths } = resolveHostDeniedReadPaths({
            canonicalCwd,
            canonicalHome: await resolvePotentialPath(defaultHomeDirectory(options.homeDirectory)),
            environment: options.environment,
            homeDirectory: options.homeDirectory,
            hostPolicy: options.hostPolicy,
        });
        const policy = createSupervisorPolicy({
            cwd: canonicalCwd,
            permissions: options.permissions,
            deniedReadPaths: [
                ...(options.permissions.deniedReadPaths ?? []),
                ...privatePaths,
                ...sensitiveReadPaths,
            ],
        });
        const command = createSupervisorWorkerCommand({
            cwd: canonicalCwd,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            policy,
            supervisorPath: resolveSupervisorBinary(options.supervisorPath),
        });
        const environment = await createToolEnvironment("read_only", options.environment, {
            cwd: options.cwd,
            ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
        });
        const child = spawn(command.command, command.args, {
            // The worker names the workspace with `--cwd`. Its own working directory stays
            // elsewhere, because Windows refuses to delete a folder a live process works in.
            cwd: dirname(command.command),
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        let startupError = "";
        child.stderr.on("data", (chunk: Buffer) => {
            if (startupError.length < STDERR_LIMIT_BYTES) startupError += chunk.toString("utf8");
        });
        const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("The sandboxed command worker did not start in time."));
                child.kill();
            }, WORKER_START_TIMEOUT_MS);
            timer.unref();
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            void exited.then(() => {
                clearTimeout(timer);
                reject(new Error(workerStoppedMessage(startupError)));
            });
            createInterface({ input: child.stdout }).on("line", (line) => {
                const event = parseEvent(line);
                if (event?.type === "ready") {
                    clearTimeout(timer);
                    resolve();
                } else if (event !== undefined) {
                    receive(event);
                }
            });
        });
        const running: RunningWorker = { child, exited, ready };
        void exited.then(() => {
            if (worker === running) worker = undefined;
            active?.reject(new Error(workerStoppedMessage(startupError)));
            active = undefined;
        });
        return running;
    };

    const receive = (event: WorkerEvent) => {
        const run = active;
        if (event.type === "ready" || event.type === "protocolError") return;
        if (run === undefined || event.id !== run.id) return;
        if (event.type === "stdout") {
            if (run.truncated) return;
            const chunk = Buffer.from(event.data, "base64");
            run.stdout.push(chunk);
            run.stdoutBytes += chunk.byteLength;
            if (run.stdoutBytes > run.maxOutputBytes) {
                run.truncated = true;
                write({ id: run.id, type: "terminate" });
            }
        } else if (event.type === "stderr") {
            const chunk = Buffer.from(event.data, "base64");
            if (run.stderrBytes < STDERR_LIMIT_BYTES) run.stderr.push(chunk);
            run.stderrBytes += chunk.byteLength;
        } else if (event.type === "exit") {
            active = undefined;
            run.resolve({
                exitCode: event.code,
                stderr: Buffer.concat(run.stderr).toString("utf8").slice(0, STDERR_LIMIT_BYTES),
                stdout: Buffer.concat(run.stdout).subarray(0, run.maxOutputBytes),
                timedOut: event.timedOut,
                truncated: run.truncated,
            });
        } else {
            active = undefined;
            run.reject(new Error(event.message));
        }
    };

    const write = (request: object) => {
        worker?.child.stdin.write(`${JSON.stringify(request)}\n`);
    };

    const runNow = async (request: HostCommandWorkerRun): Promise<HostCommandWorkerResult> => {
        request.signal?.throwIfAborted();
        if (disposed) throw new Error("The sandboxed command worker was stopped.");
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        const running = await launch();
        await whenReady(running);
        if (worker !== running) throw new Error(workerStoppedMessage(""));
        const id = nextId++;
        const result = new Promise<HostCommandWorkerResult>((resolve, reject) => {
            active = {
                id,
                maxOutputBytes: request.maxOutputBytes,
                reject,
                resolve,
                stderr: [],
                stderrBytes: 0,
                stdout: [],
                stdoutBytes: 0,
                truncated: false,
            };
        });
        const abort = () => write({ id, type: "terminate" });
        request.signal?.addEventListener("abort", abort, { once: true });
        write({ argv: request.argv, id, timeoutMs: request.timeoutMs, type: "run" });
        try {
            const outcome = await result;
            request.signal?.throwIfAborted();
            return outcome;
        } finally {
            request.signal?.removeEventListener("abort", abort);
            armIdle(running);
        }
    };

    return {
        dispose,
        warm() {
            if (disposed) return;
            if (worker !== undefined) {
                armIdle(worker);
                return;
            }
            void launch().catch(() => undefined);
        },
        run(request) {
            // The worker runs one command at a time; later callers wait their turn.
            const next = queue.then(
                () => runNow(request),
                () => runNow(request),
            );
            queue = next.catch(() => undefined);
            return next;
        },
    };
}

function parseEvent(line: string): WorkerEvent | undefined {
    try {
        const value: unknown = JSON.parse(line);
        return Value.Check(workerEventSchema, value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function workerStoppedMessage(stderr: string): string {
    const detail = stderr.trim();
    return detail.length === 0
        ? "The sandboxed command worker stopped."
        : `The sandboxed command worker stopped: ${detail}`;
}
