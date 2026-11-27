import { randomUUID } from "node:crypto";

import type { Context } from "@steve.kite/stdlib";

import {
    COMMAND_MARKER_VARIABLE,
    findCommandProcesses,
    isCommandProcessAlive,
    type TrackedCommandProcess,
} from "./impl/findCommandProcesses.js";
import { killProcessTree } from "./impl/killProcessTree.js";
import {
    isProcessGroupAlive,
    killProcessGroup,
    ProcessGroupReaper,
} from "./impl/ProcessGroupReaper.js";
import { startProcessTransport, type ProcessTransport } from "./impl/startProcessTransport.js";
import { BoundedOutputBuffer } from "./impl/BoundedOutputBuffer.js";
import type {
    CommandProcess,
    ManagedProcessStatus,
    ProcessKillOptions,
    ProcessOutputDelta,
    ProcessRunOptions,
    ProcessRunResult,
    ProcessSnapshot,
    ProcessStartOptions,
    ProcessStopReport,
} from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 512_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const EXIT_STDIO_IDLE_GRACE_MS = 100;
/** How often a stop looks again at processes it is waiting on, within its grace. */
const STOP_POLL_MS = 20;

/**
 * Starts, observes, and stops operating-system processes for a compute backend.
 *
 * The manager is created once with the context that owns the compute's process
 * lifetime, not with a tool-call context. Work that outlives the call that
 * triggered it — the delayed force-kill of a lingering process, the reaping of
 * whole groups at shutdown — runs on that owning context, so a completed tool
 * call is never retained by a process it left behind.
 */
export class NativeProcessManager {
    readonly #processes = new Map<string, ManagedProcess>();
    readonly #groups = new ProcessGroupReaper();
    readonly #ctx: Context;

    constructor(ctx: Context) {
        this.#ctx = ctx;
    }

    async start(ctx: Context, options: ProcessStartOptions): Promise<ManagedProcess> {
        const process = await ManagedProcess.start(ctx, options, {
            owningContext: this.#ctx,
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
        return ctx.span("compute.process.run", async (ctx) => {
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

    /** A stronger native boundary has independently confirmed this entire execution is gone. */
    releaseConfirmedProcessGroup(process: ManagedProcess): void {
        if (process.status === "running") throw new Error("Cannot retire a running process group.");
        if (process.pid !== null) this.#groups.release(process.pid);
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
    /** The context owning the compute's process lifetime, for work that outlives a call. */
    owningContext: Context;
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
    /** The value of the marker variable this command and everything it starts inherit. */
    readonly #marker: string;
    /** How the spawned process itself ended, which a pipe can report before its output closes. */
    #leaderExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
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
        marker: string,
    ) {
        this.#marker = marker;
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
        const marker = randomUUID();
        return startProcessTransport(
            ctx,
            {
                ...options,
                env: { ...(options.env ?? process.env), [COMMAND_MARKER_VARIABLE]: marker },
            },
            (ctx, transport) => new ManagedProcess(ctx, options, hooks, transport, marker),
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
        completeUtf8Only = false,
    ): ProcessSnapshot & ProcessOutputDelta {
        return {
            ...this.snapshot(),
            ...this.readOutputDelta(stdoutOffset, stderrOffset, consume, completeUtf8Only),
        };
    }

    /** Service readers need independent deltas, not repeated copies of a megabyte-sized capture. */
    readOutputDelta(
        stdoutOffset: number,
        stderrOffset: number,
        consume = false,
        completeUtf8Only = false,
    ): ProcessOutputDelta {
        const includePending = !completeUtf8Only || this.#settled;
        const stdoutDelta = consume
            ? drainedSnapshot(this.#stdoutUnread)
            : this.#stdout.snapshotFromOffset(stdoutOffset, includePending);
        const stderrDelta = consume
            ? drainedSnapshot(this.#stderrUnread)
            : this.#stderr.snapshotFromOffset(stderrOffset, includePending);
        return {
            stderrDelta: stderrDelta.buffer.toString("utf8"),
            stderrDeltaBytes: stderrDelta.totalBytes,
            stderrDeltaOmittedBytes: stderrDelta.omittedBytes,
            stderrOffset: consume
                ? this.#stderrBytes - this.#stderrUnread.totalBytes
                : this.#stderrBytes - (includePending ? 0 : this.#stderr.pendingBytes),
            stdoutDelta: stdoutDelta.buffer.toString("utf8"),
            stdoutDeltaBytes: stdoutDelta.totalBytes,
            stdoutDeltaOmittedBytes: stdoutDelta.omittedBytes,
            stdoutOffset: consume
                ? this.#stdoutBytes - this.#stdoutUnread.totalBytes
                : this.#stdoutBytes - (includePending ? 0 : this.#stdout.pendingBytes),
        };
    }

    writeStdin(ctx: Context, data: string | Uint8Array): Promise<boolean> {
        return ctx.span("compute.process.stdin.write", async () => {
            if (this.#status !== "running") return false;
            return this.#transport.write(data);
        });
    }

    endStdin(ctx: Context, data?: string | Uint8Array): Promise<void> {
        return ctx.span("compute.process.stdin.end", async () => this.#transport.endInput(data));
    }

    interrupt(ctx: Context): Promise<boolean> {
        return ctx.span("compute.process.interrupt", async (ctx) => {
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

    /**
     * Stops the command and everything it started, and says what that ended.
     *
     * The command's processes are found before anything is signalled, while the shell that
     * launched them still links them together: a child that called `setsid` is outside the
     * command's group and session, and one whose parent has died has been handed to init. Each
     * process found is asked to stop, and whatever is still running when the grace runs out is
     * forced.
     *
     * The stop settles once that is done, even when something still holds the command's output
     * open. Waiting for every holder of a pipe to close is waiting on a process the stop may not
     * be able to reach, so the pipes' ends here are closed instead and the survivors are named.
     */
    async kill(
        ctx: Context,
        signal: NodeJS.Signals = "SIGTERM",
        options: ProcessKillOptions = {},
    ): Promise<ProcessStopReport> {
        return await ctx.span("compute.process.kill", async (ctx) => {
            if (this.#settled || this.pid === null) {
                if (!this.#settled) await this.#waitPromise;
                return { stopped: [], survivors: [] };
            }

            this.#killed = true;
            this.#status = "killed";
            const deadline = Date.now() + (options.forceAfterMs ?? DEFAULT_KILL_GRACE_MS);
            const leaderWasRunning = this.#leaderExit === undefined;
            const found = await this.#findCommandProcesses();
            await this.#signalCommandProcesses(ctx, found, signal);

            const forced: TrackedCommandProcess[] = [];
            if (signal !== "SIGKILL") {
                await this.#waitForStop(found, deadline);
            }
            const remaining = mergeProcesses(
                await stillRunning(found),
                await this.#findCommandProcesses(),
            );
            if (remaining.length > 0 || this.#leaderExit === undefined) {
                // The grace is over. Whatever ignored the polite request does not get another.
                await this.#signalCommandProcesses(ctx, remaining, "SIGKILL");
                forced.push(...remaining);
                // A process cannot ignore SIGKILL, but it ends only when the kernel gets to it.
                // The wait for that is bounded by the same grace, so a process stuck in the
                // kernel is reported as a survivor rather than holding the stop forever.
                await this.#waitForStop(
                    remaining,
                    Date.now() + (options.forceAfterMs ?? DEFAULT_KILL_GRACE_MS),
                );
            }

            const all = mergeProcesses(found, forced);
            const survivors = await stillRunning(all);
            if (!this.#settled) {
                // Whatever still holds the output is not going to be heard from. Close our ends
                // so the command is settled instead of waiting on a process the stop cannot end.
                this.#finalize(this.#leaderExit?.code ?? null, this.#leaderExit?.signal ?? null);
            }
            // A survivor keeps the group registered, so shutdown still tries to take it down.
            if (survivors.length === 0) this.#hooks.onGroupTerminated(this.pid);

            const surviving = new Set(survivors.map((survivor) => survivor.pid));
            const stopped = all
                .filter((stoppedProcess) => !surviving.has(stoppedProcess.pid))
                .map(publicProcess);
            if (leaderWasRunning && !all.some((member) => member.pid === this.pid)) {
                stopped.unshift({ command: this.command, pid: this.pid });
            }
            return { stopped, survivors: survivors.map(publicProcess) };
        });
    }

    /** Everything that belongs to this command right now. */
    #findCommandProcesses(): Promise<TrackedCommandProcess[]> {
        return findCommandProcesses({
            leaderAlive: this.#leaderExit === undefined,
            leaderPid: this.pid!,
            marker: this.#marker,
        });
    }

    async #signalCommandProcesses(
        ctx: Context,
        targets: readonly TrackedCommandProcess[],
        signal: NodeJS.Signals,
    ): Promise<void> {
        const pid = this.pid!;
        if (process.platform === "win32") {
            if (this.#leaderExit === undefined) await killProcessTree(ctx, pid, signal);
            return;
        }
        // The group as well as its members found a moment ago, so a child forked in between is
        // not missed. A group cannot be renumbered while any member of it is alive.
        if (this.#leaderExit === undefined || isProcessGroupAlive(pid)) {
            await killProcessGroup(ctx, pid, signal);
        }
        await ctx.span("compute.process.signal_members", async () => {
            for (const target of targets) {
                try {
                    process.kill(target.pid, signal);
                } catch {
                    // Already gone, or no longer ours to signal.
                }
            }
        });
    }

    /**
     * Waits until the command has settled and every process found has ended, or the deadline
     * passes, whichever comes first.
     */
    async #waitForStop(targets: readonly TrackedCommandProcess[], deadline: number): Promise<void> {
        let alive = await stillRunning(targets);
        while (!this.#settled || alive.length > 0) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) return;
            await new Promise((resolve) => {
                setTimeout(resolve, Math.min(STOP_POLL_MS, remainingMs)).unref();
            });
            alive = await stillRunning(alive);
        }
    }

    wait(ctx: Context): Promise<ProcessRunResult> {
        return ctx.span("compute.process.wait", async () => this.#waitPromise);
    }

    #attachListeners(): void {
        this.#transport.onStdout(this.#onStdoutData);
        this.#transport.onStderr(this.#onStderrData);
        this.#transport.onOutputEnd(this.#onOutputEnd);
        this.#transport.onError(this.#onError);
        this.#transport.onExit(this.#onExit);
        this.#transport.onLeaderExit?.(this.#onLeaderExit);
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

    #onLeaderExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.#leaderExit = { code, signal };
    };

    #onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.#leaderExit ??= { code, signal };
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

/** The processes among these that are still running as the processes that were found. */
async function stillRunning(
    targets: readonly TrackedCommandProcess[],
): Promise<TrackedCommandProcess[]> {
    const alive = await Promise.all(targets.map(isCommandProcessAlive));
    return targets.filter((_, index) => alive[index]);
}

function mergeProcesses(
    ...lists: readonly (readonly TrackedCommandProcess[])[]
): TrackedCommandProcess[] {
    const merged = new Map<number, TrackedCommandProcess>();
    for (const list of lists) for (const entry of list) merged.set(entry.pid, entry);
    return [...merged.values()];
}

function publicProcess(tracked: TrackedCommandProcess): CommandProcess {
    return { command: tracked.command, pid: tracked.pid };
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
