import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { ProcessTransport } from "../../processes/impl/startProcessTransport.js";

/**
 * How long one start may take before it is abandoned and its process tree killed. The first
 * setup of a workspace can rewrite permissions across a large folder tree.
 */
const RUNNER_START_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const FIRST_RETRY_MS = 1_000;
const RETRY_LIMIT_MS = 5 * 60 * 1000;
/** A runner that stayed up this long has proven itself; its next failure starts backoff over. */
const HEALTHY_AFTER_MS = 60_000;
const STDERR_LIMIT_BYTES = 64 * 1024;

const runnerEventSchema = Type.Union([
    Type.Object({ type: Type.Literal("ready") }),
    Type.Object({ id: Type.Integer(), pid: Type.Integer(), type: Type.Literal("spawned") }),
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
type RunnerEvent = Static<typeof runnerEventSchema>;

/** Thrown instead of starting a command while a runner that failed waits to start again. */
export class SandboxShellRunnerUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SandboxShellRunnerUnavailableError";
    }
}

export interface SandboxShellRunnerOptions {
    /** The runner's own named lifetime, derived from the root rather than from any caller. */
    ctx: Context;
    /** The native supervisor and its `--shell-runner` arguments. */
    command: string;
    args: readonly string[];
    /** The runner's own environment, used only to start the sandbox; commands bring their own. */
    environment: NodeJS.ProcessEnv;
    /** Where the runner process itself runs; never a workspace, which it would keep from deletion. */
    processCwd: string;
    /** How long the runner keeps running with no command. Defaults to five minutes. */
    idleMs?: number;
    /** Told when the runner stops for lack of work, so whoever holds it can let it go. */
    onIdleStop?: () => void;
}

export interface SandboxShellCommand {
    argv: readonly string[];
    /** The command's complete environment. */
    env: NodeJS.ProcessEnv;
    tty: boolean;
}

interface RunningCommand {
    emitError(error: Error): void;
    emitExit(code: number): void;
    emitOutput(stream: "stderr" | "stdout", chunk: Buffer): void;
}

interface LiveRunner {
    child: ChildProcessWithoutNullStreams;
    commands: Map<number, RunningCommand>;
    exited: Promise<void>;
    ready: Promise<void>;
    readyAt?: number;
    /** Stopped on purpose, when idle or disposed; its exit is not a failure. */
    stopping?: true;
}

/**
 * One long-lived sandboxed process that runs a workspace's shell commands under one policy.
 *
 * Every restricted Windows command otherwise costs a setup refresh, a sandbox logon, and a
 * private desktop. The runner pays those once. Commands run concurrently, each with its own
 * restricted token, job, and scratch folder, and each request carries the command's whole
 * environment so nothing leaks from one command to the next.
 *
 * Starting is single-flight. If the runner dies, every command it was running ends with a clear
 * error, and the next command starts a new runner after a backoff that begins at one second and
 * doubles up to five minutes, resetting once a runner has stayed up for a minute. During the
 * backoff commands are refused rather than each starting a sandbox setup of its own.
 */
export class SandboxShellRunner {
    readonly #options: SandboxShellRunnerOptions;
    readonly #idleMs: number;
    #live: LiveRunner | undefined;
    #launching: Promise<LiveRunner> | undefined;
    #idleTimer: NodeJS.Timeout | undefined;
    #nextId = 1;
    #disposed = false;
    #retryAt = 0;
    #retryDelayMs = FIRST_RETRY_MS;
    #lastFailure = "";

    constructor(options: SandboxShellRunnerOptions) {
        this.#options = options;
        this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
        options.ctx.lifetime?.addEventListener("abort", () => void this.dispose(), {
            once: true,
        });
    }

    /** Commands that have been started and have not ended. */
    get activeCount(): number {
        return this.#live?.commands.size ?? 0;
    }

    /** Starts one command and returns its transport once the runner has accepted it. */
    async start(command: SandboxShellCommand): Promise<ProcessTransport> {
        if (this.#disposed) throw new Error("The sandbox shell runner was stopped.");
        this.#clearIdle();
        let live: LiveRunner;
        try {
            live = await this.#launch();
            await live.ready;
        } catch (error) {
            this.#armIdle();
            if (error instanceof SandboxShellRunnerUnavailableError) throw error;
            throw new SandboxShellRunnerUnavailableError(errorMessage(error));
        }
        if (this.#live !== live) throw new Error(runnerStoppedMessage(""));
        return this.#open(live, command);
    }

    async dispose(): Promise<void> {
        this.#disposed = true;
        this.#clearIdle();
        await this.#launching?.catch(() => undefined);
        const live = this.#live;
        if (live === undefined) return;
        this.#stop(live);
        await live.exited;
    }

    #open(live: LiveRunner, command: SandboxShellCommand): ProcessTransport {
        const id = this.#nextId++;
        const stdout = new Set<(chunk: Buffer) => void>();
        const stderr = new Set<(chunk: Buffer) => void>();
        const exitListeners = new Set<(code: number | null, signal: null) => void>();
        const outputEndListeners = new Set<() => void>();
        const errorListeners = new Set<(error: Error) => void>();
        let ended = false;
        const finish = () => {
            ended = true;
            live.commands.delete(id);
            this.#armIdle();
        };
        live.commands.set(id, {
            emitError: (error) => {
                if (ended) return;
                finish();
                for (const listener of errorListeners) listener(error);
            },
            emitExit: (code) => {
                if (ended) return;
                finish();
                // The runner sends every byte of output before the exit.
                for (const listener of outputEndListeners) listener();
                for (const listener of exitListeners) listener(code, null);
            },
            emitOutput: (stream, chunk) => {
                for (const listener of stream === "stdout" ? stdout : stderr) listener(chunk);
            },
        });
        const send = (request: object) => {
            if (ended || live.child.stdin.destroyed) return false;
            live.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
            return true;
        };
        send({
            argv: command.argv,
            env: definedEnvironment(command.env),
            tty: command.tty,
            type: "run",
        });
        const write = (data: string | Uint8Array) =>
            send({ data: Buffer.from(data).toString("base64"), type: "stdin" });
        return {
            endInput(data) {
                if (data !== undefined) write(data);
                send({ type: "closeStdin" });
            },
            async initialize(data) {
                if (data !== undefined && !write(data)) {
                    throw new Error("Could not write trusted startup input to the command.");
                }
            },
            kind: command.tty ? "pty" : "pipe",
            onError(listener) {
                errorListeners.add(listener);
            },
            onExit(listener) {
                exitListeners.add(listener);
            },
            onOutputEnd(listener) {
                outputEndListeners.add(listener);
            },
            onStderr(listener) {
                stderr.add(listener);
            },
            onStdout(listener) {
                stdout.add(listener);
            },
            // The command runs as the sandbox account, beyond the reach of a host process kill.
            pid: null,
            release() {
                stdout.clear();
                stderr.clear();
                exitListeners.clear();
                outputEndListeners.clear();
                errorListeners.clear();
            },
            // A pseudo-console merges the two streams.
            separatesStderr: !command.tty,
            terminate() {
                send({ type: "terminate" });
            },
            write,
        };
    }

    #launch(): Promise<LiveRunner> {
        if (this.#live !== undefined) return Promise.resolve(this.#live);
        if (this.#launching !== undefined) return this.#launching;
        if (Date.now() < this.#retryAt) return Promise.reject(this.#unavailable());
        const attempt = this.#options.ctx
            .span("compute.shell_runner.start", async () => this.#spawn())
            .then((live) => {
                if (this.#disposed) {
                    this.#stop(live);
                    throw new Error("The sandbox shell runner was stopped.");
                }
                this.#live = live;
                live.ready.then(
                    () => {
                        live.readyAt = Date.now();
                    },
                    (error: unknown) => {
                        if (this.#live === live) this.#live = undefined;
                        this.#recordFailure(error);
                    },
                );
                return live;
            });
        this.#launching = attempt;
        void attempt
            .finally(() => {
                if (this.#launching === attempt) this.#launching = undefined;
            })
            .catch((error: unknown) => this.#recordFailure(error));
        return attempt;
    }

    #spawn(): LiveRunner {
        const child = spawn(this.#options.command, [...this.#options.args], {
            cwd: this.#options.processCwd,
            env: this.#options.environment,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        child.stdin.on("error", () => undefined);
        let startupError = "";
        child.stderr.on("data", (chunk: Buffer) => {
            if (startupError.length < STDERR_LIMIT_BYTES) startupError += chunk.toString("utf8");
        });
        const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        const commands = new Map<number, RunningCommand>();
        const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("The sandbox shell runner did not start in time."));
                child.kill();
            }, RUNNER_START_TIMEOUT_MS);
            timer.unref();
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            void exited.then(() => {
                clearTimeout(timer);
                reject(new Error(runnerStoppedMessage(startupError)));
            });
            createInterface({ input: child.stdout }).on("line", (line) => {
                const event = parseEvent(line);
                if (event?.type === "ready") {
                    clearTimeout(timer);
                    resolve();
                } else if (event !== undefined) {
                    receive(commands, event);
                }
            });
        });
        // Nothing waits on the outcome until a command arrives.
        ready.catch(() => undefined);
        const live: LiveRunner = { child, commands, exited, ready };
        void exited.then(() => {
            if (this.#live === live) this.#live = undefined;
            // A runner that ran a while and then died earns a quick restart; one that keeps
            // dying waits longer each time.
            if (live.readyAt !== undefined && live.stopping === undefined) {
                if (Date.now() - live.readyAt >= HEALTHY_AFTER_MS) {
                    this.#retryDelayMs = FIRST_RETRY_MS;
                }
                if (!this.#disposed)
                    this.#recordFailure(new Error(runnerStoppedMessage(startupError)));
            }
            const error = new Error(
                "The sandbox shell runner stopped, so this command was stopped too.",
            );
            // Each command removes itself as it ends; a Map allows that while iterating.
            for (const command of commands.values()) command.emitError(error);
            this.#clearIdle();
        });
        return live;
    }

    #stop(live: LiveRunner): void {
        if (this.#live === live) this.#live = undefined;
        live.stopping = true;
        // Closing stdin stops every command the runner is running, and then the runner.
        live.child.stdin.end();
    }

    #recordFailure(error: unknown): void {
        this.#lastFailure = errorMessage(error);
        this.#retryAt = Date.now() + this.#retryDelayMs;
        this.#retryDelayMs = Math.min(RETRY_LIMIT_MS, this.#retryDelayMs * 2);
    }

    #unavailable(): SandboxShellRunnerUnavailableError {
        const seconds = Math.max(1, Math.ceil((this.#retryAt - Date.now()) / 1000));
        const wait =
            seconds < 60
                ? `${String(seconds)} second${seconds === 1 ? "" : "s"}`
                : `${String(Math.ceil(seconds / 60))} minutes`;
        return new SandboxShellRunnerUnavailableError(
            `The sandbox for this workspace could not start, so it will try again in about ${wait}. ${this.#lastFailure}`.trim(),
        );
    }

    #armIdle(): void {
        this.#clearIdle();
        const live = this.#live;
        if (this.#disposed || live === undefined || live.commands.size > 0) return;
        this.#idleTimer = setTimeout(() => {
            if (this.#live !== live || live.commands.size > 0) return;
            this.#stop(live);
            this.#options.onIdleStop?.();
        }, this.#idleMs);
        this.#idleTimer.unref();
    }

    #clearIdle(): void {
        if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
        this.#idleTimer = undefined;
    }
}

function receive(commands: Map<number, RunningCommand>, event: RunnerEvent): void {
    if (event.type === "ready" || event.type === "protocolError" || event.type === "spawned") {
        return;
    }
    const command = commands.get(event.id);
    if (command === undefined) return;
    if (event.type === "stdout" || event.type === "stderr") {
        command.emitOutput(event.type, Buffer.from(event.data, "base64"));
    } else if (event.type === "exit") {
        command.emitExit(event.code);
    } else {
        command.emitError(new Error(event.message));
    }
}

function parseEvent(line: string): RunnerEvent | undefined {
    try {
        const value: unknown = JSON.parse(line);
        return Value.Check(runnerEventSchema, value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
    const defined: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value;
    return defined;
}

function runnerStoppedMessage(stderr: string): string {
    const detail = stderr.trim();
    return detail.length === 0
        ? "The sandbox shell runner stopped."
        : `The sandbox shell runner stopped: ${detail}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
