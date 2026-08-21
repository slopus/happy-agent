import { randomUUID } from "node:crypto";

import type { Context } from "@steve.kite/stdlib";

import { killProcessTree } from "./killProcessTree.js";
import { isProcessGroupAlive, killProcessGroup, ProcessGroupReaper } from "./ProcessGroupReaper.js";
import { startProcessTransport, type ProcessTransport } from "./startProcessTransport.js";
import { BoundedOutputBuffer } from "./BoundedOutputBuffer.js";
import { withProcessContext } from "../observability/index.js";
import type {
    ManagedProcessStatus,
    ProcessKillOptions,
    ProcessRunOptions,
    ProcessRunResult,
    ProcessSnapshot,
    ProcessStartOptions,
} from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 512_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const EXIT_STDIO_IDLE_GRACE_MS = 100;

export class NativeProcessManager {
    readonly #processes = new Map<string, ManagedProcess>();
    readonly #groups = new ProcessGroupReaper();

    async start(ctx: Context, options: ProcessStartOptions): Promise<ManagedProcess> {
        const process = await ManagedProcess.start(ctx, options, {
            onGroupTerminated: (processGroupId) => {
                this.#groups.release(processGroupId);
            },
            onSettled: (id) => {
                this.#processes.delete(id);
            },
        });
        this.#processes.set(process.id, process);
        if (process.pid !== null) this.#groups.retain(process.pid);
        return process;
    }

    run(ctx: Context, options: ProcessRunOptions): Promise<ProcessRunResult> {
        return ctx.span("happy.terminal.process.run", async (ctx) => {
            if (options.signal?.aborted) {
                return abortedResult(options);
            }

            const process = await this.start(ctx, options);
            let timedOut = false;
            let aborted = false;
            let timeout: NodeJS.Timeout | undefined;

            const kill = () => {
                void process.kill(ctx, "SIGTERM", {
                    forceAfterMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
                });
            };
            const onAbort = () => {
                aborted = true;
                kill();
            };

            if (options.timeoutMs !== undefined) {
                timeout = setTimeout(() => {
                    timedOut = true;
                    kill();
                }, options.timeoutMs);
                timeout.unref();
            }
            options.signal?.addEventListener("abort", onAbort, { once: true });
            // Spawning crosses an asynchronous tracing boundary. Cancellation may arrive while
            // that span is being opened, before the listener above can be installed.
            if (options.signal?.aborted === true) onAbort();

            try {
                const result = await process.wait(ctx);
                return {
                    ...result,
                    timedOut,
                    aborted,
                    killed: result.killed || timedOut || aborted,
                };
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
                options.signal?.removeEventListener("abort", onAbort);
            }
        });
    }

    get(id: string): ManagedProcess | undefined {
        return this.#processes.get(id);
    }

    snapshots(): ProcessSnapshot[] {
        return [...this.#processes.values()].map((process) => process.snapshot());
    }

    activeCount(): number {
        return this.#processes.size;
    }

    async writeStdin(ctx: Context, id: string, data: string | Uint8Array): Promise<boolean> {
        const process = this.get(id);
        if (!process) return false;
        return process.writeStdin(ctx, data);
    }

    async kill(ctx: Context, id: string, options: ProcessKillOptions = {}): Promise<boolean> {
        const process = this.get(id);
        if (!process) return false;
        await process.kill(ctx, "SIGTERM", options);
        return true;
    }

    /**
     * Stops running work.
     *
     * Detached work — a command the agent deliberately left running in the
     * background — is spared unless the caller is shutting everything down, in
     * which case whole process groups go too, including anything that outlived
     * the shell that launched it.
     */
    async killAll(ctx: Context, options: ProcessKillOptions = {}): Promise<void> {
        const targets = [...this.#processes.values()].filter(
            (process) => options.includeDetached === true || !process.detached,
        );
        await Promise.all(targets.map((process) => process.kill(ctx, "SIGTERM", options)));
        if (options.includeDetached === true) {
            await this.#groups.terminateAll(ctx, options.forceAfterMs ?? DEFAULT_KILL_GRACE_MS);
        }
    }

    /** Process groups that a shutdown would still have to take down. */
    pendingProcessGroups(): readonly number[] {
        return this.#groups.pending();
    }

    /**
     * How much running work a shutdown would still find.
     *
     * A live command and the group it leads are one thing, so the group of an
     * active process is not counted twice. What this adds are the groups that
     * outlived the command that started them: `nohup server &` leaves nothing
     * running under our watch, but the server is very much still there.
     */
    reapableCount(): number {
        const led = new Set(
            [...this.#processes.values()].flatMap((process) =>
                process.pid === null ? [] : [process.pid],
            ),
        );
        const orphaned = this.#groups
            .pending()
            .filter((processGroupId) => !led.has(processGroupId)).length;
        return this.activeCount() + orphaned;
    }
}

export interface ManagedProcessHooks {
    /** The whole process group is known to be gone. */
    onGroupTerminated: (processGroupId: number) => void;
    /** No more output or exit information can arrive. */
    onSettled: (id: string) => void;
}

export class ManagedProcess {
    readonly id = randomUUID();
    readonly command: string;
    readonly cwd: string;
    readonly pid: number | null;

    /** The agent left this running on purpose; an interrupted turn spares it. */
    detached = false;

    readonly #transport: ProcessTransport;
    readonly #maxOutputBytes: number;
    readonly #hooks: ManagedProcessHooks;
    readonly #waitPromise: Promise<ProcessRunResult>;
    #resolveWait!: (result: ProcessRunResult) => void;
    readonly #stdout: BoundedOutputBuffer;
    readonly #stderr: BoundedOutputBuffer;
    #stdoutUnread: BoundedOutputBuffer;
    #stderrUnread: BoundedOutputBuffer;
    #stdoutBytes = 0;
    #stderrBytes = 0;
    #status: ManagedProcessStatus = "running";
    #exitCode: number | null = null;
    #exitSignal: NodeJS.Signals | null = null;
    #stdoutEnded = false;
    #stderrEnded = false;
    #settled = false;
    #killed = false;
    #postExitTimer: NodeJS.Timeout | undefined;

    private constructor(
        _ctx: Context,
        options: ProcessStartOptions,
        hooks: ManagedProcessHooks,
        transport: ProcessTransport,
    ) {
        this.command = options.command;
        this.cwd = options.cwd;
        this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        this.#stdout = new BoundedOutputBuffer(this.#maxOutputBytes);
        this.#stderr = new BoundedOutputBuffer(this.#maxOutputBytes);
        this.#stdoutUnread = new BoundedOutputBuffer(this.#maxOutputBytes);
        this.#stderrUnread = new BoundedOutputBuffer(this.#maxOutputBytes);
        this.#hooks = hooks;
        this.#waitPromise = new Promise((resolve) => {
            this.#resolveWait = resolve;
        });

        this.#transport = transport;
        // A terminal merges the two streams, so nothing will ever arrive on
        // stderr and waiting for it to close would hang.
        this.#stderrEnded = !this.#transport.separatesStderr;
        this.pid = this.#transport.pid;
        this.#attachListeners();
    }

    static async start(
        ctx: Context,
        options: ProcessStartOptions,
        hooks: ManagedProcessHooks,
    ): Promise<ManagedProcess> {
        return startProcessTransport(
            ctx,
            options,
            (ctx, transport) => new ManagedProcess(ctx, options, hooks, transport),
        );
    }

    get status(): ManagedProcessStatus {
        return this.#status;
    }

    snapshot(): ProcessSnapshot {
        return {
            id: this.id,
            pid: this.pid,
            command: this.command,
            cwd: this.cwd,
            status: this.#status,
            stdout: this.#stdout.snapshot().toString("utf8"),
            stderr: this.#stderr.snapshot().toString("utf8"),
            stdoutBytes: this.#stdout.totalBytes,
            stderrBytes: this.#stderr.totalBytes,
            stdoutOmittedBytes: this.#stdout.omittedBytes,
            stderrOmittedBytes: this.#stderr.omittedBytes,
        };
    }

    readOutput(
        stdoutOffset: number,
        stderrOffset: number,
        consume = false,
    ): ProcessSnapshot & {
        stderrDelta: string;
        stderrDeltaBytes: number;
        stderrDeltaOmittedBytes: number;
        stderrOffset: number;
        stdoutDelta: string;
        stdoutDeltaBytes: number;
        stdoutDeltaOmittedBytes: number;
        stdoutOffset: number;
    } {
        const stdoutDelta = consume
            ? drainedSnapshot(this.#stdoutUnread)
            : this.#stdout.snapshotFromOffset(stdoutOffset);
        const stderrDelta = consume
            ? drainedSnapshot(this.#stderrUnread)
            : this.#stderr.snapshotFromOffset(stderrOffset);
        return {
            ...this.snapshot(),
            stderrDelta: stderrDelta.buffer.toString("utf8"),
            stderrDeltaBytes: stderrDelta.totalBytes,
            stderrDeltaOmittedBytes: stderrDelta.omittedBytes,
            stderrOffset: consume
                ? this.#stderrBytes - this.#stderrUnread.totalBytes
                : this.#stderrBytes,
            stdoutDelta: stdoutDelta.buffer.toString("utf8"),
            stdoutDeltaBytes: stdoutDelta.totalBytes,
            stdoutDeltaOmittedBytes: stdoutDelta.omittedBytes,
            stdoutOffset: consume
                ? this.#stdoutBytes - this.#stdoutUnread.totalBytes
                : this.#stdoutBytes,
        };
    }

    writeStdin(ctx: Context, data: string | Uint8Array): Promise<boolean> {
        return ctx.span("happy.terminal.process.stdin.write", async () => {
            if (this.#status !== "running") return false;
            return this.#transport.write(data);
        });
    }

    endStdin(ctx: Context, data?: string | Uint8Array): Promise<void> {
        return ctx.span("happy.terminal.process.stdin.end", async () =>
            this.#transport.endInput(data),
        );
    }

    interrupt(ctx: Context): Promise<boolean> {
        return ctx.span("happy.terminal.process.interrupt", async (ctx) => {
            if (
                process.platform === "win32" ||
                this.#settled ||
                this.#status !== "running" ||
                this.pid === null
            ) {
                return false;
            }
            await killProcessTree(ctx, this.pid, "SIGINT");
            return true;
        });
    }

    async kill(
        ctx: Context,
        signal: NodeJS.Signals = "SIGTERM",
        options: ProcessKillOptions = {},
    ): Promise<void> {
        await ctx.span("happy.terminal.process.kill", async (ctx) => {
            if (this.#settled) {
                return;
            }

            this.#killed = true;
            this.#status = "killed";
            const startedAt = Date.now();
            if (this.pid !== null) {
                await killProcessTree(ctx, this.pid, signal);
            }

            let force: NodeJS.Timeout | undefined;
            const forceAfterMs = options.forceAfterMs ?? DEFAULT_KILL_GRACE_MS;
            if (this.pid !== null && signal !== "SIGKILL" && forceAfterMs > 0) {
                force = setTimeout(() => {
                    if (!this.#settled && this.pid !== null) {
                        void withProcessContext(
                            "force-kill",
                            (ctx) => killProcessTree(ctx, this.pid!, "SIGKILL"),
                            { processId: this.id },
                        );
                    }
                }, forceAfterMs);
                force.unref();
            }

            try {
                await this.#waitPromise;
            } finally {
                if (force !== undefined) clearTimeout(force);
                if (this.pid !== null) {
                    // The launcher is gone, but a child of it may still be shutting
                    // down and is entitled to the rest of its grace period.
                    if (signal !== "SIGKILL") {
                        await this.#forceGroupAfterGrace(ctx, forceAfterMs, startedAt);
                    }
                    this.#hooks.onGroupTerminated(this.pid);
                }
            }
        });
    }

    /** Gives the rest of the group what remains of its grace, then ends it. */
    async #forceGroupAfterGrace(
        ctx: Context,
        forceAfterMs: number,
        startedAt: number,
    ): Promise<void> {
        if (this.pid === null) return;
        const remainingMs = forceAfterMs - (Date.now() - startedAt);
        if (remainingMs > 0 && isProcessGroupAlive(this.pid)) {
            await new Promise((resolve) => {
                setTimeout(resolve, remainingMs).unref();
            });
        }
        // Group only, never the bare number: the launcher is already gone, so
        // its process id may now belong to a stranger.
        if (isProcessGroupAlive(this.pid)) await killProcessGroup(ctx, this.pid, "SIGKILL");
    }

    wait(ctx: Context): Promise<ProcessRunResult> {
        return ctx.span("happy.terminal.process.wait", async () => this.#waitPromise);
    }

    #attachListeners(): void {
        this.#transport.onStdout(this.#onStdoutData);
        this.#transport.onStderr(this.#onStderrData);
        this.#transport.onOutputEnd(this.#onOutputEnd);
        this.#transport.onError(this.#onError);
        this.#transport.onExit(this.#onExit);
    }

    #onStdoutData = (chunk: Buffer): void => {
        this.#stdoutBytes += chunk.length;
        this.#stdout.append(chunk);
        this.#stdoutUnread.append(chunk);
        if (this.#exitCode !== null || this.#exitSignal !== null) {
            this.#armPostExitTimer();
        }
    };

    #onStderrData = (chunk: Buffer): void => {
        this.#stderrBytes += chunk.length;
        this.#stderr.append(chunk);
        this.#stderrUnread.append(chunk);
        if (this.#exitCode !== null || this.#exitSignal !== null) {
            this.#armPostExitTimer();
        }
    };

    #onOutputEnd = (): void => {
        this.#stdoutEnded = true;
        this.#stderrEnded = true;
        this.#maybeFinalizeAfterExit();
    };

    #onError = (error: Error): void => {
        const chunk = Buffer.from(error.message);
        this.#stderrBytes += chunk.length;
        this.#stderr.append(chunk);
        this.#stderrUnread.append(chunk);
        this.#finalize(null, null);
    };

    #onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.#exitCode = code;
        this.#exitSignal = signal;
        this.#finalize(code, signal);
    };

    #maybeFinalizeAfterExit(): void {
        if (this.#settled || (this.#exitCode === null && this.#exitSignal === null)) {
            return;
        }
        if (this.#stdoutEnded && this.#stderrEnded) {
            this.#finalize(this.#exitCode, this.#exitSignal);
        }
    }

    #armPostExitTimer(): void {
        if (this.#postExitTimer !== undefined) {
            clearTimeout(this.#postExitTimer);
        }
        this.#postExitTimer = setTimeout(() => {
            this.#finalize(this.#exitCode, this.#exitSignal);
        }, EXIT_STDIO_IDLE_GRACE_MS);
        this.#postExitTimer.unref();
    }

    #finalize(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.#settled) {
            return;
        }
        this.#settled = true;
        this.#exitCode = code;
        this.#exitSignal = signal;
        if (this.#status === "running") {
            this.#status = "exited";
        }

        this.#cleanupListeners();
        this.#transport.release();

        // Anything the command left running keeps running. Its process group
        // stays registered with the manager, which reaps it at shutdown.
        this.#hooks.onSettled(this.id);
        this.#resolveWait({
            ...this.snapshot(),
            exitCode: code,
            signal,
            timedOut: false,
            aborted: false,
            killed: this.#killed,
        });
    }

    #cleanupListeners(): void {
        if (this.#postExitTimer !== undefined) {
            clearTimeout(this.#postExitTimer);
            this.#postExitTimer = undefined;
        }
    }
}

function drainedSnapshot(buffer: BoundedOutputBuffer): {
    buffer: Buffer;
    omittedBytes: number;
    totalBytes: number;
} {
    const drained = buffer.drain();
    return {
        buffer: drained.snapshot(),
        omittedBytes: drained.omittedBytes,
        totalBytes: drained.totalBytes,
    };
}

function abortedResult(options: ProcessRunOptions): ProcessRunResult {
    return {
        id: randomUUID(),
        pid: null,
        command: options.command,
        cwd: options.cwd,
        status: "killed",
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        killed: true,
    };
}
